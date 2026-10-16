import crypto from "crypto";

function secret() {
  return process.env.MEMBER_SECRET || process.env.COACH_PASS || process.env.STRIPE_SECRET_KEY || "";
}

function hmac(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function signMemberToken(email, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = `${String(email).trim().toLowerCase()}|${exp}`;
  return `${Buffer.from(payload).toString("base64url")}.${hmac(payload)}`;
}

export function readMemberToken(token) {
  if (!secret()) return null;
  const [raw, sig] = String(token || "").split(".");
  if (!raw || !sig) return null;
  let payload = "";
  try {
    payload = Buffer.from(raw, "base64url").toString();
  } catch {
    return null;
  }
  if (!safeEqual(hmac(payload), sig)) return null;
  const [email, exp] = payload.split("|");
  if (!email || Number(exp) < Date.now() / 1000) return null;
  return email.trim().toLowerCase();
}

function cookieValue(req, name) {
  const raw = String(req.headers?.cookie || "");
  if (!raw) return "";
  const parts = raw.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

export function tokenFromRequest(req) {
  const header = String(req.headers?.authorization || "");
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const fromBearer = readMemberToken(bearer);
    if (fromBearer) return fromBearer;
  }
  const q = String(req.query?.k || "").trim();
  if (q) {
    const fromQuery = readMemberToken(q);
    if (fromQuery) return fromQuery;
  }
  const cookieTok = cookieValue(req, "ap_member_session");
  return cookieTok ? readMemberToken(cookieTok) : null;
}

/** Secure session cookie for OTP / magic-link member sessions. */
export function memberSessionCookie(token, { maxAgeSec = 30 * 86400 } = {}) {
  const parts = [
    `ap_member_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.max(60, Number(maxAgeSec) || 30 * 86400)}`,
  ];
  return parts.join("; ");
}

export function clearMemberSessionCookie() {
  return "ap_member_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}
