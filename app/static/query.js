// =============================================================
// Query Console
// =============================================================

const editor = document.getElementById('sqlEditor');
const runBtn = document.getElementById('runBtn');
const csvBtn = document.getElementById('csvBtn');
const resultBox = document.getElementById('resultBox');
const summary = document.getElementById('resultSummary');

let lastResult = null;
let currentView = 'unified';

// snippets
document.querySelectorAll('.chip[data-snippet]').forEach((c) => {
  c.addEventListener('click', () => {
    editor.value = c.dataset.snippet;
    editor.focus();
  });
});

// keyboard shortcut: Cmd/Ctrl + Enter
editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runQuery();
  }
});

async function runQuery(storeCodes = null) {
  const sql = editor.value.trim();
  if (!sql) { toast('Enter a SQL statement', 'error'); return; }

  runBtn.disabled = true;
  const original = runBtn.innerHTML;
  runBtn.innerHTML = '⟳ RUNNING...';
  resultBox.innerHTML = '<div class="empty-state"><div class="empty-icon">⟳</div><div class="empty-title">Fanning out across stores...</div><div class="empty-sub">queries are running in parallel</div></div>';

  try {
    const r = await API.post('/api/query', {
      sql,
      store_codes: storeCodes,
    });
    lastResult = r;
    renderSummary(r.summary);
    renderResult(currentView);
  } catch (err) {
    resultBox.innerHTML = `<div class="empty-state"><div class="empty-icon" style="color:var(--bad)">!</div><div class="empty-title">Query failed</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    toast(err.message, 'error');
  } finally {
    runBtn.disabled = false;
    runBtn.innerHTML = original;
  }
}

function renderSummary(s) {
  summary.classList.remove('hidden');
  document.getElementById('mTotal').textContent = s.total;
  document.getElementById('mOk').textContent = s.succeeded;
  document.getElementById('mFail').textContent = s.failed;
  document.getElementById('mRows').textContent = fmtNum(s.total_rows);
  document.getElementById('mTime').innerHTML = `${s.duration_ms}<span class="metric-unit">ms</span>`;

  const ratio = s.total ? (s.succeeded / s.total) * 100 : 0;
  document.getElementById('ratioFill').style.width = `${ratio}%`;
  let txt = `${s.succeeded} / ${s.total} stores (${ratio.toFixed(1)}%)`;
  if (s.preview_capped) {
    txt += `  •  preview capped at ${fmtNum(s.preview_cap)} rows — use ⬇ Excel / CSV for full data`;
  }
  document.getElementById('ratioText').textContent = txt;
}

function renderResult(view) {
  if (!lastResult) return;
  currentView = view;
  document.querySelectorAll('.rtab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === view);
  });

  if (view === 'unified') {
    renderUnified(lastResult.unified);
  } else if (view === 'perstore') {
    renderPerStore(lastResult.per_store);
  } else if (view === 'failed') {
    renderFailedTable(lastResult.failed_list);
  }
}

function renderUnified({ columns, rows }) {
  if (!rows.length) {
    resultBox.innerHTML = '<div class="empty-state"><div class="empty-icon">○</div><div class="empty-title">No rows returned</div><div class="empty-sub">The query succeeded but produced no data</div></div>';
    return;
  }
  resultBox.innerHTML = buildTable(columns, rows, true);
}

function renderPerStore(stores) {
  let html = '<div style="padding:14px;">';
  for (const s of stores) {
    const pill = s.ok ? `<span class="pill pill-ok">${s.rowcount} rows · ${s.duration_ms}ms</span>`
                      : `<span class="pill pill-bad">${escapeHtml(s.error || 'error')}</span>`;
    html += `
      <div style="margin-bottom:14px; border:1px solid var(--line); border-radius:6px; overflow:hidden;">
        <div style="background:var(--bg-2); padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-family:var(--font-mono); color:var(--accent);">${escapeHtml(s.store_code)} <span style="color:var(--fg-3);">@ ${escapeHtml(s.ip)}</span></span>
          ${pill}
        </div>`;
    if (s.ok && s.rows.length) {
      html += buildTable(s.columns, s.rows, false);
    } else if (s.ok) {
      html += '<div style="padding:14px; color:var(--fg-3); font-size:12px;">no rows</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  resultBox.innerHTML = html;
}

function renderFailedTable(failed) {
  if (!failed.length) {
    resultBox.innerHTML = '<div class="empty-state"><div class="empty-icon" style="color:var(--ok)">✓</div><div class="empty-title">All stores succeeded</div></div>';
    return;
  }
  let html = '<div style="padding:14px;">';
  for (const f of failed) {
    html += `
      <div class="failed-row">
        <span class="fr-code">${escapeHtml(f.store_code)}</span>
        <span class="fr-ip">${escapeHtml(f.ip)}</span>
        <span class="fr-err">${escapeHtml(f.error)}</span>
      </div>`;
  }
  html += '</div>';
  resultBox.innerHTML = html;
}

function buildTable(cols, rows, includeStoreTag) {
  let h = '<table class="data-table"><thead><tr>';
  cols.forEach((c) => { h += `<th>${escapeHtml(c)}</th>`; });
  h += '</tr></thead><tbody>';
  // cap render at 5000 rows to keep DOM happy
  const display = rows.slice(0, 5000);
  for (const row of display) {
    h += '<tr>';
    for (const c of cols) {
      let v = row[c];
      let cell = '';
      if (v == null) cell = '<span style="color:var(--fg-3);">NULL</span>';
      else if (c === '_store' && includeStoreTag) cell = `<span class="row-store-tag">${escapeHtml(v)}</span>`;
      else if (typeof v === 'number') cell = `<span class="num">${escapeHtml(v)}</span>`;
      else cell = escapeHtml(v);
      h += `<td>${cell}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  if (rows.length > 5000) {
    h += `<div style="padding:10px; text-align:center; color:var(--fg-3); font-size:12px;">Showing first 5,000 of ${fmtNum(rows.length)} rows — download Excel or CSV for the full result.</div>`;
  }
  return h;
}

// view switcher
document.querySelectorAll('.rtab').forEach((t) => {
  t.addEventListener('click', () => renderResult(t.dataset.view));
});

// failed modal
document.getElementById('showFailed').addEventListener('click', () => {
  if (!lastResult) return;
  const box = document.getElementById('failedList');
  if (!lastResult.failed_list.length) {
    box.innerHTML = '<div style="padding:14px; color:var(--fg-3);">No failed stores.</div>';
  } else {
    box.innerHTML = lastResult.failed_list.map((f) => `
      <div class="failed-row">
        <span class="fr-code">${escapeHtml(f.store_code)}</span>
        <span class="fr-ip">${escapeHtml(f.ip)}</span>
        <span class="fr-err">${escapeHtml(f.error)}</span>
      </div>
    `).join('');
  }
  openModal('failedModal');
});

document.getElementById('retryFailed').addEventListener('click', () => {
  if (!lastResult || !lastResult.failed_list.length) return;
  const codes = lastResult.failed_list.map((f) => f.store_code);
  closeModal('failedModal');
  runQuery(codes);
});

// run + downloads
runBtn.addEventListener('click', () => runQuery());

const xlsxBtn = document.getElementById('xlsxBtn');
const exportProgress = document.getElementById('exportProgress');
const exportLabel    = document.getElementById('exportLabel');
const exportFill     = document.getElementById('exportFill');
const exportPct      = document.getElementById('exportPct');

function setProgress(label, pct, indeterminate = false) {
  if (!exportProgress) return;
  exportProgress.classList.remove('hidden');
  exportProgress.classList.toggle('indeterminate', indeterminate);
  exportLabel.textContent = label;
  if (indeterminate) {
    exportFill.style.width = '100%';
    exportPct.textContent  = '';
  } else {
    exportFill.style.width = `${pct}%`;
    exportPct.textContent  = `${pct}%`;
  }
}
function hideProgress() {
  if (exportProgress) exportProgress.classList.add('hidden');
}

function downloadAs(format) {
  return new Promise((resolve) => {
    const sql = editor.value.trim();
    if (!sql) { toast('Enter a SQL statement', 'error'); resolve(); return; }

    const btn = format === 'csv' ? csvBtn : xlsxBtn;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = format === 'csv' ? 'Exporting...' : 'Exporting...';

    setProgress(
      format === 'csv' ? 'Querying stores and building CSV...' : 'Querying stores and building Excel...',
      0, true,
    );

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/query/${format}`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'blob';

    // Server starts sending bytes once query+build are done. We flip to
    // determinate mode the moment we get the first byte.
    let sawFirstByte = false;
    xhr.onprogress = (e) => {
      if (!sawFirstByte) {
        sawFirstByte = true;
        setProgress('Downloading...', 0, false);
      }
      if (e.lengthComputable) {
        const pct = Math.min(99, Math.floor((e.loaded / e.total) * 100));
        setProgress('Downloading...', pct, false);
      } else {
        // Fallback: show MB transferred when length isn't known
        const mb = (e.loaded / (1024 * 1024)).toFixed(1);
        setProgress(`Downloading... ${mb} MB`, 0, true);
      }
    };

    xhr.onload = () => {
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (xhr.status < 200 || xhr.status >= 300) {
        hideProgress();
        // Try to extract error text from blob response
        xhr.response.text().then((t) => toast(t || `HTTP ${xhr.status}`, 'error'));
        resolve(); return;
      }
      setProgress('Saving file...', 100, false);
      const blob = xhr.response;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `multistore_${Date.now()}.${format}`;
      a.click();

      const totalRows = xhr.getResponseHeader('X-Total-Rows');
      if (totalRows) {
        toast(`Exported ${fmtNum(parseInt(totalRows))} rows`, 'success');
      }
      setTimeout(hideProgress, 600);
      resolve();
    };

    xhr.onerror = () => {
      btn.disabled = false;
      btn.textContent = originalLabel;
      hideProgress();
      toast('Network error during export', 'error');
      resolve();
    };

    xhr.send(JSON.stringify({ sql }));
  });
}

csvBtn.addEventListener('click', () => downloadAs('csv'));
if (xlsxBtn) xlsxBtn.addEventListener('click', () => downloadAs('xlsx'));
