// scripts/run-electron.js — launches electron with hostile env vars cleared.
// Usage: node scripts/run-electron.js <args...>  (e.g. `.` or `. --dev`)
const { spawn } = require('child_process');
const path = require('path');

// Strip variables that break Electron's main-process bootstrap.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_NO_ATTACH_CONSOLE;

const electronBin = require('electron'); // path string to electron.exe
const args = process.argv.slice(2);

const child = spawn(electronBin, args, {
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
