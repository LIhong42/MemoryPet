// main/db.js — sql.js (WASM SQLite) wrapper, file persistence
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY,
  first_name   TEXT NOT NULL DEFAULT '',
  last_name    TEXT NOT NULL DEFAULT '',
  nickname     TEXT,
  company      TEXT,
  job_position TEXT,
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

module.exports = {
  open, get, save, newId, nowStr, all, one, run,
  upsertSearch, deleteSearch, getSetting, setSetting,
  markDirty,
};