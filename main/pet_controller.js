// main/pet_controller.js — autonomous pet movement + state machine.
//
// Runs a 100 ms timer that translates the pet window horizontally
// (walk) / vertically (jump parabola) / not at all (sleep / idle). State
// changes are pushed to the renderer via IPC so the right CSS animation
// plays. Persistence:
//   * `pet_walk_enabled`  : "1" or "0"
//   * `pet_species`       : "cat" | "dog" | "bird"
//   * `pet_paused_until`  : epoch ms; controller skips movement while Date.now()
//                          < this value. We don't read this on the JS hot path —
//                          it's a flag used by the drag handler.

const { screen } = require('electron');

const TICK_MS = 100;
const PET_W = 220;
const PET_H = 240;
const VALID_SPECIES = new Set(['cat', 'dog', 'bird', 'miku']);

class PetController {
  constructor({ winPet, db }) {
    this.win = winPet;
    this.db = db;
    this.timer = null;
    // Movement state. The pet walks in a direction at a step velocity (per
    // tick) for a random duration, then either turns, switches to idle /
    // sleep / jump, or keeps walking in the same direction.
    this.action = 'idle';      // 'idle' | 'walking' | 'jumping' | 'sleeping' | 'sing' | 'wave'
    this.actionDirection = 1;  // -1 = left, +1 = right
    this.actionStepVel = 2;    // px per tick while walking
    this.actionUntil = 0;      // epoch ms; controller switches out of current action after
    this.jumpVy = 0;
    this.jumpBaseY = 0;
    this.jumpBaseX = 0;
    this._pickNextAt = 0;
    this.enabled = db.getSetting('pet_walk_enabled') !== '0';
    this.species = VALID_SPECIES.has(db.getSetting('pet_species'))
      ? db.getSetting('pet_species') : 'cat';
    // One-shot action (miku wave / sing). When set we run that action for
    // `oneShotUntil`, then restore the underlying behavior. This runs on top
    // of the regular idle/walk/jump/sleep state machine.
    this.oneShotAction = null;     // 'wave' | 'sing' | null
    this.oneShotUntil = 0;
  }

  start() {
    if (this.timer) return;
    this._pickNextAt = Date.now() + 1500; // small startup delay
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.broadcastAction();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.db.setSetting('pet_walk_enabled', this.enabled ? '1' : '0');
    // When disabled we send 'idle' so the renderer stops the walk animation.
    if (!this.enabled) {
      this.action = 'idle';
      this.broadcastAction();
    }
  }

  setSpecies(s) {
    if (!VALID_SPECIES.has(s)) s = 'cat';
    this.species = s;
    this.db.setSetting('pet_species', s);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pet:species-changed', { species: s });
    }
  }

  // Miku 专属：触发一次性动作（wave / sing）。会暂时接管渲染端的
  // data-action，到时间后自动恢复到底层动作（idle/walking/...）。
  triggerOneShot(action, ms) {
    if (action !== 'wave' && action !== 'sing') return;
    this.oneShotAction = action;
    this.oneShotUntil = Date.now() + Math.max(300, ms || 1500);
    this.broadcastAction();
  }

  // Called from the drag handler on every move-by call; we pause for `ms` so
  // the pet doesn't run away right after the user releases the cursor.
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
    const display = screen.getDisplayMatching({ x, y, width: PET_W, height: PET_H })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
  }

  broadcastAction() {
    if (!this.win || this.win.isDestroyed()) return;
    // One-shot action overlays the underlying state. Underneath, the pet
    // keeps walking/jumping/etc.; the renderer just plays the cute one-shot
    // animation on top.
    const displayed = (this.oneShotUntil > Date.now() && this.oneShotAction)
      ? this.oneShotAction : this.action;
    this.win.webContents.send('pet:action-changed', {
      action: displayed,
      direction: this.actionDirection > 0 ? 'right' : 'left',
    });
  }

  tick() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.enabled) {
      // Make sure the renderer plays the idle animation even if it wasn't on
      // 'idle' yet (e.g. the user just disabled walking mid-step).
      if (this.action !== 'idle') {
        this.action = 'idle';
        this.broadcastAction();
      }
      return;
    }
    if (this._paused()) {
      // Treat as idle visually but don't pick a new action — we resume when
      // the pause window ends.
      this._checkOneShotExpiry();
      return;
    }

    const now = Date.now();
    // Miku 专属：闲置时偶尔主动唱一段歌，超时自动恢复
    if (this.species === 'miku' && this.action === 'idle'
        && !this.oneShotAction
        && now >= this._pickNextAt) {
      // 18% 概率在 idle 状态下自动开嗓（让桌面常有小惊喜）
      if (Math.random() < 0.18) {
        this.triggerOneShot('sing', 2200 + Math.floor(Math.random() * 1800));
        this._pickNextAt = now + 8000 + Math.floor(Math.random() * 8000);
        return;
      }
    }
    this._checkOneShotExpiry();
    if (this.action === 'idle') {
      if (now >= this._pickNextAt) this._startRandomAction();
      return;
    }
    if (this.action === 'walking') {
      this._stepWalk();
      return;
    }
    if (this.action === 'jumping') {
      this._stepJump();
      return;
    }
    if (this.action === 'sleeping') {
      if (now >= this.actionUntil) {
        this.action = 'idle';
        this._pickNextAt = now + 500 + Math.floor(Math.random() * 1500);
        this.broadcastAction();
      }
      return;
    }
  }

  _checkOneShotExpiry() {
    if (this.oneShotAction && Date.now() >= this.oneShotUntil) {
      this.oneShotAction = null;
      this.oneShotUntil = 0;
      this.broadcastAction();
    }
  }

  // ---- Action selection ----
  _startRandomAction() {
    const r = Math.random();
    if (r < 0.55) {
      // Walk. Direction biased to keep going in the same direction as the
      // last walk so the pet doesn't look jittery.
      if (Math.random() < 0.4) this.actionDirection *= -1;
      this.actionStepVel = 1 + Math.floor(Math.random() * 3); // 1..3 px/tick
      this.action = 'walking';
      this.actionUntil = Date.now() + 2000 + Math.floor(Math.random() * 4000); // 2-6 s
    } else if (r < 0.75) {
      // Jump.
      this._beginJump();
    } else if (r < 0.95) {
      // Sleep.
      this.action = 'sleeping';
      this.actionUntil = Date.now() + 5000 + Math.floor(Math.random() * 7000); // 5-12 s
    } else {
      // Idle a bit longer.
      this._pickNextAt = Date.now() + 2000 + Math.floor(Math.random() * 4000);
      return;
    }
    this.broadcastAction();
  }

  // ---- Walk ----
  _stepWalk() {
    if (Date.now() >= this.actionUntil) {
      this.action = 'idle';
      this._pickNextAt = Date.now() + 1500 + Math.floor(Math.random() * 4000);
      this.broadcastAction();
      return;
    }
    const b = this._bounds();
    if (!b) return;
    let [x, y] = this.win.getPosition();
    x = (x || 0) + this.actionDirection * this.actionStepVel;
    // Bounce off the screen edges.
    if (x < b.x) {
      x = b.x;
      this.actionDirection = 1;
    } else if (x + PET_W > b.x + b.w) {
      x = b.x + b.w - PET_W;
      this.actionDirection = -1;
    }
    // Walk only moves X; we still need to keep Y within the work area in case
    // the user dragged the pet up/down (jumping not active here).
    if ((y || 0) < b.y) y = b.y;
    if ((y + PET_H) > b.y + b.h) y = b.y + b.h - PET_H;
    this.win.setPosition(Math.round(x), Math.round(y), false);
  }

  // ---- Jump ----
  _beginJump() {
    this.action = 'jumping';
    this.jumpVy = -6.5;       // upward velocity in "step units" per tick (negative = up)
    const [x, y] = this.win.getPosition();
    this.jumpBaseX = x || 0;
    this.jumpBaseY = y || 0;
    this.actionUntil = Date.now() + 900; // hard cap so a stuck jump can't loop forever
    this.broadcastAction();
  }
  _stepJump() {
    const b = this._bounds();
    if (!b) return;
    this.jumpVy += 0.55; // gravity per tick
    const [, curY] = this.win.getPosition();
    let nx = this.jumpBaseX + this.actionDirection * this.actionStepVel * 0.6;
    let ny = (curY || 0) + this.jumpVy;
    // Bounce horizontally off edges.
    if (nx < b.x) { nx = b.x; this.actionDirection = 1; }
    if (nx + PET_W > b.x + b.w) { nx = b.x + b.w - PET_W; this.actionDirection = -1; }
    // Land when we cross back down to (or below) the base.
    if (this.jumpVy >= 0 && ny >= this.jumpBaseY) {
      ny = this.jumpBaseY;
      this.action = 'idle';
      this._pickNextAt = Date.now() + 800 + Math.floor(Math.random() * 2000);
      this.broadcastAction();
    } else if (Date.now() >= this.actionUntil) {
      // Stuck: abort back to idle.
      this.action = 'idle';
      this._pickNextAt = Date.now() + 800;
      this.broadcastAction();
    }
    // Round to integers — setPosition refuses non-finite values and Electron's
    // positional APIs have rejected fractional coords in older versions.
    const ix = Math.round(nx);
    const iy = Math.round(ny);
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
      // Defensive abort: reset to idle so the next tick doesn't loop on
      // garbage.
      this.action = 'idle';
      this._pickNextAt = Date.now() + 500;
      this.broadcastAction();
      return;
    }
    this.win.setPosition(ix, iy, false);
  }
}

module.exports = { PetController, VALID_SPECIES };