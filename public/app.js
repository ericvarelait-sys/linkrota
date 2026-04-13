/* ═══════════════════════════════════════════════════════
   LinkRota — Frontend
   ════════════════════════════════════════════════════════ */

let rotators = [];
let folders = [];
let shortLinks = [];
let currentStatsId = null;
let currentView = localStorage.getItem('lr_view') || 'grid';
let currentMode = 'weighted'; // 'equal' | 'weighted'
let currentFolderId = 'all';  // 'all' | 'none' | '<folder-id>'
let dragSrcRow = null;

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
  document.getElementById('btnShortLinks').onclick = openShortLinksModal;
  document.getElementById('btnCloseShortLinks').onclick = closeShortLinksModal;
  document.getElementById('btnCreateShortLink').onclick = createShortLink;
  document.getElementById('newShortUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') createShortLink();
  });
  document.getElementById('modalShortLinks').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeShortLinksModal();
  });
  document.getElementById('btnViewGrid').onclick = () => setView('grid');
  document.getElementById('btnViewList').onclick = () => setView('list');

  // Mode picker (step 1)
  document.getElementById('modeCardEqual').onclick    = () => selectMode('equal');
  document.getElementById('modeCardWeighted').onclick = () => selectMode('weighted');
  document.getElementById('modeCardSchedule').onclick = () => selectMode('schedule');

  // Mode toggle pills (step 2)
  document.getElementById('modePillEqual').onclick    = () => setCurrentMode('equal');
  document.getElementById('modePillWeighted').onclick = () => setCurrentMode('weighted');
  document.getElementById('modePillSchedule').onclick = () => setCurrentMode('schedule');

  // Folder management (inline in bar)
  document.getElementById('btnAddFolder').onclick = toggleInlineFolderCreate;
  document.getElementById('btnInlineFolderSave').onclick = createFolderInline;
  document.getElementById('btnInlineFolderCancel').onclick = cancelInlineFolderCreate;
  document.getElementById('inlineFolderInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') createFolderInline();
    if (e.key === 'Escape') cancelInlineFolderCreate();
  });

  // Drag-and-drop for link rows (event delegation on the list container)
  const linksList = document.getElementById('linksList');
  linksList.addEventListener('dragstart', e => {
    const row = e.target.closest('.link-row');
    if (!row) return;
    dragSrcRow = row;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for Firefox
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  linksList.addEventListener('dragend', () => {
    document.querySelectorAll('.link-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
    dragSrcRow = null;
  });
  linksList.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.link-row');
    if (!row || row === dragSrcRow) return;
    document.querySelectorAll('.link-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });
  linksList.addEventListener('dragleave', e => {
    const row = e.target.closest('.link-row');
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drag-over');
  });
  linksList.addEventListener('drop', e => {
    e.preventDefault();
    const targetRow = e.target.closest('.link-row');
    if (!targetRow || targetRow === dragSrcRow || !dragSrcRow) return;
    const rect = targetRow.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      linksList.insertBefore(dragSrcRow, targetRow);
    } else {
      linksList.insertBefore(dragSrcRow, targetRow.nextSibling);
    }
    document.querySelectorAll('.link-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    updateWeightTotal();
  });

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
    [rotators, folders] = await Promise.all([
      api('GET', '/api/rotators'),
      api('GET', '/api/folders')
    ]);
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

  renderFolderBar();

  if (rotators.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    statsBar.style.display = 'none';
    viewControls.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  statsBar.style.display = 'flex';

  // Global stats (always all rotators)
  const totalClicks = rotators.reduce((a, r) => a + (r.totalClicks || 0), 0);
  const totalLinks = rotators.reduce((a, r) => a + (r.links?.length || 0), 0);
  document.getElementById('statTotal').textContent = rotators.length;
  document.getElementById('statClicks').textContent = totalClicks.toLocaleString();
  document.getElementById('statLinks').textContent = totalLinks;

  // Folder home: show folder tiles when 'all' and folders exist
  if (currentFolderId === 'all' && folders.length > 0) {
    viewControls.style.display = 'none';
    grid.className = 'rotators-grid';
    grid.innerHTML = renderFolderHome();
    grid.querySelectorAll('.folder-tile').forEach(tile => {
      tile.addEventListener('click', () => selectFolder(tile.dataset.folderId));
    });
    return;
  }

  viewControls.style.display = 'flex';
  document.getElementById('btnViewGrid').classList.toggle('active', currentView === 'grid');
  document.getElementById('btnViewList').classList.toggle('active', currentView === 'list');

  // Apply folder filter
  const filtered = filterRotatorsByFolder(rotators, currentFolderId);

  grid.className = currentView === 'list' ? 'rotators-list' : 'rotators-grid';

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="folder-empty">No hay rotadores en esta carpeta todavía.</div>`;
  } else {
    grid.innerHTML = filtered.map(currentView === 'list' ? renderRow : renderCard).join('');
  }

  // Bind card/row buttons
  grid.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', handleCardAction);
  });

  // Bind folder assignment selects
  grid.querySelectorAll('.card-folder-select').forEach(sel => {
    sel.addEventListener('change', () => {
      moveRotatorFolder(sel.dataset.rotatorId, sel.value || null);
    });
  });
}

function renderFolderHome() {
  const tiles = folders.map(f => {
    const count = rotators.filter(r => String(r.folderId) === String(f.id)).length;
    return `
      <div class="folder-tile" data-folder-id="${f.id}">
        <div class="folder-tile-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="folder-tile-name">${escHtml(f.name)}</div>
        <div class="folder-tile-count">${count} rotador${count !== 1 ? 'es' : ''}</div>
      </div>
    `;
  }).join('');

  const uncat = rotators.filter(r => !r.folderId).length;
  const uncatTile = uncat > 0 ? `
    <div class="folder-tile folder-tile-uncat" data-folder-id="none">
      <div class="folder-tile-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="folder-tile-name">Sin carpeta</div>
      <div class="folder-tile-count">${uncat} rotador${uncat !== 1 ? 'es' : ''}</div>
    </div>
  ` : '';

  return tiles + uncatTile;
}

function filterRotatorsByFolder(rotators, folderId) {
  if (folderId === 'all')  return rotators;
  if (folderId === 'none') return rotators.filter(r => !r.folderId);
  return rotators.filter(r => String(r.folderId) === String(folderId));
}

function renderFolderBar() {
  const bar = document.getElementById('folderBar');
  bar.style.display = rotators.length > 0 ? 'flex' : 'none';

  // Remove previously injected dynamic tabs
  bar.querySelectorAll('.folder-tab-dyn').forEach(t => t.remove());

  // Flat folder tabs — inject before the inline-create div
  // Actions are INSIDE the button so hover never loses focus crossing a gap
  const insertBefore = document.getElementById('folderInlineCreate');
  folders.forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'folder-tab folder-tab-dyn';
    btn.dataset.folderId = f.id;
    btn.classList.toggle('active', String(f.id) === String(currentFolderId));
    btn.innerHTML = `
      <span class="folder-tab-label">${escHtml(f.name)}</span>
      <span class="folder-tab-actions">
        <span class="folder-tab-btn-rename" title="Renombrar">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </span>
        <span class="folder-tab-btn-delete" title="Eliminar">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </span>
      </span>
    `;
    btn.addEventListener('click', e => {
      if (!e.target.closest('.folder-tab-actions')) selectFolder(f.id);
    });
    btn.querySelector('.folder-tab-btn-rename').addEventListener('click', e => {
      e.stopPropagation();
      startInlineRename(f.id, f.name, btn);
    });
    btn.querySelector('.folder-tab-btn-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteFolder(f.id);
    });
    insertBefore.insertAdjacentElement('beforebegin', btn);
  });

  // Sync static tabs
  const allTab = bar.querySelector('[data-folder-id="all"]');
  const noneTab = bar.querySelector('[data-folder-id="none"]');
  allTab.classList.toggle('active', currentFolderId === 'all');
  allTab.onclick = () => selectFolder('all');
  noneTab.classList.toggle('active', currentFolderId === 'none');
  noneTab.onclick = () => selectFolder('none');
}

function selectFolder(folderId) {
  currentFolderId = folderId;
  renderAll();
}

function renderCard(r) {
  const rotatorUrl = `${window.location.origin}/r/${r.slug}`;
  const linkCount = r.links?.length || 0;
  const createdDate = new Date(r.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
  const isEqual    = r.distributionMode === 'equal';
  const isSchedule = r.distributionMode === 'schedule';

  const totalWeight = (r.links || []).reduce((sum, l) => sum + (l.weight || 1), 0);
  const linksPreview = (r.links || []).slice(0, 4).map(l => {
    let pctDisplay;
    if (isSchedule) {
      const days = formatScheduleDays(l.schedule);
      const time = formatScheduleTime(l.schedule);
      pctDisplay = `<span class="link-preview-schedule" title="${escHtml(days + (time ? ' ' + time : ''))}">
        ${escHtml(days)}${time ? `<br><small>${escHtml(time)}</small>` : ''}
      </span>`;
    } else {
      pctDisplay = isEqual
        ? '&nbsp;=&nbsp;'
        : `${totalWeight > 0 ? Math.round(((l.weight || 1) / totalWeight) * 100) : 0}%`;
    }
    return `
    <div class="link-preview-item">
      <span class="link-preview-label" title="${escHtml(l.url)}">${escHtml(l.label)}</span>
      <span class="link-preview-pct">${pctDisplay}</span>
      <span class="link-preview-clicks">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 12 9-9 9 9"/><path d="m3 12 9 9 9-9"/></svg>
        ${(l.clicks || 0).toLocaleString()}
      </span>
    </div>
  `;
  }).join('');

  const moreLinks = linkCount > 4 ? `<div class="link-preview-item"><span class="link-preview-label" style="color:var(--text3)">+${linkCount - 4} links más…</span></div>` : '';

  const folderOptions = `<option value="">Sin carpeta</option>` +
    folders.map(f => `<option value="${f.id}" ${String(r.folderId) === String(f.id) ? 'selected' : ''}>${escHtml(f.name)}</option>`).join('');

  return `
    <div class="rotator-card" data-id="${r.id}">
      <div class="card-header">
        <div>
          <div class="card-title">${escHtml(r.name)}</div>
          <div class="card-meta">
            ${linkCount} link${linkCount !== 1 ? 's' : ''} · ${createdDate}
            <span class="mode-badge ${isEqual ? 'equal' : isSchedule ? 'schedule' : 'weighted'}">${isEqual ? 'Equitativa' : isSchedule ? 'Horario' : '% Pesado'}</span>
          </div>
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

      <div class="card-folder-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <select class="card-folder-select" data-rotator-id="${r.id}">${folderOptions}</select>
      </div>
    </div>
  `;
}

function renderRow(r) {
  const rotatorUrl = `${window.location.origin}/r/${r.slug}`;
  const linkCount = r.links?.length || 0;
  const createdDate = new Date(r.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
  const isEqual    = r.distributionMode === 'equal';
  const isSchedule = r.distributionMode === 'schedule';
  const folderOptions = `<option value="">Sin carpeta</option>` +
    folders.map(f => `<option value="${f.id}" ${String(r.folderId) === String(f.id) ? 'selected' : ''}>${escHtml(f.name)}</option>`).join('');

  return `
    <div class="rotator-row" data-id="${r.id}">
      <div class="row-name">
        <div class="row-title">${escHtml(r.name)}</div>
        <div class="row-meta">
          ${linkCount} link${linkCount !== 1 ? 's' : ''} · ${createdDate}
          <span class="mode-badge ${isEqual ? 'equal' : isSchedule ? 'schedule' : 'weighted'}">${isEqual ? 'Equitativa' : isSchedule ? 'Horario' : '% Pesado'}</span>
          <span class="row-folder-wrap">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <select class="card-folder-select row-folder-select" data-rotator-id="${r.id}">${folderOptions}</select>
          </span>
        </div>
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
  populateFolderSelect(null);

  // Show step 1 (mode picker), hide step 2 (form)
  document.getElementById('stepMode').style.display = '';
  document.getElementById('stepForm').style.display = 'none';

  document.getElementById('modalRotator').classList.add('open');
}

function selectMode(mode) {
  currentMode = mode;
  // Transition to step 2
  document.getElementById('stepMode').style.display = 'none';
  document.getElementById('stepForm').style.display = '';

  // Add default rows if none yet
  if (document.getElementById('linksList').children.length === 0) {
    addLinkRow();
    addLinkRow();
  }

  updateModeUI();
  setTimeout(() => document.getElementById('rotatorName').focus(), 80);
}

function setCurrentMode(mode) {
  currentMode = mode;
  updateModeUI();
}

function updateModeUI() {
  const stepForm = document.getElementById('stepForm');
  stepForm.classList.toggle('mode-equal',    currentMode === 'equal');
  stepForm.classList.toggle('mode-weighted', currentMode === 'weighted');
  stepForm.classList.toggle('mode-schedule', currentMode === 'schedule');

  document.getElementById('modePillEqual').classList.toggle('active',    currentMode === 'equal');
  document.getElementById('modePillWeighted').classList.toggle('active', currentMode === 'weighted');
  document.getElementById('modePillSchedule').classList.toggle('active', currentMode === 'schedule');

  updateWeightTotal();
}

function openEditModal(id) {
  const r = rotators.find(x => x.id === id);
  if (!r) return;

  currentMode = r.distributionMode || 'weighted';

  document.getElementById('editingId').value = id;
  document.getElementById('modalTitle').textContent = 'Editar Rotador';
  document.getElementById('rotatorName').value = r.name;
  populateFolderSelect(r.folderId);

  // Skip step 1, go directly to form
  document.getElementById('stepMode').style.display = 'none';
  document.getElementById('stepForm').style.display = '';

  const list = document.getElementById('linksList');
  list.innerHTML = '';
  r.links.forEach(l => addLinkRow(l.label, l.url, l.id, l.clicks, l.weight || 1, l.schedule || null));

  updateModeUI();
  document.getElementById('modalRotator').classList.add('open');
  setTimeout(() => document.getElementById('rotatorName').focus(), 80);
}

function closeModal() {
  document.getElementById('modalRotator').classList.remove('open');
}

function addLinkRow(label = '', url = '', lid = '', clicks = 0, weight = 1, schedule = null) {
  const list = document.getElementById('linksList');
  const row = document.createElement('div');
  row.draggable = true;
  row.dataset.lid = lid;
  row.dataset.clicks = clicks;

  const dragHandleHTML = `
    <span class="drag-handle" title="Arrastrar para reordenar">
      <svg width="14" height="14" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/>
        <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
        <circle cx="3" cy="14" r="1.5"/><circle cx="7" cy="14" r="1.5"/>
      </svg>
    </span>`;
  const removeBtnHTML = `
    <button class="btn-remove-link" title="Eliminar link">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;

  if (currentMode === 'schedule') {
    row.className = 'link-row link-row-schedule';
    const s = schedule || { days: [], timeStart: '06:00', timeEnd: '23:59' };
    const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const dayBtnsHTML = DAY_NAMES.map((d, i) =>
      `<button type="button" class="day-btn${s.days.includes(i) ? ' active' : ''}" data-day="${i}">${d}</button>`
    ).join('');
    row.innerHTML = `
      <div class="link-row-main">
        ${dragHandleHTML}
        <input type="text" placeholder="Etiqueta" value="${escHtml(label)}" class="link-label" maxlength="40" />
        <input type="url" placeholder="https://..." value="${escHtml(url)}" class="link-url" />
        ${removeBtnHTML}
      </div>
      <div class="link-row-schedule-opts">
        <div class="schedule-days">${dayBtnsHTML}</div>
        <div class="schedule-times">
          <input type="time" class="link-time-start" value="${escHtml(s.timeStart || '06:00')}" />
          <span class="schedule-sep">–</span>
          <input type="time" class="link-time-end" value="${escHtml(s.timeEnd || '23:59')}" />
        </div>
      </div>
    `;
    row.querySelectorAll('.day-btn').forEach(btn =>
      btn.addEventListener('click', () => btn.classList.toggle('active'))
    );
  } else {
    row.className = 'link-row';
    row.innerHTML = `
      ${dragHandleHTML}
      <input type="text" placeholder="Etiqueta" value="${escHtml(label)}" class="link-label" maxlength="40" />
      <input type="url" placeholder="https://..." value="${escHtml(url)}" class="link-url" />
      <input type="number" min="1" max="100" value="${weight}" class="link-weight" title="Porcentaje de tráfico" />
      ${removeBtnHTML}
    `;
    row.querySelector('.link-weight').addEventListener('input', updateWeightTotal);
  }

  row.querySelector('.btn-remove-link').onclick = () => {
    if (list.children.length > 1) { row.remove(); updateWeightTotal(); }
    else toast('Debe haber al menos 1 link', 'error');
  };
  list.appendChild(row);
  updateWeightTotal();
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

    const normalized = url.startsWith('http') ? url : 'https://' + url;

    if (currentMode === 'schedule') {
      const activeDays = Array.from(row.querySelectorAll('.day-btn.active'))
        .map(b => parseInt(b.dataset.day));
      links.push({
        id: row.dataset.lid || undefined,
        label,
        url: normalized,
        clicks: parseInt(row.dataset.clicks || 0),
        weight: 1,
        schedule: {
          days: activeDays,
          timeStart: row.querySelector('.link-time-start').value || '00:00',
          timeEnd:   row.querySelector('.link-time-end').value   || '23:59'
        }
      });
    } else {
      links.push({
        id: row.dataset.lid || undefined,
        label,
        url: normalized,
        clicks: parseInt(row.dataset.clicks || 0),
        weight: Math.max(1, parseInt(row.querySelector('.link-weight').value) || 1)
      });
    }
  });

  if (hasError) { toast('Completa todos los URLs', 'error'); return; }
  if (links.length === 0) { toast('Agrega al menos 1 link', 'error'); return; }

  const btn = document.getElementById('btnSaveRotator');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const folderId = document.getElementById('rotatorFolder').value || null;
    const payload = { name, links, distributionMode: currentMode, folderId };
    if (editingId) {
      await api('PUT', `/api/rotators/${editingId}`, payload);
      toast('Rotador actualizado', 'success');
    } else {
      await api('POST', '/api/rotators', payload);
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
  const isEqual    = r.distributionMode === 'equal';
  const isSchedule = r.distributionMode === 'schedule';

  const avg = linkCount > 0 ? (total / linkCount).toFixed(1) : '0';

  const totalWeight = (r.links || []).reduce((sum, l) => sum + (l.weight || 1), 0);

  const rows = (r.links || [])
    .map((l, i) => ({ ...l, idx: i }))
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .map(l => {
      const actualPct = total > 0 ? Math.round(((l.clicks || 0) / total) * 100) : 0;
      let configPct;
      if (isSchedule) {
        const days = formatScheduleDays(l.schedule);
        const time = formatScheduleTime(l.schedule);
        configPct = `<span style="font-size:11px;color:var(--accent)">${escHtml(days)}</span>
                     ${time ? `<br><span style="font-size:11px;color:var(--text2)">${escHtml(time)}</span>` : ''}`;
      } else {
        configPct = isEqual
          ? `<span style="color:var(--text3)">—</span>`
          : `<span style="color:var(--accent);font-weight:600">${totalWeight > 0 ? Math.round(((l.weight || 1) / totalWeight) * 100) : 0}%</span>`;
      }
      return `
        <tr>
          <td>
            <div style="font-weight:500">${escHtml(l.label)}</div>
            <a href="${escHtml(l.url)}" target="_blank" class="stats-url" title="${escHtml(l.url)}">${escHtml(l.url)}</a>
          </td>
          <td>${configPct}</td>
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
      <div class="stats-mini-card">
        <div class="stats-mini-val" style="font-size:14px">${isEqual ? 'Equitativa' : isSchedule ? 'Horario' : 'Por %'}</div>
        <div class="stats-mini-label">Distribución</div>
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
            <th>${isSchedule ? 'Horario' : isEqual ? 'Config.' : 'Peso cfg.'}</th>
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

function updateWeightTotal() {
  if (currentMode !== 'weighted') return;
  const inputs = document.querySelectorAll('#linksList .link-weight');
  const sum = Array.from(inputs).reduce((acc, el) => acc + (parseInt(el.value) || 0), 0);
  const el = document.getElementById('weightTotal');
  if (!el) return;
  el.textContent = sum;
  el.className = 'weight-total-val ' + (sum === 100 ? 'ok' : 'bad');
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

// ─── Folder Management ────────────────────────────────────────────────────────

function populateFolderSelect(selectedFolderId) {
  const sel = document.getElementById('rotatorFolder');
  let options = '<option value="">Sin carpeta</option>';
  folders.forEach(f => {
    options += `<option value="${f.id}" ${String(selectedFolderId) === String(f.id) ? 'selected' : ''}>${escHtml(f.name)}</option>`;
  });
  sel.innerHTML = options;
  document.getElementById('folderSelectGroup').style.display = '';
}

// ─── Inline folder creation ───────────────────────────────────────────────────

function toggleInlineFolderCreate() {
  document.getElementById('folderInlineCreate').style.display = '';
  document.getElementById('btnAddFolder').style.display = 'none';
  const input = document.getElementById('inlineFolderInput');
  input.value = '';
  input.focus();
}

function cancelInlineFolderCreate() {
  document.getElementById('folderInlineCreate').style.display = 'none';
  document.getElementById('btnAddFolder').style.display = '';
}

async function createFolderInline() {
  const input = document.getElementById('inlineFolderInput');
  const name = input.value.trim();
  if (!name) { toast('Escribe un nombre para la carpeta', 'error'); input.focus(); return; }

  const saveBtn = document.getElementById('btnInlineFolderSave');
  saveBtn.disabled = true;
  try {
    const folder = await api('POST', '/api/folders', { name, parentId: null });
    folders.push(folder);
    cancelInlineFolderCreate();
    renderFolderBar();
    toast('Carpeta creada', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

// ─── Inline folder rename (in-place tab editing) ──────────────────────────────

function startInlineRename(id, currentName, tabBtn) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-tab folder-tab-rename-input folder-tab-dyn'; // folder-tab-dyn ensures cleanup on re-render
  input.value = currentName;
  input.maxLength = 50;

  let saved = false;
  const finish = async (save) => {
    if (saved) return;
    saved = true;
    const newName = input.value.trim();
    if (save && newName && newName !== currentName) {
      try {
        const updated = await api('PUT', `/api/folders/${id}`, { name: newName });
        const idx = folders.findIndex(f => String(f.id) === String(id));
        if (idx !== -1) folders[idx] = updated;
        renderFolderBar();
        renderAll();
        toast('Carpeta renombrada', 'success');
      } catch (e) {
        toast(e.message, 'error');
        renderFolderBar();
      }
    } else {
      renderFolderBar();
    }
  };

  input.onblur = () => finish(true);
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); input.onblur = null; finish(true); }
    if (e.key === 'Escape') { input.onblur = null; finish(false); }
  };

  tabBtn.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteFolder(id) {
  const folder = folders.find(f => String(f.id) === String(id));
  if (!folder) return;
  const affectedCount = rotators.filter(r => String(r.folderId) === String(id)).length;
  let msg = `¿Eliminar la carpeta "${folder.name}"?`;
  if (affectedCount > 0) msg += `\n${affectedCount} rotador(es) quedarán sin carpeta.`;
  if (!confirm(msg)) return;

  try {
    await api('DELETE', `/api/folders/${id}`);
    folders = folders.filter(f => String(f.id) !== String(id));
    rotators.forEach(r => { if (String(r.folderId) === String(id)) r.folderId = null; });
    if (String(currentFolderId) === String(id)) currentFolderId = 'all';
    renderAll();
    toast('Carpeta eliminada', 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function moveRotatorFolder(rotatorId, folderId) {
  const r = rotators.find(x => String(x.id) === String(rotatorId));
  if (!r) return;
  const oldFolder = r.folderId;
  r.folderId = folderId || null; // optimistic update
  try {
    await api('PUT', `/api/rotators/${rotatorId}`, {
      name: r.name, links: r.links,
      distributionMode: r.distributionMode,
      folderId: folderId || null
    });
    renderFolderBar();
    if (currentFolderId !== 'all') renderAll();
    toast('Carpeta actualizada', 'success');
  } catch (e) {
    r.folderId = oldFolder; // revert on error
    toast(e.message, 'error');
    renderAll();
  }
}

// ─── Short Links ──────────────────────────────────────────────────────────────

async function openShortLinksModal() {
  document.getElementById('newShortUrl').value = '';
  document.getElementById('newShortLabel').value = '';
  document.getElementById('newShortCode').value = '';
  document.getElementById('modalShortLinks').classList.add('open');
  await loadShortLinks();
}

function closeShortLinksModal() {
  document.getElementById('modalShortLinks').classList.remove('open');
}

async function loadShortLinks() {
  const list = document.getElementById('shortLinksList');
  list.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">Cargando…</div>';
  try {
    shortLinks = await api('GET', '/api/short-links');
    renderShortLinks();
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

function renderShortLinks() {
  const list = document.getElementById('shortLinksList');
  if (!shortLinks.length) {
    list.innerHTML = '<div class="short-empty">No tenés links cortos todavía.<br>¡Acortá tu primer link arriba!</div>';
    return;
  }
  list.innerHTML = shortLinks.map(s => {
    const shortUrl = `${window.location.origin}/s/${s.code}`;
    const date = new Date(s.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
    return `
      <div class="short-link-item">
        <div class="short-link-info">
          ${s.label ? `<div class="short-link-label">${escHtml(s.label)}</div>` : ''}
          <div class="short-link-short-url">${escHtml(shortUrl)}</div>
          <div class="short-link-dest" title="${escHtml(s.url)}">${escHtml(s.url)}</div>
          <div class="short-link-meta">${(s.clicks || 0).toLocaleString()} click${s.clicks !== 1 ? 's' : ''} · ${date}</div>
        </div>
        <div class="short-link-actions">
          <button class="btn-copy" onclick="copyToClipboard('${escHtml(shortUrl)}', this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copiar
          </button>
          <button class="btn btn-icon btn-danger" onclick="deleteShortLink('${escHtml(s.id)}')" title="Eliminar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function createShortLink() {
  const url   = document.getElementById('newShortUrl').value.trim();
  const label = document.getElementById('newShortLabel').value.trim();
  const code  = document.getElementById('newShortCode').value.trim();

  if (!url) { toast('Ingresa una URL', 'error'); document.getElementById('newShortUrl').focus(); return; }

  const btn = document.getElementById('btnCreateShortLink');
  btn.disabled = true;
  btn.textContent = 'Acortando…';
  try {
    const sl = await api('POST', '/api/short-links', { url, label, code });
    shortLinks.unshift(sl);
    document.getElementById('newShortUrl').value = '';
    document.getElementById('newShortLabel').value = '';
    document.getElementById('newShortCode').value = '';
    renderShortLinks();
    toast('Link acortado', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Acortar';
  }
}

async function deleteShortLink(id) {
  if (!confirm('¿Eliminar este link corto?')) return;
  try {
    await api('DELETE', `/api/short-links/${id}`);
    shortLinks = shortLinks.filter(s => s.id !== id);
    renderShortLinks();
    toast('Link eliminado', 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────

const DAY_ABBR = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function formatScheduleDays(schedule) {
  if (!schedule || !schedule.days || !schedule.days.length) return '—';
  return [...schedule.days].sort((a, b) => a - b).map(d => DAY_ABBR[d]).join(', ');
}

function formatScheduleTime(schedule) {
  if (!schedule || !schedule.timeStart) return '';
  return `${schedule.timeStart}–${schedule.timeEnd}`;
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
