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
    // Total count and active count diverge once a user clicks "完成" — the
    // dismissed item stays in the queue so the 今日 page can still show it,
    // but it should not contribute to the pet nag count.
    const payload = { count: this.items.length, active_count: this.activeCount() };
    for (const cb of this.listeners) cb(payload);
  }
  pushIfNew(r) {
    const exists = this.items.some((x) => x.source === r.source && x.source_id === r.source_id);
    if (exists) return false;
    // Normalize: every queue item carries a dismissed_for_today flag so
    // callers can distinguish "已停止催但仍记录" from "尚未处理".
    if (typeof r.dismissed_for_today !== 'boolean') r.dismissed_for_today = false;
    this.items.push(r);
    this.emit();
    return true;
  }
  list() { return [...this.items]; }
  head() { return this.items[0] || null; }
  len() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
  // ---- Active (not-dismissed) helpers ----
  // Pet state and "current nag head" only consider non-dismissed items. The
  // 今日 page reads `list()` directly so it can render both states.
  activeItems() { return this.items.filter((r) => !r.dismissed_for_today); }
  activeCount() { return this.activeItems().length; }
  activeHead() { return this.activeItems()[0] || null; }
  isActiveEmpty() { return this.activeItems().length === 0; }
  // Mark a queue item as "completed for today" without removing it. Returns
  // the item that was updated, or null if no matching item was in the queue.
  // Idempotent: a second call on an already-dismissed item is a no-op (no
  // emit), so duplicate renderer clicks don't churn the UI.
  dismissForToday(source, sourceId) {
    const item = this.items.find((r) => r.source === source && r.source_id === sourceId);
    if (!item) return null;
    if (item.dismissed_for_today) return item;
    item.dismissed_for_today = true;
    this.emit();
    return item;
  }
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

function start({ queue, getPetState, setPetState, setActiveReminder, petController }) {
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
      const c = db.one('SELECT name FROM contacts WHERE id = ?', [ev.contact_id]);
      if (c && c.name) contactName = c.name;
    }

    fired.push({
      source: 'event',
      source_id: ev.id,
      title: ev.title,
      description: ev.description || null,
      contact_id: ev.contact_id,
      contact_name: contactName,
      next_fire_at: ev.next_fire_at,
      // Category is carried through to the renderer so the 今日 page can
      // link back to /events/:id?category=<this> and open the matching edit
      // form (general / work / memorial) instead of guessing.
      category: ev.category,
      kind: 'event',
      remind_kind: ev.remind_kind,
      dismissed_for_today: false,
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
    const c = db.one('SELECT name FROM contacts WHERE id = ?', [d.contact_id]);
    if (c && c.name) contactName = c.name;

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
      category: null,
      dismissed_for_today: false,
    });
  }

  for (const r of fired) {
    if (queue.pushIfNew(r)) {
      // Re-hydrate the dismissed-for-today state from reminder_acks so that
      // a soft "完成" survives an Electron quit-then-restart. We only look
      // at acks stamped today — older acks (one_time events that already
      // fired once, periodic ones that fired yesterday) shouldn't suppress
      // today's nag, since the user would have seen those reminders
      // complete in past sessions and the new day should re-prompt.
      const todayPrefix = now_str.slice(0, 10); // YYYY-MM-DD
      const ackToday = db.one(
        `SELECT acked_at FROM reminder_acks
          WHERE source=? AND source_id=? AND acked_at LIKE ?
          ORDER BY id DESC LIMIT 1`,
        [r.source, r.source_id, `${todayPrefix}%`]
      );
      if (ackToday) {
        queue.dismissForToday(r.source, r.source_id);
      }
    }
  }

  // Use the active (non-dismissed) subset to drive pet state — dismissed
  // items must NOT keep the pet in REMINDER mode, even though they remain
  // visible on the 今日 page so the user can review what they finished.
  const activeLen = queue.activeCount();
  if (activeLen > 0 && !getPetState()) {
    setPetState(true);
    setActiveReminder(queue.activeHead());
    if (petController && petController.setReminding) petController.setReminding(true);
  } else if (activeLen > 0) {
    setActiveReminder(queue.activeHead());
    if (petController && petController.setReminding) petController.setReminding(true);
  } else if (getPetState()) {
    setPetState(false);
    setActiveReminder(null);
    if (petController && petController.setReminding) petController.setReminding(false);
  }
}

module.exports = { start, stop, ReminderQueue };