// Hourly self-audit: proves the monitor really ran every 5 minutes over the last
// hour instead of assuming it did. Emails only when the count falls short, so a
// silent inbox means the cadence is healthy.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const HEARTBEAT_FILE = path.join(ROOT, 'heartbeat.json');

const EXPECTED_PER_HOUR = 12;
// A run that lands a few seconds late shouldn't trip the alarm; 10 of 12 still
// means the cadence is working.
const MIN_ACCEPTABLE = 10;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function sendMail(subject, html, text) {
  const to = process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;
  if (!to || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('[watchdog] email not configured, skipping');
    return;
  }
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({ from: `"RockIt Uptime Watchdog" <${process.env.GMAIL_USER}>`, to, subject, html, text });
}

async function main() {
  const heartbeat = loadJson(HEARTBEAT_FILE, { checks: [] });
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = heartbeat.checks.filter((t) => new Date(t).getTime() >= cutoff);

  const lastCheck = heartbeat.checks.length ? new Date(heartbeat.checks[heartbeat.checks.length - 1]) : null;
  const minutesSinceLast = lastCheck ? Math.round((Date.now() - lastCheck.getTime()) / 60000) : null;

  console.log(`[watchdog] ${recent.length} checks in the last hour (expected ${EXPECTED_PER_HOUR})`);
  console.log(`[watchdog] last check was ${minutesSinceLast === null ? 'never' : minutesSinceLast + ' minutes ago'}`);

  if (recent.length >= MIN_ACCEPTABLE) {
    console.log('[watchdog] cadence healthy, no email sent');
    return;
  }

  const subject = `⚠️ Monitoring gap: only ${recent.length}/${EXPECTED_PER_HOUR} checks ran in the last hour`;
  const html = `
    <h2 style="color:#c0392b">The uptime monitor is not running at its 5-minute cadence</h2>
    <p>Checks recorded in the last hour: <b>${recent.length}</b> (expected ${EXPECTED_PER_HOUR}).</p>
    <p>Last check: <b>${minutesSinceLast === null ? 'never' : minutesSinceLast + ' minutes ago'}</b>.</p>
    <p>This means site statuses on the dashboard may be stale, and an outage could go unnoticed.</p>
  `;
  const text = `Only ${recent.length}/${EXPECTED_PER_HOUR} checks ran in the last hour. Last check: ${minutesSinceLast === null ? 'never' : minutesSinceLast + ' minutes ago'}.`;

  await sendMail(subject, html, text);
  console.log('[watchdog] ALERT SENT');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
