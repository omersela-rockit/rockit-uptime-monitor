// Runs once per GitHub Actions invocation: checks every site in sites.json,
// sends email alerts on up/down transitions, updates status.json, and
// regenerates the static docs/index.html status page.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const STATUS_FILE = path.join(ROOT, 'status.json');
const DOCS_DIR = path.join(ROOT, 'docs');

const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const SLOW_RESPONSE_MS = 8000;

const ERROR_SIGNATURES = [
  'account has been suspended',
  'this account has been suspended',
  'domain has expired',
  'this domain is expired',
  'domain is parked',
  'buy this domain',
  'this domain may be for sale',
  'error establishing a database connection',
  'database connection error',
  'index of /',
  'bandwidth limit exceeded',
  'website is currently unavailable',
  'this site is temporarily unavailable',
  'default web site page',
  '404 not found',
  'the requested url was not found',
];

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function checkSite(site) {
  const startedAt = Date.now();
  let status = 'up';
  let statusCode = null;
  let error = null;

  try {
    const res = await axios.request({
      url: site.url,
      method: 'GET',
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
      },
    });
    statusCode = res.status;
    const bodyLower = typeof res.data === 'string' ? res.data.toLowerCase() : '';
    const errorSignature = ERROR_SIGNATURES.find((sig) => bodyLower.includes(sig));
    let keywordOk = true;
    if (site.keyword && typeof res.data === 'string') keywordOk = res.data.includes(site.keyword);

    // Getting ANY HTTP response at all -- even a 403/401/429 -- proves the server is alive,
    // reachable, and answering requests. A genuinely down site can't produce an HTTP status
    // code; it fails at DNS, connection, or TLS instead (handled in the catch block below).
    // 401/403/429 are access-control decisions made by a working server/WAF, not outages, so
    // they don't count as down -- confirmed by manually re-checking every such site from a
    // normal (non-cloud) IP: they all loaded fine. Only real server-side breakage (5xx) counts.
    const isAccessDenied = [401, 403, 429].includes(statusCode);

    if (statusCode >= 500) {
      status = 'down';
      error = `Server error ${statusCode}`;
    } else if (isAccessDenied) {
      status = 'up';
      error = `HTTP ${statusCode} (access denied by the site's own firewall/rate-limit, not an outage -- server is responding)`;
    } else if (statusCode < 200 || statusCode > 299) {
      status = 'down';
      error = `Unexpected status code ${statusCode}`;
    } else if (!keywordOk) {
      status = 'down';
      error = `Expected keyword "${site.keyword}" not found on page`;
    } else if (errorSignature) {
      status = 'down';
      error = `Page loaded (${statusCode}) but looks broken: contains "${errorSignature}"`;
    } else if (bodyLower.length < 50) {
      status = 'down';
      error = `Page loaded (${statusCode}) but returned almost no content`;
    }
  } catch (err) {
    status = 'down';
    error = err.code === 'ECONNABORTED' ? 'Request timed out' : err.message;
  }

  const responseTimeMs = Date.now() - startedAt;
  if (status === 'up' && responseTimeMs > SLOW_RESPONSE_MS) {
    error = `Slow response (${responseTimeMs}ms)`;
  }

  return { status, statusCode, error, responseTimeMs };
}

async function checkAllThrottled(sites) {
  const results = new Array(sites.length);
  let next = 0;
  async function worker() {
    while (next < sites.length) {
      const i = next++;
      results[i] = await checkSite(sites[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

function buildTransport() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function sendMail(subject, html, text) {
  const transport = buildTransport();
  const to = process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;
  if (!transport || !to) {
    console.warn('[mail] not configured, skipping:', subject);
    return;
  }
  await transport.sendMail({ from: `"Rock It Uptime Monitor" <${process.env.GMAIL_USER}>`, to, subject, html, text });
}

async function sendDownAlert(site, result) {
  const reason = result.error || `HTTP ${result.statusCode}`;
  await sendMail(
    `🔴 DOWN: ${site.name}`,
    `<h2 style="color:#c0392b">${site.name} is DOWN</h2><p><b>URL:</b> ${site.url}</p><p><b>Reason:</b> ${reason}</p>`,
    `${site.name} (${site.url}) is DOWN. Reason: ${reason}`
  );
}

async function sendRecoveryAlert(site, downtimeMinutes) {
  await sendMail(
    `✅ UP: ${site.name} is back online`,
    `<h2 style="color:#27ae60">${site.name} is back UP</h2><p><b>URL:</b> ${site.url}</p><p><b>Downtime:</b> ~${downtimeMinutes} minute(s)</p>`,
    `${site.name} (${site.url}) is back UP after ~${downtimeMinutes} minute(s) of downtime.`
  );
}

function renderStatusPage(sites, statusMap) {
  function rowsFor(list) {
    return list
      .map((site) => {
        const s = statusMap[site.name] || {};
        return `<tr>
          <td>${site.name}</td>
          <td><a href="${site.url}" target="_blank" rel="noopener">${site.url}</a></td>
          <td>${s.responseTimeMs != null ? s.responseTimeMs + ' ms' : '-'}</td>
          <td>${s.lastCheckedAt ? new Date(s.lastCheckedAt).toLocaleString('en-GB') : '-'}</td>
          <td>${s.error ? escapeHtml(s.error) : ''}</td>
        </tr>`;
      })
      .join('\n');
  }

  const upSites = sites.filter((site) => (statusMap[site.name] || {}).status === 'up');
  const downSites = sites.filter((site) => (statusMap[site.name] || {}).status === 'down');
  const upCount = upSites.length;
  const downCount = downSites.length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Rock It Uptime Monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236366f1'/%3E%3Cstop offset='1' stop-color='%238b5cf6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='url(%23g)'/%3E%3Cpath d='M7 18h4l2.5-8L18 25l2.5-8H25' stroke='white' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
<style>
:root{--bg:#0a0b0f;--panel:#14161d;--border:#262a35;--text:#eef0f4;--muted:#8b93a7;--up:#34d399;--down:#f5677a;--accent:#6366f1;--accent-2:#8b5cf6;}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(900px 500px at 12% -10%,#1b1040 0%,transparent 60%),radial-gradient(700px 500px at 100% 0%,#071a2e 0%,transparent 55%),var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;min-height:100vh}
header{display:flex;align-items:center;gap:12px;padding:20px 28px;border-bottom:1px solid var(--border)}
header .mark{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px -4px rgba(99,102,241,.6)}
h1{font-size:17px;margin:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
main{max-width:1100px;margin:0 auto;padding:28px}
.summary{display:flex;gap:14px;margin-bottom:22px}
.stat{flex:1;background:var(--panel);border:1px solid var(--border);border-top:2px solid var(--accent);border-radius:14px;padding:14px 18px;cursor:pointer;text-align:left;font-family:inherit;color:inherit;transition:border-color .15s ease,transform .15s ease}
.stat:hover{border-color:var(--accent-2);transform:translateY(-1px)}
.stat .label{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.stat .value{font-size:24px;font-weight:700;margin-top:4px}
.columns{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.col{flex:1;min-width:340px;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;scroll-margin-top:20px}
.col.down-col{order:1;border-top:2px solid var(--down)}
.col.up-col{order:2;border-top:2px solid var(--up)}
.col h2{font-size:13px;margin:0;padding:14px 16px;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.04em}
.col.down-col h2{color:var(--down)}
.col.up-col h2{color:var(--up)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1b1e27}
a{color:var(--muted);text-decoration:none}
a:hover{color:var(--text)}
footer{text-align:center;padding:30px;color:#5d6472;font-size:12.5px}
footer b{background:linear-gradient(135deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
@media (max-width:760px){.col{min-width:100%}}
</style>
</head><body>
<header><div class="mark"><svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M7 18h4l2.5-8L18 25l2.5-8H25" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h1>Rock It Uptime Monitor</h1></header>
<main>
<div class="summary">
  <div class="stat" style="cursor:default"><div class="label">Total sites</div><div class="value">${sites.length}</div></div>
  <button class="stat" onclick="document.getElementById('up-col').scrollIntoView({behavior:'smooth',block:'start'})"><div class="label">Up</div><div class="value" style="color:var(--up)">${upCount}</div></button>
  <button class="stat" onclick="document.getElementById('down-col').scrollIntoView({behavior:'smooth',block:'start'})"><div class="label">Down</div><div class="value" style="color:var(--down)">${downCount}</div></button>
</div>
<div class="columns">
  <div class="col down-col" id="down-col">
    <h2>🔴 Down (${downCount})</h2>
    <table>
      <thead><tr><th>Name</th><th>URL</th><th>Response</th><th>Last checked (UTC)</th><th>Notes</th></tr></thead>
      <tbody>${rowsFor(downSites) || `<tr><td colspan="5" style="color:var(--muted)">Nothing down 🎉</td></tr>`}</tbody>
    </table>
  </div>
  <div class="col up-col" id="up-col">
    <h2>🟢 Up (${upCount})</h2>
    <table>
      <thead><tr><th>Name</th><th>URL</th><th>Response</th><th>Last checked (UTC)</th><th>Notes</th></tr></thead>
      <tbody>${rowsFor(upSites)}</tbody>
    </table>
  </div>
</div>
</main>
<footer>Powered by <b>RockIt AI Technologies</b> — checked hourly via GitHub Actions</footer>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  const sites = loadJson(SITES_FILE, []);
  const prev = loadJson(STATUS_FILE, { sites: {} });
  const results = await checkAllThrottled(sites);

  const statusMap = {};
  const nowIso = new Date().toISOString();

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const result = results[i];
    const prevEntry = prev.sites[site.name];
    const wasStatus = prevEntry ? prevEntry.status : 'unknown';

    if (result.status === 'down' && wasStatus !== 'down') {
      console.log(`[alert] ${site.name} -> DOWN (${result.error})`);
      await sendDownAlert(site, result).catch((e) => console.error('[mail] down alert failed', e.message));
    } else if (result.status === 'up' && wasStatus === 'down') {
      const downSince = prevEntry.downSince ? new Date(prevEntry.downSince) : new Date();
      const minutes = Math.max(1, Math.round((Date.now() - downSince.getTime()) / 60000));
      console.log(`[alert] ${site.name} -> back UP after ~${minutes}m`);
      await sendRecoveryAlert(site, minutes).catch((e) => console.error('[mail] recovery alert failed', e.message));
    }

    statusMap[site.name] = {
      status: result.status,
      statusCode: result.statusCode,
      error: result.error,
      responseTimeMs: result.responseTimeMs,
      lastCheckedAt: nowIso,
      downSince: result.status === 'down' ? (wasStatus === 'down' ? prevEntry.downSince : nowIso) : null,
    };
  }

  fs.writeFileSync(STATUS_FILE, JSON.stringify({ lastRunAt: nowIso, sites: statusMap }, null, 2));

  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), renderStatusPage(sites, statusMap));

  const downSites = Object.entries(statusMap).filter(([, s]) => s.status === 'down');
  console.log(`Checked ${sites.length} sites: ${sites.length - downSites.length} up, ${downSites.length} down`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
