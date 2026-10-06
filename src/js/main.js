// src/js/main.js — entry point, wires router, navigation active link, reminder modal, pet state pill
import { api, escapeHtml, fmtDateTime, toast } from './api.js';
import { register, onChange, start } from './router.js';
import './pages/today.js';
import './pages/contacts_list.js';
import './pages/contact_detail.js';
import './pages/contact_edit.js';
import './pages/contact_list_edit.js';
import './pages/attributes.js';
import './pages/attribute_detail.js';
import './pages/important_date_detail.js';
import './pages/events.js';
import './pages/events_memorial.js';
import './pages/events_work.js';
import './pages/event_edit.js';
import './pages/search.js';
import './pages/settings.js';

function updateActiveLink(path) {
  document.querySelectorAll('.nav a').forEach((a) => {
    const r = a.getAttribute('data-route') || '';
    const match = (path === '/' && r === '/') ||
                  (path.startsWith(r) && r !== '/');
    a.classList.toggle('active', match);
  });
}

function updatePetPill(state) {
  const pill = document.getElementById('pet-pill');
  const text = document.getElementById('pet-pill-text');
  if (!pill) return;
  if (state && state.state === 'REMINDER') {
    pill.classList.add('remind');
    text.textContent = `桌宠提醒（${state.count}）`;
  } else {
    pill.classList.remove('remind');
    text.textContent = '桌宠正常';
  }
}

function showReminderModal(r) {
  const modal = document.getElementById('reminder-modal');
  const title = document.getElementById('reminder-title');
  const meta = document.getElementById('reminder-meta');
  const desc = document.getElementById('reminder-description');
  const actions = document.getElementById('reminder-actions');

  title.textContent = r.title || '提醒';
  meta.innerHTML = `
    <span class="tag">${r.source === 'event' ? '事件' : '重要日期'}</span>
    ${r.contact_name ? '关联联系人：' + escapeHtml(r.contact_name) : ''}
    · ${fmtDateTime(r.next_fire_at)}
  `;
  desc.textContent = r.description || '';

  actions.innerHTML = `
    <button class="btn" id="r-done">完成</button>
    <button class="btn secondary" id="r-snooze">稍后 30 分钟</button>
    <button class="btn secondary" id="r-snooze-1d">明天再提醒</button>
  `;
  modal.classList.remove('hidden');

  document.getElementById('r-done').onclick = async () => {
    await api.reminders.markDone(r.source, r.source_id);
    modal.classList.add('hidden');
    toast('已标记完成');
    location.reload();
  };
  document.getElementById('r-snooze').onclick = async () => {
    await api.reminders.snooze(r.source, r.source_id, 30);
    modal.classList.add('hidden');
    toast('30 分钟后再提醒');
  };
  document.getElementById('r-snooze-1d').onclick = async () => {
    await api.reminders.snooze(r.source, r.source_id, 60 * 24);
    modal.classList.add('hidden');
    toast('明天再提醒');
  };
}

document.getElementById('reminder-close').onclick = () => {
  document.getElementById('reminder-modal').classList.add('hidden');
};

api.on('pet:state-changed', (payload) => {
  updatePetPill(payload);
  if (payload.state === 'NORMAL' && !document.getElementById('reminder-modal').classList.contains('hidden')) {
    document.getElementById('reminder-modal').classList.add('hidden');
  }
});

api.on('main:open-reminder', async (payload) => {
  // Fetch the active reminder matching payload source_id
  const active = await api.reminders.listActive();
  const r = active.find((x) => x.source === payload.source && x.source_id === payload.source_id)
            || active[0];
  if (r) showReminderModal(r);
});

// Allow the main process (e.g. pet context menu) to push a hash route.
api.on('main:navigate', (path) => {
  if (typeof path === 'string' && path.startsWith('/')) {
    location.hash = '#' + path;
  }
});

// App-internal open-reminder (from home page click)
window.addEventListener('open-reminder', async (e) => {
  const { source, source_id } = e.detail;
  const active = await api.reminders.listActive();
  const r = active.find((x) => x.source === source && x.source_id === source_id)
            || active[0];
  if (r) showReminderModal(r);
});

onChange(updateActiveLink);

// Initial pet pill state
api.pet.getState().then(updatePetPill);

start();