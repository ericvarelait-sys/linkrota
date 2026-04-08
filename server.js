const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, 'data', 'rotators.json');

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
  res.setHeader('Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
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

// ─── Data helpers ────────────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ rotators: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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

// ─── Redirect route (must be before static) ──────────────────────────────────

app.get('/r/:slug', (req, res) => {
  const data = loadData();
  const rotator = data.rotators.find(r => r.slug === req.params.slug);

  if (!rotator) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>Link rotador no encontrado</h2>
        <a href="/">Volver al inicio</a>
      </body></html>
    `);
  }

  if (!rotator.links || rotator.links.length === 0) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>Este rotador no tiene links configurados</h2>
        <a href="/">Volver al inicio</a>
      </body></html>
    `);
  }

  // Round-robin: pick current index, then advance
  const idx = rotator.currentIndex % rotator.links.length;
  const target = rotator.links[idx];

  rotator.links[idx].clicks = (rotator.links[idx].clicks || 0) + 1;
  rotator.totalClicks = (rotator.totalClicks || 0) + 1;
  rotator.currentIndex = (idx + 1) % rotator.links.length;

  // Track click history (last 500)
  if (!rotator.clickHistory) rotator.clickHistory = [];
  rotator.clickHistory.push({
    ts: Date.now(),
    linkIndex: idx,
    url: target.url
  });
  if (rotator.clickHistory.length > 500) {
    rotator.clickHistory = rotator.clickHistory.slice(-500);
  }

  saveData(data);
  res.redirect(target.url);
});

// ─── API ──────────────────────────────────────────────────────────────────────

// List all rotators
app.get('/api/rotators', authMiddleware, (req, res) => {
  const data = loadData();
  res.json(data.rotators);
});

// Create rotator
app.post('/api/rotators', authMiddleware, (req, res) => {
  const { name, links } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Nombre requerido' });
  }
  if (!Array.isArray(links) || links.length < 1) {
    return res.status(400).json({ error: 'Se necesita al menos 1 link' });
  }

  const data = loadData();
  const id = generateId();
  const slug = generateSlug(name.trim());

  const rotator = {
    id,
    slug,
    name: name.trim(),
    links: links.map((l, i) => ({
      id: generateId(),
      label: (l.label || '').trim() || `Link ${i + 1}`,
      url: l.url.trim(),
      clicks: 0
    })),
    totalClicks: 0,
    currentIndex: 0,
    clickHistory: [],
    createdAt: new Date().toISOString()
  };

  data.rotators.unshift(rotator);
  saveData(data);
  res.status(201).json(rotator);
});

// Get single rotator
app.get('/api/rotators/:id', authMiddleware, (req, res) => {
  const data = loadData();
  const rotator = data.rotators.find(r => r.id === req.params.id);
  if (!rotator) return res.status(404).json({ error: 'No encontrado' });
  res.json(rotator);
});

// Update rotator (name + links)
app.put('/api/rotators/:id', authMiddleware, (req, res) => {
  const { name, links } = req.body;
  const data = loadData();
  const idx = data.rotators.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });

  const rotator = data.rotators[idx];

  if (name && name.trim()) rotator.name = name.trim();

  if (Array.isArray(links)) {
    rotator.links = links.map((l, i) => ({
      id: l.id || generateId(),
      label: (l.label || '').trim() || `Link ${i + 1}`,
      url: l.url.trim(),
      clicks: l.clicks || 0
    }));
    rotator.currentIndex = 0;
  }

  saveData(data);
  res.json(rotator);
});

// Delete rotator
app.delete('/api/rotators/:id', authMiddleware, (req, res) => {
  const data = loadData();
  const idx = data.rotators.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  data.rotators.splice(idx, 1);
  saveData(data);
  res.json({ ok: true });
});

// Reset stats for a rotator
app.post('/api/rotators/:id/reset', authMiddleware, (req, res) => {
  const data = loadData();
  const rotator = data.rotators.find(r => r.id === req.params.id);
  if (!rotator) return res.status(404).json({ error: 'No encontrado' });

  rotator.totalClicks = 0;
  rotator.currentIndex = 0;
  rotator.clickHistory = [];
  rotator.links.forEach(l => { l.clicks = 0; });

  saveData(data);
  res.json(rotator);
});

// ─── Catch-all → dashboard ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LinkRota corriendo en http://localhost:${PORT}`);
});
