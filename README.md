# 🐾 SoulDesktopPet

> 本地优先（local-first）的桌面宠物，用于**关系管理**与**纪念提醒**。
> A local-first desktop pet for relationship management & reminders.

---

## 这是什么

SoulDesktopPet 是一个跑在你电脑上的桌面宠物（桌面应用），帮你记住：

- 👤 联系人——他们的昵称、关系、自定义头像；
- ❤️ 喜好 / 🚫 忌讳 / 🎁 礼物——你对他们的了解；
- 📅 重要日期——生日、纪念日，以及每一年自动复发的节日；
- 📷 回忆事件——带照片的回忆相册；
- 💼 工作事件——一次性 / 周期性的工作提醒；
- 🐾 一只陪伴你的桌宠——会走动、会撒娇、会在该提醒的时候叫你。

**所有数据都保存在你自己电脑里**（`%APPDATA%/SoulDesktopPet/`），不上云、不上传。

---

## 核心功能

| 模块 | 功能 |
|---|---|
| **联系人** | 新建 / 编辑 / 删除联系人；上传自定义头像；每个联系人独立管理喜好、忌讳、礼物、重要日期。 |
| **喜好 / 忌讳 / 礼物** | 全局条目库，可批量管理与联系人关联。 |
| **重要日期** | 按公历或农历记录一次性或年度循环的日期，到日子自动提醒。 |
| **事件** | 分两类：回忆事件（带照片相册）、工作事件（一次性 / 按 cron 循环）。 |
| **节日库** | 内置节日（情人节、教师节、七夕、圣诞节 …），支持浮动节日（父亲节等）。 |
| **桌面宠物** | 半透明无边框窗体；自动行走 / 待机 / 入睡；单击 = 角色动作、右击 = cozy 互动菜单（摸/拍/喂/玩/睡/抱）。 |
| **亲密值系统** | 三层架构：**Bond（永久羁绊）**、**Cozy（短时温馨值）**、**Mood（情绪）**。亲密度随互动提升，解锁更强的互动（如双击拍头需要 tier≥5）。 |
| **回忆相册导出** | 把回忆事件一键导出为 **PDF 相册** 或 **MP4 视频相册**；支持多模板布局，所见即所得。 |
| **工具** | 把视频按帧拆分为 PNG 序列，打包成 zip，方便制作桌宠动画。 |
| **数据备份 / 还原** | 把整个数据库（含照片）打包为 zip 备份；导入即可在一台新机器恢复所有数据。 |
| **桌宠导入** | 上传包含帧动画 PNG 的 zip 自动生成桌宠，立刻可在桌面上使用。 |
| **PIN 密码锁** | 主窗口需 4 位 PIN 码解锁（默认 1234），隐私数据有保护。 |
| **角色动作配置** | 为每个桌宠自定义：单击 → 什么动作；待机循环哪些动作；右击菜单的 6 个 cozy 动作各自播放什么动画。 |

---

## 安装与运行

### 准备环境
- Node.js 18+
- Windows 10 / 11（macOS 也可运行，但默认打包目标是 Windows）

### 安装
```bash
npm install
```
`postinstall` 钩子会自动补齐运行所需的 helper 模块。

### 开发运行
```bash
npm run dev
```
> 启动 Electron，主窗口自动打开并附带 DevTools；桌宠窗体置顶显示。

### 正式启动
```bash
npm start
```
> 主窗口默认隐藏；点击桌宠即可唤起。

> 💡 **如果 `npm install` 看起来卡了、或 `npm start` 报 `Electron failed to install correctly`**，
> 请直接跳到下面的 [故障排查](#故障排查) 一节。一条 `npm run doctor -- --fix` 通常就够了。

### 打包为安装程序（Windows）
```bash
npm run build
```
> 产物在 `dist/` 下，默认 NSIS 安装器，输出桌面 + 开始菜单快捷方式（名称：SoulDesktopPet）。

---

## 数据存储位置

所有数据都保存在操作系统用户目录：

```
%APPDATA%\SoulDesktopPet\
  ├─ soul-desktop-pet.db       ← SQLite 数据库（sql.js）
  ├─ avatars\<contact_id>      ← 联系人的自定义头像
  ├─ photos\<event_id>\        ← 回忆事件照片
  └─ pets\                     ← 内置 + 用户导入的桌宠包
```

备份的 zip 内仍以 `soul-desktop-pet.db` 为根文件，导入时会原子替换。

---

## 项目结构

```
.
├─ main/                ← Electron 主进程（数据库、调度、IPC、桌宠引擎）
│  ├─ main.js             入口
│  ├─ db.js               sql.js 封装 + SQLite 模式
│  ├─ scheduler.js        提醒队列 + 1Hz 亲密值管线
│  ├─ ipc.js              所有 IPC handler（约 100+）
│  ├─ bond_engine.js      亲密值（tier 1+2）算法
│  ├─ cozy_engine.js      cozy（tier 3）算法
│  ├─ pet_controller.js   桌宠自动行为状态机
│  ├─ pet_registry.js     桌宠资源注册表
│  ├─ pet_zip_import.js   用户 zip 导入桌宠
│  ├─ album_pdf.js        PDF 相册导出
│  ├─ album_video.js      MP4 视频相册导出
│  └─ festivals.js        节日库
├─ pet/                 ← 桌宠窗口 preload
├─ src/                 ← 渲染进程（主窗口）
│  ├─ index.html
│  ├─ pet.html           ← 桌宠窗口 HTML
│  └─ js/
│     ├─ main.js, api.js, router.js, auth.js, pet.js
│     └─ pages/            各路由页面（today / contacts / events / export …）
├─ scripts/             ← 工具脚本（含若干 smoke 测）
├─ icons/               ← 应用图标
├─ resources/           ← 桌宠帧资源（默认包含若干内置桌宠）
└─ package.json
```

### 模块要点

- **主进程**（`main/`）：所有数据库 / 文件系统 / 调度逻辑都在主进程，渲染进程只能通过 `preload.js` 暴露的白名单 IPC 访问。
- **桌宠窗体**独立进程，自带透明无边框窗体、置顶渲染、不抢焦点。
- **亲密值系统**分三档：
  - **Bond**（持久档）——每周结算一次，按 10 个维度（问候 / 喂食 / 玩耍 …）统计，季度升级；
  - **Cozy**（短期档）——会随时间衰减，玩一次加一点，决定宠物的"心情";
  - **Mood**——由 cozy + 当天活动 + 周活动密度计算，驱动桌宠的表情滤镜。

---

## 使用入门

### 1. 解锁主窗口
- 启动后默认显示桌宠 + PIN 解锁界面（默认密码 `1234`）。
- 在 **设置 → 访问密码** 中可修改 4 位 PIN。

### 2. 添加联系人
- 进入 **联系人 → 新建联系人**，填名称、关系、选头像 / 上传自定义头像。
- 进联系人详情页可继续添加：喜好、忌讳、礼物、重要日期。

### 3. 创建回忆事件 + 上传照片
- **回忆事件 → 新建** → 填标题、日期、关联联系人。
- 在详情页可批量上传照片；之后可一键导出为 PDF / MP4 相册。

### 4. 等待桌宠提醒
- 桌宠右上角会显示未读提醒数，到时间桌面宠物会自动提醒；
- 点桌宠唤起主窗口 / 提醒弹窗，或在 **今日** 页查看所有当天事项。

### 5. 与桌宠互动
- **单击**：触发用户为该桌宠配置的"单击动作"（默认：摸一下）。
- **双击**：触发"双击动作"（默认：拍头，亲密 tier≥5 解锁）。
- **右击**：弹出 cozy 互动菜单：摸一下 / 拍头 / 喂食 / 玩耍 / 睡觉 / 抱抱。
- 在 **设置 → 角色动作** 中可自由切换每个触发绑定的角色动画。

### 6. 切换桌宠 / 导入新桌宠
- **设置 → 桌面宠物形象** → 在下拉中切换；或上传帧动画压缩包（见 `角色更换与制作指南.md`）。

### 7. 备份与迁移
- **设置 → 数据迁移 → 导出备份** 生成 zip，包含数据库 + 所有照片 + 设置；
- 在另一台机器上 **导入备份** 即可还原全部数据。

---

## 常见操作速查

| 想做什么 | 去哪里 |
|---|---|
| 看今天该做什么 | **今日** 页 |
| 录一个新朋友 | **联系人 → 新建联系人** |
| 给朋友设置生日提醒 | 联系人详情 → **重要日期 → 新建** |
| 整理某人的喜好 | **喜好 / 忌讳 / 礼物** 三个全局页 |
| 录一段带孩子去公园的回忆 | **回忆事件 → 新建**，上传照片 |
| 录明天的会议 | **工作事件 → 新建**，cron / 一次性 |
| 给相册加封面 / 换模板 | 相册详情 → 进入 **相册编辑器** |
| 导出相册为 PDF / MP4 | **工具** 或 **回忆事件** → **导出相册** |
| 切桌宠 | **设置 → 桌面宠物形象** |
| 改桌宠单击动作 | **设置 → 角色动作 → 触发方式→角色动作** |
| 改访问密码 | **设置 → 访问密码** |
| 备份 / 还原数据 | **设置 → 数据迁移** |

---

## 故障排查

> 本项目常见安装 / 启动失败，原因几乎都是同一个：**Electron 的二进制（`electron.exe`，约 100 MB）没下载下来**。
> `node_modules/electron/` 这个 npm 包本身只是源码；真正的可执行文件由 `node_modules/electron/postinstall` 从 GitHub Releases 拉取，国内网络非常容易超时。

### 1. 先跑医生
```bash
npm run doctor
```
会逐项检查 Node 版本、`node_modules`、Electron 二进制、磁盘空间，并打印可粘贴的修复命令。

### 2. 一键修复
```bash
npm run doctor -- --fix     # 自动 npm rebuild electron
```
> 仍然失败？下面的命令 99% 能解：
```bash
npm run install:bin
# 或：
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # Windows cmd
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ # bash
npm rebuild electron
```

### 3. 完全重装
```bash
rm -rf node_modules package-lock.json
npm install
```
> 如果重装前看到 `EACCES` / `EPERM`，关掉 OneDrive / 坚果云 / Dropbox 同步后再试。

### 4. 常见报错速查
| 报错 | 原因 | 修复 |
|---|---|---|
| `Electron failed to install correctly` | 二进制未下完 | `npm run install:bin` |
| `npm install 卡住不动` | 在等 GitHub | 设 `ELECTRON_MIRROR` 后重装 |
| `Cannot create symbolic link` | Windows 普通用户无 `SeCreateSymbolicLinkPrivilege`（仅在打包时） | 打包脚本会自动剔除 macOS 符号链接，无需手动处理 |
| `EACCES ... EPERM` | OneDrive / 杀软占用文件 | 关掉同步后再 `npm install` |
| 项目路径超过 260 字符 | Windows MAX_PATH | 把项目挪到 `C:\proj\soul-desktop-pet` |
| 主窗口弹出后立刻消失 | Pin 锁 / 桌宠位置被推到屏幕外 | 在 `%APPDATA%\SoulDesktopPet\` 下手动删 `pet_x` / `pet_y` 设置 |

### 5. 数据目录
所有用户数据都在操作系统用户目录下，独立于项目：
```
# Windows
%APPDATA%\SoulDesktopPet\
# macOS / Linux
~/.config/SoulDesktopPet/
```
直接删掉这个目录相当于"重置应用"，不会影响项目本身。

---

## 开发说明

### Smoke 测试
```bash
node scripts/smoke-backup.js
node scripts/smoke-photo-read.js
node scripts/smoke-memorial-v2.js
```
全部应该输出 `SMOKE OK: ...`。

### 加一个新的 IPC
1. 在 `main/ipc.js` 注册 `ipcMain.handle('xxx:yyy', ...)`；
2. 在 `main/preload.js` 的 `mp.xxx.yyy` 下暴露白名单 API；
3. 在 `src/js/api.js` 转译 `window.mp.xxx.yyy` 供渲染进程使用。

### 写一个新桌宠
见 **[角色更换与制作指南.md](角色更换与制作指南.md)** ——包含帧目录结构、`manifest.json` 字段、上传流程。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 32 |
| 数据库 | sql.js（纯 JS SQLite，零原生依赖） |
| 渲染 | 原生 HTML + ES Module + hash 路由（无框架） |
| 打包 | electron-builder + NSIS |
| 视频帧拆分 | ffmpeg-static + fluent-ffmpeg |
| PDF 生成 | pdfkit |
| 农历 | lunar-javascript |

> 无任何云端依赖；无任何追踪；网络只在 OS 自动更新 Electron 时使用。

---

## License

Apache License 2.0 — 见 [LICENSE](LICENSE) / [NOTICE](NOTICE)。
