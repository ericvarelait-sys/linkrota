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
      id            TEXT PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      links         JSONB NOT NULL DEFAULT '[]',
      total_clicks  INTEGER NOT NULL DEFAULT 0,
      current_index INTEGER NOT NULL DEFAULT 0,
      click_history JSONB NOT NULL DEFAULT '[]',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

function generateSlug(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'rotador';
  return `${base}-${generateId()}`;
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

    const idx = row.current_index % links.length;
    const target = links[idx];

    links[idx].clicks = (links[idx].clicks || 0) + 1;
    const newIndex = (idx + 1) % links.length;
    const newTotal = row.total_clicks + 1;

    let history = row.click_history || [];
    history.push({ ts: Date.now(), linkIndex: idx, url: target.url });
    if (history.length > 500) history = history.slice(-500);

    await pool.query(
      `UPDATE rotators SET links=$1, total_clicks=$2, current_index=$3, click_history=$4 WHERE id=$5`,
      [JSON.stringify(links), newTotal, newIndex, JSON.stringify(history), row.id]
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
  const { name, links } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Nombre requerido' });
  if (!Array.isArray(links) || links.length < 1)
    return res.status(400).json({ error: 'Se necesita al menos 1 link' });

  const id = generateId();
  const slug = generateSlug(name.trim());
  const mappedLinks = links.map((l, i) => ({
    id: generateId(),
    label: (l.label || '').trim() || `Link ${i + 1}`,
    url: l.url.trim(),
    clicks: 0
  }));

  try {
    const { rows } = await pool.query(
      `INSERT INTO rotators (id, slug, name, links, total_clicks, current_index, click_history)
       VALUES ($1, $2, $3, $4, 0, 0, '[]') RETURNING *`,
      [id, slug, name.trim(), JSON.stringify(mappedLinks)]
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
  const { name, links } = req.body;
  try {
    const { rows: existing } = await pool.query('SELECT * FROM rotators WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'No encontrado' });

    const newName = (name && name.trim()) ? name.trim() : existing[0].name;
    let newLinks = existing[0].links;
    if (Array.isArray(links)) {
      newLinks = links.map((l, i) => ({
        id: l.id || generateId(),
        label: (l.label || '').trim() || `Link ${i + 1}`,
        url: l.url.trim(),
        clicks: l.clicks || 0
      }));
    }

    const { rows } = await pool.query(
      `UPDATE rotators SET name=$1, links=$2, current_index=0 WHERE id=$3 RETURNING *`,
      [newName, JSON.stringify(newLinks), req.params.id]
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
