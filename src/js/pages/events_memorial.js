// src/js/pages/events_memorial.js — 回忆事件 list.
//
// Reads from `memorial_events` (independent of the reminder events table).
// Each row carries its own kind ('first_time' / 'other'), occurrence time,
// multi-contact list, and an optional thumbnail of the first uploaded photo.
import { api, escapeHtml, categoryIcon, memorialPhotoUrl, fetchPhotoDataUrl } from '../api.js';
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
  // Pre-warm the data-URL cache for every photo shown on the list page (up
  // to two thumbnails per row) so the first paint doesn't flash empty img
  // boxes before the IPC round-trip resolves.
  for (const e of events) {
    if (e.first_photo_id) fetchPhotoDataUrl(e.first_photo_id);
    if (e.second_photo_id) fetchPhotoDataUrl(e.second_photo_id);
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

  // Swap in the real data URLs once the IPC round-trip resolves. The render
  // pass above only writes an `src=""` placeholder because `memorialPhotoUrl`
  // is synchronous-only; without this follow-up the browser would mark the
  // thumbnail as broken and only show the image on the NEXT render (e.g.
  // after opening + closing the detail page). The `data-photo-id` attribute
  // is the join key — same pattern as event_edit.js.
  for (const e of events) {
    for (const id of [e.first_photo_id, e.second_photo_id]) {
      if (!id) continue;
      fetchPhotoDataUrl(id).then((url) => {
        if (!url) return;
        app.querySelectorAll(`img[data-photo-id="${CSS.escape(id)}"]`).forEach((imgEl) => {
          if (imgEl.src !== url) imgEl.src = url;
        });
      });
    }
  }

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
      // Sync every row checkbox with the current Set — otherwise hitting
      // "全选" in the toolbar only updates the counter; the per-row boxes
      // stay empty because they were rendered once at enter-time.
      app.querySelectorAll('.bulk-row-check').forEach((cb) => {
        const id = cb.dataset.bulkId;
        if (!id) return;
        cb.checked = pageState.selectMode.selected.has(id);
      });
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

// YYYY-MM-DD (no minutes). `formatRelative` is built for "when does the next
// reminder fire" so it always tags the time-of-day — useless here, since
// memorial events are anchored to a date, not an instant.
function formatDateOnly(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function contactSummary(e) {
  const names = (e.contact_names || []).filter(Boolean);
  if (names.length === 0) return '独立事件';
  if (names.length === 1) return names[0];
  return `${names[0]} 等 ${names.length} 人`;
}

// Render up to two small thumbnails side-by-side. The list endpoint now
// returns both `first_photo_id` and `second_photo_id` so we don't need a
// second round-trip per row. Each <img> carries a `data-photo-id` join key
// so the post-render swap loop can find and update it once the data URL
// resolves.
function thumbsHtml(e) {
  const ids = [e.first_photo_id, e.second_photo_id].filter(Boolean).slice(0, 2);
  if (ids.length === 0) return '';
  const more = e.photo_count > ids.length ? `<span class="thumb-more">+${e.photo_count - ids.length}</span>` : '';
  const imgs = ids.map((id) => {
    const url = memorialPhotoUrl(id);
    return `<img class="thumb" src="${escapeHtml(url)}" data-photo-id="${escapeHtml(id)}" alt="" loading="lazy"/>`;
  }).join('');
  return `<span class="thumb-stack">${imgs}${more}</span>`;
}

function renderRow(e) {
  return `
    <div class="card list-row clickable memorial-row" data-kind="memorial" data-id="${escapeHtml(e.id)}">
      ${memorialRowInner(e)}
    </div>
  `;
}

function rowInner(e) {
  return memorialRowInner(e);
}

// New layout (2026-10-07):
//   column 1: title (with kind tag)
//   column 2: contact names (same font size as the title) + relative time
//             on the same line
//   column 3: up to two photo thumbnails
//
// The user wanted the title to lead, the contacts to follow, and the photos
// to anchor the right edge. The avatar-stack was removed here — the title
// block already carries the category glyph, so a second avatar in front of
// the contact names just made the row feel busy.
function memorialRowInner(e) {
  const names = (e.contact_names || []).filter(Boolean);
  const contactText = contactSummary(e);
  return `
    <div class="mr-title">
      <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
      <span class="lr-title">${escapeHtml(e.title || '(无标题)')}</span>
      <span class="tag">${escapeHtml(kindTagLabel(e.kind))}</span>
    </div>
    <div class="mr-mid">
      <span class="contact-text">${escapeHtml(contactText)}</span>
      <span class="contact-time"><span class="chip-dot"></span>${escapeHtml(formatDateOnly(e.occurred_at))}</span>
    </div>
    <div class="mr-thumbs">
      ${thumbsHtml(e)}
    </div>
  `;
}

register('/events/memorial', render);