// main/ipc.js — register all ipcMain handlers (sql.js-friendly)
const { ipcMain, app, screen, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const db = require('./db');
const { fmtDateTime, computeNextFireEvent } = require('./time_util');
const { validateLunar } = require('./lunar');
const { listFestivals, festivalLabel } = require('./festivals');
const {
  readFolderPack, readZipPack, installPack, removeImported,
  isImportedId, readManifestExtras,
} = require('./pet_pack_import');

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

function register({ queue, winMain, winPet, setPetState, getPetState, setActiveReminder, petController, petRegistry }) {
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
    // Avatar: `icon_kind` is a Lucide-style identifier (e.g. 'user', 'heart',
    // 'briefcase'). `custom_avatar_path` is an absolute filesystem path to a
    // user-uploaded image; null when the user is on the default glyph. Both
    // are optional in `input` and fall back to schema defaults.
    const iconKind = (input && typeof input.icon_kind === 'string' && input.icon_kind.trim())
      ? input.icon_kind.trim() : 'user';
    const customAvatar = (input && typeof input.custom_avatar_path === 'string' && input.custom_avatar_path.trim())
      ? input.custom_avatar_path.trim() : null;
    db.run(
      `INSERT INTO contacts(id, name, relationship, icon_kind, custom_avatar_path,
                            likes_json, taboos_json, gifts_json,
                            listed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 1, ?, ?)`,
      [id, name, relationship, iconKind, customAvatar, now, now]
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
    const iconKind = (input && typeof input.icon_kind === 'string' && input.icon_kind.trim())
      ? input.icon_kind.trim() : 'user';
    const customAvatar = (input && typeof input.custom_avatar_path === 'string' && input.custom_avatar_path.trim())
      ? input.custom_avatar_path.trim() : null;
    db.run(
      `UPDATE contacts SET name=?, relationship=?, icon_kind=?, custom_avatar_path=?, updated_at=? WHERE id=?`,
      [name, relationship, iconKind, customAvatar, now, id]
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
    //   * the per-contact avatar file (if any)               — manual
    //
    // The "only contact" check is forward-compatible with a future
    // event_contacts many-to-many table — see db.deleteContactCascade.
    //
    // `queue` is passed in so the helper can prune active reminders without
    // reaching across modules. `updatePetState` is called afterwards so the
    // pet window's idle/active state reflects the (now smaller) queue.
    deleteContactAvatarFile(id);
    const result = db.deleteContactCascade(id, queue);
    updatePetState({ queue, setPetState, setActiveReminder });
    return result;
  });

  // ---- Contact avatars ----
  // Per-contact uploaded images live under <appData>/MemoryPet/avatars/.
  // The on-disk filename is keyed by the contact id; the renderer retrieves
  // a CSP-friendly data URL via `contacts:avatar_read` so the <img src=…>
  // never has to reference a raw file path. `custom_avatar_path` in the DB
  // stores the relative path so we can find the file later.
  function getAvatarsDir() {
    return path.join(app.getPath('appData'), 'MemoryPet', 'avatars');
  }

  // Resolve the on-disk path for a contact's avatar file. Returns null when
  // the contact has no uploaded avatar (DB column is null) or when the file
  // is missing on disk — both cases are treated identically by the caller.
  function getContactAvatarPath(contactId) {
    const row = db.one(
      'SELECT custom_avatar_path FROM contacts WHERE id = ?',
      [contactId]
    );
    if (!row || !row.custom_avatar_path) return null;
    const rel = String(row.custom_avatar_path).replace(/\\/g, '/');
    if (rel.includes('..') || path.isAbsolute(rel)) return null;
    const full = path.join(getAvatarsDir(), rel);
    if (!fs.existsSync(full)) return null;
    return full;
  }

  // Wipe a contact's avatar file from disk. Silent on missing files so it's
  // safe to call from delete handlers without race-checking existence.
  function deleteContactAvatarFile(contactId) {
    try {
      const full = getContactAvatarPath(contactId);
      if (full) fs.unlinkSync(full);
    } catch (e) {
      console.error('deleteContactAvatarFile failed:', e);
    }
  }

  // Accept an uploaded image and persist it under avatars/<contact_id><ext>.
  // We sanitize the original filename down to just an extension and use the
  // contact id as the stable basename so subsequent uploads overwrite cleanly.
  // The DB stores the *relative* path under avatars/, so the user-data dir
  // can move (e.g. across machines via backup import) without breaking links.
  ipcMain.handle('contacts:upload_avatar', (_e, contactId, input) => {
    if (!contactId) throw new Error('contactId is required');
    if (!input || !input.bytes) throw new Error('photo bytes required');
    if (!db.one('SELECT id FROM contacts WHERE id = ?', [contactId])) {
      throw new Error(`contact not found: ${contactId}`);
    }
    const mime = (input.mime || '').toLowerCase();
    const allowed = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
    };
    let ext = allowed[mime];
    if (!ext) {
      // Fall back to the original filename's extension, then to a generic
      // .bin suffix. We never trust the renderer-decided mime alone.
      const guessed = path.extname(input.filename || '').toLowerCase();
      ext = allowed[({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif':  'image/gif',
        '.webp': 'image/webp','.bmp':  'image/bmp',
      }[guessed] || '')] || '.bin';
    }
    const avatarsDir = getAvatarsDir();
    fs.mkdirSync(avatarsDir, { recursive: true });
    // Drop any existing avatar file for this contact (different extension or
    // not) so we never accumulate stale images. Best effort — failure is
    // logged but doesn't abort the new upload.
    try {
      const existing = getContactAvatarPath(contactId);
      if (existing) fs.unlinkSync(existing);
    } catch (e) {
      console.error('avatar overwrite cleanup failed:', e);
    }
    const filename = `${contactId}${ext}`;
    const fullPath = path.join(avatarsDir, filename);
    const buf = Buffer.from(input.bytes);
    fs.writeFileSync(fullPath, buf);
    const relPath = path.posix.join(filename);
    const now = db.nowStr();
    db.run(
      `UPDATE contacts SET custom_avatar_path = ?, updated_at = ? WHERE id = ?`,
      [relPath, now, contactId]
    );
    const stored = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [contactId]));
    db.upsertSearch('contact', stored.id, db.buildContactBody(stored));
    return stored;
  });

  // Read the contact's avatar (if any) as a base64 data URL so the renderer
  // can drop it straight into <img src=…> without tripping the CSP. Returns
  // { data_url, mime } or null when no avatar is set / the file is missing.
  // Mirrors memorial_events:photo_read so we get the same render behaviour
  // everywhere contact photos appear.
  ipcMain.handle('contacts:avatar_read', (_e, contactId) => {
    if (!contactId) return null;
    const full = getContactAvatarPath(contactId);
    if (!full) return null;
    try {
      const buf = fs.readFileSync(full);
      const mime = ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif',   '.webp': 'image/webp',  '.bmp': 'image/bmp',
      }[path.extname(full).toLowerCase()] || 'application/octet-stream');
      return { data_url: `data:${mime};base64,${buf.toString('base64')}` , mime };
    } catch (e) {
      console.error('avatar_read failed:', e);
      return null;
    }
  });

  // Drop the avatar file + clear the DB column. The renderer can immediately
  // call contacts:get afterwards and the row will have custom_avatar_path=null.
  ipcMain.handle('contacts:avatar_delete', (_e, contactId) => {
    if (!contactId) throw new Error('contactId is required');
    deleteContactAvatarFile(contactId);
    const now = db.nowStr();
    db.run(
      `UPDATE contacts SET custom_avatar_path = NULL, updated_at = ? WHERE id = ?`,
      [now, contactId]
    );
    const stored = db.parseContactRow(db.one('SELECT * FROM contacts WHERE id = ?', [contactId]));
    db.upsertSearch('contact', stored.id, db.buildContactBody(stored));
    return stored;
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
    // Two-level ordering: 未完成事件在前（按即将到来的时间升序），
    // 已完成的单次事件（active=0 或 next_fire_at IS NULL）沉底。
    // "已完成"的定义：单次事件被触发后会被 scheduler 置为 active=0 +
    // next_fire_at=NULL（main/scheduler.js）。提醒关闭的一次性事件虽然
    // active=1 但也 next_fire_at=NULL，按同样规则沉底，避免过期的
    // remind_date 把它们顶到列表最前面。
    sql += ` ORDER BY
      (CASE WHEN remind_kind = 'one_time' AND (active = 0 OR next_fire_at IS NULL) THEN 1 ELSE 0 END) ASC,
      COALESCE(next_fire_at, remind_date, created_at) ASC`;
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
    // (with the tag_kind label, e.g. "刘杰的生日") or a generic placeholder
    // so the row always has a non-empty display label.
    let title = (typeof input.title === 'string' ? input.title.trim() : '');
    if (!title) {
      if (input.contact_id) {
        const c = db.one('SELECT name FROM contacts WHERE id = ?', [input.contact_id]);
        if (c && c.name) {
          const suffix = tagKind === 'birthday'    ? '生日'
                       : tagKind === 'anniversary' ? '纪念日'
                       : tagKind === 'festival'    ? '节日'
                       : '提醒';
          title = `${c.name}的${suffix}`;
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
  // list_active returns every queue item, including items the user already
  // marked complete for today (with `dismissed_for_today: true`). The
  // 今日 page uses this distinction to render completed items in a
  // visually muted style, so the user can still scroll back to see what
  // they finished. Callers that only want non-dismissed items should use
  // `pet:get_state` (which carries the active head) or filter client-side.
  ipcMain.handle('reminders:list_active', () => queue.list());

  // Today view: returns EVERY event scheduled for today (whether or not
  // the scheduler has fired it yet), decorated with the soft-completion
  // state. The 今日 page uses this so the "当前提醒" block is the
  // authoritative list of what the user has to deal with today, not just
  // whatever the scheduler happens to have already nagged about. Pending
  // items surface above completed ones so attention still flows to what
  // needs doing.
  ipcMain.handle('reminders:list_today_view', () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today_start = `${today_date} 00:00:00`;
    const today_end = `${today_date} 23:59:59`;
    const today_prefix = today_date; // YYYY-MM-DD

    // Pull every event that should fire today. The filter is intentionally
    // NOT gated on `active = 1` — a one_time event gets flipped to
    // `active = 0` the moment the scheduler fires it, but the 今日 page
    // still needs to show the event (now with a "已完成" tag) so the user
    // can scroll back and confirm what they finished. The same is true
    // for periodic events the user is looking at mid-day.
    //
    // We match on three independent criteria, deduped by id:
    //   1. one_time with remind_date = today        (covers pre-fire AND
    //                                                post-fire one_times)
    //   2. any kind whose next_fire_at falls in today's window
    //                                                (covers periodic +
    //                                                daily still scheduled
    //                                                for later today)
    //   3. any kind whose last_fired_at falls in today's window
    //                                                (covers one_times
    //                                                that already fired
    //                                                and lost their
    //                                                next_fire_at)
    const events = db.all(
      `SELECT * FROM events
        WHERE (
          (remind_kind = 'one_time' AND remind_date = ?)
          OR (next_fire_at BETWEEN ? AND ?)
          OR (last_fired_at BETWEEN ? AND ?)
        )
        ORDER BY COALESCE(next_fire_at, remind_date) ASC`,
      [today_date, today_start, today_end, today_start, today_end]
    );

    // Look up the soft-completion state from reminder_acks. Restrict to
    // today's acks so that periodic events finished yesterday don't
    // re-mark as completed for the new day.
    const ackedTodayIds = new Set();
    if (events.length > 0) {
      const ids = events.map((e) => e.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.all(
        `SELECT source_id FROM reminder_acks
          WHERE source = 'event' AND acked_at LIKE ?
            AND source_id IN (${placeholders})`,
        [today_prefix + '%', ...ids]
      );
      for (const r of rows) ackedTodayIds.add(r.source_id);
    }

    // Also surface any queue item that the scheduler fired today but that
    // is NOT in the events list above — covers the edge case where the
    // event was completed (active=0) right after firing, or where the
    // event is a one_time that already got auto-deactivated. The queue
    // item still represents work the user was told about.
    const queueItems = queue.list();
    const eventIdsToday = new Set(events.map((e) => e.id));
    const extras = [];
    for (const q of queueItems) {
      if (q.source !== 'event') continue;
      if (eventIdsToday.has(q.source_id)) continue;
      // Only include queue items that fired today.
      if (q.next_fire_at && String(q.next_fire_at).slice(0, 10) === today_date) {
        extras.push(q);
      }
    }

    const decorate = (r) => ({
      source: 'event',
      source_id: r.source_id,
      title: r.title,
      description: r.description || null,
      contact_id: r.contact_id,
      contact_name: r.contact_name || null,
      next_fire_at: r.next_fire_at || null,
      remind_kind: r.remind_kind || null,
      category: r.category || 'general',
      dismissed_for_today: !!r.dismissed_for_today,
    });
    const view = [
      ...events.map((e) => decorate({
        source_id: e.id,
        title: e.title,
        description: e.description,
        contact_id: e.contact_id,
        contact_name: (() => {
          if (!e.contact_id) return null;
          const c = db.one('SELECT name FROM contacts WHERE id = ?', [e.contact_id]);
          return c ? c.name : null;
        })(),
        next_fire_at: e.next_fire_at,
        remind_kind: e.remind_kind,
        category: e.category,
        dismissed_for_today: ackedTodayIds.has(e.id),
      })),
      ...extras.map(decorate),
    ];

    // Pending items first, then completed — eye lands on what still needs
    // attention before drifting down into today's accomplishments.
    view.sort((a, b) => {
      if (a.dismissed_for_today !== b.dismissed_for_today) {
        return a.dismissed_for_today ? 1 : -1;
      }
      return (a.next_fire_at || '').localeCompare(b.next_fire_at || '');
    });

    return view;
  });

  // Mark a reminder as "completed for today" — the pet stops nagging, but
  // the queue item (and the 今日 page entry) remain visible. This is the
  // soft-dismiss action: the user said they handled it, but might want to
  // revisit it later in the day to confirm. A periodic reminder's next
  // occurrence tomorrow is still scheduled normally; the ack row we write
  // (next_fire_at = NULL) does not block future scanAndFire invocations.
  //
  // Works whether or not the event is in the live queue — the renderer
  // can mark a 今日-view item as completed even before the scheduler has
  // fired it. The reminder_acks row is the source of truth for "已确认
  // 完成"; the queue entry is just a transient nag mirror.
  ipcMain.handle('reminders:complete_for_today', (_e, source, sourceId) => {
    queue.dismissForToday(source, sourceId);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, NULL)`,
      [source, sourceId, db.nowStr()]
    );
    updatePetState({ queue, setPetState, setActiveReminder });
    return true;
  });

  // Backwards-compatible: older renderer builds still call mark_done. Same
  // semantic now (soft-dismiss for today) so behavior is consistent across
  // builds. Anything that actually wants to hard-remove a reminder should
  // delete the underlying event/important_date directly.
  ipcMain.handle('reminders:mark_done', (_e, source, sourceId) => {
    queue.dismissForToday(source, sourceId);
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
    // Reflect active (non-dismissed) reminders only. The pill mirrors the
    // pet's nag count, and dismissed items should not contribute to it.
    const head = queue.activeHead();
    return {
      state: getPetState() ? 'REMINDER' : 'NORMAL',
      count: queue.activeCount(),
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

  // ---- Pet registry (frame-based) ----
  // The renderer asks for the list of installed pets, the current petId, and
  // resolves an animation variant to a concrete frame list. Frames are
  // returned as file:// URLs the renderer can feed straight to <img src>.
  if (petRegistry) {
    ipcMain.handle('pet:list', () => petRegistry.list());
    ipcMain.handle('pet:get_current', () => {
      // Legacy migration: if pet_id is unset but pet_species is set (one of
      // the old hard-coded species), fall back to the first registered pet
      // and persist the new key on the way out.
      if (!db.getSetting('pet_id') && db.getSetting('pet_species')) {
        const first = petRegistry.list()[0];
        if (first) {
          db.setSetting('pet_id', first.id);
          if (petController && petController.petId !== first.id) {
            petController.petId = first.id;
          }
          return first.id;
        }
      }
      return db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id) || null;
    });
    ipcMain.handle('pet:set_current', (_e, id) => {
      if (petController && typeof petController.setPetId === 'function') {
        petController.setPetId(id);
      } else {
        db.setSetting('pet_id', id);
      }
      return true;
    });
    ipcMain.handle('pet:resolve_frames', (_e, petId, variant, direction) => {
      try {
        return petRegistry.resolveFrames({ petId, variant, direction });
      } catch (err) {
        console.error('[ipc] pet:resolve_frames failed:', err.message);
        throw err;
      }
    });
  }

  // ---- Pet pack import (desktop-pet style adapter) ----
  // These four handlers layer on top of the existing PetRegistry without
  // changing it. They:
  //   * surface a per-pet "is imported / origin / importedAt / description"
  //     view that the registry doesn't track itself;
  //   * pop a native file/folder picker, validate the pack, slice the
  //     spritesheet into per-frame PNGs, and install the result into
  //     `<userData>/MemoryPet/pets/imported-<hash>/`;
  //   * delete an imported pet directory; if the deletion would orphan the
  //     current pet, switch back to the first built-in first.
  //
  // The legacy `pet:list / get_current / set_current` channels are unchanged,
  // so the settings page dropdown and the new /pets page share the same
  // registry view of the world.

  // Resolve the userDataPath the same way PetRegistry.init() does so
  // installPack / removeImported land in the right place.
  function getPetsUserDataPath() {
    return path.join(app.getPath('appData'), 'MemoryPet', 'pets');
  }

  // First built-in pet id, or null when no built-in exists. Imported pets
  // (id starts with 'imported-') are skipped on purpose.
  function pickFirstBuiltinId() {
    if (!petRegistry) return null;
    const all = petRegistry.list();
    const builtin = all.find((p) => !String(p.id || '').startsWith('imported-'));
    return builtin ? builtin.id : null;
  }

  // Decorate a registry entry with the manifest extras the /pets UI needs
  // (description, origin, importedAt). Built-in pets get a stub object so
  // the UI can render them with the same shape.
  function decoratePetEntry(pet) {
    const userData = getPetsUserDataPath();
    if (String(pet.id).startsWith('imported-')) {
      const extras = readManifestExtras(userData, pet.id) || {};
      return {
        ...pet,
        description: extras.description || '',
        source: 'imported',
        origin: extras.origin || null,
        importedAt: extras.importedAt || null,
      };
    }
    return {
      ...pet,
      description: '',
      source: 'builtIn',
      origin: null,
      importedAt: null,
    };
  }

  ipcMain.handle('pet:list_installed', () => {
    if (!petRegistry) return [];
    return petRegistry.list().map(decoratePetEntry);
  });

  ipcMain.handle('pet:import_from_folder', async () => {
    if (!petRegistry) throw new Error('pet registry unavailable');
    const pick = await dialog.showOpenDialog(winMain, {
      title: '从文件夹导入桌宠',
      properties: ['openDirectory'],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    const folder = pick.filePaths[0];
    const pack = readFolderPack(folder);
    const installed = installPack(pack, getPetsUserDataPath());
    petRegistry.rescan();
    return {
      ok: true,
      deduped: !!installed.deduped,
      pet: { id: installed.id, name: pack.manifest.raw.name || 'Imported Character' },
    };
  });

  ipcMain.handle('pet:import_from_zip', async () => {
    if (!petRegistry) throw new Error('pet registry unavailable');
    const pick = await dialog.showOpenDialog(winMain, {
      title: '从 ZIP 导入桌宠',
      properties: ['openFile'],
      filters: [{ name: '桌宠包', extensions: ['zip'] }],
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
      return { canceled: true };
    }
    const zip = pick.filePaths[0];
    const pack = readZipPack(zip);
    const installed = installPack(pack, getPetsUserDataPath());
    petRegistry.rescan();
    return {
      ok: true,
      deduped: !!installed.deduped,
      pet: { id: installed.id, name: pack.manifest.raw.name || 'Imported Character' },
    };
  });

  ipcMain.handle('pet:remove_imported', (_e, petId) => {
    if (!petRegistry) throw new Error('pet registry unavailable');
    if (!isImportedId(petId)) {
      throw new Error('非导入桌宠不可删除');
    }
    let switchedTo = null;
    // If the user is currently using the pet they're about to delete, we
    // need to switch them off it first so the pet window doesn't end up
    // referencing a non-existent pet. setPetId() broadcasts pet:pet-changed
    // which the pet window already handles by clearing its frame cache.
    if (petController && petController.petId === petId) {
      const fallback = pickFirstBuiltinId();
      if (fallback && fallback !== petId) {
        petController.setPetId(fallback);
        switchedTo = fallback;
      } else {
        // No built-in to fall back to: refuse the deletion rather than
        // leaving the renderer pointing at a dead pet.
        throw new Error('当前正在使用该桌宠且没有内置备选，请先切换到其他桌宠');
      }
    }
    removeImported(petId, getPetsUserDataPath());
    petRegistry.rescan();
    return { ok: true, removed: petId, switchedTo };
  });

  // ---- Pet species / walk toggle ----
  // Legacy handlers kept for backwards compatibility with renderers that still
  // call getSpecies/setSpecies. They map onto the new pet_id machinery: any
  // of the four old species values picks the first installed pet.
  ipcMain.handle('pet:get_species', () => {
    if (petRegistry) {
      const cur = db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id);
      // Map back to a legacy token so older renderers don't break visually.
      if (cur) return 'cat';
    }
    const v = db.getSetting('pet_species');
    return (v === 'dog' || v === 'bird' || v === 'miku') ? v : 'cat';
  });
  ipcMain.handle('pet:set_species', (_e, species) => {
    if (petController && petRegistry) {
      const cur = db.getSetting('pet_id') || (petRegistry.list()[0] && petRegistry.list()[0].id);
      if (cur) petController.setPetId(cur);
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

  // One-shot variant (replaces the old Miku-only wave/sing): emit an
  // action-changed IPC for `ms` milliseconds, then the renderer restores
  // the underlying state automatically.
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
              const head = queue.activeHead();
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
  // Reflect active (non-dismissed) reminders only. After a soft "完成"
  // the queue still contains the dismissed item, but the pet should drop
  // back to NORMAL — so we key off activeCount/activeHead here.
  const len = queue.activeCount();
  if (len > 0) {
    setPetState(true);
    setActiveReminder(queue.activeHead());
  } else {
    setPetState(false);
    setActiveReminder(null);
  }
}

module.exports = { register };