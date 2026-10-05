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
  -- ON DELETE CASCADE: when a contact is deleted, any events that reference
  -- ONLY that contact should be removed too (the contact's preferences and
  -- important context go with them). If a future schema introduces an
  -- event_contacts many-to-many table, that table will own the relationship
  -- and the deletion logic in deleteContactCascade will skip events that
  -- are still referenced by other contacts.
  contact_id    TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  remind        INTEGER NOT NULL DEFAULT 0,
  remind_kind   TEXT NOT NULL DEFAULT 'one_time',
  remind_time   TEXT,
  remind_date   TEXT,
  next_fire_at  TEXT,
  last_fired_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  category      TEXT NOT NULL DEFAULT 'general',
  tag_kind      TEXT,
  lunar_month   INTEGER,
  lunar_day     INTEGER,
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

-- Memorial events: independent from the reminder events table. They record
-- "what happened, when, with whom" instead of "when to fire a reminder".
-- No remind/remind_kind/lunar_*/next_fire_at fields — the scheduler never
-- reads this table. See the migration in migrateMemorialEventsV1 for the
-- runtime CREATE statements that run alongside the schema above.
CREATE TABLE IF NOT EXISTS memorial_events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other')),
  title       TEXT NOT NULL,
  -- The five user-facing fields that replace the legacy single description
  -- text column. All nullable; the form lets the user skip any of them.
  place       TEXT,
  food        TEXT,
  outfit      TEXT,
  activities  TEXT,
  notes       TEXT,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memorial_events_occurred_at ON memorial_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memorial_events_kind        ON memorial_events(kind);

CREATE TABLE IF NOT EXISTS memorial_event_contacts (
  memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
  contact_id        TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (memorial_event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_mec_contact ON memorial_event_contacts(contact_id);

CREATE TABLE IF NOT EXISTS memorial_event_photos (
  id                TEXT PRIMARY KEY,
  memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
  relative_path     TEXT NOT NULL,
  original_name     TEXT,
  mime              TEXT,
  size_bytes        INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mep_event ON memorial_event_photos(memorial_event_id);
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
  migrateEventsCategoryV1();
  migrateEventsTagKindV1();
  migrateEventsContactCascadeV1();
  migrateMemorialEventsV1();
  migrateMemorialEventsV2();
  seedDefaultFestivals();

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

// Hard-delete a contact and every row that references it.
//
// Why this exists:
//   * The schema already declares ON DELETE CASCADE on important_dates and
//     contact_attributes, so SQLite would clean those up automatically if we
//     simply ran `DELETE FROM contacts WHERE id = ?`. We don't rely on that
//     alone because:
//       - `events.contact_id` is the one relationship that is *not* safe to
//         cascade unconditionally. The user explicitly asked for events tied
//         to this contact to be removed UNLESS the event is also tied to other
//         contacts. Today's schema only stores a single contact_id per event,
//         so in practice this means "delete the event"; but the helper checks
//         a sibling `event_contacts` table (if present) so the same logic
//         keeps working when many-to-many is added later.
//       - search_index rows are not FK-linked, so we have to delete them
//         manually.
//       - reminder_acks and active reminder queue entries are not FK-linked
//         either; we want to drop them so dismissed/snoozed state doesn't
//         resurrect after a contact is gone.
//   * This is called from the ipc handler `contacts:delete` with the
//     caller-provided `queue` so we can prune live reminders without reaching
//     across module boundaries.
//
// Returns a small summary the renderer can show ("已删除：1 联系人 / 12 偏好
// 条目 / 3 事件 / …") so the user has a clear confirmation of what was
// removed.
function deleteContactCascade(id, queue) {
  if (!db) throw new Error('DB not opened');
  const c = one('SELECT * FROM contacts WHERE id = ?', [id]);
  if (!c) {
    return { deleted: false, summary: null };
  }

  // Snapshot the affected ids BEFORE we start deleting so the summary
  // reflects what we touched (not what's left after).
  const attrIds = all(
    'SELECT id FROM contact_attributes WHERE contact_id = ?', [id]
  ).map((r) => r.id);
  const dateIds = all(
    'SELECT id FROM important_dates WHERE contact_id = ?', [id]
  ).map((r) => r.id);

  // ---- Events: pick out the ones to delete vs. ones to keep ----
  // Today's schema only has events.contact_id (a single FK), so every event
  // tied to this contact is exclusively tied to this contact — delete them
  // all. If a future schema adds an `event_contacts` many-to-many table, we
  // keep events that are still referenced by at least one other contact.
  //
  // We probe for the table dynamically so this helper stays correct whether
  // or not the migration has been applied. A missing table is the common
  // case (current schema) and falls through to "delete everything".
  const ownedEventIds = all(
    'SELECT id FROM events WHERE contact_id = ?', [id]
  ).map((r) => r.id);
  const eventIdsToDelete = (() => {
    let hasJoin = false;
    try {
      hasJoin = !!one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='event_contacts'"
      );
    } catch { /* pragma probe failed — treat as no join table */ }
    if (!hasJoin) return ownedEventIds;

    const keep = new Set();
    for (const eid of ownedEventIds) {
      const other = one(
        'SELECT 1 FROM event_contacts WHERE event_id = ? AND contact_id != ? LIMIT 1',
        [eid, id]
      );
      if (other) keep.add(eid);
    }
    return ownedEventIds.filter((eid) => !keep.has(eid));
  })();
  const keptEventIds = ownedEventIds.filter((eid) => !eventIdsToDelete.includes(eid));

  // ---- Delete in FK-safe order ----
  // Reminder acks for events/dates we're about to remove — clearing these
  // first means the scheduler / pet state never sees dangling source_ids.
  if (eventIdsToDelete.length) {
    const placeholders = eventIdsToDelete.map(() => '?').join(',');
    run(
      `DELETE FROM reminder_acks
        WHERE (source = 'event' AND source_id IN (${placeholders}))`,
      eventIdsToDelete
    );
  }
  if (dateIds.length) {
    const placeholders = dateIds.map(() => '?').join(',');
    run(
      `DELETE FROM reminder_acks
        WHERE (source = 'important_date' AND source_id IN (${placeholders}))`,
      dateIds
    );
  }
  // search_index cleanup. events/dates/attrs also have rows here; the FK
  // cascade on contacts will drop contact rows via deleteSearch below, but
  // events and important_dates are not FK-linked to contacts so we have to
  // remove them by hand. Attribute rows aren't indexed (only the contact
  // body includes them via buildContactBody) so no per-attribute search
  // cleanup is needed.
  deleteSearch('contact', id);
  for (const eid of eventIdsToDelete) deleteSearch('event', eid);
  for (const did of dateIds)        deleteSearch('important_date', did);

  // Drop live reminder queue entries the same way so the pet UI doesn't
  // keep nagging about a contact that no longer exists.
  if (queue && typeof queue.remove === 'function') {
    for (const eid of eventIdsToDelete) queue.remove('event', eid);
    for (const did of dateIds)        queue.remove('important_date', did);
  }

  // Now the actual hard delete. SQLite handles important_dates and
  // contact_attributes via their ON DELETE CASCADE declarations; we don't
  // need to issue those deletes ourselves. We DO need to delete events we
  // own — and once events are gone, the FK cascade on contacts will let
  // SQLite drop the contact row itself. We do the contact DELETE last so a
  // mid-cascade failure leaves us in a recoverable state.
  if (eventIdsToDelete.length) {
    const placeholders = eventIdsToDelete.map(() => '?').join(',');
    run(`DELETE FROM events WHERE id IN (${placeholders})`, eventIdsToDelete);
  }
  // Set any remaining events to NULL (won't happen under current schema, but
  // covers the case where a future many-to-many migration temporarily leaves
  // a contact_id dangling before cleanup).
  if (keptEventIds.length) {
    const placeholders = keptEventIds.map(() => '?').join(',');
    run(
      `UPDATE events SET contact_id = NULL WHERE id IN (${placeholders})`,
      keptEventIds
    );
  }
  run('DELETE FROM contacts WHERE id = ?', [id]);

  return {
    deleted: true,
    summary: {
      contact: 1,
      attributes: attrIds.length,
      important_dates: dateIds.length,
      events: eventIdsToDelete.length,
      events_kept: keptEventIds.length,
    },
  };
}

// ---- events v1 migration ----
// Adds `category` (default 'general'), `lunar_month`, `lunar_day` columns to
// existing events tables. Guarded by a settings key so it never re-runs.
function migrateEventsCategoryV1() {
  if (!db) return;
  if (getSetting('events_category_v1_applied') === '1') return;

  const cols = db.prepare("PRAGMA table_info(events)");
  const names = new Set();
  while (cols.step()) names.add(cols.get()[1]);
  cols.free();

  try {
    if (!names.has('category')) {
      // NOT NULL with DEFAULT — backfills existing rows with 'general'.
      db.run("ALTER TABLE events ADD COLUMN category    TEXT NOT NULL DEFAULT 'general'");
    }
    if (!names.has('lunar_month')) {
      db.run("ALTER TABLE events ADD COLUMN lunar_month INTEGER");
    }
    if (!names.has('lunar_day')) {
      db.run("ALTER TABLE events ADD COLUMN lunar_day   INTEGER");
    }
    // Index on the new column — created here (not in SCHEMA) so it does
    // not fail on pre-existing DBs that lack the column. SCHEMA runs first
    // and would abort on "no such column: category" before the ALTER TABLE
    // below could add it.
    db.run("CREATE INDEX IF NOT EXISTS idx_events_category ON events(category)");
    setSetting('events_category_v1_applied', '1');
  } catch (e) {
    console.error('events v1 migration failed:', e);
  }
}

// ---- events v2 migration ----
// Adds `tag_kind` column (one of 'birthday' / 'anniversary' / 'festival' / null).
// Distinct from the schema-level CREATE TABLE so a fresh DB doesn't trip on
// the same "no such column" race as v1.
function migrateEventsTagKindV1() {
  if (!db) return;
  if (getSetting('events_tag_kind_v1_applied') === '1') return;

  const cols = db.prepare("PRAGMA table_info(events)");
  const names = new Set();
  while (cols.step()) names.add(cols.get()[1]);
  cols.free();

  try {
    if (!names.has('tag_kind')) {
      db.run("ALTER TABLE events ADD COLUMN tag_kind TEXT");
    }
    setSetting('events_tag_kind_v1_applied', '1');
  } catch (e) {
    console.error('events tag_kind v1 migration failed:', e);
  }
}

// ---- events v3 migration ----
// Rebuild the events table so the foreign key on contact_id is
// ON DELETE CASCADE instead of ON DELETE SET NULL. SQLite does not support
// changing a foreign key's ON DELETE action in place, so the migration is
// a "rebuild under a temporary name" dance:
//
//   1. Disable foreign keys (PRAGMA deferral won't help — the FK action is
//      metadata and we need the rebuild to commit).
//   2. CREATE events_new with the desired schema.
//   3. INSERT … SELECT every row from the old events table.
//   4. DROP the old events table.
//   5. Rename events_new → events.
//   6. Recreate the indexes that lived on the old table.
//   7. Re-enable foreign keys.
//
// Why we need this at all: the user asked for "delete a contact → also
// delete its events". The v1 schema's ON DELETE SET NULL orphaned every
// event instead of removing it, which silently kept dozens of reminder
// rows alive after a contact disappeared. CASCADE makes the contract
// match the user's expectation.
//
// Guarded by `events_fk_cascade_applied` so it only runs once per DB.
function migrateEventsContactCascadeV1() {
  if (!db) return;
  if (getSetting('events_fk_cascade_applied') === '1') return;

  // Probe the existing FK action. sqlite_master doesn't expose it directly,
  // so we check the foreign_key_list pragma against the source pragma on
  // the contact_id column. The pragma returns the on_delete string for the
  // FK that owns the given child column.
  let needsRebuild = false;
  try {
    const s = db.prepare("PRAGMA foreign_key_list(events)");
    while (s.step()) {
      const row = s.getAsObject();
      if (row.from === 'contact_id' && row.on_delete !== 'CASCADE') {
        needsRebuild = true;
        break;
      }
    }
    s.free();
  } catch (e) {
    console.error('events fk probe failed:', e);
    return; // can't determine — leave the schema alone, don't loop on boot
  }

  if (!needsRebuild) {
    setSetting('events_fk_cascade_applied', '1');
    return;
  }

  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run('BEGIN');
    db.run(`
      CREATE TABLE events_new (
        id            TEXT PRIMARY KEY,
        contact_id    TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT,
        remind        INTEGER NOT NULL DEFAULT 0,
        remind_kind   TEXT NOT NULL DEFAULT 'one_time',
        remind_time   TEXT,
        remind_date   TEXT,
        next_fire_at  TEXT,
        last_fired_at TEXT,
        active        INTEGER NOT NULL DEFAULT 1,
        category      TEXT NOT NULL DEFAULT 'general',
        tag_kind      TEXT,
        lunar_month   INTEGER,
        lunar_day     INTEGER,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    db.run(`
      INSERT INTO events_new
        SELECT id, contact_id, title, description, remind, remind_kind,
               remind_time, remind_date, next_fire_at, last_fired_at, active,
               category, tag_kind, lunar_month, lunar_day, created_at, updated_at
        FROM events
    `);
    db.run('DROP TABLE events');
    db.run('ALTER TABLE events_new RENAME TO events');
    db.run('CREATE INDEX IF NOT EXISTS idx_events_next_fire ON events(next_fire_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_events_contact    ON events(contact_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_events_category   ON events(category)');
    db.run('COMMIT');
    setSetting('events_fk_cascade_applied', '1');
    markDirty();
  } catch (e) {
    try { db.run('ROLLBACK'); } catch {}
    console.error('events FK CASCADE migration failed:', e);
  } finally {
    try { db.run('PRAGMA foreign_keys = ON'); } catch {}
  }
}

// ---- memorial events v1 migration ----
// SCHEMA already declares the three tables (memorial_events, the join table
// memorial_event_contacts, and the photo metadata table memorial_event_photos)
// so a fresh DB never needs to ALTER anything. We keep a migration function
// anyway so older DBs that pre-date these tables get them created in one
// idempotent sweep, guarded by a settings key.
//
// We DO NOT auto-migrate existing events rows with category='memorial': the
// user may have relied on remind_kind=yearly / next_fire_at scheduling on
// them. We log a count so the developer sees the legacy footprint on first
// run; the rows are filtered out by ipc.js (events:list) and the renderer
// has no path to surface them.
const MEMORIAL_EVENTS_V1_KEY = 'memorial_events_v1_applied';

function migrateMemorialEventsV1() {
  if (!db) return;
  if (getSetting(MEMORIAL_EVENTS_V1_KEY) === '1') return;
  try {
    db.run(`CREATE TABLE IF NOT EXISTS memorial_events (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other')),
      title       TEXT NOT NULL,
      place       TEXT,
      food        TEXT,
      outfit      TEXT,
      activities  TEXT,
      notes       TEXT,
      occurred_at TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memorial_events_occurred_at ON memorial_events(occurred_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memorial_events_kind        ON memorial_events(kind)`);
    db.run(`CREATE TABLE IF NOT EXISTS memorial_event_contacts (
      memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
      contact_id        TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (memorial_event_id, contact_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mec_contact ON memorial_event_contacts(contact_id)`);
    db.run(`CREATE TABLE IF NOT EXISTS memorial_event_photos (
      id                TEXT PRIMARY KEY,
      memorial_event_id TEXT NOT NULL REFERENCES memorial_events(id) ON DELETE CASCADE,
      relative_path     TEXT NOT NULL,
      original_name     TEXT,
      mime              TEXT,
      size_bytes        INTEGER,
      created_at        TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mep_event ON memorial_event_photos(memorial_event_id)`);
    setSetting(MEMORIAL_EVENTS_V1_KEY, '1');
  } catch (e) {
    console.error('memorial_events v1 migration failed:', e);
    return;
  }
  try {
    const legacy = all("SELECT COUNT(*) AS n FROM events WHERE category = 'memorial'");
    const n = (legacy[0] && legacy[0].n) || 0;
    if (n > 0) {
      console.log(`[memorial migration] ${n} legacy events with category='memorial' present; hidden from list.`);
    }
  } catch {}
}

// ---- memorial events v2 migration ----
// Splits the legacy single `description TEXT` column into 5 user-facing
// fields (place / food / outfit / activities / notes). The old description
// is copied wholesale into `notes`; the other four stay NULL so the user
// can revisit each event and reclassify it later if they want.
//
// Uses the standard SQLITE table-rebuild pattern (PRAGMA-OFF / BEGIN /
// CREATE TABLE _new / INSERT…SELECT / DROP / RENAME / COMMIT) modelled on
// `migrateEventsContactCascadeV1` above. Guard key
// `memorial_events_v2_applied` so the migration runs exactly once per DB.
//
// The `description` column goes away in the new shape — any code path that
// still reads it (none in this repo) would see a SQL error, which is the
// intended loud failure.
const MEMORIAL_EVENTS_V2_KEY = 'memorial_events_v2_applied';

function migrateMemorialEventsV2() {
  if (!db) return;
  if (getSetting(MEMORIAL_EVENTS_V2_KEY) === '1') return;

  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run('BEGIN');
    db.run(`
      CREATE TABLE memorial_events_new (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('first_time','other')),
        title       TEXT NOT NULL,
        place       TEXT,
        food        TEXT,
        outfit      TEXT,
        activities  TEXT,
        notes       TEXT,
        occurred_at TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
    // Move the legacy description into `notes`. NULL for the other four
    // new fields — the user can re-categorize on next edit if they want.
    db.run(
      `INSERT INTO memorial_events_new
         (id, kind, title, place, food, outfit, activities, notes,
          occurred_at, created_at, updated_at)
       SELECT id, kind, title, NULL, NULL, NULL, NULL, description,
              occurred_at, created_at, updated_at
         FROM memorial_events`
    );
    db.run('DROP TABLE memorial_events');
    db.run('ALTER TABLE memorial_events_new RENAME TO memorial_events');
    db.run('CREATE INDEX IF NOT EXISTS idx_memorial_events_occurred_at ON memorial_events(occurred_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_memorial_events_kind        ON memorial_events(kind)');
    db.run('COMMIT');
    setSetting(MEMORIAL_EVENTS_V2_KEY, '1');
    markDirty();
    console.log('[memorial v2 migration] description split into 5 fields; old description → notes.');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch {}
    console.error('memorial_events v2 migration failed:', e);
  } finally {
    try { db.run('PRAGMA foreign_keys = ON'); } catch {}
  }
}

// ---- memorial event queries ----
// Each returned row is decorated with:
//   - contact_ids[]: ordered list of associated contact ids
//   - contact_names[]: matching display names (ordered)
//   - photo_count: number of attached photos
//   - first_photo_id + first_photo_relative_path: id and path of the
//     earliest uploaded photo. The renderer uses the id to load the bytes
//     via `memorial_events:photo_read` (CSP-safe data URL).
function listMemorialEvents(opts = {}) {
  let sql = `SELECT me.*,
                    (SELECT COUNT(*) FROM memorial_event_photos p WHERE p.memorial_event_id = me.id) AS photo_count,
                    (SELECT p.id
                       FROM memorial_event_photos p
                      WHERE p.memorial_event_id = me.id
                      ORDER BY p.created_at ASC LIMIT 1) AS first_photo_id,
                    (SELECT p.relative_path
                       FROM memorial_event_photos p
                      WHERE p.memorial_event_id = me.id
                      ORDER BY p.created_at ASC LIMIT 1) AS first_photo_relative_path
               FROM memorial_events me
              WHERE 1=1`;
  const args = [];
  if (opts.kind === 'first_time' || opts.kind === 'other') {
    sql += ' AND me.kind = ?';
    args.push(opts.kind);
  }
  if (opts.contact_id) {
    sql += ' AND EXISTS (SELECT 1 FROM memorial_event_contacts mc WHERE mc.memorial_event_id = me.id AND mc.contact_id = ?)';
    args.push(opts.contact_id);
  }
  sql += ' ORDER BY me.occurred_at DESC, me.created_at DESC';
  const rows = all(sql, args);
  for (const r of rows) {
    const links = all(
      `SELECT mc.contact_id, c.name
         FROM memorial_event_contacts mc
         JOIN contacts c ON c.id = mc.contact_id
        WHERE mc.memorial_event_id = ?
        ORDER BY c.name`,
      [r.id]
    );
    r.contact_ids = links.map((l) => l.contact_id);
    r.contact_names = links.map((l) => l.name);
  }
  return rows;
}

// Single-row fetch with full contact + photo detail. Returned shape matches
// listMemorialEvents rows plus a `photos[]` array (only here; the list page
// doesn't need the full photo list).
function getMemorialEvent(id) {
  const row = one('SELECT * FROM memorial_events WHERE id = ?', [id]);
  if (!row) return null;
  row.contact_ids = all(
    `SELECT mc.contact_id
       FROM memorial_event_contacts mc
       JOIN contacts c ON c.id = mc.contact_id
      WHERE mc.memorial_event_id = ?
      ORDER BY c.name`,
    [id]
  ).map((r) => r.contact_id);
  row.contact_names = all(
    `SELECT c.name
       FROM memorial_event_contacts mc
       JOIN contacts c ON c.id = mc.contact_id
      WHERE mc.memorial_event_id = ?
      ORDER BY c.name`,
    [id]
  ).map((r) => r.name);
  row.photos = all(
    `SELECT id, relative_path, original_name, mime, size_bytes, created_at
       FROM memorial_event_photos
      WHERE memorial_event_id = ?
      ORDER BY created_at ASC`,
    [id]
  );
  return row;
}

function listPhotosForMemorialEvent(id) {
  return all(
    `SELECT id, relative_path, original_name, mime, size_bytes, created_at
       FROM memorial_event_photos
      WHERE memorial_event_id = ?
      ORDER BY created_at ASC`,
    [id]
  );
}

// ---- default festival seed ----
// On first run (or any DB that doesn't yet have built-in festival events),
// insert one row per built-in festival with category='general',
// tag_kind='festival', title=<festival code>. All are pre-enabled by default —
// the user can delete ones they don't care about. Guarded by a settings key
// so we don't re-insert after a manual delete. (If you want to re-seed, clear
// that key — see SETTINGS_DEFAULT_FESTIVALS_KEY.)
//
// v2 adds reconciliation: rows for festival codes that are no longer in the
// built-in catalog are deleted. This handles catalog removals (e.g. dropping
// the solar 七夕节 when we switched to lunar 七夕 only) without leaving stale
// rows behind. Bumping the key ensures the cleanup runs on existing DBs.
const SETTINGS_DEFAULT_FESTIVALS_KEY = 'default_festivals_seeded_v2';

// Compute the next solar (year, month, day) for a built-in festival so we
// can pre-populate next_fire_at and remind_date. Returns null on failure.
function festivalNextYmd(code) {
  try {
    const { nextFestivalSolar } = require('./festivals');
    const solar = nextFestivalSolar(code, new Date());
    if (!solar) return null;
    return `${solar.year}-${String(solar.month).padStart(2, '0')}-${String(solar.day).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

function seedDefaultFestivals() {
  if (!db) return;
  if (getSetting(SETTINGS_DEFAULT_FESTIVALS_KEY) === '1') return;
  try {
    const { listFestivals } = require('./festivals');
    const { computeNextFireEvent, fmtDateTime } = require('./time_util');

    // Reconciliation: delete any auto-seeded festival rows whose code is no
    // longer in the built-in catalog (e.g. when a festival was retired). We
    // only touch rows the seed migration itself created — rows the user
    // added manually with tag_kind='festival' are left alone because we
    // can't reliably tell them apart from the seed at the SQL level.
    //
    // In practice all category='general' tag_kind='festival' rows are
    // seeded by this function on first run, so deleting the stale ones is
    // safe. If a user wants a custom festival row they can create one via
    // the form (which goes through a different code path and won't be hit
    // here because tag_kind is set to 'festival' only by this seed or by
    // internal callers — never from the user-facing form).
    const catalogCodes = new Set(listFestivals().map((f) => f.code));
    const stale = all(
      `SELECT id, title FROM events
         WHERE category = 'general' AND tag_kind = 'festival'`
    ).filter((r) => r.title && !catalogCodes.has(r.title));
    for (const r of stale) {
      run('DELETE FROM events WHERE id = ?', [r.id]);
      deleteSearch('event', r.id);
    }

    const existing = new Set(
      all(
        `SELECT title FROM events
           WHERE category = 'general' AND tag_kind = 'festival'`
      ).map((r) => r.title)
    );
    const now = nowStr();
    for (const f of listFestivals()) {
      if (existing.has(f.code)) continue;
      const remindDate = festivalNextYmd(f.code);
      const nf = computeNextFireEvent({
        title: f.code,
        description: '',
        remind: true,
        remind_kind: 'yearly',
        remind_time: '09:00',
        remind_date: remindDate,
        contact_id: null,
        category: 'general',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        lunar_month: null,
        lunar_day: null,
        tag_kind: 'festival',
      }, new Date());
      run(
        `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                            remind_time, remind_date, next_fire_at, last_fired_at, active,
                            category, tag_kind, lunar_month, lunar_day,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1,
                 ?, ?, ?, ?, ?, ?)`,
        [newId(), null, f.code, null, 1, 'yearly', '09:00', remindDate,
         nf ? fmtDateTime(nf) : null,
         'general', 'festival', null, null, now, now]
      );
      // The search index isn't strictly necessary for festival rows but
      // upsertSearch is a best-effort helper; skipping it is fine.
    }
    setSetting(SETTINGS_DEFAULT_FESTIVALS_KEY, '1');
  } catch (e) {
    console.error('default festival seed failed:', e);
  }
}

module.exports = {
  open, get, save, newId, nowStr, all, one, run,
  upsertSearch, deleteSearch, getSetting, setSetting,
  markDirty,
  parseContactRow, buildContactBody, safeParseArray,
  listAttributes, getAttribute,
  deleteContactCascade,
  listMemorialEvents, getMemorialEvent, listPhotosForMemorialEvent,
  // Exposed so ipc.js can call them (avoids duplicating logic in IPC handlers).
  // These wrap require() at call-time so we don't introduce a require cycle
  // between db.js and the helpers.
  _seedFestivals: () => seedDefaultFestivals(),
};