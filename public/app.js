/* ═══════════════════════════════════════════════════════
   LinkRota — Frontend
   ════════════════════════════════════════════════════════ */

let rotators = [];
let currentStatsId = null;
let currentView = localStorage.getItem('lr_view') || 'grid';

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getToken() { return localStorage.getItem('lr_token'); }
function getRole()  { return localStorage.getItem('lr_role'); }
function getEmail() { return localStorage.getItem('lr_email'); }

function requireAuth() {
  if (!getToken()) {
    window.location.replace('/login.html');
    return false;
  }
  return true;
}

async function logout() {
  const token = getToken();
  if (token) {
    try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
  }
  localStorage.removeItem('lr_token');
  localStorage.removeItem('lr_role');
  localStorage.removeItem('lr_email');
  window.location.replace('/login.html');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (!requireAuth()) return;
  applyTheme();
  loadRotators();
  bindEvents();
  if (getRole() === 'admin') {
    document.getElementById('btnTeam').style.display = 'inline-flex';
  }
});

function bindEvents() {
  document.getElementById('btnNewRotator').onclick = openCreateModal;
  document.getElementById('btnNewRotatorEmpty').onclick = openCreateModal;
  document.getElementById('btnCloseModal').onclick = closeModal;
  document.getElementById('btnCancelModal').onclick = closeModal;
  document.getElementById('btnSaveRotator').onclick = saveRotator;
  document.getElementById('btnAddLink').onclick = addLinkRow;
  document.getElementById('btnCloseStats').onclick = closeStatsModal;
  document.getElementById('btnTheme').onclick = toggleTheme;
  document.getElementById('btnLogout').onclick = logout;
  document.getElementById('btnTeam').onclick = openTeamModal;
  document.getElementById('btnCloseTeam').onclick = closeTeamModal;
  document.getElementById('btnAddMember').onclick = addMember;
  document.getElementById('btnViewGrid').onclick = () => setView('grid');
  document.getElementById('btnViewList').onclick = () => setView('list');
  document.getElementById('modalTeam').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTeamModal();
  });

  // Close modal on overlay click
  document.getElementById('modalRotator').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('modalStats').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeStatsModal();
  });

  // Enter to save
  document.getElementById('rotatorName').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveRotator();
  });
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${getToken()}`
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    localStorage.removeItem('lr_token');
    window.location.replace('/login.html');
    return;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error en el servidor');
  return data;
}

// ─── Load & Render ────────────────────────────────────────────────────────────

async function loadRotators() {
  try {
    rotators = await api('GET', '/api/rotators');
    renderAll();
  } catch (e) {
    toast('Error cargando datos', 'error');
  }
}

function renderAll() {
  const grid = document.getElementById('rotatorsGrid');
  const empty = document.getElementById('emptyState');
  const statsBar = document.getElementById('statsBar');

  const viewControls = document.getElementById('viewControls');

  if (rotators.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    statsBar.style.display = 'none';
    viewControls.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  statsBar.style.display = 'flex';
  viewControls.style.display = 'flex';
  document.getElementById('btnViewGrid').classList.toggle('active', currentView === 'grid');
  document.getElementById('btnViewList').classList.toggle('active', currentView === 'list');

  // Global stats
  const totalClicks = rotators.reduce((a, r) => a + (r.totalClicks || 0), 0);
  const totalLinks = rotators.reduce((a, r) => a + (r.links?.length || 0), 0);
  document.getElementById('statTotal').textContent = rotators.length;
  document.getElementById('statClicks').textContent = totalClicks.toLocaleString();
  document.getElementById('statLinks').textContent = totalLinks;

  grid.className = currentView === 'list' ? 'rotators-list' : 'rotators-grid';
  grid.innerHTML = rotators.map(currentView === 'list' ? renderRow : renderCard).join('');

  // Bind card/row buttons
  grid.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', handleCardAction);
  });
}

function renderCard(r) {
  const rotatorUrl = `${window.location.origin}/r/${r.slug}`;
  const linkCount = r.links?.length || 0;
  const createdDate = new Date(r.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });

  const totalWeight = (r.links || []).reduce((sum, l) => sum + (l.weight || 1), 0);
  const linksPreview = (r.links || []).slice(0, 4).map(l => {
    const effectivePct = totalWeight > 0 ? Math.round(((l.weight || 1) / totalWeight) * 100) : 0;
    return `
    <div class="link-preview-item">
      <span class="link-preview-label" title="${escHtml(l.url)}">${escHtml(l.label)}</span>
      <span class="link-preview-pct">${effectivePct}%</span>
      <span class="link-preview-clicks">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 12 9-9 9 9"/><path d="m3 12 9 9 9-9"/></svg>
        ${(l.clicks || 0).toLocaleString()}
      </span>
    </div>
  `;
  }).join('');

  const moreLinks = linkCount > 4 ? `<div class="link-preview-item"><span class="link-preview-label" style="color:var(--text3)">+${linkCount - 4} links más…</span></div>` : '';

  return `
    <div class="rotator-card" data-id="${r.id}">
      <div class="card-header">
        <div>
          <div class="card-title">${escHtml(r.name)}</div>
          <div class="card-meta">${linkCount} link${linkCount !== 1 ? 's' : ''} · Creado ${createdDate}</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-icon" data-action="stats" data-id="${r.id}" title="Estadísticas">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          </button>
          <button class="btn btn-icon" data-action="edit" data-id="${r.id}" title="Editar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-icon btn-danger" data-action="delete" data-id="${r.id}" title="Eliminar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>

      <div class="card-url-row">
        <div class="card-url" title="${rotatorUrl}">${rotatorUrl}</div>
        <button class="btn-copy" data-action="copy" data-url="${rotatorUrl}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copiar
        </button>
      </div>

      <div class="card-links-preview">
        ${linksPreview}${moreLinks}
      </div>

      <div class="card-stats">
        <div class="card-click-count">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <span class="click-badge">${(r.totalClicks || 0).toLocaleString()}</span>
          clicks totales
        </div>
        <button class="btn btn-ghost btn-sm" data-action="stats" data-id="${r.id}">Ver estadísticas →</button>
      </div>
    </div>
  `;
}

function renderRow(r) {
  const rotatorUrl = `${window.location.origin}/r/${r.slug}`;
  const linkCount = r.links?.length || 0;
  const createdDate = new Date(r.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });

  return `
    <div class="rotator-row" data-id="${r.id}">
      <div class="row-name">
        <div class="row-title">${escHtml(r.name)}</div>
        <div class="row-meta">${linkCount} link${linkCount !== 1 ? 's' : ''} · ${createdDate}</div>
      </div>
      <div class="row-url">
        <div class="card-url" title="${rotatorUrl}">${rotatorUrl}</div>
        <button class="btn-copy" data-action="copy" data-url="${rotatorUrl}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copiar
        </button>
      </div>
      <div class="row-clicks">
        <span class="click-badge">${(r.totalClicks || 0).toLocaleString()}</span>
        <span style="font-size:12px;color:var(--text2)">clicks</span>
      </div>
      <div class="row-actions">
        <button class="btn btn-icon" data-action="stats" data-id="${r.id}" title="Estadísticas">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </button>
        <button class="btn btn-icon" data-action="edit" data-id="${r.id}" title="Editar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-icon btn-danger" data-action="delete" data-id="${r.id}" title="Eliminar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>
  `;
}

function handleCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'copy') {
    copyToClipboard(btn.dataset.url, btn);
  } else if (action === 'edit') {
    openEditModal(id);
  } else if (action === 'delete') {
    deleteRotator(id);
  } else if (action === 'stats') {
    openStatsModal(id);
  }
}

// ─── Create / Edit Modal ──────────────────────────────────────────────────────

function openCreateModal() {
  document.getElementById('editingId').value = '';
  document.getElementById('modalTitle').textContent = 'Nuevo Rotador';
  document.getElementById('rotatorName').value = '';
  document.getElementById('linksList').innerHTML = '';
  addLinkRow();
  addLinkRow();
  document.getElementById('modalRotator').classList.add('open');
  setTimeout(() => document.getElementById('rotatorName').focus(), 80);
}

function openEditModal(id) {
  const r = rotators.find(x => x.id === id);
  if (!r) return;

  document.getElementById('editingId').value = id;
  document.getElementById('modalTitle').textContent = 'Editar Rotador';
  document.getElementById('rotatorName').value = r.name;

  const list = document.getElementById('linksList');
  list.innerHTML = '';
  r.links.forEach(l => addLinkRow(l.label, l.url, l.id, l.clicks, l.weight || 1));

  document.getElementById('modalRotator').classList.add('open');
  setTimeout(() => document.getElementById('rotatorName').focus(), 80);
}

function closeModal() {
  document.getElementById('modalRotator').classList.remove('open');
}

function addLinkRow(label = '', url = '', lid = '', clicks = 0, weight = 1) {
  const list = document.getElementById('linksList');
  const row = document.createElement('div');
  row.className = 'link-row';
  row.dataset.lid = lid;
  row.dataset.clicks = clicks;
  row.innerHTML = `
    <input type="text" placeholder="Etiqueta" value="${escHtml(label)}" class="link-label" maxlength="40" />
    <input type="url" placeholder="https://..." value="${escHtml(url)}" class="link-url" />
    <input type="number" min="1" max="9999" value="${weight}" class="link-weight" title="Peso relativo. Ej: 50/30/20 → 50%, 30%, 20%" />
    <button class="btn-remove-link" title="Eliminar link">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  row.querySelector('.btn-remove-link').onclick = () => {
    if (list.children.length > 1) row.remove();
    else toast('Debe haber al menos 1 link', 'error');
  };
  list.appendChild(row);
}

async function saveRotator() {
  const name = document.getElementById('rotatorName').value.trim();
  const editingId = document.getElementById('editingId').value;

  if (!name) { toast('Ingresa un nombre para el rotador', 'error'); return; }

  const rows = document.querySelectorAll('#linksList .link-row');
  const links = [];
  let hasError = false;

  rows.forEach((row, i) => {
    const urlInput = row.querySelector('.link-url');
    const url = urlInput.value.trim();
    const label = row.querySelector('.link-label').value.trim() || `Link ${i + 1}`;

    if (!url) { urlInput.focus(); hasError = true; return; }

    // Auto-add https if missing
    const normalized = url.startsWith('http') ? url : 'https://' + url;

    links.push({
      id: row.dataset.lid || undefined,
      label,
      url: normalized,
      clicks: parseInt(row.dataset.clicks || 0),
      weight: Math.max(1, parseInt(row.querySelector('.link-weight').value) || 1)
    });
  });

  if (hasError) { toast('Completa todos los URLs', 'error'); return; }
  if (links.length === 0) { toast('Agrega al menos 1 link', 'error'); return; }

  const btn = document.getElementById('btnSaveRotator');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    if (editingId) {
      await api('PUT', `/api/rotators/${editingId}`, { name, links });
      toast('Rotador actualizado', 'success');
    } else {
      await api('POST', '/api/rotators', { name, links });
      toast('Rotador creado', 'success');
    }
    closeModal();
    loadRotators();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deleteRotator(id) {
  const r = rotators.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`¿Eliminar el rotador "${r.name}"?\nEsta acción no se puede deshacer.`)) return;

  try {
    await api('DELETE', `/api/rotators/${id}`);
    toast('Rotador eliminado', 'info');
    loadRotators();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Stats Modal ──────────────────────────────────────────────────────────────

async function openStatsModal(id) {
  currentStatsId = id;
  const r = rotators.find(x => x.id === id);
  if (!r) return;

  document.getElementById('statsModalTitle').textContent = `Estadísticas — ${r.name}`;

  const body = document.getElementById('statsBody');
  body.innerHTML = renderStats(r);

  // Bind reset button
  body.querySelector('#btnResetStats')?.addEventListener('click', () => resetStats(id));

  document.getElementById('modalStats').classList.add('open');
}

function renderStats(r) {
  const total = r.totalClicks || 0;
  const linkCount = r.links?.length || 0;
  const rotatorUrl = `${window.location.origin}/r/${r.slug}`;

  const avg = linkCount > 0 ? (total / linkCount).toFixed(1) : '0';

  const totalWeight = (r.links || []).reduce((sum, l) => sum + (l.weight || 1), 0);

  const rows = (r.links || [])
    .map((l, i) => ({ ...l, idx: i }))
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .map(l => {
      const actualPct = total > 0 ? Math.round(((l.clicks || 0) / total) * 100) : 0;
      const configPct = totalWeight > 0 ? Math.round(((l.weight || 1) / totalWeight) * 100) : 0;
      return `
        <tr>
          <td>
            <div style="font-weight:500">${escHtml(l.label)}</div>
            <a href="${escHtml(l.url)}" target="_blank" class="stats-url" title="${escHtml(l.url)}">${escHtml(l.url)}</a>
          </td>
          <td style="color:var(--accent);font-weight:600">${configPct}%</td>
          <td style="font-weight:700;color:var(--text)">${(l.clicks || 0).toLocaleString()}</td>
          <td style="color:var(--text2)">${actualPct}%</td>
          <td>
            <div class="progress-bar-wrap">
              <div class="progress-bar"><div class="progress-bar-fill" style="width:${actualPct}%"></div></div>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  // Recent clicks (last 10)
  const recent = (r.clickHistory || []).slice(-10).reverse().map(c => {
    const d = new Date(c.ts);
    const timeStr = d.toLocaleString('es', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    return `
      <tr>
        <td style="color:var(--text2);font-size:12px">${timeStr}</td>
        <td><a href="${escHtml(c.url)}" target="_blank" class="stats-url">${escHtml(c.url)}</a></td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="2" style="color:var(--text3);text-align:center">Sin clicks aún</td></tr>`;

  return `
    <div class="stats-summary">
      <div class="stats-mini-card">
        <div class="stats-mini-val">${total.toLocaleString()}</div>
        <div class="stats-mini-label">Clicks totales</div>
      </div>
      <div class="stats-mini-card">
        <div class="stats-mini-val">${linkCount}</div>
        <div class="stats-mini-label">Links activos</div>
      </div>
      <div class="stats-mini-card">
        <div class="stats-mini-val">${avg}</div>
        <div class="stats-mini-label">Promedio por link</div>
      </div>
    </div>

    <div class="stats-section-title">URL del rotador</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
      <div class="card-url" style="flex:1;font-size:13px">${rotatorUrl}</div>
      <button class="btn-copy" onclick="copyToClipboard('${rotatorUrl}', this)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar
      </button>
    </div>

    <div class="stats-section-title">Distribución por link</div>
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead>
          <tr>
            <th>Link</th>
            <th>Peso cfg.</th>
            <th>Clicks</th>
            <th>% real</th>
            <th>Distribución</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="stats-section-title">Últimos 10 clicks</div>
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead><tr><th>Fecha/hora</th><th>Destino</th></tr></thead>
        <tbody>${recent}</tbody>
      </table>
    </div>

    <div class="stats-reset-row">
      <button class="btn btn-danger btn-sm" id="btnResetStats">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.09"/></svg>
        Resetear estadísticas
      </button>
    </div>
  `;
}

function closeStatsModal() {
  document.getElementById('modalStats').classList.remove('open');
  currentStatsId = null;
}

async function resetStats(id) {
  if (!confirm('¿Resetear todas las estadísticas de este rotador?')) return;
  try {
    const updated = await api('POST', `/api/rotators/${id}/reset`);
    // Update local cache
    const idx = rotators.findIndex(r => r.id === id);
    if (idx !== -1) rotators[idx] = updated;
    renderAll();
    document.getElementById('statsBody').innerHTML = renderStats(updated);
    document.getElementById('statsBody').querySelector('#btnResetStats')?.addEventListener('click', () => resetStats(id));
    toast('Estadísticas reseteadas', 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Copiado
      `;
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
    }
    toast('Link copiado al portapapeles', 'success');
  }).catch(() => toast('No se pudo copiar', 'error'));
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  const theme = localStorage.getItem('lr_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('iconMoon').style.display = theme === 'dark' ? 'block' : 'none';
  document.getElementById('iconSun').style.display  = theme === 'light' ? 'block' : 'none';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('lr_theme', next);
  applyTheme();
}

function setView(view) {
  currentView = view;
  localStorage.setItem('lr_view', view);
  renderAll();
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  const container = document.getElementById('toastContainer');
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Team Panel ───────────────────────────────────────────────────────────────

async function openTeamModal() {
  document.getElementById('modalTeam').classList.add('open');
  document.getElementById('newUserEmail').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserRole').value = 'member';
  await loadTeamMembers();
}

function closeTeamModal() {
  document.getElementById('modalTeam').classList.remove('open');
}

async function loadTeamMembers() {
  const list = document.getElementById('teamList');
  list.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">Cargando…</div>';
  try {
    const members = await api('GET', '/api/users');
    const myEmail = getEmail();
    list.innerHTML = members.map(m => {
      const initials = m.email.slice(0, 2).toUpperCase();
      const isMe = m.email === myEmail;
      const date = new Date(m.created_at).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
      return `
        <div class="team-member">
          <div class="team-member-info">
            <div class="team-avatar">${escHtml(initials)}</div>
            <div>
              <div class="team-email">${escHtml(m.email)}${isMe ? ' <span style="color:var(--text3);font-size:11px">(tú)</span>' : ''}</div>
              <div class="team-meta">Desde ${date}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="badge badge-${m.role}">${m.role === 'admin' ? 'Admin' : 'Miembro'}</span>
            ${!isMe ? `<button class="btn btn-icon btn-danger" onclick="deleteMember('${m.id}','${escHtml(m.email)}')" title="Eliminar">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red);font-size:13px">${e.message}</div>`;
  }
}

async function addMember() {
  const email    = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role     = document.getElementById('newUserRole').value;
  const btn      = document.getElementById('btnAddMember');

  if (!email || !password) { toast('Completa email y contraseña', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Agregando…';
  try {
    await api('POST', '/api/users', { email, password, role });
    toast('Miembro agregado', 'success');
    document.getElementById('newUserEmail').value = '';
    document.getElementById('newUserPassword').value = '';
    await loadTeamMembers();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Agregar';
  }
}

async function deleteMember(id, email) {
  if (!confirm(`¿Eliminar a ${email} del equipo?`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    toast('Miembro eliminado', 'info');
    await loadTeamMembers();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
