// main/main.js — Electron entry: DB, scheduler, IPC, two windows
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const scheduler = require('./scheduler');
const ipc = require('./ipc');
const { PetController } = require('./pet_controller');

const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Surface unhandled rejections with a stack instead of Node's default one-
// liner. Prevents the cryptic "UnhandledPromiseRejectionWarning" that
// Electron emits otherwise when any awaitable chain in the main process
// rejects without a catch.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
});

// Single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let winMain = null;
let winPet = null;
let petState = false; // false = NORMAL, true = REMINDER
let activeReminder = null;
let petController = null;

function setPetState(v) {
  if (petState === v) return;
  petState = v;
  broadcastPetState();
}

function getPetState() { return petState; }

function setActiveReminder(r) { activeReminder = r; }

function broadcastPetState() {
  const head = queue.head();
  const payload = {
    state: petState ? 'REMINDER' : 'NORMAL',
    count: queue.len(),
    // Carry enough of `head` that the pet window can render a meaningful
    // speech bubble without an extra round-trip back to us. Fields are
    // already on the head object (see scheduler.ReminderQueue → scanAndFire).
    head: head ? {
      title: head.title,
      contact_name: head.contact_name || null,
      description: head.description || null,
    } : null,
  };
  if (winPet && !winPet.isDestroyed()) winPet.webContents.send('pet:state-changed', payload);
  if (winMain && !winMain.isDestroyed()) winMain.webContents.send('pet:state-changed', payload);
}

const queue = new scheduler.ReminderQueue();
queue.on((payload) => {
  broadcastPetState();
});

function createWindows() {
  const petX = parseInt(db.getSetting('pet_x') || '200', 10);
  const petY = parseInt(db.getSetting('pet_y') || '200', 10);

  winPet = new BrowserWindow({
    width: 220,
    height: 240,
    x: petX,
    y: petY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    focusable: false,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  winPet.setIgnoreMouseEvents(false); // CSS hit-target handles click-through; we keep mouse events ON.
  winPet.loadFile(path.join(__dirname, '..', 'src', 'pet.html'));
  winPet.setAlwaysOnTop(true, 'screen-saver');

  winPet.on('moved', () => {
    if (!winPet || winPet.isDestroyed()) return;
    const [x, y] = winPet.getPosition();
    db.setSetting('pet_x', String(x));
    db.setSetting('pet_y', String(y));
  });

  winMain = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    center: true,
    title: 'MemoryPet',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  winMain.removeMenu();
  winMain.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  winMain.once('ready-to-show', () => {
    // Main window starts hidden — user opens it via pet click or Settings.
    // In dev mode, always show the main window on launch so the developer
    // can iterate on the UI without having to click the pet each time.
    if (isDev) {
      winMain.show();
      winMain.focus();
    }
  });

  if (isDev) {
    winMain.webContents.on('did-finish-load', () => {
      winMain.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

function getDbPath() {
  // %APPDATA%/MemoryPet/memorypet.db
  const dir = path.join(app.getPath('appData'), 'MemoryPet');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'memorypet.db');
}

app.on('second-instance', () => {
  if (winMain && !winMain.isDestroyed()) {
    if (!winMain.isVisible()) winMain.show();
    winMain.focus();
  }
});

app.whenReady().then(async () => {
  await db.open(getDbPath());

  createWindows();

  // Start the autonomous-movement state machine. Created here (after the
  // pet window exists) so it has a window reference to translate.
  petController = new PetController({ winPet, db });
  petController.start();

  ipc.register({
    queue,
    winMain,
    winPet,
    setPetState,
    getPetState,
    setActiveReminder,
    petController,
  });

  scheduler.start({
    app,
    winMain,
    winPet,
    queue,
    getPetState,
    setPetState,
    setActiveReminder,
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on('window-all-closed', () => {
  // Quit on Windows/Linux when both windows close. The pet window itself has
  // no close button (frame:false), so this only fires after the main window
  // is closed too — or via the explicit "退出 MemoryPet" button in Settings.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  scheduler.stop();
  if (petController) petController.stop();
  try { db.save(); } catch (e) { console.error('db save error:', e); }
});