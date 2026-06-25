# Deploying the WhatsApp bot 24/7

The bot runs a real headless Chrome (via whatsapp-web.js), so it needs an
**always-on host** — not serverless, not a free tier that sleeps (sleeping kills
the WhatsApp session). The most reliable option is a small VPS (~$5/mo, 1 GB RAM)
running Docker. The dashboard is **already hosted on Supabase** and needs no host.

## What's already live (no action needed)
- Database (`chats`, `faq`) + seeded FAQ — in your Supabase project.
- Live dashboard: `https://xzxqqtizascjsbcrtcha.supabase.co/functions/v1/supabase-dashboard`
  (login `admin` / `Tickets-9fK2-Lm74`).

You only need to host **the engine** (`server.js`) so it can talk to WhatsApp.

## Option A — Any VPS with Docker (recommended, most reliable)

1. Create a small Linux VPS (DigitalOcean, Hetzner, Linode, etc. — 1 GB RAM is enough).
2. Install Docker, then copy this folder to the server (scp, rsync, or paste the files).
3. Create your `.env` from `.env.example` and fill in `SUPABASE_KEY` (service_role)
   and `SUPABASE_ANON_KEY` (anon).
4. Build & run:
   ```bash
   docker compose up -d --build
   docker compose logs -f          # watch for the QR code
   ```
5. A **QR code** prints in the logs. Open WhatsApp on the bot's phone →
   **Linked Devices → Link a Device** → scan it. The session is saved to a Docker
   volume, so restarts/redeploys won't ask again.
6. Done. The bot now answers messages and writes tickets to Supabase, which show
   up on the live dashboard above. (The engine also serves its own copy of the
   dashboard on `http://<server-ip>:3000` if you want it.)

## Option B — Railway (managed, uses the Dockerfile)

1. Create a Railway project → **Deploy from Dockerfile** (point it at this folder,
   or upload it). Railway detects the `Dockerfile` automatically.
2. Add a **Volume** mounted at `/app/.wwebjs_auth` so the login persists.
3. Add the env vars from `.env.example` in the Railway **Variables** tab.
4. Deploy, open the **deploy logs**, scan the QR with the bot's phone.
5. Railway keeps it running 24/7 (note: Railway is usage-billed after the trial).

## Notes
- **RAM:** Chromium needs ~512 MB–1 GB. Free tiers with less will crash-loop.
- **Don't use sleeping free tiers** (e.g., Render free web services) — when they
  sleep, WhatsApp unlinks the session and you'd have to re-scan the QR.
- **Re-scan:** if you ever need to relink, delete the `.wwebjs_auth` volume and
  restart, then scan the new QR.
- **ToS:** whatsapp-web.js is unofficial and can get the number banned. Use a
  number you can afford to lose.
