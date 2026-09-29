import { blobRead, blobWrite } from "./store.js";

const FILE = "members.json";

function empty() {
  return {
    freezeAll: false,
    freezeAllAt: null,
    freezeAllReason: "",
    byEmail: {},
  };
}

export async function loadMembersState() {
  const raw = await blobRead(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    return {
      freezeAll: Boolean(data.freezeAll),
      freezeAllAt: data.freezeAllAt || null,
      freezeAllReason: data.freezeAllReason || "",
      byEmail: data.byEmail && typeof data.byEmail === "object" ? data.byEmail : {},
    };
  } catch {
    return empty();
  }
}

export async function saveMembersState(state) {
  const ok = await blobWrite(FILE, state);
  return ok ? state : null;
}

export function memberRecord(state, email) {
  const e = String(email || "").trim().toLowerCase();
  return state.byEmail[e] || null;
}

export function isMemberFrozen(state, email) {
  if (state.freezeAll) {
    return {
      frozen: true,
      scope: "all",
      reason: state.freezeAllReason || "All memberships are paused right now.",
    };
  }
  const row = memberRecord(state, email);
  if (row?.frozen) {
    return {
      frozen: true,
      scope: "one",
      reason: row.reason || "This membership is paused. Call or text (405) 819-4401.",
    };
  }
  return { frozen: false };
}

export function upsertMember(state, email, patch) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return state;
  state.byEmail[e] = {
    ...(state.byEmail[e] || {}),
    ...patch,
    email: e,
    // Every caller here means real activity — a booking, a payment, a freeze. If
    // this card was taken off the list, that activity puts it back, so a second
    // email that starts paying again can't stay hidden.
    removed: false,
    removedAt: null,
    updatedAt: Date.now(),
  };
  return state;
}

// Parents sometimes sign up twice under two emails, which leaves the coach
// looking at two cards for one athlete. Removing a card hides it from the
// members list without throwing anything away: the record keeps their history,
// notes and balance, so a card taken off by mistake can be put straight back.
export function isMemberRemoved(state, email) {
  return Boolean(memberRecord(state, email)?.removed);
}

export function removeMember(state, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return state;
  state.byEmail[e] = {
    ...(state.byEmail[e] || {}),
    email: e,
    removed: true,
    removedAt: Date.now(),
    updatedAt: Date.now(),
  };
  return state;
}

export function restoreMember(state, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !state.byEmail[e]) return state;
  state.byEmail[e] = {
    ...state.byEmail[e],
    removed: false,
    removedAt: null,
    updatedAt: Date.now(),
  };
  return state;
}

export function removedMembers(state) {
  return Object.values(state.byEmail || {})
    .filter((m) => m && m.removed)
    .sort((a, b) => (Number(b.removedAt) || 0) - (Number(a.removedAt) || 0));
}

export function periodBonusDays(state, email) {
  const row = memberRecord(state, email);
  return Math.max(0, Number(row?.periodBonusDays) || 0);
}

// Days the coach freeze has been running but not yet written into periodBonusDays
// (that write happens on unfreeze). Used so the membership stays valid while paused.
export function activeFreezeBonusDays(state, email) {
  if (state?.freezeAll && state.freezeAllAt) {
    return Math.max(0, Math.ceil((Date.now() - state.freezeAllAt) / 86400000));
  }
  const row = memberRecord(state, email);
  if (row?.frozen && row.frozenAt) {
    return Math.max(0, Math.ceil((Date.now() - row.frozenAt) / 86400000));
  }
  return 0;
}

export function totalPeriodBonusDays(state, email) {
  return periodBonusDays(state, email) + activeFreezeBonusDays(state, email);
}
