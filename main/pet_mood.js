// main/pet_mood.js — Tier 4 of the pet intimacy system.
//
// Pure decision tree that turns the user's current state into a single
// "dominant mood" + UI hints. The renderer uses `mood` to drive CSS
// filters and `variant` to ask the main process for a different sprite
// set; the auto-trigger ends up as a one-shot variant.
//
// This module is intentionally side-effect-free. It does not touch the DB
// and does not broadcast — `scheduler.js` does that on a 1s tick.

function computeMood(input) {
  const tier = (input && input.bond_tier) | 0 || 1;
  const weekScore = clampNum(input && input.week_score, 0, 100);
  const cozy = clampNum(input && input.cozy, 0, 100);
  const lonelyHours = Math.max(0, (input && input.lonely_hours) | 0 || 0);
  const activeReminders = (input && input.active_reminders) | 0 || 0;
  const isWeekend = !!(input && input.is_weekend);
  const newEventToday = !!(input && input.new_event_today);
  const newMemorialToday = !!(input && input.new_memorial_today);

  // Priority order — top wins.
  // 1. reminder overrides everything (the pet is nagged by an active task)
  if (activeReminders > 0) {
    return {
      mood: 'reminder',
      variant: 'reminder',
      bubble: null,
      autoTrigger: null,
      cssClass: 'reminder',
    };
  }

  // 2. depressed — long loneliness AND severely cozy-starved
  if (cozy < 20 && lonelyHours >= 48) {
    return {
      mood: 'depressed',
      variant: 'default',
      bubble: '你已经很久没陪我了…',
      autoTrigger: null,
      cssClass: 'depressed',
    };
  }

  // 3. sad — very low cozy
  if (cozy < 10) {
    return {
      mood: 'sad',
      variant: 'default',
      bubble: null,
      autoTrigger: null,
      cssClass: 'sad',
    };
  }

  // 4. concerned — pet cares about the user's weak weekly contribution.
  // Note: only fires when reminders are clear, otherwise reminder wins.
  if (weekScore < 30) {
    return {
      mood: 'concerned',
      variant: 'default',
      bubble: '本周你的关系维护有点少哦',
      autoTrigger: null,
      cssClass: 'concerned',
    };
  }

  // 5. lonely — no play > 24h
  if (lonelyHours >= 24) {
    return {
      mood: 'lonely',
      variant: 'default',
      bubble: lonelyHours >= 72 ? '我好想你' : '你回来啦？',
      autoTrigger: null,
      cssClass: 'lonely',
    };
  }

  // 6. festive — weekend + high enough tier to "earn" celebration
  if (tier >= 4 && isWeekend) {
    return {
      mood: 'festive',
      variant: 'default',
      bubble: '周末好~',
      autoTrigger: null,
      cssClass: 'festive',
    };
  }

  // 7. proud — user just did something noteworthy today
  if (newMemorialToday) {
    return {
      mood: 'proud',
      variant: 'default',
      bubble: '今天你记录了一段纪念，超棒 ✨',
      autoTrigger: null,
      cssClass: 'proud',
    };
  }
  if (newEventToday) {
    return {
      mood: 'proud',
      variant: 'default',
      bubble: '今天的你，超棒 ✨',
      autoTrigger: null,
      cssClass: 'proud',
    };
  }

  // 8. happy_clingy — warm + cozy AND tier high enough to trigger auto-行为
  if (cozy >= 70 && tier >= 5) {
    return {
      mood: 'happy_clingy',
      variant: 'default',
      bubble: '来贴贴~',
      autoTrigger: 'clingy_walk',
      cssClass: 'happy_clingy',
    };
  }

  // 9. missing_you — okayish but a bit cold
  if (cozy < 40) {
    return {
      mood: 'missing_you',
      variant: 'default',
      bubble: null,
      autoTrigger: null,
      cssClass: 'missing_you',
    };
  }

  // 10. default content
  return {
    mood: 'content',
    variant: 'default',
    bubble: null,
    autoTrigger: null,
    cssClass: 'content',
  };
}

function clampNum(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

module.exports = { computeMood };
