import { blobRead, blobWrite } from "./store.js";

const FILE = "settings.json";

export const DEFAULT_SETTINGS = {
  prices: {
    single: 8000,
    thirty: 6000,
    membership: 28000,
  },
  membershipDeposit: 10000, // $100 card deposit toward $280 membership
  allowCash: true,
  allowDeposit: true,
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
