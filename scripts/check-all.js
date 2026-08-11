// Runs once per GitHub Actions invocation: checks every site in sites.json,
// sends email alerts on up/down transitions, updates status.json, and
// regenerates the static docs/index.html status page.
const fs = require('fs');
const path = require('path');
const dnsPromises = require('dns').promises;
const axios = require('axios');
const nodemailer = require('nodemailer');
const { diagnose } = require('./diagnose');

const ROOT = path.join(__dirname, '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const STATUS_FILE = path.join(ROOT, 'status.json');
const HEARTBEAT_FILE = path.join(ROOT, 'heartbeat.json');
const DOCS_DIR = path.join(ROOT, 'docs');

const CONCURRENCY = 6;
// Generous on purpose: a slow site is not a down site, and a cloud runner's
// route to a given host is often slower than a normal connection. 15s was
// producing false "timed out" alerts for sites that load fine in a browser.
const TIMEOUT_MS = 30000;
const SLOW_RESPONSE_MS = 8000;
const RETRY_DELAY_MS = 5000;

// How many checks in a row must fail before an email goes out.
// Definitive failures (DNS missing, expired cert, 5xx) are trustworthy signals,
// so two in a row is enough. Network-level failures (timeouts, resets) are the
// ones that produce false alarms from cloud runners, so they need a third
// confirmation before anyone is told.
const CONFIRM_FAILURES_DEFINITIVE = 2;
const CONFIRM_FAILURES_NETWORK = 3;

// If this share of all sites fails in one cycle, stop trusting the result until
// the canaries below confirm the runner can reach the internet at all.
const MASS_FAILURE_RATIO = 0.25;

// Big, independently-hosted, extremely reliable endpoints. If these are also
// unreachable, the fault is on this end -- no real event takes Google, Cloudflare
// and GitHub down at the same moment as a customer's WordPress site.
const CANARY_URLS = ['https://www.google.com', 'https://www.cloudflare.com', 'https://github.com'];

// Errors that reflect the network path to the site rather than the site itself.
const NETWORK_ERROR_PATTERNS = [
  'timed out',
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'network',
];

function requiredFailures(error) {
  if (!error) return CONFIRM_FAILURES_DEFINITIVE;
  const lower = String(error).toLowerCase();
  const isNetwork = NETWORK_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
  return isNetwork ? CONFIRM_FAILURES_NETWORK : CONFIRM_FAILURES_DEFINITIVE;
}

// How many recent check timestamps to keep for the hourly self-audit.
const HEARTBEAT_KEEP = 400;

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

// A single site check, with one immediate retry. Most "down" readings from a
// cloud runner are transient blips (a dropped connection, a momentary 5xx). One
// retry a few seconds later removes the majority of them before they ever reach
// the alerting logic.
async function checkSite(site) {
  const first = await checkSiteOnce(site);
  if (first.status === 'up') return first;

  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await checkSiteOnce(site);
  if (second.status === 'up') {
    second.error = null;
    return second;
  }
  return second;
}

async function checkSiteOnce(site) {
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

// Append-only record of when checks actually ran, so the hourly watchdog can
// prove the 5-minute cadence is really happening instead of taking it on faith.
function recordHeartbeat(nowIso = new Date().toISOString()) {
  const heartbeat = loadJson(HEARTBEAT_FILE, { checks: [] });
  heartbeat.checks.push(nowIso);
  heartbeat.checks = heartbeat.checks.slice(-HEARTBEAT_KEEP);
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
}

// Independent proof of whether this runner can reach the internet right now.
async function checkCanaries() {
  return Promise.all(
    CANARY_URLS.map(async (url) => {
      const host = new URL(url).host;
      try {
        const res = await axios.get(url, {
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        });
        return { host, ok: res.status < 500 };
      } catch (err) {
        return { host, ok: false, error: err.message };
      }
    })
  );
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

const CATEGORY_LABELS = {
  dns: 'Domain / DNS',
  tls: 'SSL certificate',
  connection: 'Server unreachable',
  server: 'Server error',
  content: 'Page content',
  config: 'Configuration',
  unknown: 'Inconclusive',
};

async function sendDownAlert(site, result, diagnosis) {
  const reason = result.error || `HTTP ${result.statusCode}`;

  let diagnosisHtml = '';
  let diagnosisText = '';
  if (diagnosis) {
    const shared = diagnosis.sharedWith && diagnosis.sharedWith.length
      ? `<p style="margin:14px 0 0;padding:10px 12px;background:#fff4e5;border-left:3px solid #f5a623;border-radius:4px">
           <b>${diagnosis.sharedWith.length + 1} sites are affected together:</b> ${[site.name, ...diagnosis.sharedWith].join(', ')}.
           This is one incident on shared infrastructure, not separate failures.
         </p>`
      : '';
    diagnosisHtml = `
      <div style="margin-top:22px;padding:16px;background:#f7f8fa;border-radius:8px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;font-weight:700">
          Diagnosis &middot; ${CATEGORY_LABELS[diagnosis.category] || diagnosis.category}
        </div>
        <h3 style="margin:6px 0 10px">${diagnosis.headline}</h3>
        <p style="margin:0 0 10px"><b>What this means:</b> ${diagnosis.likelyCause}</p>
        <p style="margin:0 0 14px"><b>What to do:</b> ${diagnosis.action}</p>
        ${shared}
        <details style="margin-top:12px">
          <summary style="cursor:pointer;color:#6366f1;font-size:13px">Technical evidence</summary>
          <ul style="font-size:13px;color:#555;margin:8px 0 0;padding-left:18px">
            ${diagnosis.evidence.map((e) => `<li>${e}</li>`).join('')}
          </ul>
        </details>
      </div>`;
    diagnosisText =
      `\n\nDIAGNOSIS (${CATEGORY_LABELS[diagnosis.category] || diagnosis.category}): ${diagnosis.headline}\n` +
      `What this means: ${diagnosis.likelyCause}\n` +
      `What to do: ${diagnosis.action}\n` +
      (diagnosis.sharedWith && diagnosis.sharedWith.length
        ? `Also affected on the same server: ${diagnosis.sharedWith.join(', ')}\n`
        : '') +
      `Evidence:\n${diagnosis.evidence.map((e) => '  - ' + e).join('\n')}`;
  }

  const subject = diagnosis ? `🔴 DOWN: ${site.name} — ${diagnosis.headline}` : `🔴 DOWN: ${site.name}`;

  await sendMail(
    subject,
    `<h2 style="color:#c0392b">${site.name} is DOWN</h2>
     <p><b>URL:</b> <a href="${site.url}">${site.url}</a></p>
     <p><b>Detected error:</b> ${reason}</p>
     ${diagnosisHtml}`,
    `${site.name} (${site.url}) is DOWN. Detected error: ${reason}${diagnosisText}`
  );
}

async function sendRecoveryAlert(site, downtimeMinutes) {
  await sendMail(
    `✅ UP: ${site.name} is back online`,
    `<h2 style="color:#27ae60">${site.name} is back UP</h2><p><b>URL:</b> ${site.url}</p><p><b>Downtime:</b> ~${downtimeMinutes} minute(s)</p>`,
    `${site.name} (${site.url}) is back UP after ~${downtimeMinutes} minute(s) of downtime.`
  );
}

const GITHUB_REPO = 'omersela-rockit/rockit-uptime-monitor';
const GITHUB_BRANCH = 'master';
const SITES_EDIT_URL = `https://github.com/${GITHUB_REPO}/edit/${GITHUB_BRANCH}/sites.json`;

function renderStatusPage(sites, statusMap) {
  function rowsFor(list) {
    return list
      .map((site) => {
        const s = statusMap[site.name] || {};
        const note = s.error ? escapeHtml(s.error) : '';
        return `<tr data-name="${escapeHtml(site.name.toLowerCase())}">
          <td>
            <a href="${site.url}" target="_blank" rel="noopener" title="${site.url}">${site.name}</a>
            <a class="edit-link" href="${SITES_EDIT_URL}" target="_blank" rel="noopener" title="Edit this site's URL on GitHub">✎</a>
            <a class="edit-link delete-link" href="${SITES_EDIT_URL}" target="_blank" rel="noopener" title="Remove from monitoring: opens GitHub, delete this site's line, then commit">🗑</a>
          </td>
          <td class="nowrap">${s.responseTimeMs != null ? s.responseTimeMs + ' ms' : '-'}</td>
          <td class="note" title="${note}">${note}</td>
        </tr>`;
      })
      .join('\n');
  }

  const upSites = sites.filter((site) => (statusMap[site.name] || {}).status === 'up');
  const downSites = sites.filter((site) => (statusMap[site.name] || {}).status === 'down');
  const upCount = upSites.length;
  const downCount = downSites.length;
  const lastRunLabel = new Date().toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC';

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
main{max-width:900px;margin:0 auto;padding:28px}
.summary{display:flex;gap:14px;margin-bottom:22px}
.stat{flex:1;background:var(--panel);border:1px solid var(--border);border-top:2px solid var(--accent);border-radius:14px;padding:14px 18px;cursor:pointer;text-align:left;font-family:inherit;color:inherit;transition:border-color .15s ease,transform .15s ease}
.stat:hover{border-color:var(--accent-2);transform:translateY(-1px)}
.stat .label{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.stat .value{font-size:24px;font-weight:700;margin-top:4px}
.updated{color:var(--muted-2,#5d6472);font-size:12px;margin:-14px 0 10px}
.search{width:100%;padding:11px 14px;margin:0 0 18px;background:var(--panel);border:1px solid var(--border);border-radius:12px;color:var(--text);font-size:14px;font-family:inherit;box-sizing:border-box}
.search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.22)}
.hidden{display:none!important}
.columns{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.col{flex:1 1 300px;min-width:0;max-width:100%;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;scroll-margin-top:20px}
.col.down-col{order:1;border-top:2px solid var(--down)}
.col.up-col{order:2;border-top:2px solid var(--up)}
.col h2{font-size:12.5px;margin:0;padding:12px 14px;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.04em}
.col.down-col h2{color:var(--down)}
.col.up-col h2{color:var(--up)}
.col-scroll{max-height:520px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
th:nth-child(2),td:nth-child(2){width:60px}
th:last-child,td:last-child{width:42%}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1b1e27;overflow:visible;white-space:normal;word-break:break-word}
td:first-child{display:flex;align-items:center;gap:6px}
td:first-child a:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.edit-link{flex-shrink:0;font-weight:400;opacity:.45;text-decoration:none}
.edit-link:hover{opacity:1;color:var(--accent-2)}
.delete-link:hover{color:var(--down)}
a{color:var(--text);text-decoration:none;font-weight:600}
a:hover{color:var(--accent-2)}
.note{color:var(--muted)}
footer{text-align:center;padding:30px;color:#5d6472;font-size:12.5px}
footer b{background:linear-gradient(135deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
@media (max-width:640px){.columns{flex-direction:column}.col{flex-basis:auto;width:100%}}
</style>
</head><body>
<header><div class="mark"><svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M7 18h4l2.5-8L18 25l2.5-8H25" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h1>Rock It Uptime Monitor</h1><a href="${SITES_EDIT_URL}" target="_blank" rel="noopener" style="margin-inline-start:auto;font-size:12.5px;font-weight:600;color:var(--muted)">✎ Edit site list</a></header>
<main>
<div class="summary">
  <div class="stat" style="cursor:default"><div class="label">Total sites</div><div class="value">${sites.length}</div></div>
  <button class="stat" onclick="document.getElementById('up-col').scrollIntoView({behavior:'smooth',block:'start'})"><div class="label">Up</div><div class="value" style="color:var(--up)">${upCount}</div></button>
  <button class="stat" onclick="document.getElementById('down-col').scrollIntoView({behavior:'smooth',block:'start'})"><div class="label">Down</div><div class="value" style="color:var(--down)">${downCount}</div></button>
</div>
<p class="updated">Last checked: ${lastRunLabel} · updates hourly</p>
<input type="search" id="searchBox" class="search" placeholder="🔎 Search a site by name…" oninput="filterSites(this.value)" />
<p id="searchEmpty" class="hidden" style="color:var(--muted);font-size:13px;margin:-10px 0 16px">No sites match "<span id="searchEmptyTerm"></span>"</p>
<div class="columns">
  <div class="col down-col" id="down-col">
    <h2>🔴 Down (${downCount})</h2>
    <div class="col-scroll"><table>
      <thead><tr><th>Name</th><th>Resp.</th><th>Notes</th></tr></thead>
      <tbody>${rowsFor(downSites) || `<tr><td colspan="3" style="color:var(--muted);white-space:normal">Nothing down 🎉</td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="col up-col" id="up-col">
    <h2>🟢 Up (${upCount})</h2>
    <div class="col-scroll"><table>
      <thead><tr><th>Name</th><th>Resp.</th><th>Notes</th></tr></thead>
      <tbody>${rowsFor(upSites)}</tbody>
    </table></div>
  </div>
</div>
</main>
<footer>Powered by <b>RockIt AI Technologies</b> — checked hourly via GitHub Actions</footer>
<script>
function filterSites(query) {
  const q = query.trim().toLowerCase();
  const rows = document.querySelectorAll('tr[data-name]');
  let visibleCount = 0;
  rows.forEach((row) => {
    const match = !q || row.dataset.name.includes(q);
    row.classList.toggle('hidden', !match);
    if (match) visibleCount++;
  });
  document.getElementById('searchEmpty').classList.toggle('hidden', !(q && visibleCount === 0));
  document.getElementById('searchEmptyTerm').textContent = query;
}
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  const sites = loadJson(SITES_FILE, []);
  const prev = loadJson(STATUS_FILE, { sites: {} });
  const results = await checkAllThrottled(sites);

  // Guard against the runner's own network breaking and making every site look
  // dead. On 2026-08-10T21:08 twenty unrelated sites "failed" in the same second
  // with a mix of timeouts and 502s, then all recovered together 21 minutes
  // later -- that was the egress path, not the sites. Per-site confirmation
  // can't catch this because every site fails repeatedly during such an outage.
  const failed = results.filter((r) => r.status === 'down').length;
  const failureRatio = sites.length ? failed / sites.length : 0;

  if (failureRatio >= MASS_FAILURE_RATIO) {
    const canaries = await checkCanaries();
    const canariesDown = canaries.filter((c) => !c.ok);
    if (canariesDown.length >= 2) {
      console.error(
        `[network] ${failed}/${sites.length} sites failed AND ${canariesDown.length}/${canaries.length} canaries ` +
          `(${canariesDown.map((c) => c.host).join(', ')}) are unreachable -- this is the monitor's own network, not your sites.`
      );
      console.error('[network] leaving all statuses unchanged and sending no alerts this cycle.');
      // Still record the heartbeat: the loop ran on time, it just couldn't trust
      // what it saw. Suppressing that would make the cadence look broken too.
      recordHeartbeat();
      return;
    }
    console.warn(
      `[network] ${failed}/${sites.length} sites failed but canaries are reachable ` +
        '-- treating as a real outage (shared hosting can fail together).'
    );
  }

  const statusMap = {};
  const nowIso = new Date().toISOString();

  // Group the currently-failing sites by the IP they resolve to. When a batch of
  // client sites goes dark at once it is almost always one shared server, and
  // saying so turns twenty confusing emails into one clear incident.
  const downPeers = new Map();
  const downNow = sites.filter((_, i) => results[i].status === 'down');
  if (downNow.length > 1) {
    await Promise.all(
      downNow.map(async (site) => {
        try {
          const ips = await dnsPromises.resolve4(new URL(site.url).hostname);
          if (!ips.length) return;
          const list = downPeers.get(ips[0]) || [];
          list.push(site.name);
          downPeers.set(ips[0], list);
        } catch {
          // Unresolvable hosts can't share an IP with anything; DNS-layer
          // diagnosis will explain those individually.
        }
      })
    );
  }

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const result = results[i];
    const prevEntry = prev.sites[site.name] || {};
    const prevFailures = prevEntry.consecutiveFailures || 0;
    const wasAlerted = !!prevEntry.alerted;

    const failures = result.status === 'down' ? prevFailures + 1 : 0;
    const downSince = result.status === 'down' ? prevEntry.downSince || nowIso : null;

    // Only email once the failure has been confirmed by later checks, and only
    // email a recovery if we actually told anyone it was down in the first place.
    const needed = requiredFailures(result.error);
    let alerted = wasAlerted;
    let diagnosis = prevEntry.diagnosis || null;
    if (result.status === 'down' && !wasAlerted && failures >= needed) {
      console.log(`[alert] ${site.name} -> DOWN confirmed ${failures}x (${result.error})`);
      // Only diagnosed at the moment of alerting: it costs several probes, and
      // this is exactly when someone needs to know the cause.
      diagnosis = await diagnose(site, result, { downPeers }).catch((e) => {
        console.error('[diagnose] failed', e.message);
        return null;
      });
      if (diagnosis) console.log(`[diagnose] ${site.name}: [${diagnosis.category}] ${diagnosis.headline}`);
      await sendDownAlert(site, result, diagnosis).catch((e) => console.error('[mail] down alert failed', e.message));
      alerted = true;
    } else if (result.status === 'down' && !wasAlerted) {
      console.log(`[pending] ${site.name} failed ${failures}/${needed} - waiting for confirmation, no email yet`);
    } else if (result.status === 'up' && wasAlerted) {
      const since = prevEntry.downSince ? new Date(prevEntry.downSince) : new Date();
      const minutes = Math.max(1, Math.round((Date.now() - since.getTime()) / 60000));
      console.log(`[alert] ${site.name} -> back UP after ~${minutes}m`);
      await sendRecoveryAlert(site, minutes).catch((e) => console.error('[mail] recovery alert failed', e.message));
      alerted = false;
      diagnosis = null;
    } else if (result.status === 'up') {
      diagnosis = null;
    } else if (result.status === 'down' && wasAlerted && !diagnosis) {
      // Already-alerted outage with no diagnosis on record (it started before
      // diagnosis existed, or the probe failed last time). Fill it in for the
      // dashboard without emailing again -- they were already told.
      diagnosis = await diagnose(site, result, { downPeers }).catch(() => null);
      if (diagnosis) console.log(`[diagnose] ${site.name} (backfill): [${diagnosis.category}] ${diagnosis.headline}`);
    }

    statusMap[site.name] = {
      status: result.status,
      statusCode: result.statusCode,
      error: result.error,
      responseTimeMs: result.responseTimeMs,
      lastCheckedAt: nowIso,
      downSince,
      consecutiveFailures: failures,
      alerted,
      diagnosis,
    };
  }

  fs.writeFileSync(STATUS_FILE, JSON.stringify({ lastRunAt: nowIso, sites: statusMap }, null, 2));

  recordHeartbeat(nowIso);

  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), renderStatusPage(sites, statusMap));

  const downSites = Object.entries(statusMap).filter(([, s]) => s.status === 'down');
  console.log(`Checked ${sites.length} sites: ${sites.length - downSites.length} up, ${downSites.length} down`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
