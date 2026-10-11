import { blobRead, blobWrite } from "./store.js";

const FILE = "settings.json";

export const DEFAULT_SETTINGS = {
  prices: {
    single: 8000, // regular hour, per athlete — two athletes can share the hour
    thirty: 6000,
    membership: 28000, // standard membership — 4 lessons / 30 days
    membership_private: 36000, // private membership — 4 exclusive lessons / 30 days
    private: 10000, // 1-on-1 drop-in: buys the whole hour so nobody else can join
  },
  membershipDeposit: 8000, // $80 card deposit on STANDARD membership only; rest cash at first lesson
  allowCash: true,
  allowDeposit: true, // deposit applies to standard membership only (not private)
};

// What one athlete on this booking costs.
//
// New private drop-ins are always one athlete at the private price. The
// athletes>1 branch remains only so historical sibling-private receipts still
// price-check; the booking APIs reject new private pairs.
//
// IMPORTANT: mirrored in js/booking-core.js for the booking form — change both.
export function unitPriceFor(type, athletes, prices) {
  const table = { ...DEFAULT_SETTINGS.prices, ...(prices || {}) };
  if (type === "private" && Number(athletes) > 1) return table.single;
  return table[type] || 0;
}

export async function loadSettings() {
  const raw = await blobRead(FILE);
  if (!raw) return { ...DEFAULT_SETTINGS, prices: { ...DEFAULT_SETTINGS.prices } };
  try {
    const data = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...data,
      prices: { ...DEFAULT_SETTINGS.prices, ...(data.prices || {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, prices: { ...DEFAULT_SETTINGS.prices } };
  }
}

export async function saveSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...settings,
    prices: { ...DEFAULT_SETTINGS.prices, ...(settings.prices || {}) },
  };
  const ok = await blobWrite(FILE, next);
  return ok ? next : null;
}
