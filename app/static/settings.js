// =============================================================
// Settings page
// =============================================================

async function loadSettings() {
  const s = await API.get('/api/settings');
  document.getElementById('sUsername').value = s.username || '';
  document.getElementById('sDriver').value = s.driver || '';
  document.getElementById('pwdHint').textContent = s.password_set
    ? 'A password is already set. Type a new value to replace it.'
    : 'No password set yet.';
  document.getElementById('rMax').textContent = s.max_concurrency;
  document.getElementById('rCT').textContent  = `${s.connect_timeout}s`;
  document.getElementById('rQT').textContent  = `${s.query_timeout}s`;
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  const body = {
    username: document.getElementById('sUsername').value.trim(),
    driver:   document.getElementById('sDriver').value.trim(),
  };
  const pwd = document.getElementById('sPassword').value;
  if (pwd) body.password = pwd;

  try {
    await API.post('/api/settings', body);
    toast('Settings saved', 'success');
    document.getElementById('sPassword').value = '';
    loadSettings();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('testOne').addEventListener('click', async () => {
  try {
    const stores = await API.get('/api/stores');
    const first = stores.find((s) => s.enabled);
    if (!first) { toast('No enabled stores to test', 'error'); return; }
    toast(`Pinging ${first.store_code}...`);
    const r = await API.post('/api/health', [first.store_code]);
    const res = r.results[0];
    if (res?.ok) toast(`${first.store_code} OK (${res.duration_ms}ms)`, 'success');
    else toast(`${first.store_code}: ${res?.error || 'failed'}`, 'error');
  } catch (err) { toast(err.message, 'error'); }
});

async function loadHistory() {
  try {
    const rows = await API.get('/api/history?limit=30');
    const box = document.getElementById('historyBox');
    if (!rows.length) {
      box.innerHTML = '<div class="empty-mini">No queries run yet</div>';
      return;
    }
    box.innerHTML = rows.map((r) => `
      <div class="history-row" title="${escapeHtml(r.sql)}">
        <span style="color:var(--fg-3);">${escapeHtml(r.executed_at)}</span>
        <span style="color:var(--ok);">${r.succeeded}/${r.total}</span>
        <span style="color:var(--fg-2);">${r.duration_ms}ms</span>
        <span style="color:${r.failed ? 'var(--bad)' : 'var(--fg-3)'};">${r.failed} fail</span>
        <span class="h-sql">${escapeHtml(r.sql.slice(0, 200))}</span>
      </div>
    `).join('');
  } catch { /* silent */ }
}

loadSettings();
loadHistory();
