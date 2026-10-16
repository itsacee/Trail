/**
 * Short-lived member login OTP codes (6 digits).
 * Codes are never stored in plaintext — only a salted SHA-256 hash.
 * Storage: private Blob when available, else in-process Map (tests).
 */
import crypto from "crypto";
import { head, put } from "@vercel/blob";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const MEMORY = new Map();

function pepper() {
  return (
    process.env.MEMBER_OTP_PEPPER ||
    process.env.MEMBER_SECRET ||
    process.env.COACH_PASS ||
    process.env.STRIPE_SECRET_KEY ||
    "otp-dev-pepper"
  );
}

function emailKey(email) {
  return crypto
    .createHash("sha256")
    .update(`otp-email:${String(email || "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

function hashCode(email, code, salt) {
  return crypto
    .createHash("sha256")
    .update(`${pepper()}|${String(email).trim().toLowerCase()}|${salt}|${code}`)
    .digest("hex");
}

function blobToken() {
  return process.env.PRIVATE_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || "";
}

function blobPath(email) {
  return `member-otp/${emailKey(email)}.json`;
}

function memoryOnly() {
  return process.env.BLOB_MEMORY_STORE === "1" || !blobToken();
}

async function readRecord(email) {
  const key = emailKey(email);
  if (memoryOnly()) return MEMORY.get(key) || null;
  try {
    const meta = await head(blobPath(email), { token: blobToken() });
    if (!meta?.url) return MEMORY.get(key) || null;
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${blobToken()}` },
    });
    if (!res.ok) return MEMORY.get(key) || null;
    return await res.json();
  } catch {
    return MEMORY.get(key) || null;
  }
}

async function writeRecord(email, record) {
  const key = emailKey(email);
  MEMORY.set(key, record);
  if (memoryOnly()) return;
  try {
    await put(blobPath(email), JSON.stringify(record), {
      access: "private",
      token: blobToken(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  } catch (err) {
    console.error("memberOtp blob write failed:", err?.message || err);
  }
}

function pruneHistory(history = [], now = Date.now()) {
  return history.filter((t) => now - t < 60 * 60 * 1000);
}

export function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function issueMemberOtp(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
    return { ok: false, error: "invalid_email" };
  }
  const now = Date.now();
  const prev = (await readRecord(em)) || {};
  if (prev.issuedAt && now - prev.issuedAt < RESEND_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - (now - prev.issuedAt)) / 1000);
    return { ok: false, error: "cooldown", retryAfterSec };
  }
  const history = pruneHistory(prev.issueHistory || [], now);
  if (history.length >= MAX_CODES_PER_HOUR) {
    return { ok: false, error: "rate_limited", retryAfterSec: 3600 };
  }
  const code = generateOtpCode();
  const salt = crypto.randomBytes(16).toString("hex");
  const record = {
    hash: hashCode(em, code, salt),
    salt,
    expiresAt: now + CODE_TTL_MS,
    issuedAt: now,
    attempts: 0,
    used: false,
    issueHistory: [...history, now],
  };
  await writeRecord(em, record);
  return { ok: true, code, expiresInSec: Math.floor(CODE_TTL_MS / 1000) };
}

export async function verifyMemberOtp(email, code) {
  const em = String(email || "").trim().toLowerCase();
  const submitted = String(code || "").replace(/\D/g, "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || !/^\d{6}$/.test(submitted)) {
    return { ok: false, error: "invalid" };
  }
  const now = Date.now();
  const record = await readRecord(em);
  if (!record || record.used || !record.hash || !record.salt) {
    return { ok: false, error: "invalid" };
  }
  if (Number(record.expiresAt) < now) {
    return { ok: false, error: "expired" };
  }
  if (Number(record.attempts) >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, error: "locked" };
  }
  const nextAttempts = Number(record.attempts || 0) + 1;
  const match = hashCode(em, submitted, record.salt) === record.hash;
  if (!match) {
    await writeRecord(em, { ...record, attempts: nextAttempts });
    return { ok: false, error: nextAttempts >= MAX_VERIFY_ATTEMPTS ? "locked" : "invalid" };
  }
  await writeRecord(em, { ...record, used: true, attempts: nextAttempts });
  return { ok: true };
}

export function clearMemberOtpMemory() {
  MEMORY.clear();
}
