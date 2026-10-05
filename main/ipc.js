// main/ipc.js — register all ipcMain handlers (sql.js-friendly)
const { ipcMain, app, screen, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const db = require('./db');
const { fmtDateTime, computeNextFireEvent } = require('./time_util');
const { validateLunar } = require('./lunar');
const { listFestivals, festivalLabel } = require('./festivals');

// Resolve the name to persist. Accepts legacy first_name/last_name for one
// release cycle so older renderer builds still work after the schema upgrade;
// prefers the new `name` field when present.
function resolveName(input) {
  if (input && typeof input.name === 'string' && input.name.trim()) {
    return input.name.trim();
  }
  const legacy = [input && input.first_name, input && input.last_name]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return legacy || '';
}

function register({ queue, winMain, winPet, setPetState, getPetState, setActiveReminder, petController }) {
  // ---- Contacts ----
  ipcMain.handle('contacts:list', () =>
    db.all('SELECT * FROM contacts WHERE listed = 1 ORDER BY updated_at DESC').map(db.parseContactRow));

  ipcMain.handle('contacts:get', (_e, id) =>
    db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [id])));

  // contacts:create / contacts:update only write basic info now. The
  // likes/taboos/gifts data lives in the contact_attributes table and is
  // managed via the attributes:* handlers below.
  ipcMain.handle('contacts:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    const name = resolveName(input);
    const relationship = (input && typeof input.relationship === 'string' && input.relationship.trim())
      ? input.relationship.trim() : null;
    db.run(
      `INSERT INTO contacts(id, name, relationship,
                            likes_json, taboos_json, gifts_json,
                            listed, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '[]', '[]', 1, ?, ?)`,
      [id, name, relationship, now, now]
    );
    const stored = db.one('SELECT * FROM contacts WHERE id = ?', [id]);
    const parsed = db.parseContactRow(stored);
    db.upsertSearch('contact', id, db.buildContactBody(parsed));
    return parsed;
  });

  ipcMain.handle('contacts:update', (_e, id, input) => {
    const now = db.nowStr();
    const name = resolveName(input);
    const relationship = (input && typeof input.relationship === 'string' && input.relationship.trim())
      ? input.relationship.trim() : null;
    db.run(
      `UPDATE contacts SET name=?, relationship=?, updated_at=? WHERE id=?`,
      [name, relationship, now, id]
    );
    const stored = db.one('SELECT * FROM contacts WHERE id = ?', [id]);
    const parsed = db.parseContactRow(stored);
    db.upsertSearch('contact', id, db.buildContactBody(parsed));
    return parsed;
  });

  ipcMain.handle('contacts:delete', (_e, id) => {
    // Hard-delete the contact and everything tied to it:
    //   * contact_attributes (likes / taboos / gifts)        — via FK cascade
    //   * important_dates                                    — via FK cascade
    //   * events whose ONLY contact is this one              — manual delete
    //   * search_index rows (contact / event / important_date) — manual
    //   * reminder_acks for those events/dates               — manual
    //   * live reminder queue entries                        — manual
    //
    // The "only contact" check is forward-compatible with a future
    // event_contacts many-to-many table — see db.deleteContactCascade.
    //
    // `queue` is passed in so the helper can prune active reminders without
    // reaching across modules. `updatePetState` is called afterwards so the
    // pet window's idle/active state reflects the (now smaller) queue.
    const result = db.deleteContactCascade(id, queue);
    updatePetState({ queue, setPetState, setActiveReminder });
    return result;
  });

  // ---- Contact attributes (likes / taboos / gifts — global table) ----
  // All likes/taboos/gifts entries live in contact_attributes and are managed
  // through these handlers. The per-contact sub-pages and the three new global
  // top-level pages (/likes, /taboos, /gifts) all funnel through here.
  const ATTR_KINDS = new Set(['like', 'taboo', 'gift']);

  ipcMain.handle('attributes:list', (_e, kind, opts = {}) => {
    if (!ATTR_KINDS.has(kind)) throw new Error(`unknown attribute kind: ${kind}`);
    return db.listAttributes(kind, opts || {});
  });

  ipcMain.handle('attributes:create', (_e, input = {}) => {
    const kind = input.kind;
    if (!ATTR_KINDS.has(kind)) throw new Error(`unknown attribute kind: ${kind}`);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new Error('description is required');
    if (!input.contact_id) throw new Error('contact_id is required');
    if (!db.one('SELECT id FROM contacts WHERE id = ?', [input.contact_id])) {
      throw new Error(`contact not found: ${input.contact_id}`);
    }
    const event = typeof input.event === 'string' && input.event.trim() ? input.event.trim() : null;
    const id = db.newId();
    const now = db.nowStr();
    db.run(
      `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.contact_id, kind, description, event, now, now]
    );
    // Sync search_index so the new description is searchable via LIKE.
    const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [input.contact_id]));
    if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    return db.one(
      `SELECT a.*, c.name AS contact_name
         FROM contact_attributes a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id = ?`, [id]
    );
  });

  ipcMain.handle('attributes:update', (_e, id, input = {}) => {
    if (!db.getAttribute(id)) throw new Error(`attribute not found: ${id}`);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new Error('description is required');
    const event = typeof input.event === 'string' && input.event.trim() ? input.event.trim() : null;
    const now = db.nowStr();
    db.run(
      `UPDATE contact_attributes SET description=?, event=?, updated_at=? WHERE id=?`,
      [description, event, now, id]
    );
    const row = db.one('SELECT contact_id FROM contact_attributes WHERE id = ?', [id]);
    if (row) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [row.contact_id]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    return db.one(
      `SELECT a.*, c.name AS contact_name
         FROM contact_attributes a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id = ?`, [id]
    );
  });

  ipcMain.handle('attributes:delete', (_e, id) => {
    const row = db.one('SELECT contact_id FROM contact_attributes WHERE id = ?', [id]);
    db.run('DELETE FROM contact_attributes WHERE id = ?', [id]);
    if (row) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [row.contact_id]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    return true;
  });

  // Bulk-delete a set of contact_attributes rows in one round-trip.
  // Returns the number of rows actually deleted. Each affected contact's
  // search_index entry is rebuilt once (after the deletes) instead of once
  // per row, which matters when the renderer is wiping a filtered list of
  // dozens of items from the same contact.
  //
  // The renderer collects ids from the current filtered view and passes
  // them here. We deliberately trust the renderer: ids come from the same
  // DB read the renderer just made, so passing them back is round-trip safe.
  ipcMain.handle('attributes:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    // Validate / normalize input. Anything non-string is dropped before it
    // touches SQL — defence in depth against accidental array-shape bugs.
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length > 0);
    if (safeIds.length === 0) return { deleted: 0 };

    const placeholders = safeIds.map(() => '?').join(',');
    // Capture affected contact_ids BEFORE deleting so we can rebuild the
    // search index for each affected contact exactly once.
    const affectedContactIds = Array.from(new Set(
      db.all(
        `SELECT DISTINCT contact_id FROM contact_attributes WHERE id IN (${placeholders})`,
        safeIds
      ).map((r) => r.contact_id).filter(Boolean)
    ));
    db.run(
      `DELETE FROM contact_attributes WHERE id IN (${placeholders})`,
      safeIds
    );
    for (const cid of affectedContactIds) {
      const c = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [cid]));
      if (c) db.upsertSearch('contact', c.id, db.buildContactBody(c));
    }
    return { deleted: safeIds.length };
  });

  // Bulk-delete a set of events in one round-trip. Mirrors
  // attributes:delete_many — ids are trusted (round-trip from the same
  // DB read), search_index + reminder_acks + live reminder queue are all
  // pruned in bulk instead of one round-trip per row.
  ipcMain.handle('events:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length > 0);
    if (safeIds.length === 0) return { deleted: 0 };

    const placeholders = safeIds.map(() => '?').join(',');
    // Wipe per-event side-tables BEFORE deleting the events themselves so
    // a crash mid-flight doesn't leave dangling search/ack rows.
    db.run(
      `DELETE FROM search_index WHERE kind = 'event' AND ref_id IN (${placeholders})`,
      safeIds
    );
    db.run(
      `DELETE FROM reminder_acks WHERE source = 'event' AND source_id IN (${placeholders})`,
      safeIds
    );
    if (queue && typeof queue.remove === 'function') {
      for (const id of safeIds) queue.remove('event', id);
    }
    db.run(`DELETE FROM events WHERE id IN (${placeholders})`, safeIds);

    // Pet state may have changed (queue is shorter) — push the updated
    // state to the renderer so the pet icon doesn't keep an idle "REMINDER"
    // glow after the queue empties.
    updatePetState({ queue, setPetState, setActiveReminder });
    return { deleted: safeIds.length };
  });

  // ---- Important dates ----
  ipcMain.handle('important_dates:list', (_e, contact_id) =>
    db.all('SELECT * FROM important_dates WHERE contact_id = ? ORDER BY month, day', [contact_id]));

  ipcMain.handle('important_dates:create', (_e, contact_id, input) => {
    const id = db.newId();
    const now = db.nowStr();
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contact_id, input.label, input.day, input.month,
       input.year || null, input.kind || 'custom',
       input.remind_time || '09:00', now, now]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:update', (_e, id, input) => {
    const now = db.nowStr();
    db.run(
      `UPDATE important_dates SET label=?, day=?, month=?, year=?, kind=?,
                                 remind_time=?, updated_at=? WHERE id=?`,
      [input.label, input.day, input.month, input.year || null,
       input.kind || 'custom', input.remind_time || '09:00', now, id]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:delete', (_e, id) => {
    db.run('DELETE FROM important_dates WHERE id = ?', [id]);
    db.deleteSearch('important_date', id);
    return true;
  });

  // ---- Events ----
  // Categories: 'general' (the default "提醒日期" page), 'memorial' (回忆事件),
  // 'work' (工作事件). Filtering by category is optional — without it the
  // handler returns all categories (used by contact_detail and search).
  const EVENT_CATEGORIES = new Set(['general', 'memorial', 'work']);

  ipcMain.handle('events:list', (_e, opts = {}) => {
    // Memorial events live in their own table now (see memorial_events:*).
    // The legacy `events` table no longer carries category='memorial' rows;
    // short-circuit so any stale call returns an empty list instead of
    // surfacing reminder state for events the UI has retired.
    if (opts.category === 'memorial') return [];
    let sql = 'SELECT * FROM events WHERE 1=1';
    const args = [];
    if (opts.contact_id) { sql += ' AND contact_id = ?'; args.push(opts.contact_id); }
    if (opts.from) { sql += ' AND (next_fire_at IS NULL OR next_fire_at >= ?)'; args.push(opts.from); }
    if (opts.to) { sql += ' AND (next_fire_at IS NULL OR next_fire_at <= ?)'; args.push(opts.to); }
    if (opts.category && EVENT_CATEGORIES.has(opts.category)) {
      sql += ' AND category = ?'; args.push(opts.category);
    }
    // tag_kind filter (used by 提醒日期 list filters):
    //   - 'birthday' / 'anniversary' / 'festival' — match that exact value
    //   - 'none' — only events without a tag_kind (user-created untagged)
    //   - 'any_tagged' — anything where tag_kind IS NOT NULL
    //   - absent/empty — no filter
    if (opts.tag_kind === 'none') {
      sql += ' AND tag_kind IS NULL';
    } else if (opts.tag_kind === 'any_tagged') {
      sql += ' AND tag_kind IS NOT NULL';
    } else if (opts.tag_kind && EVENT_TAG_KINDS.has(opts.tag_kind)) {
      sql += ' AND tag_kind = ?';
      args.push(opts.tag_kind);
    }
    sql += ' ORDER BY COALESCE(next_fire_at, remind_date, created_at) ASC';
    return db.all(sql, args);
  });

  ipcMain.handle('events:list_today', () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today_start = `${today_date} 00:00:00`;
    const today_end = `${today_date} 23:59:59`;
    return db.all(
      `SELECT * FROM events
       WHERE active = 1 AND (
         (remind_kind = 'one_time' AND remind_date = ?)
         OR (next_fire_at BETWEEN ? AND ?)
       )
       ORDER BY COALESCE(next_fire_at, remind_date) ASC`,
      [today_date, today_start, today_end]);
  });

  ipcMain.handle('events:get', (_e, id) =>
    db.one('SELECT * FROM events WHERE id = ?', [id]));

  // Tag kinds: 'birthday' / 'anniversary' / 'festival' — or null/empty for
  // untyped events. Determines whether the title is a free-text label
  // (生日 / 纪念日) or a built-in festival code (节日).
  const EVENT_TAG_KINDS = new Set(['birthday', 'anniversary', 'festival']);
  const FESTIVAL_CODES = new Set(listFestivals().map((f) => f.code));

  ipcMain.handle('events:list_festivals', () => listFestivals());

  ipcMain.handle('events:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    // Category defaults to 'general'; reject unknown values so a typo can't
    // hide an event from every page.
    const category = EVENT_CATEGORIES.has(input.category) ? input.category : 'general';
    // Memorial events have their own table + handlers now. Reject any
    // attempt to write category='memorial' here so the UI is forced through
    // the new memorial_events:* channels.
    if (category === 'memorial') throw new Error('请使用新建回忆事件页面');
    // Tag kind is no longer settable from the new-event form. The renderer
    // never sends it. We accept it from internal callers (festival auto-
    // create) but never from the form.
    let tagKind = null;
    if (input.tag_kind && EVENT_TAG_KINDS.has(input.tag_kind)) {
      tagKind = input.tag_kind;
      if (tagKind === 'festival' && !FESTIVAL_CODES.has(input.title)) {
        throw new Error('节日类型必须选择内置节日');
      }
    }
    // Title is no longer required from the user — auto-fill from contact name
    // or a generic placeholder so the row always has a non-empty display
    // label.
    let title = (typeof input.title === 'string' ? input.title.trim() : '');
    if (!title) {
      if (input.contact_id) {
        const c = db.one('SELECT name FROM contacts WHERE id = ?', [input.contact_id]);
        if (c && c.name) {
          title = `${c.name}的提醒`;
        }
      }
      if (!title) title = '新建提醒';
    }
    // Lunar fields are accepted only when both are present; reject invalid
    // (month, day) pairs up front so the user gets immediate feedback.
    let lunarMonth = null, lunarDay = null;
    if (input.lunar_month != null && input.lunar_day != null) {
      const v = validateLunar(input.lunar_month, input.lunar_day);
      if (!v.ok) throw new Error(v.reason || '农历日期无效');
      lunarMonth = Number(input.lunar_month);
      lunarDay = Number(input.lunar_day);
    }
    const nf = computeNextFireEvent({
      ...input,
      title,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
      lunar_month: lunarMonth,
      lunar_day: lunarDay,
    }, new Date());
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          category, tag_kind, lunar_month, lunar_day,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1,
               ?, ?, ?, ?, ?, ?)`,
      [id, input.contact_id || null, title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null,
       category, tagKind, lunarMonth, lunarDay, now, now]
    );
    db.upsertSearch('event', id, `${title} ${input.description || ''} ${input.remind_kind || ''} ${category} ${tagKind || ''}`);
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:update', (_e, id, input) => {
    const now = db.nowStr();
    const category = EVENT_CATEGORIES.has(input.category) ? input.category : 'general';
    if (category === 'memorial') throw new Error('请使用新建回忆事件页面');
    let tagKind = null;
    if (input.tag_kind && EVENT_TAG_KINDS.has(input.tag_kind)) {
      tagKind = input.tag_kind;
      if (tagKind === 'festival' && !FESTIVAL_CODES.has(input.title)) {
        throw new Error('节日类型必须选择内置节日');
      }
    }
    // Title may not be cleared by the user. If the form sends an empty
    // string, fall back to the existing row's title.
    let title = (typeof input.title === 'string' ? input.title.trim() : '');
    if (!title) {
      const existing = db.one('SELECT title FROM events WHERE id = ?', [id]);
      title = (existing && existing.title) || '新建提醒';
    }
    let lunarMonth = null, lunarDay = null;
    if (input.lunar_month != null && input.lunar_day != null) {
      const v = validateLunar(input.lunar_month, input.lunar_day);
      if (!v.ok) throw new Error(v.reason || '农历日期无效');
      lunarMonth = Number(input.lunar_month);
      lunarDay = Number(input.lunar_day);
    }
    const nf = computeNextFireEvent({
      ...input,
      title,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
      lunar_month: lunarMonth,
      lunar_day: lunarDay,
    }, new Date());
    db.run(
      `UPDATE events SET contact_id=?, title=?, description=?, remind=?, remind_kind=?,
                         remind_time=?, remind_date=?, next_fire_at=?, active=1,
                         category=?, tag_kind=?, lunar_month=?, lunar_day=?, updated_at=?
       WHERE id=?`,
      [input.contact_id || null, title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null,
       category, tagKind, lunarMonth, lunarDay, now, id]
    );
    db.upsertSearch('event', id, `${title} ${input.description || ''} ${input.remind_kind || ''} ${category} ${tagKind || ''}`);
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:delete', (_e, id) => {
    db.run('DELETE FROM events WHERE id = ?', [id]);
    db.deleteSearch('event', id);
    return true;
  });

  ipcMain.handle('events:debug_fire_due_now', () => {
    db.run(
      `UPDATE events SET next_fire_at = ?
       WHERE active = 1 AND remind = 1 AND remind_kind != 'none'`,
      [db.nowStr()]
    );
    return true;
  });

  // ---- Memorial events ----
  // Independent from the reminder-style events table. Records "what
  // happened, when, with whom" — no remind/remind_kind/lunar/next_fire
  // fields. Photo metadata lives in memorial_event_photos; the actual
  // bytes are written to disk by photos_upload and served to the renderer
  // via the `memorial-photo://` protocol registered in main/main.js.

  // Photo storage lives under <appData>/MemoryPet/photos/<event_id>/.
  function getPhotosDir() {
    return path.join(app.getPath('appData'), 'MemoryPet', 'photos');
  }
  // Strip filesystem-hostile characters and clamp the basename before we
  // trust it as a filename on disk.
  function sanitizeFilename(name) {
    const stripped = String(name || '')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120);
    return stripped || 'photo';
  }
  function guessExtFromMime(m) {
    if (!m) return '';
    return ({
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
      'image/heic': '.heic', 'image/heif': '.heic',
    }[String(m).toLowerCase()] || '');
  }

  // Replace the contacts associated with a memorial event. Drops the old
  // rows and inserts the new set in one transaction-ish block; unknown
  // contact ids are silently skipped (the FK would error out otherwise).
  function setMemorialEventContacts(eventId, contactIds) {
    db.run('DELETE FROM memorial_event_contacts WHERE memorial_event_id = ?', [eventId]);
    const now = db.nowStr();
    for (const cid of contactIds) {
      if (!db.one('SELECT id FROM contacts WHERE id = ?', [cid])) continue;
      db.run(
        `INSERT OR IGNORE INTO memorial_event_contacts(memorial_event_id, contact_id, created_at)
         VALUES (?, ?, ?)`,
        [eventId, cid, now]
      );
    }
  }

  // Trim a free-text form input. Non-strings and whitespace-only strings
// collapse to null so the DB doesn't store meaningless blanks and the
// search_index body stays tight.
function normFreeText(s) {
  return (typeof s === 'string' && s.trim()) ? s.trim() : null;
}

// Accept both YYYY-MM-DD and YYYY-MM-DD HH:MM[:SS] from the renderer
  // (datetime-local produces the former shape, the form fills the seconds
  // before posting). Anything else throws so the user sees a clear error
  // instead of a silently-shifted occurrence date.
  function normalizeOccurredAt(input, fallback) {
    if (typeof input !== 'string' || !input.trim()) {
      return fallback || db.nowStr();
    }
    const trimmed = input.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) return `${trimmed} 00:00:00`;
    const dateTime = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (!dateTime) throw new Error('事件发生时间格式无效');
    const [, y, mo, d, h, mi, s = '00'] = dateTime;
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  }

  ipcMain.handle('memorial_events:list', (_e, opts = {}) =>
    db.listMemorialEvents(opts || {}));

  ipcMain.handle('memorial_events:get', (_e, id) => db.getMemorialEvent(id));

  ipcMain.handle('memorial_events:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    const kind = (input && (input.kind === 'first_time' || input.kind === 'other'))
      ? input.kind : 'other';
    const title = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim() : '回忆事件';
    // 5 free-text fields, all nullable. Each is independently trimmed and
    // stored only if non-empty; an empty string from the form becomes NULL
    // so search_index doesn't include noise.
    const place      = normFreeText(input && input.place);
    const food       = normFreeText(input && input.food);
    const outfit     = normFreeText(input && input.outfit);
    const activities = normFreeText(input && input.activities);
    const notes      = normFreeText(input && input.notes);
    const occurredAt = normalizeOccurredAt(input && input.occurred_at);
    const contactIds = Array.isArray(input && input.contact_ids)
      ? Array.from(new Set(input.contact_ids.filter((x) => typeof x === 'string' && x.length)))
      : [];
    db.run(
      `INSERT INTO memorial_events(id, kind, title,
                                   place, food, outfit, activities, notes,
                                   occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, title,
       place, food, outfit, activities, notes,
       occurredAt, now, now]
    );
    setMemorialEventContacts(id, contactIds);
    db.upsertSearch('memorial_event', id,
      [title, place, food, outfit, activities, notes, kind, occurredAt]
        .filter(Boolean).join(' '));
    return db.getMemorialEvent(id);
  });

  ipcMain.handle('memorial_events:update', (_e, id, input) => {
    const now = db.nowStr();
    const cur = db.one('SELECT * FROM memorial_events WHERE id = ?', [id]);
    if (!cur) throw new Error('memorial_event not found');
    const kind = (input && (input.kind === 'first_time' || input.kind === 'other'))
      ? input.kind : cur.kind;
    const title = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim() : cur.title;
    // Per-field "fall back to existing value if the form didn't send this
    // key" semantics. The form always sends all 5 so the typeof check
    // doubles as a defensive guard for partial updates from future callers.
    const place      = (input && Object.prototype.hasOwnProperty.call(input, 'place'))
      ? normFreeText(input.place) : cur.place;
    const food       = (input && Object.prototype.hasOwnProperty.call(input, 'food'))
      ? normFreeText(input.food) : cur.food;
    const outfit     = (input && Object.prototype.hasOwnProperty.call(input, 'outfit'))
      ? normFreeText(input.outfit) : cur.outfit;
    const activities = (input && Object.prototype.hasOwnProperty.call(input, 'activities'))
      ? normFreeText(input.activities) : cur.activities;
    const notes      = (input && Object.prototype.hasOwnProperty.call(input, 'notes'))
      ? normFreeText(input.notes) : cur.notes;
    const occurredAt = normalizeOccurredAt(input && input.occurred_at, cur.occurred_at);
    const contactIds = Array.isArray(input && input.contact_ids)
      ? Array.from(new Set(input.contact_ids.filter((x) => typeof x === 'string' && x.length)))
      : db.all('SELECT contact_id FROM memorial_event_contacts WHERE memorial_event_id = ?', [id])
          .map((r) => r.contact_id);
    db.run(
      `UPDATE memorial_events
          SET kind=?, title=?,
              place=?, food=?, outfit=?, activities=?, notes=?,
              occurred_at=?, updated_at=?
        WHERE id=?`,
      [kind, title,
       place, food, outfit, activities, notes,
       occurredAt, now, id]
    );
    setMemorialEventContacts(id, contactIds);
    db.upsertSearch('memorial_event', id,
      [title, place, food, outfit, activities, notes, kind, occurredAt]
        .filter(Boolean).join(' '));
    return db.getMemorialEvent(id);
  });

  ipcMain.handle('memorial_events:delete', (_e, id) => {
    // Drop the on-disk photo directory before the DB rows. CASCADE on the
    // photo FK removes the metadata rows automatically.
    try {
      fs.rmSync(path.join(getPhotosDir(), id), { recursive: true, force: true });
    } catch (e) {
      console.error('memorial_events:delete photo dir rm failed:', e);
    }
    db.run('DELETE FROM memorial_events WHERE id = ?', [id]);
    db.deleteSearch('memorial_event', id);
    return true;
  });

  ipcMain.handle('memorial_events:delete_many', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    const safeIds = ids.filter((x) => typeof x === 'string' && x.length);
    if (safeIds.length === 0) return { deleted: 0 };
    for (const id of safeIds) {
      try {
        fs.rmSync(path.join(getPhotosDir(), id), { recursive: true, force: true });
      } catch (e) {
        console.error('memorial_events:delete_many photo dir rm failed:', e);
      }
      db.deleteSearch('memorial_event', id);
    }
    const placeholders = safeIds.map(() => '?').join(',');
    db.run(`DELETE FROM memorial_events WHERE id IN (${placeholders})`, safeIds);
    return { deleted: safeIds.length };
  });

  // ---- Memorial event photos ----
  ipcMain.handle('memorial_events:photos_list', (_e, eventId) =>
    db.listPhotosForMemorialEvent(eventId));

  ipcMain.handle('memorial_events:photos_upload', (_e, eventId, input) => {
    if (!input || !input.bytes) throw new Error('photo bytes required');
    if (!db.one('SELECT id FROM memorial_events WHERE id = ?', [eventId])) {
      throw new Error(`memorial_event not found: ${eventId}`);
    }
    const eventPath = path.join(getPhotosDir(), eventId);
    fs.mkdirSync(eventPath, { recursive: true });
    const safeBase = sanitizeFilename(input.filename || 'photo');
    const ext = path.extname(safeBase) || guessExtFromMime(input.mime);
    const baseName = safeBase.replace(/\.[^.]+$/, '') || 'photo';
    let filename = `${baseName}${ext}`;
    let n = 1;
    // Disambiguate if the user picks two files with the same basename
    // ("photo.jpg", "photo (1).jpg" both stripped to "photo").
    while (fs.existsSync(path.join(eventPath, filename))) {
      filename = `${baseName}-${n}${ext}`;
      n += 1;
    }
    const fullPath = path.join(eventPath, filename);
    const buf = Buffer.from(input.bytes);
    fs.writeFileSync(fullPath, buf);
    const id = db.newId();
    const now = db.nowStr();
    const relPath = path.posix.join('photos', eventId, filename);
    db.run(
      `INSERT INTO memorial_event_photos(id, memorial_event_id, relative_path, original_name, mime, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, eventId, relPath, input.filename || filename, input.mime || null, buf.length, now]
    );
    return db.one(
      `SELECT id, relative_path, original_name, mime, size_bytes, created_at
         FROM memorial_event_photos WHERE id = ?`,
      [id]
    );
  });

  ipcMain.handle('memorial_events:photos_delete', (_e, photoId) => {
    const row = db.one('SELECT * FROM memorial_event_photos WHERE id = ?', [photoId]);
    if (!row) return false;
    const full = path.join(getPhotosDir(), row.memorial_event_id, path.basename(row.relative_path));
    try { fs.unlinkSync(full); } catch {}
    db.run('DELETE FROM memorial_event_photos WHERE id = ?', [photoId]);
    // Tidy: remove the parent dir if it's now empty (best effort).
    try {
      const dir = path.dirname(full);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {}
    return true;
  });

  // Read a single photo's content as a base64 data URL. We deliberately
  // avoid a custom `memorial-photo://` scheme because CSP `default-src 'self'`
  // refuses to load images from any non-self protocol — the <img> tag falls
  // back to the broken-image icon. Data URLs sidestep the CSP entirely.
  //
  // Returns: { data_url, mime } or null if the row is missing. The renderer
  // turns `data_url` into <img src=…>. Each photo is a few MB at typical
  // upload sizes — fine for an in-memory base64 round-trip, and the browser
  // caches the decoded bitmap so re-renders don't re-read.
  ipcMain.handle('memorial_events:photo_read', (_e, photoId) => {
    const row = db.one('SELECT * FROM memorial_event_photos WHERE id = ?', [photoId]);
    if (!row) return null;
    const full = path.join(getPhotosDir(), row.memorial_event_id, path.basename(row.relative_path));
    if (!fs.existsSync(full)) return null;
    try {
      const buf = fs.readFileSync(full);
      const mime = row.mime || ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.heic': 'image/heic', '.heif': 'image/heic',
      }[path.extname(full).toLowerCase()] || 'application/octet-stream');
      return { data_url: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (e) {
      console.error('photo_read failed:', e);
      return null;
    }
  });

  // ---- Search ----
  ipcMain.handle('search:query', (_e, q) => {
    q = (q || '').trim();
    if (!q) return { contacts: [], events: [], memorial_events: [], important_dates: [] };
    const like = `%${q}%`;
    const contacts = db.all(
      `SELECT * FROM contacts WHERE listed=1 AND (
        name LIKE ? OR relationship LIKE ?
        OR EXISTS (SELECT 1 FROM contact_attributes a
                   WHERE a.contact_id = contacts.id AND a.description LIKE ?)
      )`,
      [like, like, like]
    ).map(db.parseContactRow);
    const events = db.all('SELECT * FROM events WHERE title LIKE ? OR description LIKE ?', [like, like]);
    // Memorial events are searched by title/description only (kind lives in a
    // separate column we don't text-match). The renderer doesn't show
    // contact names on the search-result card, so we don't need the join
    // table here.
    const memorial = db.all(
      `SELECT * FROM memorial_events
        WHERE title LIKE ? OR place LIKE ? OR food LIKE ?
           OR outfit LIKE ? OR activities LIKE ? OR notes LIKE ?`,
      [like, like, like, like, like, like]
    );
    const dates = db.all('SELECT * FROM important_dates WHERE label LIKE ?', [like]);
    return { contacts, events, memorial_events: memorial, important_dates: dates };
  });

  // ---- Reminders ----
  ipcMain.handle('reminders:list_active', () => queue.list());

  ipcMain.handle('reminders:mark_done', (_e, source, sourceId) => {
    queue.remove(source, sourceId);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, NULL)`,
      [source, sourceId, db.nowStr()]
    );
    updatePetState({ queue, setPetState, setActiveReminder });
    return true;
  });

  ipcMain.handle('reminders:snooze', (_e, source, sourceId, minutes) => {
    const newFire = new Date(Date.now() + minutes * 60_000);
    const newFireStr = fmtDateTime(newFire);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, ?)`,
      [source, sourceId, db.nowStr(), newFireStr]
    );
    if (source === 'event') {
      db.run('UPDATE events SET next_fire_at = ? WHERE id = ?', [newFireStr, sourceId]);
    }
    queue.remove(source, sourceId);
    updatePetState({ queue, setPetState, setActiveReminder });
    return true;
  });

  // ---- Pet / settings / windowing ----
  ipcMain.handle('pet:get_state', () => {
    const head = queue.head();
    return {
      state: getPetState() ? 'REMINDER' : 'NORMAL',
      count: queue.len(),
      // Same shape as the `pet:state-changed` payload's head field — the
      // renderer uses one setState() function for both.
      head: head ? {
        title: head.title,
        contact_name: head.contact_name || null,
        description: head.description || null,
      } : null,
    };
  });

  ipcMain.handle('settings:get', (_e, key) => db.getSetting(key));
  ipcMain.handle('settings:set', (_e, key, value) => { db.setSetting(key, value); return true; });

  ipcMain.handle('pet:set_position', (_e, x, y) => {
    db.setSetting('pet_x', String(x));
    db.setSetting('pet_y', String(y));
    if (winPet && !winPet.isDestroyed()) {
      winPet.setPosition(x, y);
    }
    return true;
  });

  ipcMain.handle('pet:get_position', () => ({
    x: parseInt(db.getSetting('pet_x') || '200', 10),
    y: parseInt(db.getSetting('pet_y') || '200', 10),
  }));

  // ---- Pet species / walk toggle ----
  // Both settings are persisted in the `settings` table and broadcast to the
  // pet window so it can react immediately (species swap / animation stop).
  // The PetController (main process) also reads them on construction.
  ipcMain.handle('pet:get_species', () => {
    const v = db.getSetting('pet_species');
    return (v === 'dog' || v === 'bird' || v === 'miku') ? v : 'cat';
  });
  ipcMain.handle('pet:set_species', (_e, species) => {
    if (petController && typeof petController.setSpecies === 'function') {
      petController.setSpecies(species);
    }
    return true;
  });
  ipcMain.handle('pet:get_walk_enabled', () =>
    db.getSetting('pet_walk_enabled') !== '0');
  ipcMain.handle('pet:set_walk_enabled', (_e, enabled) => {
    if (petController && typeof petController.setEnabled === 'function') {
      petController.setEnabled(!!enabled);
    }
    return true;
  });
  ipcMain.handle('pet:set_paused', (_e, ms) => {
    if (petController && typeof petController.setPaused === 'function') {
      petController.setPaused(ms);
    }
    return true;
  });

  // Miku 专属：触发一次性动画（wave / sing），到时间后自动恢复到 idle。
  ipcMain.handle('pet:trigger_action', (_e, action, ms) => {
    if (petController && typeof petController.triggerOneShot === 'function') {
      petController.triggerOneShot(action, ms);
    }
    return true;
  });

  ipcMain.handle('window:show_main', () => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
    }
    return true;
  });

  ipcMain.handle('window:hide_main', () => {
    if (winMain && !winMain.isDestroyed()) winMain.hide();
    return true;
  });

  ipcMain.handle('window:open_reminder', (_e, source, sourceId) => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
      winMain.webContents.send('main:open-reminder', { source, source_id: sourceId });
    }
    return true;
  });

  // ---- App-level controls ----
  ipcMain.handle('app:quit', () => {
    setTimeout(() => app.quit(), 50); // slight delay so the IPC ack reaches the renderer
    return true;
  });

  // ---- Pet drag: receive a per-tick delta from the pet window. We add it
  // to the window's current position and clamp to the display work area.
  // (Using per-tick deltas — not cumulative-from-mousedown — is the key to
  // smooth 1:1 tracking. If we accumulated from mousedown, the main process
  // would add the full cumulative delta to the window's *current* position
  // each tick and the window would run away from the cursor.)
  ipcMain.handle('pet:move_by', (_e, dx, dy) => {
    if (!winPet || winPet.isDestroyed()) return false;
    const [x, y] = winPet.getPosition();
    const w = winPet.getBounds().width;
    const h = winPet.getBounds().height;
    const nx = x + dx;
    const ny = y + dy;
    const display = screen.getDisplayMatching({ x: nx, y: ny, width: w, height: h })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    const cx = Math.max(wa.x, Math.min(wa.x + wa.width - w, nx));
    const cy = Math.max(wa.y, Math.min(wa.y + wa.height - h, ny));
    winPet.setPosition(cx, cy);
    // Pause autonomous movement for ~2 s so the pet doesn't run away right
    // after the user releases the drag. The renderer also calls setPaused at
    // the start of every drag (see src/js/pet.js) — this is a safety net
    // for rendererless moves.
    if (petController && typeof petController.setPaused === 'function') {
      petController.setPaused(2000);
    }
    return true;
  });

  // ---- Pet right-click context menu (native Electron Menu at cursor) ----
  ipcMain.handle('pet:context_menu', () => {
    const state = getPetState() ? 'REMINDER' : 'NORMAL';
    const reminderLabel = state === 'REMINDER' ? '查看提醒' : '打开主窗口';
    const menu = Menu.buildFromTemplate([
      { label: '🐾 MemoryPet', enabled: false },
      { type: 'separator' },
      {
        label: reminderLabel,
        click: () => {
          if (state === 'REMINDER') {
            // Open main window + pop the reminder modal.
            if (winMain && !winMain.isDestroyed()) {
              winMain.show();
              winMain.focus();
              const head = queue.head();
              if (head) {
                winMain.webContents.send('main:open-reminder', {
                  source: head.source,
                  source_id: head.source_id,
                });
              }
            }
          } else if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
          }
        },
      },
      {
        label: '设置…',
        click: () => {
          if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
            winMain.webContents.send('main:navigate', '/settings');
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出 MemoryPet',
        click: () => {
          setTimeout(() => app.quit(), 50);
        },
      },
    ]);
    menu.popup({ window: winPet });
    return true;
  });

  // ---- Backup / restore ----
  // Round-trippable bundle: a zip containing memorypet.db and a photos/
  // folder that follows the on-disk layout <appData>/MemoryPet/photos.
  // search_index is not bundled — it's a derived cache that's rebuilt from
  // the imported tables by the next round of upsertSearch() calls.
  //
  // The flow is split into three handlers so the user gets a real OS
  // confirm() dialog between picking the file and overwriting the local DB:
  //
  //   backup:export    – showSaveDialog → return chosen path (or canceled)
  //   backup:import    – showOpenDialog → return chosen path (or canceled)
  //   backup:apply     – destructive: swap DB on disk, replace photos dir,
  //                       rebuild the in-memory reminder queue
  //
  // backup:export / backup:apply both snapshot the DB before doing IO so
  // the in-memory state always lands in the file the user is going to ship.

  function backupStamp() {
    // "YYYYMMDD-HHmmss" in local time. Safe for filenames on Windows /
    // macOS / Linux (no spaces, no colons).
    return db.nowStr().replace(/[-: ]/g, '').slice(0, 15);
  }

  ipcMain.handle('backup:export', async () => {
    if (!db.dbPath) throw new Error('数据库未初始化');
    const stamp = backupStamp();
    const result = await dialog.showSaveDialog(winMain, {
      title: '导出备份',
      defaultPath: `memorypet-backup-${stamp}.zip`,
      filters: [{ name: 'MemoryPet 备份', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    // Persist the latest in-memory state before copying the file out.
    db.save();

    const zip = new AdmZip();
    zip.addLocalFile(db.dbPath, '', 'memorypet.db');
    const photosDir = getPhotosDir();
    if (fs.existsSync(photosDir)) {
      // Empty directories inside `photos/` would otherwise be dropped by
      // the zip writer; that's fine — empty dirs have no bytes anyway.
      zip.addLocalFolder(photosDir, 'photos');
    }
    zip.writeZip(result.filePath);

    db.setSetting('last_export_at', db.nowStr());
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('backup:import', async () => {
    const pick = await dialog.showOpenDialog(winMain, {
      title: '导入备份',
      filters: [{ name: 'MemoryPet 备份', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, path: pick.filePaths[0] };
  });

  ipcMain.handle('backup:apply', async (_e, zipPath) => {
    if (!zipPath) throw new Error('备份路径为空');
    if (!fs.existsSync(zipPath)) throw new Error('备份文件不存在');

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    if (!entries.some((e) => e.entryName === 'memorypet.db')) {
      throw new Error('备份中缺少 memorypet.db');
    }

    if (!db.dbPath) throw new Error('数据库未初始化');

    // 1) Snapshot current in-memory state, then close so we can replace the
    //    file on disk.
    try { db.save(); } catch (e) { console.error('pre-import save failed:', e); }
    db.close();

    // 2) Atomically replace memorypet.db. We write to a sibling temp file
    //    first so a crash mid-write can't leave the live DB half-written.
    const dbEntry = entries.find((e) => e.entryName === 'memorypet.db');
    const tmpDb = db.dbPath + '.import.tmp';
    fs.writeFileSync(tmpDb, dbEntry.getData());
    fs.copyFileSync(tmpDb, db.dbPath);
    try { fs.unlinkSync(tmpDb); } catch {}

    // 3) Reopen — sql.js reloads the bytes from disk.
    await db.open(db.dbPath);

    // 4) Wipe and rebuild the photos directory from the zip. Reject any
    //    entry whose path tries to escape (zip slip) — entryName must not
    //    contain ".." or absolute paths.
    const photosDir = getPhotosDir();
    fs.rmSync(photosDir, { recursive: true, force: true });
    fs.mkdirSync(photosDir, { recursive: true });
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!e.entryName.startsWith('photos/')) continue;
      if (e.entryName.includes('..')) continue;
      // Strip the "photos/" prefix; the resulting path must stay inside
      // photosDir.
      const rel = e.entryName.slice('photos/'.length);
      const out = path.join(photosDir, rel);
      const relOut = path.relative(photosDir, out);
      if (relOut.startsWith('..') || path.isAbsolute(relOut)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, e.getData());
    }

    // 5) Reset the live reminder queue so it doesn't keep stale ids from
    //    the previous DB. The next scheduler tick will repopulate from
    //    events.next_fire_at via scanAndFire().
    if (queue && typeof queue.clear === 'function') {
      queue.clear();
    }

    db.setSetting('last_import_at', db.nowStr());
    return { canceled: false };
  });
}

function updatePetState({ queue, setPetState, setActiveReminder }) {
  const len = queue.len();
  if (len > 0) {
    setPetState(true);
    setActiveReminder(queue.head());
  } else {
    setPetState(false);
    setActiveReminder(null);
  }
}

module.exports = { register };