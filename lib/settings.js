import { blobRead, blobWrite } from "./store.js";

const FILE = "settings.json";

export const DEFAULT_SETTINGS = {
  prices: {
    single: 8000, // regular hour, per athlete — two athletes can share the hour
    thirty: 6000,
    membership: 28000,
    private: 10000, // 1-on-1: buys the whole hour so nobody else can join
  },
  membershipDeposit: 8000, // $80 card deposit; rest is cash at the first lesson
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
