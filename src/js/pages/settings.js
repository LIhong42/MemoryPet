// src/js/pages/settings.js — pet position, debug, version
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render() {
  const app = document.getElementById('app');
  const pos = await api.pet.getPosition();
  const state = await api.pet.getState();
  const lastExport = await api.settings.get('last_export_at');
  const lastImport = await api.settings.get('last_import_at');
  app.innerHTML = `
    <h1>设置</h1>
    <div class="card">
      <h2>桌面宠物位置</h2>
      <div class="form-row">
        <div class="field"><label>X</label><input type="number" id="pet-x" value="${pos.x}"/></div>
        <div class="field"><label>Y</label><input type="number" id="pet-y" value="${pos.y}"/></div>
      </div>
      <button class="btn" id="save-pos">保存位置</button>
      <p class="meta" style="margin-top:8px">提示：直接用鼠标拖动桌宠即可调整位置，无需手动输入。</p>
    </div>

    <div class="card">
      <h2>调试</h2>
      <p>立即把所有"未来"事件提前到现在，看桌宠能否在 20 秒内进入提醒状态。</p>
      <button class="btn secondary" id="fire-now">让所有提醒立即到期</button>
      <p style="margin-top:10px">当前宠物状态：<strong>${state.state}</strong>，队列长度 <strong>${state.count}</strong></p>
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

    <div class="card">
      <h2>关于</h2>
      <p>MemoryPet v0.1.0 · 基于 Electron + sql.js (WASM SQLite)。</p>
      <p>数据保存在本地 <code>%APPDATA%/MemoryPet/memorypet.db</code>。</p>
      <p>点击宠物可打开主窗口或处理提醒；按住拖动可移动位置。</p>
    </div>
  `;
  document.getElementById('save-pos').onclick = async () => {
    const x = parseInt(document.getElementById('pet-x').value, 10);
    const y = parseInt(document.getElementById('pet-y').value, 10);
    await api.pet.setPosition(x, y);
    toast('已保存');
  };
  document.getElementById('fire-now').onclick = async () => {
    await api.events.debugFireDueNow();
    toast('已触发；将在 20 秒内提醒');
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