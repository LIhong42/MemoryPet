// scripts/smoke-photo-read.js — one-shot Electron IPC smoke test for the
// data-URL photo pipeline. Boots the real main process, opens the DB + IPC
// registration in-process (so we exercise the exact same code path the app
// uses), creates a memorial event, uploads a tiny PNG, calls photo_read,
// and prints the size of the returned data URL. Quits with status 0 on
// success, 1 on failure.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Force a sandbox appData so we don't trample the user's real db/photos.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-smoke-'));
app.setPath('appData', sandbox);

const db = require('../main/db');
const ipc = require('../main/ipc');

const queue = { len: () => 0, head: () => null, remove: () => {}, list: () => [], on: () => {} };
// Stub the windowing callbacks — IPC handlers don't actually use these for
// the memorial_events:* channels, only the reminders/pet/window channels.
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} }, show: () => {}, focus: () => {} };
const setPetState = () => {};
const getPetState = () => false;
const setActiveReminder = () => {};

// Fire-and-forget IPC invocation. We bypass ipcRenderer entirely because
// we're inside the main process; ipcMain.handle(… ) registers a function
// on `ipcMain._invokeHandlers` that takes (event, …args) and returns a
// Promise. This is the same code path the renderer hits.
async function invoke(channel, ...args) {
  const internal = ipcMain._invokeHandlers;
  if (!internal || !internal.has(channel)) {
    throw new Error('no handler registered for ' + channel);
  }
  return internal.get(channel)({}, ...args);
}

async function run() {
  await db.open(path.join(sandbox, 'memorypet.db'));
  ipc.register({ queue, winMain: fakeWin, winPet: null, setPetState, getPetState, setActiveReminder });
  // Force-exit safety: don't wait for the next event loop tick. The IPC
  // handlers we exercise never create windows, so a 50ms grace is plenty.
  const forceTimer = setTimeout(() => { console.error('SMOKE FAIL: hang'); process.exit(1); }, 15000);

  // Create a memorial event via the same handler the renderer uses.
  const ev = await invoke('memorial_events:create', {
    kind: 'other',
    title: 'smoke',
    description: null,
    occurred_at: '2026-10-05 12:00:00',
    contact_ids: [],
  });

  // 1×1 transparent PNG.
  const png = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
    '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );

  const photoRow = await invoke('memorial_events:photos_upload', ev.id, {
    filename: 'pixel.png', mime: 'image/png', bytes: png,
  });

  const result = await invoke('memorial_events:photo_read', photoRow.id);
  if (!result || !result.data_url) {
    console.error('SMOKE FAIL: photo_read returned', result);
    process.exit(1);
  }
  if (!result.data_url.startsWith('data:image/png;base64,')) {
    console.error('SMOKE FAIL: unexpected data_url prefix:', result.data_url.slice(0, 40));
    process.exit(1);
  }
  console.log('SMOKE OK: data_url length=' + result.data_url.length + ' mime=' + result.mime);

  const list = await invoke('memorial_events:list', {});
  if (!list[0] || list[0].first_photo_id !== photoRow.id) {
    console.error('SMOKE FAIL: listMemorialEvents first_photo_id mismatch:', list[0] && list[0].first_photo_id);
    process.exit(1);
  }
  console.log('SMOKE OK: first_photo_id =', list[0].first_photo_id);

  clearTimeout(forceTimer);
  process.exit(0);
}

app.whenReady().then(run).catch((e) => {
  console.error('SMOKE FAIL (boot):', e);
  process.exit(1);
});