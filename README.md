# Rock It Uptime Monitor

Self-hosted uptime monitor for your own websites — like UptimeRobot, but yours. Checks each site on a schedule, shows status/uptime/response time on a dashboard, and emails you (via your Gmail) when a site goes down, comes back up, and on a daily/weekly summary.

## 1. Local setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `SESSION_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` — this app has one login. Pick a username, then generate the password hash:
  ```bash
  node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD_HERE', 10))"
  ```
  paste the output into `ADMIN_PASSWORD_HASH`.

### Sign in with Google (optional)

Adds a "Sign in with Google" button on the login page, alongside the username/password login (both stay active).

1. Go to https://console.cloud.google.com/apis/credentials, create a project if needed.
2. **OAuth consent screen** — set it to "External", add yourself as a test user (or publish it — it's just for you).
3. **Create Credentials → OAuth client ID → Web application.**
4. Under "Authorized redirect URIs" add: `http://localhost:3000/auth/google/callback` for local testing, and your production URL's equivalent (e.g. `https://your-domain.com/auth/google/callback`) once deployed.
5. Copy the **Client ID** and **Client Secret** into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and set `GOOGLE_REDIRECT_URI` to match whichever redirect URI you're using.
6. Set `ALLOWED_GOOGLE_EMAIL` to the one Google account allowed to sign in this way — anyone else who authenticates with Google is rejected.

If these variables are left blank, the Google button simply doesn't appear — the app falls back to username/password only.

### Gmail email alerts

1. Turn on 2-Step Verification on the Google account that will send mail: https://myaccount.google.com/signinoptions/two-step-verification
2. Create an App Password: https://myaccount.google.com/apppasswords — app "Mail", name it `uptime-monitor`. Copy the 16-character password.
3. In `.env`:
   - `GMAIL_USER` = that Gmail address
   - `GMAIL_APP_PASSWORD` = the 16-character app password (no spaces)
   - `ALERT_EMAIL_TO` = where you want alerts sent (can be the same address)

Run it:

```bash
npm start
```

Open http://localhost:3000, log in, click **Send test email** to confirm alerts work, then **+ Add site**.

## 2. How it works

- Every 30 seconds the scheduler checks which sites are due (based on each site's own check interval) and pings them.
- A site is marked **down** after `FAILURE_THRESHOLD` consecutive failed checks (default 2), to avoid false alarms from a single blip — you then get a 🔴 email.
- When it recovers you get a ✅ email with the downtime duration.
- Once a day (or week — see `SUMMARY_FREQUENCY`) you get a summary email with uptime % and incident counts per site.
- All history (checks, incidents) is stored in a local SQLite file at `data/monitor.db`.

## 3. Deploying to a server / the cloud

### Option A — Docker (any VPS, or any host that runs containers)

```bash
docker compose up -d --build
```

This builds the image, and persists the SQLite DB in `./data` on the host so it survives restarts/redeploys. Put the app behind a reverse proxy (Caddy, nginx, or your host's built-in TLS) so it's served over HTTPS — it's a login-protected dashboard, don't leave it on plain HTTP over the public internet.

### Option B — Railway / Render (simplest managed option)

1. Push this folder to a GitHub repo.
2. Create a new Web Service on Railway or Render, point it at the repo.
3. Build command: `npm install` — Start command: `node src/server.js`.
4. Add all the variables from `.env` as environment variables in the dashboard.
5. **Important:** attach a persistent volume mounted at `/app/data` (both Railway and Render support this) — without it, your monitoring history resets on every deploy.

### Option C — Fly.io

```bash
fly launch   # accept the Dockerfile it detects
fly volumes create data --size 1
```
Then in `fly.toml` mount that volume at `/app/data`, and set your `.env` values with `fly secrets set KEY=value`.

## 4. Security notes

- The whole app (dashboard + API) sits behind the single login in `.env`. Don't skip setting `ADMIN_PASSWORD_HASH`.
- Always serve it over HTTPS in production — the session cookie carries your login.
- The Gmail App Password only grants mail-sending for this app; it doesn't expose your main Gmail password.
