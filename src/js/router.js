// src/js/router.js — tiny hash-based router
const routes = {};
let onChangeCb = null;

export function register(path, handler) {
  routes[path] = handler;
}

export function onChange(cb) { onChangeCb = cb; }

function parseHash() {
  const h = (location.hash || '#/').slice(1); // drop leading #
  const [path, query] = h.split('?');
  const params = {};
  if (query) {
    for (const kv of query.split('&')) {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  // Match path with optional :param. Static (non-parameterized) patterns are
  // matched BEFORE parameterized ones so that e.g. "/contacts/new" wins over
  // "/contacts/:id" regardless of registration order. This is critical —
  // otherwise "new" gets parsed as an id and contacts:get("new") returns null.
  const patterns = Object.keys(routes);
  const staticPatterns = patterns.filter((p) => !p.includes(':'));
  const dynamicPatterns = patterns.filter((p) => p.includes(':'));
  for (const pattern of [...staticPatterns, ...dynamicPatterns]) {
    const pp = pattern.split('/').filter(Boolean);
    const aa = path.split('/').filter(Boolean);
    if (pp.length !== aa.length) continue;
    let ok = true;
    const args = {};
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) {
        args[pp[i].slice(1)] = decodeURIComponent(aa[i]);
      } else if (pp[i] !== aa[i]) {
        ok = false; break;
      }
    }
    if (ok) return { handler: routes[pattern], args, params, path, query: query || '' };
  }
  return null;
}

export async function dispatch() {
  const m = parseHash();
  if (!m) {
    location.hash = '#/';
    return;
  }
  if (onChangeCb) onChangeCb(m.path);
  try {
    await m.handler(m.args, m.params);
  } catch (e) {
    console.error('route error', e);
    document.getElementById('app').innerHTML =
      `<div class="empty">出错了：${(e && e.message) || e}</div>`;
  }
}

export function navigate(path) {
  location.hash = '#' + path;
}

export function start() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) location.hash = '#/';
  dispatch();
}