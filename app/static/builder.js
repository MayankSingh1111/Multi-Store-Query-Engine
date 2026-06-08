// =============================================================
// Report Builder — drag-and-drop SQL generator
// =============================================================

const builder = {
  table: null,
  columns: [],     // schema columns of selected table [{COLUMN_NAME, DATA_TYPE}]
  select: [],      // [{name, alias, agg}]
  filter: [],      // [{column, op, value, value2}]
  group:  [],      // [name]
  order:  [],      // [{column, dir}]
  limit:  null,
};

// ---- helpers ----
function qIdent(n) {
  return '[' + String(n).replace(/[^A-Za-z0-9._ ]/g, '').split('.').map(s => s.trim()).join('].[') + ']';
}

function previewSql() {
  // Mirror server logic on the client so the user sees live SQL
  if (!builder.table || !builder.select.length) return '-- drag columns to begin --';
  const parts = ['SELECT'];
  if (builder.limit) parts.push(`TOP ${parseInt(builder.limit, 10)}`);

  const cols = builder.select.map((c) => {
    let expr = qIdent(c.name);
    if (c.agg) {
      expr = c.agg === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${expr})` : `${c.agg}(${expr})`;
    }
    if (c.alias) expr += ` AS ${qIdent(c.alias)}`;
    return expr;
  });
  parts.push(cols.join(', '));
  parts.push('FROM ' + qIdent(builder.table));

  if (builder.filter.length) {
    const ws = builder.filter.map((f) => {
      const col = qIdent(f.column);
      const op = (f.op || '=').toUpperCase();
      if (op === 'IS NULL' || op === 'IS NOT NULL') return `${col} ${op}`;
      if (op === 'IN') {
        const list = String(f.value || '').split(',').map(s => s.trim()).filter(Boolean)
          .map(v => isNaN(v) ? `'${v.replace(/'/g, "''")}'` : v).join(', ');
        return `${col} IN (${list})`;
      }
      if (op === 'BETWEEN') {
        const a = isNaN(f.value) ? `'${(f.value || '').replace(/'/g, "''")}'` : f.value;
        const b = isNaN(f.value2) ? `'${(f.value2 || '').replace(/'/g, "''")}'` : f.value2;
        return `${col} BETWEEN ${a} AND ${b}`;
      }
      const v = isNaN(f.value) || f.value === '' ? `'${(f.value || '').replace(/'/g, "''")}'` : f.value;
      return `${col} ${op} ${v}`;
    });
    parts.push('WHERE ' + ws.join(' AND '));
  }
  if (builder.group.length) parts.push('GROUP BY ' + builder.group.map(qIdent).join(', '));
  if (builder.order.length) {
    parts.push('ORDER BY ' + builder.order.map((o) => `${qIdent(o.column)} ${o.dir}`).join(', '));
  }
  return parts.join('\n');
}

function updateSqlPreview() {
  document.getElementById('sqlPreview').textContent = previewSql();
}

// ---- tables list ----
async function loadTables() {
  const sel = document.getElementById('schemaStore').value;
  const list = document.getElementById('tablesList');
  list.innerHTML = '<div class="empty-mini">Loading...</div>';
  try {
    const url = sel ? `/api/schema/tables?store_code=${encodeURIComponent(sel)}` : '/api/schema/tables';
    const r = await API.get(url);
    renderTables(r.tables);
    toast(`Loaded ${r.tables.length} tables from ${r.store_code}`, 'success');
  } catch (err) {
    list.innerHTML = `<div class="empty-mini danger-text">${escapeHtml(err.message)}</div>`;
  }
}

function renderTables(tables) {
  const filter = document.getElementById('tableFilter').value.trim().toLowerCase();
  const list = document.getElementById('tablesList');
  const filtered = tables.filter((t) => {
    const full = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`.toLowerCase();
    return !filter || full.includes(filter);
  });
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-mini">No tables match</div>';
    return;
  }
  list.innerHTML = filtered.map((t) => {
    const full = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
    return `<div class="table-item" data-table="${escapeHtml(full)}">▤ ${escapeHtml(full)}</div>`;
  }).join('');
  list._tables = tables;     // stash for re-filter
}

document.getElementById('tableFilter').addEventListener('input', () => {
  const tbl = document.getElementById('tablesList')._tables;
  if (tbl) renderTables(tbl);
});

document.getElementById('refreshSchema').addEventListener('click', loadTables);

// pick table
document.getElementById('tablesList').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-table]');
  if (!item) return;
  document.querySelectorAll('.table-item').forEach((x) => x.classList.remove('selected'));
  item.classList.add('selected');
  const tbl = item.dataset.table;
  builder.table = tbl;
  document.getElementById('currentTable').textContent = tbl;
  await loadColumns(tbl);
  // clear zones when switching tables
  builder.select = []; builder.filter = []; builder.group = []; builder.order = [];
  renderZones();
});

async function loadColumns(table) {
  const list = document.getElementById('columnsList');
  list.innerHTML = '<div class="empty-mini">Loading...</div>';
  try {
    const sel = document.getElementById('schemaStore').value;
    const url = `/api/schema/columns?table=${encodeURIComponent(table)}${sel ? `&store_code=${encodeURIComponent(sel)}` : ''}`;
    const r = await API.get(url);
    builder.columns = r.columns;
    document.getElementById('columnsHead').textContent = `Columns (${r.columns.length})`;
    list.innerHTML = r.columns.map((c) => `
      <div class="col-item" draggable="true"
           data-col="${escapeHtml(c.COLUMN_NAME)}"
           data-type="${escapeHtml(c.DATA_TYPE)}">
        ⋮⋮ ${escapeHtml(c.COLUMN_NAME)}
        <span class="col-type">${escapeHtml(c.DATA_TYPE)}</span>
      </div>
    `).join('');
    bindColumnDrag();
  } catch (err) {
    list.innerHTML = `<div class="empty-mini danger-text">${escapeHtml(err.message)}</div>`;
  }
}

// ---- drag and drop ----
function bindColumnDrag() {
  document.querySelectorAll('.col-item').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        col: el.dataset.col,
        type: el.dataset.type,
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

document.querySelectorAll('.drop-zone').forEach((zone) => {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (!payload?.col) return;
    addToZone(zone.dataset.zone, payload);
  });
});

function addToZone(zone, payload) {
  if (zone === 'select') {
    builder.select.push({ name: payload.col, alias: null, agg: null });
  } else if (zone === 'filter') {
    builder.filter.push({ column: payload.col, op: '=', value: '', value2: '' });
  } else if (zone === 'group') {
    if (!builder.group.includes(payload.col)) builder.group.push(payload.col);
  } else if (zone === 'order') {
    builder.order.push({ column: payload.col, dir: 'ASC' });
  }
  renderZones();
}

function renderZones() {
  // SELECT
  const sel = document.getElementById('zone-select');
  sel.innerHTML = builder.select.length
    ? builder.select.map((c, i) => `
      <div class="zone-item">
        <span class="col-name">${escapeHtml(c.name)}</span>
        <select data-i="${i}" data-k="agg">
          <option value="">no agg</option>
          ${['SUM','COUNT','AVG','MIN','MAX','COUNT_DISTINCT'].map(a =>
            `<option ${c.agg === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
        <input data-i="${i}" data-k="alias" placeholder="alias" value="${escapeHtml(c.alias || '')}" style="width: 90px;" />
        <button class="x-btn" data-z="select" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="zone-empty">drag columns here</div>';

  // FILTER
  const fil = document.getElementById('zone-filter');
  fil.innerHTML = builder.filter.length
    ? builder.filter.map((f, i) => {
        const needs2 = f.op === 'BETWEEN';
        const needsNone = f.op === 'IS NULL' || f.op === 'IS NOT NULL';
        return `
          <div class="zone-item">
            <span class="col-name">${escapeHtml(f.column)}</span>
            <select data-i="${i}" data-zf="op">
              ${['=','<>','>','<','>=','<=','LIKE','IN','BETWEEN','IS NULL','IS NOT NULL'].map(o =>
                `<option ${f.op === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
            ${needsNone ? '' : `<input data-i="${i}" data-zf="value" placeholder="value" value="${escapeHtml(f.value || '')}" style="width:110px;" />`}
            ${needs2 ? `<input data-i="${i}" data-zf="value2" placeholder="and value" value="${escapeHtml(f.value2 || '')}" style="width:110px;" />` : ''}
            <button class="x-btn" data-z="filter" data-i="${i}">×</button>
          </div>`;
      }).join('')
    : '<div class="zone-empty">drag columns here</div>';

  // GROUP
  const grp = document.getElementById('zone-group');
  grp.innerHTML = builder.group.length
    ? builder.group.map((c, i) => `
      <div class="zone-item">
        <span class="col-name">${escapeHtml(c)}</span>
        <button class="x-btn" data-z="group" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="zone-empty">drag columns here</div>';

  // ORDER
  const ord = document.getElementById('zone-order');
  ord.innerHTML = builder.order.length
    ? builder.order.map((o, i) => `
      <div class="zone-item">
        <span class="col-name">${escapeHtml(o.column)}</span>
        <button class="x-btn" data-z="orderdir" data-i="${i}" title="toggle direction">${o.dir === 'ASC' ? '↑' : '↓'}</button>
        <button class="x-btn" data-z="order" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="zone-empty">drag columns here</div>';

  updateSqlPreview();
}

// zone-item interactions (event delegation on the parent .drop-grid)
document.querySelector('.drop-grid').addEventListener('click', (e) => {
  const x = e.target.closest('[data-z]');
  if (!x) return;
  const i = parseInt(x.dataset.i, 10);
  const z = x.dataset.z;
  if (z === 'select') builder.select.splice(i, 1);
  else if (z === 'filter') builder.filter.splice(i, 1);
  else if (z === 'group') builder.group.splice(i, 1);
  else if (z === 'order') builder.order.splice(i, 1);
  else if (z === 'orderdir') {
    builder.order[i].dir = builder.order[i].dir === 'ASC' ? 'DESC' : 'ASC';
  }
  renderZones();
});

document.querySelector('.drop-grid').addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-k]')) {
    const i = parseInt(el.dataset.i, 10);
    const k = el.dataset.k;
    builder.select[i][k] = el.value || null;
  } else if (el.matches('[data-zf]')) {
    const i = parseInt(el.dataset.i, 10);
    const k = el.dataset.zf;
    builder.filter[i][k] = el.value;
    if (k === 'op') renderZones();   // re-render to add/remove BETWEEN second box
  }
  updateSqlPreview();
});

document.querySelector('.drop-grid').addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('[data-zf]') || (el.matches('[data-k]') && el.tagName === 'INPUT')) {
    const i = parseInt(el.dataset.i, 10);
    if (el.dataset.k) builder.select[i][el.dataset.k] = el.value || null;
    if (el.dataset.zf) builder.filter[i][el.dataset.zf] = el.value;
    updateSqlPreview();
  }
});

document.getElementById('limitInput').addEventListener('input', (e) => {
  builder.limit = e.target.value ? parseInt(e.target.value, 10) : null;
  updateSqlPreview();
});

document.getElementById('copySqlBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('sqlPreview').textContent);
  toast('SQL copied', 'success');
});

// ---- run report ----
document.getElementById('runReportBtn').addEventListener('click', async () => {
  if (!builder.table) { toast('Select a table first', 'error'); return; }
  if (!builder.select.length) { toast('Add at least one SELECT column', 'error'); return; }

  const cfg = {
    table: builder.table,
    columns: builder.select.map((c) => ({
      name: c.name, alias: c.alias || null, agg: c.agg || null,
    })),
    filters: builder.filter.map((f) => {
      const op = f.op.toUpperCase();
      let value = f.value;
      // IN: split CSV
      if (op === 'IN' && typeof value === 'string') {
        value = value.split(',').map((s) => s.trim()).filter(Boolean);
      }
      return { column: f.column, op, value, value2: f.value2 };
    }),
    group_by: builder.group,
    order_by: builder.order,
    limit: builder.limit,
  };

  const box = document.getElementById('reportResult');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty-state"><div class="empty-icon">⟳</div><div class="empty-title">Running across all stores...</div></div>';

  try {
    const r = await API.post('/api/report/run', cfg);
    renderReport(r);
  } catch (err) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon" style="color:var(--bad)">!</div><div class="empty-title">Report failed</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
  }
});

function renderReport(r) {
  const box = document.getElementById('reportResult');
  const s = r.summary;
  const rows = r.unified.rows.slice(0, 5000);
  const cols = r.unified.columns;

  let h = `
    <div style="padding:14px; border-bottom:1px solid var(--line); background:var(--bg-2);">
      <strong style="color:var(--accent);">${s.succeeded}/${s.total}</strong> stores returned
      <strong>${fmtNum(s.total_rows)}</strong> rows in ${s.duration_ms}ms
      ${s.failed ? `<span class="pill pill-bad" style="margin-left:10px;">${s.failed} failed</span>` : ''}
    </div>
  `;
  if (!rows.length) {
    h += '<div class="empty-state"><div class="empty-icon">○</div><div class="empty-title">No rows returned</div></div>';
  } else {
    h += '<table class="data-table"><thead><tr>';
    cols.forEach((c) => { h += `<th>${escapeHtml(c)}</th>`; });
    h += '</tr></thead><tbody>';
    for (const row of rows) {
      h += '<tr>';
      for (const c of cols) {
        let v = row[c];
        if (v == null) v = '<span style="color:var(--fg-3);">NULL</span>';
        else if (c === '_store') v = `<span class="row-store-tag">${escapeHtml(v)}</span>`;
        else v = escapeHtml(v);
        h += `<td>${v}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    if (r.unified.rows.length > 5000) {
      h += `<div style="padding:10px; text-align:center; color:var(--fg-3); font-size:12px;">First 5,000 of ${fmtNum(r.unified.rows.length)} rows shown.</div>`;
    }
  }
  box.innerHTML = h;
}

// ---- saved reports ----
document.getElementById('saveReportBtn').addEventListener('click', () => {
  if (!builder.table || !builder.select.length) {
    toast('Build a report first', 'error');
    return;
  }
  openModal('saveModal');
  document.getElementById('saveName').focus();
});

document.getElementById('saveReportConfirm').addEventListener('click', async () => {
  const name = document.getElementById('saveName').value.trim();
  if (!name) { toast('Name required', 'error'); return; }
  const cfg = {
    table: builder.table,
    columns: builder.select,
    filters: builder.filter,
    group_by: builder.group,
    order_by: builder.order,
    limit: builder.limit,
  };
  try {
    await API.post('/api/reports', { name, config: cfg });
    toast('Report saved', 'success');
    closeModal('saveModal');
    loadSavedReports();
  } catch (err) { toast(err.message, 'error'); }
});

async function loadSavedReports() {
  const list = document.getElementById('savedReports');
  try {
    const reports = await API.get('/api/reports');
    if (!reports.length) {
      list.innerHTML = '<div class="empty-mini">No saved reports yet</div>';
      return;
    }
    list.innerHTML = reports.map((r) => `
      <div class="saved-item" data-id="${r.id}">
        <span>${escapeHtml(r.name)}</span>
        <button class="saved-del" data-del="${r.id}" title="Delete">×</button>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty-mini">Failed to load</div>';
  }
}

document.getElementById('savedReports').addEventListener('click', async (e) => {
  if (e.target.matches('[data-del]')) {
    e.stopPropagation();
    if (!confirm('Delete this report?')) return;
    await API.del(`/api/reports/${e.target.dataset.del}`);
    loadSavedReports();
    return;
  }
  const item = e.target.closest('[data-id]');
  if (!item) return;
  const r = await API.get(`/api/reports/${item.dataset.id}`);
  builder.table = r.config.table;
  builder.select = r.config.columns || [];
  builder.filter = r.config.filters || [];
  builder.group = r.config.group_by || [];
  builder.order = r.config.order_by || [];
  builder.limit = r.config.limit || null;
  document.getElementById('currentTable').textContent = builder.table;
  document.getElementById('limitInput').value = builder.limit || '';
  await loadColumns(builder.table);
  renderZones();
  toast(`Loaded report "${r.name}"`, 'success');
});

// load store picker options
async function loadStorePicker() {
  try {
    const stores = await API.get('/api/stores');
    const sel = document.getElementById('schemaStore');
    sel.innerHTML = '<option value="">Any responding store</option>' +
      stores.filter((s) => s.enabled).map((s) => `<option value="${escapeHtml(s.store_code)}">${escapeHtml(s.store_code)}</option>`).join('');
  } catch (err) { /* silent */ }
}

loadStorePicker();
loadSavedReports();
