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
    updatedAt: Date.now(),
  };
  return state;
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
