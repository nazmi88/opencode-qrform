const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { put, del } = require('@vercel/blob');

const { sql, init } = require('./db');

const app = express();

const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------------------------------------------------------------------------
// Sessions (simple in-memory token store)
// ---------------------------------------------------------------------------
const sessions = new Set();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function requireAdmin(req, res, next) {
  if (sessions.has(parseCookies(req).admin_token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// Uploads (QR code image -> Vercel Blob)
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
function defaultSettings() {
  return {
    form_title: 'Payment & Registration',
    form_description: 'Scan the QR code to pay, then fill in your details below.',
    redirect_url: '',
    qr_path: '',
    google_sheets_url: ''
  };
}

async function getSettings() {
  await init();
  const s = defaultSettings();
  const { rows } = await sql`SELECT key, value FROM settings`;
  for (const row of rows) s[row.key] = row.value;
  return s;
}

async function setSetting(key, value) {
  await init();
  await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value == null ? '' : String(value)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

async function pushToGoogleSheets(row) {
  const url = (await getSettings()).google_sheets_url;
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.error('Google Sheets push failed: status', r.status);
    } else {
      console.log('Google Sheets push ok');
    }
  } catch (e) {
    console.error('Google Sheets push failed:', e.message);
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
app.get('/api/settings', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({
    form_title: s.form_title,
    form_description: s.form_description,
    qr_path: s.qr_path || null
  });
}));

app.post('/api/submit', wrap(async (req, res) => {
  const { name, phone, email } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'Email is required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  await init();
  const { rows } = await sql`INSERT INTO submissions (name, phone, email) VALUES (${String(name).trim()}, ${String(phone).trim()}, ${String(email).trim()}) RETURNING id, name, phone, email, created_at`;
  const row = rows[0];
  pushToGoogleSheets(row);

  const s = await getSettings();
  res.json({ ok: true, id: row.id, redirect_url: s.redirect_url });
}));

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.cookie('admin_token', token, { httpOnly: true, sameSite: 'strict' });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(parseCookies(req).admin_token);
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  res.json(await getSettings());
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const { form_title, form_description, redirect_url, google_sheets_url } = req.body || {};
  if (form_title !== undefined) await setSetting('form_title', form_title);
  if (form_description !== undefined) await setSetting('form_description', form_description);
  if (redirect_url !== undefined) await setSetting('redirect_url', redirect_url);
  if (google_sheets_url !== undefined) await setSetting('google_sheets_url', google_sheets_url);
  res.json({ ok: true, settings: await getSettings() });
}));

app.post('/api/admin/qr', requireAdmin, upload.single('qr'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const filename = `qr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const blob = await put(filename, req.file.buffer, {
    access: 'public',
    contentType: req.file.mimetype,
    addRandomSuffix: false
  });

  const old = (await getSettings()).qr_path;
  if (old) await del(old).catch(() => {});

  await setSetting('qr_path', blob.url);
  res.json({ ok: true, qr_path: blob.url });
}));

app.delete('/api/admin/qr', requireAdmin, wrap(async (req, res) => {
  const old = (await getSettings()).qr_path;
  if (old) await del(old).catch(() => {});
  await setSetting('qr_path', '');
  res.json({ ok: true });
}));

app.get('/api/admin/submissions', requireAdmin, wrap(async (req, res) => {
  await init();
  const { rows } = await sql`SELECT * FROM submissions ORDER BY id DESC`;
  res.json({ rows });
}));

app.post('/api/admin/test-sheets', requireAdmin, wrap(async (req, res) => {
  const url = (await getSettings()).google_sheets_url;
  if (!url) return res.status(400).json({ error: 'No Google Sheets URL configured' });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TEST', phone: '000', email: 'test@example.com', created_at: new Date().toLocaleString() }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (r.ok) return res.json({ ok: true });
    return res.status(400).json({ error: 'Google Sheets returned status ' + r.status });
  } catch (e) {
    return res.status(400).json({ error: 'Request failed: ' + e.message });
  }
}));

app.delete('/api/admin/submissions/:id', requireAdmin, wrap(async (req, res) => {
  await init();
  await sql`DELETE FROM submissions WHERE id = ${Number(req.params.id)}`;
  res.json({ ok: true });
}));

app.delete('/api/admin/submissions', requireAdmin, wrap(async (req, res) => {
  await init();
  await sql`DELETE FROM submissions`;
  res.json({ ok: true });
}));

app.get('/api/admin/export', requireAdmin, wrap(async (req, res) => {
  await init();
  const { rows } = await sql`SELECT id, name, phone, email, created_at FROM submissions ORDER BY id DESC`;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'name', 'phone', 'email', 'created_at'].map(esc).join(',');
  const lines = rows.map((r) => [r.id, r.name, r.phone, r.email, r.created_at].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
  res.send('\uFEFF' + [header, ...lines].join('\r\n'));
}));

// ---------------------------------------------------------------------------
// Static files (fallback when Vercel CDN static serving doesn't kick in)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'style.css'));
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use('/api', (err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Request failed' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Buyer form : http://localhost:${PORT}/`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html (password: ${ADMIN_PASSWORD})`);
  });
}

module.exports = app;
