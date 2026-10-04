// src/js/pages/contacts_list.js — list + create
import { api, escapeHtml, firstChar, displayName, toast } from '../api.js';
import { register, navigate } from '../router.js';

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const contacts = await api.contacts.list();
  app.innerHTML = `
    <div class="row between">
      <h1>联系人</h1>
      <button class="btn" id="new-contact">+ 新建</button>
    </div>
    ${contacts.length === 0
      ? `<div class="empty">还没有联系人 · 点 + 新建 创建一个</div>`
      : contacts.map((c) => `
        <div class="list-item" data-id="${escapeHtml(c.id)}">
          <div class="row">
            <div class="avatar">${escapeHtml(firstChar(c.name))}</div>
            <div>
              <div><strong>${escapeHtml(displayName(c))}</strong></div>
              <div class="meta">${escapeHtml(c.relationship || '')}</div>
            </div>
          </div>
        </div>
      `).join('')}
  `;
  app.querySelectorAll('.list-item').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  document.getElementById('new-contact').onclick = () => navigate('/contacts/new');
}

register('/contacts', render);
