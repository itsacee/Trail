// Stripe → Postgres reconciliation for paid Checkout sessions that failed to
// mirror (webhook/confirm outage). Never displaces another customer's booking.
// Idempotent via confirmPaid (idempotency_keys + booking id upsert).

import { dbConfirmPaid } from "../bookingStore.js";
import { bookingWritesEnabled } from "./flags.js";

const HOLD_LOOKBACK_HOURS = 48;

function stripeFetch(key, path) {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

function sourceIdFromSession(session) {
  return (
    session?.payment_intent ||
    session?.subscription ||
    session?.id ||
    ""
  );
}

function metaFromSession(session) {
  return { ...(session?.metadata || {}) };
}

/**
 * List recent paid Checkout sessions (Stripe API). No charges created.
 */
export async function listRecentPaidCheckoutSessions(
  stripeKey,
  { lookbackHours = HOLD_LOOKBACK_HOURS, limit = 40 } = {}
) {
  if (!stripeKey) return { ok: false, code: "missing_stripe_key", sessions: [] };
  const since = Math.floor(Date.now() / 1000) - Math.max(1, lookbackHours) * 3600;
  const path =
    `checkout/sessions?limit=${Math.min(100, Math.max(1, limit))}` +
    `&created[gte]=${since}`;
  let res;
  try {
    res = await stripeFetch(stripeKey, path);
  } catch (error) {
    return { ok: false, code: "stripe_network", error: error.message, sessions: [] };
  }
  if (!res.ok) {
    return { ok: false, code: "stripe_http", status: res.status, sessions: [] };
  }
  const data = await res.json();
  const sessions = (data.data || []).filter((s) => s.payment_status === "paid");
  return { ok: true, sessions };
}

/**
 * Attempt to mirror one paid session into Postgres.
 * On capacity conflict: records an open reconcile alert; never deletes others.
 */
export async function reconcilePaidCheckoutSession(
  store,
  session,
  { stripeKey, env = process.env } = {}
) {
  const sessionId = session?.id || "";
  const sourceId = sourceIdFromSession(session);
  const meta = metaFromSession(session);
  if (!sessionId || !sourceId) {
    return { ok: false, code: "invalid_session", action: "skip" };
  }

  // Already mirrored?
  if (store?.listActiveBySourceRef) {
    const existing = await store.listActiveBySourceRef(sourceId);
    if (existing.length) {
      return {
        ok: true,
        action: "already_mirrored",
        sourceId,
        sessionId,
        bookingIds: existing.map((r) => r.id),
        idempotent: true,
      };
    }
  }

  if (!bookingWritesEnabled(env)) {
    return {
      ok: false,
      code: "writes_disabled",
      action: "deferred",
      sourceId,
      sessionId,
      note: "Writes are off — occupancy still reserved via Stripe paid search safety net when reads are on.",
    };
  }

  const mirrored = await dbConfirmPaid(
    {
      idempotencyKey: `mirror:${sourceId}`,
      sourceId,
      sessionId,
      metadata: meta,
    },
    env
  );

  if (mirrored.ok) {
    return {
      ok: true,
      action: mirrored.idempotent ? "already_mirrored" : "mirrored",
      sourceId,
      sessionId,
      bookingIds: mirrored.bookingIds || [],
      idempotent: Boolean(mirrored.idempotent),
    };
  }

  const conflict =
    mirrored.code === "slot_unavailable" ||
    /taken|full|unavailable|focus/i.test(String(mirrored.error || mirrored.code || ""));

  if (conflict && store?.recordReconcileAlert) {
    const date = meta.date || meta.date1 || null;
    const time = meta.time || meta.time1 || "";
    await store.recordReconcileAlert({
      id: `paid_conflict:${sourceId}`,
      kind: "paid_mirror_conflict",
      sourceRef: sourceId,
      sessionId,
      date,
      time,
      email: meta.email || session.customer_details?.email || "",
      player: meta.player || "",
      detail: {
        code: mirrored.code || "slot_unavailable",
        error: mirrored.error || "",
        type: meta.type || "",
        focus: meta.focus || "",
        note:
          "Paid in Stripe but the hour is full in Postgres. Do not auto-evict the seated customer. Contact both parties or offer a makeup slot.",
      },
    });
    return {
      ok: false,
      action: "alert_operator",
      code: mirrored.code || "slot_unavailable",
      sourceId,
      sessionId,
      alertId: `paid_conflict:${sourceId}`,
      error: mirrored.error,
    };
  }

  return {
    ok: false,
    action: "retry_later",
    code: mirrored.code || "mirror_failed",
    sourceId,
    sessionId,
    error: mirrored.error,
  };
}

/**
 * Batch reconcile recent paid sessions. Safe to run on cron / coach desk.
 */
export async function reconcileRecentPaidSessions(
  store,
  stripeKey,
  { lookbackHours = HOLD_LOOKBACK_HOURS, limit = 40, env = process.env } = {}
) {
  const listed = await listRecentPaidCheckoutSessions(stripeKey, { lookbackHours, limit });
  if (!listed.ok) {
    return {
      ok: false,
      code: listed.code,
      summary: { scanned: 0, mirrored: 0, already: 0, alerts: 0, deferred: 0, failed: 0 },
      results: [],
      error: listed.error,
    };
  }

  const results = [];
  const summary = { scanned: listed.sessions.length, mirrored: 0, already: 0, alerts: 0, deferred: 0, failed: 0 };

  for (const session of listed.sessions) {
    const meta = metaFromSession(session);
    // Skip sessions with no bookable slot metadata.
    if (!meta.date && !meta.date1) {
      results.push({ sessionId: session.id, action: "skip_no_slots" });
      continue;
    }
    const outcome = await reconcilePaidCheckoutSession(store, session, { stripeKey, env });
    results.push(outcome);
    if (outcome.action === "mirrored") summary.mirrored++;
    else if (outcome.action === "already_mirrored") summary.already++;
    else if (outcome.action === "alert_operator") summary.alerts++;
    else if (outcome.action === "deferred") summary.deferred++;
    else if (outcome.ok === false) summary.failed++;
  }

  let openAlerts = [];
  if (store?.listOpenReconcileAlerts) {
    openAlerts = await store.listOpenReconcileAlerts({ limit: 50 });
  }

  return {
    ok: summary.failed === 0,
    summary,
    results,
    openAlerts: openAlerts.map((a) => ({
      id: a.id,
      kind: a.kind,
      sourceRef: a.source_ref,
      sessionId: a.session_id,
      date: a.slot_date,
      time: a.time_label,
      email: a.email,
      player: a.player,
      detail: a.detail,
      createdAt: a.created_at,
    })),
  };
}

/**
 * Whether a Stripe payment source is already represented in occupancy sources
 * (Postgres lesson ids are `${sourceId}-N`).
 */
export function occupancyHasStripeSource(sources, sourceId) {
  const id = String(sourceId || "");
  if (!id) return false;
  return (sources || []).some((s) => {
    const sid = String(s.id || "");
    const ref = String(s.sourceRef || s.source_ref || "");
    return (
      sid === id ||
      ref === id ||
      sid.startsWith(`${id}-`) ||
      (s.kind === "paid" && (sid === id || ref === id))
    );
  });
}
