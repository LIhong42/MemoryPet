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
    // Avatar upload/read/delete. `upload` payload shape mirrors the photo
    // uploaders: { filename, mime, bytes (ArrayBuffer|Uint8Array) }. `read`
    // returns { data_url, mime } or null when no avatar is set — embed the
    // data_url into <img src=…> directly (CSP-safe).
    uploadAvatar: (id, payload) => ipcRenderer.invoke('contacts:upload_avatar', id, payload),
    readAvatar:   (id)            => ipcRenderer.invoke('contacts:avatar_read', id),
    deleteAvatar: (id)            => ipcRenderer.invoke('contacts:avatar_delete', id),
  },
  // contact attributes (likes / taboos / gifts — global table)
  attributes: {
    list:   (kind, opts) => ipcRenderer.invoke('attributes:list', kind, opts || {}),
    create: (input) => ipcRenderer.invoke('attributes:create', input),
    update: (id, input) => ipcRenderer.invoke('attributes:update', id, input),
    delete: (id) => ipcRenderer.invoke('attributes:delete', id),
    deleteMany: (ids) => ipcRenderer.invoke('attributes:delete_many', ids),
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
    deleteMany: (ids) => ipcRenderer.invoke('events:delete_many', ids),
    debugFireDueNow: () => ipcRenderer.invoke('events:debug_fire_due_now'),
    listFestivals: () => ipcRenderer.invoke('events:list_festivals'),
  },
  // memorial events (independent from the reminder events table)
  memorialEvents: {
    list:   (opts)      => ipcRenderer.invoke('memorial_events:list', opts || {}),
    get:    (id)        => ipcRenderer.invoke('memorial_events:get', id),
    create: (input)     => ipcRenderer.invoke('memorial_events:create', input),
    update: (id, input) => ipcRenderer.invoke('memorial_events:update', id, input),
    delete: (id)        => ipcRenderer.invoke('memorial_events:delete', id),
    deleteMany: (ids)   => ipcRenderer.invoke('memorial_events:delete_many', ids),
    photos: {
      // payload shape for upload: { filename, mime, bytes (ArrayBuffer|Uint8Array) }
      list:   (eventId)         => ipcRenderer.invoke('memorial_events:photos_list', eventId),
      upload: (eventId, payload)=> ipcRenderer.invoke('memorial_events:photos_upload', eventId, payload),
      delete: (photoId)         => ipcRenderer.invoke('memorial_events:photos_delete', photoId),
      // Returns { data_url, mime } — embed directly in <img src=...> to
      // bypass the CSP `default-src 'self'` rule that prevents custom protocol
      // schemes from being loaded into <img>.
      read:   (photoId)         => ipcRenderer.invoke('memorial_events:photo_read', photoId),
    },
  },
  // reminders
  reminders: {
    listActive: () => ipcRenderer.invoke('reminders:list_active'),
    // Today's reminder view: every event scheduled for today (whether
    // or not the scheduler has fired it yet), with the soft-completion
    // state attached. Drives the "当前提醒" block on the 今日 page.
    listTodayView: () => ipcRenderer.invoke('reminders:list_today_view'),
    // Soft-dismiss for today. The pet stops nagging but the queue item
    // (and 今日 page entry) remain visible so the user can still scroll
    // back to confirm what they finished.
    completeForToday: (source, id) => ipcRenderer.invoke('reminders:complete_for_today', source, id),
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
    // Legacy species API kept as a thin wrapper around the new pet-id registry.
    getSpecies: () => ipcRenderer.invoke('pet:get_species'),
    setSpecies: (s) => ipcRenderer.invoke('pet:set_species', s),
    // New frame-based registry.
    list: () => ipcRenderer.invoke('pet:list'),
    getCurrent: () => ipcRenderer.invoke('pet:get_current'),
    setCurrent: (id) => ipcRenderer.invoke('pet:set_current', id),
    resolveFrames: (petId, variant, direction) =>
      ipcRenderer.invoke('pet:resolve_frames', petId, variant, direction),
    // Autonomous-walk controls.
    getWalkEnabled: () => ipcRenderer.invoke('pet:get_walk_enabled'),
    setWalkEnabled: (b) => ipcRenderer.invoke('pet:set_walk_enabled', b),
    // Pack import (desktop-pet style adapter) — see main/pet_pack_import.js.
    listInstalled:   ()        => ipcRenderer.invoke('pet:list_installed'),
    importFromFolder:()        => ipcRenderer.invoke('pet:import_from_folder'),
    importFromZip:   ()        => ipcRenderer.invoke('pet:import_from_zip'),
    removeImported:  (petId)   => ipcRenderer.invoke('pet:remove_imported', petId),
  },
  settings: {
    get: (k) => ipcRenderer.invoke('settings:get', k),
    set: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  },
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  // Backup / restore. Two-step import (pick → apply) so the renderer can
  // surface a confirm() dialog between picking the zip and overwriting the
  // local DB.
  backup: {
    export: () => ipcRenderer.invoke('backup:export'),
    import: () => ipcRenderer.invoke('backup:import'),
    apply:  (zipPath) => ipcRenderer.invoke('backup:apply', zipPath),
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