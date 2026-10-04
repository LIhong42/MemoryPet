// src/js/pages/today.js — Today's events + important dates
import { api, escapeHtml, fmtDate, fmtDateTime } from '../api.js';
import { register, navigate } from '../router.js';

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const events = await api.events.listToday();
  const contacts = await api.contacts.list();
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  const today = new Date();
  const m = today.getMonth() + 1;
  const d = today.getDate();
  const impDatesAll = [];
  for (const c of contacts) {
    const ids = await api.importantDates.list(c.id);
    for (const idt of ids) {
      if (idt.month === m && idt.day === d) impDatesAll.push({ ...idt, contact: c });
    }
  }

  app.innerHTML = `
    <h1>今日 · ${today.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}</h1>

    <div class="section-header"><h2>🎂 重要日期</h2></div>
    ${impDatesAll.length === 0
      ? `<div class="empty">今天没有重要日期</div>`
      : impDatesAll.map((d) => `
        <div class="card">
          <div><strong>${escapeHtml(d.label)}</strong> · ${escapeHtml(d.contact.first_name)}</div>
          <div class="meta">${kindLabel(d.kind)}${d.year ? ' · ' + (today.getFullYear() - d.year) + '岁' : ''}</div>
        </div>
      `).join('')}

    <div class="section-header"><h2>📅 事件</h2></div>
    ${events.length === 0
      ? `<div class="empty">今天没有事件</div>`
      : events.map((e) => `
        <div class="card clickable" data-id="${escapeHtml(e.id)}">
          <div><strong>${escapeHtml(e.title)}</strong></div>
          <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.contact_id && cById[e.contact_id] ? ' · ' + escapeHtml(cById[e.contact_id].first_name) : ''}</div>
        </div>
      `).join('')}
  `;

  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id);
  });
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

register('/today', render);