// src/js/pages/contact_detail.js — view a single contact + their dates + events
import { api, escapeHtml, fmtDate, fmtDateTime, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render(args) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const c = await api.contacts.get(args.id);
  const [dates, events] = await Promise.all([
    api.importantDates.list(args.id),
    api.events.list({ contact_id: args.id }),
  ]);

  app.innerHTML = `
    <div class="row between">
      <h1>${escapeHtml(displayName(c))}</h1>
      <div>
        <a class="inline-link" href="#/contacts/${escapeHtml(c.id)}/edit">编辑</a>
        <a class="inline-link" style="margin-left:10px" href="#/contacts">← 返回</a>
      </div>
    </div>
    <div class="card">
      <div class="row" style="gap:24px">
        ${c.nickname ? `<div><div class="meta">昵称</div>${escapeHtml(c.nickname)}</div>` : ''}
        ${c.company ? `<div><div class="meta">公司</div>${escapeHtml(c.company)}</div>` : ''}
        ${c.job_position ? `<div><div class="meta">职位</div>${escapeHtml(c.job_position)}</div>` : ''}
      </div>
    </div>

    <div class="section-header">
      <h2>重要日期</h2>
      <button class="btn secondary" id="add-date">+ 新增</button>
    </div>
    ${dates.length === 0
      ? `<div class="empty">还没有重要日期</div>`
      : dates.map((d) => `
        <div class="card">
          <div class="row between">
            <div>
              <div><strong>${escapeHtml(d.label)}</strong> · <span class="tag">${kindLabel(d.kind)}</span></div>
              <div class="meta">每年 ${d.month}/${d.day}${d.year ? '（' + d.year + '年生）' : ''} · 提醒 ${escapeHtml(d.remind_time || '09:00')}</div>
            </div>
            <button class="icon-btn" data-del-date="${escapeHtml(d.id)}" title="删除">✕</button>
          </div>
        </div>
      `).join('')}

    <div class="section-header">
      <h2>事件</h2>
      <button class="btn secondary" id="add-event">+ 新增</button>
    </div>
    ${events.length === 0
      ? `<div class="empty">还没有事件</div>`
      : events.map((e) => `
        <div class="card clickable" data-id="${escapeHtml(e.id)}">
          <div class="row between">
            <div>
              <div><strong>${escapeHtml(e.title)}</strong></div>
              <div class="meta">${fmtDateTime(e.next_fire_at || e.remind_date)} · ${kindLabel(e.remind_kind)}${e.active ? '' : ' · 已结束'}</div>
            </div>
          </div>
        </div>
      `).join('')}
  `;

  document.getElementById('add-date').onclick = () => showDateDialog(args.id);
  document.getElementById('add-event').onclick = () => navigate('/events/new?contact_id=' + args.id);
  app.querySelectorAll('[data-del-date]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('删除该重要日期？')) return;
      await api.importantDates.delete(el.dataset.delDate);
      toast('已删除');
      render(args);
    };
  });
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id);
  });
}

function displayName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.nickname || '(无名)';
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