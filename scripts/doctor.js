#!/usr/bin/env node
// scripts/doctor.js — `npm run doctor`.
// Walks every prerequisite the renderer + main process needs and prints
// either ✓ OK or ✗ FAIL with a copy-pasteable fix. Designed so that a
// user pasting the output back to a teammate can be told "step N is red".
//
// It does NOT mutate the filesystem except when `--fix` is passed. Default
// mode is read-only so it's safe to run anywhere.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');
const RED = (s) => '\x1b[31m' + s + '\x1b[0m';
const GRN = (s) => '\x1b[32m' + s + '\x1b[0m';
const YLW = (s) => '\x1b[33m' + s + '\x1b[0m';
const DIM = (s) => '\x1b[2m' + s + '\x1b[0m';
const FIX = process.argv.includes('--fix');

let failed = 0;

function check(label, ok, fix) {
  if (ok) console.log(`${GRN('✓')} ${label}`);
  else {
    console.log(`${RED('✗')} ${label}`);
    failed++;
    if (fix) {
      fix.split('\n').forEach((l) => console.log(`    ${YLW('→')} ${l.trim()}`));
    }
  }
}
function info(s) { console.log(DIM('  ' + s)); }

// --------------------------------------------------------------------------
// 1) Node version
// --------------------------------------------------------------------------
const major = parseInt(process.versions.node.split('.')[0], 10);
check(
  `Node.js ${process.versions.node} (>= 18)`,
  major >= 18 && major < 25,
  'Install Node.js 18 / 20 / 22 LTS from https://nodejs.org/. Avoid odd-numbered versions (19, 21).'
);

// --------------------------------------------------------------------------
// 2) Platform
// --------------------------------------------------------------------------
const supported = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
check(
  `Platform ${process.platform}/${process.arch} is supported`,
  supported,
  'This project only ships installers for Windows x64. macOS/Linux run from source only.'
);

// --------------------------------------------------------------------------
// 3) node_modules present and consistent
// --------------------------------------------------------------------------
check(
  'node_modules/ exists (run `npm install` if not)',
  fs.existsSync(NM),
  'npm install'
);

// --------------------------------------------------------------------------
// 4) Electron binary — the chronic failure
// --------------------------------------------------------------------------
const electronDist = path.join(NM, 'electron', 'dist');
const electronPathTxt = path.join(NM, 'electron', 'path.txt');
const electronBinExpected = process.platform === 'win32' ? 'electron.exe'
                          : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
                          : 'electron';
const electronBinFull = path.join(electronDist, electronBinExpected);

let electronOk = fs.existsSync(electronDist) && fs.existsSync(electronPathTxt) && fs.existsSync(electronBinFull);

if (!electronOk) {
  // Count missing pieces for a useful message.
  const missing = [];
  if (!fs.existsSync(electronDist)) missing.push('node_modules/electron/dist/');
  if (!fs.existsSync(electronPathTxt)) missing.push('node_modules/electron/path.txt');
  if (fs.existsSync(electronDist) && !fs.existsSync(electronBinFull)) missing.push(electronBinExpected);

  let fix;
  if (missing.length > 0) {
    fix = `Missing: ${missing.join(', ')}\n`
        + `npm rebuild electron\n`
        + `If you're on a slow link, retry via the mirror:\n`
        + `  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (Windows cmd)\n`
        + `  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/  (bash)\n`
        + `  npm rebuild electron`;
    // Try to auto-fix when --fix.
    if (FIX) {
      console.log(`${YLW('[fix]')} rebuilding electron …`);
      try {
        execSync('npm rebuild electron', { cwd: ROOT, stdio: 'inherit' });
        electronOk = fs.existsSync(electronDist) && fs.existsSync(electronPathTxt) && fs.existsSync(electronBinFull);
      } catch (e) { /* leave electronOk false */ }
    }
  }
  check(`Electron binary present (${electronBinExpected})`, electronOk, fix);
} else {
  // Read the path.txt so the user can see what's there.
  try {
    const rel = fs.readFileSync(electronPathTxt, 'utf-8').trim();
    const sz = fs.statSync(electronBinFull).size;
    info(`path.txt → ${rel}  (${(sz/1024/1024).toFixed(1)} MB)`);
  } catch {}
  check(`Electron binary present (${electronBinExpected})`, true);
}

// --------------------------------------------------------------------------
// 5) Other heavy deps
// --------------------------------------------------------------------------
const deps = [
  ['ffmpeg-static', 'ffmpeg.exe'],
  ['sql.js', null],
  ['pdfkit', null],
  ['adm-zip', null],
  ['lunar-javascript', null],
  ['electron-builder', null],
  ['jsdom', null],
];
for (const [pkg, extra] of deps) {
  const dir = path.join(NM, pkg);
  let ok = fs.existsSync(dir) && fs.existsSync(path.join(dir, 'package.json'));
  if (ok && extra) {
    const sub = path.join(dir, 'lib', extra);
    const flat = path.join(dir, extra);
    ok = fs.existsSync(sub) || fs.existsSync(flat);
  }
  check(`Package ${pkg} installed`, ok, `npm install ${pkg}`);
}

// --------------------------------------------------------------------------
// 6) call-bind-apply-helpers hoisted
// --------------------------------------------------------------------------
const hoistMarker = path.join(NM, 'call-bind', 'node_modules', 'call-bind-apply-helpers');
check('call-bind-apply-helpers hoisted (postinstall ran)', fs.existsSync(hoistMarker),
  'npm rebuild soul-desktop-pet  (re-triggers postinstall)');

// --------------------------------------------------------------------------
// 7) Disk space + path length
// --------------------------------------------------------------------------
try {
  // npm install pulls ~400MB; make sure the partition has room.
  const cwd = process.cwd();
  let stat;
  if (process.platform === 'win32') {
    // fsutil output ends with values for "Free bytes", "Total bytes", "Total
    // allocation bytes" — but the line layout differs between Windows 10
    // and Windows 11. Parse defensively: pick the first number >= 1 GB and
    // treat it as the free-bytes hint. If parsing fails, skip the check
    // silently — disk space is non-fatal.
    try {
      const out = execSync(`fsutil volume diskfree "${cwd.replace(/\\/g, '\\\\')}"`).toString();
      const nums = out.match(/\d[\d ,]*/g) || [];
      const bytes = parseInt(nums[0].replace(/[, ]/g, ''), 10);
      if (Number.isFinite(bytes) && bytes > 0) {
        const freeMB = bytes / 1024 / 1024;
        check(`Free disk >= 1 GB (now ${freeMB.toFixed(0)} MB)`, freeMB >= 1024,
          'Free at least 1 GB on the drive where the project lives.');
      }
    } catch { /* not on a real Windows shell or fsutil missing */ }
  }
} catch { /* non-fatal */ }

// Windows MAX_PATH (260) check — long project paths + `node_modules\electron\dist\resources\app.asar`
// blow up during extraction.
const projectPath = ROOT;
if (process.platform === 'win32' && projectPath.length > 60) {
  info(`Project path is ${projectPath.length} chars (Windows MAX_PATH is 260). Should be safe.`);
}
if (process.platform === 'win32' && projectPath.length > 200) {
  check(`Project path under MAX_PATH`, false,
    `Project path is ${projectPath.length} chars; Windows may refuse to create files. ` +
    `Move the project closer to the drive root, e.g. C:\\proj\\soul-desktop-pet.`);
}

// --------------------------------------------------------------------------
// 8) Env hints
// --------------------------------------------------------------------------
if (!process.env.ELECTRON_MIRROR) {
  info('No ELECTRON_MIRROR set. If GitHub is slow in your region:');
  info('  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/');
}

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(GRN('All checks passed. You can now run:'));
  console.log('  npm start     # launch the pet');
  console.log('  npm run dev   # launch with DevTools');
} else {
  console.log(RED(`${failed} check(s) failed.`));
  console.log(YLW('Re-run with --fix to auto-repair the Electron binary:'));
  console.log('  npm run doctor -- --fix');
  process.exit(1);
}
