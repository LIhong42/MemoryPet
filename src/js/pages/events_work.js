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

  // 类别内搜索：只过滤工作事件列表。本地筛选覆盖 title/description 和关
  // 联联系人的显示名，避免再发一次 IPC。
  const q = ((params && params.q) || '').trim().toLowerCase();
  const filtered = q ? events.filter((e) => matchesWorkQuery(e, cById, q)) : events;
  const suppressed = events.length - filtered.length;

  app.innerHTML = `
    <div class="row between">
      <h1>工作事件 ${!pageState.selectMode.active && filtered.length > 0 ? bulkEnterLinkHtml() : ''}</h1>
      <button class="btn" id="new-event">+ 新建</button>
    </div>
    <div class="page-search">
      <input type="search" id="work-q" placeholder="在工作事件中搜索…" autocomplete="off" />
      ${q ? `<button class="btn secondary" id="work-clear" type="button">清除</button>` : ''}
      ${q ? `<span class="meta">${filtered.length} / ${events.length} 条匹配</span>` : ''}
    </div>
    ${pageState.selectMode.active ? bulkToolbarHtml({
        count: pageState.selectMode.selected.size,
        total: filtered.length,
        kindLabel: '个工作事件',
      }) : ''}
    ${events.length === 0
      ? `<div class="empty">还没有工作事件 · 点 + 新建 创建一个</div>`
      : filtered.length === 0
        ? `<div class="empty">没有匹配「${escapeHtml(q)}」的工作事件 · 已隐藏 ${suppressed} 条</div>`
        : filtered.map((e) => pageState.selectMode.active
            ? bulkSelectableRowHtml(rowInner(e, cById), e.id, pageState.selectMode.selected.has(e.id), 'work')
            : renderRow(e, cById)).join('')}
  `;

  // Mirror URL → input + wire IME-safe flush. Same logic as the memorial
  // page — lives here as an independent copy because each page owns its
  // own input element (and `data-wired` guards against double-binding).
  const input = document.getElementById('work-q');
  if (input && input.value !== q) input.value = q;
  wireWorkPageSearch({
    input,
    inputId: 'work-q',
    clearId: 'work-clear',
    basePath: '/events/work',
    q,
  });

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
  // 工作事件没有关联联系人，标题总是被服务端默认为「新建提醒」。
  // 直接展示 description（即用户填写的具体工作内容）作为主行，标题
  // 退化为没有 description 时的兜底。
  const desc = (e.description || '').trim();
  const mainLine = desc || e.title || '(无描述)';
  return `
    <div class="lr-id">
      <span class="cat-icon" data-tone="work">${escapeHtml(categoryIcon('work', e.tag_kind))}</span>
      ${contact ? `<span class="stack-av" style="background: var(--contact-${contactTone})" title="${escapeHtml(contactName)}">${escapeHtml(firstChar(contact.name))}</span>` : ''}
    </div>
    <div class="lr-main">
      <div class="lr-title">${escapeHtml(mainLine)}</div>
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

// Local search predicate for work events. Work events have far fewer
// user-visible fields than memorial events — the row's primary text is
// `description`, with `title` as a fallback and `contact.name` for the
// linked contact. We substring-match across all three so a query like
// "周报" hits the description; "张三" hits the linked contact.
function matchesWorkQuery(e, cById, q) {
  if (!q) return true;
  const fields = [e.title, e.description];
  for (const f of fields) {
    if (typeof f === 'string' && f.toLowerCase().includes(q)) return true;
  }
  if (e.contact_id && cById && cById[e.contact_id]) {
    const name = cById[e.contact_id].name || '';
    if (typeof name === 'string' && name.toLowerCase().includes(q)) return true;
  }
  return false;
}

// Wire the work-page search input. Independent copy of the memorial page's
// helper because each page owns a separate DOM node — sharing a single
// utility would force the page files to coordinate via a shared module, and
// the bodies are short enough that duplicating keeps each page self-contained.
// IME composition (中文/微软拼音/百度输入法等的候选词输入) is handled by
// debouncing through rAF + a 120ms idle settle, plus an immediate flush at
// the compositionend boundary.
function wireWorkPageSearch({ input, inputId, clearId, basePath, q }) {
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
  if (q && input !== document.activeElement) input.focus();
}

register('/events/work', render);
