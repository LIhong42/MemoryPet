// src/js/pages/album_editor.js — WYSIWYG album layout editor.
//
// Embedded inside /export. Toggled via state.view = 'editor' in export.js.
// Renders an editing surface for an AlbumLayout: theme switcher, page
// thumbnails, a per-page canvas with photo slots + text slots, a property
// inspector for the selected slot, and a bottom photo palette to drag
// new photos into empty slots.
//
// Pointer events are used throughout for drag-and-drop (HTML5 drag has
// no precedent in this codebase; pointer events also unify canvas pan
// with photo drag in v1).
//
// Public API:
//   mountEditor({ container, events, onBack, onExport })
//   destroyEditor()
//
// State is module-level (single instance, single page).

import {
  api,
  escapeHtml,
  toast,
  fetchPhotoDataUrl,
} from '../api.js';
import {
  THEMES,
  LAYOUT_TEMPLATES,
  getTheme,
  getLayoutTemplate,
  getPageDims,
  slotRect,
  slotRectCss,
  computePhotoDrawRect,
} from '../album_layouts.js';
import {
  buildAlbumLayout,
  remapPageTemplate,
} from '../album_builder.js';

// ---- state -----------------------------------------------------------------

const state = {
  container: null,
  events: [],          // memorial events with photos
  eventById: new Map(),// eventId → event
  photoById: new Map(),// photoId → {id, eventId, full_path, mime, ...}
  layout: null,        // AlbumLayout (mutated in place)
  selectedPageIdx: 0,
  selectedSlotIdx: null,
  selectedSlotType: null, // 'photo' | 'text' | null
  editingPhotoSlotIdx: null, // photo slot in "pan/zoom edit" mode
  // Drag state (single active drag at a time)
  drag: null,
  // Computed CSS pixel size of the current page canvas (depends on
  // container width)
  canvasPx: { w: 0, h: 0, scale: 1 },
  // Resize observer handle
  resizeObserver: null,
  // Cached photo data URLs (Map<photoId, dataUrl>)
  photoUrls: new Map(),
};

// ---- mount / destroy --------------------------------------------------------

export function mountEditor({ container, events, onBack, onExport }) {
  state.container = container;
  state.events = events || [];
  state.eventById = new Map(state.events.map((e) => [e.id, e]));
  state.photoById = new Map();
  state.events.forEach((e) => {
    (e.photos || []).forEach((p) => state.photoById.set(p.id, { ...p, eventId: e.id }));
  });
  state.onBack = onBack;
  state.onExport = onExport;

  // Build initial layout
  state.layout = buildAlbumLayout(state.events, { themeId: 'classic' });
  state.selectedPageIdx = 0;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.editingPhotoSlotIdx = null;
  state.photoUrls = new Map();

  renderShell();
  applyTheme(state.layout.themeId);
  computeCanvasSize();
  renderPageThumbs();
  renderActivePage();
  renderPhotoPalette();
  setupResizeObserver();
  // Pre-warm the photo URL cache for the current page
  prefetchPagePhotos(state.selectedPageIdx);
}

export function destroyEditor() {
  if (state.resizeObserver) {
    try { state.resizeObserver.disconnect(); } catch {}
    state.resizeObserver = null;
  }
  cleanupDrag();
  if (state.photoPan) {
    state.photoPan = null;
    window.removeEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
    window.removeEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
  }
  if (state.textPan) {
    state.textPan = null;
    window.removeEventListener('pointermove', onWindowTextPanMove, { capture: true });
    window.removeEventListener('pointerup', onWindowTextPanUp, { capture: true });
  }
  state.container = null;
  state.layout = null;
  state.events = [];
  state.eventById = new Map();
  state.photoById = new Map();
  state.photoUrls = new Map();
}

// ---- render: shell ---------------------------------------------------------

function renderShell() {
  state.container.innerHTML = `
    <div class="album-editor" data-theme="${escapeHtml(state.layout.themeId)}">
      <div class="album-toolbar">
        <button class="btn secondary" id="album-back-btn" type="button">← 返回筛选</button>
        <div class="album-toolbar-spacer"></div>
        <label class="album-toolbar-field">
          <span>主题</span>
          <select id="album-theme-select">
            ${THEMES.map((t) => `<option value="${escapeHtml(t.id)}" ${
              t.id === state.layout.themeId ? 'selected' : ''
            }>${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </label>
        <label class="album-toolbar-field" id="album-template-toolbar-field" style="display:none;">
          <span>版式</span>
          <select id="album-template-select">
            ${LAYOUT_TEMPLATES.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn" id="album-export-btn" type="button">导出 PDF</button>
      </div>
      <div class="album-body">
        <aside class="album-side album-side-left">
          <div class="album-side-title">页面 <span id="album-page-count">${state.layout.pages.length}</span></div>
          <div class="album-page-thumbs" id="album-page-thumbs"></div>
          <button class="btn secondary album-add-page" id="album-add-page-btn" type="button">+ 新页</button>
        </aside>
        <main class="album-canvas-wrap" id="album-canvas-wrap">
          <div class="album-canvas" id="album-canvas" data-theme="${escapeHtml(state.layout.themeId)}"></div>
        </main>
        <aside class="album-side album-side-right" id="album-inspector"></aside>
      </div>
      <div class="album-palette" id="album-palette">
        <div class="album-palette-title">照片 · 拖到画布</div>
        <div class="album-palette-strip" id="album-palette-strip"></div>
      </div>
    </div>
  `;
  // Wire shell-level handlers
  state.container.querySelector('#album-back-btn').onclick = handleBack;
  state.container.querySelector('#album-export-btn').onclick = handleExport;
  state.container.querySelector('#album-theme-select').onchange = (e) => {
    state.layout.themeId = e.target.value;
    applyTheme(state.layout.themeId);
    // Theme change doesn't move slots, just colors. Re-render canvas only.
    renderActivePage();
  };
  const tplSelect = state.container.querySelector('#album-template-select');
  tplSelect.onchange = (e) => handleChangePageTemplate(state.selectedPageIdx, e.target.value);
  // Page thumb strip + add page
  state.container.querySelector('#album-add-page-btn').onclick = handleAddPage;
  // Palette drag
  state.container.querySelector('#album-palette-strip').onpointerdown = onPalettePointerDown;
}

function applyTheme(themeId) {
  const root = state.container.querySelector('.album-editor');
  if (!root) return;
  root.setAttribute('data-theme', themeId);
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) canvas.setAttribute('data-theme', themeId);
  const theme = getTheme(themeId);
  // Set CSS custom properties on the canvas wrapper so both editor chrome
  // and inner slots pick them up uniformly
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (wrap) {
    wrap.style.setProperty('--theme-bg', theme.cssVar.bg);
    wrap.style.setProperty('--theme-surface', theme.cssVar.surface);
    wrap.style.setProperty('--theme-text', theme.cssVar.text);
    wrap.style.setProperty('--theme-muted', theme.cssVar.muted);
    wrap.style.setProperty('--theme-accent', theme.cssVar.accent);
    wrap.style.setProperty('--theme-accent-dark', theme.cssVar.accentDark);
    wrap.style.setProperty('--theme-ribbon', theme.cssVar.ribbon);
    wrap.style.setProperty('--theme-title-size', `${theme.size.title}pt`);
    wrap.style.setProperty('--theme-body-size', `${theme.size.body}pt`);
    wrap.style.setProperty('--theme-caption-size', `${theme.size.caption}pt`);
  }
}

function setupResizeObserver() {
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (!wrap || typeof ResizeObserver === 'undefined') return;
  if (state.resizeObserver) {
    try { state.resizeObserver.disconnect(); } catch {}
  }
  state.resizeObserver = new ResizeObserver(() => {
    computeCanvasSize();
    renderActivePage();
  });
  state.resizeObserver.observe(wrap);
}

function computeCanvasSize() {
  const wrap = state.container.querySelector('#album-canvas-wrap');
  if (!wrap) return;
  // Use a small inset so the canvas isn't flush against the inspector
  const availW = Math.max(280, wrap.clientWidth - 24);
  const availH = Math.max(220, wrap.clientHeight - 24);
  // Maintain theme page AR
  const pageDims = getPageDims(state.layout.pageShape);
  const pageAR = pageDims.w / pageDims.h;
  let w = availW;
  let h = w / pageAR;
  if (h > availH) {
    h = availH;
    w = h * pageAR;
  }
  state.canvasPx = { w, h, scale: w / pageDims.w };
  const canvas = state.container.querySelector('#album-canvas');
  if (canvas) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

// ---- render: page thumbs ----------------------------------------------------

function renderPageThumbs() {
  const wrap = state.container.querySelector('#album-page-thumbs');
  if (!wrap) return;
  const total = state.layout.pages.length;
  document.getElementById('album-page-count').textContent = String(total);
  const html = [];
  for (let i = 0; i < total; i += 1) {
    const page = state.layout.pages[i];
    const tpl = getLayoutTemplate(page.templateId);
    const photoCount = page.slots.filter((s) => s.type === 'photo' && s.photoId).length;
    const textCount = page.slots.filter((s) => s.type !== 'photo').length;
    const isActive = i === state.selectedPageIdx;
    html.push(`
      <button type="button"
        class="album-page-thumb ${isActive ? 'is-active' : ''}"
        data-page-idx="${i}">
        <div class="album-page-thumb-num">${i + 1}</div>
        <div class="album-page-thumb-mini" data-page-thumb-idx="${i}"></div>
        <div class="album-page-thumb-meta">${photoCount}图·${textCount}文</div>
      </button>
    `);
  }
  wrap.innerHTML = html.join('');
  wrap.querySelectorAll('.album-page-thumb').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-page-idx'));
      selectPage(idx);
    };
  });
  // Render mini previews of each page (cheap absolute-positioned dots)
  for (let i = 0; i < total; i += 1) {
    const mini = wrap.querySelector(`[data-page-thumb-idx="${i}"]`);
    if (mini) renderPageMini(mini, state.layout.pages[i]);
  }
}

function renderPageMini(hostEl, page) {
  const tpl = getLayoutTemplate(page.templateId);
  // Fixed 80x52 mini canvas
  const W = 80, H = 52;
  const parts = [];
  for (const s of tpl.slots) {
    const r = slotRect(s, W, H, 2);
    let bg;
    if (s.type === 'photo') {
      const filled = page.slots.find((ps) => ps.type === 'photo' && ps._slotTemplate && ps._slotTemplate.x === s.x && ps._slotTemplate.y === s.y);
      bg = filled && filled.photoId ? '#888' : '#ddd';
    } else {
      bg = '#bbb';
    }
    parts.push(`<div style="position:absolute;left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px;background:${bg};border-radius:1px;"></div>`);
  }
  hostEl.innerHTML = `<div style="position:relative;width:${W}px;height:${H}px;background:#fff;border:1px solid #ccc;">${parts.join('')}</div>`;
}

function selectPage(idx) {
  if (idx < 0 || idx >= state.layout.pages.length) return;
  state.selectedPageIdx = idx;
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  state.editingPhotoSlotIdx = null;
  renderPageThumbs();
  renderActivePage();
}

// ---- render: active page canvas ---------------------------------------------

function renderActivePage() {
  const canvas = state.container.querySelector('#album-canvas');
  if (!canvas) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) {
    canvas.innerHTML = `<div class="album-empty">空相册</div>`;
    return;
  }
  const tpl = getLayoutTemplate(page.templateId);
  const pageDims = getPageDims(state.layout.pageShape);
  const pw = state.canvasPx.w;
  const ph = state.canvasPx.h;
  // Build slot DOM in original template order so we can map back to slotIdx
  // via the same index. We also tag each photo slot with its photoId so
  // the drop handler can resolve which slot was hit.
  const theme = getTheme(state.layout.themeId);

  // Decorative ribbon (theme-driven)
  let deco = '';
  if (theme.chrome && theme.chrome.showRibbon) {
    deco += `<div class="album-ribbon album-ribbon-left"></div>`;
  }

  const slotsHtml = tpl.slots.map((slot, slotIdx) => {
    // Find the actual content slot for this template slot. Because builder
    // creates slots in template order (photo slots first then text slots),
    // we use position-based matching: walk through page.slots in order and
    // find the i-th one matching slot.type at position slotIdx.
    const content = findContentForTemplateSlot(page, slot, slotIdx);
    const r = slotRect(slot, pw, ph, slot.padding || 0);
    return renderSlot(content, slot, slotIdx, r, theme);
  }).join('');

  canvas.innerHTML = deco + slotsHtml;

  // Per-slot pointer handlers
  canvas.querySelectorAll('[data-slot-idx]').forEach((el) => {
    const slotIdx = Number(el.getAttribute('data-slot-idx'));
    el.onpointerdown = (e) => onCanvasSlotPointerDown(e, slotIdx);
  });
  // Wheel handler on the canvas — drives photo zoom when over a photo slot
  canvas.onwheel = onCanvasWheel;
  // Pointer up on the canvas itself catches drops into empty space
  canvas.onpointerup = onCanvasPointerUp;
  canvas.onpointermove = onCanvasPointerMove;

  // Inspector
  renderInspector();
  // Update toolbar template select to current
  const tplSelect = state.container.querySelector('#album-template-select');
  if (tplSelect) tplSelect.value = page.templateId;
}

// Map a template slot at index slotIdx to its content slot in page.slots.
// page.slots is built in template order (photos first, then text) so we
// walk through tpl.slots and consume page.slots in lockstep. We match
// by checking the stored _slotTemplate coords to be defensive against
// future re-orderings.
function findContentForTemplateSlot(page, templateSlot, slotIdx) {
  // Look for content whose _slotTemplate matches this templateSlot exactly
  return page.slots.find((s) =>
    s._slotTemplate
    && s._slotTemplate.x === templateSlot.x
    && s._slotTemplate.y === templateSlot.y
    && s._slotTemplate.w === templateSlot.w
    && s._slotTemplate.h === templateSlot.h
  ) || null;
}

function renderSlot(content, templateSlot, slotIdx, r, theme) {
  const isPhoto = templateSlot.type === 'photo';
  const isSelected = state.selectedSlotIdx === slotIdx;
  const isEditing = state.editingPhotoSlotIdx === slotIdx;
  const baseStyle = `left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px;`;
  const cls = [
    'album-slot',
    `album-slot-${templateSlot.type}`,
    isSelected ? 'is-selected' : '',
    isEditing ? 'is-editing' : '',
    isPhoto ? (content && content.photoId ? '' : 'is-empty') : '',
  ].filter(Boolean).join(' ');
  if (isPhoto) {
    const photoId = content && content.photoId;
    const url = photoId ? (state.photoUrls.get(photoId) || '') : '';
    const transform = (content && content.transform) || { x: 50, y: 50, zoom: 1 };
    return `
      <div class="${cls}" data-slot-idx="${slotIdx}" data-slot-type="photo" style="${baseStyle}">
        ${photoId ? `
          <div class="album-photo" data-photo-id="${escapeHtml(photoId)}" style="
            position:absolute;
            ${(() => {
              // Compute draw rect using natural AR if available
              const photo = state.photoById.get(photoId);
              let srcW = photo && photo.width ? photo.width : 4;
              let srcH = photo && photo.height ? photo.height : 3;
              // Cover-style baseline. Without real AR we approximate 4:3.
              const dRect = computePhotoDrawRect(r, srcW, srcH, transform);
              return `left:${dRect.x.toFixed(1)}px;top:${dRect.y.toFixed(1)}px;width:${dRect.width.toFixed(1)}px;height:${dRect.height.toFixed(1)}px;`;
            })()}
          ">
            ${url ? `<img src="${escapeHtml(url)}" alt="" draggable="false"/>` : `<div class="album-photo-loading">加载中…</div>`}
          </div>
        ` : `<div class="album-photo-empty">拖照片到此处</div>`}
        ${isEditing && photoId ? renderPhotoEditControls() : ''}
      </div>
    `;
  }
  // Text slot
  const text = (content && content.text) || '';
  const editable = isSelected;
  const textOffset = (content && content.textOffset) || { x: 0, y: 0 };
  // CSS px = pt * 96/72, so for fidelity with the PDF (which uses pt) we
  // scale the theme's font-size by 96/72.
  const fontPx = templateSlot.type === 'title'
    ? Math.round(theme.size.title * 96 / 72)
    : Math.round(theme.size.caption * 96 / 72);
  return `
    <div class="${cls}" data-slot-idx="${slotIdx}" data-slot-type="${templateSlot.type}" style="${baseStyle}">
      <div class="album-text ${editable ? 'is-selected' : ''}" data-text-idx="${slotIdx}"
           style="transform: translate(${textOffset.x}px, ${textOffset.y}px);">
        ${templateSlot.type === 'title'
          ? `<div class="album-text-title" data-text-role="title" style="font-size:${fontPx}px;">${escapeHtml(text)}</div>`
          : `<div class="album-text-caption" data-text-role="caption" style="font-size:${fontPx}px;">${escapeHtml(text)}</div>`}
      </div>
    </div>
  `;
}

function renderPhotoEditControls() {
  return `
    <div class="album-photo-edit-controls">
      <button type="button" data-photo-action="zoom-out" title="缩小">−</button>
      <button type="button" data-photo-action="reset" title="重置">↺</button>
      <button type="button" data-photo-action="zoom-in" title="放大">+</button>
      <button type="button" data-photo-action="done" title="完成">✓</button>
    </div>
  `;
}

// ---- render: inspector ------------------------------------------------------

function renderInspector() {
  const host = state.container.querySelector('#album-inspector');
  if (!host) return;
  const page = state.layout.pages[state.selectedPageIdx];
  if (!page) {
    host.innerHTML = '<div class="album-inspector-empty">未选择页面</div>';
    return;
  }
  if (state.selectedSlotIdx == null) {
    // Page-level inspector: change template, page meta
    const tpl = getLayoutTemplate(page.templateId);
    const eventId = page.eventId;
    const ev = state.eventById.get(eventId);
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">当前页 · 第 ${state.selectedPageIdx + 1} 页</div>
        <div class="album-inspector-meta">${escapeHtml(tpl.name)} · ${page.slots.filter((s) => s.type === 'photo').length} 图 · ${page.slots.filter((s) => s.type !== 'photo').length} 文</div>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">换版式</div>
        <div class="album-inspector-templates">
          ${LAYOUT_TEMPLATES.map((t) => `
            <button type="button" class="album-inspector-tpl ${
              t.id === page.templateId ? 'is-active' : ''
            }" data-tpl-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>
          `).join('')}
        </div>
      </div>
      ${ev ? `
      <div class="album-inspector-section">
        <div class="album-inspector-label">所属事件</div>
        <div class="album-inspector-meta">${escapeHtml(ev.title || '(无标题)')}</div>
      </div>
      ` : ''}
      <div class="album-inspector-section">
        <button type="button" class="btn secondary" id="album-delete-page-btn">删除此页</button>
      </div>
    `;
    host.querySelectorAll('.album-inspector-tpl').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        handleChangePageTemplate(state.selectedPageIdx, btn.getAttribute('data-tpl-id'));
      };
    });
    const delBtn = host.querySelector('#album-delete-page-btn');
    if (delBtn) delBtn.onclick = handleDeletePage;
    return;
  }
  // Slot-level inspector
  const content = page.slots[state.selectedSlotIdx];
  if (!content) {
    host.innerHTML = '<div class="album-inspector-empty">空 slot</div>';
    return;
  }
  if (content.type === 'photo') {
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">照片</div>
        <div class="album-inspector-meta">${content.photoId ? '已放置' : '空槽位'}</div>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">变换 (pan / zoom)</div>
        <div class="album-inspector-row">
          <label>X <input type="range" min="0" max="100" id="album-pan-x" value="${content.transform.x}"/></label>
          <label>Y <input type="range" min="0" max="100" id="album-pan-y" value="${content.transform.y}"/></label>
          <label>缩放 <input type="range" min="1" max="40" id="album-zoom" value="${Math.round(content.transform.zoom * 10)}"/></label>
        </div>
        <div class="album-inspector-row">
          <button type="button" class="btn secondary" id="album-photo-reset">重置变换</button>
          ${content.photoId ? '<button type="button" class="btn secondary" id="album-photo-remove">移除照片</button>' : ''}
        </div>
      </div>
    `;
    wirePhotoInspector(content);
  } else {
    const offX = (content.textOffset && content.textOffset.x) || 0;
    const offY = (content.textOffset && content.textOffset.y) || 0;
    host.innerHTML = `
      <div class="album-inspector-section">
        <div class="album-inspector-title">${content.type === 'title' ? '标题' : '说明文字'}</div>
        <textarea class="album-inspector-text" id="album-text-input" rows="6">${escapeHtml(content.text || '')}</textarea>
        <div class="album-inspector-row" style="margin-top:6px;">
          <button type="button" class="btn secondary" id="album-text-reset">重置为默认</button>
        </div>
      </div>
      <div class="album-inspector-section">
        <div class="album-inspector-label">位置偏移 (px · 与 PDF 一致)</div>
        <div class="album-inspector-row">
          <label>X <input type="range" min="-200" max="200" id="album-text-x" value="${Math.round(offX)}"/></label>
          <label>Y <input type="range" min="-120" max="120" id="album-text-y" value="${Math.round(offY)}"/></label>
        </div>
        <div class="album-inspector-row">
          <button type="button" class="btn secondary" id="album-text-offset-reset">重置位置</button>
        </div>
      </div>
    `;
    const ta = host.querySelector('#album-text-input');
    if (ta) {
      ta.oninput = (e) => {
        content.text = e.target.value;
        // Update the rendered text in place to keep WYSIWYG in sync
        const el = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
        if (el) el.textContent = content.text;
      };
    }
    const reset = host.querySelector('#album-text-reset');
    if (reset) {
      reset.onclick = () => {
        const ev = state.eventById.get(page.eventId);
        if (content.type === 'title') {
          content.text = ev ? (ev.title || '') : '';
        } else {
          // Re-build the default caption from the event
          import('../album_builder.js').then((mod) => {
            content.text = mod.buildEventCaption(ev || {});
            ta.value = content.text || '';
            const el = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
            if (el) el.textContent = content.text;
          });
        }
        if (content.type === 'title') {
          ta.value = content.text || '';
          const el = state.container.querySelector(`[data-slot-idx="${state.selectedSlotIdx}"] [data-text-role]`);
          if (el) el.textContent = content.text;
        }
      };
    }
    // Text position offset controls
    const xRange = host.querySelector('#album-text-x');
    const yRange = host.querySelector('#album-text-y');
    if (xRange) xRange.oninput = (e) => {
      content.textOffset = content.textOffset || { x: 0, y: 0 };
      content.textOffset.x = Number(e.target.value);
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
    if (yRange) yRange.oninput = (e) => {
      content.textOffset = content.textOffset || { x: 0, y: 0 };
      content.textOffset.y = Number(e.target.value);
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
    const offReset = host.querySelector('#album-text-offset-reset');
    if (offReset) offReset.onclick = () => {
      content.textOffset = { x: 0, y: 0 };
      if (xRange) xRange.value = '0';
      if (yRange) yRange.value = '0';
      updateTextOffset(state.selectedPageIdx, state.selectedSlotIdx);
    };
  }
}

function wirePhotoInspector(content) {
  const root = state.container.querySelector('#album-inspector');
  if (!root) return;
  const xRange = root.querySelector('#album-pan-x');
  const yRange = root.querySelector('#album-pan-y');
  const zRange = root.querySelector('#album-zoom');
  if (xRange) xRange.oninput = (e) => {
    content.transform.x = Number(e.target.value);
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  if (yRange) yRange.oninput = (e) => {
    content.transform.y = Number(e.target.value);
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  if (zRange) zRange.oninput = (e) => {
    content.transform.zoom = Number(e.target.value) / 10;
    updateSlotPhotoTransform(state.selectedPageIdx, state.selectedSlotIdx);
  };
  const reset = root.querySelector('#album-photo-reset');
  if (reset) reset.onclick = () => {
    content.transform = { x: 50, y: 50, zoom: 1 };
    renderActivePage();
  };
  const remove = root.querySelector('#album-photo-remove');
  if (remove) remove.onclick = () => {
    content.photoId = null;
    content.empty = true;
    renderActivePage();
  };
}

function updateSlotPhotoTransform(pageIdx, slotIdx) {
  const page = state.layout.pages[pageIdx];
  if (!page) return;
  const content = page.slots[slotIdx];
  if (!content || content.type !== 'photo') return;
  const tpl = getLayoutTemplate(page.templateId);
  const templateSlot = tpl.slots[slotIdx];
  if (!templateSlot) return;
  const pw = state.canvasPx.w;
  const ph = state.canvasPx.h;
  const r = slotRect(templateSlot, pw, ph, templateSlot.padding || 0);
  const photo = state.photoById.get(content.photoId);
  const srcW = photo && photo.width ? photo.width : 4;
  const srcH = photo && photo.height ? photo.height : 3;
  const dRect = computePhotoDrawRect(r, srcW, srcH, content.transform);
  const photoEl = state.container.querySelector(
    `[data-slot-idx="${slotIdx}"] .album-photo`
  );
  if (photoEl) {
    photoEl.style.left = `${dRect.x.toFixed(1)}px`;
    photoEl.style.top = `${dRect.y.toFixed(1)}px`;
    photoEl.style.width = `${dRect.width.toFixed(1)}px`;
    photoEl.style.height = `${dRect.height.toFixed(1)}px`;
  }
}

// Apply text offset to the slot's text wrapper in place (no full re-render).
function updateTextOffset(pageIdx, slotIdx) {
  const content = state.layout.pages[pageIdx] && state.layout.pages[pageIdx].slots[slotIdx];
  if (!content) return;
  const off = content.textOffset || { x: 0, y: 0 };
  const wrap = state.container.querySelector(
    `[data-slot-idx="${slotIdx}"] [data-text-idx]`
  );
  if (wrap) {
    wrap.style.transform = `translate(${off.x || 0}px, ${off.y || 0}px)`;
  }
}

// ---- render: photo palette --------------------------------------------------

function renderPhotoPalette() {
  const strip = state.container.querySelector('#album-palette-strip');
  if (!strip) return;
  // Build a deduplicated list of all photos across all events
  const seen = new Set();
  const photos = [];
  for (const ev of state.events) {
    for (const p of (ev.photos || [])) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      photos.push(p);
    }
  }
  if (photos.length === 0) {
    strip.innerHTML = '<div class="album-palette-empty">没有可拖动的照片</div>';
    return;
  }
  strip.innerHTML = photos.map((p) => `
    <div class="album-palette-item" data-photo-id="${escapeHtml(p.id)}" title="${escapeHtml(p.original_name || p.id)}">
      <div class="album-palette-thumb" data-photo-thumb-id="${escapeHtml(p.id)}"></div>
    </div>
  `).join('');
  // Fetch data URLs (uses the existing cache)
  photos.forEach((p) => {
    fetchPhotoDataUrl(p.id).then((url) => {
      if (!url) return;
      state.photoUrls.set(p.id, url);
      const slot = state.container.querySelector(`[data-photo-thumb-id="${CSS.escape(p.id)}"]`);
      if (slot) slot.innerHTML = `<img src="${escapeHtml(url)}" alt="" draggable="false"/>`;
    }).catch(() => {});
  });
}

// ---- pointer events: palette → canvas drag ----------------------------------
//
// Single drag state machine. pointerdown on a palette item OR a canvas photo
// slot starts a drag; pointermove tracks; pointerup resolves into the target
// slot (if any).

function onPalettePointerDown(e) {
  const item = e.target.closest('.album-palette-item');
  if (!item) return;
  e.preventDefault();
  const photoId = item.getAttribute('data-photo-id');
  if (!photoId) return;
  startDrag({
    kind: 'palette',
    photoId,
    sourceSlotIdx: null,
    sourcePageIdx: null,
    ghostText: item.getAttribute('title') || '',
  }, e);
}

function onCanvasSlotPointerDown(e, slotIdx) {
  // Click selects the slot. If a drag is in progress this won't fire because
  // we captured the pointer. Pointer up handler resolves the drop.
  const el = e.currentTarget;
  const slotType = el.getAttribute('data-slot-type');
  state.selectedSlotIdx = slotIdx;
  state.selectedSlotType = slotType;
  if (slotType === 'photo') {
    const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
    if (content && content.photoId) {
      // Alt (or middle-click) → pan the photo itself (adjust transform.x/y)
      // Otherwise → start slot→slot drag for swap/move.
      if (e.altKey || e.metaKey || e.button === 1) {
        e.preventDefault();
        startPhotoPan(slotIdx, e);
        return;
      }
      e.preventDefault();
      startDrag({
        kind: 'slot',
        photoId: content.photoId,
        sourceSlotIdx: slotIdx,
        sourcePageIdx: state.selectedPageIdx,
        ghostText: '',
      }, e);
    } else {
      // Empty photo slot — select only
      renderActivePage();
      return;
    }
  } else {
    // Text slot — Alt/Meta drag moves the text (updates textOffset). Plain
    // click only selects.
    if (e.altKey || e.metaKey || e.button === 1) {
      e.preventDefault();
      startTextPan(slotIdx, e);
      return;
    }
    renderActivePage();
  }
}

// ---- direct photo pan/zoom --------------------------------------------------
//
// When the user holds Alt and drags a photo on the canvas, the photo's
// transform.x/y is updated (pan). Wheel (with or without Alt) on a photo
// adjusts transform.zoom. This is independent of the slot→slot drag system.

function startPhotoPan(slotIdx, e) {
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content) return;
  const t = content.transform || (content.transform = { x: 50, y: 50, zoom: 1 });
  state.photoPan = {
    slotIdx,
    startX: e.clientX,
    startY: e.clientY,
    baseX: t.x,
    baseY: t.y,
    // We translate pixel deltas to 0..100 pan units based on the slot
    // pixel size at the moment of drag start.
    pixelsToUnits: computePanUnitsPerPixel(slotIdx),
  };
  window.addEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
  window.addEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
  // Visual hint: cursor + slot outline
  const slotEl = state.container.querySelector(`[data-slot-idx="${slotIdx}"]`);
  if (slotEl) slotEl.classList.add('is-panning');
}

function computePanUnitsPerPixel(slotIdx) {
  // Pan unit range: 0..100 covers the slot's width/height. So 1 pixel of
  // mouse movement = 100 / slotWidthPx units in x, and similarly for y.
  const tpl = getLayoutTemplate(state.layout.pages[state.selectedPageIdx].templateId);
  const tSlot = tpl.slots[slotIdx];
  if (!tSlot) return { x: 1, y: 1 };
  const r = slotRect(tSlot, state.canvasPx.w, state.canvasPx.h, tSlot.padding || 0);
  return {
    x: r.w > 0 ? 100 / r.w : 1,
    y: r.h > 0 ? 100 / r.h : 1,
  };
}

function onWindowPhotoPanMove(e) {
  const p = state.photoPan;
  if (!p) return;
  const dx = e.clientX - p.startX;
  const dy = e.clientY - p.startY;
  const content = state.layout.pages[state.selectedPageIdx].slots[p.slotIdx];
  if (!content) return;
  content.transform = content.transform || { x: 50, y: 50, zoom: 1 };
  // Pan: increase in x means show more of the right side of the image, so
  // we move the image leftward in the slot. CSS pan (transform.x > 50)
  // means shift the image toward the right, exposing the left side.
  // With dx > 0 (mouse moves right) we want transform.x to DECREASE so the
  // image follows the finger. Then we clamp to 0..100.
  const newX = Math.max(0, Math.min(100, p.baseX - dx * p.pixelsToUnits.x));
  const newY = Math.max(0, Math.min(100, p.baseY - dy * p.pixelsToUnits.y));
  content.transform.x = newX;
  content.transform.y = newY;
  updateSlotPhotoTransform(state.selectedPageIdx, p.slotIdx);
}

function onWindowPhotoPanUp(e) {
  const p = state.photoPan;
  state.photoPan = null;
  window.removeEventListener('pointermove', onWindowPhotoPanMove, { capture: true });
  window.removeEventListener('pointerup', onWindowPhotoPanUp, { capture: true });
  if (p && p.slotIdx != null) {
    const slotEl = state.container.querySelector(`[data-slot-idx="${p.slotIdx}"]`);
    if (slotEl) slotEl.classList.remove('is-panning');
  }
}

// ---- direct text pan -------------------------------------------------------
//
// Alt + drag a text slot to move the text inside its slot. We work in pixel
// units that mirror the PDF's pt-space (1px = 1pt in user space because the
// editor canvas is scaled to match A4 exactly — see computeCanvasSize).

function startTextPan(slotIdx, e) {
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content) return;
  content.textOffset = content.textOffset || { x: 0, y: 0 };
  state.textPan = {
    slotIdx,
    startX: e.clientX,
    startY: e.clientY,
    baseX: content.textOffset.x || 0,
    baseY: content.textOffset.y || 0,
  };
  window.addEventListener('pointermove', onWindowTextPanMove, { capture: true });
  window.addEventListener('pointerup', onWindowTextPanUp, { capture: true });
  const slotEl = state.container.querySelector(`[data-slot-idx="${slotIdx}"]`);
  if (slotEl) slotEl.classList.add('is-panning');
}

function onWindowTextPanMove(e) {
  const p = state.textPan;
  if (!p) return;
  const content = state.layout.pages[state.selectedPageIdx].slots[p.slotIdx];
  if (!content) return;
  // 1:1 px → pt mapping keeps PDF and editor visually identical.
  const dx = e.clientX - p.startX;
  const dy = e.clientY - p.startY;
  content.textOffset = {
    x: Math.max(-300, Math.min(300, p.baseX + dx)),
    y: Math.max(-180, Math.min(180, p.baseY + dy)),
  };
  updateTextOffset(state.selectedPageIdx, p.slotIdx);
  // Keep inspector sliders in sync
  const xRange = state.container.querySelector('#album-text-x');
  const yRange = state.container.querySelector('#album-text-y');
  if (xRange) xRange.value = String(Math.round(content.textOffset.x));
  if (yRange) yRange.value = String(Math.round(content.textOffset.y));
}

function onWindowTextPanUp() {
  const p = state.textPan;
  state.textPan = null;
  window.removeEventListener('pointermove', onWindowTextPanMove, { capture: true });
  window.removeEventListener('pointerup', onWindowTextPanUp, { capture: true });
  if (p && p.slotIdx != null) {
    const slotEl = state.container.querySelector(`[data-slot-idx="${p.slotIdx}"]`);
    if (slotEl) slotEl.classList.remove('is-panning');
  }
}

function onCanvasWheel(e) {
  // Wheel over a photo slot → zoom that photo. We allow this without
  // requiring Alt since it's a natural gesture over the image.
  if (!e.target) return;
  const slotEl = e.target.closest && e.target.closest('[data-slot-idx][data-slot-type="photo"]');
  if (!slotEl) return;
  const slotIdx = Number(slotEl.getAttribute('data-slot-idx'));
  const content = state.layout.pages[state.selectedPageIdx].slots[slotIdx];
  if (!content || !content.photoId) return;
  e.preventDefault();
  // deltaY < 0 = scroll up = zoom in. 1 notch ≈ 10% zoom.
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const cur = (content.transform && content.transform.zoom) || 1;
  const next = Math.max(0.1, Math.min(4, cur * factor));
  content.transform = content.transform || { x: 50, y: 50, zoom: 1 };
  content.transform.zoom = next;
  updateSlotPhotoTransform(state.selectedPageIdx, slotIdx);
  // Keep inspector sliders in sync if visible
  const zoomRange = state.container.querySelector('#album-zoom');
  if (zoomRange) zoomRange.value = String(Math.round(next * 10));
}

function onCanvasPointerMove(e) {
  if (!state.drag) return;
  moveDragGhost(e);
  // Highlight the target slot
  const over = findSlotUnderPointer(e);
  state.container.querySelectorAll('.album-slot.is-drop-target').forEach((el) => {
    el.classList.remove('is-drop-target');
  });
  if (over && over.el) over.el.classList.add('is-drop-target');
  state.drag.overSlotIdx = over ? over.slotIdx : null;
  state.drag.overSlotType = over ? over.slotType : null;
}

function onCanvasPointerUp(e) {
  if (!state.drag) return;
  const over = state.drag.overSlotIdx;
  const overType = state.drag.overSlotType;
  const sourceSlotIdx = state.drag.sourceSlotIdx;
  const sourcePageIdx = state.drag.sourcePageIdx;
  const photoId = state.drag.photoId;
  cleanupDrag();
  if (over == null || overType !== 'photo') {
    // Drop on empty area — no-op
    return;
  }
  const targetPage = state.layout.pages[state.selectedPageIdx];
  const targetContent = targetPage.slots[over];
  if (!targetContent || targetContent.type !== 'photo') return;
  // Same-slot drop = no-op
  if (sourceSlotIdx === over && sourcePageIdx === state.selectedPageIdx) return;
  if (targetContent.photoId) {
    // Swap: exchange photoIds between source and target
    const sourcePage = state.layout.pages[sourcePageIdx];
    if (sourcePageIdx != null && sourceSlotIdx != null) {
      const sourceContent = sourcePage.slots[sourceSlotIdx];
      const tmpId = sourceContent.photoId;
      const tmpTransform = sourceContent.transform;
      sourceContent.photoId = targetContent.photoId;
      sourceContent.transform = targetContent.transform;
      sourceContent.empty = !sourceContent.photoId;
      targetContent.photoId = tmpId;
      targetContent.transform = tmpTransform;
      targetContent.empty = !targetContent.photoId;
    } else {
      // From palette into occupied slot — replace
      targetContent.photoId = photoId;
      targetContent.transform = { x: 50, y: 50, zoom: 1 };
      targetContent.empty = false;
    }
  } else {
    // Empty slot — place the photo
    targetContent.photoId = photoId;
    targetContent.transform = { x: 50, y: 50, zoom: 1 };
    targetContent.empty = false;
  }
  // Ensure URL is cached
  if (photoId && !state.photoUrls.has(photoId)) {
    fetchPhotoDataUrl(photoId).then((url) => {
      if (url) {
        state.photoUrls.set(photoId, url);
        renderActivePage();
      }
    }).catch(() => {});
  }
  renderActivePage();
  renderPageThumbs();
}

function findSlotUnderPointer(e) {
  const canvas = state.container.querySelector('#album-canvas');
  if (!canvas) return null;
  // Walk up from the element under the pointer; if it's a slot, return it
  let el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return null;
  // If the user is over the canvas's own area (not in a slot), bail
  if (!canvas.contains(el)) return null;
  while (el && el !== canvas) {
    if (el.hasAttribute && el.hasAttribute('data-slot-idx')) {
      return {
        el,
        slotIdx: Number(el.getAttribute('data-slot-idx')),
        slotType: el.getAttribute('data-slot-type'),
      };
    }
    el = el.parentElement;
  }
  return null;
}

function startDrag(drag, e) {
  state.drag = drag;
  // Create a ghost element
  const ghost = document.createElement('div');
  ghost.className = 'album-drag-ghost';
  ghost.textContent = drag.ghostText || '🖼';
  document.body.appendChild(ghost);
  state.drag.ghost = ghost;
  positionGhost(e);
  // Capture global pointer events
  window.addEventListener('pointermove', onWindowPointerMove, { capture: true });
  window.addEventListener('pointerup', onWindowPointerUp, { capture: true });
}

function onWindowPointerMove(e) {
  if (!state.drag) return;
  positionGhost(e);
  onCanvasPointerMove(e);
}

function onWindowPointerUp(e) {
  if (!state.drag) return;
  onCanvasPointerUp(e);
}

function positionGhost(e) {
  if (!state.drag || !state.drag.ghost) return;
  const g = state.drag.ghost;
  g.style.left = `${e.clientX + 8}px`;
  g.style.top = `${e.clientY + 8}px`;
}

function cleanupDrag() {
  if (state.drag) {
    if (state.drag.ghost) {
      try { state.drag.ghost.remove(); } catch {}
    }
    state.drag = null;
  }
  window.removeEventListener('pointermove', onWindowPointerMove, { capture: true });
  window.removeEventListener('pointerup', onWindowPointerUp, { capture: true });
  state.container.querySelectorAll('.album-slot.is-drop-target').forEach((el) => {
    el.classList.remove('is-drop-target');
  });
}

// ---- event handlers ---------------------------------------------------------

function handleBack() {
  if (state.onBack) state.onBack();
}

function handleExport() {
  if (state.onExport) {
    state.onExport(state.layout);
  }
}

function handleAddPage() {
  // Add a fresh page after the current one, using a default template and
  // pulling content from the current page's event (if any).
  const cur = state.layout.pages[state.selectedPageIdx];
  const eventId = cur ? cur.eventId : null;
  const ev = eventId ? state.eventById.get(eventId) : null;
  // Find an unused photo from the same event (or any event) to seed the page
  const usedIds = new Set();
  state.layout.pages.forEach((p) => p.slots.forEach((s) => {
    if (s.photoId) usedIds.add(s.photoId);
  }));
  let seedPhoto = null;
  for (const e of state.events) {
    for (const p of (e.photos || [])) {
      if (!usedIds.has(p.id)) { seedPhoto = p; break; }
    }
    if (seedPhoto) break;
  }
  const tpl = getLayoutTemplate('single-full');
  const newPage = {
    templateId: 'single-full',
    eventId: eventId,
    slots: [
      seedPhoto
        ? { type: 'photo', photoId: seedPhoto.id, transform: { x: 50, y: 50, zoom: 1 },
            _slotTemplate: { x: tpl.slots[0].x, y: tpl.slots[0].y, w: tpl.slots[0].w, h: tpl.slots[0].h, padding: 0 } }
        : { type: 'photo', photoId: null, transform: { x: 50, y: 50, zoom: 1 },
            _slotTemplate: { x: tpl.slots[0].x, y: tpl.slots[0].y, w: tpl.slots[0].w, h: tpl.slots[0].h, padding: 0 }, empty: true },
      { type: 'caption', text: ev ? '' : '',
        _slotTemplate: { x: tpl.slots[1].x, y: tpl.slots[1].y, w: tpl.slots[1].w, h: tpl.slots[1].h, padding: 4 } },
    ],
  };
  // Fill caption with event data
  if (ev) {
    import('../album_builder.js').then((mod) => {
      newPage.slots[1].text = mod.buildEventCaption(ev);
      state.layout.pages.splice(state.selectedPageIdx + 1, 0, newPage);
      selectPage(state.selectedPageIdx + 1);
    });
  } else {
    state.layout.pages.splice(state.selectedPageIdx + 1, 0, newPage);
    selectPage(state.selectedPageIdx + 1);
  }
}

function handleDeletePage() {
  if (state.layout.pages.length <= 1) {
    toast('至少需要保留一页');
    return;
  }
  state.layout.pages.splice(state.selectedPageIdx, 1);
  if (state.selectedPageIdx >= state.layout.pages.length) {
    state.selectedPageIdx = state.layout.pages.length - 1;
  }
  state.selectedSlotIdx = null;
  state.selectedSlotType = null;
  renderPageThumbs();
  renderActivePage();
}

function handleChangePageTemplate(pageIdx, newTemplateId) {
  const cur = state.layout.pages[pageIdx];
  if (!cur) return;
  const ev = state.eventById.get(cur.eventId);
  const next = remapPageTemplate(cur, newTemplateId, { event: ev });
  state.layout.pages[pageIdx] = next;
  renderPageThumbs();
  renderActivePage();
}

// ---- photo prefetch (so canvas images appear quickly) -----------------------

function prefetchPagePhotos(pageIdx) {
  const page = state.layout.pages[pageIdx];
  if (!page) return;
  const ids = new Set();
  page.slots.forEach((s) => { if (s.photoId) ids.add(s.photoId); });
  ids.forEach((id) => {
    if (state.photoUrls.has(id)) return;
    fetchPhotoDataUrl(id).then((url) => {
      if (url) {
        state.photoUrls.set(id, url);
        // Re-render only the photo element for this id (cheap)
        const page2 = state.layout.pages[state.selectedPageIdx];
        if (!page2) return;
        const slotIdx = page2.slots.findIndex((s) => s.photoId === id);
        if (slotIdx < 0) return;
        const el = state.container.querySelector(`[data-slot-idx="${slotIdx}"] .album-photo`);
        if (el) {
          el.innerHTML = `<img src="${escapeHtml(url)}" alt="" draggable="false"/>`;
        }
      }
    }).catch(() => {});
  });
}
