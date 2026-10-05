// src/js/pages/contacts_list.js — list + create
import { api, escapeHtml, firstChar, displayName, contactColorIndex, toast } from '../api.js';
import { register, navigate } from '../router.js';

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;
  const contacts = await api.contacts.list();
  // Pre-compute the per-contact palette index once so we don't re-hash on
  // every row's data-attribute set.
  const tone = (name) => contactColorIndex(name);
  app.innerHTML = `
    <div class="row between">
      <h1>联系人 <span class="meta" style="margin-left:6px">· ${contacts.length} 人</span></h1>
      <button class="btn" id="new-contact">+ 新建</button>
    </div>
    ${contacts.length === 0
      ? `<div class="empty">还没有联系人 · 点 + 新建 创建一个</div>`
      : contacts.map((c) => `
        <div class="card list-row clickable" data-contact-color="${tone(c.name)}" data-id="${escapeHtml(c.id)}">
          <div class="lr-id">
            <div class="avatar-lg" style="background: var(--contact-${tone(c.name)})">${escapeHtml(firstChar(c.name))}</div>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(displayName(c))}</div>
            <div class="lr-meta">${c.relationship ? escapeHtml(c.relationship) + ' · ' : ''}按此查看喜好 / 忌讳 / 礼物 / 事件</div>
          </div>
          <div class="lr-side">
            <div class="time-chip muted">详情 →</div>
          </div>
        </div>
      `).join('')}
  `;
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  document.getElementById('new-contact').onclick = () => navigate('/contacts/new');
}

register('/contacts', render);
