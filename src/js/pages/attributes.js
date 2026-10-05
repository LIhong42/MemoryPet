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

import { api, escapeHtml, firstChar, displayName, fmtDate, contactColorIndex, toast, todayYmd } from '../api.js';
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
            draftDescription: '', draftEvent: '', draftContactId: '', formOpen: false,
            selectMode: { active: false, selected: new Set() } },
  taboos: { items: [], contacts: [], query: '', contactId: '', editingId: null,
            draftDescription: '', draftEvent: '', draftContactId: '', formOpen: false,
            selectMode: { active: false, selected: new Set() } },
  gifts:  { items: [], contacts: [], query: '', contactId: '', editingId: null,
            draftDescription: '', draftEvent: '', draftContactId: '', formOpen: false,
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
  return `
    <div class="card list-row attribute-row" data-id="${id}">
      <div class="lr-id">
        <div class="avatar-lg" style="background: var(--contact-${tone})">${escapeHtml(firstChar(it.contact_name))}</div>
      </div>
      <div class="lr-main">
        <div class="lr-title"><a class="inline-link" href="#/contacts/${escapeHtml(it.contact_id)}">${escapeHtml(displayName({ name: it.contact_name }))}</a></div>
        <div class="lr-meta">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="lr-side">
        ${it.event ? `<div class="time-chip"><span class="chip-dot"></span>${escapeHtml(fmtDate(it.event))}</div>` : ''}
        <div class="row" style="gap:6px">
          <button type="button" class="icon-btn attr-edit" data-id="${id}" title="编辑">✎</button>
          <button type="button" class="icon-btn attr-del"  data-id="${id}" title="删除">✕</button>
        </div>
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

function rerender(app, routeKey, meta) {
  const s = state[routeKey];
  const filtered = clientFilter(s.items, s.query, s.contactId);
  const noContacts = !s.contacts.length;
  const showForm = s.formOpen || s.editingId;
  const hasActiveFilter = !!(s.query || s.contactId);
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

  // Header "进入批量删除" link — only shown in idle mode and only when
  // there's at least one row to pick from. Inline next to the section
  // title so the user can find it without hunting.
  const enterBulkLink = (!selectActive && filtered.length > 0)
    ? bulkEnterLinkHtml() : '';

  // Toolbar pinned above the list while in select mode. The count is the
  // number of currently-checked rows (NOT total filtered), so the user
  // sees exactly what they're about to delete.
  const toolbar = selectActive
    ? bulkToolbarHtml({
        count: s.selectMode.selected.size,
        total: filtered.length,
        kindLabel: `${meta.title}条目`,
      })
    : '';

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
    `}
  `;

  if (noContacts) return;

  // Search input
  const search = document.getElementById('attr-search');
  if (search) {
    search.oninput = (e) => {
      s.query = e.target.value;
      rerender(app, routeKey, meta);
      const fresh = document.getElementById('attr-search');
      if (fresh) {
        fresh.focus();
        const v = fresh.value;
        fresh.setSelectionRange(v.length, v.length);
      }
    };
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
    s.draftEvent = '';
    // Default to the currently filtered contact if any, else the first contact.
    s.draftContactId = s.contactId || (s.contacts[0] ? s.contacts[0].id : '');
    s.formOpen = true;
    rerender(app, routeKey, meta);
  };

  if (showForm) wireForm(app, routeKey, meta);

  // Row actions (idle mode only — in select mode we render a checkbox on
  // each row instead of the per-row edit/delete buttons).
  if (!selectActive) {
    app.querySelectorAll('.attr-edit').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const it = s.items.find((x) => x && x.id === id);
        if (!it) return;
        s.editingId = id;
        s.draftDescription = it.description || '';
        s.draftEvent = it.event || '';
        s.formOpen = false;
        rerender(app, routeKey, meta);
      };
    });
    app.querySelectorAll('.attr-del').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        if (!confirm('确认删除该条目？')) return;
        try {
          await api.attributes.delete(id);
          toast('已删除');
        } catch (e) {
          toast('删除失败：' + (e.message || e));
          return;
        }
        await refreshItems(routeKey);
        rerender(app, routeKey, meta);
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
    s.selectMode.onChange = () => {
      const t = app.querySelector('[data-bulk-toolbar]');
      if (!t) return;
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
  return `
    <div class="list-row" data-id="${id}" style="background:transparent;">
      <div class="lr-id">
        <div class="avatar-lg" style="background: var(--contact-${tone})">${escapeHtml(firstChar(it.contact_name))}</div>
      </div>
      <div class="lr-main">
        <div class="lr-title"><a class="inline-link" href="#/contacts/${escapeHtml(it.contact_id)}">${escapeHtml(displayName({ name: it.contact_name }))}</a></div>
        <div class="lr-meta">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="lr-side">
        ${it.event ? `<div class="time-chip"><span class="chip-dot"></span>${escapeHtml(fmtDate(it.event))}</div>` : ''}
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
    ev.value = '';
  }
  document.getElementById('attr-save').onclick = async () => {
    const description = desc.value.trim();
    if (!description) { toast('请填写描述'); desc.focus(); return; }
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
    s.draftEvent = '';
    s.draftContactId = '';
    s.formOpen = false;
    await refreshItems(routeKey);
    rerender(app, routeKey, meta);
  };
  document.getElementById('attr-cancel').onclick = () => {
    s.editingId = null;
    s.draftDescription = '';
    s.draftEvent = '';
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
