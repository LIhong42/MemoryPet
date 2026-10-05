// src/js/pages/search.js
import { api, escapeHtml, firstChar, displayName, eventKindAttr, fmtDateTime, formatRelative, categoryIcon, contactColorIndex } from '../api.js';
import { register, navigate } from '../router.js';

async function render(_args, params) {
  const app = document.getElementById('app');
  const q = (params.q || '').trim();
  app.innerHTML = `
    <h1>搜索</h1>
    <div class="card">
      <input type="text" id="q" placeholder="搜联系人、事件、重要日期…" value="${escapeHtml(q)}" autofocus />
    </div>
    <div id="search-results"></div>
  `;
  const input = document.getElementById('q');
  input.oninput = async () => {
    const v = input.value.trim();
    if (!v) {
      document.getElementById('search-results').innerHTML = '';
      return;
    }
    navigate('/search?q=' + encodeURIComponent(v));
  };
  if (q) await runSearch(q);
}

async function runSearch(q) {
  const out = document.getElementById('search-results');
  out.innerHTML = `<div class="empty">搜索中…</div>`;
  const r = await api.search.query(q);
  const memorial = r.memorial_events || [];
  out.innerHTML = `
    ${r.contacts.length === 0 && r.events.length === 0 && memorial.length === 0 && r.important_dates.length === 0
      ? `<div class="empty">没有匹配结果</div>`
      : ''}
    ${r.contacts.length > 0 ? `
      <div class="section-header"><h2>联系人 (${r.contacts.length})</h2></div>
      ${r.contacts.map((c) => {
        const tone = contactColorIndex(c.name);
        return `
        <div class="card list-row clickable" data-contact-color="${tone}" data-id="${escapeHtml(c.id)}" data-action="contact">
          <div class="lr-id">
            <div class="avatar-lg" style="background: var(--contact-${tone})">${escapeHtml(firstChar(c.name))}</div>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(displayName(c))}</div>
            <div class="lr-meta">${escapeHtml(c.relationship || '联系人')}</div>
          </div>
          <div class="lr-side"><div class="time-chip muted">查看 →</div></div>
        </div>
      `}).join('')}` : ''}
    ${r.events.length > 0 ? `
      <div class="section-header"><h2>事件 (${r.events.length})</h2></div>
      ${r.events.map((e) => {
        const kind = eventKindAttr(e);
        return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}" data-action="event">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title)} <span class="tag" style="margin-left:6px">${escapeHtml(categoryTagLabel(e.category))}</span>${e.tag_kind ? ` <span class="tag">${escapeHtml(tagKindLabel(e.tag_kind))}</span>` : ''}</div>
            <div class="lr-meta">${escapeHtml(kindLabel(e.remind_kind))}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '-' + e.lunar_day : ''}</div>
          </div>
          <div class="lr-side"><div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.next_fire_at || e.remind_date))}</div></div>
        </div>
      `}).join('')}` : ''}
    ${memorial.length > 0 ? `
      <div class="section-header"><h2>回忆事件 (${memorial.length})</h2></div>
      ${memorial.map((e) => `
        <div class="card list-row clickable" data-kind="memorial" data-id="${escapeHtml(e.id)}" data-action="memorial">
          <div class="lr-id">
            <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(e.kind === 'first_time' ? '第一次' : '其他')}</span></div>
            <div class="lr-meta">回忆事件</div>
          </div>
          <div class="lr-side"><div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.occurred_at))}</div></div>
        </div>
      `).join('')}` : ''}
    ${r.important_dates.length > 0 ? `
      <div class="section-header"><h2>重要日期 (${r.important_dates.length})</h2></div>
      ${r.important_dates.map((d) => `
        <div class="card list-row" data-kind="important" data-id="${escapeHtml(d.contact_id)}" data-action="contact">
          <div class="lr-id">
            <span class="cat-icon" data-tone="important">🎂</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(d.label)}</div>
            <div class="lr-meta">${d.month}/${d.day}${d.year ? ' · ' + d.year + '年生' : ''} · 每年提醒</div>
          </div>
          <div class="lr-side"><div class="time-chip muted">查看 →</div></div>
        </div>
      `).join('')}` : ''}
  `;
  out.querySelectorAll('[data-action="contact"]').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  out.querySelectorAll('[data-action="event"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
  });
  out.querySelectorAll('[data-action="memorial"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id + '?category=memorial');
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

register('/search', render);