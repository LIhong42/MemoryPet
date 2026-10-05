// src/js/pages/event_edit.js — create/edit events + event detail.
// The category comes from the URL ?category=… and is fixed for the lifetime
// of the form (the page is reached from one of three list pages). Users do
// not edit the category directly.
//
// `tag_kind` is set internally by the toggle_festival IPC for built-in
// festival events; the form itself does not expose it as user input. The
// 标签 (title) field was removed from this page on request — server auto-
// fills it from the contact name (or a generic placeholder) on create, and
// preserves the existing title on edit.
import { api, escapeHtml, displayName, fmtDateTime, toast } from '../api.js';
import { register, navigate } from '../router.js';

const CATEGORIES = ['general', 'memorial', 'work'];
const CATEGORY_TITLE = { general: '提醒日期', memorial: '回忆事件', work: '工作事件' };
const CATEGORY_LIST_ROUTE = { general: '/reminders', memorial: '/events/memorial', work: '/events/work' };

// Map a tag_kind code to the visible label.
const TAG_KIND_LABEL = { birthday: '生日', anniversary: '纪念日', festival: '节日' };

// 1-12 lunar months; the day range is intentionally wide (1-30) and validated
// server-side because whether day 30 exists depends on the year/month.
const LUNAR_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const LUNAR_DAY_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

function resolveCategory(params) {
  const c = (params && params.category) || 'general';
  return CATEGORIES.includes(c) ? c : 'general';
}

function categoryTitle(c) { return CATEGORY_TITLE[c] || '提醒日期'; }
function categoryListRoute(c) { return CATEGORY_LIST_ROUTE[c] || '/reminders'; }

// Visible label for a tag_kind code (or '' when unset).
export function tagKindLabel(k) {
  return TAG_KIND_LABEL[k] || '';
}

async function renderEdit(args, params) {
  const app = document.getElementById('app');
  const category = resolveCategory(params);
  const isNew = !args.id;
  let ev = {
    category,
    contact_id: params.contact_id || null,
    title: '',
    description: '',
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: new Date().toISOString().slice(0, 10),
    lunar_month: null,
    lunar_day: null,
    tag_kind: null,
  };
  if (!isNew) {
    ev = await api.events.get(args.id);
  }
  const contacts = await api.contacts.list();
  const listRoute = categoryListRoute(category);
  const listHref = '#' + listRoute;
  // Pre-compute the initial calendar mode: prefer lunar when both lunar
  // fields are populated (typically a saved lunar reminder); otherwise solar.
  const initialCalMode = (ev.lunar_month && ev.lunar_day) ? 'lunar' : 'solar';

  // For festival events the stored `title` is a code (e.g. 'fathers_day').
  // Resolve it to a human label so the form has a meaningful subtitle even
  // though the title field itself is hidden.
  let titleDisplay = ev.title || '';
  if (ev.tag_kind === 'festival') {
    const festivals = await api.events.listFestivals();
    const f = festivals.find((x) => x.code === ev.title);
    if (f) titleDisplay = f.label;
  }

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建' : '编辑'}${categoryTitle(category)}</h1>
      <a class="inline-link" href="${listHref}">← 返回列表</a>
    </div>
    <div class="card">
      ${titleDisplay ? `<div class="meta" style="margin-bottom: 10px;">标题：<strong>${escapeHtml(titleDisplay)}</strong></div>` : ''}
      <div class="field">
        <label>类型</label>
        <select id="e-tag-kind">
          <option value=""           ${!ev.tag_kind ? 'selected' : ''}>(无)</option>
          <option value="birthday"    ${ev.tag_kind === 'birthday'    ? 'selected' : ''}>生日</option>
          <option value="anniversary" ${ev.tag_kind === 'anniversary' ? 'selected' : ''}>纪念日</option>
          ${ev.tag_kind === 'festival' ? '<option value="festival" selected>节日</option>' : ''}
        </select>
      </div>
      <div class="field"><label>描述</label><textarea id="e-desc">${escapeHtml(ev.description || '')}</textarea></div>
      <div class="field">
        <label>关联联系人（可选）</label>
        <select id="e-contact">
          <option value="">(独立事件)</option>
          ${contacts.map((c) => `<option value="${escapeHtml(c.id)}" ${ev.contact_id===c.id?'selected':''}>${escapeHtml(displayName(c))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label><input type="checkbox" id="e-remind" ${ev.remind?'checked':''}/> 启用提醒</label>
      </div>
      <div id="remind-fields">
        <div class="form-row">
          <div class="field">
            <label>重复</label>
            <select id="e-kind">
              <option value="one_time" ${ev.remind_kind==='one_time'?'selected':''}>只一次</option>
              <option value="daily"    ${ev.remind_kind==='daily'?'selected':''}>每天</option>
              <option value="monthly"  ${ev.remind_kind==='monthly'?'selected':''}>每月</option>
              <option value="yearly"   ${ev.remind_kind==='yearly'?'selected':''}>每年</option>
            </select>
          </div>
          <div class="field">
            <label>日期类型</label>
            <div class="row" style="gap:12px; align-items:center;">
              <label><input type="radio" name="e-cal-mode" value="solar" ${initialCalMode==='solar'?'checked':''}/> 阳历</label>
              <label><input type="radio" name="e-cal-mode" value="lunar" ${initialCalMode==='lunar'?'checked':''}/> 农历</label>
            </div>
          </div>
        </div>
        <div id="solar-fields">
          <div class="field">
            <label id="date-label">日期</label>
            <input type="date" id="e-date" value="${escapeHtml(ev.remind_date || new Date().toISOString().slice(0,10))}"/>
          </div>
        </div>
        <div id="lunar-fields" class="hidden">
          <div class="form-row">
            <div class="field">
              <label>农历月</label>
              <select id="e-lunar-month">
                ${LUNAR_MONTH_OPTIONS.map((m) => `<option value="${m}" ${ev.lunar_month===m?'selected':''}>${m} 月</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>农历日</label>
              <select id="e-lunar-day">
                ${LUNAR_DAY_OPTIONS.map((d) => `<option value="${d}" ${ev.lunar_day===d?'selected':''}>${d} 日</option>`).join('')}
              </select>
            </div>
          </div>
          </div>
        <div class="field">
          <label>提醒时间</label>
          <input type="time" id="e-time" value="${escapeHtml(ev.remind_time || '09:00')}"/>
        </div>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">${isNew?'创建':'保存'}</button>
        ${!isNew ? '<button class="btn danger" id="del">删除</button>' : ''}
      </div>
    </div>
  `;

  function toggleRemind() {
    const on = document.getElementById('e-remind').checked;
    document.getElementById('remind-fields').style.display = on ? '' : 'none';
  }
  function toggleKind() {
    const k = document.getElementById('e-kind').value;
    document.getElementById('date-label').textContent =
      k === 'one_time' ? '日期' :
      k === 'yearly' ? '周年日期' :
      k === 'monthly' ? '每月几号' :
      k === 'daily' ? '起始日期（可选）' : '日期';
  }
  // Show/hide the solar vs lunar field set, and gate the lunar radio when
  // the user picks "每天" (a daily reminder has no meaningful lunar anchor).
  function toggleCalMode() {
    const mode = document.querySelector('input[name="e-cal-mode"]:checked')?.value || 'solar';
    const isDaily = document.getElementById('e-kind').value === 'daily';
    document.getElementById('solar-fields').classList.toggle('hidden', mode !== 'solar');
    document.getElementById('lunar-fields').classList.toggle('hidden', mode !== 'lunar');
    const lunarRadio = document.querySelector('input[name="e-cal-mode"][value="lunar"]');
    if (lunarRadio) {
      lunarRadio.disabled = isDaily;
      if (isDaily && lunarRadio.checked) {
        document.querySelector('input[name="e-cal-mode"][value="solar"]').checked = true;
        toggleCalMode();
      }
    }
  }

  document.getElementById('e-remind').onchange = toggleRemind;
  document.getElementById('e-kind').onchange = () => { toggleKind(); toggleCalMode(); };
  document.querySelectorAll('input[name="e-cal-mode"]').forEach((el) => {
    el.addEventListener('change', toggleCalMode);
  });
  toggleRemind();
  toggleKind();
  toggleCalMode();

  document.getElementById('save').onclick = async () => {
    const mode = document.querySelector('input[name="e-cal-mode"]:checked')?.value || 'solar';
    const kind = document.getElementById('e-kind').value;
    // Tag kind comes from the 类型 dropdown. The dropdown includes an
    // "(无)" option that maps to null. Festival events are system-managed
    // and the dropdown is locked for them (see form HTML), so we just
    // preserve the existing tag_kind in that case.
    let tagKind = ev.tag_kind || null;
    if (ev.tag_kind !== 'festival') {
      const sel = document.getElementById('e-tag-kind').value;
      tagKind = sel || null;
    }
    // Title is no longer on the form — the server auto-fills it from the
    // contact name (or a generic placeholder) on create, and falls back to
    // the existing title on update if the form somehow sends an empty value.
    const base = {
      title: ev.title || '',
      description: document.getElementById('e-desc').value.trim() || null,
      contact_id: document.getElementById('e-contact').value || null,
      remind: document.getElementById('e-remind').checked,
      remind_kind: kind,
      remind_time: document.getElementById('e-time').value || '09:00',
      category,
      tag_kind: tagKind,
    };
    if (kind === 'daily' && mode === 'lunar') {
      toast('每天重复不支持农历日期');
      return;
    }
    let input;
    if (mode === 'lunar') {
      input = {
        ...base,
        lunar_month: Number(document.getElementById('e-lunar-month').value),
        lunar_day: Number(document.getElementById('e-lunar-day').value),
        // remind_date is not meaningful for lunar; the server uses lunar_* to
        // recompute next_fire_at on every save/tick. Keep null for clarity.
        remind_date: null,
      };
    } else {
      input = {
        ...base,
        lunar_month: null,
        lunar_day: null,
        remind_date: document.getElementById('e-date').value || null,
      };
    }
    try {
      if (isNew) {
        const r = await api.events.create(input);
        toast('已创建');
        navigate('/events/' + r.id);
      } else {
        await api.events.update(ev.id, input);
        toast('已保存');
        navigate('/events/' + ev.id);
      }
    } catch (e) {
      toast((e && e.message) || '保存失败');
    }
  };
  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该事件？')) return;
      await api.events.delete(ev.id);
      toast('已删除');
      navigate(listRoute);
    };
  }
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

// /events/:id and /events/:id/edit both render the edit form. Clicking an
// event card from any list (or from contact_detail / search / today) lands
// directly on the edit page — no separate "编辑" button click needed.
// /events/new keeps its own route for the empty-form create case.
register('/events/new', renderEdit);
register('/events/:id/edit', renderEdit);
register('/events/:id', renderEdit);