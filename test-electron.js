// test-electron.js — quick test
const electron = require('electron');
console.log('typeof electron:', typeof electron);
console.log('keys:', Object.keys(electron));
console.log('app:', typeof electron.app);
process.exit(0);