// main/pet_controller.js — autonomous pet movement + state machine (frame-based).
//
// Per-tick responsibilities:
//   * Translate the pet window horizontally (walk).
//   * Pick the next animation variant ("variant" = a UI-level action key like
//     default/walking/reminder) and broadcast it to the renderer.
//   * Push the current variant + direction + petId so the renderer can resolve
//     frames via PetRegistry.
//
// Persistence:
//   * `pet_walk_enabled`  : "1" or "0"
//   * `pet_id`            : active pet id (replaces legacy `pet_species`)
//   * `pet_paused_until`  : epoch ms; controller skips movement while Date.now()
//                          < this value.

const { screen } = require('electron');

const TICK_MS = 100;

// Render height is fixed; width is computed from the active pet's
// `manifest.defaultSize` so the character fits the window without any
// letterboxing. Built-in pets declare 768×832 (≈ 0.92 wide:tall) and end up
// ≈ 203×220; an imported 109×145 ends up ≈ 165×220. Width floor of 48 px
// keeps extreme aspect ratios (e.g. a 1×4096 sprite) clickable.
const PET_RENDER_HEIGHT = 220;
const PET_RENDER_MIN_WIDTH = 48;

// Resolve `{w, h}` for the renderer / window given a manifest's
// `defaultSize`. Always returns PET_RENDER_HEIGHT on `h`. Falls back to
// 220×220 (square) when the input is missing or malformed.
function petRenderSize(defaultSize) {
  const w = (defaultSize && Number(defaultSize.w)) || 1;
  const h = (defaultSize && Number(defaultSize.h)) || 1;
  if (!(w > 0) || !(h > 0)) return { w: PET_RENDER_HEIGHT, h: PET_RENDER_HEIGHT };
  const wPx = Math.max(PET_RENDER_MIN_WIDTH, Math.round(PET_RENDER_HEIGHT * (w / h)));
  return { w: wPx, h: PET_RENDER_HEIGHT };
}

// UI-level variants the controller emits. Only the two folders shipped with
// the vup resource set ("Default" + "MOVE") plus the reminder override are
// reachable. The renderer turns these into a manifest `variants` lookup; the
// registry picks the actual frame leaf.
const VALID_VARIANTS = new Set([
  'default', 'walking', 'reminder',
]);

class PetController {
  constructor({ winPet, db, petRegistry }) {
    this.win = winPet;
    this.db = db;
    this.petRegistry = petRegistry;
    this.timer = null;
    this.action = 'default';   // 'default' | 'walking' | 'reminder'
    this.actionDirection = 1;  // -1 = left, +1 = right
    this.actionStepVel = 1;    // px per tick while walking
    this.actionUntil = 0;
    this._pickNextAt = 0;
    this.enabled = db.getSetting('pet_walk_enabled') !== '0';
    // Legacy `pet_species` is allowed during migration; map to a real pet id.
    const persistedPet = db.getSetting('pet_id')
      || (db.getSetting('pet_species') ? 'vup' : null);
    const knownIds = petRegistry ? petRegistry.list().map((p) => p.id) : [];
    this.petId = (persistedPet && knownIds.includes(persistedPet))
      ? persistedPet
      : (knownIds[0] || 'vup');
    if (petRegistry && this.petId && !db.getSetting('pet_id')) {
      db.setSetting('pet_id', this.petId);
    }
    this._reminderOn = false;
    // Window/CSS render size for the current pet. Recomputed on setPetId()
    // and used by _bounds() / _stepWalk() so the auto-walk clamp follows
    // the window when its width changes.
    let defaultSize = null;
    if (petRegistry) {
      const m = petRegistry.getManifest(this.petId);
      defaultSize = m && m.defaultSize;
    }
    const init = petRenderSize(defaultSize);
    this.renderW = init.w;
    this.renderH = init.h;
  }

  start() {
    if (this.timer) return;
    this._pickNextAt = Date.now() + 3000;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.broadcastAction();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.db.setSetting('pet_walk_enabled', this.enabled ? '1' : '0');
    if (!this.enabled) {
      this.action = 'default';
      this.broadcastAction();
    }
  }

  setPetId(id) {
    if (!this.petRegistry) return;
    const known = this.petRegistry.list().map((p) => p.id);
    if (!known.includes(id)) return;
    this.petId = id;
    this.db.setSetting('pet_id', id);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pet:pet-changed', { petId: id });
    }
    // Resize the window + broadcast the new render size so pet.js can
    // update its CSS variables. We keep the current x/y position so the
    // pet doesn't jump to a screen edge on switch.
    const manifest = this.petRegistry.getManifest(id);
    const newSize = petRenderSize(manifest ? manifest.defaultSize : null);
    if (newSize.w !== this.renderW || newSize.h !== this.renderH) {
      this.renderW = newSize.w;
      this.renderH = newSize.h;
      if (this.win && !this.win.isDestroyed()) {
        const [x, y] = this.win.getPosition();
        this.win.setBounds({ x, y, width: newSize.w, height: newSize.h });
        this.win.webContents.send('pet:size-changed', newSize);
      }
    }
    this.broadcastAction();
  }

  // One-shot: renderer can ask the controller to fire a one-shot variant for
  // `ms` milliseconds, after which the underlying state resumes. Used for
  // click-triggered `reminder`, etc.
  triggerOneShot(variant, ms) {
    if (!VALID_VARIANTS.has(variant)) return;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pet:action-changed', {
        petId: this.petId,
        action: variant,
        direction: this.actionDirection > 0 ? 'right' : 'left',
        oneShotMs: Math.max(300, ms || 1500),
      });
    }
  }

  setPaused(ms) {
    this.db.setSetting('pet_paused_until', String(Date.now() + (ms || 0)));
  }

  _paused() {
    const raw = this.db.getSetting('pet_paused_until');
    if (!raw) return false;
    const until = parseInt(raw, 10);
    if (!until) return false;
    if (Date.now() < until) return true;
    return false;
  }

  _bounds() {
    if (!this.win || this.win.isDestroyed()) return null;
    const [x, y] = this.win.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: this.renderW, height: this.renderH })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
  }

  broadcastAction() {
    if (!this.win || this.win.isDestroyed()) return;
    const action = this._reminderOn ? 'reminder' : this.action;
    this.win.webContents.send('pet:action-changed', {
      petId: this.petId,
      action,
      direction: this.actionDirection > 0 ? 'right' : 'left',
    });
  }

  // External API: scheduler can flip a "is the queue non-empty / has reminder"
  // flag and the controller will reflect that as `reminder` variant.
  setReminding(on) {
    const next = !!on;
    if (this._reminderOn === next) return;
    this._reminderOn = next;
    this.broadcastAction();
  }

  tick() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.enabled) {
      if (this.action !== 'default') {
        this.action = 'default';
        this.broadcastAction();
      }
      return;
    }
    if (this._reminderOn) {
      // Reminder overrides autonomous motion; just hold position.
      return;
    }
    if (this._paused()) {
      return;
    }

    const now = Date.now();
    if (this.action === 'default') {
      if (now >= this._pickNextAt) this._startRandomAction();
      return;
    }
    if (this.action === 'walking') {
      this._stepWalk();
      return;
    }
  }

  // Pick the next action. To reduce action-switching frequency the controller
  // spends most of its time in `default` and only occasionally steps out into
  // `walking`. Action durations are intentionally longer than the legacy
  // values so the renderer doesn't churn through frames at full speed.
  _startRandomAction() {
    const r = Math.random();
    if (r < 0.45) {
      // Walk — direction may flip, but only with low probability so the pet
      // doesn't zig-zag across the screen.
      if (Math.random() < 0.3) this.actionDirection *= -1;
      this.actionStepVel = 1 + Math.floor(Math.random() * 2);
      this.action = 'walking';
      // 6–12 seconds of walking before going back to default.
      this.actionUntil = Date.now() + 6000 + Math.floor(Math.random() * 6000);
    } else {
      // Stay in default — long idle so the pet doesn't appear jittery.
      // 8–20 seconds of pure default animation between walks.
      this._pickNextAt = Date.now() + 8000 + Math.floor(Math.random() * 12000);
      return;
    }
    this.broadcastAction();
  }

  _stepWalk() {
    if (Date.now() >= this.actionUntil) {
      this.action = 'default';
      // Pause in default for a while before considering another walk.
      this._pickNextAt = Date.now() + 6000 + Math.floor(Math.random() * 10000);
      this.broadcastAction();
      return;
    }
    const b = this._bounds();
    if (!b) return;
    let [x, y] = this.win.getPosition();
    x = (x || 0) + this.actionDirection * this.actionStepVel;
    if (x < b.x) {
      x = b.x;
      this.actionDirection = 1;
    } else if (x + this.renderW > b.x + b.w) {
      x = b.x + b.w - this.renderW;
      this.actionDirection = -1;
    }
    if ((y || 0) < b.y) y = b.y;
    if ((y + this.renderH) > b.y + b.h) y = b.y + b.h - this.renderH;
    this.win.setPosition(Math.round(x), Math.round(y), false);
  }
}

module.exports = { PetController, VALID_VARIANTS, petRenderSize };
