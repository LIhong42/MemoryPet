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
    debugFireDueNow: () => M.events.debugFireDueNow(),
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