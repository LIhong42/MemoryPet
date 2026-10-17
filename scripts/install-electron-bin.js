#!/usr/bin/env node
// scripts/install-electron-bin.js — explicit "download just the Electron
// binary" command. Wired as `npm run install:bin`. Use this when:
//   - you see "Electron failed to install correctly" from `require('electron')`
//   - you're on a slow link and want to retry the binary download without
//     a full `npm install`
//
// Honours the same env vars as the upstream postinstall:
//   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
//   ELECTRON_SKIP_BINARY_DOWNLOAD=1   (skip on purpose)
//   ELECTRON_OVERRIDE_DIST_PATH=...  (use a pre-staged dist/)

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const installJs = path.join(process.cwd(), 'node_modules', 'electron', 'install.js');
if (!fs.existsSync(installJs)) {
  console.error('node_modules/electron not installed. Run `npm install` first.');
  process.exit(1);
}

console.log('Re-running node_modules/electron/install.js …');
console.log('  ELECTRON_MIRROR =', process.env.ELECTRON_MIRROR || '(unset)');
console.log('  node version    =', process.version);
console.log('  platform/arch   =', process.platform + '/' + process.arch);

const r = spawnSync(process.execPath, [installJs], { stdio: 'inherit' });
process.exit(r.status ?? 1);
