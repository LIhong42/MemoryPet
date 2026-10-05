# MemoryPet

本地优先的 Windows 桌面应用，结合 **Monica 风格的关系管理** 与 **BongoCat 风格的桌面宠物**。

## 功能（v1 范围）

- **联系人管理**（CRUD）：姓名、昵称、公司、职位
- **重要日期**：生日 / 纪念日 / 自定义，含月日 + 可选年份
- **事件**：一次性 / 每天 / 每月 / 每年，关联联系人（可选）；按「提醒日期 / 回忆事件 / 工作事件」分类管理；支持按农历日期每年提醒
- **桌面宠物**：透明、始终置顶、待机动画 + 提醒抖动
- **提醒调度**：20 秒一轮扫描，NORMAL ↔ REMINDER 状态机
- **全局搜索**：跨联系人/事件/重要日期的 LIKE 搜索
- **本地 SQLite** 存储（通过 `sql.js` WASM），完全离线

## 技术栈

- **Electron 32**（主进程 + 两个 BrowserWindow：主窗口 + 宠物窗口）
- **sql.js**（WASM SQLite，无需 MSVC 编译）
- Vanilla JS（无前端框架，原生 hash-router）
- electron-builder（NSIS 安装包）

## 目录结构

```
MemoryPet/
├── main/                  # Electron 主进程
│   ├── main.js            # 入口（窗口创建 + 调度器启动）
│   ├── db.js              # sql.js 封装（迁移 + 持久化）
│   ├── time_util.js       # 下次触发时间计算（纯函数）
│   ├── scheduler.js       # 20 秒轮询提醒
│   ├── ipc.js             # 所有 ipcMain.handle 通道
│   └── preload.js         # contextBridge 暴露给主窗口
├── pet/preload.js         # contextBridge 暴露给宠物窗口
├── src/                   # 前端（vanilla）
│   ├── index.html / pet.html
│   ├── css/styles.css / pet.css
│   ├── js/
│   │   ├── api.js         # mp.* IPC 封装
│   │   ├── router.js      # hash 路由
│   │   ├── main.js        # 主窗口入口
│   │   ├── pet.js         # 宠物窗口逻辑
│   │   └── pages/         # 9 个页面模块
├── scripts/
│   ├── run-electron.js           # 启动器（剥离 ELECTRON_RUN_AS_NODE）
│   ├── gen-icons.js              # 纯 Node 图标生成（PNG + ICO）
│   └── prebuild-extract-winCodeSign.js  # 预解压 winCodeSign 7z
└── icons/                 # 多尺寸 PNG + icon.ico
```

## 开发运行

```bash
cd MemoryPet
npm install              # 安装依赖（含 electron、sql.js、electron-builder）
npm start                # 启动 Electron（dev 模式，DevTools 自动打开）
npm run dev              # 同上（显式传递 --dev）
```

启动后：
- 主窗口出现在屏幕中央
- 桌宠出现在屏幕左上（默认位置 200,200）
- DevTools 在 dev 模式下打开

## 打包 .exe

### 独立可执行（推荐，无需安装）

```bash
npm run build:dir
# 产出：dist/win-unpacked/MemoryPet.exe
```

直接双击 `dist/win-unpacked/MemoryPet.exe` 即可运行（包含完整 Chromium 运行时 + 应用代码，约 580 MB）。

或使用 `dist/run-memorypet.cmd` 启动（已处理 Windows 上的环境变量问题）。

### NSIS 安装包（可选）

```bash
npm run build
# 产出：dist/MemoryPet Setup 0.1.0.exe
```

⚠️ **NSIS 安装包在当前 Windows 环境下可能失败**：`winCodeSign` 归档包含 macOS 符号链接（libcrypto.dylib / libssl.dylib），Windows 没有 `SeCreateSymbolicLinkPrivilege` 时 7-Zip 会报错（已用 `scripts/prebuild-extract-winCodeSign.js` 预解压了 Windows 部分，但 app-builder 仍会用新 hash 重新解压）。**已验证**：`npm run build:dir` 产出的独立 `MemoryPet.exe` 可以完整运行。

## 调试提醒流程

1. 启动后桌宠在 NORMAL 状态（bob 动画）。
2. 设置页 → 调试区 → "让所有提醒立即到期" → 20 秒内桌宠进入 REMINDER（shake 动画 + 角标）。
3. 点击桌宠 → 主窗口弹出提醒模态框 → 完成 → 桌宠回 NORMAL。

## 数据存储位置

- DB：`%APPDATA%/MemoryPet/memorypet.db`（sql.js 内存库 + 周期性写盘）
- 桌宠位置：`settings.pet_x` / `settings.pet_y`（默认 200, 200）

## 关键设计决策

- **CSS hit-target**：桌宠根 `pointer-events: none`，sprite `pointer-events: auto`，无需 `set_ignore_cursor_events`（参见 BongoCat 的 WS_EX_TRANSPARENT 复杂方案）。
- **sql.js 替代 better-sqlite3**：WASM 无需 MSVC 编译，规避 Windows 工具链缺失。
- **scheduler 20 秒轮询**：分钟级响应，不需要更精细。
- **不实现 FTS5**：sql.js 的 FTS5 启用复杂，回退到 LIKE 搜索（小数据集够用）。
- **不打包 Live2D**：用 inline SVG 猫精灵 + CSS 动画（`@keyframes bob/shake`）。

## 已知问题 / 环境约束

- Windows 用户的 shell 全局设置了 `ELECTRON_RUN_AS_NODE=1`，会导致 `require('electron')` 返回字符串而非 API。已用 `scripts/run-electron.js` 启动器绕过。
- electron-builder 下载 winCodeSign 时遇 macOS symlink 失败（无管理员权限无法创建符号链接）。`npm run build:dir` 不受影响。
- 不支持代码签名（.exe 没有 Authenticode 签名，Windows SmartScreen 可能警告）。

## License

本项目基于 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 开源。

```
Copyright 2026 MemoryPet

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

除非适用法律要求或经书面同意，根据本许可证分发的软件按"原样"分发，
不附带任何明示或暗示的保证或条件。请参阅许可证以了解具体的权限和限制。

### 主要权限

- ✅ 商用、可修改、可分发、专利授权
- ✅ 可与闭源代码混合使用（无 Copyleft 传染性）

### 主要义务

- 在所有副本/衍生作品中保留版权声明和许可证
- 修改后的文件必须标注已修改
- 包含 NOTICE 文件（如提供）必须在衍生作品中传递其中的归属声明

详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
