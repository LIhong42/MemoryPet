// main/preload.js — main window preload, exposes safe IPC API to window
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp', {
  // contacts
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    get: (id) => ipcRenderer.invoke('contacts:get', id),
    create: (input) => ipcRenderer.invoke('contacts:create', input),
    update: (id, input) => ipcRenderer.invoke('contacts:update', id, input),
    delete: (id) => ipcRenderer.invoke('contacts:delete', id),
  },
  // contact attributes (likes / taboos / gifts — global table)
  attributes: {
    list:   (kind, opts) => ipcRenderer.invoke('attributes:list', kind, opts || {}),
    create: (input) => ipcRenderer.invoke('attributes:create', input),
    update: (id, input) => ipcRenderer.invoke('attributes:update', id, input),
    delete: (id) => ipcRenderer.invoke('attributes:delete', id),
  },
  // important dates
  importantDates: {
    list: (contactId) => ipcRenderer.invoke('important_dates:list', contactId),
    create: (contactId, input) => ipcRenderer.invoke('important_dates:create', contactId, input),
    update: (id, input) => ipcRenderer.invoke('important_dates:update', id, input),
    delete: (id) => ipcRenderer.invoke('important_dates:delete', id),
  },
  // events
  events: {
    list: (opts) => ipcRenderer.invoke('events:list', opts || {}),
    listToday: () => ipcRenderer.invoke('events:list_today'),
    get: (id) => ipcRenderer.invoke('events:get', id),
    create: (input) => ipcRenderer.invoke('events:create', input),
    update: (id, input) => ipcRenderer.invoke('events:update', id, input),
    delete: (id) => ipcRenderer.invoke('events:delete', id),
    debugFireDueNow: () => ipcRenderer.invoke('events:debug_fire_due_now'),
  },
  // reminders
  reminders: {
    listActive: () => ipcRenderer.invoke('reminders:list_active'),
    markDone: (source, id) => ipcRenderer.invoke('reminders:mark_done', source, id),
    snooze: (source, id, minutes) => ipcRenderer.invoke('reminders:snooze', source, id, minutes),
  },
  // search
  search: {
    query: (q) => ipcRenderer.invoke('search:query', q),
  },
  // pet / settings / windowing
  pet: {
    getState: () => ipcRenderer.invoke('pet:get_state'),
    setPosition: (x, y) => ipcRenderer.invoke('pet:set_position', x, y),
    getPosition: () => ipcRenderer.invoke('pet:get_position'),
    showMain: () => ipcRenderer.invoke('window:show_main'),
    openReminder: () => ipcRenderer.invoke('window:open_reminder'),
  },
  settings: {
    get: (k) => ipcRenderer.invoke('settings:get', k),
    set: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  // Events from main → renderer
  on: (channel, cb) => {
    const allowed = ['pet:state-changed', 'main:open-reminder', 'main:navigate'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});