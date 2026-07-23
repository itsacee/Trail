# AP Academy — Website

A modern landing page for AP Academy (Ace Performance) baseball training.
Plain HTML/CSS/JS — nothing to install, easy to edit, free to host.

## See it locally

Open `index.html` in your browser, or in Cursor right-click it and choose
"Open with Live Server" style preview. That's it.

## Make it yours (checklist)

Search `index.html` for the text `EDIT ME` — every spot that needs your real
info is marked. In order of importance:

1. **Your bio** — the "Meet the Coach" section. Your name, playing background,
   coaching story. This is the #1 thing that gets parents to book.
2. **Your photo** — drop a photo into the `img/` folder named `coach.jpg`,
   then in `index.html` delete the placeholder box and uncomment the `<img>` line.
3. **Testimonials** — text 3–4 parents you've trained with and ask for one
   sentence each. Real quotes with names convert way better than anything else.
4. **Membership price** — fill in the real monthly price and what's included.
5. **Contact info** — phone, email, city, and your Instagram/socials in the footer.
6. **FAQ answers** — ages, location, cancellation policy.
7. **Stats in the hero** — years coaching, players trained.

Want different colors? Open `css/styles.css` and change `--accent` at the top.

## Booking

All "Book" buttons currently link to your existing booking page at
`https://www.apacademybsb.com` (with the Stripe checkout). When you're ready,
you can move that booking form into this site — or keep it as-is and just
point this page at it.

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
