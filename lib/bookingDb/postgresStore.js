// Authoritative Postgres booking store.
// All capacity mutations lock the hour slot row, re-evaluate rules, then commit.

import { randomBytes } from "node:crypto";
import { evaluateAdmission, seatsForRequest } from "./capacity.js";
import { HOLD_MINUTES } from "../holds.js";
import { LOCATION_KEY } from "../schedule.js";

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** In-process serialization per hour (defense in depth; Postgres FOR UPDATE is authority across instances). */
const slotQueues = new Map();
function enqueueSlot(locationKey, date, timeLabel, fn) {
  const key = `${locationKey}|${date}|${timeLabel}`;
  const prev = slotQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  slotQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

export class PostgresBookingStore {
  /**
   * @param {{ query: Function, connect?: Function }} pool
   *   pg Pool, or pg-mem adapter with query/connect.
   */
  constructor(pool, { now = () => Date.now() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async withTransaction(fn) {
    if (typeof this.pool.connect === "function") {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        // Soft capacity/business failures roll back partial writes, then return
        // a structured result (used by confirmPaid multi-lesson loops).
        if (error && error.softFail) {
          return (
            error.payload || {
              ok: false,
              code: error.code || "transaction_failed",
              error: error.message || "Transaction failed.",
            }
          );
        }
        throw error;
      } finally {
        client.release();
      }
    }
    // Single-connection fallback (some test adapters).
    await this.pool.query("BEGIN");
    try {
      const result = await fn(this.pool);
      await this.pool.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.pool.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      if (error && error.softFail) {
        return (
          error.payload || {
            ok: false,
            code: error.code || "transaction_failed",
            error: error.message || "Transaction failed.",
          }
        );
      }
      throw error;
    }
  }

  async ensureSlotLock(client, locationKey, date, timeLabel) {
    await client.query(
      `INSERT INTO slot_locks (location_key, slot_date, time_label)
       VALUES ($1, $2::date, $3)
       ON CONFLICT DO NOTHING`,
      [locationKey, date, timeLabel]
    );
    await client.query(
      `SELECT 1 FROM slot_locks
       WHERE location_key = $1 AND slot_date = $2::date AND time_label = $3
       FOR UPDATE`,
      [locationKey, date, timeLabel]
    );
  }

  async loadSlotBookings(client, locationKey, date, timeLabel) {
    const { rows } = await client.query(
      `SELECT *
       FROM bookings
       WHERE location_key = $1
         AND slot_date = $2::date
         AND time_label = $3
         AND status IN ('held', 'active')`,
      [locationKey, date, timeLabel]
    );
    return rows.map(normalizeBookingRow);
  }

  /**
   * Active + non-expired held bookings for a date (occupancy / calendar).
   */
  async listOccupancy(date, { locationKey = LOCATION_KEY, ignoreHold = "" } = {}) {
    const nowIso = new Date(this.now()).toISOString();
    const { rows } = await this.query(
      `SELECT *
       FROM bookings
       WHERE location_key = $1
         AND slot_date = $2::date
         AND (
           status = 'active'
           OR (status = 'held' AND (hold_expires_at IS NULL OR hold_expires_at > $3::timestamptz))
         )
       ORDER BY time_label, created_at`,
      [locationKey, date, nowIso]
    );
    return rows
      .map(normalizeBookingRow)
      .filter((r) => !(ignoreHold && r.stripe_session === ignoreHold));
  }

  async getBooking(id) {
    const { rows } = await this.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
    return rows[0] ? normalizeBookingRow(rows[0]) : null;
  }

  async listBookingsForEmail(email) {
    const { rows } = await this.query(
      `SELECT * FROM bookings
       WHERE lower(email) = $1 AND status IN ('held', 'active')
       ORDER BY slot_date, time_label`,
      [normalizeEmail(email)]
    );
    return rows.map(normalizeBookingRow);
  }

  /** Active (+ optional held) bookings for Coach Desk / calendar reads. */
  async listActiveBookings({ includeHeld = false, sinceDate = null } = {}) {
    const statuses = includeHeld ? ["active", "held"] : ["active"];
    const params = [statuses];
    let sql = `SELECT * FROM bookings WHERE status = ANY($1::text[])`;
    if (sinceDate) {
      params.push(sinceDate);
      sql += ` AND slot_date >= $2::date`;
    }
    sql += ` ORDER BY slot_date, time_label, id`;
    const { rows } = await this.query(sql, params);
    return rows.map(normalizeBookingRow);
  }

  /**
   * Reserve checkout hold seats. Idempotent per stripe session:
   * replaces prior holds for the same sessionId.
   */
  async reserveHold({
    sessionId,
    slots,
    mins = 60,
    focus = "",
    type = "",
    privacy = "",
    seats,
    locationKey = LOCATION_KEY,
  }) {
    if (!sessionId || !Array.isArray(slots) || !slots.length) {
      return { ok: false, code: "invalid_hold", error: "Missing hold slots." };
    }
    const expiresAt = new Date(this.now() + HOLD_MINUTES * 60 * 1000).toISOString();
    const resolvedSeats =
      Number(seats) ||
      seatsForRequest({ type, athletes: seats, privacy, focus });

    // Serialize per first slot (typical checkout is one hour); multi-slot holds
    // still lock each hour inside the transaction.
    const head = slots[0];
    return enqueueSlot(locationKey, head.date, head.time, () =>
      this.withTransaction(async (client) => {
        // Drop prior holds for this checkout (replace-on-write).
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled', cancelled_at = now(), updated_at = now()
           WHERE stripe_session = $1 AND status = 'held'`,
          [sessionId]
        );

        const created = [];
        for (const slot of slots) {
          const date = slot.date;
          const time = slot.time;
          await this.ensureSlotLock(client, locationKey, date, time);
          const existing = await this.loadSlotBookings(client, locationKey, date, time);
          const decision = evaluateAdmission(
            existing,
            {
              focus,
              time,
              mins,
              type,
              privacy,
              seats: resolvedSeats,
              ignoreIds: [],
            },
            { now: this.now() }
          );
          if (!decision.ok) return decision;

          const id = newId("hld");
          await client.query(
            `INSERT INTO bookings (
               id, source, source_ref, status, slot_date, time_label, mins, location_key,
               focus, privacy, seats, booking_type, stripe_session, hold_expires_at, payload
             ) VALUES (
               $1,'hold',$2,'held',$3::date,$4,$5,$6,
               $7,$8,$9,$10,$2,$11::timestamptz,'{}'::jsonb
             )`,
            [
              id,
              sessionId,
              date,
              time,
              decision.mins,
              locationKey,
              decision.focus,
              decision.privacy,
              decision.seats,
              type || "",
              expiresAt,
            ]
          );
          created.push(id);
        }
        return { ok: true, holdIds: created, expiresAt };
      })
    );
  }

  async releaseHold(sessionId) {
    if (!sessionId) return { ok: true, released: 0 };
    const { rowCount } = await this.query(
      `UPDATE bookings
       SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE stripe_session = $1 AND status = 'held'`,
      [sessionId]
    );
    return { ok: true, released: rowCount || 0 };
  }

  /**
   * Mirror a paid Stripe checkout/payment into active bookings.
   * Idempotent on idempotencyKey (typically mirror:<pi|session>).
   */
  async confirmPaid({
    idempotencyKey,
    sourceId,
    sessionId = "",
    metadata = {},
    locationKey = LOCATION_KEY,
  }) {
    if (!idempotencyKey || !sourceId) {
      return { ok: false, code: "invalid_confirm", error: "Missing payment identity." };
    }

    const lessons = lessonsFromStripeMeta(sourceId, metadata);
    if (!lessons.length) {
      return { ok: false, code: "no_lessons", error: "No lesson slots in payment metadata." };
    }
    const head = lessons[0];
    return enqueueSlot(locationKey, head.date, head.time, () =>
      this.withTransaction(async (client) => {
      const existing = await client.query(`SELECT result FROM idempotency_keys WHERE key = $1`, [
        idempotencyKey,
      ]);
      if (existing.rows[0]) {
        return { ok: true, idempotent: true, ...existing.rows[0].result };
      }

      if (sessionId) {
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled', cancelled_at = now(), updated_at = now()
           WHERE stripe_session = $1 AND status = 'held'`,
          [sessionId]
        );
      }

      const bookingIds = [];
      // Phase 1: lock + evaluate every slot before inserting any row so a
      // multi-lesson payment never leaves a partial mirror if a later hour fails.
      const decisions = [];
      for (const lesson of lessons) {
        await this.ensureSlotLock(client, locationKey, lesson.date, lesson.time);
        const slotRows = await this.loadSlotBookings(client, locationKey, lesson.date, lesson.time);
        const others = slotRows.filter((r) => r.id !== lesson.id);
        const decision = evaluateAdmission(
          others,
          {
            focus: lesson.focus,
            time: lesson.time,
            mins: lesson.mins || 60,
            type: lesson.type,
            privacy: lesson.privacy,
            seats: lesson.seats,
            athletes: lesson.athletes,
          },
          { now: this.now() }
        );
        if (!decision.ok) return decision;
        decisions.push(decision);
      }

      // Phase 2: insert all lessons (same TX).
      for (let i = 0; i < lessons.length; i++) {
        const lesson = lessons[i];
        const decision = decisions[i];
        await client.query(
          `INSERT INTO bookings (
             id, source, source_ref, status, slot_date, time_label, mins, location_key,
             focus, privacy, seats, email, player, player2, parent, phone, booking_type,
             athletes, stripe_pi, stripe_session, membership_id, payload
           ) VALUES (
             $1,'stripe',$2,'active',$3::date,$4,$5,$6,
             $7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,$18,$19,$20::jsonb
           )
           ON CONFLICT (id) DO UPDATE SET
             status = 'active',
             focus = EXCLUDED.focus,
             privacy = EXCLUDED.privacy,
             seats = EXCLUDED.seats,
             email = EXCLUDED.email,
             player = EXCLUDED.player,
             updated_at = now(),
             cancelled_at = NULL,
             payload = EXCLUDED.payload`,
          [
            lesson.id,
            sourceId,
            lesson.date,
            lesson.time,
            decision.mins,
            locationKey,
            decision.focus,
            decision.privacy,
            decision.seats,
            normalizeEmail(lesson.email),
            lesson.player || "",
            lesson.player2 || "",
            lesson.parent || "",
            lesson.phone || "",
            lesson.type || "single",
            Number(lesson.athletes) || 1,
            String(sourceId).startsWith("pi_") ? sourceId : null,
            sessionId || null,
            lesson.subId || null,
            JSON.stringify({ mirroredAt: this.now(), metadata: summarizeMeta(metadata) }),
          ]
        );
        bookingIds.push(lesson.id);
      }

      const result = { bookingIds, sourceId, sessionId: sessionId || "" };
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (key, result) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey, JSON.stringify(result)]
      );
      if (!inserted.rowCount) {
        const raced = await client.query(`SELECT result FROM idempotency_keys WHERE key = $1`, [
          idempotencyKey,
        ]);
        if (raced.rows[0]) {
          return { ok: true, idempotent: true, ...raced.rows[0].result };
        }
      }
      return { ok: true, idempotent: false, ...result };
    })
    );
  }

  /**
   * Member portal book using a membership credit.
   */
  async memberBook({
    membershipId,
    email,
    date,
    time,
    focus,
    type = "membership",
    privacy = "standard",
    player = "",
    parent = "",
    phone = "",
    locationKey = LOCATION_KEY,
    creditsTotal = 4,
  }) {
    const em = normalizeEmail(email);
    if (!membershipId || !em || !date || !time) {
      return { ok: false, code: "invalid_book", error: "Missing booking fields." };
    }

    return enqueueSlot(locationKey, date, time, () =>
      this.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO membership_credits (membership_id, email, tier, credits_total, credits_used, status)
           VALUES ($1, $2, $3, $4, 0, 'active')
           ON CONFLICT (membership_id) DO NOTHING`,
          [membershipId, em, type.includes("private") ? "private" : "standard", creditsTotal]
        );

        const { rows: creditRows } = await client.query(
          `SELECT * FROM membership_credits WHERE membership_id = $1 FOR UPDATE`,
          [membershipId]
        );
        const credit = creditRows[0];
        if (!credit || credit.status !== "active") {
          return { ok: false, code: "membership_inactive", error: "Membership is not active." };
        }
        // Seed/sync ledger from existing active lessons so cash/import history
        // cannot be overshot by a lagging credits_used counter.
        const { rows: usedRows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM bookings
           WHERE membership_id = $1 AND status = 'active'`,
          [membershipId]
        );
        const lessonUsed = Number(usedRows[0]?.n) || 0;
        if (lessonUsed > credit.credits_used) {
          await client.query(
            `UPDATE membership_credits
             SET credits_used = $2, updated_at = now()
             WHERE membership_id = $1`,
            [membershipId, lessonUsed]
          );
          credit.credits_used = lessonUsed;
        }
        if (credit.credits_used >= credit.credits_total) {
          return { ok: false, code: "no_credits", error: "No membership credits left." };
        }

        await this.ensureSlotLock(client, locationKey, date, time);
        const existing = await this.loadSlotBookings(client, locationKey, date, time);
        const decision = evaluateAdmission(
          existing,
          { focus, time, mins: 60, type, privacy, athletes: 1 },
          { now: this.now() }
        );
        if (!decision.ok) return decision;

        const id = newId("lsn");
        await client.query(
          `INSERT INTO bookings (
             id, source, source_ref, status, slot_date, time_label, mins, location_key,
             focus, privacy, seats, email, player, parent, phone, booking_type,
             athletes, membership_id, payload
           ) VALUES (
             $1,'member',$2,'active',$3::date,$4,60,$5,
             $6,$7,$8,$9,$10,$11,$12,$13,
             1,$2,'{}'::jsonb
           )`,
          [
            id,
            membershipId,
            date,
            time,
            locationKey,
            decision.focus,
            decision.privacy,
            decision.seats,
            em,
            player,
            parent,
            phone,
            type,
          ]
        );
        await client.query(
          `UPDATE membership_credits
           SET credits_used = credits_used + 1, updated_at = now()
           WHERE membership_id = $1`,
          [membershipId]
        );
        return { ok: true, bookingId: id, creditsUsed: credit.credits_used + 1 };
      })
    );
  }

  /**
   * Atomic reschedule. On capacity failure the original row and credit are unchanged.
   */
  async reschedule({
    bookingId,
    newDate,
    newTime,
    newFocus,
    locationKey = LOCATION_KEY,
  }) {
    if (!bookingId || !newDate || !newTime) {
      return { ok: false, code: "invalid_reschedule", error: "Missing reschedule fields." };
    }

    return this.withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
        bookingId,
      ]);
      const row = rows[0];
      if (!row || row.status !== "active") {
        return { ok: false, code: "not_found", error: "Lesson not found." };
      }

      const focus = newFocus || row.focus || "";
      // Lock old and new slots in stable order to avoid deadlocks.
      const keys = [
        [row.location_key, row.slot_date, row.time_label],
        [locationKey, newDate, newTime],
      ].sort((a, b) => a.join("|").localeCompare(b.join("|")));
      for (const [loc, d, t] of keys) {
        await this.ensureSlotLock(client, loc, formatDate(d), t);
      }

      const existing = await this.loadSlotBookings(client, locationKey, newDate, newTime);
      const others = existing.filter((r) => r.id !== bookingId);
      const decision = evaluateAdmission(
        others,
        {
          focus,
          time: newTime,
          mins: row.mins || 60,
          type: row.booking_type,
          privacy: row.privacy,
          seats: row.seats,
          athletes: row.athletes,
        },
        { now: this.now() }
      );
      if (!decision.ok) {
        // Explicit no-op: original row still active (transaction will commit without changes
        // only if we return before updates — we return error and roll back via throw? 
        // Better: return error and ROLLBACK by throwing a control error, or just return
        // without updates then COMMIT — returning without updates preserves original.
        return decision;
      }

      const prevPayload =
        row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? row.payload
          : {};
      const nextPayload = {
        ...prevPayload,
        movedAt: this.now(),
        movedFrom: { date: formatDate(row.slot_date), time: row.time_label },
      };
      await client.query(
        `UPDATE bookings SET
           slot_date = $2::date,
           time_label = $3,
           location_key = $4,
           focus = $5,
           privacy = $6,
           seats = $7,
           updated_at = now(),
           payload = $8::jsonb
         WHERE id = $1 AND status = 'active'`,
        [
          bookingId,
          newDate,
          newTime,
          locationKey,
          decision.focus,
          decision.privacy,
          decision.seats,
          JSON.stringify(nextPayload),
        ]
      );
      return {
        ok: true,
        bookingId,
        from: { date: formatDate(row.slot_date), time: row.time_label },
        to: { date: newDate, time: newTime },
      };
    });
  }

  /**
   * Coach Desk / cash-book manual booking with transactional capacity check.
   */
  async manualBook({
    id,
    date,
    time,
    focus = "",
    type = "single",
    privacy = "standard",
    seats,
    athletes = 1,
    email = "",
    player = "",
    player2 = "",
    parent = "",
    phone = "",
    locationKey = LOCATION_KEY,
    payload = {},
    membershipId = null,
  }) {
    if (!id || !date || !time) {
      return { ok: false, code: "invalid_book", error: "Missing booking fields." };
    }
    const resolvedSeats =
      Number(seats) ||
      seatsForRequest({ type, athletes, privacy, focus });
    return enqueueSlot(locationKey, date, time, () =>
      this.withTransaction(async (client) => {
        const existingId = await client.query(`SELECT id, status FROM bookings WHERE id = $1`, [id]);
        if (existingId.rows[0]?.status === "active") {
          return { ok: true, bookingId: id, idempotent: true };
        }
        await this.ensureSlotLock(client, locationKey, date, time);
        const existing = await this.loadSlotBookings(client, locationKey, date, time);
        const decision = evaluateAdmission(
          existing.filter((r) => r.id !== id),
          { focus, time, mins: 60, type, privacy, seats: resolvedSeats, athletes },
          { now: this.now() }
        );
        if (!decision.ok) return decision;

        await client.query(
          `INSERT INTO bookings (
             id, source, source_ref, status, slot_date, time_label, mins, location_key,
             focus, privacy, seats, email, player, player2, parent, phone, booking_type,
             athletes, membership_id, payload
           ) VALUES (
             $1,'manual',$1,'active',$2::date,$3,60,$4,
             $5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16::jsonb
           )
           ON CONFLICT (id) DO UPDATE SET
             status = 'active',
             focus = EXCLUDED.focus,
             privacy = EXCLUDED.privacy,
             seats = EXCLUDED.seats,
             email = EXCLUDED.email,
             player = EXCLUDED.player,
             payload = EXCLUDED.payload,
             updated_at = now(),
             cancelled_at = NULL`,
          [
            id,
            date,
            time,
            locationKey,
            decision.focus,
            decision.privacy,
            decision.seats,
            normalizeEmail(email),
            player || "",
            player2 || "",
            parent || "",
            phone || "",
            type || "single",
            Number(athletes) || 1,
            membershipId,
            JSON.stringify(payload || {}),
          ]
        );
        return { ok: true, bookingId: id, idempotent: false };
      })
    );
  }

  async cancelBooking(bookingId, { restoreCredit = false } = {}) {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
        bookingId,
      ]);
      const row = rows[0];
      if (!row) return { ok: false, code: "not_found", error: "Lesson not found." };
      if (row.status !== "active" && row.status !== "held") {
        return { ok: true, already: true };
      }
      await client.query(
        `UPDATE bookings
         SET status = 'cancelled', cancelled_at = now(), updated_at = now()
         WHERE id = $1`,
        [bookingId]
      );
      // Member-portal lessons and cash/manual membership lessons both spend a
      // credit when membership_id is set — restore on cancel for either source.
      if (
        restoreCredit &&
        row.membership_id &&
        (row.source === "member" ||
          row.source === "manual" ||
          String(row.booking_type || "").includes("membership"))
      ) {
        await client.query(
          `UPDATE membership_credits
           SET credits_used = GREATEST(credits_used - 1, 0), updated_at = now()
           WHERE membership_id = $1`,
          [row.membership_id]
        );
      }
      return { ok: true, bookingId };
    });
  }

  /**
   * Coach Desk collect_payment for a manual (cash) booking.
   * Updates payload payment fields inside a transaction; finance ledger stays Blob.
   */
  async collectManualPayment({ id, amountCents }) {
    const amount = Math.max(0, Number(amountCents) || 0);
    if (!id || !amount) {
      return { ok: false, code: "invalid_payment", error: "Enter an amount.", status: 400 };
    }
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      const row = rows[0];
      if (!row || (row.status !== "active" && row.status !== "held")) {
        return {
          ok: false,
          code: "not_found",
          error: "Booking not found (only cash/manual bookings can be collected here).",
          status: 404,
        };
      }
      if (row.source !== "manual") {
        return {
          ok: false,
          code: "not_manual",
          error: "Booking not found (only cash/manual bookings can be collected here).",
          status: 404,
        };
      }
      const prev =
        row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? { ...row.payload }
          : typeof row.payload === "string"
            ? (() => {
                try {
                  return JSON.parse(row.payload);
                } catch {
                  return {};
                }
              })()
            : {};
      const due = Math.max(0, Number(prev.amountDueCents) || 0);
      const alreadyPaid =
        due <= 0 &&
        (String(prev.paymentStatus || "") === "paid" || Number(prev.amountPaidCents) > 0);
      if (alreadyPaid || due <= 0) {
        return {
          ok: true,
          take: 0,
          idempotent: true,
          booking: {
            id: row.id,
            type: row.booking_type || "single",
            player: row.player || "",
            email: row.email || "",
            date: formatDate(row.slot_date),
            time: row.time_label || "",
            amountPaidCents: Number(prev.amountPaidCents) || 0,
            amountDueCents: 0,
            paymentStatus: "paid",
            membershipId: row.membership_id || null,
          },
        };
      }
      const take = Math.min(amount, due);
      const amountPaidCents = (Number(prev.amountPaidCents) || 0) + take;
      const amountDueCents = Math.max(0, due - take);
      const paymentStatus = amountDueCents > 0 ? "deposit_paid" : "paid";
      const payload = {
        ...prev,
        amountPaidCents,
        amountDueCents,
        paymentStatus,
        collectedAt: this.now(),
      };
      await client.query(
        `UPDATE bookings SET payload = $2::jsonb, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(payload)]
      );
      return {
        ok: true,
        take,
        idempotent: false,
        booking: {
          id: row.id,
          type: row.booking_type || "single",
          player: row.player || "",
          email: row.email || "",
          date: formatDate(row.slot_date),
          time: row.time_label || "",
          amountPaidCents,
          amountDueCents,
          paymentStatus,
          membershipId: row.membership_id || null,
        },
      };
    });
  }

  async getMembershipCredits(membershipId) {
    const { rows } = await this.query(
      `SELECT * FROM membership_credits WHERE membership_id = $1`,
      [membershipId]
    );
    return rows[0] || null;
  }

  /**
   * Insert imported historical row without capacity checks (migration only).
   * Idempotent: ON CONFLICT DO NOTHING — safe to retry.
   */
  async importBookingRow(row) {
    const result = await this.query(
      `INSERT INTO bookings (
         id, source, source_ref, status, slot_date, time_label, mins, location_key,
         focus, privacy, seats, email, player, player2, parent, phone, booking_type,
         athletes, membership_id, stripe_pi, stripe_session, payload, hold_expires_at,
         created_at, updated_at, cancelled_at
       ) VALUES (
         $1,$2,$3,$4,$5::date,$6,$7,$8,
         $9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22::jsonb,$23::timestamptz,
         COALESCE($24::timestamptz, now()), COALESCE($25::timestamptz, now()), $26::timestamptz
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        row.id,
        row.source,
        row.source_ref || null,
        row.status,
        row.slot_date || row.date,
        row.time_label || row.time,
        row.mins || 60,
        row.location_key || LOCATION_KEY,
        row.focus || "",
        row.privacy || "standard",
        row.seats || 1,
        normalizeEmail(row.email),
        row.player || "",
        row.player2 || "",
        row.parent || "",
        row.phone || "",
        row.booking_type || row.type || "",
        row.athletes || null,
        row.membership_id || row.subId || null,
        row.stripe_pi || null,
        row.stripe_session || row.sessionId || null,
        JSON.stringify(row.payload || {}),
        row.hold_expires_at || null,
        row.created_at ? new Date(row.created_at).toISOString() : null,
        row.updated_at ? new Date(row.updated_at).toISOString() : null,
        row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
      ]
    );
    return { ok: true, inserted: Boolean(result.rowCount) };
  }

  /**
   * Idempotent membership credit upsert for import.
   * Never decreases credits_used on retry (GREATEST).
   */
  async importMembershipCredits({ membershipId, email, tier = "standard", creditsTotal = 4, creditsUsed = 0 }) {
    if (!membershipId) return { ok: false, inserted: false };
    await this.query(
      `INSERT INTO membership_credits (membership_id, email, tier, credits_total, credits_used, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (membership_id) DO UPDATE SET
         email = EXCLUDED.email,
         tier = EXCLUDED.tier,
         credits_total = GREATEST(membership_credits.credits_total, EXCLUDED.credits_total),
         credits_used = GREATEST(membership_credits.credits_used, EXCLUDED.credits_used),
         updated_at = now()`,
      [
        membershipId,
        normalizeEmail(email),
        tier,
        Math.max(0, Number(creditsTotal) || 4),
        Math.max(0, Number(creditsUsed) || 0),
      ]
    );
    return { ok: true };
  }

  /** Active bookings for a Stripe payment / source id (pi_… / sub_…). */
  async listActiveBySourceRef(sourceRef) {
    if (!sourceRef) return [];
    const { rows } = await this.query(
      `SELECT * FROM bookings
       WHERE source_ref = $1 AND status = 'active'
       ORDER BY slot_date, time_label, id`,
      [sourceRef]
    );
    return rows.map(normalizeBookingRow);
  }

  /**
   * Record (or refresh) an open operator alert when auto-mirror cannot seat a
   * paid customer without displacing someone else.
   */
  async recordReconcileAlert({
    id,
    kind = "paid_mirror_conflict",
    sourceRef = "",
    sessionId = "",
    date = null,
    time = "",
    email = "",
    player = "",
    detail = {},
  }) {
    const alertId = id || `alert_${sourceRef || sessionId || newId("al")}`;
    await this.query(
      `INSERT INTO reconcile_alerts (
         id, kind, source_ref, session_id, slot_date, time_label, email, player, detail, status
       ) VALUES (
         $1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, 'open'
       )
       ON CONFLICT (id) DO UPDATE SET
         detail = EXCLUDED.detail,
         status = 'open',
         resolved_at = NULL`,
      [
        alertId,
        kind,
        sourceRef || null,
        sessionId || null,
        date || null,
        time || null,
        normalizeEmail(email) || null,
        player || null,
        JSON.stringify(detail || {}),
      ]
    );
    return { ok: true, id: alertId };
  }

  async listOpenReconcileAlerts({ limit = 50 } = {}) {
    const { rows } = await this.query(
      `SELECT * FROM reconcile_alerts
       WHERE status = 'open'
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    return rows;
  }

  async resolveReconcileAlert(id, { status = "resolved" } = {}) {
    const next = status === "ignored" ? "ignored" : "resolved";
    const { rowCount } = await this.query(
      `UPDATE reconcile_alerts
       SET status = $2, resolved_at = now()
       WHERE id = $1 AND status = 'open'`,
      [id, next]
    );
    return { ok: true, updated: rowCount || 0 };
  }

  /**
   * Audit membership_credits vs counted active lessons for one or all members.
   */
  async auditMembershipCredits({ membershipId = null } = {}) {
    const params = [];
    let sql = `
      SELECT mc.membership_id, mc.email, mc.credits_total, mc.credits_used, mc.status,
             COALESCE(b.n, 0)::int AS lesson_count
      FROM membership_credits mc
      LEFT JOIN (
        SELECT membership_id, COUNT(*)::int AS n
        FROM bookings
        WHERE status = 'active' AND membership_id IS NOT NULL
        GROUP BY membership_id
      ) b ON b.membership_id = mc.membership_id`;
    if (membershipId) {
      params.push(membershipId);
      sql += ` WHERE mc.membership_id = $1`;
    }
    sql += ` ORDER BY mc.membership_id`;
    const { rows } = await this.query(sql, params);
    return rows.map((r) => ({
      membershipId: r.membership_id,
      email: r.email,
      creditsTotal: Number(r.credits_total) || 0,
      creditsUsed: Number(r.credits_used) || 0,
      lessonCount: Number(r.lesson_count) || 0,
      status: r.status,
      mismatch: Number(r.credits_used) !== Number(r.lesson_count),
    }));
  }

  /** Raise credits_used to match active lesson count (never decreases). */
  async syncMembershipCreditsFromLessons({ membershipId }) {
    if (!membershipId) return { ok: false, code: "invalid" };
    const { rows: countRows } = await this.query(
      `SELECT COUNT(*)::int AS n FROM bookings
       WHERE membership_id = $1 AND status = 'active'`,
      [membershipId]
    );
    const lessonCount = Number(countRows[0]?.n) || 0;
    const { rows } = await this.query(
      `UPDATE membership_credits
       SET credits_used = GREATEST(credits_used, $2), updated_at = now()
       WHERE membership_id = $1
       RETURNING credits_used`,
      [membershipId, lessonCount]
    );
    return { ok: true, creditsUsed: rows[0] ? Number(rows[0].credits_used) : null };
  }
}

function formatDate(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return value.slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  try {
    return formatDate(String(value));
  } catch {
    return "";
  }
}

function normalizeBookingRow(row) {
  if (!row) return row;
  const slot_date = formatDate(row.slot_date);
  return { ...row, slot_date, date: slot_date };
}

function summarizeMeta(meta) {
  const m = meta || {};
  return {
    email: m.email || "",
    focus: m.focus || "",
    type: m.type || "",
    privacy: m.privacy || "",
  };
}

function lessonsFromStripeMeta(sourceId, metadata) {
  const m = metadata || {};
  const privacy =
    m.privacy ||
    (m.type === "private" || m.type === "membership_private" ? "private" : "standard");
  const type = m.type || "single";
  const athletes = Number(m.athletes) || 1;
  const seats = seatsForRequest({ type, athletes, privacy, focus: m.focus || "" });
  const base = {
    sourceId,
    type,
    focus: m.focus || "",
    privacy,
    seats,
    athletes,
    email: m.email || "",
    player: m.player || m.player1 || "",
    player2: m.player2 || "",
    parent: m.parent || "",
    phone: m.phone || "",
    mins: 60,
    subId: m.subId || "",
  };
  const out = [];
  for (let i = 1; i <= 4; i++) {
    if (m[`date${i}`] && m[`time${i}`]) {
      out.push({
        ...base,
        id: `${sourceId}-${i}`,
        date: m[`date${i}`],
        time: m[`time${i}`],
      });
    }
  }
  if (!out.length && m.date && m.time) {
    out.push({ ...base, id: `${sourceId}-1`, date: m.date, time: m.time });
  }
  return out;
}
