const { createClient } = require('@supabase/supabase-js');

let client;

function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

function db() { return getClient().from('settings'); }
function sub() { return getClient().from('submissions'); }

let ready;

function init() {
  if (!ready) {
    ready = (async () => {
      try {
        await getClient().rpc('exec_sql', {
          query: `
            CREATE TABLE IF NOT EXISTS settings (
              key   TEXT PRIMARY KEY,
              value TEXT
            );
            CREATE TABLE IF NOT EXISTS submissions (
              id         SERIAL PRIMARY KEY,
              name       TEXT NOT NULL,
              phone      TEXT NOT NULL,
              email      TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
            );
          `
        });
      } catch (e) {
        console.error('Table init failed (run SQL manually in Supabase):', e.message);
      }
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
  const { data } = await db().select('key, value');
  if (data) for (const row of data) defaults[row.key] = row.value;
  return defaults;
}

async function setSetting(key, value) {
  await init();
  const val = value == null ? '' : String(value);
  const { data: existing } = await db().select('key').eq('key', key).limit(1);
  if (existing && existing.length > 0) {
    await db().update({ value: val }).eq('key', key);
  } else {
    await db().insert({ key, value: val });
  }
}

async function getAllSubmissions() {
  await init();
  const { data } = await sub().select('*').order('id', { ascending: false });
  return data || [];
}

async function addSubmission(name, phone, email) {
  await init();
  const { data, error } = await sub()
    .insert({ name, phone, email })
    .select('id, name, phone, email, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function deleteSubmission(id) {
  await init();
  await sub().delete().eq('id', id);
}

async function deleteAllSubmissions() {
  await init();
  await sub().delete().neq('id', 0);
}

module.exports = { getSettings, setSetting, getAllSubmissions, addSubmission, deleteSubmission, deleteAllSubmissions };
