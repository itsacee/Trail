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

export function tokenFromRequest(req) {
  const header = String(req.headers?.authorization || "");
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return readMemberToken(bearer);
  const q = String(req.query?.k || "").trim();
  return q ? readMemberToken(q) : null;
}
