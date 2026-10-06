// src/js/pages/attributes.js — Global /likes /taboos /gifts pages.
//
// One render function drives all three routes; the three pages differ only
// by `kind` and display title. Lets the user add / edit / delete likes,
// taboos, and gift entries for any contact without first navigating into
// that contact's detail page.
//
// State for each page (search query, in-progress edit draft) lives in a
// module-scoped object so it survives re-renders triggered by the
// search input / inline form interactions.

import { api, escapeHtml, firstChar, displayName, fmtDate, contactColorIndex, toast, todayYmd, wireDateInputs } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';

const META = {
  likes:  { title: '喜好', kind: 'like',  singular: '喜好' },
  taboos: { title: '忌讳', kind: 'taboo', singular: '忌讳' },
  gifts:  { title: '礼物', kind: 'gift',  singular: '礼物' },
};

// Per-route state. Reset whenever a new page module load happens, which is
// fine for a hash-router app — the state lives across renders within a
// single page visit.
//
// `selectMode.selected` holds the ids currently checked while in batch-
// delete mode. It's a Set so add/delete is O(1) and the UI can flip rows
// on/off without rebuilding the whole list.
const state = {
  likes:  { items: [], contacts: [], query: '', contactId: '', editingId: null,
            draftDescription: '', draftEvent: todayYmd(), draftContactId: '', formOpen: false,
            selectMode: { active: false, selected: new Set() } },
  taboos: { items: [], contacts: [], query: '', contactId: '', editingId: null,
            draftDescription: '', draftEvent: todayYmd(), draftContactId: '', formOpen: false,
            selectMode: { active: false, selected: new Set() } },
  gifts:  { items: [], contacts: [], query: '', contactId: '', editingId: null,
            draftDescription: '', draftEvent: todayYmd(), draftContactId: '', formOpen: false,
            selectMode: { active: false, selected: new Set() } },
};

function clientFilter(items, q, contactId) {
  const v = (q || '').trim().toLowerCase();
  const cid = (contactId || '').trim();
  return items.filter((it) => {
    if (cid && it.contact_id !== cid) return false;
    if (!v) return true;
    const desc = (it.description || '').toLowerCase();
    const name = (it.contact_name || '').toLowerCase();
    return desc.includes(v) || name.includes(v);
  });
}

function renderRow(it) {
  const id = escapeHtml(it.id);
  const tone = contactColorIndex(it.contact_name);
  const kind = suggestIconKind(it.contact_relationship);
  return `
    <div class="card list-row clickable attribute-row" data-id="${id}">
      <div class="lr-id">
        <div class="contact-avatar" style="color: var(--contact-${tone})">${iconSVG(kind, { title: it.contact_name })}</div>
      </div>
      <div class="lr-main lr-main-inline">
        <a class="inline-link lr-title" href="#/contacts/${escapeHtml(it.contact_id)}">${escapeHtml(displayName({ name: it.contact_name }))}</a>
        <div class="lr-title-main">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="lr-side">
        <div class="lr-created-at">${escapeHtml(fmtDate(it.created_at))}</div>
      </div>
    </div>
  `;
}

// Inline form used for both "add new" and "edit existing". `mode` flips the
// submit label and shows / hides the cancel button.
function renderForm(state, meta, mode) {
  const editing = !!state.editingId;
  const title = editing ? '编辑条目' : '新增条目';
  const submitLabel = editing ? '保存' : '添加';
  const noContacts = !state.contacts.length;
  return `
    <div class="card">
      <div class="section-header"><h2>${title}</h2></div>
      ${noContacts ? `<div class="empty">还没有联系人，无法添加条目。先在「联系人」添加一个联系人。</div>` : `
        <div class="field">
          <label>描述 *</label>
          <input type="text" id="attr-desc" placeholder="例如：抹茶甜点" value="${escapeHtml(state.draftDescription)}" autofocus/>
        </div>
        <div class="field">
          <label>事件（记录时间）</label>
          <input type="date" id="attr-event" value="${escapeHtml(state.draftEvent)}"/>
        </div>
        ${editing ? '' : `
          <div class="field">
            <label>联系人 *</label>
            <select id="attr-contact">
              ${state.contacts.map((c) => `<option value="${escapeHtml(c.id)}" ${state.draftContactId === c.id ? 'selected' : ''}>${escapeHtml(displayName(c))}</option>`).join('')}
            </select>
          </div>
        `}
        <div class="row" style="margin-top:14px; gap:8px;">
          <button type="button" class="btn" id="attr-save">${submitLabel}</button>
          <button type="button" class="btn secondary" id="attr-cancel">取消</button>
        </div>
      `}
    </div>
  `;
}

// Re-render only the list+toolbar+section-header portion of the page.
// Used by the search input — keeping the search input itself and the
// filter dropdown outside the rewritten subtree means deleting a
// character (or pressing backspace) inside a Chinese IME never tears down
// the live input, so the IME composition context is preserved and the
// caret / focus survive every keystroke.
function rerenderList(routeKey, meta) {
  const s = state[routeKey];
  const filtered = clientFilter(s.items, s.query, s.contactId);
  const hasActiveFilter = !!(s.query || s.contactId);
  const selectActive = s.selectMode.active;

  const contactsWithItems = s.items.length
    ? Array.from(new Set(s.items.map((it) => it.contact_id)))
        .map((cid) => ({ id: cid, name: (s.items.find((x) => x.contact_id === cid) || {}).contact_name || '' }))
        .sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh'))
    : [];

  const enterBulkLink = (!selectActive && filtered.length > 0) ? bulkEnterLinkHtml() : '';
  const toolbar = selectActive
    ? bulkToolbarHtml({ count: s.selectMode.selected.size, total: filtered.length, kindLabel: `${meta.title}条目` })
    : '';

  const host = document.getElementById('attr-list');
  if (!host) return;
  host.innerHTML = `
    <div class="section-header">
      <h2>
        ${s.contactId
          ? `${escapeHtml(displayName(contactsWithItems.find((c) => c.id === s.contactId) || { name: '' }))} 的${escapeHtml(meta.title)}`
          : `所有${escapeHtml(meta.title)}`}
        （${filtered.length}${hasActiveFilter ? ` / ${s.items.length}` : ''}）
        ${enterBulkLink}
      </h2>
    </div>

    ${toolbar}

    ${filtered.length === 0
      ? (s.items.length === 0
          ? `<div class="empty">还没有${escapeHtml(meta.title)}条目 · 点右上「+ 新建」添加</div>`
          : `<div class="empty">没有匹配的${escapeHtml(meta.title)}</div>`)
      : filtered.map((it) => selectActive
          ? bulkSelectableRowHtml(rowInner(it), it.id, s.selectMode.selected.has(it.id), meta.kind)
          : renderRow(it)
        ).join('')
    }
  `;

  // Wire bulk-select controls that live inside the rewritten subtree.
  // Only the "Enter" link is shown in idle mode; the toolbar's delete
  // / exit buttons and per-row checkboxes are wired by the full
  // rerender() below when select mode is active.
  if (!selectActive) {
    wireBulkEnter(host, () => {
      s.selectMode.active = true;
      s.selectMode.selected = new Set();
      rerenderList(routeKey, meta);
    });
    host.querySelectorAll('.attribute-row').forEach((row) => {
      row.onclick = () => navigate('/attributes/' + row.dataset.id);
    });
  }
}

function rerender(app, routeKey, meta) {
  const s = state[routeKey];
  const noContacts = !s.contacts.length;
  const showForm = s.formOpen || s.editingId;
  const selectActive = s.selectMode.active;

  // Build contact dropdown options. Only include contacts that actually
  // appear in `s.items` so the dropdown never shows entries with no items
  // (keeps the list short when there are many contacts). Sorted by display
  // name for readability.
  const contactsWithItems = s.items.length
    ? Array.from(new Set(s.items.map((it) => it.contact_id)))
        .map((cid) => {
          const it = s.items.find((x) => x.contact_id === cid);
          return { id: cid, name: it ? it.contact_name : '' };
        })
        .sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh'))
    : [];

  app.innerHTML = `
    <div class="row between">
      <h1>${escapeHtml(meta.title)}</h1>
      <div class="row" style="gap:8px;">
        <button type="button" class="btn" id="attr-new" ${noContacts ? 'disabled' : ''}>+ 新建</button>
      </div>
    </div>

    ${noContacts ? `
      <div class="empty">还没有联系人 · <a class="inline-link" href="#/contacts/new">先添加一个</a>，然后回到这里管理${escapeHtml(meta.title)}。</div>
    ` : `
      <div class="filter-row">
        <input type="text" id="attr-search" placeholder="搜索描述或联系人…" value="${escapeHtml(s.query)}"/>
        <select id="attr-contact-filter">
          <option value="">所有联系人</option>
          ${contactsWithItems.map((c) => `<option value="${escapeHtml(c.id)}" ${s.contactId === c.id ? 'selected' : ''}>${escapeHtml(displayName(c))}</option>`).join('')}
        </select>
      </div>

      ${showForm ? renderForm(s, meta) : ''}

      <div id="attr-list"></div>
    `}
  `;

  if (noContacts) return;

  // Make date / time inputs open their picker on click of the whole box,
  // not only the tiny trailing icon. No-op on renderers without support.
  wireDateInputs(app);

  // Initial paint of the list section.
  rerenderList(routeKey, meta);

  // Search input. The input node is NEVER replaced — only the list
  // subtree underneath is rewritten. The previous implementation called
  // rerender(app,...) on every keystroke which destroyed the live input
  // and dropped IME composition context (typing "汉" lost the intermediate
  // pinyin strokes, and even plain backspace lost the caret until the
  // user re-clicked the box). Now we mirror the value into state, repaint
  // only `<div id="attr-list">`, and never touch the input itself.
  const search = document.getElementById('attr-search');
  if (search) {
    let settleTimer = null;
    const apply = () => {
      settleTimer = null;
      s.query = search.value;
      rerenderList(routeKey, meta);
      // Keep focus on the same input node (it was never replaced).
      const fresh = document.getElementById('attr-search');
      if (fresh && document.activeElement !== fresh) fresh.focus();
    };
    search.addEventListener('input', () => {
      // Debounce IME composition bursts. 120ms covers the typical settle
      // time for Chinese/Japanese IMEs; the input is not torn down so
      // backspace, selection edits, and cursor moves work continuously.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, 120);
    });
    search.addEventListener('compositionend', () => {
      if (settleTimer) clearTimeout(settleTimer);
      apply();
    });
  }

  // Contact filter dropdown
  const contactFilter = document.getElementById('attr-contact-filter');
  if (contactFilter) {
    contactFilter.onchange = (e) => {
      s.contactId = e.target.value;
      rerender(app, routeKey, meta);
    };
  }

  // New-row button
  document.getElementById('attr-new').onclick = () => {
    s.editingId = null;
    s.draftDescription = '';
    // Pre-fill with today's local date so the user doesn't have to pick
    // anything; they can also click the input to change it.
    s.draftEvent = todayYmd();
    // Default to the currently filtered contact if any, else the first contact.
    s.draftContactId = s.contactId || (s.contacts[0] ? s.contacts[0].id : '');
    s.formOpen = true;
    rerender(app, routeKey, meta);
  };

  if (showForm) wireForm(app, routeKey, meta);

  // Row actions (idle mode only — in select mode we render a checkbox on
  // each row instead of the per-row edit/delete buttons). Click on a row
  // opens its detail page, which is where all edits / deletes happen.
  if (!selectActive) {
    app.querySelectorAll('.attribute-row').forEach((row) => {
      row.onclick = (e) => {
        // Don't hijack clicks that are targeting the contact-name inline link
        // — those should bubble through to the router and land on the contact
        // detail page, not on the attribute detail page.
        if (e.target && e.target.closest && e.target.closest('a.inline-link')) return;
        navigate('/attributes/' + row.dataset.id);
      };
    });
  }

  // Bulk-select mode wiring.
  if (selectActive) {
    // Handlers are shared by the toolbar's delete/exit buttons AND the
    // lighter-weight onChange path (see below) so we hoist them up.
    const handlers = {
      onDelete: async (ids) => {
        const result = await api.attributes.deleteMany(ids);
        await refreshItems(routeKey);
        rerender(app, routeKey, meta);
        return result;
      },
      onExit: () => {
        s.selectMode.active = false;
        s.selectMode.selected = new Set();
        rerender(app, routeKey, meta);
      },
    };
    // Lightweight onChange: a single checkbox flip just refreshes the
    // toolbar's count + enabled state without rebuilding the whole list
    // (which would steal the user's focus from the checkbox).
    // Also sync the per-row checkbox visuals — without this, hitting
    // "全选" only flips the toolbar counter; the row boxes stay empty
    // because they were rendered once at enter-time.
    s.selectMode.onChange = () => {
      const t = app.querySelector('[data-bulk-toolbar]');
      if (!t) return;
      app.querySelectorAll('.bulk-row-check').forEach((cb) => {
        const id = cb.dataset.bulkId;
        if (!id) return;
        cb.checked = s.selectMode.selected.has(id);
      });
      t.outerHTML = bulkToolbarHtml({
        count: s.selectMode.selected.size,
        total: filtered.length,
        kindLabel: `${meta.title}条目`,
      });
      wireBulkToolbar(app, s.selectMode, handlers);
    };
    wireBulkRowChecks(app, s.selectMode);
    wireBulkToolbar(app, s.selectMode, handlers);
  }
  wireBulkEnter(app, () => {
    s.selectMode.active = true;
    s.selectMode.selected = new Set();
    rerender(app, routeKey, meta);
  });
}

// Inner row template — same content as the outer card but WITHOUT the
// wrapper. Used inside bulkSelectableRowHtml's wrapper. Keeping this as a
// separate function avoids duplicating the avatar / name / event markup.
function rowInner(it) {
  const id = escapeHtml(it.id);
  const tone = contactColorIndex(it.contact_name);
  const kind = suggestIconKind(it.contact_relationship);
  return `
    <div class="list-row" data-id="${id}" style="background:transparent;">
      <div class="lr-id">
        <div class="contact-avatar" style="color: var(--contact-${tone})">${iconSVG(kind, { title: it.contact_name })}</div>
      </div>
      <div class="lr-main lr-main-inline">
        <a class="inline-link lr-title" href="#/contacts/${escapeHtml(it.contact_id)}">${escapeHtml(displayName({ name: it.contact_name }))}</a>
        <div class="lr-title-main">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="lr-side">
        <div class="lr-created-at">${escapeHtml(fmtDate(it.created_at))}</div>
      </div>
    </div>
  `;
}

function wireForm(app, routeKey, meta) {
  const s = state[routeKey];
  const desc = document.getElementById('attr-desc');
  const ev = document.getElementById('attr-event');
  const contactEl = document.getElementById('attr-contact');
  if (!desc) return;
  if (s.editingId) {
    desc.value = s.draftDescription;
    ev.value = s.draftEvent;
  } else {
    desc.value = '';
    // New rows default the date to today in local time so the user gets a
    // sensible value without picking anything. They can still clear it.
    ev.value = s.draftEvent || todayYmd();
  }
  document.getElementById('attr-save').onclick = async () => {
    const description = desc.value.trim();
    if (!description) { toast('请填写描述'); desc.focus(); return; }
    // Empty input -> treat as today. Bilingual callers (server-side) already
    // do this fallback, but doing it here keeps the persisted value honest
    // even when the user later edits without saving through this form.
    const event = ev.value || todayYmd();
    try {
      if (s.editingId) {
        await api.attributes.update(s.editingId, { description, event });
        toast('已保存');
      } else {
        const contactId = contactEl ? contactEl.value : '';
        if (!contactId) { toast('请选择联系人'); return; }
        await api.attributes.create({ contact_id: contactId, kind: meta.kind, description, event });
        toast('已添加');
      }
    } catch (e) {
      toast('操作失败：' + (e.message || e));
      return;
    }
    s.editingId = null;
    s.draftDescription = '';
    s.draftEvent = todayYmd();
    s.draftContactId = '';
    s.formOpen = false;
    await refreshItems(routeKey);
    rerender(app, routeKey, meta);
  };
  document.getElementById('attr-cancel').onclick = () => {
    s.editingId = null;
    s.draftDescription = '';
    s.draftEvent = todayYmd();
    s.draftContactId = '';
    s.formOpen = false;
    rerender(app, routeKey, meta);
  };
}

async function refreshItems(routeKey) {
  const s = state[routeKey];
  const meta = META[routeKey];
  const [items, contacts] = await Promise.all([
    api.attributes.list(meta.kind),
    api.contacts.list(),
  ]);
  s.items = items;
  s.contacts = contacts;
}

async function render(routeKey) {
  const meta = META[routeKey];
  if (!meta) return;
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  await refreshItems(routeKey);
  rerender(app, routeKey, meta);
}

register('/likes',  () => render('likes'));
register('/taboos', () => render('taboos'));
register('/gifts',  () => render('gifts'));
