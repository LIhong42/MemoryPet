// src/js/pages/contact_edit.js — create or edit a contact (basic info only).
//
// Likes / taboos / gifts used to be edited inline here, but they now live in
// the global contact_attributes table and are managed from the dedicated
// `/likes`, `/taboos`, `/gifts` top-level pages. The reminder card below
// links the user there.
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render(args) {
  const app = document.getElementById('app');
  const isNew = !args.id;
  let c = { name: '', relationship: '' };
  if (!isNew) {
    c = await api.contacts.get(args.id);
  }

  app.innerHTML = `
    <div class="row between">
      <h1>${isNew ? '新建联系人' : '编辑联系人'}</h1>
      <a class="inline-link" href="${isNew ? '#/contacts' : '#/contacts/' + c.id}">取消</a>
    </div>

    <div class="card">
      <div class="section-header"><h2>基本信息</h2></div>
      <div class="field">
        <label>姓名 *</label>
        <input type="text" id="f-name" value="${escapeHtml(c.name || '')}" autofocus/>
      </div>
      <div class="field">
        <label>与本人的关系</label>
        <input type="text" id="f-relationship" placeholder="家人 / 朋友 / 同事..."
               value="${escapeHtml(c.relationship || '')}"/>
      </div>
    </div>

    <div class="card">
      <div class="section-header"><h2>喜好 / 忌讳 / 礼物</h2></div>
      <div class="meta">在顶部导航的「<a class="inline-link" href="#/likes">喜好</a> / <a class="inline-link" href="#/taboos">忌讳</a> / <a class="inline-link" href="#/gifts">礼物</a>」页面统一管理。</div>
    </div>

    <div class="row" style="margin-top:14px; gap:8px;">
      <button class="btn" id="save">${isNew ? '创建' : '保存'}</button>
      ${!isNew ? `<button class="btn danger" id="del">删除</button>` : ''}
    </div>
  `;

  document.getElementById('save').onclick = async () => {
    const input = {
      name: document.getElementById('f-name').value.trim(),
      relationship: document.getElementById('f-relationship').value.trim() || null,
    };
    if (!input.name) { toast('请填写「姓名」'); return; }
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
      if (!confirm('确认删除该联系人？关联事件将变为独立事件，喜好/忌讳/礼物条目也会一并删除。')) return;
      await api.contacts.delete(c.id);
      toast('已删除');
      navigate('/contacts');
    };
  }
}

register('/contacts/new', () => render({}));
register('/contacts/:id/edit', render);
