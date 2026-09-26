# ValueAccelerate Services Limited — Website

Single-page marketing site with a working contact form that delivers enquiries
by email through [Resend](https://resend.io).

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | The entire site (styles, scripts, logo and favicons inlined — fully self-contained) |
| `server.js` | Zero-dependency Node server: static hosting + `POST /api/contact` → Resend |
| `logo.png`, `favicon-32.png`, `favicon-64.png` | Optimized brand assets (also inlined into `index.html`) |
| `.env` | Secrets — **never commit** (already in `.gitignore`) |
| `.env.example` | Template for `.env` |
| `1.png` | Original logo source artwork |

## Quick start

```bash
cp .env.example .env    # then edit .env with your real values
npm start               # http://localhost:8787
```

### Configure Resend

1. Create an API key at **resend.com/dashboard/api-keys** (starts with `re_`).
2. Put it in `.env` as `RESEND_API_KEY`.
3. Set `CONTACT_TO` to the inbox that should receive enquiries.
4. Set `CONTACT_FROM` to a verified sender:
   - **Before your domain is verified** you can send to your own account email
     only, using `ValueAccelerate <onboarding@resend.dev>`.
   - **After verifying `valueaccelerate.ng`** in Resend (Domains → add DNS records),
     switch to `ValueAccelerate <hello@valueaccelerate.ng>` to send to anyone.

If email isn't configured, submissions get a friendly message pointing visitors
to WhatsApp/phone instead of failing silently.

## How the form works

- Browser validates fields, shows a sending spinner, then `POST`s JSON to `/api/contact`.
- Server re-validates everything (never trusts the client), applies per-IP rate
  limiting (5 requests/minute), and checks a hidden honeypot field for bots.
- On success it emails a formatted enquiry to `CONTACT_TO` (optional `CONTACT_BCC`)
  and sets the visitor's address as `reply_to`, so you can reply directly.
- Upstream Resend errors are mapped to friendly messages; auth errors are never
  leaked to the client.

## Deploying

Any Node 18+ host works (Railway, Render, Fly.io, a VPS…):

```bash
npm start   # uses PORT from the environment when provided
```

Set `RESEND_API_KEY`, `CONTACT_TO`, `CONTACT_FROM` in the host's environment
variables (don't copy the `.env` file). For static-only hosting (e.g. bare
Netlify without functions), the site still works visually but the form needs a
server — keep `server.js` as the deploy target.
