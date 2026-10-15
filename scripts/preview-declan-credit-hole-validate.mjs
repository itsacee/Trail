/**
 * Isolated Preview validation for membership credit enforcement fix.
 * Refuses Production (fragrant-credit). Creates fictional Declan-like rows,
 * proves 5th book is blocked, verifies 4/0 display math, then deletes fixtures.
 *
 * Usage:
 *   BOOKING_DATABASE_URL=… node scripts/preview-declan-credit-hole-validate.mjs
 */
import pg from "pg";
import { createBookingStore, closeBookingStore } from "../lib/bookingDb/createStore.js";

const url = process.env.BOOKING_DATABASE_URL || "";
const host = (url.match(/@([^/]+)/) || [])[1] || "";
if (!url) {
  console.error("Missing BOOKING_DATABASE_URL");
  process.exit(2);
}
if (/fragrant-credit/i.test(host) || /production/i.test(host)) {
  console.error("REFUSING Production host:", host);
  process.exit(2);
}

const TAG = `preview_credit_fix_${Date.now().toString(36)}`;
const MID = `pi_${TAG}`;
const EMAIL = `${TAG}@example.test`;
const results = [];

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

const handle = await createBookingStore({
  mode: "postgres",
  env: {
    BOOKING_DATABASE_URL: url,
    BOOKING_ALLOW_NON_PREVIEW: "1",
    VERCEL_ENV: "preview",
    BOOKING_STORE: "postgres",
    BOOKING_WRITES_ENABLED: "1",
  },
});
const store = handle.store;

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

async function cleanup() {
  await client.query(`DELETE FROM bookings WHERE email = $1 OR membership_id = $2 OR stripe_pi = $2`, [
    EMAIL,
    MID,
  ]);
  await client.query(`DELETE FROM membership_credits WHERE membership_id = $1`, [MID]);
}

try {
  await cleanup();

  // Orphan checkout lesson (empty membership_id, stripe_pi set) + lagging ledger.
  await client.query(
    `INSERT INTO bookings (
       id, source, source_ref, status, slot_date, time_label, mins, location_key,
       focus, privacy, seats, email, player, booking_type, athletes, stripe_pi, membership_id, payload
     ) VALUES (
       $1,'stripe',$2,'active','2099-06-02','6:00 PM',60,'mustang',
       'Both','private',2,$3,'Preview Declan','membership',1,$2,NULL,'{}'::jsonb
     )`,
    [`${MID}-1`, MID, EMAIL]
  );
  await client.query(
    `INSERT INTO membership_credits (membership_id, email, tier, credits_total, credits_used, status)
     VALUES ($1, $2, 'standard', 4, 0, 'active')`,
    [MID, EMAIL]
  );

  for (let i = 0; i < 3; i++) {
    const booked = await store.memberBook({
      membershipId: MID,
      email: EMAIL,
      date: `2099-06-0${3 + i}`,
      time: "6:00 PM",
      focus: ["Hitting", "Fielding", "Both"][i],
      type: "membership",
      privacy: "standard",
      creditsTotal: 4,
      player: "Preview Declan",
    });
    record(`book_${i + 2}`, booked.ok === true, booked.ok ? booked.bookingId : booked.code);
    if (!booked.ok) break;
  }

  const credits = await store.getMembershipCredits(MID);
  record(
    "ledger_4_0",
    Number(credits?.credits_used) === 4,
    `credits_used=${credits?.credits_used}`
  );

  const fifth = await store.memberBook({
    membershipId: MID,
    email: EMAIL,
    date: "2099-06-10",
    time: "6:00 PM",
    focus: "Hitting",
    type: "membership",
    privacy: "standard",
    creditsTotal: 4,
    player: "Preview Declan",
  });
  record("fifth_blocked", fifth.ok === false && fifth.code === "no_credits", `${fifth.code}`);

  const { rows: active } = await client.query(
    `SELECT id, membership_id, stripe_pi FROM bookings
     WHERE status='active' AND (membership_id=$1 OR stripe_pi=$1) ORDER BY slot_date`,
    [MID]
  );
  record("four_intact", active.length === 4, `active=${active.length}`);

  const audit = await store.auditMembershipCredits({ membershipId: MID });
  record(
    "audit_match",
    audit[0]?.lessonCount === 4 && audit[0]?.mismatch === false,
    JSON.stringify(audit[0] || {})
  );

  // Fresh confirmPaid attribution (no orphan)
  const mid2 = `pi_${TAG}_fresh`;
  const mirrored = await store.confirmPaid({
    idempotencyKey: `mirror:${mid2}`,
    sourceId: mid2,
    metadata: {
      date: "2099-07-01",
      time: "5:00 PM",
      focus: "Hitting",
      type: "membership",
      privacy: "standard",
      email: `${TAG}.fresh@example.test`,
      player: "Fresh Mem",
    },
  });
  const row = mirrored.ok ? await store.getBooking(`${mid2}-1`) : null;
  record(
    "confirm_sets_membership_id",
    mirrored.ok && row?.membership_id === mid2 && row?.stripe_pi === mid2,
    mirrored.ok ? `mid=${row?.membership_id}` : mirrored.code
  );
  await client.query(`DELETE FROM bookings WHERE membership_id=$1 OR stripe_pi=$1 OR id LIKE $2`, [
    mid2,
    `${mid2}%`,
  ]);
  await client.query(`DELETE FROM membership_credits WHERE membership_id=$1`, [mid2]);
  await client.query(`DELETE FROM idempotency_keys WHERE key=$1`, [`mirror:${mid2}`]);
} finally {
  await cleanup();
  await client.end();
  await closeBookingStore(handle);
}

const failed = results.filter((r) => !r.pass);
console.log(
  JSON.stringify(
    {
      host,
      tag: TAG,
      pass: failed.length === 0,
      results,
      cleanedUp: true,
    },
    null,
    2
  )
);
process.exit(failed.length ? 1 : 0);
