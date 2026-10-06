// src/js/pet.js — pet window: PNG-frame animator + drag/click/right-click +
// reminder UI. The legacy SVG species switcher is gone; the pet now plays
// PNG sequences resolved by the main process from each pet's manifest.
const M = window.mp;

const sprite = document.getElementById('pet-sprite');
const frame = document.getElementById('pet-frame');
const badge = document.getElementById('pet-badge');
const bubble = document.getElementById('pet-bubble');

// Bubble auto-fade timer — when a new head arrives we reset the timer so the
// bubble is re-showable even if it was mid-fade-out.
let bubbleFadeTimer = null;
const BUBBLE_VISIBLE_MS = 10_000;
const BUBBLE_FADE_MS = 600;

// Currently active pet and variant hint (for cache key).
let currentPetId = null;
let currentAction = 'default';
let currentDirection = 'right';
let currentVariantHint = '';

// LRU cache of preloaded <img> sets keyed by petId|variantHint. Capacity 20.
class FrameCache {
  constructor(capacity = 20) {
    this.cap = capacity;
    this.map = new Map();  // key -> HTMLImageElement[]
  }
  _key(petId, variantHint) { return `${petId}|${variantHint}`; }
  get(petId, variantHint) { return this.map.get(this._key(petId, variantHint)) || null; }
  put(petId, variantHint, imgs) {
    const k = this._key(petId, variantHint);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, imgs);
    while (this.map.size > this.cap) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  clear() { this.map.clear(); }
}
const cache = new FrameCache(20);

// Pre-create <img> objects so the browser can decode them off the hot path.
// Returns a Promise that resolves to the imgs list once all are decoded.
function preloadFrames(frames) {
  const imgs = [];
  let pending = 0;
  return new Promise((resolve) => {
    for (const f of frames) {
      const img = new Image();
      img.draggable = false;
      img.decoding = 'async';
      pending++;
      img.onload = img.onerror = () => {
        pending--;
        if (pending === 0) resolve(imgs);
      };
      img.src = f.url;
      imgs.push(img);
    }
    if (pending === 0) resolve(imgs);
  });
}

// FrameAnimator: plays a sequence of preloaded <img> elements by swapping
// the visible <img#pet-frame>. Uses setTimeout chain so a sequence switch
// cleanly cancels the previous chain. `loop` controls whether the sequence
// restarts; non-loop sequences call onEnded() once.
class FrameAnimator {
  constructor(displayImg) {
    this.img = displayImg;
    this.imgs = [];
    this.frames = [];           // [{url, ms}]
    this.loop = true;
    this.cursor = 0;
    this.timer = null;
    this.running = false;
    this.onEnded = null;
  }
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.running = false;
  }
  async load(frames, imgs, loop) {
    this.stop();
    this.frames = frames;
    this.imgs = imgs;
    this.loop = loop !== false;
    this.cursor = 0;
    if (this.imgs.length > 0) this.img.src = this.imgs[0].src;
  }
  start() {
    if (this.running) return;
    if (this.frames.length === 0) return;
    this.running = true;
    this._tick();
  }
  _tick() {
    if (!this.running) return;
    const cur = this.frames[this.cursor];
    if (cur && this.imgs[this.cursor]) this.img.src = this.imgs[this.cursor].src;
    const next = this.cursor + 1;
    const ms = (cur && cur.ms) || 125;
    this.timer = setTimeout(() => {
      if (!this.running) return;
      if (next >= this.frames.length) {
        if (this.loop) {
          this.cursor = 0;
          this._tick();
        } else {
          this.running = false;
          if (this.onEnded) this.onEnded();
        }
      } else {
        this.cursor = next;
        this._tick();
      }
    }, ms);
  }
}
const animator = new FrameAnimator(frame);

// ---- Variant resolution ----
// Re-resolve every cycle so we get fresh random leaf picks (== the
// "随机风格变体轮播" decision). Cached preloads are reused.
async function playVariant(action, direction, opts = {}) {
  currentAction = action;
  currentDirection = direction;
  sprite.dataset.action = action;
  sprite.dataset.direction = direction;

  // Make sure we're working with the right pet id.
  if (!currentPetId) {
    try { currentPetId = await M.pet.getCurrent(); }
    catch { currentPetId = null; }
    if (currentPetId) sprite.dataset.pet = currentPetId;
  }
  if (!currentPetId) return;

  let resolved;
  try {
    resolved = await M.pet.resolveFrames(currentPetId, action, direction);
  } catch (e) {
    console.error('[pet] resolveFrames failed', action, e);
    return;
  }
  if (!resolved || !resolved.frames || resolved.frames.length === 0) return;
  // Bail if the variant changed while we were awaiting.
  if (currentAction !== action || currentDirection !== direction) return;

  currentVariantHint = resolved.variantHint || '';

  let imgs = cache.get(currentPetId, currentVariantHint);
  if (!imgs) {
    imgs = await preloadFrames(resolved.frames);
    cache.put(currentPetId, currentVariantHint, imgs);
  }
  if (currentAction !== action || currentDirection !== direction) return;

  await animator.load(resolved.frames, imgs, resolved.loop);
  animator.onEnded = opts.onEnded || null;
  animator.start();
}

// ---- State / reminder UI ----
function setState(state, count, head) {
  sprite.dataset.state = state;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (head) {
      const parts = [];
      if (head.title) parts.push(head.title);
      if (head.contact_name) parts.push(head.contact_name);
      bubble.textContent = parts.join(' · ');
      bubble.classList.remove('hidden');
      bubble.classList.remove('fade');
      if (bubbleFadeTimer) clearTimeout(bubbleFadeTimer);
      bubbleFadeTimer = setTimeout(() => {
        bubble.classList.add('fade');
      }, BUBBLE_VISIBLE_MS);
    } else {
      bubble.classList.add('hidden');
    }
  } else {
    badge.classList.add('hidden');
    bubble.classList.add('hidden');
    bubble.classList.remove('fade');
    if (bubbleFadeTimer) { clearTimeout(bubbleFadeTimer); bubbleFadeTimer = null; }
  }
}

function clearReminderBubble() {
  bubble.classList.add('hidden');
  bubble.classList.remove('fade');
  if (bubbleFadeTimer) { clearTimeout(bubbleFadeTimer); bubbleFadeTimer = null; }
}

// ---- Drag implementation ----
const DRAG_THRESHOLD_PX = 4;
let pressing = false;
let didDrag = false;
let lastX = 0, lastY = 0, downX = 0, downY = 0;

sprite.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pressing = true;
  didDrag = false;
  downX = e.screenX;
  downY = e.screenY;
  lastX = e.screenX;
  lastY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!pressing) return;
  if (!didDrag) {
    if (Math.hypot(e.screenX - downX, e.screenY - downY) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
    sprite.classList.add('dragging');
    try { M.pet.setPaused(2000); } catch {}
  }
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  M.pet.moveBy(dx, dy);
  lastX = e.screenX;
  lastY = e.screenY;
});

window.addEventListener('mouseup', async () => {
  if (!pressing) return;
  pressing = false;
  sprite.classList.remove('dragging');
  if (didDrag) return;
  try {
    const s = await M.pet.getState();
    if (s && s.state === 'REMINDER') {
      clearReminderBubble();
      await M.pet.openReminder();
    } else {
      await M.pet.showMain();
    }
  } catch (err) {
    console.error('pet click error', err);
    try { await M.pet.showMain(); } catch {}
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  M.pet.openContextMenu();
});

// ---- Subscriptions from the main process ----
if (M.on) {
  M.on('pet:state-changed', (payload) => {
    setState(payload.state, payload.count, payload.head);
  });
  M.on('pet:pet-changed', (payload) => {
    if (payload && payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      sprite.dataset.pet = currentPetId;
      // Drop cached preloads for the previous pet — they'll be rebuilt on
      // next play if needed.
      cache.clear();
      // Force-replay current action under the new pet.
      playVariant(currentAction, currentDirection);
    }
  });
  M.on('pet:action-changed', (payload) => {
    if (!payload) return;
    if (payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      sprite.dataset.pet = currentPetId;
    }
    if (payload.oneShotMs && payload.action) {
      // One-shot: play the requested action for `oneShotMs` then fall back to
      // whatever idle-ish variant the controller would be in underneath.
      playVariant(payload.action, payload.direction || currentDirection, {
        onEnded: () => {
          // After one-shot, the next action-changed from the controller will
          // restore the underlying state. We do nothing here on purpose.
        },
      });
      return;
    }
    playVariant(payload.action, payload.direction);
  });
}

// ---- Init ----
(async () => {
  try {
    const s = await M.pet.getState();
    setState(s.state, s.count, s.head);
    if (M.pet.getCurrent) {
      try { currentPetId = await M.pet.getCurrent(); } catch {}
    }
    if (currentPetId) sprite.dataset.pet = currentPetId;
    playVariant('default', 'right');
  } catch (e) {
    console.error('pet init', e);
  }
})();
