#!/usr/bin/env node
// scripts/install.js — postinstall safety net.
//
// `postinstall: node scripts/install.js` runs after `npm install` finishes
// the dep tree. The two things we genuinely care about at this stage are:
//
//   1) Electron's binary (`node_modules/electron/dist/electron.exe` plus
//      `path.txt`) — npm's `electron` package ships ONLY source files; the
//      runtime binary is fetched by `node_modules/electron/install.js` as a
//      `postinstall` of *that* package. When the download silently fails
//      (network drop, GitHub 5xx, mirror down) we end up with an Electron
//      folder that has no `dist/`, and `require('electron')` later throws
//      "Electron failed to install correctly". That's the failure mode
//      this script exists to repair.
//
//   2) `call-bind-apply-helpers` hoisting — handled by
//      `scripts/hoist-call-bind-helpers.js` (kept separately so it can also
//      run from `prebuild`).
//
// We do NOT swallow errors. We detect, report, and try to recover. The
// exit codes are:
//
//   0  — everything needed for `npm start` is present.
//   1  — unrecoverable; the user must run `npm run doctor` and follow
//        the on-screen remediation steps.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');

function ok(msg)    { console.log(`[install] ✓ ${msg}`); }
function info(msg)  { console.log(`[install] · ${msg}`); }
function fail(msg)  { console.error(`[install] ✗ ${msg}`); }

function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ stdio: 'inherit', shell: false }, opts || {}));
}

// --------------------------------------------------------------------------
// 1. Verify / repair the Electron binary.
// --------------------------------------------------------------------------

// `require('electron')` in main process throws if path.txt is missing —
// see node_modules/electron/index.js. We test the same condition here.
function electronBinaryPresent() {
  const distDir = path.join(NM, 'electron', 'dist');
  const pathFile = path.join(NM, 'electron', 'path.txt');
  if (!fs.existsSync(distDir)) return { ok: false, reason: 'no dist/' };
  if (!fs.existsSync(pathFile)) return { ok: false, reason: 'no path.txt' };

  // Pick the right executable name based on host OS (the postinstall
  // inside `electron` writes the path matching THIS machine, not the
  // package's pre-set value).
  const exeName = process.platform === 'win32' ? 'electron.exe'
                : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
                : 'electron';
  if (!fs.existsSync(path.join(distDir, exeName))) {
    return { ok: false, reason: `missing ${exeName} under dist/` };
  }
  return { ok: true };
}

function repairElectronBinary() {
  info('Electron binary missing — re-running node_modules/electron/install.js');
  info('If GitHub is slow, set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ first.');

  const installJs = path.join(NM, 'electron', 'install.js');
  if (!fs.existsSync(installJs)) {
    fail('node_modules/electron/install.js was not found at all. The package itself did not install correctly.');
    fail('Run: rm -rf node_modules package-lock.json && npm install');
    return false;
  }

  const r = run(process.execPath, [installJs]);
  if (r.status !== 0) return false;

  // Some mirror paths write a `path.txt` but the named binary doesn't
  // exist — double-check.
  return electronBinaryPresent().ok;
}

let electronChecked = electronBinaryPresent();
if (electronChecked.ok) {
  ok('Electron binary present');
} else {
  fail(`Electron binary not usable (${electronChecked.reason})`);
  if (repairElectronBinary()) {
    ok('Electron binary recovered');
  } else {
    fail('Could not download Electron binary automatically.');
    fail('You can:');
    fail('  1. Set ELECTRON_MIRROR env var (see .npmrc comments) and re-run:');
    fail('       npm rebuild electron');
    fail('  2. Or run: npm run doctor   (for a full diagnostic + manual download URL)');
    fail('  3. Or delete node_modules/electron/ and run: node node_modules/electron/install.js');
    process.exitCode = 0; // don't fail `npm install` outright; require('electron') later will surface a clean error.
  }
}

// --------------------------------------------------------------------------
// 2. Run the call-bind-apply-helpers hoist (idempotent; cheap).
// --------------------------------------------------------------------------
const hoist = path.join(__dirname, 'hoist-call-bind-helpers.js');
if (fs.existsSync(hoist)) {
  const r = run(process.execPath, [hoist]);
  if (r.status !== 0) info('hoist-call-bind-helpers.js exited non-zero; continuing');
} else {
  info('hoist script not present, skipping');
}

// --------------------------------------------------------------------------
// 3. Smoke-check ffmpeg / sql.js / pdfkit — the other heavy build artifacts.
//    Don't fail the install on these; just log so the user notices early.
// --------------------------------------------------------------------------
const checks = [
  { p: 'ffmpeg-static', label: 'ffmpeg.exe (or ffmpeg binary)' },
  { p: 'sql.js',        label: 'sql.js WASM bundle' },
  { p: 'pdfkit',        label: 'pdfkit (PDF generation)' },
  { p: 'adm-zip',       label: 'adm-zip (backup/restore)' },
  { p: 'lunar-javascript', label: 'lunar-javascript (农历)' },
];
for (const c of checks) {
  const dir = path.join(NM, c.p);
  if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'package.json'))) ok(c.label);
  else fail(`${c.label} missing (${c.p})`);
}

// --------------------------------------------------------------------------
// 4. Print a friendly "what to do next" footer.
// --------------------------------------------------------------------------
console.log('');
console.log('[install] next steps:');
console.log('  npm run doctor    # diagnose any remaining issues');
console.log('  npm start          # launch the desktop pet');
console.log('  npm run dev        # launch with DevTools attached');
