// src/js/pages/today.js — Today's reminders + important dates + events.
// The original home page's "当前提醒" block has been folded into the top
// of this page (see PR description).
import { api, escapeHtml, firstChar, displayName, eventKindAttr, fmtDate, fmtDateTime, formatRelative, countdownTo, categoryIcon, contactColorIndex } from '../api.js';
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
      : activeReminders.map((r) => {
        const kind = r.source === 'event' ? 'reminder' : 'important';
        const sourceLabel = r.source === 'event' ? '事件' : '重要日期';
        const contactName = r.contact_name || '';
        return `
        <div class="card list-row clickable" data-kind="${kind}" data-source="${escapeHtml(r.source)}" data-id="${escapeHtml(r.source_id)}" data-action="reminder">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${kind}">⏰</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(r.title)} <span class="tag" style="margin-left:6px">待处理</span></div>
            <div class="lr-meta">${escapeHtml(sourceLabel)}${contactName ? ' · ' + escapeHtml(contactName) : ''}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip urgent"><span class="chip-dot"></span>立即处理</div>
          </div>
        </div>
      `}).join('')}

    <div class="section-header"><h2>🎂 重要日期</h2></div>
    ${impDatesAll.length === 0
      ? `<div class="empty">今天没有重要日期</div>`
      : impDatesAll.map((d) => {
        const tone = contactColorIndex(d.contact.name);
        return `
        <div class="card list-row" data-kind="important" data-contact-color="${tone}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="important">🎂</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(d.label)}</div>
            <div class="lr-meta">${escapeHtml(displayName(d.contact))} · ${escapeHtml(kindLabel(d.kind))}${d.year ? ' · ' + (today.getFullYear() - d.year) + '岁' : ''}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip urgent"><span class="chip-dot"></span>今天</div>
          </div>
        </div>
      `}).join('')}

    <div class="section-header"><h2>📅 事件</h2></div>
    ${events.length === 0
      ? `<div class="empty">今天没有事件</div>`
      : events.map((e) => {
        const kind = eventKindAttr(e);
        const contact = e.contact_id && cById[e.contact_id] ? cById[e.contact_id] : null;
        return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
            ${contact ? `<span class="stack-av" style="background: var(--contact-${contactColorIndex(contact.name)})" title="${escapeHtml(displayName(contact))}">${escapeHtml(firstChar(contact.name))}</span>` : ''}
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title)} <span class="tag" style="margin-left:6px">${escapeHtml(categoryTagLabel(e.category))}</span>${e.tag_kind ? ` <span class="tag">${escapeHtml(tagKindLabel(e.tag_kind))}</span>` : ''}</div>
            <div class="lr-meta">${escapeHtml(kindLabel(e.remind_kind))}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '-' + e.lunar_day : ''}${contact ? ' · ' + escapeHtml(displayName(contact)) : ''}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip urgent"><span class="chip-dot"></span>今天 ${escapeHtml((e.next_fire_at || e.remind_date || '').slice(11, 16) || '09:00')}</div>
          </div>
        </div>
      `}).join('')}
  `;

  app.querySelectorAll('.card.clickable').forEach((el) => {
    if (el.dataset.action === 'reminder') {
      el.onclick = () => {
        window.dispatchEvent(new CustomEvent('open-reminder', {
          detail: { source: el.dataset.source, source_id: el.dataset.id },
        }));
      };
    } else {
      el.onclick = () => navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
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
