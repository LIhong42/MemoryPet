// src/js/pages/events.js — events list (all / filtered)
import { api, escapeHtml, fmtDateTime, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render(args, params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const opts = {};
  if (params.contact_id) opts.contact_id = params.contact_id;
  const [events, contacts] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
  ]);
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  app.innerHTML = `
    <div class="row between">
      <h1>事件</h1>
      <button class="btn" id="new-event">+ 新建</button>
    </div>
    ${events.length === 0
      ? `<div class="empty">还没有事件 · 点 + 新建 创建一个</div>`
      : events.map((e) => `
        <div class="card clickable" data-id="${escapeHtml(e.id)}">
          <div class="row between">
            <div>
              <div><strong>${escapeHtml(e.title)}</strong></div>
              <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.contact_id && cById[e.contact_id] ? ' · ' + escapeHtml(cById[e.contact_id].first_name) : ''}${e.active ? '' : ' · 已结束'}</div>
            </div>
            <div>
              ${e.remind ? '<span class="tag">提醒</span>' : ''}
            </div>
          </div>
        </div>
      `).join('')}
  `;

  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id);
  });
  document.getElementById('new-event').onclick = () => navigate('/events/new');
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

register('/events', render);