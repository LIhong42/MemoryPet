// src/js/pages/contact_detail.js — view a single contact + their dates + events
import { api, escapeHtml, firstChar, displayName, eventKindAttr, contactColorIndex, fmtDate, fmtDateTime, formatRelative, countdownTo, categoryIcon, toast } from '../api.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml,
  wireBulkEnter, wireBulkToolbar,
} from '../bulk_delete.js';

// --- List section with search + event filter + pagination -----------------
//
// Each of the likes / taboos / gifts sections behaves identically:
//   * Header with title + count badge, plus a "管理 →" link that opens the
//     per-section edit page (#/contacts/:id/:kind)
//   * Two independent filters:
//       - "section-search"    : keyword in `description` (case-insensitive)
//       - "section-event-filter": dropdown over distinct years/months observed
//         in the items' `event` values. Adds "不限" and "未填事件" entries.
//     They compose: search ∩ eventFilter, in either order; both empty = all.
//   * Search hits are surfaced in (event date desc, original order) so
//     recent events rise to the top.
//   * When the visible result set exceeds PAGE_SIZE, pagination controls
//     (上一页 / 第 X / Y 页 / 下一页) appear under the list.

const PAGE_SIZE = 5;

// Internal short kind ("like" / "taboo" / "gift") ↔ URL long kind
// ("likes" / "taboos" / "gifts"). The contact-detail UI talks in the short
// form; sub-page routes use the long form.
const kindMap = { like: 'likes', taboo: 'taboos', gift: 'gifts' };
const kindTitle = { like: '喜好', taboo: '忌讳', gift: '礼物参考' };

// Pure filter on description — case-insensitive substring match. Empty
// query means "do not filter by description".
function matchesQuery(item, q) {
  if (!q) return true;
  const desc = (item && item.description) || '';
  return desc.toLowerCase().includes(q);
}

// Pure filter on event date. `filterValue` is one of:
//   ''           — do not filter by event (show everything)
//   '__none__'   — show only items without an event
//   'YYYY'       — show items whose event starts with YYYY
//   'YYYY-MM'    — show items whose event starts with YYYY-MM
function matchesEvent(item, filterValue) {
  if (!filterValue) return true;
  const ev = (item && item.event) || '';
  if (filterValue === '__none__') return !ev;
  return ev.startsWith(filterValue);
}

// Build the dropdown options from the items currently visible. Includes
// "不限" + "未填事件" + every distinct (year, year-month) tuple observed,
// sorted descending so most-recent years/months appear first.
function buildEventFilterOptions(items) {
  const yearMonths = new Map(); // year → Set of "MM"
  for (const it of items || []) {
    const ev = it && it.event;
    if (!ev) continue;
    const m = /^(\d{4})(?:-(\d{2}))?/.exec(ev);
    if (!m) continue;
    const y = m[1];
    if (!yearMonths.has(y)) yearMonths.set(y, new Set());
    if (m[2]) yearMonths.get(y).add(m[2]);
  }
  const years = [...yearMonths.keys()].sort().reverse();
  const opts = [{ value: '', label: '不限' }, { value: '__none__', label: '未填事件' }];
  for (const y of years) {
    opts.push({ value: y, label: y + ' 年（全部月份）' });
    const months = [...yearMonths.get(y)].sort().reverse();
    for (const mo of months) opts.push({ value: `${y}-${mo}`, label: `${y}-${mo}` });
  }
  return opts;
}

function matchesEither(item, q, evFilter) {
  return matchesQuery(item, q) && matchesEvent(item, evFilter);
}

// Sort helper: items with an event come first by date desc, then items
// without an event retain their original order at the tail.
function sortByEventDesc(items) {
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => {
    const ea = a.it.event || '';
    const eb = b.it.event || '';
    if (ea && !eb) return -1;
    if (!ea && eb) return 1;
    if (ea && eb) {
      if (ea < eb) return 1;
      if (ea > eb) return -1;
    }
    return a.i - b.i;
  });
  return indexed.map((x) => x.it);
}

function renderItemRow(it) {
  return `
    <div class="row between">
      <div>
        <div>${escapeHtml(it.description || '')}</div>
        ${it.event ? `<div class="meta">${escapeHtml(fmtDate(it.event))}</div>` : ''}
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="icon-btn section-edit" data-id="${escapeHtml(it.id)}" title="编辑">✎</button>
        <button type="button" class="icon-btn section-del"  data-id="${escapeHtml(it.id)}" title="删除">✕</button>
      </div>
    </div>
  `;
}

// Inline editor row replacing a row when its id matches `state.editingId`.
// Description + event inputs; Save calls api.attributes.update; Cancel
// just clears the editing id and re-renders.
function renderEditRow(it) {
  return `
    <div class="row between">
      <div style="flex:1">
        <input type="text" class="section-edit-desc" value="${escapeHtml(it.description || '')}" autofocus/>
        <input type="date" class="section-edit-event" value="${escapeHtml(it.event || '')}" style="margin-top:4px"/>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn section-edit-save" data-id="${escapeHtml(it.id)}">保存</button>
        <button type="button" class="btn secondary section-edit-cancel">取消</button>
      </div>
    </div>
  `;
}

function renderPager(state, totalPages) {
  if (totalPages <= 1) return '';
  const cur = state.page + 1; // 1-based for display
  const prevDisabled = state.page <= 0;
  const nextDisabled = state.page >= totalPages - 1;
  return `
    <div class="row between" style="margin-top:8px">
      <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(state.kind)}" data-action="prev" ${prevDisabled ? 'disabled' : ''}>← 上一页</button>
      <div class="meta">第 ${cur} / ${totalPages} 页</div>
      <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(state.kind)}" data-action="next" ${nextDisabled ? 'disabled' : ''}>下一页 →</button>
    </div>
  `;
}

function renderListSection(title, items, state, kind, c) {
  const all = items || [];
  const q = state.query.trim().toLowerCase();

  // Apply description search and event filter independently; both must match.
  const filtered = all.filter((it) => matchesEither(it, q, state.eventFilter));
  // When *something* filters, surface date-anchored items first.
  const ordered = (q || state.eventFilter) ? sortByEventDesc(filtered) : filtered;

  // Clamp page into the new bounds (handles e.g. deleting a row on the last page).
  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  const start = state.page * PAGE_SIZE;
  const visible = ordered.slice(start, start + PAGE_SIZE);

  const filtersActive = !!(q || state.eventFilter);
  const selectActive = !!state.selectModeActive;
  // When a row is being inline-edited, render the edit form in place of its
  // normal row. All other rows render as before. In bulk-select mode we
  // additionally prefix each row with a checkbox.
  const rowsHtml = visible.map((it) => {
    const inner = state.editingId === it.id ? renderEditRow(it) : renderItemRow(it);
    if (selectActive) {
      return `
        <div class="row" style="gap:10px; padding:6px 0;">
          <input type="checkbox" class="section-bulk-check" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(it.id)}" ${state.selected.has(it.id) ? 'checked' : ''}/>
          <div style="flex:1; min-width:0;">${inner}</div>
        </div>
      `;
    }
    return inner;
  }).join('');
  const listHtml = visible.length
    ? `<div class="card" data-kind="${escapeHtml(kind)}">${rowsHtml}</div>`
    : (filtersActive
        ? `<div class="empty">没有匹配的${title}</div>`
        : `<div class="empty">还没有${title}</div>`);

  const countBadge = all.length ? `<span class="meta">${all.length}</span>` : '';
  const searchInput = `
    <input type="text" class="section-search" data-kind="${escapeHtml(kind)}"
           placeholder="搜索描述…" value="${escapeHtml(state.query)}"/>
  `;
  const opts = buildEventFilterOptions(all);
  const eventFilterHtml = `
    <select class="section-event-filter" data-kind="${escapeHtml(kind)}">
      ${opts.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === state.eventFilter ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
    </select>
  `;
  // In idle mode the right side of the header carries a "管理 →" link
  // (per-section manage page) PLUS a "批量删除" link when there's at least
  // one row to pick from. In select mode the header just shows the count
  // badge — the toolbar below takes over the action area.
  const editLink = c && !selectActive
    ? `<a class="inline-link section-manage" href="#/contacts/${escapeHtml(c.id)}/${escapeHtml(kindMap[kind])}">管理 →</a>`
    : '';
  const enterBulkLink = (!selectActive && ordered.length > 0 && c)
    ? bulkEnterLinkHtml().replace('data-bulk-enter', `data-bulk-enter data-kind="${escapeHtml(kind)}"`)
    : '';

  const matchFooter = filtersActive
    ? `<div class="meta" style="padding:6px 0">匹配 ${ordered.length} 条${q ? ' · 关键词：' + escapeHtml(state.query) : ''}${state.eventFilter ? ' · 事件：' + escapeHtml(state.eventFilter === '__none__' ? '未填事件' : state.eventFilter) : ''}</div>`
    : '';

  const toolbarHtml = selectActive ? bulkToolbarHtml({
    count: state.selected.size,
    total: ordered.length,
    kindLabel: '条' + title,
  }) : '';

  return `
    <div class="section-header">
      <h2>${title} ${countBadge} ${enterBulkLink}</h2>
      ${editLink}
    </div>
    <div class="filter-row">
      ${searchInput}
      ${eventFilterHtml}
    </div>
    ${toolbarHtml}
    ${listHtml}
    ${matchFooter}
    ${renderPager(state, totalPages)}
  `;
}

async function render(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const c = await api.contacts.get(args.id);
  const [dates, events, memorial, likes, taboos, gifts] = await Promise.all([
    api.importantDates.list(args.id),
    api.events.list({ contact_id: args.id }),
    api.memorialEvents.list({ contact_id: args.id }),
    api.attributes.list('like',  { contact_id: args.id }),
    api.attributes.list('taboo', { contact_id: args.id }),
    api.attributes.list('gift',  { contact_id: args.id }),
  ]);
  // Per-kind item list, sourced from the new contact_attributes table.
  // `id` is the contact's own id (used for refresh after a per-item mutation).
  const itemsByKind = {
    like:  likes,
    taboo: taboos,
    gift:  gifts,
  };

  // Per-section UI state. Owned by this render() invocation; the inputs
  // and pager buttons read/mutate this directly via closures.
  //
  // selectModeActive + selected drive the bulk-delete UI. `selected` is a
  // Set<id> so toggling a checkbox is O(1) and the count shown in the
  // toolbar is always in sync.
  const sectionState = {
    like:  { kind: 'like',  query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
    taboo: { kind: 'taboo', query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
    gift:  { kind: 'gift',  query: '', eventFilter: '', page: 0, editingId: null,
             selectModeActive: false, selected: new Set() },
  };

  // Refresh a single kind's items from the API and re-render only that
  // section. Avoids a full-page re-render after a row edit/delete.
  async function refreshKind(kind) {
    const attrKind = kind;
    itemsByKind[kind] = await api.attributes.list(attrKind, { contact_id: args.id });
    const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
    if (!host) return;
    host.innerHTML = renderListSection(kindTitle[kind], itemsByKind[kind], sectionState[kind], kind, c);
    wireSection(kind);
  }

  function rerenderSections() {
    for (const kind of ['like', 'taboo', 'gift']) {
      const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
      if (!host) continue;
      host.innerHTML = renderListSection(kindTitle[kind], itemsByKind[kind], sectionState[kind], kind, c);
      wireSection(kind);
    }
  }

  function wireSection(kind) {
    const input = document.querySelector(`.section-search[data-kind="${kind}"]`);
    if (input) {
      input.oninput = (e) => {
        sectionState[kind].query = e.target.value;
        sectionState[kind].page = 0; // reset to first page on new filter
        rerenderSections();
        const fresh = document.querySelector(`.section-search[data-kind="${kind}"]`);
        if (fresh) {
          fresh.focus();
          const v = fresh.value;
          fresh.setSelectionRange(v.length, v.length);
        }
      };
    }
    const select = document.querySelector(`.section-event-filter[data-kind="${kind}"]`);
    if (select) {
      select.onchange = (e) => {
        sectionState[kind].eventFilter = e.target.value;
        sectionState[kind].page = 0;
        rerenderSections();
      };
    }
    document.querySelectorAll(`.section-page[data-kind="${kind}"]`).forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'prev') sectionState[kind].page = Math.max(0, sectionState[kind].page - 1);
        if (action === 'next') sectionState[kind].page = sectionState[kind].page + 1;
        rerenderSections();
      };
    });
    document.querySelectorAll(`.section-edit[data-kind="${kind}"]`).forEach((btn) => {
      btn.onclick = () => {
        sectionState[kind].editingId = btn.dataset.id;
        sectionState[kind].page = 0; // jump to the row being edited
        rerenderSections();
        const fresh = document.querySelector(`.section-edit-desc`);
        if (fresh) fresh.focus();
      };
    });
    document.querySelectorAll(`.section-del[data-kind="${kind}"]`).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('确认删除该条目？')) return;
        try {
          await api.attributes.delete(btn.dataset.id);
          toast('已删除');
        } catch (e) {
          toast('删除失败：' + (e.message || e));
          return;
        }
        sectionState[kind].editingId = null;
        await refreshKind(kind);
      };
    });
    document.querySelectorAll(`.section-edit-save`).forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const card = btn.closest('.card');
        if (!card) return;
        const desc = card.querySelector('.section-edit-desc');
        const ev = card.querySelector('.section-edit-event');
        const description = desc ? desc.value.trim() : '';
        if (!description) { toast('请填写描述'); if (desc) desc.focus(); return; }
        const event = ev ? ev.value : '';
        try {
          await api.attributes.update(id, { description, event });
          toast('已保存');
        } catch (e) {
          toast('保存失败：' + (e.message || e));
          return;
        }
        sectionState[kind].editingId = null;
        await refreshKind(kind);
      };
    });
    document.querySelectorAll(`.section-edit-cancel`).forEach((btn) => {
      btn.onclick = () => {
        sectionState[kind].editingId = null;
        rerenderSections();
      };
    });
    // Bulk-select wiring (per-kind). Activated by the "批量删除" link in
    // the section header; toggled off by the toolbar's "退出选择" button.
    // We use a local Set state.selected, mutated by checkbox flips and
    // cleared on exit / delete-confirmed.
    const enterLink = document.querySelector(`.list-host[data-kind="${kind}"] [data-bulk-enter][data-kind="${kind}"]`);
    if (enterLink) {
      enterLink.onclick = (e) => {
        e.preventDefault();
        sectionState[kind].selectModeActive = true;
        sectionState[kind].selected = new Set();
        rerenderSections();
      };
    }
    if (sectionState[kind].selectModeActive) {
      const host = document.querySelector(`.list-host[data-kind="${kind}"]`);
      // Per-row checkbox flips — keep the Set in sync, then refresh the
      // toolbar count without rebuilding the whole list (which would
      // steal the user's focus).
      host.querySelectorAll('.section-bulk-check').forEach((cb) => {
        cb.onchange = () => {
          const id = cb.dataset.id;
          if (!id) return;
          if (cb.checked) sectionState[kind].selected.add(id);
          else sectionState[kind].selected.delete(id);
          const t = host.querySelector('[data-bulk-toolbar]');
          if (!t) return;
          // Compute the visible filtered count for the toolbar's "total"
          // — matches what the user sees on this page right now.
          const all = itemsByKind[kind] || [];
          const qq = sectionState[kind].query.trim().toLowerCase();
          const ef = sectionState[kind].eventFilter;
          const total = all.filter((it) => matchesEither(it, qq, ef)).length;
          t.outerHTML = bulkToolbarHtml({
            count: sectionState[kind].selected.size,
            total,
            kindLabel: '条' + kindTitle[kind],
          });
          wireBulkToolbar(host, sectionState[kind], {
            kindLabel: '条' + kindTitle[kind],
            onDelete: handlers.onDelete,
            onExit: handlers.onExit,
          });
        };
      });
      const handlers = {
        kindLabel: '条' + kindTitle[kind],
        onDelete: async (ids) => {
          const result = await api.attributes.deleteMany(ids);
          sectionState[kind].selectModeActive = false;
          sectionState[kind].selected = new Set();
          toast(`已删除 ${result.deleted} 条${kindTitle[kind]}`);
          await refreshKind(kind);
          return result;
        },
        onExit: () => {
          sectionState[kind].selectModeActive = false;
          sectionState[kind].selected = new Set();
          rerenderSections();
        },
      };
      wireBulkToolbar(host, sectionState[kind], handlers);
    }
  }

  app.innerHTML = `
    <div class="row between">
      <h1>${escapeHtml(displayName(c))}</h1>
      <div>
        <a class="inline-link" href="#/contacts/${escapeHtml(c.id)}/edit">编辑基本信息</a>
        <a class="inline-link" style="margin-left:10px" href="#/contacts">← 返回</a>
      </div>
    </div>
    <div class="card" data-contact-color="${contactColorIndex(c.name)}">
      <div class="row" style="gap:24px">
        ${c.relationship ? `<div><div class="meta">关系</div>${escapeHtml(c.relationship)}</div>` : ''}
        <div><div class="meta">条目统计</div>${likes.length} 喜好 / ${taboos.length} 忌讳 / ${gifts.length} 礼物</div>
      </div>
    </div>

    <div class="list-host" data-kind="like"></div>
    <div class="list-host" data-kind="taboo"></div>
    <div class="list-host" data-kind="gift"></div>

    <div class="section-header">
      <h2>重要日期</h2>
      <button class="btn secondary" id="add-date">+ 新增</button>
    </div>
    ${dates.length === 0
      ? `<div class="empty">还没有重要日期</div>`
      : dates.map((d) => {
        const kindTone = d.kind === 'birthday' ? 'birthday'
                       : d.kind === 'anniversary' ? 'anniversary'
                       : 'important';
        const icon = d.kind === 'birthday' ? '🎂'
                   : d.kind === 'anniversary' ? '💝'
                   : '📅';
        return `
        <div class="card list-row" data-kind="important">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${kindTone}">${icon}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(d.label)} <span class="tag" style="margin-left:6px">${escapeHtml(kindLabel(d.kind))}</span></div>
            <div class="lr-meta">每年 ${d.month}/${d.day}${d.year ? ' · ' + d.year + '年生' : ''} · 提醒 ${escapeHtml(d.remind_time || '09:00')}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip"><span class="chip-dot"></span>每年 ${d.month}-${d.day}</div>
            <button class="icon-btn" data-del-date="${escapeHtml(d.id)}" title="删除">✕</button>
          </div>
        </div>
      `}).join('')}

    <div class="section-header">
      <h2>回忆事件</h2>
      <button class="btn secondary" id="add-memorial">+ 新增</button>
    </div>
    ${memorial.length === 0
      ? `<div class="empty">还没有回忆事件</div>`
      : memorial.map((e) => `
        <div class="card list-row clickable" data-kind="memorial" data-memorial="${escapeHtml(e.id)}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(e.kind === 'first_time' ? '第一次' : '其他')}</span></div>
            <div class="lr-meta">${e.photo_count > 0 ? `${e.photo_count} 张照片` : '回忆事件'}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.occurred_at))}</div>
          </div>
        </div>
      `).join('')}

    <div class="section-header">
      <h2>事件</h2>
      <button class="btn secondary" id="add-event">+ 新增</button>
    </div>
    ${events.length === 0
      ? `<div class="empty">还没有事件</div>`
      : events.map((e) => {
        const kind = eventKindAttr(e);
        const rel = formatRelative(e.next_fire_at || e.remind_date);
        const cd  = countdownTo(e.next_fire_at || e.remind_date);
        return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title)}</div>
            <div class="lr-meta">${escapeHtml(kindLabel(e.remind_kind))}${e.active ? '' : ' · 已结束'}</div>
          </div>
          <div class="lr-side">
            <div class="time-chip ${cd ? 'urgent' : ''}"><span class="chip-dot"></span>${escapeHtml(rel)}</div>
            ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
          </div>
        </div>
      `}).join('')}
  `;

  rerenderSections();

  document.getElementById('add-date').onclick = () => showDateDialog(args.id);
  document.getElementById('add-event').onclick = () => navigate('/events/new?category=general&contact_id=' + args.id);
  const addMemorial = document.getElementById('add-memorial');
  if (addMemorial) addMemorial.onclick = () => navigate('/events/new?category=memorial&contact_id=' + args.id);
  app.querySelectorAll('[data-del-date]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('删除该重要日期？')) return;
      await api.importantDates.delete(el.dataset.delDate);
      toast('已删除');
      render(args);
    };
  });
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.memorial) {
        navigate('/events/' + el.dataset.memorial + '?category=memorial');
      } else if (el.dataset.id) {
        navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
      }
    };
  });
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', yearly: '每年', birthday: '生日', anniversary: '纪念日', custom: '自定义' }[k]) || k || '';
}

function showDateDialog(contactId) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>新增重要日期</h3>
        <button class="icon-btn" id="x">✕</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>名称（例：生日）</label><input type="text" id="d-label"/></div>
        <div class="form-row">
          <div class="field"><label>月</label><input type="number" id="d-month" min="1" max="12" value="1"/></div>
          <div class="field"><label>日</label><input type="number" id="d-day" min="1" max="31" value="1"/></div>
        </div>
        <div class="form-row">
          <div class="field"><label>年（可选）</label><input type="number" id="d-year" placeholder="1990"/></div>
          <div class="field"><label>类型</label>
            <select id="d-kind">
              <option value="birthday">生日</option>
              <option value="anniversary">纪念日</option>
              <option value="deceased_date">忌日</option>
              <option value="custom">自定义</option>
            </select>
          </div>
        </div>
        <div class="field"><label>提醒时间</label><input type="time" id="d-time" value="09:00"/></div>
        <div class="row" style="margin-top:14px; gap:8px;">
          <button class="btn" id="save">保存</button>
          <button class="btn secondary" id="cancel">取消</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#x').onclick = () => modal.remove();
  modal.querySelector('#cancel').onclick = () => modal.remove();
  modal.querySelector('#save').onclick = async () => {
    const input = {
      label: modal.querySelector('#d-label').value.trim() || '生日',
      month: parseInt(modal.querySelector('#d-month').value, 10),
      day: parseInt(modal.querySelector('#d-day').value, 10),
      year: modal.querySelector('#d-year').value ? parseInt(modal.querySelector('#d-year').value, 10) : null,
      kind: modal.querySelector('#d-kind').value,
      remind_time: modal.querySelector('#d-time').value || '09:00',
    };
    if (input.month < 1 || input.month > 12 || input.day < 1 || input.day > 31) {
      toast('日期不合法');
      return;
    }
    await api.importantDates.create(contactId, input);
    modal.remove();
    toast('已添加');
    render({ id: contactId });
  };
}

register('/contacts/:id', render);