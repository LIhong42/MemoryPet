// src/js/pages/today.js — Today's reminders + important dates + events.
// The original home page's "当前提醒" block has been folded into the top
// of this page (see PR description).
import { api, escapeHtml, displayName, fmtDate, fmtDateTime } from '../api.js';
import { register, navigate } from '../router.js';

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const events = await api.events.listToday();
  const contacts = await api.contacts.list();
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const activeReminders = await api.reminders.listActive();

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

    <div class="section-header"><h2>⏰ 当前提醒</h2></div>
    ${activeReminders.length === 0
      ? `<div class="empty">暂无待办提醒 ✨</div>`
      : activeReminders.map((r) => `
        <div class="card clickable" data-source="${escapeHtml(r.source)}" data-id="${escapeHtml(r.source_id)}" data-action="reminder">
          <div class="row between">
            <div>
              <div><strong>${escapeHtml(r.title)}</strong></div>
              <div class="meta">${escapeHtml(r.source === 'event' ? '事件' : '重要日期')}${r.contact_name ? ' · ' + escapeHtml(r.contact_name) : ''}</div>
            </div>
            <span class="tag">待处理</span>
          </div>
        </div>
      `).join('')}

    <div class="section-header"><h2>🎂 重要日期</h2></div>
    ${impDatesAll.length === 0
      ? `<div class="empty">今天没有重要日期</div>`
      : impDatesAll.map((d) => `
        <div class="card">
          <div><strong>${escapeHtml(d.label)}</strong> · ${escapeHtml(displayName(d.contact))}</div>
          <div class="meta">${kindLabel(d.kind)}${d.year ? ' · ' + (today.getFullYear() - d.year) + '岁' : ''}</div>
        </div>
      `).join('')}

    <div class="section-header"><h2>📅 事件</h2></div>
    ${events.length === 0
      ? `<div class="empty">今天没有事件</div>`
      : events.map((e) => `
        <div class="card clickable" data-id="${escapeHtml(e.id)}">
          <div><strong>${escapeHtml(e.title)}</strong> <span class="tag">${escapeHtml(categoryTagLabel(e.category))}</span>${e.tag_kind ? ` <span class="tag">${tagKindLabel(e.tag_kind)}</span>` : ''}</div>
          <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '月' + e.lunar_day + '日' : ''}${e.contact_id && cById[e.contact_id] ? ' · ' + escapeHtml(displayName(cById[e.contact_id])) : ''}</div>
        </div>
      `).join('')}
  `;

  app.querySelectorAll('.card.clickable').forEach((el) => {
    if (el.dataset.action === 'reminder') {
      el.onclick = () => {
        window.dispatchEvent(new CustomEvent('open-reminder', {
          detail: { source: el.dataset.source, source_id: el.dataset.id },
        }));
      };
    } else {
      el.onclick = () => navigate('/events/' + el.dataset.id);
    }
  });
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

function categoryTagLabel(c) {
  return ({ general: '提醒', memorial: '回忆', work: '工作' }[c]) || c || '';
}

function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

register('/today', render);
