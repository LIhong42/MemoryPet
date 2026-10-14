// scripts/hoist-call-bind-helpers.js
//
// electron-builder 在打包时会把 'call-bind-apply-helpers' 嵌套到某个顶层
// 包（如 call-bind）的 node_modules 下，但其他顶层包（如 get-intrinsic、
// object.assign、dunder-proto）也会直接 require 它——它们需要自己 '向上'
// 找到顶层副本，顶层副本却不存在了，于是运行时抛 'Cannot find module'。
//
// 在打包前为每个直接 require 该 helper 的顶层包创建一份私有嵌套副本，
// 让运行时从任何发起方都能命中。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'node_modules');
const HELPER = 'call-bind-apply-helpers';
const TOP_LEVEL_PKGS = ['call-bind', 'call-bound', 'dunder-proto', 'get-intrinsic', 'object.assign'];

const helperSrc = path.join(ROOT, HELPER);
if (!fs.existsSync(helperSrc)) {
  console.error(`[hoist] helper not found at ${helperSrc}`);
  process.exit(1);
}

for (const pkg of TOP_LEVEL_PKGS) {
  const dest = path.join(ROOT, pkg, 'node_modules', HELPER);
  if (fs.existsSync(dest)) {
    console.log(`[hoist] ${pkg}: already exists, skip`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 同步拷贝：递归创建硬链接更快，但 fs.copyFileSync 在 Windows 上
  // 也很快。
  copyDir(helperSrc, dest);
  console.log(`[hoist] ${pkg}: copied -> ${path.relative(ROOT, dest)}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyDir(s, d);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
