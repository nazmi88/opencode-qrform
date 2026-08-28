const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const db = require('./db');

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
// Uploads (QR code image)
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `qr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
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
    qr_path: null,
    google_sheets_url: ''
  };
}

function getSettings() {
  const s = defaultSettings();
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    s[row.key] = row.value;
  }
  return s;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

async function pushToGoogleSheets(row) {
  const url = getSettings().google_sheets_url;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({
    form_title: s.form_title,
    form_description: s.form_description,
    qr_path: s.qr_path
  });
});

app.post('/api/submit', (req, res) => {
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

  const info = db.prepare('INSERT INTO submissions (name, phone, email) VALUES (?, ?, ?)')
    .run(String(name).trim(), String(phone).trim(), String(email).trim());

  const row = db.prepare('SELECT id, name, phone, email, created_at FROM submissions WHERE id = ?')
    .get(info.lastInsertRowid);
  pushToGoogleSheets(row);

  const s = getSettings();
  res.json({ ok: true, id: info.lastInsertRowid, redirect_url: s.redirect_url });
});

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

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(getSettings());
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { form_title, form_description, redirect_url, google_sheets_url } = req.body || {};
  if (form_title !== undefined) setSetting('form_title', form_title);
  if (form_description !== undefined) setSetting('form_description', form_description);
  if (redirect_url !== undefined) setSetting('redirect_url', redirect_url);
  if (google_sheets_url !== undefined) setSetting('google_sheets_url', google_sheets_url);
  res.json({ ok: true, settings: getSettings() });
});

app.post('/api/admin/qr', requireAdmin, upload.single('qr'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const old = getSettings().qr_path;
  if (old) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(old)), () => {});
  }

  setSetting('qr_path', '/uploads/' + req.file.filename);
  res.json({ ok: true, qr_path: '/uploads/' + req.file.filename });
});

app.delete('/api/admin/qr', requireAdmin, (req, res) => {
  const old = getSettings().qr_path;
  if (old) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(old)), () => {});
  }
  setSetting('qr_path', null);
  res.json({ ok: true });
});

app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY id DESC').all();
  res.json({ rows });
});

app.post('/api/admin/test-sheets', requireAdmin, async (req, res) => {
  const url = getSettings().google_sheets_url;
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
});

app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/submissions', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM submissions').run();
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, phone, email, created_at FROM submissions ORDER BY id DESC').all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'name', 'phone', 'email', 'created_at'].map(esc).join(',');
  const lines = rows.map((r) => [r.id, r.name, r.phone, r.email, r.created_at].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
  res.send('\uFEFF' + [header, ...lines].join('\r\n'));
});

// ---------------------------------------------------------------------------
// Static files & error handling
// ---------------------------------------------------------------------------
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

app.use('/api', (err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Request failed' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Buyer form : http://localhost:${PORT}/`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html (password: ${ADMIN_PASSWORD})`);
});
