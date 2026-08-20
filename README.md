# AP Academy — Website

A modern landing page for AP Academy (Ace Performance) baseball training.
Plain HTML/CSS/JS — nothing to install, easy to edit, free to host.

## See it locally

Open `index.html` in your browser, or in Cursor right-click it and choose
"Open with Live Server" style preview. That's it.

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

The site has its own booking section (`#book`): parents pick a session type
(single $70 / group $25 per player · $50 total / membership $240 per month), a date, a
time, enter the player's name, and pay through Stripe Checkout.

The payment is created by `api/checkout.js`, a serverless function that runs
automatically when this repo is deployed on Vercel. **One-time setup:**

1. In Vercel: your project → Settings → Environment Variables
2. Add `STRIPE_SECRET_KEY` = your Stripe secret key
   (Stripe Dashboard → Developers → API keys → "Secret key", starts with `sk_live_`)
3. Redeploy

Until that key is set (and on non-Vercel previews), the booking form shows a
friendly "call or text to book" message instead of failing silently.

## Hours and locations

Defined in `lib/schedule.js` (server) and mirrored in `js/main.js` (booking
form) — **change both together**:

| Days | Hours | Location |
| --- | --- | --- |
| Mon–Fri | 5–9 PM (last start 8 PM) | Mustang |
| Sat–Sun | 9 AM–7 PM (last start 6 PM) | Del City |

Each booking records which location it belongs to, so the confirmation email,
calendar feed, and coach page all show the right place. A location with no
`address` filled in degrades gracefully — the email says the address will be
texted instead of printing a placeholder. `LOCATIONS.mustang.address` and
`LOCATIONS.mojo.address` still need real values.

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

## Coach schedule page

`/coach.html` is a private page showing all upcoming lessons (player, parent,
phone, time) plus a lessons-this-week counter. It reads bookings straight
from Stripe via `api/schedule.js`. Setup:

1. In Vercel: Settings → Environment Variables → add `COACH_PASS` with a
   passcode you make up, then redeploy
2. Open `apacademybsb.com/coach.html`, enter the passcode once — it's
   remembered on that device

The page is not linked from the public site and is marked noindex.

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
