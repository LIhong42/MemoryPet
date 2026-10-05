// src/js/pet.js — pet window logic (drag + click + right-click menu + species + action animations)
const M = window.mp;

const sprite = document.getElementById('pet-sprite');
const badge = document.getElementById('pet-badge');
const bubble = document.getElementById('pet-bubble');
const zzz = document.getElementById('zzz-badge');

const stages = {
  cat:  document.getElementById('stage-cat'),
  dog:  document.getElementById('stage-dog'),
  bird: document.getElementById('stage-bird'),
};

// Bubble auto-fade timer — when a new head arrives we reset the timer so the
// bubble is re-showable even if it was mid-fade-out.
let bubbleFadeTimer = null;
let currentHead = null;
const BUBBLE_VISIBLE_MS = 10_000;
const BUBBLE_FADE_MS = 600;

let currentSpecies = 'cat';

async function loadSvgs() {
  // Inline the three SVG files into their stage divs. We do this once at
  // startup so species switching is just a CSS visibility toggle.
  const species = ['cat', 'dog', 'bird'];
  await Promise.all(species.map(async (s) => {
    try {
      const r = await fetch(`pet/${s}.svg`);
      const txt = await r.text();
      stages[s].innerHTML = txt;
    } catch (e) {
      console.error(`failed to load ${s}.svg`, e);
    }
  }));
}

function applySpecies(species) {
  if (!stages[species]) species = 'cat';
  currentSpecies = species;
  sprite.dataset.species = species;
  for (const k of Object.keys(stages)) {
    stages[k].classList.toggle('hidden', k !== species);
  }
}

function applyAction(action, direction) {
  sprite.dataset.action = action || 'idle';
  if (direction) sprite.dataset.direction = direction;
  if (action === 'sleep') {
    zzz.classList.remove('hidden');
    for (const s of Object.values(stages)) {
      const oc = s.querySelector('.eyes-open');
      const cc = s.querySelector('.eyes-closed');
      if (oc) oc.style.display = 'none';
      if (cc) cc.style.display = '';
    }
  } else {
    zzz.classList.add('hidden');
    for (const s of Object.values(stages)) {
      const oc = s.querySelector('.eyes-open');
      const cc = s.querySelector('.eyes-closed');
      if (oc) oc.style.display = '';
      if (cc) cc.style.display = 'none';
    }
  }
}

function setState(state, count, head) {
  sprite.dataset.state = state;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (head) {
      currentHead = head;
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
  currentHead = null;
}

// ---- Drag implementation ----
const DRAG_THRESHOLD_PX = 4;
let pressing = false;
let didDrag = false;
let lastX = 0;
let lastY = 0;
let downX = 0;
let downY = 0;

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
    // Pause autonomous movement for a couple seconds so the pet doesn't run
    // away right after the user releases the drag.
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
      // Mark bubble as handled (the user is about to see the modal).
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
  M.on('pet:species-changed', (payload) => {
    applySpecies(payload && payload.species);
  });
  M.on('pet:action-changed', (payload) => {
    applyAction(payload && payload.action, payload && payload.direction);
  });
}

(async () => {
  try {
    await loadSvgs();
    const s = await M.pet.getState();
    setState(s.state, s.count, s.head);
    // Apply persisted species + initial idle action. If a species value isn't
    // set yet we default to 'cat'.
    let species = 'cat';
    if (M.pet.getSpecies) {
      try { species = await M.pet.getSpecies(); } catch {}
    }
    applySpecies(species);
    applyAction('idle');
  } catch (e) {
    console.error('pet init', e);
  }
})();