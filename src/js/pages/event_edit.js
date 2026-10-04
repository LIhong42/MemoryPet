// src/js/pages/event_edit.js — create/edit events + event detail
import { api, escapeHtml, displayName, fmtDateTime, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function renderEdit(args, params) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  let ev = {
    contact_id: params.contact_id || null,
    title: '',
    description: '',
    remind: true,
    remind_kind: 'one_time',
    remind_time: '09:00',
    remind_date: new Date().toISOString().slice(0, 10),
  };
  if (!isNew) {
    ev = await api.events.get(args.id);
  }
  const contacts = await api.contacts.list();

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建事件' : '编辑事件'}</h1>
      <a class="inline-link" href="${isNew ? '#/events' : '#/events/' + ev.id}">取消</a>
    </div>
    <div class="card">
      <div class="field"><label>标题 *</label><input type="text" id="e-title" value="${escapeHtml(ev.title)}"/></div>
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
            <label id="date-label">日期</label>
            <input type="date" id="e-date" value="${escapeHtml(ev.remind_date || new Date().toISOString().slice(0,10))}"/>
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
  document.getElementById('e-remind').onchange = toggleRemind;
  document.getElementById('e-kind').onchange = toggleKind;
  toggleRemind();
  toggleKind();

  document.getElementById('save').onclick = async () => {
    const input = {
      title: document.getElementById('e-title').value.trim(),
      description: document.getElementById('e-desc').value.trim() || null,
      contact_id: document.getElementById('e-contact').value || null,
      remind: document.getElementById('e-remind').checked,
      remind_kind: document.getElementById('e-kind').value,
      remind_time: document.getElementById('e-time').value || '09:00',
      remind_date: document.getElementById('e-date').value || null,
    };
    if (!input.title) { toast('请填写标题'); return; }
    if (isNew) {
      const r = await api.events.create(input);
      toast('已创建');
      navigate('/events/' + r.id);
    } else {
      await api.events.update(ev.id, input);
      toast('已保存');
      navigate('/events/' + ev.id);
    }
  };
  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该事件？')) return;
      await api.events.delete(ev.id);
      toast('已删除');
      navigate('/events');
    };
  }
}

async function renderDetail(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const ev = await api.events.get(args.id);
  let contact = null;
  if (ev.contact_id) {
    contact = await api.contacts.get(ev.contact_id);
  }

  app.innerHTML = `
    <div class="row between">
      <h1>${escapeHtml(ev.title)}</h1>
      <div>
        <a class="inline-link" href="#/events/${escapeHtml(ev.id)}/edit">编辑</a>
        <a class="inline-link" style="margin-left:10px" href="#/events">← 返回</a>
      </div>
    </div>
    <div class="card">
      <div class="row" style="gap:24px;">
        <div><div class="meta">类型</div>${kindLabel(ev.remind_kind)}</div>
        <div><div class="meta">下次提醒</div>${fmtDateTime(ev.next_fire_at || ev.remind_date)}</div>
        ${contact ? `<div><div class="meta">联系人</div><a class="inline-link" href="#/contacts/${escapeHtml(contact.id)}">${escapeHtml(displayName(contact))}</a></div>` : ''}
      </div>
      ${ev.description ? `<p style="margin-top:12px">${escapeHtml(ev.description)}</p>` : ''}
    </div>
  `;
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

register('/events/new', renderEdit);
register('/events/:id/edit', renderEdit);
register('/events/:id', renderDetail);