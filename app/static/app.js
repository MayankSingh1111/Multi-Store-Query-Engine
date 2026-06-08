// =============================================================
// Multi-Store SQL — shared client utilities
// =============================================================

const API = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  },
  async post(url, body) {
    const opts = { method: 'POST' };
    if (body !== null && body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  },
  async patch(url, body) {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  },
};

function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'error' ? 'bad' : type === 'success' ? 'ok' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtNum(n) {
  return new Intl.NumberFormat().format(n);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Modal helpers
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.classList.contains('modal-close')) {
    const modal = e.target.closest('.modal');
    if (modal) modal.classList.add('hidden');
  }
  if (e.target.classList.contains('modal')) {
    e.target.classList.add('hidden');
  }
});

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ----- sidebar: ping all -----
async function pingAllStores() {
  const status = document.getElementById('connStatus');
  const statusText = document.getElementById('connStatusText');
  const btn = document.getElementById('pingAllBtn');

  status.className = 'conn-status warn';
  statusText.textContent = 'Pinging stores...';
  btn.disabled = true;

  try {
    const r = await API.post('/api/health', null);
    if (r.disconnected === 0) {
      status.className = 'conn-status';
      statusText.textContent = `All ${r.total} stores OK`;
    } else if (r.connected === 0) {
      status.className = 'conn-status bad';
      statusText.textContent = `0/${r.total} stores reachable`;
    } else {
      status.className = 'conn-status warn';
      statusText.textContent = `${r.connected}/${r.total} stores up`;
    }
    toast(`${r.connected}/${r.total} stores connected (${fmtMs(r.duration_ms)})`,
          r.disconnected ? 'info' : 'success');
    // expose for other pages
    window.__lastHealth = r;
  } catch (err) {
    status.className = 'conn-status bad';
    statusText.textContent = 'Health check failed';
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('pingAllBtn');
  if (btn) btn.addEventListener('click', pingAllStores);
});
