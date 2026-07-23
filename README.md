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
(single $70 / group $50 per player / membership $240 per month), a date, a
time, enter the player's name, and pay through Stripe Checkout.

The payment is created by `api/checkout.js`, a serverless function that runs
automatically when this repo is deployed on Vercel. **One-time setup:**

1. In Vercel: your project → Settings → Environment Variables
2. Add `STRIPE_SECRET_KEY` = your Stripe secret key
   (Stripe Dashboard → Developers → API keys → "Secret key", starts with `sk_live_`)
3. Redeploy

Until that key is set (and on non-Vercel previews), the booking form shows a
friendly "call or text to book" message instead of failing silently.

Training hours shown in the time picker are set at the top of `js/main.js`
(`OPEN_HOURS`) — weekdays 4–8pm, weekends 9am–5pm by default. Adjust to your
real availability.

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
