// scripts/smoke-memorial-v2.js — exercise the v2 (5-field) memorial_events
// schema end-to-end. Boot a sandbox DB, seed an old-schema memorial row
// containing a `description`, run the open() migration pipeline, and verify
// the description was copied into `notes` while place/food/outfit/
// activities are NULL. Then create+get a fresh row with all 5 fields
// populated and confirm round-trip fidelity, and confirm search returns
// hits on each of the 5 fields. Exits 0 on success.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-smoke-v2-'));
app.setPath('appData', sandbox);

const db = require('../main/db');
const ipc = require('../main/ipc');

const queue = { len: () => 0, head: () => null, remove: () => {}, list: () => [], on: () => {} };
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} }, show: () => {}, focus: () => {} };
const setPetState = () => {};
const getPetState = () => false;
const setActiveReminder = () => {};

async function invoke(channel, ...args) {
  const internal = ipcMain._invokeHandlers;
  if (!internal || !internal.has(channel)) throw new Error('no handler: ' + channel);
  return internal.get(channel)({}, ...args);
}

function fail(msg) {
  console.error('SMOKE FAIL:', msg);
  process.exit(1);
}

async function run() {
  process.stderr.write('STAGE 1: seed legacy row\n');
  // ---- Stage 1: seed an old-schema DB ----
  // Open DB, manually CREATE the legacy memorial_events with a `description`
  // column, INSERT one row, then close the db and re-open so migrations run.
  const dbFile = path.join(sandbox, 'memorypet.db');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  let raw = new SQL.Database();
  raw.run(`CREATE TABLE memorial_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    description TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const stmt = raw.prepare(
    `INSERT INTO memorial_events(id, kind, title, description, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(['legacy-row-1', 'other', 'legacy test', '旧的一段描述\n多行内容', '2026-09-01 10:00:00', '2026-09-01 10:00:00', '2026-09-01 10:00:00']);
  stmt.free();
  fs.writeFileSync(dbFile, Buffer.from(raw.export()));
  raw.close();

  // ---- Stage 2: open via the real open() so migrations run ----
  process.stderr.write('STAGE 2: open DB + register IPC\n');
  await db.open(dbFile);
  ipc.register({ queue, winMain: fakeWin, winPet: null, setPetState, getPetState, setActiveReminder });
  process.stderr.write('STAGE 2 OK\n');
  const forceTimer = setTimeout(() => { console.error('SMOKE FAIL: hang'); process.exit(1); }, 15000);

  // ---- Stage 3: verify legacy row was migrated ----
  process.stderr.write('STAGE 3: invoke get(legacy-row-1)\n');
  const legacyRow = await invoke('memorial_events:get', 'legacy-row-1');
  process.stderr.write('STAGE 3 returned\n');
  if (!legacyRow) fail('legacy row missing after migration');
  if (legacyRow.notes !== '旧的一段描述\n多行内容') {
    fail('notes != old description, got: ' + JSON.stringify(legacyRow.notes));
  }
  if (legacyRow.place !== null || legacyRow.food !== null ||
      legacyRow.outfit !== null || legacyRow.activities !== null) {
    fail('expected NULL for place/food/outfit/activities; got ' +
      JSON.stringify({place: legacyRow.place, food: legacyRow.food,
                      outfit: legacyRow.outfit, activities: legacyRow.activities}));
  }
  console.log('SMOKE OK: legacy description migrated into notes');

  // ---- Stage 4: create a new row with all 5 fields populated ----
  const created = await invoke('memorial_events:create', {
    kind: 'first_time',
    title: 'first cafe',
    place: '西湖边的咖啡店',
    food: '寿喜烧',
    outfit: '红色连衣裙',
    activities: '看了日落',
    notes: '补充一下：风很大',
    occurred_at: '2026-10-05 18:00:00',
    contact_ids: [],
  });
  const got = await invoke('memorial_events:get', created.id);
  if (got.place !== '西湖边的咖啡店' || got.food !== '寿喜烧' ||
      got.outfit !== '红色连衣裙' || got.activities !== '看了日落' ||
      got.notes !== '补充一下：风很大') {
    fail('round-trip mismatch: ' + JSON.stringify(got));
  }
  console.log('SMOKE OK: 5-field round-trip on create');

  // ---- Stage 5: update partial fields, confirm fall-back to existing ----
  // Run the search probe on the freshly-created row (stage 4) BEFORE the
  // partial update so all 5 fields are still populated.
  for (const [probe, field] of [
    ['咖啡店', 'place'],
    ['寿喜烧', 'food'],
    ['红色连衣裙', 'outfit'],
    ['日落', 'activities'],
    ['风很大', 'notes'],
  ]) {
    const r = await invoke('search:query', probe);
    const ids = (r.memorial_events || []).map((e) => e.id);
    if (!ids.includes(created.id)) {
      fail('search "' + probe + '" (should hit ' + field + ') missed our row; got: ' + JSON.stringify(ids));
    }
  }
  console.log('SMOKE OK: search hits each of place / food / outfit / activities / notes');

  await invoke('memorial_events:update', created.id, {
    kind: 'first_time',
    title: 'first cafe',
    // Intentionally omit food + activities — server should preserve them.
    place: '另一家咖啡店',
    outfit: '换了一件白衬衫',
    notes: '',
    occurred_at: '2026-10-05 18:00:00',
    contact_ids: [],
  });
  const after = await invoke('memorial_events:get', created.id);
  if (after.place !== '另一家咖啡店') fail('update.place: ' + after.place);
  if (after.food !== '寿喜烧') fail('update.food should be preserved; got: ' + after.food);
  if (after.outfit !== '换了一件白衬衫') fail('update.outfit: ' + after.outfit);
  if (after.activities !== '看了日落') fail('update.activities should be preserved; got: ' + after.activities);
  if (after.notes !== null) fail('empty notes should become null; got: ' + JSON.stringify(after.notes));
  console.log('SMOKE OK: partial update preserves unspecified fields; empty notes → null');

  // ---- Stage 6: legacy description is still searchable through `notes` ----
  const r2 = await invoke('search:query', '旧的一段');
  if (!(r2.memorial_events || []).some((e) => e.id === 'legacy-row-1')) {
    fail('legacy description not searchable via notes; got: ' + JSON.stringify(r2.memorial_events));
  }
  console.log('SMOKE OK: legacy description searchable via notes');

  clearTimeout(forceTimer);
  process.exit(0);
}

app.whenReady().then(run).catch((e) => {
  console.error('SMOKE FAIL (boot):', e);
  process.exit(1);
});