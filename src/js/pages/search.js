// src/js/pages/search.js
import { api, escapeHtml, firstChar, fmtDateTime } from '../api.js';
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
  out.innerHTML = `
    ${r.contacts.length === 0 && r.events.length === 0 && r.important_dates.length === 0
      ? `<div class="empty">没有匹配结果</div>`
      : ''}
    ${r.contacts.length > 0 ? `
      <div class="section-header"><h2>联系人 (${r.contacts.length})</h2></div>
      ${r.contacts.map((c) => `
        <div class="list-item" data-id="${escapeHtml(c.id)}" data-action="contact">
          <div class="row">
            <div class="avatar">${escapeHtml(firstChar(c.first_name))}</div>
            <div>
              <div><strong>${escapeHtml(displayName(c))}</strong></div>
              <div class="meta">${escapeHtml(c.company || c.job_position || '')}</div>
            </div>
          </div>
        </div>
      `).join('')}` : ''}
    ${r.events.length > 0 ? `
      <div class="section-header"><h2>事件 (${r.events.length})</h2></div>
      ${r.events.map((e) => `
        <div class="card clickable" data-id="${escapeHtml(e.id)}" data-action="event">
          <div><strong>${escapeHtml(e.title)}</strong></div>
          <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}</div>
        </div>
      `).join('')}` : ''}
    ${r.important_dates.length > 0 ? `
      <div class="section-header"><h2>重要日期 (${r.important_dates.length})</h2></div>
      ${r.important_dates.map((d) => `
        <div class="card" data-id="${escapeHtml(d.contact_id)}" data-action="contact">
          <div><strong>${escapeHtml(d.label)}</strong></div>
          <div class="meta">每年 ${d.month}/${d.day}${d.year ? '（' + d.year + '年生）' : ''}</div>
        </div>
      `).join('')}` : ''}
  `;
  out.querySelectorAll('[data-action="contact"]').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  out.querySelectorAll('[data-action="event"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id);
  });
}

function displayName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.nickname || '(无名)';
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

register('/search', render);