// src/js/api.js — thin wrappers around window.mp (preload bridge)
const M = window.mp;
if (!M) {
  document.body.innerHTML = '<div style="padding:20px;color:#900">Preload bridge missing. Run via Electron, not a browser.</div>';
  throw new Error('Preload bridge missing');
}

export const api = {
  contacts: {
    list: () => M.contacts.list(),
    get: (id) => M.contacts.get(id),
    create: (input) => M.contacts.create(input),
    update: (id, input) => M.contacts.update(id, input),
    delete: (id) => M.contacts.delete(id),
  },
  attributes: {
    list:   (kind, opts) => M.attributes.list(kind, opts || {}),
    create: (input) => M.attributes.create(input),
    update: (id, input) => M.attributes.update(id, input),
    delete: (id) => M.attributes.delete(id),
    deleteMany: (ids) => M.attributes.deleteMany(ids),
  },
  importantDates: {
    list: (contactId) => M.importantDates.list(contactId),
    create: (contactId, input) => M.importantDates.create(contactId, input),
    update: (id, input) => M.importantDates.update(id, input),
    delete: (id) => M.importantDates.delete(id),
  },
  events: {
    list: (opts) => M.events.list(opts || {}),
    listToday: () => M.events.listToday(),
    get: (id) => M.events.get(id),
    create: (input) => M.events.create(input),
    update: (id, input) => M.events.update(id, input),
    delete: (id) => M.events.delete(id),
    deleteMany: (ids) => M.events.deleteMany(ids),
    debugFireDueNow: () => M.events.debugFireDueNow(),
    listFestivals: () => M.events.listFestivals(),
  },
  memorialEvents: {
    list:   (opts)      => M.memorialEvents.list(opts || {}),
    get:    (id)        => M.memorialEvents.get(id),
    create: (input)     => M.memorialEvents.create(input),
    update: (id, input) => M.memorialEvents.update(id, input),
    delete: (id)        => M.memorialEvents.delete(id),
    deleteMany: (ids)   => M.memorialEvents.deleteMany(ids),
    photos: {
      list:   (eventId)         => M.memorialEvents.photos.list(eventId),
      upload: (eventId, payload)=> M.memorialEvents.photos.upload(eventId, payload),
      delete: (photoId)         => M.memorialEvents.photos.delete(photoId),
      read:   (photoId)         => M.memorialEvents.photos.read(photoId),
    },
  },
  reminders: {
    listActive: () => M.reminders.listActive(),
    markDone: (source, id) => M.reminders.markDone(source, id),
    snooze: (source, id, minutes) => M.reminders.snooze(source, id, minutes),
  },
  search: {
    query: (q) => M.search.query(q),
  },
  pet: {
    getState: () => M.pet.getState(),
    setPosition: (x, y) => M.pet.setPosition(x, y),
    getPosition: () => M.pet.getPosition(),
    showMain: () => M.pet.showMain(),
    openReminder: () => M.pet.openReminder?.() || M.pet.showMain(),
  },
  settings: {
    get: (k) => M.settings.get(k),
    set: (k, v) => M.settings.set(k, v),
  },
  app: {
    quit: () => M.app.quit(),
  },
  on: (channel, cb) => M.on(channel, cb),
};

export function toast(msg, ms = 1800) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 200ms';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export function fmtDate(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Local-time YYYY-MM-DD for today. Used by contact-edit pages as the default
// "event" value when the user adds a list row without picking a date — saves
// stay useful even when the user is in a hurry and skips the date field.
export function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function firstChar(s) {
  if (!s) return '?';
  return s.trim().charAt(0).toUpperCase();
}

// Single source of truth for "how do we show this contact's name"? Used by
// every page that renders a contact (list, detail, home, today, events,
// search, event_edit). Falls back to "(无名)" for contacts with an empty
// `name` field.
export function displayName(c) {
  return (c && typeof c.name === 'string' && c.name.trim()) || '(无名)';
}

// Photo display. Earlier versions exposed a custom `memorial-photo://`
// scheme handled by main.js, but `default-src 'self'` in index.html CSP
// blocks <img src=…> from loading any non-self protocol — the browser shows
// a broken-image icon even though the protocol handler returns 200. The fix
// is to embed photos as data URLs (base64). They bypass the CSP entirely
// and the browser caches the decoded bitmap on subsequent renders.
//
// `photoDataUrlCache` is a module-level Map<photoId, dataUrl>. The first
// lookup of a given photo IPCs to main and stores the result; subsequent
// lookups are synchronous. Callers can pass through `memorialPhotoUrl()` —
// when given a relative_path it returns the data URL synchronously when
// already cached, otherwise it returns '' and kicks off a background fetch
// that resolves into the cache. The list-page <img> tags render with the
// blank alt attribute until the second tick when the cache populates; the
// lightbox pre-warms entries on open.
const photoDataUrlCache = new Map();
const photoFetchInflight = new Map();

export function getCachedPhotoDataUrl(photoId) {
  return photoDataUrlCache.get(photoId) || '';
}

// Resolve a photoId to a data URL, calling the IPC once and caching. Returns
// a Promise<string>. Callers usually don't await this — they fire-and-forget
// to warm the cache for the next render.
export async function fetchPhotoDataUrl(photoId) {
  if (!photoId) return '';
  if (photoDataUrlCache.has(photoId)) return photoDataUrlCache.get(photoId);
  if (photoFetchInflight.has(photoId)) return photoFetchInflight.get(photoId);
  const p = (async () => {
    try {
      const r = await api.memorialEvents.photos.read(photoId);
      const url = (r && r.data_url) || '';
      if (url) photoDataUrlCache.set(photoId, url);
      return url;
    } catch (e) {
      console.error('fetchPhotoDataUrl failed for', photoId, e);
      return '';
    } finally {
      photoFetchInflight.delete(photoId);
    }
  })();
  photoFetchInflight.set(photoId, p);
  return p;
}

// Drop the cached entry for a photo — call after a delete so the renderer
// doesn't keep showing the now-stale bytes.
export function invalidatePhotoDataUrl(photoId) {
  if (!photoId) return;
  photoDataUrlCache.delete(photoId);
  photoFetchInflight.delete(photoId);
}

// Legacy shape compatibility — the row helper `listMemorialEvents` /
// `getMemorialEvent` returns each photo as `{ id, relative_path, ... }`.
// Earlier renderer code passed `relative_path` into `memorialPhotoUrl()`
// and used the result in an <img src=…>. We keep the same function name so
// callers don't need to be rewritten, but the argument is now a photo id
// (we map it through the cache). Any non-id input returns '' and is ignored.
export function memorialPhotoUrl(photoIdOrPath) {
  if (!photoIdOrPath) return '';
  if (photoDataUrlCache.has(photoIdOrPath)) return photoDataUrlCache.get(photoIdOrPath);
  // Trigger a background fetch — the <img> tag will repaint on the next
  // tick once the cache resolves. Callers that need a guaranteed-ready URL
  // should call fetchPhotoDataUrl() and `await` it.
  fetchPhotoDataUrl(photoIdOrPath);
  return '';
}