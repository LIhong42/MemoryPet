// src/js/pages/settings.js — pet selection, walk toggle, backup, quit
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render() {
  const app = document.getElementById('app');
  const lastExport = await api.settings.get('last_export_at');
  const lastImport = await api.settings.get('last_import_at');
  // Pet list is now dynamic, sourced from the resources/pets/ registry.
  const petList = (await api.pet.list()) || [];
  const currentPetId = await api.pet.getCurrent();
  const walkEnabled = await api.pet.getWalkEnabled();

  const petOptions = petList.length
    ? petList.map((p) =>
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
        桌宠文件夹位于 <code>resources/pets/<id>/</code>，每个桌宠自带 <code>manifest.json</code> 描述自己的动作。在 <code>%APPDATA%/MemoryPet/pets/</code> 目录下添加新桌宠也会被自动识别。
      </p>
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

register('/settings', render);