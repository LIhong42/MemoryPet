// pet/preload.js — pet window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    getPosition: () => ipcRenderer.invoke('pet:get_position'),
    // Legacy alias for getCurrent (kept so older renderer code keeps working).
    getSpecies: () => ipcRenderer.invoke('pet:get_current'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
    moveBy: (dx, dy) => ipcRenderer.invoke('pet:move_by', dx, dy),
    setPaused: (ms) => ipcRenderer.invoke('pet:set_paused', ms),
    openContextMenu: () => ipcRenderer.invoke('pet:context_menu'),
    triggerAction: (action, ms) => ipcRenderer.invoke('pet:trigger_action', action, ms),
    // New frame-based registry API.
    list: () => ipcRenderer.invoke('pet:list'),
    getCurrent: () => ipcRenderer.invoke('pet:get_current'),
    setCurrent: (id) => ipcRenderer.invoke('pet:set_current', id),
    resolveFrames: (petId, variant, direction) =>
      ipcRenderer.invoke('pet:resolve_frames', petId, variant, direction),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  on: (channel, cb) => {
    const allowed = [
      'pet:state-changed',
      'pet:species-changed',  // legacy
      'pet:action-changed',
      'pet:pet-changed',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
