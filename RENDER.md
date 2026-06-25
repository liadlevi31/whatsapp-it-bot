# Deploy to Render (bot + GUI dashboard)

Running `server.js` on Render gives you BOTH the WhatsApp bot AND a properly
rendered dashboard GUI at your Render URL (Express serves real `text/html`,
unlike Supabase edge functions which forced plain text).

## Plan & resources — read first
- **Use the `starter` plan ($7/mo), not free.** Free Render web services sleep
  when idle; sleeping logs the WhatsApp session out and forces a QR re-scan.
- The bot runs a real Chrome, which needs RAM. Starter (512 MB) usually works
  with the memory flags already set in `server.js`. **If it crash-loops with
  out-of-memory**, bump to the `standard` plan (2 GB) in `render.yaml` / the
  Render UI.
- A **persistent disk** (configured in `render.yaml`) stores the WhatsApp login
  so restarts and redeploys don't ask for the QR again.

## Steps

### 1. Put the files in a GitHub repo
Render deploys from a Git repo. You don't need the git command line:
1. Go to github.com → **New repository** (Private is fine).
2. Click **uploading an existing file** and drag in: `server.js`, `package.json`,
   `Dockerfile`, `.dockerignore`, `render.yaml`. (Do NOT upload `.env`.)
3. Commit.

### 2. Create the service on Render
1. render.com → **New → Blueprint**.
2. Connect your GitHub and pick the repo. Render reads `render.yaml` and proposes
   the `whatsapp-it-bot` web service + disk.
3. It will ask for the two secret env vars (marked `sync: false`):
   - `SUPABASE_KEY` = your Supabase **service_role** key (Settings → API)
   - `SUPABASE_ANON_KEY` = your Supabase **anon** public key
   (`SUPABASE_URL` is already filled in by the blueprint.)
4. Click **Apply / Create**. Render builds the Dockerfile (a few minutes).

### 3. Link WhatsApp
1. Open the service → **Logs**.
2. Wait for the **QR code** to print in the logs.
3. On the bot's phone: WhatsApp → **Linked Devices → Link a Device** → scan it.
4. Logs show `WhatsApp client READY — bot is live.`

### 4. Use it
- Your dashboard GUI is the service's public URL (e.g.
  `https://whatsapp-it-bot.onrender.com/`). It renders properly and updates live.
- Message the bot `my mac is frozen` → instant answer; message `human` or
  anything unknown → it replies with the 4-hour SLA line and the ticket appears
  on the dashboard.

## Notes
- **Port:** Render injects `PORT`; `server.js` already binds to it. Health check
  is `/healthz` (already implemented).
- **Re-scan:** to relink, delete the disk's contents (or the disk) and redeploy.
- **ToS:** whatsapp-web.js is unofficial and can get the number banned — use a
  number you can afford to lose.
