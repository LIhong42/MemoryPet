// main/auto_behaviors.js — decides whether to fire an autonomous pet
// behavior variant and gates it with a per-pet cooldown so we don't spam
// every minute.
//
// "Autonomous behaviors" here means: pet-initiated actions that don't need
// the user to be at the keyboard. Examples:
//
//   clingy_walk    : pet drifts toward the center of the screen (tier>=5)
//   weekend_greet  : small wave when the user first logs in on a weekend
//   farewell       : pet waves as the system clock passes 18:00 (tier>=3)
//   nap            : pet takes a deliberate nap at 13-14 / 22-23 (tier>=2)
//
// v1 stores the "last triggered timestamp per behavior" in the settings
// table under the key `auto_log:<pet_id>`, JSON-encoded.

const VALID_BEHAVIORS = new Set([
  'clingy_walk', 'weekend_greet', 'farewell', 'nap', 'festive_greet',
]);

const BEHAVIOR_RULES = [
  {
    name: 'clingy_walk',
    needs: { tierMin: 5, cozyMin: 70, hours: 'any', dow: 'any' },
    variant: 'default',
    oneShotMs: 4000,
    cooldownMs: 30 * 60_000,
  },
  {
    name: 'weekend_greet',
    needs: { tierMin: 3, cozyMin: 0, hours: 'any', dow: [0, 6] },
    variant: 'default',
    oneShotMs: 2500,
    cooldownMs: 30 * 60_000,
  },
  {
    name: 'farewell',
    needs: { tierMin: 3, cozyMin: 0, hours: { gte: 18, lt: 24 }, dow: 'any' },
    variant: 'default',
    oneShotMs: 3000,
    cooldownMs: 6 * 3600_000,    // once per evening
  },
  {
    name: 'nap',
    needs: { tierMin: 2, cozyMin: 0, hours: 'lunch_or_late', dow: 'any' },
    variant: 'sleep',
    oneShotMs: 5000,
    cooldownMs: 4 * 3600_000,    // 13h and 22h buckets each only once per period
  },
];

function loadLog(db, petId) {
  const raw = db.getSetting(`auto_log:${petId}`);
  try {
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

function saveLog(db, petId, log) {
  db.setSetting(`auto_log:${petId}`, JSON.stringify(log));
}

function canTrigger(db, petId, name, nowMs) {
  if (!VALID_BEHAVIORS.has(name)) return false;
  const log = loadLog(db, petId);
  const last = log[name] | 0;
  const rule = BEHAVIOR_RULES.find((r) => r.name === name);
  if (!rule) return false;
  if (!last) return true;
  return (nowMs - last) >= rule.cooldownMs;
}

function markTriggered(db, petId, name, nowMs) {
  const log = loadLog(db, petId);
  log[name] = nowMs;
  saveLog(db, petId, log);
}

function shouldFire(behaviorName, ctx) {
  const rule = BEHAVIOR_RULES.find((r) => r.name === behaviorName);
  if (!rule) return false;
  const { tierMin = 1, cozyMin = 0, hours, dow } = rule.needs;
  if ((ctx.tier | 0) < tierMin) return false;
  if ((ctx.cozy | 0) < cozyMin) return false;
  if (dow !== 'any' && Array.isArray(dow) && !dow.includes(ctx.dow)) return false;
  if (hours === 'any') {
    // pass
  } else if (hours === 'lunch_or_late') {
    const h = ctx.hour;
    if (!((h >= 13 && h < 14) || (h >= 22 && h < 23))) return false;
  } else if (hours && typeof hours === 'object') {
    const h = ctx.hour;
    if (h < hours.gte || h >= hours.lt) return false;
  }
  return true;
}

// Pick the highest-priority behavior that should fire right now and is
// off cooldown. Returns null if nothing fires.
function evaluate(db, petId, ctx, nowMs) {
  for (const rule of BEHAVIOR_RULES) {
    if (!shouldFire(rule.name, ctx)) continue;
    if (!canTrigger(db, petId, rule.name, nowMs)) continue;
    return {
      name: rule.name,
      variant: rule.variant,
      oneShotMs: rule.oneShotMs,
    };
  }
  return null;
}

module.exports = {
  VALID_BEHAVIORS,
  BEHAVIOR_RULES,
  loadLog, saveLog,
  canTrigger, markTriggered,
  shouldFire, evaluate,
};
