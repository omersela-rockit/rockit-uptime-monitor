const express = require('express');
const db = require('../db');
const { queueCheck, computeUptimeStats } = require('../monitor');
const { sendTestEmail } = require('../mailer');

const router = express.Router();

function since(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}

router.get('/sites', (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY created_at ASC').all();
  const enriched = sites.map((s) => ({ ...s, stats24h: computeUptimeStats(s.id, since(24)) }));
  res.json(enriched);
});

router.post('/sites', (req, res) => {
  const { name, url, method, interval_seconds, timeout_ms, keyword } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'url is not a valid URL (include https://)' });
  }
  const info = db
    .prepare(
      `INSERT INTO sites (name, url, method, interval_seconds, timeout_ms, keyword)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      url,
      (method || 'GET').toUpperCase(),
      parseInt(interval_seconds || process.env.DEFAULT_CHECK_INTERVAL_SECONDS || '300', 10),
      parseInt(timeout_ms || process.env.CHECK_TIMEOUT_MS || '15000', 10),
      keyword || null
    );
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(info.lastInsertRowid);
  queueCheck(site);
  res.status(201).json(site);
});

router.post('/sites/bulk', (req, res) => {
  const { text, interval_seconds, timeout_ms, keyword } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'No URLs provided' });

  const interval = parseInt(interval_seconds || process.env.DEFAULT_CHECK_INTERVAL_SECONDS || '300', 10);
  const timeout = parseInt(timeout_ms || process.env.CHECK_TIMEOUT_MS || '15000', 10);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const created = [];
  const errors = [];

  const insert = db.prepare(
    `INSERT INTO sites (name, url, method, interval_seconds, timeout_ms, keyword) VALUES (?, ?, 'GET', ?, ?, ?)`
  );

  for (const line of lines) {
    let name, url;
    const sepMatch = line.split(/\s*[=|]\s*/);
    if (sepMatch.length === 2) {
      [name, url] = sepMatch;
    } else {
      url = line;
    }
    try {
      const parsed = new URL(url);
      if (!name) name = parsed.hostname.replace(/^www\./, '');
    } catch {
      errors.push(`Skipped invalid URL: "${line}"`);
      continue;
    }
    const info = insert.run(name, url, interval, timeout, keyword || null);
    created.push(db.prepare('SELECT * FROM sites WHERE id = ?').get(info.lastInsertRowid));
  }

  created.forEach((site) => queueCheck(site));

  res.status(201).json({ created, errors });
});

router.get('/sites/:id', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const checks = db
    .prepare('SELECT * FROM checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT 100')
    .all(site.id);
  const incidents = db
    .prepare('SELECT * FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT 50')
    .all(site.id);
  res.json({
    ...site,
    stats24h: computeUptimeStats(site.id, since(24)),
    stats7d: computeUptimeStats(site.id, since(24 * 7)),
    checks,
    incidents,
  });
});

router.patch('/sites/:id', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const fields = ['name', 'url', 'method', 'interval_seconds', 'timeout_ms', 'keyword', 'paused'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.json(site);
  values.push(site.id);
  db.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id));
});

router.delete('/sites/:id', (req, res) => {
  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/sites/:id/check-now', async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const check = await queueCheck(site);
  res.json(check);
});

router.post('/test-email', async (req, res) => {
  const result = await sendTestEmail();
  if (result.skipped) return res.status(400).json({ error: 'Email not configured — check GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL_TO in .env' });
  res.json({ ok: true });
});

router.get('/settings', (req, res) => {
  res.json({
    alertEmailTo: process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER || null,
    emailConfigured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    summaryFrequency: process.env.SUMMARY_FREQUENCY || 'daily',
    failureThreshold: parseInt(process.env.FAILURE_THRESHOLD || '2', 10),
  });
});

module.exports = router;
