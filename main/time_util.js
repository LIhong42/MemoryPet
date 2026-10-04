// main/time_util.js — pure functions for next-fire computation

const DEFAULT_REMIND_TIME = '09:00';

function parseHhmm(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

function formatHhmm(t) {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

function fmtDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseDateTime(s) {
  if (!s) return null;
  // "YYYY-MM-DD HH:MM:SS"
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function lastDayOfMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

function nextYearlyAt(now, day, month, time) {
  let year = now.getFullYear();
  // Try up to 5 years forward
  for (let i = 0; i < 5; i++) {
    const ld = lastDayOfMonth(year, month);
    const actualDay = Math.min(day, ld);
    const cand = new Date(year, month - 1, actualDay, time.h, time.m, 0, 0);
    if (cand.getTime() > now.getTime() + 60_000) {
      return cand;
    }
    year += 1;
  }
  return null;
}

function nextMonthlyAt(now, time, dayHint) {
  const day = dayHint || now.getDate();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12
  for (let i = 0; i < 60; i++) {
    const ld = lastDayOfMonth(year, month);
    const actualDay = Math.min(day, ld);
    const cand = new Date(year, month - 1, actualDay, time.h, time.m, 0, 0);
    if (cand.getTime() > now.getTime() + 60_000) {
      return cand;
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return null;
}

function computeNextFireEvent(ev, now) {
  if (!ev.remind || !ev.active) return null;
  const kind = ev.remind_kind;
  const timeStr = ev.remind_time || DEFAULT_REMIND_TIME;
  const time = parseHhmm(timeStr);
  if (!time) return null;

  // If next_fire_at is already set and in the future, keep it
  if (ev.next_fire_at) {
    const nf = parseDateTime(ev.next_fire_at);
    if (nf && nf.getTime() > now.getTime() + 60_000) return nf;
  }

  let cand = null;
  if (kind === 'one_time') {
    if (!ev.remind_date) return null;
    const d = parseDate(ev.remind_date);
    if (!d) return null;
    cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.h, time.m, 0, 0);
    if (cand.getTime() <= now.getTime()) return null;
  } else if (kind === 'daily') {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.h, time.m, 0, 0);
    if (today.getTime() <= now.getTime() + 60_000) {
      cand = new Date(today.getTime() + 24 * 3600 * 1000);
    } else {
      cand = today;
    }
  } else if (kind === 'monthly') {
    const dayHint = ev.remind_date ? (parseDate(ev.remind_date) || {}).getDate?.() : undefined;
    cand = nextMonthlyAt(now, time, dayHint);
  } else if (kind === 'yearly') {
    let day = 1, month = now.getMonth() + 1;
    if (ev.remind_date) {
      const d = parseDate(ev.remind_date);
      if (d) { day = d.getDate(); month = d.getMonth() + 1; }
    }
    cand = nextYearlyAt(now, day, month, time);
  } else {
    return null;
  }
  return cand;
}

function computeNextFireImportantDate(d, now) {
  const timeStr = d.remind_time || DEFAULT_REMIND_TIME;
  const time = parseHhmm(timeStr);
  if (!time) return null;
  return nextYearlyAt(now, d.day, d.month, time);
}

module.exports = {
  DEFAULT_REMIND_TIME,
  parseHhmm,
  formatHhmm,
  fmtDateTime,
  parseDateTime,
  parseDate,
  computeNextFireEvent,
  computeNextFireImportantDate,
};