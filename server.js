const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotators (
      id                TEXT PRIMARY KEY,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      links             JSONB NOT NULL DEFAULT '[]',
      total_clicks      INTEGER NOT NULL DEFAULT 0,
      current_index     INTEGER NOT NULL DEFAULT 0,
      click_history     JSONB NOT NULL DEFAULT '[]',
      distribution_mode TEXT NOT NULL DEFAULT 'weighted',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotent migrations — each wrapped so one failure doesn't abort startup
  const migrations = [
    `ALTER TABLE rotators ADD COLUMN IF NOT EXISTS distribution_mode TEXT NOT NULL DEFAULT 'weighted'`,
    `ALTER TABLE rotators ADD COLUMN IF NOT EXISTS folder_id TEXT`,
    `ALTER TABLE rotators ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires'`
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { console.warn('Migration skipped:', e.message); }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS short_links (
      id         TEXT PRIMARY KEY,
      code       TEXT UNIQUE NOT NULL,
      url        TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      clicks     INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed admin user if no users exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [generateId(), 'ericvarelait@gmail.com', hashPassword('Link123+')]
    );
    console.log('Admin creado: ericvarelait@gmail.com');
  }

  console.log('DB lista');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const sessions = new Map(); // token → { userId, email, role, expires }

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const token = auth.slice(7);
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesión expirada' });
  }
  req.user = session;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el administrador puede hacer esto' });
  }
  next();
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js'))        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    else if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    else if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
}));

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Datos requeridos' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const user = rows[0];

  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  const token = generateToken();
  sessions.set(token, {
    userId: user.id,
    email: user.email,
    role: user.role,
    expires: Date.now() + 8 * 60 * 60 * 1000 // 8h
  });
  res.json({ token, email: user.email, role: user.role });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ─── Users API (admin only) ───────────────────────────────────────────────────

// List team members
app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, role, created_at FROM users ORDER BY created_at ASC'
  );
  res.json(rows);
});

// Add team member
app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const normalizedEmail = email.toLowerCase().trim();
  const allowedRoles = ['admin', 'member'];
  const assignedRole = allowedRoles.includes(role) ? role : 'member';

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, created_at`,
      [generateId(), normalizedEmail, hashPassword(password), assignedRole]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese email ya está registrado' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// Delete team member
app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.id === req.user.userId) {
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  }
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  // Invalidate any active sessions for this user
  for (const [token, session] of sessions) {
    if (session.userId === req.params.id) sessions.delete(token);
  }
  res.json({ ok: true });
});

// Change password (admin can change anyone's, member only their own)
app.put('/api/users/:id/password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  const isOwnAccount = req.params.id === req.user.userId;
  const isAdmin = req.user.role === 'admin';
  if (!isOwnAccount && !isAdmin) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hashPassword(password), req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

function generateSlug(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'rotador';
  return `${base}-${generateId()}`;
}

function selectWeightedIndex(links) {
  const totalWeight = links.reduce((sum, l) => sum + (l.weight || 1), 0);
  const totalClicks = links.reduce((sum, l) => sum + (l.clicks || 0), 0);
  // Deterministic: select the link most "owed" clicks relative to its weight.
  // deficit = expected_clicks_after_this_one - current_clicks
  let bestIdx = 0;
  let bestDeficit = -Infinity;
  for (let i = 0; i < links.length; i++) {
    const weight = links[i].weight || 1;
    const clicks = links[i].clicks || 0;
    const deficit = (weight / totalWeight) * (totalClicks + 1) - clicks;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function rowToRotator(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    links: row.links,
    totalClicks: row.total_clicks,
    currentIndex: row.current_index,
    clickHistory: row.click_history,
    distributionMode: row.distribution_mode || 'weighted',
    folderId: row.folder_id || null,
    timezone: row.timezone || 'America/Argentina/Buenos_Aires',
    createdAt: row.created_at
  };
}

// ─── Redirect route ───────────────────────────────────────────────────────────

app.get('/r/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rotators WHERE slug = $1', [req.params.slug]);
    const row = rows[0];

    if (!row) {
      return res.status(404).send(`
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Link rotador no encontrado</h2><a href="/">Volver al inicio</a>
        </body></html>`);
    }

    const links = row.links;
    if (!links || links.length === 0) {
      return res.status(404).send(`
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Este rotador no tiene links configurados</h2><a href="/">Volver al inicio</a>
        </body></html>`);
    }

    const mode = row.distribution_mode || 'weighted';
    let idx, newCurrentIndex;

    if (mode === 'equal') {
      idx = row.current_index % links.length;
      newCurrentIndex = row.current_index + 1;
    } else if (mode === 'schedule') {
      const tz = row.timezone || 'America/Argentina/Buenos_Aires';
      const arNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const currentDay = arNow.getDay(); // 0=Dom … 6=Sáb
      const hh = arNow.getHours().toString().padStart(2, '0');
      const mm = arNow.getMinutes().toString().padStart(2, '0');
      const currentTime = `${hh}:${mm}`;

      idx = links.findIndex(l => {
        const s = l.schedule;
        if (!s || !Array.isArray(s.days) || !s.days.length) return false;
        return s.days.includes(currentDay) &&
               currentTime >= (s.timeStart || '00:00') &&
               currentTime <= (s.timeEnd   || '23:59');
      });

      if (idx === -1) {
        return res.status(200).send(`
          <html><head><meta charset="UTF-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          </head>
          <body style="font-family:sans-serif;text-align:center;padding:60px;color:#888">
            <h2 style="color:#444">Este link no está disponible ahora</h2>
            <p style="margin-top:8px">Volvé en el horario configurado.</p>
          </body></html>`);
      }
      newCurrentIndex = row.current_index;
    } else {
      idx = selectWeightedIndex(links);
      newCurrentIndex = row.current_index;
    }

    const target = links[idx];

    links[idx].clicks = (links[idx].clicks || 0) + 1;
    const newTotal = row.total_clicks + 1;

    let history = row.click_history || [];
    history.push({ ts: Date.now(), linkIndex: idx, url: target.url });
    if (history.length > 500) history = history.slice(-500);

    await pool.query(
      `UPDATE rotators SET links=$1, total_clicks=$2, click_history=$3, current_index=$4 WHERE id=$5`,
      [JSON.stringify(links), newTotal, JSON.stringify(history), newCurrentIndex, row.id]
    );

    res.redirect(target.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error interno');
  }
});

// ─── Rotators API ─────────────────────────────────────────────────────────────

app.get('/api/rotators', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rotators ORDER BY created_at DESC');
    res.json(rows.map(rowToRotator));
  } catch (e) {
    res.status(500).json({ error: 'Error al cargar datos' });
  }
});

app.post('/api/rotators', authMiddleware, async (req, res) => {
  const { name, links, distributionMode, folderId, timezone } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Nombre requerido' });
  if (!Array.isArray(links) || links.length < 1)
    return res.status(400).json({ error: 'Se necesita al menos 1 link' });

  const mode = ['equal', 'weighted', 'schedule'].includes(distributionMode) ? distributionMode : 'weighted';
  const validTimezone = (timezone && timezone.trim()) ? timezone.trim() : 'America/Argentina/Buenos_Aires';
  const validFolderId = folderId || null;

  if (validFolderId) {
    const { rows: f } = await pool.query('SELECT id FROM folders WHERE id=$1', [validFolderId]);
    if (!f[0]) return res.status(404).json({ error: 'Carpeta no encontrada' });
  }

  const id = generateId();
  const slug = generateSlug(name.trim());
  const mappedLinks = links.map((l, i) => ({
    id: generateId(),
    label: (l.label || '').trim() || `Link ${i + 1}`,
    url: l.url.trim(),
    clicks: 0,
    weight: Math.max(1, parseInt(l.weight) || 1),
    schedule: l.schedule || null
  }));

  try {
    const { rows } = await pool.query(
      `INSERT INTO rotators (id, slug, name, links, total_clicks, current_index, click_history, distribution_mode, folder_id, timezone)
       VALUES ($1, $2, $3, $4, 0, 0, '[]', $5, $6, $7) RETURNING *`,
      [id, slug, name.trim(), JSON.stringify(mappedLinks), mode, validFolderId, validTimezone]
    );
    res.status(201).json(rowToRotator(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al crear rotador' });
  }
});

app.get('/api/rotators/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rotators WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rowToRotator(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/rotators/:id', authMiddleware, async (req, res) => {
  const { name, links, distributionMode, folderId, timezone } = req.body;
  try {
    const { rows: existing } = await pool.query('SELECT * FROM rotators WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'No encontrado' });

    const newName = (name && name.trim()) ? name.trim() : existing[0].name;
    const newMode = ['equal', 'weighted', 'schedule'].includes(distributionMode)
      ? distributionMode
      : (existing[0].distribution_mode || 'weighted');
    const newTimezone = (timezone && timezone.trim())
      ? timezone.trim()
      : (existing[0].timezone || 'America/Argentina/Buenos_Aires');
    const newFolderId = 'folderId' in req.body ? (folderId || null) : existing[0].folder_id;

    if (newFolderId) {
      const { rows: f } = await pool.query('SELECT id FROM folders WHERE id=$1', [newFolderId]);
      if (!f[0]) return res.status(404).json({ error: 'Carpeta no encontrada' });
    }

    let newLinks = existing[0].links;
    if (Array.isArray(links)) {
      newLinks = links.map((l, i) => ({
        id: l.id || generateId(),
        label: (l.label || '').trim() || `Link ${i + 1}`,
        url: l.url.trim(),
        clicks: l.clicks || 0,
        weight: Math.max(1, parseInt(l.weight) || 1),
        schedule: l.schedule || null
      }));
    }

    const { rows } = await pool.query(
      `UPDATE rotators SET name=$1, links=$2, current_index=0, distribution_mode=$3, folder_id=$4, timezone=$5 WHERE id=$6 RETURNING *`,
      [newName, JSON.stringify(newLinks), newMode, newFolderId, newTimezone, req.params.id]
    );
    res.json(rowToRotator(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

app.delete('/api/rotators/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM rotators WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar' });
  }
});

app.post('/api/rotators/:id/reset', authMiddleware, async (req, res) => {
  try {
    const { rows: existing } = await pool.query('SELECT * FROM rotators WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'No encontrado' });

    const clearedLinks = existing[0].links.map(l => ({ ...l, clicks: 0 }));
    const { rows } = await pool.query(
      `UPDATE rotators SET total_clicks=0, current_index=0, click_history='[]', links=$1 WHERE id=$2 RETURNING *`,
      [JSON.stringify(clearedLinks), req.params.id]
    );
    res.json(rowToRotator(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Error al resetear' });
  }
});

// ─── Folders API ─────────────────────────────────────────────────────────────

app.get('/api/folders', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM folders ORDER BY parent_id NULLS FIRST, name ASC'
    );
    res.json(rows.map(r => ({ id: r.id, name: r.name, parentId: r.parent_id })));
  } catch (e) {
    res.status(500).json({ error: 'Error al cargar carpetas' });
  }
});

app.post('/api/folders', authMiddleware, async (req, res) => {
  const { name, parentId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });

  if (parentId) {
    const { rows } = await pool.query('SELECT parent_id FROM folders WHERE id=$1', [parentId]);
    if (!rows[0]) return res.status(404).json({ error: 'Carpeta padre no encontrada' });
    if (rows[0].parent_id !== null) return res.status(400).json({ error: 'Solo se permiten 2 niveles de carpetas' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO folders (id, name, parent_id) VALUES ($1, $2, $3) RETURNING *',
      [generateId(), name.trim(), parentId || null]
    );
    const f = rows[0];
    res.status(201).json({ id: f.id, name: f.name, parentId: f.parent_id });
  } catch (e) {
    res.status(500).json({ error: 'Error al crear carpeta' });
  }
});

app.put('/api/folders/:id', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const { rows, rowCount } = await pool.query(
    'UPDATE folders SET name=$1 WHERE id=$2 RETURNING *',
    [name.trim(), req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Carpeta no encontrada' });
  const f = rows[0];
  res.json({ id: f.id, name: f.name, parentId: f.parent_id });
});

app.delete('/api/folders/:id', authMiddleware, async (req, res) => {
  try {
    const { rows: existing } = await pool.query('SELECT id FROM folders WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Carpeta no encontrada' });

    // Get subfolder IDs before cascade-deleting them
    const { rows: subs } = await pool.query('SELECT id FROM folders WHERE parent_id=$1', [req.params.id]);
    const allIds = [req.params.id, ...subs.map(s => s.id)];

    // Null out folder_id on rotators (no FK constraint to do this automatically)
    for (const fid of allIds) {
      await pool.query('UPDATE rotators SET folder_id = NULL WHERE folder_id = $1', [fid]);
    }

    // Delete folder (subfolders cascade via folders.parent_id FK)
    await pool.query('DELETE FROM folders WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al eliminar carpeta' });
  }
});

// ─── Short Links redirect ─────────────────────────────────────────────────────

app.get('/s/:code', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM short_links WHERE code = $1', [req.params.code]);
    const row = rows[0];
    if (!row) {
      return res.status(404).send(`
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Link corto no encontrado</h2><a href="/">Volver al inicio</a>
        </body></html>`);
    }
    await pool.query('UPDATE short_links SET clicks = clicks + 1 WHERE id = $1', [row.id]);
    res.redirect(row.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error interno');
  }
});

// ─── Short Links API ──────────────────────────────────────────────────────────

app.get('/api/short-links', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM short_links ORDER BY created_at DESC');
    res.json(rows.map(r => ({
      id: r.id, code: r.code, url: r.url, label: r.label,
      clicks: r.clicks, createdAt: r.created_at
    })));
  } catch (e) {
    res.status(500).json({ error: 'Error al cargar links cortos' });
  }
});

app.post('/api/short-links', authMiddleware, async (req, res) => {
  const { url, label, code } = req.body;
  if (!url || typeof url !== 'string' || !url.trim())
    return res.status(400).json({ error: 'URL requerida' });

  const normalizedUrl = url.trim().startsWith('http') ? url.trim() : 'https://' + url.trim();
  const customCode = (code || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
  const finalCode = customCode || generateShortCode();

  try {
    const { rows } = await pool.query(
      `INSERT INTO short_links (id, code, url, label) VALUES ($1, $2, $3, $4) RETURNING *`,
      [generateId(), finalCode, normalizedUrl, (label || '').trim()]
    );
    const r = rows[0];
    res.status(201).json({ id: r.id, code: r.code, url: r.url, label: r.label, clicks: r.clicks, createdAt: r.created_at });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese código ya está en uso' });
    res.status(500).json({ error: 'Error al crear link corto' });
  }
});

app.delete('/api/short-links/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM short_links WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar' });
  }
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`LinkRota corriendo en http://localhost:${PORT}`));
}).catch(err => {
  console.error('Error conectando a la DB:', err.message);
  process.exit(1);
});
