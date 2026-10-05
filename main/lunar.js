// main/lunar.js — lunar↔solar helpers backed by lunar-javascript.
// Lazy-loaded so the library is only required when a feature actually uses it.
//
// lunar-javascript's API quirk: it uses `Lunar.fromYmd(year, month, day)` to
// build a lunar date, where `year` is the *solar* year the lunar date falls
// in (NOT the Chinese lunar year — those usually coincide but a lunar date
// in early January can belong to the prior lunar year). The returned
// instance's `.getSolar()` gives the actual solar Date.

let _lib = null;
function lib() {
  if (!_lib) {
    _lib = require('lunar-javascript');
  }
  return _lib;
}

// Find the next solar Date on or after `fromDate` whose lunar (month, day)
// matches. We iterate solar years and ask "given lunar (year, month, day),
// what's the solar date?" — picking the first result that lands strictly
// after `fromDate` (with a 60-second margin to match the existing
// nextYearlyAt convention).
//
// Non-leap semantics: we never pass `isLeapMonth=true` to Lunar.fromYmd.
// Lunar birthdays in a leap month conventionally roll to the non-leap
// month, and most users will not need the leap-month distinction.
//
// Returns null if no occurrence is found within ~5 years (should never
// happen for valid (1-12, 1-30) inputs).
function nextSolarDateForLunar(lunarMonth, lunarDay, fromDate) {
  if (!lunarMonth || !lunarDay) return null;
  const { Lunar } = lib();
  const startYear = fromDate.getFullYear();
  for (let i = 0; i < 6; i++) {
    const year = startYear + i;
    let solar;
    try {
      const lun = Lunar.fromYmd(year, lunarMonth, lunarDay);
      solar = lun.getSolar();
    } catch (e) {
      // (month, day) doesn't exist in this year — try next year.
      continue;
    }
    const cand = new Date(
      solar.getYear(),
      solar.getMonth() - 1,
      solar.getDay(),
      0, 0, 0, 0
    );
    if (cand.getTime() > fromDate.getTime() + 60_000) return cand;
  }
  return null;
}

// Validate a (lunarMonth, lunarDay) pair across multiple years. A pair is
// considered valid if it exists in at least one year within a small probe
// window. This catches obviously-bad inputs (month 0/13, day 0/31) without
// over-rejecting pairs that only fail in specific years.
function validateLunar(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(m) || m < 1 || m > 12) {
    return { ok: false, reason: '农历月份必须在 1–12 之间' };
  }
  if (!Number.isFinite(d) || d < 1 || d > 30) {
    return { ok: false, reason: '农历日期必须在 1–30 之间' };
  }
  const { Lunar } = lib();
  for (const year of [2000, 2001, 2020, 2024, 2025]) {
    try {
      const lun = Lunar.fromYmd(year, m, d);
      // Touch getSolar() to confirm the conversion succeeded (some library
      // versions return a stub object instead of throwing on bad inputs).
      lun.getSolar().getYear();
      return { ok: true };
    } catch (e) {
      // try next probe year
    }
  }
  return { ok: false, reason: '该农历日期不存在' };
}

// Compute the solar YYYY-MM-DD for a given lunar (year, month, day).
// `year` is the *solar* year the lunar date falls in (see file header).
// Returns null on failure (out of range, day doesn't exist, etc.).
function lunarToSolarYmd(lunarYear, lunarMonth, lunarDay) {
  const { Lunar } = lib();
  try {
    const lun = Lunar.fromYmd(lunarYear, lunarMonth, lunarDay);
    const solar = lun.getSolar();
    const pad = (n) => String(n).padStart(2, '0');
    return `${solar.getYear()}-${pad(solar.getMonth())}-${pad(solar.getDay())}`;
  } catch (e) {
    return null;
  }
}

module.exports = {
  nextSolarDateForLunar,
  validateLunar,
  lunarToSolarYmd,
};
