// Google Calendar push sync via a service account (no npm deps).
//
// Setup (one time):
// 1. Google Cloud Console → create a project → enable Google Calendar API
// 2. Create a service account → download JSON key
// 3. Share calendar nubulah.fr4@gmail.com with the service account email
//    (permission: "Make changes to events")
// 4. Vercel env:
//      GOOGLE_SERVICE_ACCOUNT_JSON = {full JSON key as one line}
//      GOOGLE_CALENDAR_ID = nubulah.fr4@gmail.com   (optional if set in settings)

import crypto from "crypto";
import { LOCATIONS, durationFor, labelToMin } from "./schedule.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";

let cachedToken = null; // { access_token, exp }

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}

export function googleConfigured() {
  return Boolean(parseServiceAccount());
}

export function defaultCalendarId(settingsId) {
  return (
    settingsId ||
    process.env.GOOGLE_CALENDAR_ID ||
    "nubulah.fr4@gmail.com"
  );
}

async function getAccessToken() {
  const sa = parseServiceAccount();
  if (!sa?.client_email || !sa?.private_key) return null;
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.access_token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: CAL_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const key = sa.private_key.replace(/\\n/g, "\n");
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key);
  const jwt = `${unsigned}.${sig.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    exp: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.access_token;
}

function eventTimes(date, timeLabel, type) {
  const startMin = labelToMin(timeLabel);
  if (startMin === null || !date) return null;
  const dur = durationFor(type);
  const [y, m, d] = date.split("-").map(Number);
  const startH = Math.floor(startMin / 60);
  const startM = startMin % 60;
  const endTotal = startMin + dur;
  const endH = Math.floor(endTotal / 60);
  const endM = endTotal % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return {
    start: {
      dateTime: `${y}-${pad(m)}-${pad(d)}T${pad(startH)}:${pad(startM)}:00`,
      timeZone: "America/Chicago",
    },
    end: {
      dateTime: `${y}-${pad(m)}-${pad(d)}T${pad(endH)}:${pad(endM)}:00`,
      timeZone: "America/Chicago",
    },
  };
}

function buildEvent(booking) {
  const times = eventTimes(booking.date, booking.time, booking.type);
  if (!times) return null;
  const loc = LOCATIONS[booking.loc] || LOCATIONS.mustang || {};
  const typeLabel =
    booking.type === "thirty" ? "30-min" : booking.type === "membership" ? "Membership" : "Private";
  const summary = `${booking.player || "Lesson"} · ${typeLabel}${booking.focus ? ` · ${booking.focus}` : ""}`;
  const desc = [
    booking.parent ? `Parent: ${booking.parent}` : "",
    booking.phone ? `Phone: ${booking.phone}` : "",
    booking.email ? `Email: ${booking.email}` : "",
    booking.paymentMethod ? `Pay: ${booking.paymentMethod}` : "",
    booking.paymentStatus ? `Status: ${booking.paymentStatus}` : "",
    booking.amountDueCents ? `Balance due: $${(booking.amountDueCents / 100).toFixed(2)}` : "",
    booking.note ? `Note: ${booking.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary,
    description: desc,
    location: loc.address || loc.name || "",
    ...times,
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    },
  };
}

async function calFetch(calendarId, path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Google Calendar not connected." };
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function upsertGoogleEvent(booking, calendarId) {
  if (!googleConfigured()) return { ok: false, skipped: true };
  const calId = defaultCalendarId(calendarId);
  const event = buildEvent(booking);
  if (!event) return { ok: false, error: "Bad date/time" };

  if (booking.googleEventId) {
    const upd = await calFetch(calId, `/events/${encodeURIComponent(booking.googleEventId)}`, {
      method: "PUT",
      body: event,
    });
    if (upd.ok) return { ok: true, eventId: booking.googleEventId };
  }

  const created = await calFetch(calId, "/events", { method: "POST", body: event });
  if (!created.ok) return { ok: false, error: created.data?.error?.message || "Create failed" };
  return { ok: true, eventId: created.data.id };
}

export async function deleteGoogleEvent(googleEventId, calendarId) {
  if (!googleConfigured() || !googleEventId) return { ok: false, skipped: true };
  const calId = defaultCalendarId(calendarId);
  const res = await calFetch(calId, `/events/${encodeURIComponent(googleEventId)}`, {
    method: "DELETE",
  });
  // 404 / 410 = already gone
  if (res.ok || res.status === 204 || res.status === 404 || res.status === 410) {
    return { ok: true };
  }
  return { ok: false, error: res.data?.error?.message || "Delete failed" };
}

export async function googleStatus(calendarId) {
  if (!googleConfigured()) {
    return { connected: false, calendarId: defaultCalendarId(calendarId) };
  }
  const calId = defaultCalendarId(calendarId);
  const res = await calFetch(calId, "");
  return {
    connected: res.ok,
    calendarId: calId,
    summary: res.data?.summary || "",
    error: res.ok ? "" : res.data?.error?.message || "Could not reach calendar",
  };
}
