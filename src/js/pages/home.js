// src/js/pages/home.js — Home page
import { api, escapeHtml, firstChar, fmtDate, fmtDateTime } from '../api.js';
import { register, navigate } from '../router.js';

export async function render(_args, _params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  let contacts = [];
  let todayEvents = [];
  let activeReminders = [];
  try {
    [contacts, todayEvents, activeReminders] = await Promise.all([
      api.contacts.list(),
      api.events.listToday(),
      api.reminders.listActive(),
    ]);
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${e.message || e}</div>`;
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <h1>首页</h1>
    <div class="section-header"><h2>当前提醒</h2></div>
    ${
        activeReminders.length === 0
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
          `).join('')
      }

    <div class="section-header">
      <h2>今日事件（${todayStr}）</h2>
      <a class="inline-link" href="#/events">查看全部</a>
    </div>
    ${
      todayEvents.length === 0
        ? `<div class="empty">今天没有安排</div>`
        : todayEvents.map((e) => `
          <div class="card clickable" data-id="${escapeHtml(e.id)}" data-action="event">
            <div class="row between">
              <div>
                <div><strong>${escapeHtml(e.title)}</strong></div>
                <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}</div>
              </div>
            </div>
          </div>
        `).join('')
      }

    <div class="section-header">
      <h2>最近联系人</h2>
      <a class="inline-link" href="#/contacts">查看全部</a>
    </div>
    ${
      contacts.length === 0
        ? `<div class="empty">还没有联系人 · <a class="inline-link" href="#/contacts/new">添加一个</a></div>`
        : contacts.slice(0, 5).map((c) => `
          <div class="list-item" data-id="${escapeHtml(c.id)}" data-action="contact">
            <div class="row">
              <div class="avatar">${escapeHtml(firstChar(c.first_name))}</div>
              <div>
                <div><strong>${escapeHtml(displayName(c))}</strong></div>
                <div class="meta">${escapeHtml(c.company || c.job_position || '')}</div>
              </div>
            </div>
          </div>
        `).join('')
      }
  `;

  app.querySelectorAll('[data-action="contact"]').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  app.querySelectorAll('[data-action="event"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id);
  });
  app.querySelectorAll('[data-action="reminder"]').forEach((el) => {
    el.onclick = () => {
      window.dispatchEvent(new CustomEvent('open-reminder', {
        detail: { source: el.dataset.source, source_id: el.dataset.id }
      }));
    };
  });
}

function displayName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.nickname || '(无名)';
}

function kindLabel(k) {
  return ({ one_time: '天', daily: '天', monthly: '月', yearly: '年', none: '不提醒' }[k]) || k || '';
}

register('/', render);