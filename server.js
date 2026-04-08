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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotators (
      id          TEXT PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      links       JSONB NOT NULL DEFAULT '[]',
      total_clicks INTEGER NOT NULL DEFAULT 0,
      current_index INTEGER NOT NULL DEFAULT 0,
      click_history JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('DB lista');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const USER_EMAIL = 'ericvarelait@gmail.com';
const USER_PASS_HASH = crypto.createHash('sha256').update('Link123+').digest('hex');
const sessions = new Map(); // token → { email, expires }

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
  req.userEmail = session.email;
  next();
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    else if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    else if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
}));

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Datos requeridos' });

  const passHash = crypto.createHash('sha256').update(password).digest('hex');
  if (email.toLowerCase() !== USER_EMAIL || passHash !== USER_PASS_HASH) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  const token = generateToken();
  sessions.set(token, { email, expires: Date.now() + 8 * 60 * 60 * 1000 }); // 8h
  res.json({ token, email });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
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
          <h2>Link rotador no encontrado</h2>
          <a href="/">Volver al inicio</a>
        </body></html>
      `);
    }

    const links = row.links;
    if (!links || links.length === 0) {
      return res.status(404).send(`
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Este rotador no tiene links configurados</h2>
          <a href="/">Volver al inicio</a>
        </body></html>
      `);
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

// ─── API ──────────────────────────────────────────────────────────────────────

// List all rotators
app.get('/api/rotators', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rotators ORDER BY created_at DESC');
    res.json(rows.map(rowToRotator));
  } catch (e) {
    res.status(500).json({ error: 'Error al cargar datos' });
  }
});

// Create rotator
app.post('/api/rotators', authMiddleware, async (req, res) => {
  const { name, links } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Nombre requerido' });
  }
  if (!Array.isArray(links) || links.length < 1) {
    return res.status(400).json({ error: 'Se necesita al menos 1 link' });
  }

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

// Get single rotator
app.get('/api/rotators/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rotators WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rowToRotator(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Update rotator
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

// Delete rotator
app.delete('/api/rotators/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM rotators WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar' });
  }
});

// Reset stats
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

// ─── Catch-all → dashboard ────────────────────────────────────────────────────
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
