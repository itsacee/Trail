import { blobRead, blobWrite } from "./store.js";

const FILE = "finance.json";

function empty() {
  return { entries: [] };
}

export async function loadFinance() {
  const raw = await blobRead(FILE);
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw);
    return { entries: Array.isArray(data?.entries) ? data.entries : [] };
  } catch {
    return empty();
  }
}

export async function saveFinance(data) {
  const cutoff = Date.now() - 800 * 86400 * 1000;
  const entries = (data.entries || []).filter((e) => !e?.at || e.at >= cutoff);
  const ok = await blobWrite(FILE, { entries });
  return ok ? { entries } : null;
}

export function newEntryId() {
  return `fin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addFinanceEntry(data, {
  amountCents,
  method,
  type,
  player,
  email,
  bookingId,
  note,
  date,
}) {
  const entry = {
    id: newEntryId(),
    at: Date.now(),
    date: date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
    amountCents: Number(amountCents) || 0,
    method: method || "cash",
    type: type || "",
    player: player || "",
    email: String(email || "").toLowerCase(),
    bookingId: bookingId || "",
    note: note || "",
  };
  data.entries.push(entry);
  return entry;
}

function chicagoToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function mondayOf(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthKey(iso) {
  return String(iso || "").slice(0, 7);
}

export function financeSummary(entries, outstanding = []) {
  const today = chicagoToday();
  const thisWeek = mondayOf(today);
  const thisMonth = monthKey(today);
  const sum = (list) => list.reduce((n, e) => n + (Number(e.amountCents) || 0), 0);
  const paid = (entries || []).filter((e) => (e.amountCents || 0) > 0);
  const week = paid.filter((e) => e.date >= thisWeek);
  const month = paid.filter((e) => monthKey(e.date) === thisMonth);

  const byMethod = (list) => {
    const out = { card: 0, cash: 0, other: 0 };
    list.forEach((e) => {
      const m = e.method === "card" || e.method === "cash" ? e.method : "other";
      out[m] += Number(e.amountCents) || 0;
    });
    return out;
  };

  return {
    todayCents: sum(paid.filter((e) => e.date === today)),
    weekCents: sum(week),
    monthCents: sum(month),
    allCents: sum(paid),
    weekByMethod: byMethod(week),
    monthByMethod: byMethod(month),
    outstandingCents: (outstanding || []).reduce((n, b) => n + (Number(b.amountDueCents) || 0), 0),
    outstanding: outstanding || [],
    recent: [...paid].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40),
  };
}
