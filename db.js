const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (url) {
      pool = mysql.createPool(url);
    } else {
      pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'qrform'
      });
    }
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

let ready;

async function init() {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS settings (
          \`key\`   VARCHAR(255) PRIMARY KEY,
          value    TEXT
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS submissions (
          id         INT AUTO_INCREMENT PRIMARY KEY,
          name       VARCHAR(255) NOT NULL,
          phone      VARCHAR(255) NOT NULL,
          email      VARCHAR(255) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    })();
  }
  return ready;
}

async function getSettings() {
  await init();
  const defaults = {
    form_title: 'Payment & Registration',
    form_description: 'Scan the QR code to pay, then fill in your details below.',
    redirect_url: '',
    qr_path: '',
    google_sheets_url: ''
  };
  const rows = await query('SELECT \`key\`, value FROM settings');
  for (const row of rows) defaults[row.key] = row.value;
  return defaults;
}

async function setSetting(key, value) {
  await init();
  const val = value == null ? '' : String(value);
  await query(
    'INSERT INTO settings (\`key\`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, val]
  );
}

async function getAllSubmissions() {
  await init();
  return query('SELECT * FROM submissions ORDER BY id DESC');
}

async function addSubmission(name, phone, email) {
  await init();
  const info = await query(
    'INSERT INTO submissions (name, phone, email) VALUES (?, ?, ?)',
    [name, phone, email]
  );
  const rows = await query('SELECT id, name, phone, email, created_at FROM submissions WHERE id = ?', [info.insertId]);
  return rows[0];
}

async function deleteSubmission(id) {
  await init();
  await query('DELETE FROM submissions WHERE id = ?', [id]);
}

async function deleteAllSubmissions() {
  await init();
  await query('DELETE FROM submissions');
}

module.exports = { getSettings, setSetting, getAllSubmissions, addSubmission, deleteSubmission, deleteAllSubmissions };
