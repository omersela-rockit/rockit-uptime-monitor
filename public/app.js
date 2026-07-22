const siteListEl = document.getElementById('siteList');
const emptyStateEl = document.getElementById('emptyState');
const listView = document.getElementById('listView');
const detailView = document.getElementById('detailView');

let currentSiteId = null;
let pollTimer = null;

function toast(message, type = 'success') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso.endsWith('Z') ? iso : iso + 'Z').toLocaleString();
}

function renderSiteRow(site) {
  const div = document.createElement('div');
  div.className = 'site-row';
  div.innerHTML = `
    <div class="status-dot ${site.current_status}"></div>
    <div class="site-main">
      <div class="site-name">${escapeHtml(site.name)}</div>
      <div class="site-url">${escapeHtml(site.url)}</div>
    </div>
    <div class="site-meta">
      <div><b>${site.stats24h.uptimePct}%</b> uptime (24h)</div>
      <div><b>${site.stats24h.avgResponseMs ?? '-'}</b> ms avg</div>
      <div>checked <b>${fmtDate(site.last_checked_at)}</b></div>
    </div>
    <span class="pill ${site.current_status}">${site.current_status}</span>
  `;
  div.addEventListener('click', () => openDetail(site.id));
  return div;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

async function loadSites() {
  const sites = await api('/sites');
  siteListEl.innerHTML = '';
  emptyStateEl.classList.toggle('hidden', sites.length > 0);
  sites.forEach((s) => siteListEl.appendChild(renderSiteRow(s)));
}

async function openDetail(id) {
  currentSiteId = id;
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
  await refreshDetail();
}

async function refreshDetail() {
  if (!currentSiteId) return;
  const site = await api(`/sites/${currentSiteId}`);
  document.getElementById('detailName').textContent = site.name;
  const urlEl = document.getElementById('detailUrl');
  urlEl.textContent = site.url;
  urlEl.href = site.url;
  document.getElementById('detailStatus').innerHTML = `<span class="pill ${site.current_status}">${site.current_status}</span>`;
  document.getElementById('detailUptime24').textContent = site.stats24h.uptimePct + '%';
  document.getElementById('detailUptime7').textContent = site.stats7d.uptimePct + '%';
  document.getElementById('detailAvgResp').textContent = (site.stats24h.avgResponseMs ?? '-') + ' ms';
  document.getElementById('pauseSiteBtn').textContent = site.paused ? 'Resume' : 'Pause';

  const checksBody = document.getElementById('checksTable');
  checksBody.innerHTML = site.checks
    .map(
      (c) => `<tr>
        <td>${fmtDate(c.checked_at)}</td>
        <td><span class="pill ${c.status}">${c.status}</span></td>
        <td>${c.status_code ?? '-'}</td>
        <td>${c.response_time_ms ?? '-'} ms</td>
        <td>${escapeHtml(c.error_message || '')}</td>
      </tr>`
    )
    .join('');

  const incidentsBody = document.getElementById('incidentsTable');
  incidentsBody.innerHTML = site.incidents
    .map(
      (i) => `<tr>
        <td>${fmtDate(i.started_at)}</td>
        <td>${i.resolved_at ? fmtDate(i.resolved_at) : '<span class="pill down">ongoing</span>'}</td>
        <td>${escapeHtml(i.cause || '')}</td>
      </tr>`
    )
    .join('');

  window._currentSite = site;
}

function closeDetail() {
  currentSiteId = null;
  detailView.classList.add('hidden');
  listView.classList.remove('hidden');
  loadSites();
}

document.getElementById('backLink').addEventListener('click', (e) => {
  e.preventDefault();
  closeDetail();
});

document.getElementById('checkNowBtn').addEventListener('click', async () => {
  await api(`/sites/${currentSiteId}/check-now`, { method: 'POST' });
  await refreshDetail();
});

document.getElementById('pauseSiteBtn').addEventListener('click', async () => {
  const paused = window._currentSite.paused ? 0 : 1;
  await api(`/sites/${currentSiteId}`, { method: 'PATCH', body: JSON.stringify({ paused }) });
  await refreshDetail();
});

document.getElementById('deleteSiteBtn').addEventListener('click', async () => {
  if (!confirm('Delete this site and all its history?')) return;
  await api(`/sites/${currentSiteId}`, { method: 'DELETE' });
  closeDetail();
});

document.getElementById('editSiteBtn').addEventListener('click', () => {
  openSiteModal(window._currentSite);
});

// --- Add / edit site modal ---
const modalBackdrop = document.getElementById('siteModalBackdrop');
const siteForm = document.getElementById('siteForm');
const siteFormErr = document.getElementById('siteFormErr');

function openSiteModal(site) {
  siteForm.reset();
  siteFormErr.textContent = '';
  document.getElementById('modalTitle').textContent = site ? 'Edit site' : 'Add site';
  siteForm.id.value = site ? site.id : '';
  if (site) {
    siteForm.name.value = site.name;
    siteForm.url.value = site.url;
    siteForm.method.value = site.method;
    siteForm.interval_minutes.value = Math.round(site.interval_seconds / 60);
    siteForm.keyword.value = site.keyword || '';
  }
  modalBackdrop.classList.remove('hidden');
}

document.getElementById('addSiteBtn').addEventListener('click', () => openSiteModal(null));
document.getElementById('cancelSiteBtn').addEventListener('click', () => modalBackdrop.classList.add('hidden'));

siteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  siteFormErr.textContent = '';
  const id = siteForm.id.value;
  const payload = {
    name: siteForm.name.value.trim(),
    url: siteForm.url.value.trim(),
    method: siteForm.method.value,
    interval_seconds: parseInt(siteForm.interval_minutes.value, 10) * 60,
    keyword: siteForm.keyword.value.trim() || null,
  };
  try {
    if (id) {
      await api(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/sites', { method: 'POST', body: JSON.stringify(payload) });
    }
    modalBackdrop.classList.add('hidden');
    if (currentSiteId) await refreshDetail();
    else await loadSites();
  } catch (err) {
    siteFormErr.textContent = err.message;
  }
});

// --- Bulk add sites modal ---
const bulkModalBackdrop = document.getElementById('bulkModalBackdrop');
const bulkForm = document.getElementById('bulkForm');
const bulkFormErr = document.getElementById('bulkFormErr');

document.getElementById('bulkAddBtn').addEventListener('click', () => {
  bulkForm.reset();
  bulkFormErr.textContent = '';
  bulkModalBackdrop.classList.remove('hidden');
});
document.getElementById('cancelBulkBtn').addEventListener('click', () => bulkModalBackdrop.classList.add('hidden'));

bulkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  bulkFormErr.textContent = '';
  const payload = {
    text: bulkForm.text.value,
    interval_seconds: parseInt(bulkForm.interval_minutes.value, 10) * 60,
    keyword: bulkForm.keyword.value.trim() || null,
  };
  try {
    const result = await api('/sites/bulk', { method: 'POST', body: JSON.stringify(payload) });
    bulkModalBackdrop.classList.add('hidden');
    await loadSites();
    toast(`Added ${result.created.length} site(s)`, 'success');
    if (result.errors.length) result.errors.forEach((e) => toast(e, 'error'));
  } catch (err) {
    bulkFormErr.textContent = err.message;
  }
});

document.getElementById('testEmailBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    await api('/test-email', { method: 'POST' });
    btn.textContent = 'Sent! Check your inbox';
  } catch (err) {
    btn.textContent = 'Failed: ' + err.message;
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Send test email';
    }, 3000);
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login.html';
});

// Poll for updates
loadSites();
pollTimer = setInterval(() => {
  if (currentSiteId) refreshDetail();
  else loadSites();
}, 15000);
