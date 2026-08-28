const { neon } = require('@neondatabase/serverless');

let client;

function getSql() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing DATABASE_URL');
    client = neon(url);
  }
  return client;
}

function sql(strings, ...values) {
  return getSql()(strings, ...values);
}

let ready;

function init() {
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )`;
      await sql`CREATE TABLE IF NOT EXISTS submissions (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        phone      TEXT NOT NULL,
        email      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      )`;
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
  const { rows } = await sql`SELECT key, value FROM settings`;
  for (const row of rows) defaults[row.key] = row.value;
  return defaults;
}

async function setSetting(key, value) {
  await init();
  const val = value == null ? '' : String(value);
  await sql`INSERT INTO settings (key, value) VALUES (${key}, ${val}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

async function getAllSubmissions() {
  await init();
  const { rows } = await sql`SELECT * FROM submissions ORDER BY id DESC`;
  return rows;
}

async function addSubmission(name, phone, email) {
  await init();
  const { rows } = await sql`INSERT INTO submissions (name, phone, email) VALUES (${name}, ${phone}, ${email}) RETURNING id, name, phone, email, created_at`;
  return rows[0];
}

async function deleteSubmission(id) {
  await init();
  await sql`DELETE FROM submissions WHERE id = ${id}`;
}

async function deleteAllSubmissions() {
  await init();
  await sql`DELETE FROM submissions`;
}

module.exports = { getSettings, setSetting, getAllSubmissions, addSubmission, deleteSubmission, deleteAllSubmissions };
