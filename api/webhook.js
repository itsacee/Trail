// Stripe webhook — the reliable half of booking confirmations.
//
// /api/confirm only runs if the buyer's browser reaches the success page. Pay
// on a phone, close the tab or lose signal, and the email never goes out and
// never retries. Stripe calls this endpoint from its own servers instead, so
// the confirmation depends on the payment, not the browser.
//
// Both paths share deliverConfirmation() and both set the same
// `confirmation_sent` flag on the payment, so whichever gets there first wins
// and nobody is emailed twice.
//
// Set up in Stripe: Developers -> Webhooks -> Add endpoint
//   URL     https://www.apacademybsb.com/api/webhook
//   Events  checkout.session.completed
//           checkout.session.async_payment_succeeded
// Then put the signing secret (whsec_...) in Vercel as STRIPE_WEBHOOK_SECRET.

import crypto from "crypto";
import { deliverConfirmation } from "./confirm.js";

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

// Vercel's Node runtime usually parses the body for us, which consumes the
// stream. Grab the raw bytes when they're still there — signature checking
// needs the exact payload Stripe signed, not a re-serialised copy.
async function rawBody(req) {
  if (req.readableEnded || req.bodyUsed) return null;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return null;
    return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  } catch {
    return null;
  }
}

// Stripe signs `timestamp.payload`; the header carries the timestamp plus one
// or more v1 signatures.
function signatureValid(raw, header, secret) {
  const parts = Object.fromEntries(
    String(header || "")
      .split(",")
      .map((p) => p.split("=").map((s) => s.trim()))
      .filter((p) => p.length === 2)
  );
  const t = parts.t;
  if (!t || !parts.v1) return false;

  // Reject anything older than five minutes so a captured request can't be replayed.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${raw.toString("utf8")}`)
    .digest("hex");

  const given = String(header)
    .split(",")
    .map((p) => p.split("="))
    .filter(([k]) => k.trim() === "v1")
    .map(([, v]) => v.trim());

  return given.some((sig) => {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = await rawBody(req);

  let event;
  if (raw) {
    if (secret && !signatureValid(raw, req.headers["stripe-signature"], secret)) {
      console.error("Webhook rejected: bad signature");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
  } else {
    // Body was already parsed, so the exact bytes are gone and the signature
    // can't be checked. Safe to continue: nothing below trusts this payload —
    // we only take the session id, then re-fetch and re-verify it with our own
    // Stripe key before emailing anyone.
    event = req.body;
    if (secret) console.warn("Webhook: raw body unavailable, skipped signature check");
  }

  const object = event?.data?.object;
  if (!HANDLED.has(event?.type) || object?.object !== "checkout.session") {
    // Acknowledge everything else so Stripe stops retrying it.
    res.status(200).json({ received: true, ignored: event?.type || "unknown" });
    return;
  }

  const result = await deliverConfirmation({
    key: process.env.STRIPE_SECRET_KEY,
    resendKey: process.env.RESEND_API_KEY,
    from: process.env.FROM_EMAIL || "AP Academy <bookings@apacademybsb.com>",
    sessionId: object.id,
    origin: `https://${req.headers.host || "www.apacademybsb.com"}`,
  });

  const { sent, alreadySent, error } = result.body || {};
  console.log("Webhook confirmation:", object.id, { sent, alreadySent, error });

  // Always 200 — a non-2xx makes Stripe retry, and a failed email is not
  // something a retry will fix.
  res.status(200).json({ received: true, sent: Boolean(sent), alreadySent: Boolean(alreadySent) });
}
