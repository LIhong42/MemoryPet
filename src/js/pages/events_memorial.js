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

  // 类别内搜索：仅在回忆事件列表内筛选。不发起新的 IPC，而是在已载入的
  // `events` 上做客户端过滤 —— 服务端 SQL 里事件本身的字段（title/description
  // 之类）已经是 SELECT *，但 contact_names 是渲染前一次性 join 的内存字段，
  // 所以服务端 LIKE 反而拿不到关联人名。客户端匹配可以同时覆盖这两类。
  const q = ((params && params.q) || '').trim().toLowerCase();
  const filtered = q ? events.filter((e) => matchesMemorialQuery(e, q)) : events;
  const suppressed = events.length - filtered.length;

  app.innerHTML = `
    <div class="row between">
      <h1>回忆事件 ${!pageState.selectMode.active && filtered.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <div class="row" style="gap:8px;">
        ${filtered.length > 0
          ? `<button class="btn secondary" id="open-export">导出回忆</button>`
          : ''}
        <button class="btn" id="new-event">+ 新建</button>
      </div>
    </div>
    <div class="page-search">
      <input type="search" id="memorial-q" placeholder="在回忆事件中搜索…" autocomplete="off" />
      ${q ? `<button class="btn secondary" id="memorial-clear" type="button">清除</button>` : ''}
      ${q ? `<span class="meta">${filtered.length} / ${events.length} 条匹配</span>` : ''}
    </div>
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: filtered.length,
        kindLabel: '个回忆事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有回忆事件 · 点 + 新建 创建一个</div>`
      : filtered.length === 0
        ? `<div class="empty">没有匹配「${escapeHtml(q)}」的回忆事件 · 已隐藏 ${suppressed} 条</div>`
        : filtered.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e), e.id, pageState.selectMode.selected.has(e.id), 'memorial')
            : renderRow(e)).join('')}
  `;

  // Mirror URL → input. Only update when the URL actually has a different
  // value, otherwise we'd steal the caret mid-IME composition.
  const input = document.getElementById('memorial-q');
  if (input && input.value !== q) input.value = q;
  wirePageSearch({
    input,
    inputId: 'memorial-q',
    clearId: 'memorial-clear',
    basePath: '/events/memorial' + (params.contact_id ? '?contact_id=' + encodeURIComponent(params.contact_id) : ''),
    q,
  });

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

  // "导出回忆" lives inside the memorial-events page so the topbar nav
  // stays untouched. The /export route is still registered globally; we
  // just enter it from here.
  const exportBtn = document.getElementById('open-export');
  if (exportBtn) exportBtn.onclick = () => navigate('/export');

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
        total: filtered.length,
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

// Local search predicate for memorial events. We deliberately match across
// every user-visible field so a typed query feels "find what I see": title,
// description, place, food, outfit, activities, notes, and the names of any
// linked contacts. All comparisons are case-insensitive substring matches;
// there's no stemming or token-splitting — the list is small enough that
// fuzzy matching would feel surprising rather than helpful.
function matchesMemorialQuery(e, q) {
  if (!q) return true;
  const fields = [e.title, e.description, e.place, e.food, e.outfit, e.activities, e.notes];
  for (const f of fields) {
    if (typeof f === 'string' && f.toLowerCase().includes(q)) return true;
  }
  const names = (e.contact_names || []).filter(Boolean);
  for (const n of names) {
    if (n.toLowerCase().includes(q)) return true;
  }
  return false;
}

// Wire the search input on the memorial page: URL <-> input sync, IME-safe
// flushing (deferred through rAF + 120ms idle settle), clear button. The
// input element survives across renders — we only attach handlers once,
// guarded by a `data-wired` flag. `basePath` is the destination URL minus
// the `q=...` segment.
function wirePageSearch({ input, inputId, clearId, basePath, q }) {
  if (!input) return;
  if (!input.dataset.wired) {
    input.dataset.wired = '1';
    let pendingValue = null;
    let scheduled = false;
    let settleTimer = null;
    const flush = () => {
      scheduled = false;
      settleTimer = null;
      const v = pendingValue;
      pendingValue = null;
      if (v === null) return;
      const trimmed = v.trim();
      const target = trimmed
        ? basePath + (basePath.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(trimmed)
        : basePath;
      const current = (location.hash || '').replace(/^#/, '');
      if (current === target) return;
      navigate(target);
    };
    const schedule = (v) => {
      pendingValue = v;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(flush, 120);
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    };
    input.addEventListener('input', () => schedule(input.value));
    // IME composition boundary — flush immediately on candidate confirm or
    // cancel so the user doesn't wait the full 120ms.
    input.addEventListener('compositionend', () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      pendingValue = input.value;
      flush();
    });
  }
  const clearBtn = document.getElementById(clearId);
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (input.value) input.value = '';
      navigate(basePath);
    };
  }
  // Refocus the input after a render so users can keep typing without an
  // extra click. Skip if focus already lives elsewhere (e.g. the user just
  // tabbed into a row).
  if (q && input !== document.activeElement) input.focus();
}

register('/events/memorial', render);