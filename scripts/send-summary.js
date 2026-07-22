// Runs once a day via its own GitHub Actions schedule: emails a digest of
// current site status. Reads whatever status.json the hourly checker last wrote --
// does not re-check sites itself.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const STATUS_FILE = path.join(ROOT, 'status.json');

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function sendMail(subject, html, text) {
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const to = process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;
  await transport.sendMail({ from: `"Rock It Uptime Monitor" <${process.env.GMAIL_USER}>`, to, subject, html, text });
}

async function main() {
  const sites = loadJson(SITES_FILE, []);
  const status = loadJson(STATUS_FILE, { sites: {} });

  const down = sites.filter((s) => (status.sites[s.name] || {}).status === 'down');
  const up = sites.filter((s) => (status.sites[s.name] || {}).status === 'up');

  const dateLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const subject = down.length === 0
    ? `✅ Daily uptime digest — all ${sites.length} sites up (${dateLabel})`
    : `⚠️ Daily uptime digest — ${down.length} site(s) down (${dateLabel})`;

  const downRows = down
    .map((s) => {
      const err = (status.sites[s.name] || {}).error || '';
      return `<tr><td style="padding:4px 10px">${s.name}</td><td style="padding:4px 10px;color:#8b93a7">${err}</td></tr>`;
    })
    .join('');

  const html = `
    <h2>Daily uptime digest — ${dateLabel}</h2>
    <p><b>${up.length}</b> up, <b>${down.length}</b> down, out of <b>${sites.length}</b> monitored.</p>
    ${down.length > 0 ? `<table style="border-collapse:collapse"><tr style="text-align:left;background:#f2f2f2"><th style="padding:4px 10px">Site</th><th style="padding:4px 10px">Issue</th></tr>${downRows}</table>` : '<p>Everything is up. 🎉</p>'}
    <p style="color:#8b93a7;font-size:12px">Snapshot from the last hourly check (${status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : 'unknown'}). Dashboard: your Rock It Uptime Monitor login.</p>
  `;
  const text = `${up.length} up, ${down.length} down, out of ${sites.length} monitored.\n` +
    (down.length > 0 ? down.map((s) => `- ${s.name}: ${(status.sites[s.name] || {}).error || ''}`).join('\n') : 'Everything is up.');

  await sendMail(subject, html, text);
  console.log(`Sent daily digest: ${up.length} up, ${down.length} down`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
