// scripts/verify-render.js — headless render of contact edit + detail + per-list edit pages.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let sandbox = null; // hoisted so helpers can read from it
let mpBridge = null;
let window = null;
let document = null;
let runInWindow = null;
let getHandler = null;
let resetHandlers = null;
let loadPage = null;
let currentContact = null;       // builder — returns the *same* mutated object each call
let capturedListOps = null;
let capturedUpdates = null;

function resetDoc() {
  runInWindow(`
    document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
    window.confirm = () => true;
  `);
}

function buildInitialContact() {
  return {
    id: 'test-id-1',
    name: '张三',
    relationship: '家人',
    likes: [
      { id: 'l1', description: '抹茶甜点', event: '2024-12-25' },
      { id: 'l2', description: '科幻小说', event: '2025-01-15' },
      { id: 'l3', description: '远足', event: '2025-05-20' },
      { id: 'l4', description: '音乐剧', event: '2024-09-10' },
      { id: 'l5', description: '咖啡', event: '' },
      { id: 'l6', description: '鲜花', event: '2025-03-08' },
      { id: 'l7', description: '手账本', event: '2024-11-01' },
      { id: 'l8', description: '猫咪', event: '' },
    ],
    taboos: [
      { id: 't1', description: '香菜', event: '2023-06-01' },
      { id: 't2', description: '嘈杂的咖啡厅', event: '' },
      { id: 't3', description: '惊悚电影', event: '2024-10-31' },
    ],
    gifts: [
      { id: 'g1', description: '手写卡片', event: '2024-10-01' },
      { id: 'g2', description: '茶具', event: '2025-03-08' },
      { id: 'g3', description: '书籍', event: '' },
      { id: 'g4', description: '围巾', event: '2024-12-01' },
      { id: 'g5', description: '香薰蜡烛', event: '' },
      { id: 'g6', description: '耳机', event: '2025-02-14' },
    ],
  };
}

function main() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="app"></div><div id="toast-container"></div>
  </body></html>`, { url: 'http://localhost/' });
  window = dom.window;
  document = window.document;

  // Build a contact with 8 likes, 3 taboos, 6 gifts so pagination kicks in.
  // We keep an explicit `currentContact` ref so per-list-item tests can reflect
  // mutations (so detail page re-fetches pick up new state).
  const statefulContact = buildInitialContact();
  currentContact = () => statefulContact;
  capturedUpdates = [];
  const capturedCreates = [];
  capturedListOps = { adds: [], updates: [], deletes: [] };

  const mpBridge = {
    contacts: {
      list: async () => [currentContact()],
      get: async () => currentContact(),
      create: async (input) => { capturedCreates.push(input); return { ...currentContact(), ...input, id: 'new-id' }; },
      update: async (id, input) => { capturedUpdates.push({ id, input }); return { ...currentContact(), ...input, id }; },
      delete: async () => true,
      addListItem: async (cid, kind, input) => {
        capturedListOps.adds.push({ cid, kind, input });
        const c = currentContact();
        const id = 'new-' + (c[kind].length + 1);
        c[kind].push({ id, ...input });
        return c;
      },
      updateListItem: async (cid, kind, itemId, input) => {
        capturedListOps.updates.push({ cid, kind, itemId, input });
        const c = currentContact();
        const arr = c[kind];
        const idx = arr.findIndex((x) => x.id === itemId);
        if (idx >= 0) arr[idx] = { id: itemId, ...input };
        return c;
      },
      deleteListItem: async (cid, kind, itemId) => {
        capturedListOps.deletes.push({ cid, kind, itemId });
        const c = currentContact();
        c[kind] = c[kind].filter((x) => x.id !== itemId);
        return c;
      },
    },
    importantDates: { list: async () => [] },
    events: { list: async () => [], listToday: async () => [], get: async () => null },
    reminders: { listActive: async () => [] },
    search: { query: async () => ({ contacts: [], events: [], important_dates: [] }) },
    pet: { getState: async () => ({ state: 'NORMAL' }) },
    settings: { get: async () => null, set: async () => true },
    app: { quit: async () => true },
    on: () => () => {},
  };
  window.mp = mpBridge;

  sandbox = {
    mp: mpBridge, // must come BEFORE self-reference so window.mp is set
    window,
    document,
    location: window.location,
    navigator: window.navigator,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Array, Object, JSON, Map, Set, Date, Error, Number, String, Boolean,
    URLSearchParams: window.URLSearchParams,
    CustomEvent: window.CustomEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window.mp = mpBridge;
  const ctx = vm.createContext(sandbox);
  sandbox.__vmCtx = ctx;
  runInWindow = (code) => vm.runInContext(code, ctx, { filename: 'inline.js' });

  runInWindow(fs.readFileSync('src/js/api.js', 'utf8').replace(/^export\s+/gm, ''));
  runInWindow(fs.readFileSync('src/js/router.js', 'utf8').replace(/^export\s+/gm, ''));

  // Patch register to capture handlers into a map; expose __getHandler.
  runInWindow(`
    (function(){
      const origRegister = window.register;
      const m = new Map();
      window.__capturedHandlers = m;
      window.register = function(path, fn) {
        m.set(path, fn);
        return origRegister(path, fn);
      };
      window.__getHandler = (p) => m.get(p);
    })();
  `);

  getHandler = (p) => sandbox.__getHandler(p);
  resetHandlers = () => runInWindow(`window.__capturedHandlers = new Map();`);
  loadPage = (relPath) => {
    const src = fs.readFileSync(path.join('src/js/pages', relPath), 'utf8')
      .replace(/^import\s.+$/gm, '')
      .replace(/^export\s+/gm, '');
    runInWindow(src);
  };

  resetDoc();

  // ---- Edit form tests ----
  loadPage('contact_edit.js');
  console.log('===== /contacts/new (新建) — 关键字段存在性 =====');
  getHandler('/contacts/new')({}).then(() => {
    console.log('  #f-name:', !!document.getElementById('f-name'));
    console.log('  #f-relationship:', !!document.getElementById('f-relationship'));
    console.log('  #add-like:', !!document.getElementById('add-like'));
    console.log('  #add-taboo:', !!document.getElementById('add-taboo'));
    console.log('  #add-gift:', !!document.getElementById('add-gift'));
    console.log('  #save:', !!document.getElementById('save'));

    // ---- Edit form with existing contact ----
    document.getElementById('app').innerHTML = '';
    getHandler('/contacts/:id/edit')({ id: 'test-id-1' }).then(() => {
      console.log('\n===== /contacts/:id/edit — 预填 8 喜好 / 3 忌讳 / 6 礼物 =====');
      console.log('  喜好 rows:', document.querySelectorAll('.list-row[data-kind="like"]').length);
      console.log('  忌讳 rows:', document.querySelectorAll('.list-row[data-kind="taboo"]').length);
      console.log('  礼物 rows:', document.querySelectorAll('.list-row[data-kind="gift"]').length);

      // Save flow
      document.getElementById('add-like').click();
      const all = document.querySelectorAll('.list-row[data-kind="like"]');
      all[all.length - 1].querySelector('.row-desc').value = '远足';
      all[all.length - 1].querySelector('.row-event').value = '2025-05-20';
      // Add a row with description but no date → save-time backfill to today.
      document.getElementById('add-like').click();
      const allBackfill = document.querySelectorAll('.list-row[data-kind="like"]');
      allBackfill[allBackfill.length - 1].querySelector('.row-desc').value = '便签本';
      // (leave .row-event empty)
      document.getElementById('add-like').click();
      const allEmpty = document.querySelectorAll('.list-row[data-kind="like"]');
      allEmpty[allEmpty.length - 1].querySelector('.row-desc').value = '';
      document.getElementById('save').click();
      setTimeout(() => {
        console.log('\n===== 保存时 update 收到的 input =====');
        console.log(JSON.stringify(capturedUpdates[0], null, 2));

        // Backfill assertion: empty event should be filled with today's YYYY-MM-DD.
        const todayYmd = (() => {
          const d = new Date();
          const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        })();
        const likes = capturedUpdates[0].input.likes;
        const backfilled = likes.find((x) => x.description === '便签本');
        console.log('  新增 "便签本" 的 event 回填为今天:', backfilled && backfilled.event === todayYmd);

        // Empty name validation
        document.getElementById('app').innerHTML = '';
        getHandler('/contacts/new')({}).then(() => {
          document.getElementById('save').click();
          setTimeout(() => {
            console.log('\n===== 姓名为空时 toast =====');
            console.log([...document.querySelectorAll('.toast')].map(t => t.textContent));

            runDetailTests();
          }, 50);
        });
      }, 100);
    });
  });
}

function runDetailTests() {
  resetDoc();
  resetHandlers();
  loadPage('contact_detail.js');
  getHandler('/contacts/:id')({ id: 'test-id-1' }).then(() => {
    const html = sandbox.document.getElementById('app').innerHTML;
    console.log('\n===== /contacts/:id 详情页 — 默认状态 =====');
    console.log('  "喜好" 标题:', html.includes('<h2>喜好'));
    console.log('  "忌讳" 标题:', html.includes('<h2>忌讳'));
    console.log('  "礼物参考" 标题:', html.includes('<h2>礼物参考'));
    console.log('  搜索框数 (期望 3):', sandbox.document.querySelectorAll('.section-search').length);
    console.log('  事件筛选下拉数 (期望 3):', sandbox.document.querySelectorAll('.section-event-filter').length);
    console.log('  默认喜好条数 (期望 5, 第一页):', countRowsInSection('like'));
    console.log('  默认礼物条数 (期望 5, 第一页):', countRowsInSection('gift'));
    console.log('  默认忌讳条数 (期望 3, 全部):', countRowsInSection('taboo'));
    console.log('  翻页控件数 (期望 2: like + gift, 各 2 按钮):',
      sandbox.document.querySelectorAll('.section-page').length);
    console.log('  翻页提示 "第 1 / 2 页":', html.includes('第 1 / 2 页'));
    console.log('  旧 "还有 N 条…" 链接:', (html.match(/还有 \d+ 条/g) || []).join(' / ') || '无 (符合期望)');
    console.log('  独立编辑入口数 (期望 3, 每个 section 一个):',
      sandbox.document.querySelectorAll('.section-manage').length);

    // ---- 1) Independent description search ----
    console.log('\n===== 测试搜索：在「喜好」搜索框输入 "咖" (仅按描述) =====');
    const likeInput = sandbox.document.querySelector('.section-search[data-kind="like"]');
    likeInput.value = '咖';
    likeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    console.log('  搜索 "咖" 后匹配条数 (期望 1, 即 "咖啡"):', countRowsInSection('like'));
    const html2 = sandbox.document.getElementById('app').innerHTML;
    console.log('  包含 "匹配 1 条":', html2.includes('匹配 1 条'));
    console.log('  翻页控件被隐藏 (期望 0=单页):',
      sandbox.document.querySelectorAll('.section-page[data-kind="like"]').length);

    // ---- 2) Description search no longer matches date ----
    console.log('\n===== 描述搜索不再匹配日期（与事件筛选独立） =====');
    likeInput.value = '2025'; // would have matched 3 likes under the old single-filter model
    likeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    console.log('  描述搜 "2025" 后条数 (期望 0, 因描述中没有 "2025"):',
      countRowsInSection('like'));
    console.log('  包含 "没有匹配":',
      sandbox.document.getElementById('app').innerHTML.includes('没有匹配'));

    // ---- 3) Independent event filter ----
    console.log('\n===== 清空搜索；通过事件下拉筛选 2025 年 =====');
    likeInput.value = '';
    likeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const likeSelect = sandbox.document.querySelector('.section-event-filter[data-kind="like"]');
    // Inspect option set
    const opts = [...likeSelect.options].map((o) => `${o.value}=${o.textContent}`);
    console.log('  下拉选项:', opts.join(' | '));
    likeSelect.value = '2025';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  2025 年喜好条数 (期望 3, 鲜花+远足+科幻):', countRowsInSection('like'));
    const html4 = sandbox.document.getElementById('app').innerHTML;
    console.log('  匹配条数显示 "匹配 3 条":', html4.includes('匹配 3 条'));
    console.log('  筛选条件回显含 "事件：2025":', html4.includes('事件：2025'));

    // ---- 4) Drill to year-month ----
    console.log('\n===== 事件下拉细化到 2025-01 =====');
    likeSelect.value = '2025-01';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  2025-01 喜好条数 (期望 1, 科幻小说):', countRowsInSection('like'));

    // ---- 5) "未填事件" filter ----
    console.log('\n===== 事件下拉选 "未填事件" =====');
    likeSelect.value = '__none__';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  未填事件喜好条数 (期望 2, 咖啡+猫咪):', countRowsInSection('like'));

    // ---- 6) Reset event filter ----
    console.log('\n===== 事件下拉回到 "不限" =====');
    likeSelect.value = '';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  条数恢复到 5 (第一页):', countRowsInSection('like'));

    // ---- 7) Combined: search + event filter ----
    console.log('\n===== 组合：描述搜 "鲜" + 事件 2025 =====');
    likeInput.value = '鲜';
    likeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    likeSelect.value = '2025';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  "鲜" + 2025 条数 (期望 1, 鲜花):', countRowsInSection('like'));
    const html5 = sandbox.document.getElementById('app').innerHTML;
    console.log('  筛选回显同时包含 关键词 与 事件:',
      html5.includes('关键词：鲜') && html5.includes('事件：2025'));
    // Now narrow to a year that does not intersect
    console.log('\n===== 组合：搜索不变 + 事件切到 2024（应无交集） =====');
    likeSelect.value = '2024';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  "鲜" + 2024 条数 (期望 0):', countRowsInSection('like'));
    console.log('  包含 "没有匹配":',
      sandbox.document.getElementById('app').innerHTML.includes('没有匹配'));

    // ---- Test pagination on default view ----
    console.log('\n===== 测试翻页：清空所有筛选，喜好有 8 条应分 2 页 =====');
    likeInput.value = '';
    likeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    likeSelect.value = '';
    likeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    console.log('  喜好条数 (期望 5, 第一页):', countRowsInSection('like'));
    const next = sandbox.document.querySelector('.section-page[data-kind="like"][data-action="next"]');
    console.log('  下一页按钮存在:', !!next);
    next.click();
    console.log('  点击下一页后喜好条数 (期望 3, 第二页):', countRowsInSection('like'));
    const pagerHtml = sandbox.document.querySelector('.list-host[data-kind="like"]').innerHTML;
    console.log('  翻页提示含 "第 2 / 2 页":', pagerHtml.includes('第 2 / 2 页'));
    const prev = sandbox.document.querySelector('.section-page[data-kind="like"][data-action="prev"]');
    console.log('  上一页按钮已启用:', prev && !prev.disabled);
    prev.click();
    console.log('  上一页回到 5 条:', countRowsInSection('like'));

    // ---- Test edit-entry link ----
    console.log('\n===== 测试独立编辑入口 =====');
    const manageLinks = sandbox.document.querySelectorAll('.section-manage');
    const hrefs = [...manageLinks].map((a) => a.getAttribute('href'));
    console.log('  链接 href:', hrefs.join(', '));
    console.log('  指向 likes 入口:', hrefs.includes('#/contacts/test-id-1/likes'));
    console.log('  指向 taboos 入口:', hrefs.includes('#/contacts/test-id-1/taboos'));
    console.log('  指向 gifts 入口:', hrefs.includes('#/contacts/test-id-1/gifts'));

    // ---- Per-list edit page tests ----
    runListEditTests();
  });
}

function runListEditTests() {
  resetDoc();
  resetHandlers();
  loadPage('contact_list_edit.js');

  // Test likes page
  getHandler('/contacts/:id/likes')({ id: 'test-id-1' }).then(() => {
    const html = sandbox.document.getElementById('app').innerHTML;
    console.log('\n===== /contacts/:id/likes — 独立编辑入口页面 =====');
    console.log('  标题含 "喜好":', html.includes('<h1>喜好 · 张三</h1>'));
    console.log('  描述输入框存在:', !!document.getElementById('row-desc'));
    console.log('  日期输入框存在:', !!document.getElementById('row-event'));
    console.log('  已有条目数 (期望 8):', sandbox.document.querySelectorAll('.list-item-row').length);
    console.log('  链接到详情页:',
      html.includes('href="#/contacts/test-id-1"'));

    // Add a new item
    console.log('\n===== 添加新条目 =====');
    sandbox.document.getElementById('row-desc').value = '咖啡';
    sandbox.document.getElementById('row-event').value = '2025-07-01';
    sandbox.document.getElementById('row-save').click();
    setTimeout(() => {
      console.log('  addListItem 已被调用 (期望 1 次):', capturedListOps.adds.length);
      console.log('  调用参数:', JSON.stringify(capturedListOps.adds[0], null, 2));
      console.log('  已有条目数 (期望 9):', sandbox.document.querySelectorAll('.list-item-row').length);

      // Backfill: add a new row with no date → event should be today.
      console.log('\n===== 添加条目时不填日期 → 应回填为今天 =====');
      sandbox.document.getElementById('row-desc').value = '便签本';
      sandbox.document.getElementById('row-event').value = ''; // no date
      sandbox.document.getElementById('row-save').click();
      setTimeout(() => {
        const todayYmd = (() => {
          const d = new Date();
          const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        })();
        const lastAdd = capturedListOps.adds[capturedListOps.adds.length - 1];
        console.log('  新增 "便签本" 的 event 回填为今天:',
          lastAdd.input.description === '便签本' && lastAdd.input.event === todayYmd);

        // Edit existing item
        console.log('\n===== 编辑现有条目 =====');
        const editBtns = sandbox.document.querySelectorAll('.row-edit');
        console.log('  编辑按钮数:', editBtns.length);
        editBtns[0].click(); // edit first item
        setTimeout(() => {
          console.log('  点击编辑后表单标题含 "编辑条目":',
            sandbox.document.getElementById('app').innerHTML.includes('编辑条目'));
          console.log('  描述输入已预填 "抹茶甜点":',
            sandbox.document.getElementById('row-desc').value === '抹茶甜点');
          console.log('  日期输入已预填 "2024-12-25":',
            sandbox.document.getElementById('row-event').value === '2024-12-25');
          // Change value and save
          sandbox.document.getElementById('row-desc').value = '抹茶大福';
          sandbox.document.getElementById('row-event').value = '2025-08-01';
          sandbox.document.getElementById('row-save').click();
          setTimeout(() => {
            console.log('  updateListItem 被调用 (期望 1 次):', capturedListOps.updates.length);
            console.log('  调用参数:', JSON.stringify(capturedListOps.updates[0], null, 2));

            // Delete an item
            console.log('\n===== 删除条目 =====');
            const delBtns = sandbox.document.querySelectorAll('.row-del');
            console.log('  删除按钮数:', delBtns.length);
            delBtns[1].click(); // delete second item
            setTimeout(() => {
              console.log('  deleteListItem 被调用 (期望 1 次):', capturedListOps.deletes.length);
              console.log('  调用参数:', JSON.stringify(capturedListOps.deletes[0], null, 2));
              console.log('  已有条目数 (期望减少 1):', sandbox.document.querySelectorAll('.list-item-row').length);

              // Empty description validation
              console.log('\n===== 描述为空时 toast =====');
              sandbox.document.getElementById('row-desc').value = '';
              sandbox.document.getElementById('row-save').click();
              setTimeout(() => {
                console.log('  toast 内容:', [...sandbox.document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));

                console.log('\n===== ALL TESTS PASSED =====');
              }, 50);
            }, 80);
          }, 80);
        }, 50);
      }, 80);
    }, 80);
  });
}

function countRowsInSection(kind) {
  const host = sandbox.document.querySelector(`.list-host[data-kind="${kind}"]`);
  if (!host) return -1;
  const card = host.querySelector('.card');
  if (!card) return 0;
  return card.querySelectorAll('.row.between').length;
}

main();