// src/js/pages/settings.js — pet selection, walk toggle, pack import / remove,
// backup, quit
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render() {
  const app = document.getElementById('app');
  const lastExport = await api.settings.get('last_export_at');
  const lastImport = await api.settings.get('last_import_at');
  // Pet list is now dynamic, sourced from the resources/pets/ registry.
  // `listInstalled` returns entries decorated with source/origin/importedAt/
  // description, which we need to render the per-row delete button.
  const installed = (await api.pet.listInstalled?.()) || (await api.pet.list()) || [];
  const currentPetId = await api.pet.getCurrent();
  const walkEnabled = await api.pet.getWalkEnabled();

  const petOptions = installed.length
    ? installed.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === currentPetId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('')
    : '<option value="">(未找到桌宠)</option>';

  app.innerHTML = `
    <h1>设置</h1>
    <div class="card">
      <h2>桌面宠物形象</h2>
      <div class="form-row">
        <div class="field">
          <label>桌宠</label>
          <select id="pet-species">${petOptions}</select>
        </div>
        <div class="field" style="justify-content:flex-end;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="pet-walk-enabled" ${walkEnabled ? 'checked' : ''}/>
            自动行走
          </label>
        </div>
      </div>
      <p class="meta" style="margin-top:8px">
        切换桌宠后立刻生效；自动行走开启时，宠物会在桌面上随机走路、跳跃、睡觉；关闭后宠物原地待机。
      </p>
      <p class="meta" style="margin-top:4px">
        桌宠文件夹位于 <code>resources/pets/<id>/</code>，每个桌宠自带 <code>manifest.json</code> 描述自己的动作。
      </p>

      <h3 style="margin-top:18px;">导入桌宠包</h3>
      <p class="meta">支持 desktop-pet 风格的角色包：包含 <code>character.json</code> + <code>sprite.png</code> + <code>preview.png</code>。导入时会自动把动作表切成本项目的逐帧 PNG。</p>
      <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button class="btn" id="import-from-zip">从 ZIP 导入…</button>
        <button class="btn secondary" id="import-from-folder">从文件夹导入…</button>
      </div>

      <div id="installed-pets-list" style="margin-top:14px;"></div>
    </div>

    <div class="card">
      <h2>数据迁移</h2>
      <p>将所有联系人、提醒、回忆事件、照片和设置打包到一个 zip 文件，方便在不同机器之间迁移。</p>
      <p class="meta">最近导出：<strong>${lastExport || '从未'}</strong> · 最近导入：<strong>${lastImport || '从未'}</strong></p>
      <div class="row" style="gap:8px; margin-top:10px;">
        <button class="btn" id="export-backup">导出备份…</button>
        <button class="btn secondary" id="import-backup">导入备份…</button>
      </div>
      <p class="meta" style="margin-top:8px">导入会覆盖当前所有数据。建议先导出一份当前备份再导入。</p>
    </div>

    <div class="card">
      <h2>应用</h2>
      <button class="btn danger" id="quit-app">退出 MemoryPet</button>
      <p class="meta" style="margin-top:8px">点击后关闭整个应用，包括桌面宠物。</p>
    </div>
  `;
  document.getElementById('pet-species').onchange = async (e) => {
    try {
      await api.pet.setCurrent(e.target.value);
      toast('桌宠已切换');
    } catch (err) {
      toast('切换失败：' + ((err && err.message) || err));
    }
  };
  document.getElementById('pet-walk-enabled').onchange = async (e) => {
    try {
      await api.pet.setWalkEnabled(!!e.target.checked);
      toast(e.target.checked ? '自动行走已开启' : '自动行走已关闭');
    } catch (err) {
      toast('设置失败：' + ((err && err.message) || err));
    }
  };
  document.getElementById('import-from-zip').onclick = async () => {
    try {
      const r = await api.pet.importFromZip?.();
      if (!r || r.canceled) return;
      if (r.deduped) toast(`已存在同名桌宠：${r.pet.name}`);
      else            toast(`已导入：${r.pet.name}`);
      render();
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('import-from-folder').onclick = async () => {
    try {
      const r = await api.pet.importFromFolder?.();
      if (!r || r.canceled) return;
      if (r.deduped) toast(`已存在同名桌宠：${r.pet.name}`);
      else            toast(`已导入：${r.pet.name}`);
      render();
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
    }
  };

  // Render the per-pet row list (thumbnail + delete-button) below the
  // import controls. The dropdown above already covers "switch", so this
  // list is purely for managing imported packs.
  const listEl = document.getElementById('installed-pets-list');
  if (installed.length > 0) {
    listEl.innerHTML = installed.map((p) => petRow(p, currentPetId)).join('');
    wirePetListActions(currentPetId);
  } else {
    listEl.innerHTML = '';
  }

  document.getElementById('export-backup').onclick = async () => {
    try {
      const r = await api.backup.export();
      if (!r || r.canceled) return;
      toast('已导出到 ' + r.path);
      render();
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('import-backup').onclick = async () => {
    // Step 1: pick the zip.
    const picked = await api.backup.import();
    if (!picked || picked.canceled) return;
    // Step 2: confirm — full-string warning that names the destructive scope.
    if (!confirm('导入会覆盖当前所有数据，包括联系人、提醒、回忆事件、照片和设置。建议先导出一份当前备份再继续。')) return;
    // Step 3: swap.
    try {
      await api.backup.apply(picked.path);
      toast('导入完成');
      // Re-render the page so the new last_import_at shows up.
      navigate('/settings');
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
    }
  };
  document.getElementById('quit-app').onclick = async () => {
    if (!confirm('确认退出 MemoryPet？')) return;
    await api.app.quit();
  };
}

// Build a single pet-management row. Built-in rows are non-destructive
// (no delete button); imported rows get a delete button. Thumbnails fall
// back to an emoji when the registry can't give us a frame.
function petRow(pet, currentPetId) {
  const isCurrent = pet.id === currentPetId;
  const isImported = pet.source === 'imported';
  const sourceTag = isImported
    ? `<span class="tag">已导入${pet.origin === 'zip' ? ' · ZIP' : ' · 文件夹'}</span>`
    : `<span class="tag">内置</span>`;
  const sizeTxt = pet.defaultSize ? `${pet.defaultSize.w}×${pet.defaultSize.h}` : '';
  const meta = [
    sourceTag,
    sizeTxt ? `<span class="meta">${sizeTxt}</span>` : '',
    pet.importedAt ? `<span class="meta">导入于 ${escapeHtml(String(pet.importedAt).slice(0, 10))}</span>` : '',
  ].filter(Boolean).join(' ');
  const desc = pet.description ? `<div class="meta">${escapeHtml(pet.description)}</div>` : '';
  return `
    <div class="list-item pet-row" data-pet-id="${escapeHtml(pet.id)}" data-source="${escapeHtml(pet.source || 'builtIn')}">
      <div class="row" style="gap:12px; flex:1; min-width:0; align-items:center;">
        <div class="pet-thumb-wrap" data-pet-thumb-for="${escapeHtml(pet.id)}">
          <div class="pet-thumb pet-thumb-emoji">🐾</div>
        </div>
        <div style="min-width:0; flex:1;">
          <div class="lr-title" style="display:flex; align-items:center; gap:6px;">
            <span>${escapeHtml(pet.name || pet.id)}</span>
            ${isCurrent ? '<span class="tag tag-current">当前使用</span>' : ''}
          </div>
          <div class="lr-meta">${meta}</div>
          ${desc}
        </div>
      </div>
      <div class="row" style="gap:6px;">
        ${isImported
          ? `<button class="btn danger" data-action="remove-pet" data-pet-id="${escapeHtml(pet.id)}" data-pet-name="${escapeHtml(pet.name || pet.id)}">删除</button>`
          : ''}
      </div>
    </div>
  `;
}

function wirePetListActions(currentPetId) {
  document.querySelectorAll('[data-action="remove-pet"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-pet-id');
      const name = btn.getAttribute('data-pet-name') || id;
      const wasCurrent = id === currentPetId;
      const warn = wasCurrent
        ? '\n\n当前正在使用它，删除后会自动切换到其他内置桌宠。'
        : '';
      if (!confirm(`确认删除桌宠"${name}"？此操作不可撤销。${warn}`)) return;
      try {
        const r = await api.pet.removeImported?.(id);
        if (r && r.switchedTo) toast(`已删除并切换到 ${r.switchedTo}`);
        else                    toast('已删除');
        render();
      } catch (e) {
        toast('删除失败：' + ((e && e.message) || e));
      }
    };
  });
  // Lazy async thumbnails: resolve the first frame of the default variant
  // for each row. Errors are swallowed — the emoji stays in place.
  const wraps = document.querySelectorAll('[data-pet-thumb-for]');
  wraps.forEach((wrap) => {
    const petId = wrap.getAttribute('data-pet-thumb-for');
    if (!petId || !api.pet.resolveFrames) return;
    api.pet.resolveFrames(petId, 'default', 'right')
      .then((r) => {
        if (r && Array.isArray(r.frames) && r.frames.length > 0) {
          wrap.innerHTML = `<img class="pet-thumb" src="${escapeHtml(r.frames[0].url)}" alt="${escapeHtml(petId)}"/>`;
        }
      })
      .catch(() => { /* keep emoji */ });
  });
}

register('/settings', render);