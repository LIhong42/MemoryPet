// src/js/pages/contact_edit.js — create or edit a contact
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render(args) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  let c = { first_name: '', last_name: '', nickname: '', company: '', job_position: '' };
  if (!isNew) {
    c = await api.contacts.get(args.id);
  }

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建联系人' : '编辑联系人'}</h1>
      <a class="inline-link" href="${isNew ? '#/contacts' : '#/contacts/' + c.id}">取消</a>
    </div>
    <div class="card">
      <div class="form-row">
        <div class="field"><label>名 *</label><input type="text" id="f-first" value="${escapeHtml(c.first_name)}"/></div>
        <div class="field"><label>姓</label><input type="text" id="f-last" value="${escapeHtml(c.last_name || '')}"/></div>
      </div>
      <div class="field"><label>昵称</label><input type="text" id="f-nick" value="${escapeHtml(c.nickname || '')}"/></div>
      <div class="form-row">
        <div class="field"><label>公司</label><input type="text" id="f-company" value="${escapeHtml(c.company || '')}"/></div>
        <div class="field"><label>职位</label><input type="text" id="f-job" value="${escapeHtml(c.job_position || '')}"/></div>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button class="btn" id="save">${isNew ? '创建' : '保存'}</button>
        ${!isNew ? `<button class="btn danger" id="del">删除</button>` : ''}
      </div>
    </div>
  `;

  document.getElementById('save').onclick = async () => {
    const input = {
      first_name: document.getElementById('f-first').value.trim(),
      last_name: document.getElementById('f-last').value.trim(),
      nickname: document.getElementById('f-nick').value.trim() || null,
      company: document.getElementById('f-company').value.trim() || null,
      job_position: document.getElementById('f-job').value.trim() || null,
    };
    if (!input.first_name) { toast('请填写「名」'); return; }
    if (isNew) {
      const r = await api.contacts.create(input);
      toast('已创建');
      navigate('/contacts/' + r.id);
    } else {
      await api.contacts.update(c.id, input);
      toast('已保存');
      navigate('/contacts/' + c.id);
    }
  };
  if (!isNew) {
    document.getElementById('del').onclick = async () => {
      if (!confirm('确认删除该联系人？关联事件将变为独立事件。')) return;
      await api.contacts.delete(c.id);
      toast('已删除');
      navigate('/contacts');
    };
  }
}

register('/contacts/new', () => render({}));
register('/contacts/:id/edit', render);