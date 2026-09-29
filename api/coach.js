// Coach admin API — schedule edits, cash bookings, finances, freeze, settings.
// Auth: ?key=COACH_PASS (same as schedule/calendar).

import { fetchBookings } from "../lib/bookings.js";
import { bookedTimes } from "./slots.js";
import {
  allowedTimes,
  getAvailability,
  durationFor,
  labelToMin,
} from "../lib/schedule.js";
import {
  loadManualBookings,
  saveManualBookings,
  makeManualBooking,
  findBooking,
  activeBookings,
} from "../lib/manualBookings.js";
import {
  loadMembersState,
  saveMembersState,
  upsertMember,
  isFrozen,
  memberRecord,
} from "../lib/membersStore.js";
import { loadFinance, saveFinance, addFinanceEntry, financeSummary } from "../lib/finance.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../lib/settings.js";
import {
  upsertGoogleEvent,
  deleteGoogleEvent,
  googleStatus,
  googleConfigured,
} from "../lib/googleCalendar.js";
import { findMembership, chicagoDate, MEMBER_PERIOD_DAYS } from "../lib/members.js";

function auth(req, res) {
  const pass = process.env.COACH_PASS;
  if (!pass) {
    res.status(500).json({ error: "Set COACH_PASS in Vercel env vars." });
    return null;
  }
  if (String(req.query?.key || req.body?.key || "") !== pass) {
    res.status(401).json({ error: "Wrong passcode." });
    return null;
  }
  return pass;
}

async function listOutstanding() {
  const manual = await loadManualBookings();
  const members = await loadMembersState();
  const out = [];
  activeBookings(manual).forEach((b) => {
    if ((b.amountDueCents || 0) > 0) {
      out.push({
        id: b.id,
        kind: "booking",
        player: b.player,
        email: b.email,
        date: b.date,
        time: b.time,
        type: b.type,
        amountDueCents: b.amountDueCents,
        paymentMethod: b.paymentMethod,
        paymentStatus: b.paymentStatus,
      });
    }
  });
  Object.values(members.byEmail || {}).forEach((m) => {
    if ((m.amountDueCents || 0) > 0) {
      out.push({
        id: `mem_${m.email}`,
        kind: "membership",
        player: m.player || "",
        email: m.email,
        date: "",
        time: "",
        type: "membership",
        amountDueCents: m.amountDueCents,
        paymentMethod: m.paymentMethod || "cash",
        paymentStatus: "balance_due",
      });
    }
  });
  return out;
}

async function dashboard() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  let sessions = [];
  try {
    sessions = await fetchBookings(key);
  } catch {
    sessions = [];
  }

  const settings = await loadSettings();
  const membersState = await loadMembersState();
  const finance = await loadFinance();
  const outstanding = await listOutstanding();
  const gStatus = await googleStatus(settings.googleCalendarId);

  // Build member list from stripe + cash store
  const memberMap = {};
  for (const [email, row] of Object.entries(membersState.byEmail || {})) {
    memberMap[email] = {
      email,
      player: row.player || "",
      parent: row.parent || "",
      phone: row.phone || "",
      frozen: Boolean(row.frozen) || membersState.freezeAll,
      freezeReason: row.reason || membersState.freezeAllReason || "",
      periodBonusDays: row.periodBonusDays || 0,
      cashMembership: Boolean(row.cashMembership),
      amountDueCents: row.amountDueCents || 0,
      amountPaidCents: row.amountPaidCents || 0,
      note: row.note || "",
      kind: row.cashMembership ? "cash" : "card",
    };
  }

  // Pull recent stripe memberships into the list (best-effort)
  if (key) {
    try {
      const emails = new Set(
        sessions.filter((s) => s.type === "membership" && s.email).map((s) => String(s.email).toLowerCase())
      );
      for (const email of emails) {
        if (memberMap[email]) continue;
        const sub = await findMembership(key, email);
        if (!sub) continue;
        const freeze = isFrozen(membersState, email);
        memberMap[email] = {
          email,
          player: sub.metadata?.player || "",
          parent: sub.metadata?.parent || "",
          phone: sub.metadata?.phone || "",
          frozen: freeze.frozen,
          freezeReason: freeze.reason || "",
          periodBonusDays: memberRecord(membersState, email)?.periodBonusDays || 0,
          cashMembership: sub.kind === "cash",
          amountDueCents: Number(sub.metadata?.amount_due || 0) || 0,
          amountPaidCents: 0,
          note: "",
          kind: sub.kind || "payment",
          periodEndDate: chicagoDate(sub.current_period_end),
        };
      }
    } catch {
      /* ignore */
    }
  }

  return {
    sessions,
    members: Object.values(memberMap).sort((a, b) => (a.player || a.email).localeCompare(b.player || b.email)),
    freezeAll: membersState.freezeAll,
    freezeAllReason: membersState.freezeAllReason || "",
    finance: financeSummary(finance.entries, outstanding),
    settings,
    status: {
      payments: Boolean(process.env.STRIPE_SECRET_KEY),
      email: Boolean(process.env.RESEND_API_KEY),
      blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.AVAILABILITY_URL),
      google: gStatus,
    },
  };
}

async function createManual(body) {
  const settings = await loadSettings();
  const type = ["single", "thirty", "membership"].includes(body.type) ? body.type : "single";
  const date = String(body.date || "");
  const time = String(body.time || "");
  const player = String(body.player || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  if (!player || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2} (AM|PM)$/.test(time)) {
    return { status: 400, error: "Need player, day, and time." };
  }

  const availability = await getAvailability();
  if (!allowedTimes(date, availability, durationFor(type)).includes(time)) {
    return { status: 400, error: "That time isn't in your open hours." };
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    const taken = await bookedTimes(key, date);
    const start = labelToMin(time);
    const dur = durationFor(type);
    const conflict =
      start !== null &&
      taken.some((b) => {
        const bStart = labelToMin(b.time);
        return bStart !== null && start < bStart + b.mins && bStart < start + dur;
      });
    if (conflict) return { status: 409, error: "That slot is already taken." };
  }

  const payMethod = body.paymentMethod === "card" ? "card" : body.paymentMethod === "comp" ? "comp" : "cash";
  const total = body.amountCents != null ? Number(body.amountCents) : settings.prices[type] || 0;
  const paid =
    body.amountPaidCents != null
      ? Number(body.amountPaidCents)
      : payMethod === "comp"
      ? 0
      : body.markPaid
      ? total
      : 0;
  const due = Math.max(0, total - paid);

  const booking = makeManualBooking({
    type,
    player,
    parent: body.parent || "",
    phone: body.phone || "",
    email,
    focus: body.focus || "",
    date,
    time,
    availability,
    paymentMethod: payMethod,
    paymentStatus: due > 0 ? (paid > 0 ? "deposit_paid" : "unpaid") : payMethod === "comp" ? "waived" : "paid",
    amountCents: total,
    amountPaidCents: paid,
    amountDueCents: due,
    note: body.note || "",
    createdBy: "coach",
  });

  if (type === "membership" && email) {
    const members = await loadMembersState();
    const start = Math.floor(Date.now() / 1000);
    upsertMember(members, email, {
      cashMembership: true,
      cashMembershipStart: start,
      cashMembershipEnd: start + MEMBER_PERIOD_DAYS * 86400,
      player,
      parent: body.parent || "",
      phone: body.phone || "",
      amountDueCents: due,
      amountPaidCents: paid,
      paymentMethod: payMethod,
    });
    await saveMembersState(members);
    booking.membershipId = `cash_${email}`;
  }

  const g = await upsertGoogleEvent(booking, settings.googleCalendarId);
  if (g.eventId) booking.googleEventId = g.eventId;

  const store = await loadManualBookings();
  store.bookings.push(booking);
  const saved = await saveManualBookings(store);
  if (!saved) return { status: 500, error: "Could not save booking (check Blob)." };

  if (paid > 0) {
    const fin = await loadFinance();
    addFinanceEntry(fin, {
      amountCents: paid,
      method: payMethod === "card" ? "card" : "cash",
      type,
      player,
      email,
      bookingId: booking.id,
      note: "Coach booked lesson",
      date,
    });
    await saveFinance(fin);
  }

  return { status: 200, booking };
}

export default async function handler(req, res) {
  if (!auth(req, res)) return;

  if (req.method === "GET") {
    try {
      const data = await dashboard();
      res.status(200).json(data);
    } catch (e) {
      res.status(500).json({ error: e?.message || "Could not load coach data." });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = String(req.body?.action || "");
  const settings = await loadSettings();

  try {
    if (action === "create_booking") {
      const result = await createManual(req.body || {});
      if (result.error) {
        res.status(result.status || 400).json({ error: result.error });
        return;
      }
      res.status(200).json({ ok: true, booking: result.booking, ...(await dashboard()) });
      return;
    }

    if (action === "cancel_booking") {
      const id = String(req.body?.id || "");
      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b) {
        res.status(404).json({ error: "Only cash/manual bookings can be cancelled here. Card bookings need Stripe or a call." });
        return;
      }
      b.status = "cancelled";
      b.cancelledAt = Date.now();
      if (b.googleEventId) await deleteGoogleEvent(b.googleEventId, settings.googleCalendarId);
      await saveManualBookings(store);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "update_booking") {
      const id = String(req.body?.id || "");
      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b || b.status === "cancelled") {
        res.status(404).json({ error: "Booking not found." });
        return;
      }
      ["player", "parent", "phone", "email", "focus", "note", "date", "time"].forEach((k) => {
        if (req.body[k] != null) b[k] = String(req.body[k]);
      });
      if (b.email) b.email = b.email.toLowerCase();
      const g = await upsertGoogleEvent(b, settings.googleCalendarId);
      if (g.eventId) b.googleEventId = g.eventId;
      await saveManualBookings(store);
      res.status(200).json({ ok: true, booking: b, ...(await dashboard()) });
      return;
    }

    if (action === "collect_payment") {
      const id = String(req.body?.id || "");
      const amount = Math.max(0, Number(req.body?.amountCents) || 0);
      const method = req.body?.method === "card" ? "card" : "cash";
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }

      // Membership balance (mem_email)
      if (id.startsWith("mem_")) {
        const email = id.slice(4);
        const members = await loadMembersState();
        const row = memberRecord(members, email) || { email };
        const due = Math.max(0, Number(row.amountDueCents) || 0);
        const take = Math.min(amount, due || amount);
        row.amountPaidCents = (Number(row.amountPaidCents) || 0) + take;
        row.amountDueCents = Math.max(0, due - take);
        upsertMember(members, email, row);
        await saveMembersState(members);
        const fin = await loadFinance();
        addFinanceEntry(fin, {
          amountCents: take,
          method,
          type: "membership",
          player: row.player || "",
          email,
          note: "Membership balance collected",
        });
        await saveFinance(fin);
        res.status(200).json({ ok: true, collected: take, ...(await dashboard()) });
        return;
      }

      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b) {
        res.status(404).json({ error: "Booking not found." });
        return;
      }
      const take = Math.min(amount, b.amountDueCents || amount);
      b.amountPaidCents = (b.amountPaidCents || 0) + take;
      b.amountDueCents = Math.max(0, (b.amountDueCents || 0) - take);
      b.paymentStatus = b.amountDueCents > 0 ? "deposit_paid" : "paid";
      await saveManualBookings(store);

      // Mirror onto member balance if linked
      if (b.email && b.type === "membership") {
        const members = await loadMembersState();
        const row = memberRecord(members, b.email);
        if (row) {
          row.amountPaidCents = (Number(row.amountPaidCents) || 0) + take;
          row.amountDueCents = Math.max(0, (Number(row.amountDueCents) || 0) - take);
          upsertMember(members, b.email, row);
          await saveMembersState(members);
        }
      }

      const fin = await loadFinance();
      addFinanceEntry(fin, {
        amountCents: take,
        method,
        type: b.type,
        player: b.player,
        email: b.email,
        bookingId: b.id,
        date: b.date,
        note: "Collected outstanding balance",
      });
      await saveFinance(fin);
      await upsertGoogleEvent(b, settings.googleCalendarId);
      res.status(200).json({ ok: true, booking: b, collected: take, ...(await dashboard()) });
      return;
    }

    if (action === "freeze_one") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const frozen = Boolean(req.body?.frozen);
      const reason = String(req.body?.reason || "");
      if (!email) {
        res.status(400).json({ error: "Email required." });
        return;
      }
      const members = await loadMembersState();
      const prev = memberRecord(members, email) || {};
      const patch = { frozen, reason: frozen ? reason : "" };
      if (frozen) {
        patch.frozenAt = Date.now();
      } else if (prev.frozenAt) {
        // Extend membership by days they were frozen
        const days = Math.ceil((Date.now() - prev.frozenAt) / 86400000);
        patch.periodBonusDays = (Number(prev.periodBonusDays) || 0) + Math.max(0, days);
        patch.frozenAt = null;
        // Also extend cash membership end if present
        if (prev.cashMembershipEnd) {
          patch.cashMembershipEnd = Number(prev.cashMembershipEnd) + Math.max(0, days) * 86400;
        }
      }
      upsertMember(members, email, patch);
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "freeze_all") {
      const frozen = Boolean(req.body?.frozen);
      const reason = String(req.body?.reason || (frozen ? "Paused — coach unavailable" : ""));
      const members = await loadMembersState();
      if (frozen) {
        members.freezeAll = true;
        members.freezeAllAt = Date.now();
        members.freezeAllReason = reason;
      } else {
        // Extend every currently tracked member by freeze duration
        const days = members.freezeAllAt
          ? Math.ceil((Date.now() - members.freezeAllAt) / 86400000)
          : 0;
        if (days > 0) {
          Object.keys(members.byEmail || {}).forEach((email) => {
            const row = members.byEmail[email];
            row.periodBonusDays = (Number(row.periodBonusDays) || 0) + days;
            if (row.cashMembershipEnd) {
              row.cashMembershipEnd = Number(row.cashMembershipEnd) + days * 86400;
            }
          });
        }
        members.freezeAll = false;
        members.freezeAllAt = null;
        members.freezeAllReason = "";
      }
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "save_settings") {
      const next = {
        ...settings,
        ...(req.body?.settings || {}),
        prices: { ...settings.prices, ...(req.body?.settings?.prices || {}) },
      };
      const saved = await saveSettings(next);
      if (!saved) {
        res.status(500).json({ error: "Could not save settings (check Blob)." });
        return;
      }
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "add_finance") {
      const amount = Number(req.body?.amountCents) || 0;
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }
      const fin = await loadFinance();
      addFinanceEntry(fin, {
        amountCents: amount,
        method: req.body?.method === "card" ? "card" : "cash",
        type: req.body?.type || "other",
        player: req.body?.player || "",
        email: req.body?.email || "",
        note: req.body?.note || "Manual entry",
        date: req.body?.date || undefined,
      });
      await saveFinance(fin);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "member_note") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) {
        res.status(400).json({ error: "Email required." });
        return;
      }
      const members = await loadMembersState();
      upsertMember(members, email, {
        note: String(req.body?.note || ""),
        player: req.body?.player || memberRecord(members, email)?.player || "",
      });
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "extend_member") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const days = Math.max(0, Number(req.body?.days) || 0);
      if (!email || !days) {
        res.status(400).json({ error: "Email and days required." });
        return;
      }
      const members = await loadMembersState();
      const prev = memberRecord(members, email) || { email };
      const patch = {
        periodBonusDays: (Number(prev.periodBonusDays) || 0) + days,
      };
      if (prev.cashMembershipEnd) {
        patch.cashMembershipEnd = Number(prev.cashMembershipEnd) + days * 86400;
      }
      upsertMember(members, email, patch);
      await saveMembersState(members);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    res.status(400).json({
      error: "Unknown action.",
      actions: [
        "create_booking",
        "cancel_booking",
        "update_booking",
        "collect_payment",
        "freeze_one",
        "freeze_all",
        "save_settings",
        "add_finance",
        "member_note",
        "extend_member",
      ],
      defaults: DEFAULT_SETTINGS,
      googleConfigured: googleConfigured(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Coach action failed." });
  }
}
