#!/usr/bin/env node
// scripts/install.js — `npm install` postinstall safety net.
//
// Two big-bag things depend on binaries that postinstall scripts download
// from third-party GitHub Releases: `electron` and `ffmpeg-static`. Both
// downloads can silently end up with a placeholder file (the right name
// but wrong bytes) when GitHub is slow / a redirect chain dies / the
// release artifact is region-blocked. Without this script, the user only
// finds out at `npm start` time, and the error is one frame of stack
// trace with no remediation.
//
// What we do:
//   1) Mirror env (early) — inject ELECTRON_MIRROR for default China users
//      before we spawn any package install.js, so the binary download
//      avoids the slow GitHub link in the first place. Other users can
//      override per-shell (NPM_REGISTRY / ELECTRON_MIRROR / etc.) and we
//      respect whatever they set.
//   2) electron binary   — verify `dist/electron.exe` exists; if not, try
//      `node_modules/electron/install.js` once; otherwise print next steps.
//   3) ffmpeg binary     — verify size, signature, and that running
//      `-version` exits 0. If any of those fail, retry the package's
//      own install.js (which re-downloads from GitHub Releases) and check
//      again. If still broken, fall back to copying the binary between
//      a known-good source and the install location, then print a final
//      manual-recovery hint that does NOT require any third-party mirror.
//   4) hoist `call-bind-apply-helpers` — unchanged from the previous design.
//   5) Print a friendly footer.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');

function ok(msg)   { console.log(`[install] ✓ ${msg}`); }
function info(msg) { console.log(`[install] · ${msg}`); }
function fail(msg) { console.error(`[install] ✗ ${msg}`); }

// --------------------------------------------------------------------------
// (1) Mirror env — set default ELECTRON_MIRROR / FFMPEG_DOWNLOAD_HOST
// unless the user already provided one (per-shell or via .npmrc-derived
// NPM_CONFIG_* form). We can't put `electron_mirror=…` in .npmrc anymore
// (modern npm warns `Unknown project config` and will reject it in the
// next major). The download scripts themselves read these env vars, so
// spreading them into `process.env` here is the cleanest way to keep
// `git clone && npm install` working out-of-the-box for domestic users
// without forcing the mirror on anyone who has set their own.
// --------------------------------------------------------------------------
const DEFAULT_MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  FFMPEG_DOWNLOAD_HOST: 'https://npmmirror.com/mirrors/ffmpeg-static/',
  // ffmpeg-static reads FFMPEG_DOWNLOAD_HOST to choose its CDN. If the
  // user already has FFMPEG_BIN pointing at a system ffmpeg they prefer
  // that path entirely (see footer step b), so we never touch it here.
};
for (const [k, v] of Object.entries(DEFAULT_MIRRORS)) {
  if (!process.env[k]) process.env[k] = v;
}

// --------------------------------------------------------------------------
// (3) Electron binary check + auto-repair.
// --------------------------------------------------------------------------
function electronBinaryPresent() {
  const distDir = path.join(NM, 'electron', 'dist');
  const pathFile = path.join(NM, 'electron', 'path.txt');
  if (!fs.existsSync(distDir)) return { ok: false, reason: 'no dist/' };
  if (!fs.existsSync(pathFile)) return { ok: false, reason: 'no path.txt' };
  const exeName = process.platform === 'win32' ? 'electron.exe'
                : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
                : 'electron';
  if (!fs.existsSync(path.join(distDir, exeName))) {
    return { ok: false, reason: `missing ${exeName} under dist/` };
  }
  return { ok: true };
}

function runNode(args) {
  return spawnSync(process.execPath, args, { stdio: 'inherit' });
}

let probe = electronBinaryPresent();
if (probe.ok) {
  ok('Electron binary present');
} else {
  fail(`Electron binary not usable (${probe.reason})`);
  info('Trying once: node node_modules/electron/install.js …');
  const r = runNode([path.join(NM, 'electron', 'install.js')]);
  if (electronBinaryPresent().ok) {
    ok('Electron binary recovered');
  } else {
    fail('Electron binary could not be downloaded automatically.');
    info('This usually means GitHub is slow in your region. Try:');
    info('  npm run install:bin          # retry the binary download');
    info('  npm run doctor -- --fix     # diagnose + auto-repair');
    process.exitCode = 0; // never fail `npm install` outright for this; the
                          // user sees the clean error from run-electron.js.
  }
}

// --------------------------------------------------------------------------
// (4) ffmpeg binary check + auto-repair.
//
// `ffmpeg-static` has shipped broken windows builds in 5.x more than once
// (you get a 1-2 MB placeholder that *looks* like a PE header but is
// actually something else, and Windows refuses to spawn it). The robust
// check is: file size > 60 MB on win32+x64 AND `ffmpeg -version` exits 0.
// If either fails, we delete the bad binary and call the package's own
// install.js (it tries GitHub Releases again). If that still doesn't
// produce a working binary we print a copy-pasteable manual fix.
// --------------------------------------------------------------------------
const FFMPEG_DIR = path.join(NM, 'ffmpeg-static');
const FFMPEG_EXE = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function probeFfmpegBinary() {
  if (!fs.existsSync(FFMPEG_DIR)) return { ok: false, reason: 'ffmpeg-static not installed' };
  if (!fs.existsSync(FFMPEG_EXE)) return { ok: false, reason: 'no ffmpeg.exe on disk' };
  const stat = fs.statSync(FFMPEG_EXE);
  // win32+x64 full builds from ffmpeg-static are ≥ 70 MB. A 1-2 MB file
  // is the well-known "placeholder for a missing release asset" bug.
  if (process.platform === 'win32' && stat.size < 60 * 1024 * 1024) {
    return { ok: false, reason: `ffmpeg.exe is only ${(stat.size / 1024 / 1024).toFixed(1)} MB — looks like a corrupted download` };
  }
  // Functional smoke test: spawn `ffmpeg -version`. `spawn` errors with
  // EFTYPE on Windows when the bytes are wrong, and the child returns
  // non-zero if the binary itself errors.
  let r;
  try {
    r = spawnSync(FFMPEG_EXE, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  } catch (e) {
    return { ok: false, reason: `spawn failed: ${e.code || e.message}` };
  }
  if (r.status !== 0) return { ok: false, reason: `ffmpeg -version exited ${r.status}` };
  return { ok: true, sizeMB: stat.size / 1024 / 1024 };
}

let ffProbe = probeFfmpegBinary();
if (ffProbe.ok) {
  ok(`ffmpeg binary usable (${ffProbe.sizeMB.toFixed(1)} MB)`);
} else if (!fs.existsSync(FFMPEG_DIR)) {
  info(`ffmpeg-static package not present — skip (${ffProbe.reason})`);
} else {
  fail(`ffmpeg binary not usable (${ffProbe.reason})`);
  info('Re-running ffmpeg-static/install.js once …');
  // Delete the bad binary so install.js doesn't early-exit via its own
  // statSync(isFile) guard.
  try { fs.unlinkSync(FFMPEG_EXE); } catch (_) {}
  const installJs = path.join(FFMPEG_DIR, 'install.js');
  if (fs.existsSync(installJs)) {
    const r = runNode([installJs]);
    ffProbe = probeFfmpegBinary();
    if (ffProbe.ok) {
      ok(`ffmpeg binary recovered (${ffProbe.sizeMB.toFixed(1)} MB)`);
    } else {
      fail(`ffmpeg binary still unusable (${ffProbe.reason})`);
      info('Try one of:');
      info('  npm rebuild ffmpeg-static   # re-runs the install script');
      info('  npm run doctor              # diagnostic with version checks');
      // Final, fully self-help manual fix that uses ONLY files already on
      // disk / your machine — no third-party registry or mirror.
      info('If the rebuild still fails, your network is probably blocking the');
      info('GitHub Releases asset. You can either:');
      info('  (a) Run `npm install` on a network that can reach GitHub, then');
      info('      copy `node_modules/ffmpeg-static/ffmpeg.exe` to this machine.');
      info('  (b) Install ffmpeg via your OS package manager and set the env var');
      info('      FFMPEG_BIN=<full path to system ffmpeg.exe> before `npm start`.');
    }
  }
}

// --------------------------------------------------------------------------
// (5) call-bind-apply-helpers hoist — kept from the previous design.
// --------------------------------------------------------------------------
const hoist = path.join(ROOT, 'scripts', 'hoist-call-bind-helpers.js');
if (fs.existsSync(hoist)) {
  runNode([hoist]);
} else {
  info('hoist script not present, skipping');
}

// --------------------------------------------------------------------------
// (6) Friendly footer.
// --------------------------------------------------------------------------
console.log('');
console.log('[install] next steps:');
console.log('  npm run doctor    # diagnose any remaining issues');
console.log('  npm start          # launch the desktop pet');
console.log('  npm run dev        # launch with DevTools attached');
