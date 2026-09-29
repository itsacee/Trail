// Coach admin: finances, collect cash, freeze members, facility pause toggles.

import { fetchBookings } from "../lib/bookings.js";
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
  memberRecord,
  isMemberFrozen,
} from "../lib/membersStore.js";
import { loadFinance, saveFinance, addFinanceEntry, financeSummary } from "../lib/finance.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { loadCoachStatus, saveCoachStatus } from "../lib/coachStatus.js";
import { getSiteStatus } from "../lib/siteStatus.js";
import { getAvailability, allowedTimes, durationFor, slotBlocked } from "../lib/schedule.js";
import { bookedTimes } from "./slots.js";
import { MEMBER_PERIOD_DAYS } from "../lib/members.js";
import { normalizeFocus } from "../lib/siteStatus.js";

function auth(req, res) {
  const pass = process.env.COACH_PASS;
  if (!pass) {
    res.status(500).json({ error: "Set COACH_PASS in Vercel." });
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
      });
    }
  });
  return out;
}

async function dashboard() {
  await loadCoachStatus();
  const key = process.env.STRIPE_SECRET_KEY || "";
  let sessions = [];
  try {
    sessions = await fetchBookings(key);
  } catch {
    sessions = [];
  }
  const membersState = await loadMembersState();
  const finance = await loadFinance();
  const outstanding = await listOutstanding();
  const settings = await loadSettings();
  const siteStatus = getSiteStatus();

  const members = Object.values(membersState.byEmail || {}).map((m) => ({
    email: m.email,
    player: m.player || "",
    parent: m.parent || "",
    phone: m.phone || "",
    frozen: isMemberFrozen(membersState, m.email).frozen,
    amountDueCents: m.amountDueCents || 0,
    cashMembership: Boolean(m.cashMembership),
    note: m.note || "",
  }));

  // Also surface emails from upcoming membership lessons
  sessions
    .filter((s) => s.type === "membership" && s.email)
    .forEach((s) => {
      const e = String(s.email).toLowerCase();
      if (members.some((m) => m.email === e)) return;
      members.push({
        email: e,
        player: s.player || "",
        parent: s.parent || "",
        phone: s.phone || "",
        frozen: isMemberFrozen(membersState, e).frozen,
        amountDueCents: 0,
        cashMembership: false,
        note: "",
      });
    });

  return {
    sessions,
    members: members.sort((a, b) => (a.player || a.email).localeCompare(b.player || b.email)),
    freezeAll: membersState.freezeAll,
    freezeAllReason: membersState.freezeAllReason || "",
    finance: financeSummary(finance.entries, outstanding),
    settings,
    siteStatus,
  };
}

export default async function handler(req, res) {
  if (!auth(req, res)) return;
  await loadCoachStatus();

  if (req.method === "GET") {
    try {
      res.status(200).json(await dashboard());
    } catch (e) {
      res.status(500).json({ error: e?.message || "Couldn't load coach data." });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = String(req.body?.action || "");
  const key = process.env.STRIPE_SECRET_KEY || "";

  try {
    if (action === "collect_payment") {
      const id = String(req.body?.id || "");
      const amount = Math.max(0, Number(req.body?.amountCents) || 0);
      const method = req.body?.method === "card" ? "card" : "cash";
      if (!amount) {
        res.status(400).json({ error: "Enter an amount." });
        return;
      }

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
        res.status(200).json({ ok: true, ...(await dashboard()) });
        return;
      }

      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b) {
        res.status(404).json({ error: "Booking not found (only cash/manual bookings can be collected here)." });
        return;
      }
      const take = Math.min(amount, b.amountDueCents || amount);
      b.amountPaidCents = (b.amountPaidCents || 0) + take;
      b.amountDueCents = Math.max(0, (b.amountDueCents || 0) - take);
      b.paymentStatus = b.amountDueCents > 0 ? "deposit_paid" : "paid";
      await saveManualBookings(store);
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
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "cancel_booking") {
      const id = String(req.body?.id || "");
      const store = await loadManualBookings();
      const b = findBooking(store, id);
      if (!b) {
        res.status(404).json({ error: "Only cash/manual bookings can be cancelled here." });
        return;
      }
      b.status = "cancelled";
      b.cancelledAt = Date.now();
      await saveManualBookings(store);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "create_booking") {
      const settings = await loadSettings();
      const type = ["single", "thirty", "membership"].includes(req.body.type) ? req.body.type : "single";
      const date = String(req.body.date || "");
      const time = String(req.body.time || "");
      const player = String(req.body.player || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!player || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2} (AM|PM)$/.test(time)) {
        res.status(400).json({ error: "Need player, day, and time." });
        return;
      }
      const focus = normalizeFocus(req.body.focus || "Fielding", type);
      const availability = await getAvailability();
      if (!allowedTimes(date, availability, durationFor(type)).includes(time)) {
        res.status(400).json({ error: "That time isn't in your open hours." });
        return;
      }
      if (key) {
        const taken = await bookedTimes(key, date);
        if (slotBlocked(taken, time, durationFor(type), focus)) {
          res.status(409).json({ error: "That slot is already taken." });
          return;
        }
      }
      const payMethod = req.body.paymentMethod === "card" ? "card" : req.body.paymentMethod === "comp" ? "comp" : "cash";
      const total = req.body.amountCents != null ? Number(req.body.amountCents) : settings.prices[type] || 0;
      const paid = req.body.markPaid || payMethod === "card" ? total : payMethod === "comp" ? 0 : 0;
      const due = Math.max(0, total - paid);
      const booking = makeManualBooking({
        type,
        player,
        parent: req.body.parent || "",
        phone: req.body.phone || "",
        email,
        focus,
        date,
        time,
        availability,
        paymentMethod: payMethod,
        paymentStatus: due > 0 ? "unpaid" : payMethod === "comp" ? "waived" : "paid",
        amountCents: total,
        amountPaidCents: paid,
        amountDueCents: due,
        note: req.body.note || "",
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
          amountDueCents: due,
          amountPaidCents: paid,
          paymentMethod: payMethod,
        });
        await saveMembersState(members);
      }
      const store = await loadManualBookings();
      store.bookings.push(booking);
      await saveManualBookings(store);
      if (paid > 0) {
        const fin = await loadFinance();
        addFinanceEntry(fin, {
          amountCents: paid,
          method: payMethod === "card" ? "card" : "cash",
          type,
          player,
          email,
          bookingId: booking.id,
          date,
          note: "Coach booked lesson",
        });
        await saveFinance(fin);
      }
      res.status(200).json({ ok: true, booking, ...(await dashboard()) });
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
      const patch = { frozen, reason: frozen ? reason : "", player: req.body.player || prev.player || "" };
      if (frozen) patch.frozenAt = Date.now();
      else if (prev.frozenAt) {
        const days = Math.ceil((Date.now() - prev.frozenAt) / 86400000);
        patch.periodBonusDays = (Number(prev.periodBonusDays) || 0) + Math.max(0, days);
        patch.frozenAt = null;
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
      const reason = String(req.body?.reason || (frozen ? "Paused by coach" : ""));
      const members = await loadMembersState();
      if (frozen) {
        members.freezeAll = true;
        members.freezeAllAt = Date.now();
        members.freezeAllReason = reason;
      } else {
        const days = members.freezeAllAt ? Math.ceil((Date.now() - members.freezeAllAt) / 86400000) : 0;
        if (days > 0) {
          Object.keys(members.byEmail || {}).forEach((email) => {
            const row = members.byEmail[email];
            row.periodBonusDays = (Number(row.periodBonusDays) || 0) + days;
            if (row.cashMembershipEnd) row.cashMembershipEnd = Number(row.cashMembershipEnd) + days * 86400;
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

    if (action === "save_site_status") {
      const cur = await loadCoachStatus();
      const next = {
        ...cur,
        blockNewMemberships:
          typeof req.body.blockNewMemberships === "boolean" ? req.body.blockNewMemberships : cur.blockNewMemberships,
        membershipFrozen:
          typeof req.body.membershipFrozen === "boolean" ? req.body.membershipFrozen : cur.membershipFrozen,
        fieldingOnly: typeof req.body.fieldingOnly === "boolean" ? req.body.fieldingOnly : cur.fieldingOnly,
      };
      if (req.body.membershipFrozen === true && !cur.membershipFreezeSince) {
        next.membershipFreezeSince = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      }
      if (req.body.membershipFrozen === false) {
        next.membershipFreezeSince = null;
      }
      await saveCoachStatus(next);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    if (action === "save_settings") {
      const cur = await loadSettings();
      const saved = await saveSettings({ ...cur, ...(req.body.settings || {}) });
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
        note: req.body?.note || "Manual entry",
      });
      await saveFinance(fin);
      res.status(200).json({ ok: true, ...(await dashboard()) });
      return;
    }

    res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Coach action failed." });
  }
}
