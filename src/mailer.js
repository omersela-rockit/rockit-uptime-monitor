const nodemailer = require('nodemailer');

function buildTransport() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function sendMail({ subject, html, text }) {
  const transport = buildTransport();
  const to = process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;
  if (!transport || !to) {
    console.warn('[mailer] Email not configured (GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL_TO missing) — skipping send:', subject);
    return { skipped: true };
  }
  return transport.sendMail({
    from: `"Rock It Uptime Monitor" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

function fmt(dt) {
  return dt ? new Date(dt + 'Z').toLocaleString() : '-';
}

async function sendDownAlert(site, check) {
  const subject = `🔴 DOWN: ${site.name}`;
  const reason = check.error_message || `HTTP ${check.status_code}`;
  const html = `
    <h2 style="color:#c0392b">${site.name} is DOWN</h2>
    <p><b>URL:</b> ${site.url}</p>
    <p><b>Reason:</b> ${reason}</p>
    <p><b>Detected at:</b> ${fmt(check.checked_at)}</p>
  `;
  return sendMail({ subject, html, text: `${site.name} (${site.url}) is DOWN. Reason: ${reason}` });
}

async function sendRecoveryAlert(site, downtimeMinutes) {
  const subject = `✅ UP: ${site.name} is back online`;
  const html = `
    <h2 style="color:#27ae60">${site.name} is back UP</h2>
    <p><b>URL:</b> ${site.url}</p>
    <p><b>Downtime:</b> ${downtimeMinutes} minute(s)</p>
  `;
  return sendMail({ subject, html, text: `${site.name} (${site.url}) is back UP after ${downtimeMinutes} minute(s) of downtime.` });
}

async function sendSummary({ periodLabel, rows }) {
  const subject = `📊 Uptime summary (${periodLabel})`;
  const rowsHtml = rows
    .map(
      (r) => `<tr>
        <td style="padding:4px 10px">${r.name}</td>
        <td style="padding:4px 10px">${r.uptimePct}%</td>
        <td style="padding:4px 10px">${r.incidents}</td>
        <td style="padding:4px 10px">${r.avgResponseMs ?? '-'} ms</td>
      </tr>`
    )
    .join('');
  const html = `
    <h2>Uptime summary — ${periodLabel}</h2>
    <table style="border-collapse:collapse">
      <tr style="text-align:left;background:#f2f2f2">
        <th style="padding:4px 10px">Site</th>
        <th style="padding:4px 10px">Uptime</th>
        <th style="padding:4px 10px">Incidents</th>
        <th style="padding:4px 10px">Avg response</th>
      </tr>
      ${rowsHtml}
    </table>
  `;
  return sendMail({ subject, html, text: `Uptime summary (${periodLabel})` });
}

async function sendTestEmail() {
  return sendMail({
    subject: '✅ Rock It Uptime Monitor — test email',
    html: '<p>If you got this, email alerts are configured correctly.</p>',
    text: 'If you got this, email alerts are configured correctly.',
  });
}

module.exports = { sendDownAlert, sendRecoveryAlert, sendSummary, sendTestEmail };
