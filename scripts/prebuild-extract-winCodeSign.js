// scripts/prebuild-extract-winCodeSign.js
// Pre-extracts all winCodeSign 7z archives without the -snl flag,
// avoiding the "Cannot create symbolic link" failures on Windows
// where SeCreateSymbolicLinkPrivilege is not granted to the user.
// Runs at the start of `npm run build` to seed the cache before
// app-builder.exe re-extracts (and re-fails) on its own.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const path7za = require('../node_modules/7zip-bin').path7za;

const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'electron-builder/Cache/winCodeSign');

if (!fs.existsSync(cacheRoot)) {
  console.log('[prebuild] no winCodeSign cache yet; nothing to pre-extract');
  process.exit(0);
}

const archives = fs.readdirSync(cacheRoot).filter(f => f.endsWith('.7z'));
if (archives.length === 0) {
  console.log('[prebuild] no .7z archives to pre-extract');
  process.exit(0);
}

let pending = archives.length;
console.log(`[prebuild] pre-extracting ${archives.length} winCodeSign archive(s)`);

for (const archive of archives) {
  const dirName = archive.replace(/\.7z$/, '');
  const extractDir = path.join(cacheRoot, dirName);

  // Skip if a successful extraction is already present.
  if (fs.existsSync(path.join(extractDir, 'rcedit-x64.exe'))) {
    pending--;
    if (pending === 0) console.log('[prebuild] all archives already extracted');
    continue;
  }

  fs.mkdirSync(extractDir, { recursive: true });
  // Strip the -snl / -snld flags that the bundled app-builder.exe uses;
  // without them 7za exits 0 even when symlink extraction fails.
  const child = spawn(path7za, ['x', '-bd', '-y', archive, `-o${extractDir}`], {
    cwd: cacheRoot,
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('exit', (code) => {
    pending--;
    const ok = fs.existsSync(path.join(extractDir, 'rcedit-x64.exe'));
    console.log(`[prebuild] ${archive}: 7za exit ${code}, rcedit-x64.exe ${ok ? 'OK' : 'MISSING'}`);
    if (pending === 0) console.log('[prebuild] done');
  });
}
