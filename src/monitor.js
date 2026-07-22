const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const { sendDownAlert, sendRecoveryAlert, sendSummary } = require('./mailer');

const FAILURE_THRESHOLD = parseInt(process.env.FAILURE_THRESHOLD || '2', 10);
const SLOW_RESPONSE_MS = parseInt(process.env.SLOW_RESPONSE_MS || '8000', 10);

// Pages that return 200 OK but actually show a broken/parked/suspended site.
// Plain status-code checks miss these entirely.
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

async function checkSite(site) {
  const startedAt = Date.now();
  let status = 'up';
  let statusCode = null;
  let errorMessage = null;

  try {
    const res = await axios.request({
      url: site.url,
      method: site.method || 'GET',
      timeout: site.timeout_ms || 15000,
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
    const inRange = statusCode >= site.expected_status_min && statusCode <= site.expected_status_max;
    let keywordOk = true;
    if (site.keyword && typeof res.data === 'string') {
      keywordOk = res.data.includes(site.keyword);
    }
    const bodyLower = typeof res.data === 'string' ? res.data.toLowerCase() : '';
    const errorSignature = ERROR_SIGNATURES.find((sig) => bodyLower.includes(sig));

    if (!inRange) {
      status = 'down';
      errorMessage = `Unexpected status code ${statusCode}`;
    } else if (!keywordOk) {
      status = 'down';
      errorMessage = `Expected keyword "${site.keyword}" not found on page`;
    } else if (errorSignature) {
      status = 'down';
      errorMessage = `Page loaded (${statusCode}) but looks broken: contains "${errorSignature}"`;
    } else if (bodyLower.length < 50) {
      status = 'down';
      errorMessage = `Page loaded (${statusCode}) but returned almost no content (${bodyLower.length} bytes)`;
    }
  } catch (err) {
    status = 'down';
    errorMessage = err.code === 'ECONNABORTED' ? 'Request timed out' : err.message;
  }

  const responseTimeMs = Date.now() - startedAt;
  if (status === 'up' && responseTimeMs > SLOW_RESPONSE_MS) {
    errorMessage = `Slow response (${responseTimeMs}ms) — site is up but sluggish`;
  }

  db.prepare(
    `INSERT INTO checks (site_id, status, status_code, response_time_ms, error_message) VALUES (?, ?, ?, ?, ?)`
  ).run(site.id, status, statusCode, responseTimeMs, errorMessage);

  const check = { status, status_code: statusCode, response_time_ms: responseTimeMs, error_message: errorMessage, checked_at: new Date().toISOString() };

  await applyStatusTransition(site, check);

  db.prepare(`UPDATE sites SET last_checked_at = datetime('now') WHERE id = ?`).run(site.id);

  return check;
}

async function applyStatusTransition(site, check) {
  const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);

  if (check.status === 'down') {
    const failures = fresh.consecutive_failures + 1;
    db.prepare('UPDATE sites SET consecutive_failures = ? WHERE id = ?').run(failures, site.id);

    if (fresh.current_status !== 'down' && failures >= FAILURE_THRESHOLD) {
      db.prepare(`UPDATE sites SET current_status = 'down' WHERE id = ?`).run(site.id);
      db.prepare(`INSERT INTO incidents (site_id, cause) VALUES (?, ?)`).run(site.id, check.error_message);
      try {
        await sendDownAlert(fresh, check);
      } catch (e) {
        console.error('[monitor] failed to send down alert', e.message);
      }
    }
  } else {
    const wasDown = fresh.current_status === 'down';
    db.prepare(`UPDATE sites SET consecutive_failures = 0, current_status = 'up' WHERE id = ?`).run(site.id);

    if (wasDown) {
      const incident = db
        .prepare('SELECT * FROM incidents WHERE site_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
        .get(site.id);
      if (incident) {
        db.prepare(`UPDATE incidents SET resolved_at = datetime('now') WHERE id = ?`).run(incident.id);
        const downtimeMinutes = Math.max(
          1,
          Math.round((Date.now() - new Date(incident.started_at + 'Z').getTime()) / 60000)
        );
        try {
          await sendRecoveryAlert(fresh, downtimeMinutes);
        } catch (e) {
          console.error('[monitor] failed to send recovery alert', e.message);
        }
      }
    } else if (fresh.current_status === 'unknown') {
      db.prepare(`UPDATE sites SET current_status = 'up' WHERE id = ?`).run(site.id);
    }
  }
}

// Checking dozens of sites at once floods the local connection/DNS resolver and causes
// false "timed out" results that have nothing to do with the target site being down.
// Route every check through a small concurrency-limited queue instead of firing them all at once.
const CHECK_CONCURRENCY = parseInt(process.env.CHECK_CONCURRENCY || '6', 10);
let activeChecks = 0;
const checkQueue = [];

function queueCheck(site) {
  return new Promise((resolve) => {
    checkQueue.push({ site, resolve });
    pumpQueue();
  });
}

function pumpQueue() {
  while (activeChecks < CHECK_CONCURRENCY && checkQueue.length > 0) {
    const { site, resolve } = checkQueue.shift();
    activeChecks++;
    checkSite(site)
      .catch((e) => {
        console.error(`[monitor] check failed for site ${site.id}`, e.message);
        return null;
      })
      .then((result) => {
        activeChecks--;
        resolve(result);
        pumpQueue();
      });
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sites = db.prepare('SELECT * FROM sites WHERE paused = 0').all();
    const now = Date.now();
    for (const site of sites) {
      const last = site.last_checked_at ? new Date(site.last_checked_at + 'Z').getTime() : 0;
      const dueAt = last + site.interval_seconds * 1000;
      if (now >= dueAt) {
        queueCheck(site);
      }
    }
  } finally {
    ticking = false;
  }
}

function computeUptimeStats(siteId, sinceIso) {
  const total = db
    .prepare('SELECT COUNT(*) c FROM checks WHERE site_id = ? AND checked_at >= ?')
    .get(siteId, sinceIso).c;
  const up = db
    .prepare("SELECT COUNT(*) c FROM checks WHERE site_id = ? AND checked_at >= ? AND status = 'up'")
    .get(siteId, sinceIso).c;
  const avg = db
    .prepare('SELECT AVG(response_time_ms) a FROM checks WHERE site_id = ? AND checked_at >= ? AND status = \'up\'')
    .get(siteId, sinceIso).a;
  const incidents = db
    .prepare('SELECT COUNT(*) c FROM incidents WHERE site_id = ? AND started_at >= ?')
    .get(siteId, sinceIso).c;
  return {
    uptimePct: total > 0 ? Math.round((up / total) * 1000) / 10 : 100,
    avgResponseMs: avg ? Math.round(avg) : null,
    incidents,
    totalChecks: total,
  };
}

async function runSummaryEmail(periodLabel, sinceIso) {
  const sites = db.prepare('SELECT * FROM sites').all();
  if (sites.length === 0) return;
  const rows = sites.map((s) => ({ name: s.name, ...computeUptimeStats(s.id, sinceIso) }));
  await sendSummary({ periodLabel, rows });
}

function startScheduler() {
  cron.schedule('*/30 * * * * *', () => {
    tick().catch((e) => console.error('[monitor] tick error', e.message));
  });

  const frequency = process.env.SUMMARY_FREQUENCY || 'daily';
  const hour = parseInt(process.env.SUMMARY_HOUR || '8', 10);

  if (frequency === 'daily') {
    cron.schedule(`0 ${hour} * * *`, () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      runSummaryEmail('last 24 hours', since).catch((e) => console.error('[monitor] summary error', e.message));
    });
  } else if (frequency === 'weekly') {
    cron.schedule(`0 ${hour} * * 1`, () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      runSummaryEmail('last 7 days', since).catch((e) => console.error('[monitor] summary error', e.message));
    });
  }

  console.log('[monitor] scheduler started');
}

module.exports = { checkSite, queueCheck, tick, startScheduler, computeUptimeStats, runSummaryEmail };
