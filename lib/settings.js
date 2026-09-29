import { blobRead, blobWrite } from "./store.js";

const FILE = "settings.json";

export const DEFAULT_SETTINGS = {
  prices: {
    single: 7000, // cents
    thirty: 5000,
    membership: 24000,
  },
  // Card deposit toward a membership; remainder collected in cash.
  membershipDeposit: 10000,
  allowCash: true,
  allowDeposit: true,
  googleCalendarId: "", // falls back to GOOGLE_CALENDAR_ID env
};

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

export function dollars(cents) {
  return (Number(cents) || 0) / 100;
}
