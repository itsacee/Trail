# AP Academy — Website

A modern landing page for AP Academy (Ace Performance) baseball training.
Plain HTML/CSS/JS — nothing to install, easy to edit, free to host.

## See it locally

Open `index.html` in your browser, or in Cursor right-click it and choose
"Open with Live Server" style preview. That's it.

## Tests

The booking rules — date math, the 12-hour cancel/reschedule cutoff, credit
counting, expiry, and the one-lesson-per-day gate — are covered by automated tests
that run offline, with **nothing to install** (they use Node's built-in test
runner). Run them any time with:

```
npm test
```

They live in `test/` and check the logic in `lib/` (`schedule.js`,
`members.js`, `lessons.js`). If you change any booking rule, run this first —
a red test means the change broke something before it ever reaches the live
site.

## Make it yours

The site is fully written with Elijah's real info (Connors State stats,
pricing, contact, Instagram). Just tell the Cursor agent what to change and
it will update the code for you. Still needed:

1. **A photo of Elijah** for the "Meet the Coach" section — save it as
   `img/coach.jpg` in this project, then ask the agent to swap it in.
2. **Real testimonials** — the three quotes on the site are samples. Text a
   few parents you've trained and ask for one sentence each. Replace before
   going live.

Want different colors? Change `--accent` at the top of `css/styles.css`.

## Booking (built into this site)

Parents pick a lesson type on the homepage, then land on `book.html`.

- **Regular lesson ($80 / athlete) and 30-min ($60 / athlete):** pick a day
  and time, pay through Stripe Checkout. These share the hour — see
  "Two athletes per hour" below.
- **Private hour ($100 for one athlete):** books the whole slot so nobody else
  can join. Two of your own athletes can share a private hour, and because a
  pair already fills the hour they pay the regular **$80 each** instead of the
  1-on-1 premium (`unitPriceFor` in `lib/settings.js`).
- **Membership ($280 / 30 days):** one-time payment (does not auto-renew).
  Then sign in at `account.html` with the email they paid with (a sign-in
  *link*, not a password). They book **one lesson per week**, up to 4 in
  those 30 days. Unused lessons do not roll over. Buy again to continue.

They also choose how to pay: full amount by card, cash at the field, or —
for memberships — an **$80 card deposit with the $200 balance in cash at the
first lesson**. The deposit amount is a setting on the coach page, and the
balance is spelled out on the pay option, in the confirmation email, and on
the member's account page until the coach marks it collected.

Member lesson times are stored in Vercel Blob (`lessons.json`) and show up
on the coach schedule and calendar feed. Card payments still live on Stripe
metadata; cash bookings live in `manual-bookings.json`.

### Facility work: fielding only

Mustang is redoing the indoor facility, so `lib/siteStatus.js` has
`fieldingOnly: true`. That removes Hitting from every focus picker, refuses a
non-fielding booking server-side, and prints the reason on the booking page and
the pricing cards. Memberships are still **on sale** through all of this — the
notice tells buyers it's fielding only before they pay.

The membership clock is also frozen (`membershipFrozen`), but only for
memberships that were **already running when the freeze started**. Anyone who
buys during the facility work runs on their normal 30 days — otherwise the
later somebody bought, the bigger a free extension they would collect. That
split lives in `isPeriodFrozen()`.

All three flags are switches on the Coach Desk **Setup** tab, so they can be
turned off without a redeploy. `AP_SITE_NORMAL=1` forces everything open.

### Two athletes per hour

An hour holds **two athlete seats** (`SLOT_CAPACITY` in `lib/schedule.js`):

- One athlete books alone → the hour stays open for one more athlete, but
  only at the same focus.
- The booking form has an **"+ Add another athlete"** button. Adding a second
  name fills both seats, so the hour is closed to everyone else.
- A private lesson takes both seats and refuses any hour that already has
  someone in it, whether it's one athlete or a pair on it.

`api/slots.js` reports seats and exclusivity per time, so the calendar can
grey out a day that is genuinely full rather than merely busy.

The payment is created by `api/checkout.js`, a serverless function that runs
automatically when this repo is deployed on Vercel. **One-time setup:**

1. In Vercel: your project → Settings → Environment Variables
2. Add `STRIPE_SECRET_KEY` = your Stripe secret key
   (Stripe Dashboard → Developers → API keys → "Secret key", starts with `sk_live_`)
3. Redeploy

Until that key is set (and on non-Vercel previews), the booking form shows a
friendly "call or text to book" message instead of failing silently.

## Hours and locations

Day-to-day hours are edited on the coach page's **Hours** tab, which saves to
Vercel KV. The built-in fallback used before anything is saved lives in
`lib/schedule.js` (server) and is mirrored in `js/booking-core.js` (booking
form and member portal) — **change both together**:

| Days | Hours | Location |
| --- | --- | --- |
| Mon–Fri | 5–9 PM (last start 8 PM) | Del City |
| Sat–Sun | 9 AM–7 PM (last start 6 PM) | Del City |

Each booking records which location it belongs to, so the confirmation email,
calendar feed, and coach page all show the right place. A location with no
`address` filled in degrades gracefully — the email says the address will be
texted instead of printing a placeholder.

Times already paid for are marked booked automatically — `api/slots.js` reads
paid bookings straight from Stripe, and `api/checkout.js` both re-checks the
slot and validates the time against that day's schedule before payment.

## Confirmation emails

After a payment succeeds, `api/confirm.js` verifies the payment with Stripe and
emails the parent a branded confirmation containing the lesson date(s)/time(s),
the training address with a map link, what to bring, and the cancellation
policy. A copy is BCC'd to Apacademybsb@gmail.com. The address appears only
here and on the post-payment screen — never on the public site or the Stripe
checkout page.

Setup (one time, in Vercel → Settings → Environment Variables):

1. `RESEND_API_KEY` — create a free account at resend.com, verify the
   apacademybsb.com domain (Resend gives DNS records; add them in
   Vercel → Domains → apacademybsb.com → DNS), then create an API key
2. `FROM_EMAIL` — optional, defaults to `AP Academy <bookings@apacademybsb.com>`.
   Must be on the verified domain.
3. Redeploy

Until `RESEND_API_KEY` is set, bookings still work — parents just see the
address on the confirmation screen instead of also getting the email.

Sending is idempotent: the booking is flagged `confirmation_sent` in Stripe,
so refreshing the success page won't send a second email.

## Phone calendar feed

`api/calendar.js` publishes booked lessons as an iCalendar feed so they show
up automatically in iPhone Calendar, Google Calendar, or Outlook:

    webcal://www.apacademybsb.com/api/calendar?key=COACH_PASS

Events use the `America/Chicago` timezone (DST-safe), run one hour, include
the player, parent, phone and email in the notes, carry the training address
as the location, and have a one-hour-before alert. Subscribers are asked to
refresh every 15 minutes. The coach page has a one-tap subscribe button that
fills in the passcode automatically.

## Coach Desk

`/coach.html` is the private page the coach runs the business from. It works
the same on a phone (tabs pinned to the bottom) and on a desktop (tabs as a
left sidebar), and has five tabs:

| Tab | What it does |
| --- | --- |
| Lessons | Today / this week / upcoming / still-owed counts, every lesson with its athletes and tags, and per-lesson **Move**, text, call, email, cancel |
| Members | Credits left, expiry, cash owed, freeze one member or everyone, mark cash collected, send a sign-in link, remove a duplicate card |
| Money | Outstanding balances, a cash/card ledger, and week + month totals |
| Hours | Weekly open hours per day and a days-off calendar |
| Setup | All five prices, the membership deposit, whether cash and deposits are allowed, and the facility pauses |

Everything on the page talks to `api/coach.js`, which also handles moving a
lesson. Moving works for any kind of booking: cash and member lessons are
edited in place, while a card booking is voided on Stripe and rewritten as a
member lesson that remembers where it came from (`lib/reschedule.js`). A move
to a time outside posted hours is refused once and then allowed if the coach
confirms, so make-up sessions are possible but accidents are not.
Double-booking is always refused. The parent gets an email with a fresh
calendar invite unless the coach turns that off.

Parents can reschedule themselves from `account.html` up to 12 hours before
the lesson; inside 12 hours the portal asks them to call or text.

### Duplicate member cards

A parent who signs up twice under two emails shows up as two cards for one
athlete. **Remove card** takes one off the Members list. Nothing is deleted:
the record keeps their history, note and balance, the card moves to a
**Cards you removed** list, and **Put back** undoes it. A card with money still
owed asks a second time first, because removing it also takes that balance off
the Money tab. Any new activity on the email — a booking, a payment — brings the
card back on its own, so a second email that starts paying again can't stay
hidden (`removeMember` in `lib/membersStore.js`).

### Passcode

Set `COACH_PASS` in Vercel (Settings → Environment Variables) to the passcode
you want, then redeploy. If it is not set, `lib/coachAuth.js` falls back to a
built-in default so the page still opens. Enter the passcode once and it is
remembered on that device. The page is not linked from the public site and is
marked noindex.

## Put it online (free)

Easiest path with this repo: **GitHub Pages**

1. Push this repo to GitHub (already done if you're reading this there).
2. On GitHub: Settings → Pages → Source: "Deploy from a branch" → pick your
   branch and `/ (root)` → Save.
3. Your site goes live at `https://<your-username>.github.io/<repo-name>/`.
4. To use your real domain (`apacademybsb.com`), add it under Settings →
   Pages → Custom domain, then update the DNS at your domain registrar.

Netlify and Vercel also work — drag-and-drop the folder and you're live.

## Ideas to get more clients

- Post short drill clips + player wins on Instagram/TikTok and link them here.
- Ask every happy parent for a Google review AND a one-line quote for this site.
- Add a "first lesson" intro offer to lower the barrier for new families.
- Set up a free Google Business Profile so you show up in local map searches.
