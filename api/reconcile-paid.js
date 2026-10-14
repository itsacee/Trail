// Cron / coach entry: reconcile recent paid Stripe Checkout sessions into
// Postgres. Never creates charges. Never deletes another customer's booking.
//
// Auth: CRON_SECRET Bearer, x-vercel-cron, or coach key (same as reminders).

import { isCoachPass } from "../lib/coachAuth.js";
import { assertPreviewDbAllowed, bookingStoreMode } from "../lib/bookingDb/flags.js";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";
import { reconcileRecentPaidSessions } from "../lib/bookingDb/stripePaidReconcile.js";

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || "");
  if (secret && auth === `Bearer ${secret}`) return true;
  if (req.headers?.["x-vercel-cron"]) return true;
  const key = req.method === "GET" ? req.query?.key : req.body?.key;
  return isCoachPass(key);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) {
    res.status(401).json({ ok: false, error: "Not authorised." });
    return;
  }

  const preview = assertPreviewDbAllowed(process.env);
  // Allow Production cron once BookingStore is configured there — but never
  // when mode is still blob (nothing to reconcile into).
  const mode = bookingStoreMode();
  if (mode === "blob") {
    res.status(200).json({
      ok: true,
      skipped: true,
      reason: "booking_store_blob",
      note: "Postgres BookingStore not enabled; nothing to reconcile.",
    });
    return;
  }
  if (!preview.ok && process.env.BOOKING_ALLOW_NON_PREVIEW !== "1") {
    // Production cutover will set BOOKING_ALLOW_NON_PREVIEW or relax this guard
    // explicitly; until then keep Preview-only.
    res.status(403).json({ ok: false, reason: preview.reason });
    return;
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    res.status(503).json({ ok: false, error: "Stripe isn't configured." });
    return;
  }

  let handle;
  try {
    handle = await createBookingStore({
      env: process.env,
      mode: mode === "postgres" ? "postgres" : "memory",
      useMem: mode === "memory",
    });
    const lookbackHours = Math.min(
      168,
      Math.max(1, Number(req.query?.lookbackHours || req.body?.lookbackHours) || 48)
    );
    const report = await reconcileRecentPaidSessions(handle.store, stripeKey, {
      lookbackHours,
      env: process.env,
    });
    const needsOperator = (report.openAlerts || []).length > 0 || (report.summary?.alerts || 0) > 0;
    if (needsOperator) {
      console.error(
        "reconcile-paid: OPERATOR ACTION REQUIRED — paid mirror conflict(s)",
        JSON.stringify({
          alerts: report.summary?.alerts,
          open: (report.openAlerts || []).map((a) => a.id),
        })
      );
    }
    res.status(200).json({
      ok: report.ok && !needsOperator,
      needsOperator,
      summary: report.summary,
      openAlerts: report.openAlerts,
      results: (report.results || []).slice(0, 80),
    });
  } catch (error) {
    console.error("reconcile-paid failed:", error?.code || error?.message || error);
    res.status(503).json({ ok: false, error: "Reconciliation unavailable.", code: error?.code });
  } finally {
    if (handle) await closeBookingStore(handle);
  }
}
