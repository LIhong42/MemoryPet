// main/scheduler.js — periodic scan, fires due reminders, drives pet state
const db = require('./db');
const { computeNextFireEvent, computeNextFireImportantDate, parseDateTime } = require('./time_util');

const TICK_MS = 20_000;

class ReminderQueue {
  constructor() {
    this.items = [];
    this.listeners = new Set();
  }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() {
    const payload = { count: this.items.length };
    for (const cb of this.listeners) cb(payload);
  }
  pushIfNew(r) {
    const exists = this.items.some((x) => x.source === r.source && x.source_id === r.source_id);
    if (exists) return false;
    this.items.push(r);
    this.emit();
    return true;
  }
  list() { return [...this.items]; }
  head() { return this.items[0] || null; }
  len() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
  remove(source, sourceId) {
    const i = this.items.findIndex((r) => r.source === source && r.source_id === sourceId);
    if (i === -1) return null;
    const [removed] = this.items.splice(i, 1);
    this.emit();
    return removed;
  }
  clear() { this.items = []; this.emit(); }
}

let timer = null;

function start({ queue, getPetState, setPetState, setActiveReminder }) {
  function tick() {
    try {
      scanAndFire({ queue, getPetState, setPetState, setActiveReminder });
    } catch (e) {
      console.error('scheduler error:', e);
    }
  }
  setTimeout(tick, 1_500);
  timer = setInterval(tick, TICK_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function scanAndFire({ queue, getPetState, setPetState, setActiveReminder }) {
  if (!db.get()) return;
  const now = new Date();
  const now_str = db.nowStr();
  const fired = [];

  // --- Events with due next_fire_at ---
  const due_events = db.all(
    `SELECT * FROM events
     WHERE active = 1 AND remind = 1 AND next_fire_at IS NOT NULL
     ORDER BY next_fire_at ASC`
  );

  for (const ev of due_events) {
    const nf = parseDateTime(ev.next_fire_at);
    if (!nf) continue;
    if (nf.getTime() > now.getTime() + 30_000) continue;

    const ack = db.one(
      `SELECT next_fire_at FROM reminder_acks
       WHERE source='event' AND source_id=?
       ORDER BY id DESC LIMIT 1`,
      [ev.id]
    );
    if (ack && ack.next_fire_at) {
      const nfAck = parseDateTime(ack.next_fire_at);
      if (nfAck && nfAck.getTime() > now.getTime()) {
        db.run('UPDATE events SET next_fire_at = ? WHERE id = ?', [ack.next_fire_at, ev.id]);
        continue;
      }
    }

    let contactName = null;
    if (ev.contact_id) {
      const c = db.one(
        `SELECT COALESCE(NULLIF(first_name || ' ' || last_name, ''), nickname) AS name
         FROM contacts WHERE id = ?`,
        [ev.contact_id]
      );
      if (c) contactName = c.name;
    }

    fired.push({
      source: 'event',
      source_id: ev.id,
      title: ev.title,
      description: ev.description || null,
      contact_id: ev.contact_id,
      contact_name: contactName,
      next_fire_at: ev.next_fire_at,
      kind: 'event',
      remind_kind: ev.remind_kind,
    });

    const next = computeNextFireEvent(ev, now);
    if (ev.remind_kind === 'one_time') {
      db.run('UPDATE events SET active = 0, last_fired_at = ?, next_fire_at = NULL WHERE id = ?',
        [db.nowStr(), ev.id]);
    } else {
      db.run('UPDATE events SET last_fired_at = ?, next_fire_at = ? WHERE id = ?',
        [db.nowStr(), next ? require('./time_util').fmtDateTime(next) : null, ev.id]);
    }
  }

  // --- Important dates matching today's month/day ---
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const id_rows = db.all('SELECT * FROM important_dates WHERE month = ? AND day = ?',
    [todayMonth, todayDay]);

  for (const d of id_rows) {
    const ack = db.one(
      `SELECT next_fire_at FROM reminder_acks
       WHERE source='important_date' AND source_id=?
       ORDER BY id DESC LIMIT 1`,
      [d.id]
    );
    if (ack && ack.next_fire_at) {
      const nfAck = parseDateTime(ack.next_fire_at);
      if (nfAck && nfAck.getTime() > now.getTime()) continue;
    }

    let contactName = null;
    const c = db.one(
      `SELECT COALESCE(NULLIF(first_name || ' ' || last_name, ''), nickname) AS name
       FROM contacts WHERE id = ?`,
      [d.contact_id]
    );
    if (c) contactName = c.name;

    let titleStr = d.label;
    if (d.year) {
      const age = now.getFullYear() - d.year;
      if (age > 0) titleStr = `${d.label} · ${age}岁`;
    }

    fired.push({
      source: 'important_date',
      source_id: d.id,
      title: titleStr,
      description: null,
      contact_id: d.contact_id,
      contact_name: contactName,
      next_fire_at: now_str,
      kind: d.kind,
      remind_kind: null,
    });
  }

  for (const r of fired) queue.pushIfNew(r);

  const len = queue.len();
  if (len > 0 && !getPetState()) {
    setPetState(true);
    setActiveReminder(queue.head());
  } else if (len > 0) {
    setActiveReminder(queue.head());
  } else if (getPetState()) {
    setPetState(false);
    setActiveReminder(null);
  }
}

module.exports = { start, stop, ReminderQueue };