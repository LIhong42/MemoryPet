// src/js/pet.js — pet window logic (drag + click + right-click menu)
const M = window.mp;
const sprite = document.getElementById('pet-sprite');
const badge = document.getElementById('pet-badge');
const bubble = document.getElementById('pet-bubble');

function setState(state, count, head) {
  sprite.dataset.state = state;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (head) {
      bubble.textContent = head.title + (head.contact_name ? ' · ' + head.contact_name : '');
      bubble.classList.remove('hidden');
    } else {
      bubble.classList.add('hidden');
    }
  } else {
    badge.classList.add('hidden');
    bubble.classList.add('hidden');
  }
}

// ---- Drag implementation ----
// Per-tick delta (relative to the previous mousemove). The main process
// adds each delta to the window's CURRENT position, so the window tracks
// the cursor 1:1 without run-away.
const DRAG_THRESHOLD_PX = 4;
let pressing = false;
let didDrag = false;
let lastX = 0;
let lastY = 0;
let downX = 0;
let downY = 0;

sprite.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // primary button only
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
    // Use cumulative distance from mousedown for the threshold check so we
    // arm the drag at the right moment regardless of move-event density.
    if (Math.hypot(e.screenX - downX, e.screenY - downY) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
    sprite.classList.add('dragging');
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
  if (didDrag) return; // it was a drag — don't open anything on release
  // Sub-threshold release = click. Open main window; if pet is in REMINDER
  // state, also pop the reminder modal so the user can act immediately.
  try {
    const s = await M.pet.getState();
    if (s && s.state === 'REMINDER') {
      await M.pet.openReminder();
    } else {
      await M.pet.showMain();
    }
  } catch (err) {
    console.error('pet click error', err);
    try { await M.pet.showMain(); } catch {}
  }
});

// ---- Right-click context menu ----
// The pet window has no native menu bar, so we wire contextmenu → IPC, and
// the main process shows an Electron Menu at the cursor position.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  M.pet.openContextMenu();
});

if (M.on) {
  M.on('pet:state-changed', (payload) => {
    setState(payload.state, payload.count, payload.head);
  });
}

(async () => {
  try {
    const s = await M.pet.getState();
    setState(s.state, s.count, s.head);
  } catch (e) {
    console.error('pet init', e);
  }
})();
