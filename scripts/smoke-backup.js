// scripts/smoke-backup.js — exercise backup round-trip (export → apply) on
// a sandbox DB. Stubs the OS file dialogs so the smoke runs headless.
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-smoke-backup-'));
app.setPath('appData', sandbox);

const db = require('../main/db');
const ipc = require('../main/ipc');

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} }, show: () => {}, focus: () => {} };
let queueClearCount = 0;
const queue = {
  len: () => 0, head: () => null, list: () => [],
  remove: () => null, pushIfNew: () => false,
  clear: () => { queueClearCount += 1; },
};
const setPetState = () => {};
const getPetState = () => false;
const setActiveReminder = () => {};

async function invoke(channel, ...args) {
  const internal = ipcMain._invokeHandlers;
  if (!internal || !internal.has(channel)) throw new Error('no handler: ' + channel);
  return internal.get(channel)({}, ...args);
}

function fail(msg) { console.error('SMOKE FAIL:', msg); process.exit(1); }

async function run() {
  // ---- Stage 1: seed source DB ----
  await db.open(path.join(sandbox, 'memorypet.db'));
  ipc.register({ queue, winMain: fakeWin, winPet: null, setPetState, getPetState, setActiveReminder });
  const forceTimer = setTimeout(() => { console.error('SMOKE FAIL: hang'); process.exit(1); }, 30000);

  const alice = await invoke('contacts:create', { name: 'Alice', relationship: '朋友' });
  const bob   = await invoke('contacts:create', { name: 'Bob',   relationship: '同事' });
  const ev = await invoke('memorial_events:create', {
    kind: 'first_time', title: 'first cafe',
    place: '西湖边', food: '寿喜烧', outfit: '红色连衣裙',
    activities: '看了日落', notes: '风很大',
    occurred_at: '2026-10-05 18:00:00', contact_ids: [alice.id, bob.id],
  });

  const png = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
    '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );
  const photoRow = await invoke('memorial_events:photos_upload', ev.id, {
    filename: 'pixel.png', mime: 'image/png', bytes: png,
  });

  // ---- Stage 2: stub dialog.showSaveDialog and run backup:export ----
  const zipPath = path.join(sandbox, 'backup.zip');
  const origSave = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: zipPath });
  let r;
  try {
    r = await invoke('backup:export');
  } finally {
    dialog.showSaveDialog = origSave;
  }
  if (!r || r.canceled || r.path !== zipPath) fail('export returned ' + JSON.stringify(r));
  if (!fs.existsSync(zipPath)) fail('zip not written');
  console.log('SMOKE OK: backup:export wrote ' + zipPath);

  // ---- Stage 3: zip contains memorypet.db and photos/<id>/pixel.png ----
  const inspect = new AdmZip(zipPath);
  const names = inspect.getEntries().map((e) => e.entryName).sort();
  if (!names.includes('memorypet.db')) fail('zip missing memorypet.db: ' + names);
  const photoEntry = names.find((n) => n.endsWith('pixel.png'));
  if (!photoEntry) fail('zip missing photo: ' + names.join(', '));
  // photoEntry should look like 'photos/<eventId>/pixel.png'
  if (!photoEntry.startsWith('photos/')) fail('photoEntry path wrong: ' + photoEntry);
  const photoBytes = inspect.getEntry(photoEntry).getData();
  if (!photoBytes.equals(png)) fail('photo bytes mismatch in zip');
  console.log('SMOKE OK: zip contains db + photos with intact bytes');

  // ---- Stage 4: prepare a different target DB + simulate import ----
  // Pretend we are a fresh machine with totally different data.
  db.close();
  const targetPath = path.join(sandbox, 'target.db');
  await db.open(targetPath);
  // Write a different contact so the DB is clearly distinct from the source.
  await invoke('contacts:create', { name: 'Stranger', relationship: '陌生人' });
  const sourceContacts = await invoke('contacts:list', {});
  if (!sourceContacts.find((c) => c.name === 'Stranger')) {
    fail('Stranger contact not visible after seeding');
  }
  // Re-stub the open dialog (just in case).
  const origOpen = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [zipPath] });
  let picked;
  try {
    picked = await invoke('backup:import');
  } finally {
    dialog.showOpenDialog = origOpen;
  }
  if (!picked || picked.canceled) fail('import returned canceled');

  // ---- Stage 5: apply the backup ----
  await invoke('backup:apply', picked.path);

  // ---- Stage 6: verify the swap took effect ----
  const newContacts = await invoke('contacts:list', {});
  if (newContacts.find((c) => c.name === 'Stranger')) fail('Stranger still present after import');
  const foundAlice = newContacts.find((c) => c.name === 'Alice');
  const foundBob   = newContacts.find((c) => c.name === 'Bob');
  if (!foundAlice || !foundBob) fail('imported contacts missing: ' + newContacts.map((c) => c.name).join(','));

  // Memorial event + photo round-trip
  const memorial = await invoke('memorial_events:list', {});
  const got = memorial.find((m) => m.title === 'first cafe');
  if (!got) fail('memorial event missing after import');
  if (got.place !== '西湖边' || got.food !== '寿喜烧' ||
      got.outfit !== '红色连衣裙' || got.activities !== '看了日落' ||
      got.notes !== '风很大') {
    fail('memorial fields round-trip mismatch: ' + JSON.stringify(got));
  }
  // first_photo_id should still resolve to a valid photo row
  const photos = await invoke('memorial_events:photos_list', got.id);
  if (!photos.find((p) => p.id === got.first_photo_id)) {
    fail('first_photo_id not in photos list after import');
  }

  // The actual photo bytes on disk should match what we wrote.
  const photosDir = path.join(app.getPath('appData'), 'MemoryPet', 'photos');
  const onDisk = path.join(photosDir, got.id, 'pixel.png');
  if (!fs.existsSync(onDisk)) fail('photo file missing on disk after import');
  if (!fs.readFileSync(onDisk).equals(png)) fail('photo bytes on disk mismatch');

  // The queue should have been cleared exactly once.
  if (queueClearCount !== 1) fail('queue.clear() should be called once; got ' + queueClearCount);

  // last_import_at should be set.
  const lastImport = await invoke('settings:get', 'last_import_at');
  if (!lastImport) fail('last_import_at not set');

  console.log('SMOKE OK: backup:apply replaced DB + photos + cleared reminder queue');

  // ---- Stage 7: failure paths ----
  // Bad zip — missing memorypet.db entry.
  const badZipPath = path.join(sandbox, 'bad.zip');
  const badZip = new AdmZip();
  badZip.addFile('readme.txt', Buffer.from('hello'));
  badZip.writeZip(badZipPath);
  try {
    await invoke('backup:apply', badZipPath);
    fail('apply should have thrown for missing memorypet.db');
  } catch (e) {
    if (!String(e.message).includes('memorypet.db')) fail('wrong error: ' + e.message);
  }
  console.log('SMOKE OK: backup:apply rejects zip without memorypet.db');

  // Nonexistent zipPath.
  try {
    await invoke('backup:apply', path.join(sandbox, 'does-not-exist.zip'));
    fail('apply should have thrown for missing zipPath');
  } catch (e) {
    if (!String(e.message).includes('不存在')) fail('wrong error: ' + e.message);
  }
  console.log('SMOKE OK: backup:apply rejects missing zipPath');

  clearTimeout(forceTimer);
  process.exit(0);
}

app.whenReady().then(run).catch((e) => {
  console.error('SMOKE FAIL (boot):', e);
  process.exit(1);
});