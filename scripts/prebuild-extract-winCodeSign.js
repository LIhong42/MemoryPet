// scripts/prebuild-extract-winCodeSign.js
// Pre-extracts all winCodeSign 7z archives without the -snl flag,
// avoiding the "Cannot create symbolic link" failures on Windows
// where SeCreateSymbolicLinkPrivilege is not granted to the user.
// Runs at the start of `npm run build` to seed the cache before
// app-builder.exe re-extracts (and re-fails) on its own.
//
// For each .7z that lacks a complete extract directory, we first
// rebuild it without the darwin/ subtree (only Mac code-signing
// shims, which Windows packaging does not need) and then extract
// that stripped archive. The darwin symlinks are the only files
// in winCodeSign that need SeCreateSymbolicLinkPrivilege on Windows,
// so dropping them up front is enough to make extraction succeed.

const { spawn, spawnSync } = require('child_process');
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

function run7za(args, cwd) {
  const res = spawnSync(path7za, args, { cwd, stdio: 'inherit', windowsHide: true });
  return res.status;
}

for (const archive of archives) {
  const dirName = archive.replace(/\.7z$/, '');
  const extractDir = path.join(cacheRoot, dirName);
  const archivePath = path.join(cacheRoot, archive);
  const strippedArchivePath = path.join(cacheRoot, `${dirName}-no-darwin.7z`);

  // Skip if a successful extraction is already present.
  if (fs.existsSync(path.join(extractDir, 'rcedit-x64.exe'))) {
    pending--;
    if (pending === 0) console.log('[prebuild] all archives already extracted');
    continue;
  }

  fs.mkdirSync(extractDir, { recursive: true });

  // Rebuild the archive without darwin/ (Mac-only shims with symlinks
  // that 7za cannot materialize on a non-privileged Windows account).
  // `-snld` on the source side lets 7za skip over symlink entries it
  // cannot resolve, so the rebuild itself does not error.
  const stripCode = run7za(
    ['a', '-snld', '-bd', '-y', strippedArchivePath, archive, '-xr!darwin'],
    cacheRoot
  );
  if (stripCode !== 0) {
    console.log(`[prebuild] ${archive}: strip darwin failed (7za exit ${stripCode})`);
    pending--;
    if (pending === 0) console.log('[prebuild] done');
    continue;
  }

  // Extract the stripped archive without -snl: there are no symlinks
  // left, so extraction cannot fail with "Cannot create symbolic link".
  const code = run7za(
    ['x', '-bd', '-y', strippedArchivePath, `-o${extractDir}`],
    cacheRoot
  );

  // Drop the throwaway archive; the original .7z must stay so
  // app-builder.exe sees a cache hit and skips its own re-download.
  try { fs.unlinkSync(strippedArchivePath); } catch (_) {}

  pending--;
  const ok = fs.existsSync(path.join(extractDir, 'rcedit-x64.exe'));
  console.log(`[prebuild] ${archive}: 7za exit ${code}, rcedit-x64.exe ${ok ? 'OK' : 'MISSING'}`);
  if (pending === 0) console.log('[prebuild] done');
}
