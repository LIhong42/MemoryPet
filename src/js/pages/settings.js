// src/js/pages/settings.js — pet position, debug, version
import { api, escapeHtml, toast } from '../api.js';
import { register, navigate } from '../router.js';

async function render() {
  const app = document.getElementById('app');
  const pos = await api.pet.getPosition();
  const state = await api.pet.getState();
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
  document.getElementById('quit-app').onclick = async () => {
    if (!confirm('确认退出 MemoryPet？')) return;
    await api.app.quit();
  };
}

register('/settings', render);