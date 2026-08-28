const { neon } = require('@neondatabase/serverless');

let client;

function getSql() {
  if (!client) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
    if (!url) throw new Error('Missing database connection string (set DATABASE_URL)');
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

module.exports = { sql, init };
