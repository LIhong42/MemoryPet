// pet/preload.js — pet window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    getPosition: () => ipcRenderer.invoke('pet:get_position'),
    getSpecies: () => ipcRenderer.invoke('pet:get_species'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
    moveBy: (dx, dy) => ipcRenderer.invoke('pet:move_by', dx, dy),
    setPaused: (ms) => ipcRenderer.invoke('pet:set_paused', ms),
    openContextMenu: () => ipcRenderer.invoke('pet:context_menu'),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  on: (channel, cb) => {
    const allowed = ['pet:state-changed', 'pet:species-changed', 'pet:action-changed'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});