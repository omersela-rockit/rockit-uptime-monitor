// Self-healing supervisor for the monitor chain.
//
// The monitor is one long-lived job that checks every 5 minutes and then hands
// off to a fresh run. That chain can break: a handoff gets cancelled, a runner
// dies, or a run hangs. Previously the only recovery was GitHub's `schedule:`
// trigger, which is unreliable (measured 5-13 hour gaps) AND actively harmful --
// firing it into the monitor's concurrency group made each new pending run
// cancel the previous one, so a broken chain could stay broken indefinitely.
//
// This supervisor replaces that. It never queues behind the monitor; it inspects
// state and repairs it:
//   fresh heartbeat            -> healthy, do nothing
//   stale heartbeat, no run    -> chain died, start one
//   stale heartbeat, run alive -> run is hung, kill it and start a fresh one
//
// It emails only if a repair fails, since a repaired system needs no email.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const HEARTBEAT_FILE = path.join(ROOT, 'heartbeat.json');

// Checks run every 5 min. 12 minutes means at least two cycles were missed,
// which is past normal jitter and means something is actually wrong.
const STALE_AFTER_MIN = 12;
const WORKFLOW = 'check.yml';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const BRANCH = process.env.GITHUB_REF_NAME || 'master';

function api(pathname, options = {}) {
  return fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function activeRuns() {
  const runs = [];
  for (const status of ['in_progress', 'queued']) {
    const res = await api(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=50`);
    if (!res.ok) throw new Error(`listing ${status} runs failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    runs.push(...body.workflow_runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.run_started_at })));
  }
  return runs;
}

async function cancelRun(id) {
  const res = await api(`/repos/${REPO}/actions/runs/${id}/cancel`, { method: 'POST' });
  // 409 means it already finished on its own -- not a failure for our purposes.
  if (!res.ok && res.status !== 409) {
    throw new Error(`cancelling run ${id} failed: ${res.status} ${await res.text()}`);
  }
}

async function dispatch() {
  const res = await api(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
}

async function sendFailureMail(detail) {
  const to = process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;
  if (!to || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `"RockIt Uptime Supervisor" <${process.env.GMAIL_USER}>`,
    to,
    subject: '🛠️ Uptime monitor stopped and could not be restarted automatically',
    html: `<h2>The monitor chain is down and self-repair failed</h2>
           <p>The supervisor detected that checks had stopped and tried to restart them, but the restart itself failed.</p>
           <p><b>Error:</b> ${detail}</p>
           <p>This needs a look: <a href="https://github.com/${REPO}/actions">GitHub Actions</a></p>`,
    text: `Monitor chain down, self-repair failed: ${detail}\nhttps://github.com/${REPO}/actions`,
  });
}

async function main() {
  if (!REPO || !TOKEN) {
    console.error('[supervisor] GITHUB_REPOSITORY and GH_TOKEN are required');
    process.exit(1);
  }

  let lastCheck = null;
  try {
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    if (hb.checks && hb.checks.length) lastCheck = new Date(hb.checks[hb.checks.length - 1]);
  } catch {
    // No heartbeat at all is itself a reason to start the chain.
  }

  const staleMin = lastCheck ? Math.round((Date.now() - lastCheck.getTime()) / 60000) : Infinity;
  console.log(`[supervisor] last check ${lastCheck ? staleMin + ' min ago' : 'never'}`);

  if (staleMin <= STALE_AFTER_MIN) {
    console.log('[supervisor] cadence healthy, nothing to do');
    return;
  }

  const runs = await activeRuns();
  console.log(`[supervisor] cadence STALE. active monitor runs: ${runs.length}`);

  try {
    if (runs.length > 0) {
      // Something claims to be running yet no checks are landing: it is hung or
      // deadlocked in the queue. Clear it so a fresh run can take over.
      for (const r of runs) {
        console.log(`[supervisor] cancelling stuck run ${r.id} (${r.status}, started ${r.startedAt})`);
        await cancelRun(r.id);
      }
      // Give GitHub a moment to release the concurrency group.
      await new Promise((r) => setTimeout(r, 10000));
    }

    await dispatch();
    console.log('[supervisor] REPAIRED: dispatched a fresh monitor run');
  } catch (err) {
    console.error('[supervisor] self-repair FAILED:', err.message);
    await sendFailureMail(err.message).catch((e) => console.error('[supervisor] failure email failed', e.message));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await sendFailureMail(err.message).catch(() => {});
  process.exit(1);
});
