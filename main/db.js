// main/db.js — sql.js (WASM SQLite) wrapper, file persistence
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  relationship TEXT,
  likes_json   TEXT NOT NULL DEFAULT '[]',
  taboos_json  TEXT NOT NULL DEFAULT '[]',
  gifts_json   TEXT NOT NULL DEFAULT '[]',
  listed       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS important_dates (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  day         INTEGER NOT NULL,
  month       INTEGER NOT NULL,
  year        INTEGER,
  kind        TEXT NOT NULL DEFAULT 'birthday',
  remind_time TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imp_dates_contact ON important_dates(contact_id);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  remind        INTEGER NOT NULL DEFAULT 0,
  remind_kind   TEXT NOT NULL DEFAULT 'one_time',
  remind_time   TEXT,
  remind_date   TEXT,
  next_fire_at  TEXT,
  last_fired_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_next_fire ON events(next_fire_at);
CREATE INDEX IF NOT EXISTS idx_events_contact    ON events(contact_id);

CREATE TABLE IF NOT EXISTS contact_attributes (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('like','taboo','gift')),
  description TEXT NOT NULL DEFAULT '',
  event       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attrs_contact ON contact_attributes(contact_id);
CREATE INDEX IF NOT EXISTS idx_attrs_kind    ON contact_attributes(kind);

CREATE TABLE IF NOT EXISTS reminder_acks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  acked_at    TEXT NOT NULL,
  next_fire_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_acks_source ON reminder_acks(source, source_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_index (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  body   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_search_kind_ref ON search_index(kind, ref_id);
`;

let db = null;
let dbPath = null;
let dirty = false;
let saveTimer = null;

function stmtToObjects(s) {
  const out = [];
  while (s.step()) {
    out.push(s.getAsObject());
  }
  s.free();
  return out;
}

function stmtAllRows(s) {
  const cols = s.getColumnNames();
  const out = [];
  while (s.step()) {
    const row = s.get();
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    out.push(obj);
  }
  s.free();
  return out;
}

async function open(dbPathArg) {
  dbPath = dbPathArg;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  let bytes;
  if (fs.existsSync(dbPath)) {
    bytes = fs.readFileSync(dbPath);
  }
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run(SCHEMA);
  migrateContactsV2();
  migrateAttributesV1();

  // Settings defaults
  const s = db.prepare('SELECT value FROM settings WHERE key = ?');
  s.bind(['pet_x']);
  if (!s.step()) {
    db.run("INSERT INTO settings(key, value) VALUES ('pet_x', '200'), ('pet_y', '200'), ('pet_scale', '100')");
  }
  s.free();

  // Force a save on first boot after a schema upgrade. CREATE TABLE IF NOT
  // EXISTS is idempotent but it's still a structural change that needs to
  // hit disk before the next launch — otherwise a fresh open() will re-run
  // the schema and re-add the missing tables every time. Marking dirty
  // ensures scheduleSave() flushes within 5 seconds.
  dirty = true;
  scheduleSave();
  return db;
}

function get() { return db; }

function newId() {
  return require('crypto').randomUUID();
}

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function save() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  dirty = false;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (dirty) save();
    saveTimer = setTimeout(scheduleSave, 5000);
  }, 5000);
}

function markDirty() { dirty = true; }

// Helpers
function prep(sql) {
  if (!db) throw new Error('DB not opened');
  return db.prepare(sql);
}
function all(sql, params = []) {
  const s = prep(sql);
  s.bind(params);
  return stmtAllRows(s);
}
function one(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
  markDirty();
}

function upsertSearch(kind, refId, body) {
  if (!db) return;
  try {
    run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', [kind, refId]);
    run('INSERT INTO search_index(kind, ref_id, body) VALUES (?, ?, ?)', [kind, refId, body || '']);
  } catch (e) {
    // Search index is a best-effort cache — never let it break the primary
    // create/update IPC handlers. (Previously this would throw if the table
    // was missing or had a schema mismatch, cascading to a 500-style failure
    // for the renderer.)
    console.error('upsertSearch failed:', e);
  }
}

function deleteSearch(kind, refId) {
  try {
    run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', [kind, refId]);
  } catch (e) {
    console.error('deleteSearch failed:', e);
  }
}

function getSetting(key) {
  if (!db) return null;
  const r = one('SELECT value FROM settings WHERE key = ?', [key]);
  return r ? r.value : null;
}

function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  markDirty();
}

// ---- Contacts v2 migration ----
// Adds name/relationship/likes_json/taboos_json/gifts_json columns to existing
// contacts tables, backfills `name` from the legacy first_name/last_name/nickname
// columns, then reindexes the search_index once (guarded by a settings key so
// it does not re-run on every boot).
function migrateContactsV2() {
  if (!db) return;
  const cols = db.prepare("PRAGMA table_info(contacts)");
  const names = new Set();
  while (cols.step()) names.add(cols.get()[1]);
  cols.free();

  if (!names.has('name')) {
    db.run("ALTER TABLE contacts ADD COLUMN name         TEXT NOT NULL DEFAULT ''");
    db.run("ALTER TABLE contacts ADD COLUMN relationship TEXT");
    db.run("ALTER TABLE contacts ADD COLUMN likes_json   TEXT NOT NULL DEFAULT '[]'");
    db.run("ALTER TABLE contacts ADD COLUMN taboos_json  TEXT NOT NULL DEFAULT '[]'");
    db.run("ALTER TABLE contacts ADD COLUMN gifts_json   TEXT NOT NULL DEFAULT '[]'");
    // Backfill `name` from legacy columns. CONCAT preserves NULLs so we trim
    // before NULLIF — old rows where both first and last are empty fall back to
    // nickname; rows where everything is empty stay '' (displayName will render
    // "(无名)").
    db.run(
      `UPDATE contacts
         SET name = NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')
       WHERE (COALESCE(first_name,'') <> '' OR COALESCE(last_name,'') <> '')
         AND (name IS NULL OR name = '')`
    );
    db.run(
      `UPDATE contacts SET name = COALESCE(nickname, '')
       WHERE (name IS NULL OR name = '') AND COALESCE(nickname,'') <> ''`
    );
    markDirty();
  }

  // Rebuild search_index for all listed contacts once after the upgrade so the
  // search body matches the new schema. Guarded so it does not run on every
  // boot.
  if (getSetting('schema_v2_applied') !== '1') {
    try {
      const rows = all('SELECT * FROM contacts WHERE listed = 1');
      for (const r of rows) {
        const c = parseContactRow(r);
        const body = buildContactBody(c);
        upsertSearch('contact', c.id, body);
      }
      setSetting('schema_v2_applied', '1');
    } catch (e) {
      console.error('contacts v2 search reindex failed:', e);
    }
  }
}

function safeParseArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Drop the `_json` columns from a contact row before exposing it to the
// renderer. The renderer never sees raw JSON strings or the parsed arrays —
// likes / taboos / gifts now live in the `contact_attributes` table and are
// fetched via the attributes:* IPC handlers. The JSON columns are still kept
// on disk for search backwards-compat (see buildContactBody + migrateAttributesV1).
function parseContactRow(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.likes_json;
  delete out.taboos_json;
  delete out.gifts_json;
  return out;
}

// Flatten contact fields into a single string for the legacy search_index
// cache. Used by migrateContactsV2, migrateAttributesV1, and by the
// contacts:create / contacts:update IPC handlers — see main/ipc.js.
//
// Reads from contact_attributes (the new global table) rather than the
// embedded JSON columns so newly-added likes/taboos/gifts are searchable
// right after the migration runs.
function buildContactBody(c) {
  const parts = [c && c.name, c && c.relationship];
  if (c && c.id) {
    const rows = all(
      `SELECT description FROM contact_attributes
       WHERE contact_id = ? AND description <> ''`,
      [c.id]
    );
    for (const r of rows) parts.push(r.description);
  }
  return parts.filter(Boolean).join(' ');
}

// ---- contact_attributes v1 migration ----
// One-shot import from the legacy contacts.likes_json / taboos_json /
// gifts_json columns into the new contact_attributes table. Guarded by a
// settings key so it never re-runs. After this runs the JSON columns still
// exist on disk (for compatibility / future cleanup) but are no longer the
// source of truth for the UI.
function migrateAttributesV1() {
  if (!db) return;
  if (getSetting('attributes_v1_applied') === '1') return;

  // Defensive: if SCHEMA somehow didn't create the table yet, create it now.
  db.run(`CREATE TABLE IF NOT EXISTS contact_attributes (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('like','taboo','gift')),
    description TEXT NOT NULL DEFAULT '',
    event TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const KIND_TO_COL = { like: 'likes_json', taboo: 'taboos_json', gift: 'gifts_json' };
  const contacts = all('SELECT id, likes_json, taboos_json, gifts_json FROM contacts');
  const now = nowStr();
  for (const c of contacts) {
    for (const kind of ['like', 'taboo', 'gift']) {
      const arr = safeParseArray(c[KIND_TO_COL[kind]]);
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const desc = typeof it.description === 'string' ? it.description.trim() : '';
        if (!desc) continue;
        const event = typeof it.event === 'string' && it.event.trim() ? it.event.trim() : null;
        run(
          `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [newId(), c.id, kind, desc, event, now, now]
        );
      }
    }
  }

  // Rebuild search_index for every listed contact so migrated entries are
  // discoverable via the LIKE-based search.
  const listed = all('SELECT * FROM contacts WHERE listed = 1');
  for (const r of listed) {
    const parsed = parseContactRow(r);
    upsertSearch('contact', parsed.id, buildContactBody(parsed));
  }

  setSetting('attributes_v1_applied', '1');
}

// List contact_attributes of a given kind, joined with the parent contact.
// `opts.contact_id` scopes to a single contact (used by contact-detail).
function listAttributes(kind, opts = {}) {
  const args = [kind];
  let where = 'a.kind = ?';
  if (opts.contact_id) { where += ' AND a.contact_id = ?'; args.push(opts.contact_id); }
  return all(
    `SELECT a.id, a.contact_id, a.kind, a.description, a.event,
            a.created_at, a.updated_at,
            c.name AS contact_name, c.relationship AS contact_relationship,
            c.listed AS contact_listed
       FROM contact_attributes a
       JOIN contacts c ON c.id = a.contact_id
      WHERE ${where}
      ORDER BY (a.event IS NULL), a.event DESC, a.created_at DESC`,
    args
  );
}

function getAttribute(id) {
  return one('SELECT * FROM contact_attributes WHERE id = ?', [id]);
}

module.exports = {
  open, get, save, newId, nowStr, all, one, run,
  upsertSearch, deleteSearch, getSetting, setSetting,
  markDirty,
  parseContactRow, buildContactBody, safeParseArray,
  listAttributes, getAttribute,
};