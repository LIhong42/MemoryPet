#!/usr/bin/env node
// scripts/run-electron.js — launches electron with hostile env vars cleared,
// and refuses to start with a clear error if the Electron binary is missing
// (so the user sees ONE actionable message instead of a stack trace from
// `require('electron')`).
// Usage: node scripts/run-electron.js <args...>  (e.g. `.` or `. --dev`)

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Strip variables that break Electron's main-process bootstrap.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_NO_ATTACH_CONSOLE;

// Pre-flight check: resolve the electron binary. `require('electron')` throws
// "Electron failed to install correctly, please delete node_modules/electron"
// when the binary is missing — we instead catch it and print steps the user
// can run RIGHT NOW to fix it.
function resolveElectronBin() {
  const electronRoot = path.join(__dirname, '..', 'node_modules', 'electron');
  const distDir = path.join(electronRoot, 'dist');
  const pathFile = path.join(electronRoot, 'path.txt');

  // The real cause 99% of the time is `node_modules/electron/dist/` not
  // existing because the `electron` package's postinstall failed silently.
  if (!fs.existsSync(electronRoot)) {
    return { ok: false, why: 'node_modules/electron is missing — run `npm install` first.' };
  }
  if (!fs.existsSync(distDir) || !fs.existsSync(pathFile)) {
    const exe = process.platform === 'win32' ? 'electron.exe'
              : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
              : 'electron';
    return {
      ok: false,
      why: `Electron binary not installed (no ${path.relative(path.join(__dirname, '..'), distDir)}).`,
      fixes: [
        'npm run doctor       # diagnose & auto-fix',
        'npm rebuild electron  # re-run electron/postinstall only',
        'npm run install:bin   # or run scripts/install-electron-bin.js directly',
        'If GitHub is slow in your region: set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ then re-run.',
      ],
    };
  }

  // path.txt is a relative pointer — concatenate it onto dist/.
  const rel = fs.readFileSync(pathFile, 'utf-8').trim();
  const bin = path.join(distDir, rel);
  if (!fs.existsSync(bin)) {
    return {
      ok: false,
      why: `Electron binary path.txt points at ${rel}, but it doesn't exist on disk.`,
      fixes: [
        'rm -rf node_modules/electron && npm rebuild electron',
        'or: `npm run doctor`',
      ],
    };
  }
  return { ok: true, bin };
}

const probe = resolveElectronBin();
if (!probe.ok) {
  console.error('\n[soul-desktop-pet] Cannot start — ' + probe.why + '\n');
  if (probe.fixes) {
    console.error('Try in order:');
    probe.fixes.forEach((f) => console.error('  • ' + f));
    console.error('');
  }
  process.exit(2);
}

const args = process.argv.slice(2);

const child = spawn(probe.bin, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('Failed to launch electron:', err);
  process.exit(1);
});
