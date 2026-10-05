// src/js/pages/events_memorial.js — 回忆事件 list (category='memorial')
import { api, escapeHtml, displayName, fmtDateTime, toast } from '../api.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';

// selectMode is per-page state so toggling bulk-delete mode doesn't lose
// the user's checkbox selections on re-render.
const pageState = { selectMode: { active: false, selected: new Set() } };

async function render(args, params) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const opts = { category: 'memorial' };
  if (params.contact_id) opts.contact_id = params.contact_id;
  const [events, contacts] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
  ]);
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  app.innerHTML = `
    <div class="row between">
      <h1>回忆事件 ${!pageState.selectMode.active && events.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <button class="btn" id="new-event">+ 新建</button>
    </div>
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: events.length,
        kindLabel: '个回忆事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有回忆事件 · 点 + 新建 创建一个</div>`
      : events.map((e) => pageState.selectMode.active
          ? bulkSelectableRowHtml(rowInner(e, cById), e.id, pageState.selectMode.selected.has(e.id))
          : renderRow(e, cById)).join('')}
  `;

  if (!pageState.selectMode.active) {
    app.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/events/' + el.dataset.id);
    });
  }
  document.getElementById('new-event').onclick = () => navigate('/events/new?category=memorial');

  // Bulk-select mode wiring.
  if (pageState.selectMode.active) {
    const handlers = {
      onDelete: async (ids) => {
        const result = await api.events.deleteMany(ids);
        render(args, params);
        return result;
      },
      onExit: () => {
        pageState.selectMode.active = false;
        pageState.selectMode.selected = new Set();
        render(args, params);
      },
    };
    pageState.selectMode.onChange = () => {
      const t = app.querySelector('[data-bulk-toolbar]');
      if (!t) return;
      t.outerHTML = bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: events.length,
        kindLabel: '个回忆事件',
      });
      wireBulkToolbar(app, pageState.selectMode, handlers);
    };
    wireBulkRowChecks(app, pageState.selectMode);
    wireBulkToolbar(app, pageState.selectMode, handlers);
  }
  wireBulkEnter(app, () => {
    pageState.selectMode.active = true;
    pageState.selectMode.selected = new Set();
    render(args, params);
  });
}

function renderRow(e, cById) {
  return `
    <div class="card clickable" data-id="${escapeHtml(e.id)}">
      <div class="row between">
        <div>
          <div><strong>${escapeHtml(e.title)}</strong>${e.tag_kind ? ` <span class="tag">${tagKindLabel(e.tag_kind)}</span>` : ''}</div>
          <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '月' + e.lunar_day + '日' : ''}${e.contact_id && cById[e.contact_id] ? ' · ' + escapeHtml(displayName(cById[e.contact_id])) : ''}${e.active ? '' : ' · 已结束'}</div>
        </div>
        <div>${e.remind ? '<span class="tag">提醒</span>' : ''}</div>
      </div>
    </div>
  `;
}

function rowInner(e, cById) {
  return `
    <div class="row between">
      <div>
        <div><strong>${escapeHtml(e.title)}</strong>${e.tag_kind ? ` <span class="tag">${tagKindLabel(e.tag_kind)}</span>` : ''}</div>
        <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '月' + e.lunar_day + '日' : ''}${e.contact_id && cById[e.contact_id] ? ' · ' + escapeHtml(displayName(cById[e.contact_id])) : ''}${e.active ? '' : ' · 已结束'}</div>
      </div>
      <div>${e.remind ? '<span class="tag">提醒</span>' : ''}</div>
    </div>
  `;
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

register('/events/memorial', render);
