// src/js/pages/events_memorial.js — 回忆事件 list.
//
// Reads from `memorial_events` (independent of the reminder events table).
// Each row carries its own kind ('first_time' / 'other'), occurrence time,
// multi-contact list, and an optional thumbnail of the first uploaded photo.
import { api, escapeHtml, firstChar, displayName, fmtDateTime, formatRelative, categoryIcon, contactColorIndex, toast, memorialPhotoUrl, fetchPhotoDataUrl } from '../api.js';
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
  const opts = {};
  if (params.contact_id) opts.contact_id = params.contact_id;
  const events = await api.memorialEvents.list(opts);
  // Pre-warm the data-URL cache for every row that has a first photo so the
  // first paint shows the thumbnail without a second IPC round-trip.
  for (const e of events) {
    if (e.first_photo_id) fetchPhotoDataUrl(e.first_photo_id);
  }

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
          ? bulkSelectableRowHtml(rowInner(e), e.id, pageState.selectMode.selected.has(e.id), 'memorial')
          : renderRow(e)).join('')}
  `;

  if (!pageState.selectMode.active) {
    app.querySelectorAll('.card.clickable').forEach((el) => {
      el.onclick = () => navigate('/events/' + el.dataset.id + '?category=memorial');
    });
  }
  document.getElementById('new-event').onclick = () =>
    navigate('/events/new?category=memorial' + (params.contact_id ? '&contact_id=' + params.contact_id : ''));

  // Bulk-select mode wiring.
  if (pageState.selectMode.active) {
    const handlers = {
      onDelete: async (ids) => {
        const result = await api.memorialEvents.deleteMany(ids);
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

function kindTagLabel(kind) {
  return kind === 'first_time' ? '第一次' : '其他';
}

function contactSummary(e) {
  const names = (e.contact_names || []).filter(Boolean);
  if (names.length === 0) return '独立事件';
  if (names.length === 1) return names[0];
  return `${names[0]} 等 ${names.length} 人`;
}

function thumbHtml(e) {
  const url = memorialPhotoUrl(e.first_photo_id);
  if (!url) return '';
  return `<img class="thumb" src="${escapeHtml(url)}" alt="" loading="lazy"/>`;
}

function renderRow(e) {
  return `
    <div class="card list-row clickable" data-kind="memorial" data-id="${escapeHtml(e.id)}">
      ${memorialRowInner(e)}
    </div>
  `;
}

function rowInner(e) {
  return memorialRowInner(e);
}

// Shared body: left = category icon + multi-contact avatar stack,
// middle = title + meta line, right = photo thumbnail (when present) +
// date. The thumbnail is small (44px) so the date can sit below it.
function memorialRowInner(e) {
  const names = (e.contact_names || []).filter(Boolean);
  // The backend returns only names on the list endpoint — there's no per-name
  // id on the row. Hash the visible name string so the avatar tint is
  // stable and consistent with the contact-detail page for the same person.
  const avatarStackHtml = names.length
    ? `<span class="avatar-stack">${names.slice(0, 3).map((n) => {
        const tone = contactColorIndex(n);
        return `<span class="stack-av" style="background: var(--contact-${tone})" title="${escapeHtml(n)}">${escapeHtml(firstChar(n))}</span>`;
      }).join('')}${names.length > 3 ? `<span class="stack-more">+${names.length - 3}</span>` : ''}</span>`
    : '';
  const contactText = names.length === 0 ? '独立事件' : names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 人`;
  const metaParts = [contactText];
  if (e.photo_count > 0) metaParts.push(`${e.photo_count} 张照片`);
  return `
    <div class="lr-id">
      <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
      ${avatarStackHtml}
    </div>
    <div class="lr-main">
      <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(kindTagLabel(e.kind))}</span></div>
      <div class="lr-meta">${metaParts.map(escapeHtml).join(' · ')}</div>
    </div>
    <div class="lr-side">
      <div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.occurred_at))}</div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${e.photo_count > 0 ? `<span class="time-chip muted">${e.photo_count} 张</span>` : ''}
        ${thumbHtml(e)}
      </div>
    </div>
  `;
}

register('/events/memorial', render);