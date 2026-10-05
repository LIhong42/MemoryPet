// src/js/pages/events_work.js — 工作事件 list (category='work')
import { api, escapeHtml, firstChar, displayName, fmtDateTime, formatRelative, countdownTo, categoryIcon, contactColorIndex, toast } from '../api.js';
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
  const opts = { category: 'work' };
  if (params.contact_id) opts.contact_id = params.contact_id;
  const [events, contacts] = await Promise.all([
    api.events.list(opts),
    api.contacts.list(),
  ]);
  const cById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  app.innerHTML = `
    <div class="row between">
      <h1>工作事件 ${!pageState.selectMode.active && events.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <button class="btn" id="new-event">+ 新建</button>
    </div>
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: events.length,
        kindLabel: '个工作事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有工作事件 · 点 + 新建 创建一个</div>`
      : events.map((e) => pageState.selectMode.active
          ? bulkSelectableRowHtml(rowInner(e, cById), e.id, pageState.selectMode.selected.has(e.id), 'work')
          : renderRow(e, cById)).join('')}
  `;

  if (!pageState.selectMode.active) {
    app.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/events/' + el.dataset.id + '?category=work');
    });
  }
  document.getElementById('new-event').onclick = () => navigate('/events/new?category=work');

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
        kindLabel: '个工作事件',
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
    <div class="card list-row clickable" data-kind="work" data-id="${escapeHtml(e.id)}">
      ${workRowInner(e, cById)}
    </div>
  `;
}

function rowInner(e, cById) {
  return workRowInner(e, cById);
}

// Shared body for both idle renderRow (wrapped in a .card) and bulk-select
// rowInner (wrapped in .bulk-row). The bulk-row caller prepends a checkbox;
// the body itself is the same three-column grid for both modes.
function workRowInner(e, cById) {
  const contact = e.contact_id && cById && cById[e.contact_id] ? cById[e.contact_id] : null;
  const contactName = contact ? displayName(contact) : '';
  const contactTone = contact ? contactColorIndex(contact.name) : 0;
  const metaParts = [kindLabel(e.remind_kind)];
  if (e.lunar_month && e.lunar_day) metaParts.push(`农历 ${e.lunar_month}-${e.lunar_day}`);
  if (contact) metaParts.push(escapeHtml(contactName));
  if (!e.active) metaParts.push('已结束');
  const meta = metaParts.join(' · ');
  const target = e.next_fire_at || e.remind_date;
  const rel = formatRelative(target);
  const cd  = countdownTo(target);
  return `
    <div class="lr-id">
      <span class="cat-icon" data-tone="work">${escapeHtml(categoryIcon('work', e.tag_kind))}</span>
      ${contact ? `<span class="stack-av" style="background: var(--contact-${contactTone})" title="${escapeHtml(contactName)}">${escapeHtml(firstChar(contact.name))}</span>` : ''}
    </div>
    <div class="lr-main">
      <div class="lr-title">${escapeHtml(e.title || '(无标题)')}</div>
      <div class="lr-meta">${meta}</div>
    </div>
    <div class="lr-side">
      <div class="time-chip ${cd ? 'urgent' : ''}"><span class="chip-dot"></span>${escapeHtml(rel)}</div>
      ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
    </div>
  `;
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

register('/events/work', render);
