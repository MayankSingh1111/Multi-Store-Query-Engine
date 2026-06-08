// =============================================================
// Store Registry
// =============================================================

let stores = [];
let editingCode = null;       // code being edited, null = adding new

async function loadStores() {
  stores = await API.get('/api/stores');
  renderStores();
}

function renderStores() {
  const search = document.getElementById('searchStores').value.trim().toLowerCase();
  const enabledFilter = document.getElementById('filterEnabled').value;
  const tbody = document.getElementById('storesBody');

  const filtered = stores.filter((s) => {
    if (enabledFilter !== '' && String(s.enabled) !== enabledFilter) return false;
    if (!search) return true;
    return [s.store_code, s.ip, s.label, s.database].some(
      (v) => v && String(v).toLowerCase().includes(search)
    );
  });

  document.getElementById('storeCount').textContent = `${filtered.length} of ${stores.length} stores`;

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr><td colspan="8" style="text-align:center; padding:40px; color:var(--fg-3);">
        ${stores.length ? 'No stores match your filter.' : 'No stores yet — click + ADD STORE.'}
      </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((s, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong style="color:var(--accent);">${escapeHtml(s.store_code)}</strong></td>
      <td>${escapeHtml(s.label || '')}</td>
      <td>${escapeHtml(s.ip)}</td>
      <td>${s.port}</td>
      <td>${escapeHtml(s.database || `(${s.store_code})`)}</td>
      <td>${s.enabled
        ? '<span class="pill pill-ok">enabled</span>'
        : '<span class="pill pill-off">disabled</span>'}</td>
      <td>
        <button class="icon-btn" data-act="ping" data-code="${escapeHtml(s.store_code)}" title="Ping">⚡</button>
        <button class="icon-btn" data-act="edit" data-code="${escapeHtml(s.store_code)}" title="Edit">✎</button>
        <button class="icon-btn" data-act="toggle" data-code="${escapeHtml(s.store_code)}" title="${s.enabled ? 'Disable' : 'Enable'}">${s.enabled ? '◐' : '○'}</button>
        <button class="icon-btn danger" data-act="del" data-code="${escapeHtml(s.store_code)}" title="Delete">×</button>
      </td>
    </tr>
  `).join('');
}

// row actions
document.getElementById('storesBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const code = btn.dataset.code;
  const act = btn.dataset.act;
  const store = stores.find((x) => x.store_code === code);
  if (!store) return;

  if (act === 'edit') openStoreModal(store);
  else if (act === 'del') {
    if (!confirm(`Delete store "${code}"?`)) return;
    try {
      await API.del(`/api/stores/${encodeURIComponent(code)}`);
      toast(`Store ${code} deleted`, 'success');
      loadStores();
    } catch (err) { toast(err.message, 'error'); }
  } else if (act === 'toggle') {
    try {
      await API.patch(`/api/stores/${encodeURIComponent(code)}`, { enabled: !store.enabled });
      loadStores();
    } catch (err) { toast(err.message, 'error'); }
  } else if (act === 'ping') {
    btn.textContent = '⟳';
    try {
      const r = await API.post('/api/health', [code]);
      const result = r.results[0];
      if (result && result.ok) toast(`${code} OK (${result.duration_ms}ms)`, 'success');
      else toast(`${code}: ${result?.error || 'unreachable'}`, 'error');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.textContent = '⚡'; }
  }
});

// add/edit modal
function openStoreModal(store = null) {
  editingCode = store ? store.store_code : null;
  document.getElementById('storeModalTitle').textContent = store ? 'Edit Store' : 'Add Store';
  document.getElementById('fStoreCode').value = store?.store_code || '';
  document.getElementById('fStoreCode').readOnly = !!store;
  document.getElementById('fLabel').value = store?.label || '';
  document.getElementById('fIp').value = store?.ip || '';
  document.getElementById('fPort').value = store?.port || 1433;
  document.getElementById('fDatabase').value = store?.database || '';
  document.getElementById('fEnabled').checked = store ? !!store.enabled : true;
  openModal('storeModal');
  document.getElementById(store ? 'fIp' : 'fStoreCode').focus();
}

document.getElementById('addStoreBtn').addEventListener('click', () => openStoreModal(null));

document.getElementById('saveStoreBtn').addEventListener('click', async () => {
  const body = {
    store_code: document.getElementById('fStoreCode').value.trim(),
    ip:         document.getElementById('fIp').value.trim(),
    port:       parseInt(document.getElementById('fPort').value, 10) || 1433,
    database:   document.getElementById('fDatabase').value.trim() || null,
    label:      document.getElementById('fLabel').value.trim() || null,
    enabled:    document.getElementById('fEnabled').checked,
  };
  if (!body.store_code || !body.ip) {
    toast('Store code and IP are required', 'error');
    return;
  }

  if (editingCode) {
    // PATCH — editing existing row, no duplicate-check needed
    try {
      const { store_code, ...rest } = body;
      await API.patch(`/api/stores/${encodeURIComponent(editingCode)}`, rest);
      toast(`Store ${editingCode} updated`, 'success');
      closeModal('storeModal');
      loadStores();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  // ADD path — call with default on_duplicate=error so duplicates raise 409
  await tryAddStore(body, 'error');
});

async function tryAddStore(body, onDuplicate) {
  try {
    const res = await fetch(`/api/stores?on_duplicate=${encodeURIComponent(onDuplicate)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const data = await res.json();
      const detail = data.detail || {};
      if (detail.error === 'duplicate_store') {
        showDuplicateModal(detail.existing, detail.incoming);
        return;
      }
      throw new Error(detail.message || 'Duplicate store');
    }
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const verb = data.action === 'updated' ? 'updated' : 'added';
    toast(`Store ${body.store_code} ${verb}`, 'success');
    closeModal('storeModal');
    closeModal('dupModal');
    loadStores();
  } catch (err) { toast(err.message, 'error'); }
}

function showDuplicateModal(existing, incoming) {
  // Render side-by-side comparison
  const rows = [
    ['IP',       existing.ip,       incoming.ip],
    ['Port',     existing.port,     incoming.port],
    ['Database', existing.database || `(${existing.store_code})`,
                 incoming.database || `(${incoming.store_code})`],
    ['Label',    existing.label || '—', incoming.label || '—'],
    ['Enabled',  existing.enabled ? 'yes' : 'no',
                 incoming.enabled ? 'yes' : 'no'],
  ];
  const cmpHtml = `
    <table class="dup-compare">
      <thead><tr><th></th><th>Existing</th><th>New value</th></tr></thead>
      <tbody>
        ${rows.map(([k, ev, nv]) => `
          <tr>
            <td class="dup-key">${escapeHtml(k)}</td>
            <td>${escapeHtml(String(ev ?? ''))}</td>
            <td class="${String(ev ?? '') !== String(nv ?? '') ? 'dup-diff' : ''}">${escapeHtml(String(nv ?? ''))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  document.getElementById('dupCode').textContent = existing.store_code;
  document.getElementById('dupCompare').innerHTML = cmpHtml;
  // Store pending incoming for the action buttons to read
  window._pendingIncoming = incoming;
  openModal('dupModal');
}

// Duplicate-modal action buttons (wired once)
document.getElementById('dupUpdateBtn').addEventListener('click', async () => {
  const incoming = window._pendingIncoming;
  if (!incoming) return;
  await tryAddStore(incoming, 'update');
});
document.getElementById('dupKeepBtn').addEventListener('click', () => {
  closeModal('dupModal');
  closeModal('storeModal');
  toast('Kept existing store', 'info');
});
document.getElementById('dupCancelBtn').addEventListener('click', () => {
  closeModal('dupModal');
});
document.getElementById('dupCancelBtn2').addEventListener('click', () => {
  closeModal('dupModal');
});

// search/filter
document.getElementById('searchStores').addEventListener('input', renderStores);
document.getElementById('filterEnabled').addEventListener('change', renderStores);

// bulk import
document.getElementById('bulkImportBtn').addEventListener('click', () => openModal('bulkModal'));
document.getElementById('bulkImportRun').addEventListener('click', async () => {
  const txt = document.getElementById('bulkInput').value.trim();
  if (!txt) { toast('Paste CSV first', 'error'); return; }

  const items = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((p) => p.trim());
    const [code, ip, port, db, label] = parts;
    if (!code || !ip) continue;
    items.push({
      store_code: code,
      ip,
      port: parseInt(port || '1433', 10) || 1433,
      database: db || null,
      label: label || null,
      enabled: true,
    });
  }
  if (!items.length) { toast('No valid rows', 'error'); return; }

  // Honor the "update existing on conflict" toggle (default = skip)
  const updateExisting = document.getElementById('bulkUpdateExisting')?.checked;
  const on_duplicate = updateExisting ? 'update' : 'skip';

  try {
    const r = await API.post('/api/stores/bulk', { stores: items, on_duplicate });
    const parts2 = [];
    if (r.added)   parts2.push(`added ${r.added}`);
    if (r.updated) parts2.push(`updated ${r.updated}`);
    if (r.skipped) parts2.push(`skipped ${r.skipped} duplicate${r.skipped > 1 ? 's' : ''}`);
    toast(parts2.join(', ') || 'No changes', 'success');
    closeModal('bulkModal');
    document.getElementById('bulkInput').value = '';
    loadStores();
  } catch (err) { toast(err.message, 'error'); }
});

loadStores();
