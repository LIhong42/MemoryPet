// main/cozy_engine.js — Tier 3 of the pet intimacy system.
//
// "Cozy" = 0..100 number that decays over time of inactivity and refills
// when the user plays with the pet (single-click pet, double-click pat,
// right-click feed/play/sleep/cuddle). Cozy does NOT convert into Bond;
// it only nudges PetMood.
//
// Storage lives entirely in the `cozy_state` and `play_log` tables, no
// in-memory state, so restarts don't lose ground.

const COZY_DELTAS = {
  pet:    { delta:  4, cooldownMs:   8_000 },
  pat:    { delta:  8, cooldownMs:  10_000, requiresTier: 5 },
  feed:   { delta: 12, cooldownMs:  30_000 },
  play:   { delta:  6, cooldownMs:  60_000 },
  sleep:  { delta:  3, cooldownMs:  60_000 },
  cuddle: { delta: 15, cooldownMs: 300_000, requiresTier: 6 },
};

// Hour-based decay buckets. Tracks give `--decay per second`; the
// `applyDecayTick` decides which bucket applies based on
// `now - last_decay_at`.
function decayPerSec(lonelyHours) {
  if (lonelyHours >= 72) return 0;     // clamped at 20, no further decay
  if (lonelyHours >= 24) return -2.0 / 3600;
  if (lonelyHours >= 6)  return -1.0 / 3600;
  return -0.3 / 3600;
}

const DECAY_LOW_FLOOR = 20;

// ---- DB-coupled helpers ----

function readCozy(db, petId) {
  if (!petId) return null;
  return db.one('SELECT * FROM cozy_state WHERE pet_id = ?', [petId]);
}

function ensureCozy(db, petId, nowStr, nowMs) {
  const cur = readCozy(db, petId);
  if (cur) return cur;
  const now = nowMs || Date.now();
  db.run(
    `INSERT INTO cozy_state(
        pet_id, value, last_play_at, last_decay_at,
        today_day, today_peak, today_interactions, updated_at
     ) VALUES (?, 40, 0, ?, ?, 40, '{}', ?)`,
    [petId, now, todayDateStr(new Date(now)), nowStr()]
  );
  return readCozy(db, petId);
}

function todayDateStr(d) { return bondFmtYMD(d); }
function bondFmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Roll the today_* fields forward when the local date changes. Called
// before each read or decay tick.
function rollDayIfNeeded(db, petId, nowStr, nowMs) {
  const row = ensureCozy(db, petId, nowStr, nowMs);
  const today = todayDateStr(new Date(nowMs || Date.now()));
  if (row.today_day === today) return row;
  db.run(
    `UPDATE cozy_state
        SET today_day = ?, today_peak = ?, today_interactions = '{}', updated_at = ?
      WHERE pet_id = ?`,
    [today, row.value, nowStr(), petId]
  );
  return readCozy(db, petId);
}

// Apply decay for the elapsed time since last_decay_at. Idempotent — calling
// it 100x in 1s produces the same result as calling it once after 100s.
function applyDecayTick(db, petId, nowStr, nowMs) {
  const row = rollDayIfNeeded(db, petId, nowStr, nowMs);
  if (!row) return null;
  const now = nowMs || Date.now();
  // last_decay_at may be a big-int (Date.now() in modern browsers is
  // ~1.7e12); use Number() instead of `| 0` so a stored value > 2^31
  // doesn't wrap to negative and produce a 50-year decay delta.
  const last = Number(row.last_decay_at) || now;
  const dtSec = Math.max(0, (now - last) / 1000);
  if (dtSec < 1) return readCozy(db, petId);  // skip sub-second calls
  const lonelyHours = row.last_play_at
    ? (now - row.last_play_at) / 3_600_000
    : 0;
  const rate = decayPerSec(lonelyHours);
  const candidate = (row.value | 0) + rate * dtSec;
  let newValue;
  if (rate === 0) {
    newValue = Math.max(row.value | 0, DECAY_LOW_FLOOR);  // never below 20 once clamped
  } else {
    newValue = clamp(candidate, 0, 100);
  }
  db.run(
    `UPDATE cozy_state
        SET value = ?, last_decay_at = ?, updated_at = ?
      WHERE pet_id = ?`,
    [newValue | 0, now, nowStr(), petId]
  );
  return readCozy(db, petId);
}

// User-triggered interaction. Returns:
//   {
//     accepted: boolean,   // true if delta applied
//     silent:   boolean,   // true if cooldown hit
//     newValue: number,    // 0..100 after delta (or before if silent)
//     delta:    number,
//     particle: string|null, // '❤️' | '🍖' | '🧶' | '💤' | null
//     oneShotMs: number,   // petController.triggerOneShot ms
//     variant:  'default' | 'pat',  // v1 manifest keys
//   }
function applyInteraction(db, petId, action, opts, nowStr, nowMs) {
  const cfg = COZY_DELTAS[action];
  if (!cfg) return { accepted: false, reason: 'unknown_action' };
  const now = nowMs || Date.now();
  const row = rollDayIfNeeded(db, petId, nowStr, now);
  // Tier gate: only enforce on actions that have a requiresTier.
  if (cfg.requiresTier) {
    const tier = (opts && opts.bondTier) | 0 || 1;
    if (tier < cfg.requiresTier) {
      logPlay(db, petId, action, 0, 1, now);
      return { accepted: false, reason: 'tier_locked', required_tier: cfg.requiresTier, tier };
    }
  }
  // Cooldown lookup from play_log (cheap: index on pet_id+ts).
  const last = db.one(
    `SELECT ts, silent FROM play_log
      WHERE pet_id = ? AND action = ?
      ORDER BY ts DESC LIMIT 1`,
    [petId, action]
  );
  if (last && (now - Number(last.ts)) < cfg.cooldownMs) {
    logPlay(db, petId, action, 0, 1, now);
    return { accepted: false, silent: true, reason: 'cooldown', newValue: row.value | 0 };
  }
  const before = row.value | 0;
  const after = clamp(before + cfg.delta, 0, 100);
  // Update today_interactions count
  let interactions = {};
  try { interactions = JSON.parse(row.today_interactions || '{}'); } catch {}
  interactions[action] = (interactions[action] | 0) + 1;
  db.run(
    `UPDATE cozy_state
        SET value = ?, last_play_at = ?, today_peak = MAX(today_peak, ?),
            today_interactions = ?, updated_at = ?
      WHERE pet_id = ?`,
    [after, now, after, JSON.stringify(interactions), nowStr(), petId]
  );
  logPlay(db, petId, action, cfg.delta, 0, now);
  return {
    accepted: true,
    silent: false,
    newValue: after,
    delta: cfg.delta,
    particle: actionParticle(action),
    oneShotMs: actionOneShotMs(action),
    variant: actionVariant(action),
  };
}

function logPlay(db, petId, action, delta, silent, now) {
  try {
    // Use Math.trunc instead of `| 0` so timestamps > 2^31 (i.e. all
    // modern Date.now() values ~1.7e12) survive intact. `| 0` truncates
    // to a 32-bit signed int and wraps large values into negatives,
    // which would silently break the cooldown check (since `last.ts`
    // ends up negative and (now - last) is then huge).
    db.run(
      `INSERT INTO play_log(pet_id, ts, action, cozy_delta, silent)
       VALUES (?, ?, ?, ?, ?)`,
      [petId, Math.trunc(now), action, Math.trunc(delta), Math.trunc(silent)]
    );
  } catch (e) { /* table not yet created -> skip; bond migration handles it */ }
}

function actionParticle(action) {
  switch (action) {
    case 'pet':
    case 'pat':   return '❤️';
    case 'feed':  return '🍖';
    case 'play':  return '🧶';
    case 'sleep': return '💤';
    case 'cuddle':return '💕';
    default:      return null;
  }
}

function actionOneShotMs(action) {
  switch (action) {
    case 'pet':   return 1500;
    case 'pat':   return 2000;
    case 'feed':  return 2500;
    case 'play':  return 3000;
    case 'sleep': return 4000;
    case 'cuddle':return 6000;
    default:      return 1500;
  }
}

// v1 manifest only declares `default`/`walking`/`reminder`/`pat`. Other
// action keys map to `default` so the renderer falls back to the idle
// variant while CSS filters express the difference via PetMood.
function actionVariant(action) {
  if (action === 'pat') return 'pat';
  return 'default';
}

function getSnapshot(db, petId) {
  const row = readCozy(db, petId);
  if (!row) {
    return {
      pet_id: petId, value: 40, last_play_at: 0,
      today_peak: 40, today_interactions: {},
      lonely_hours: 0,
    };
  }
  const lonelyMs = row.last_play_at ? (Date.now() - row.last_play_at) : 0;
  const lonelyHours = lonelyMs > 0 ? lonelyMs / 3_600_000 : 0;
  let interactions = {};
  try { interactions = JSON.parse(row.today_interactions || '{}'); } catch {}
  return {
    pet_id: petId,
    value: row.value | 0,
    last_play_at: row.last_play_at | 0,
    today_day: row.today_day || '',
    today_peak: row.today_peak | 0,
    today_interactions: interactions,
    lonely_hours: lonelyHours,
  };
}

module.exports = {
  COZY_DELTAS, DECAY_LOW_FLOOR,
  decayPerSec,
  ensureCozy, rollDayIfNeeded, applyDecayTick,
  applyInteraction,
  getSnapshot,
};
