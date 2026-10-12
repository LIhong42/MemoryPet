// src/js/album_layouts.js — Album themes + page templates + slot geometry.
//
// Three responsibilities:
//   1. THEME catalog (5 visual styles: classic / film / magazine / warm / dark).
//      pdfkit cannot switch font families at runtime (we embed one CJK font
//      and Helvetica), so "themes" vary via color palette, font size, weight
//      and line gap. Per the user-approved plan, no font family switching.
//   2. LAYOUT_TEMPLATE catalog (5 per-page slot geometries, 0-100 normalized).
//      Every public template has at least 1 photo slot AND 1 text slot, so
//      "image-only" or "text-only" pages are structurally impossible.
//   3. slotRect / getPageDims / computePhotoDrawRect — pure math helpers
//      used by both the renderer (canvas preview) and main/album_pdf.js
//      (PDF output) so the WYSIWYG fidelity is exact.
//
// Slot coordinates are normalized 0..100 (page-relative). The pdfkit side
// multiplies by page dimensions in pt (1pt = 1/72 inch). The renderer
// multiplies by pixel page size for the on-screen canvas. Same numbers,
// different units.

const PAGE = {
  // A4 in points. pdfkit uses points natively.
  a4Portrait:  { w: 595.28, h: 841.89 },
  a4Landscape: { w: 841.89, h: 595.28 },
};

// ---- 1. THEMES ----------------------------------------------------------------

const THEMES = [
  {
    id: 'classic',
    name: '经典',
    cssVar: {
      bg:        '#ffffff',
      surface:   '#f8f7f3',
      text:      '#2a2a2a',
      muted:     '#8a8478',
      accent:    '#f4a8a0', // matches --cat-memorial in app
      accentDark:'#d97757',
      ribbon:    '#f4a8a0',
    },
    size:       { title: 28, body: 12, caption: 11 },
    weight:     { title: 'bold', body: 'normal', caption: 'normal' },
    coverLayout:'centered',
    pageShape:  'landscape',
    lineGap:    2,
    chrome:     { showRibbon: false, cornerRadius: 0 },
  },
  {
    id: 'film',
    name: '胶片',
    cssVar: {
      bg:        '#f5efe2',
      surface:   '#ece4d0',
      text:      '#3a2e1f',
      muted:     '#8a7a5e',
      accent:    '#c9a574',
      accentDark:'#8a6a3a',
      ribbon:    '#c9a574',
    },
    size:       { title: 26, body: 12, caption: 10 },
    weight:     { title: 'bold', body: 'normal', caption: 'normal' },
    coverLayout:'corner-ribbon',
    pageShape:  'landscape',
    lineGap:    3,
    chrome:     { showRibbon: true, cornerRadius: 0 },
  },
  {
    id: 'magazine',
    name: '杂志',
    cssVar: {
      bg:        '#ffffff',
      surface:   '#f3f3f3',
      text:      '#111111',
      muted:     '#666666',
      accent:    '#1a1a1a',
      accentDark:'#000000',
      ribbon:    '#1a1a1a',
    },
    size:       { title: 40, body: 12, caption: 11 },
    weight:     { title: 'bold', body: 'normal', caption: 'normal' },
    coverLayout:'split',
    pageShape:  'landscape',
    lineGap:    1,
    chrome:     { showRibbon: false, cornerRadius: 0 },
  },
  {
    id: 'warm',
    name: '暖阳',
    cssVar: {
      bg:        '#fff4e6',
      surface:   '#ffe8d1',
      text:      '#5a3a1a',
      muted:     '#b08868',
      accent:    '#d97757',
      accentDark:'#a85530',
      ribbon:    '#d97757',
    },
    size:       { title: 30, body: 13, caption: 11 },
    weight:     { title: 'bold', body: 'normal', caption: 'italic' },
    coverLayout:'centered',
    pageShape:  'landscape',
    lineGap:    3,
    chrome:     { showRibbon: false, cornerRadius: 8 },
  },
  {
    id: 'dark',
    name: '暗夜',
    cssVar: {
      bg:        '#1a1a1a',
      surface:   '#262626',
      text:      '#f0e6dd',
      muted:     '#9a8f80',
      accent:    '#e8b89a',
      accentDark:'#c89070',
      ribbon:    '#e8b89a',
    },
    size:       { title: 28, body: 12, caption: 11 },
    weight:     { title: 'bold', body: 'normal', caption: 'normal' },
    coverLayout:'centered',
    pageShape:  'landscape',
    lineGap:    2,
    chrome:     { showRibbon: true, cornerRadius: 0 },
  },
];

const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

function getTheme(id) {
  return THEME_BY_ID[id] || THEMES[0];
}

// ---- 2. LAYOUT TEMPLATES ------------------------------------------------------
//
// Slot coordinates are 0..100 (page width / page height). The (x, y) is the
// top-left corner. padding is the inset inside the slot (in % of slot size
// when scaled, in pt otherwise). For text slots padding matters; for photo
// slots it's the empty margin around the image.
//
// Every template has at least one photo AND one text slot to enforce 图文并茂.

const LAYOUT_TEMPLATES = [
  {
    id: 'single-full',
    name: '满版单图',
    orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 100, h: 78, padding: 0 },
      { type: 'caption', x: 0,  y: 78, w: 100, h: 22, padding: 4 },
    ],
    constraints: { minPhotos: 1, maxPhotos: 1, requiresText: true },
  },
  {
    id: 'big-top-text-bottom',
    name: '大图+底注',
    orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 4,  y: 4,  w: 92, h: 72, padding: 0 },
      { type: 'title',   x: 4,  y: 76, w: 92, h: 8,  padding: 1 },
      { type: 'caption', x: 4,  y: 84, w: 92, h: 12, padding: 1 },
    ],
    constraints: { minPhotos: 1, maxPhotos: 1, requiresText: true },
  },
  {
    id: 'split-h-text-bottom',
    name: '左右分栏+底注',
    orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 80, padding: 0 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 80, padding: 0 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20, padding: 4 },
    ],
    constraints: { minPhotos: 2, maxPhotos: 2, requiresText: true },
  },
  {
    id: 'three-grid-text',
    name: '三宫格+底注',
    orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 50, h: 40, padding: 0 },
      { type: 'photo',   x: 50, y: 0,  w: 50, h: 40, padding: 0 },
      { type: 'photo',   x: 0,  y: 40, w: 100,h: 40, padding: 0 },
      { type: 'caption', x: 0,  y: 80, w: 100,h: 20, padding: 4 },
    ],
    constraints: { minPhotos: 3, maxPhotos: 3, requiresText: true },
  },
  {
    id: 'one-photo-side-cap',
    name: '侧图侧文',
    orientation: 'landscape',
    slots: [
      { type: 'photo',   x: 0,  y: 0,  w: 60, h: 100, padding: 0 },
      { type: 'title',   x: 62, y: 6,  w: 34, h: 14,  padding: 2 },
      { type: 'caption', x: 62, y: 22, w: 34, h: 72,  padding: 2 },
    ],
    constraints: { minPhotos: 1, maxPhotos: 1, requiresText: true },
  },
];

const LAYOUT_BY_ID = Object.fromEntries(LAYOUT_TEMPLATES.map((l) => [l.id, l]));

function getLayoutTemplate(id) {
  return LAYOUT_BY_ID[id] || LAYOUT_TEMPLATES[0];
}

// Pick the layout that best fits a given photo count, with seeded
// offset so successive events start from a different template (avoids
// A-B-A-B repetition across events).
function pickLayoutForPhotoCount(photoCount, seedIdx = 0) {
  const fits = LAYOUT_TEMPLATES.filter(
    (l) => photoCount >= l.constraints.minPhotos
         && photoCount <= l.constraints.maxPhotos
  );
  if (fits.length === 0) {
    // 1 photo → single-full; many photos → only fill as many slots as we have
    if (photoCount === 1) return getLayoutTemplate('single-full');
    // For more photos than any template allows, take 3-grid max (3) and
    // build multiple pages — caller's responsibility.
    return getLayoutTemplate('three-grid-text');
  }
  // Rotate starting index by seedIdx so two back-to-back events don't
  // always start with the same template.
  const start = ((seedIdx % fits.length) + fits.length) % fits.length;
  return fits[start];
}

// ---- 3. GEOMETRY --------------------------------------------------------------
//
// All inputs are 0..100 normalized slot rects + page dimensions in user units
// (pt for pdf, px for renderer). Returns absolute rects in those same units.

function getPageDims(pageShape) {
  if (pageShape === 'portrait') return PAGE.a4Portrait;
  return PAGE.a4Landscape;
}

// slot = { x, y, w, h } 0..100, padding = 0..100 (added inset; default 0).
// Returns { x, y, w, h } in same units as pw/ph.
function slotRect(slot, pw, ph, padding = 0) {
  const pad = padding || 0;
  return {
    x: (slot.x / 100) * pw + (pad / 100) * pw,
    y: (slot.y / 100) * ph + (pad / 100) * ph,
    w: (slot.w / 100) * pw - 2 * (pad / 100) * pw,
    h: (slot.h / 100) * ph - 2 * (pad / 100) * ph,
  };
}

// Compute the photo draw rect for a slot given the source image dimensions
// and a transform { x: 0-100, y: 0-100, zoom: 0.1-4 }. Uses cover-style
// scaling (Math.max) so the image fills the slot, then offsets by pan.
// transform.x/y default 50 = centered; zoom default 1 = cover-fit.
//
//   slotRect  = the visible viewport (already in pt or px)
//   srcW/srcH = source image natural width/height (after EXIF orientation)
//   transform = { x, y, zoom }
//
// Returns { x, y, width, height } in the same units as slotRect. The
// caller is responsible for save/restore + clip(slotRect) around the
// image() call.
function computePhotoDrawRect(slotRect, srcW, srcH, transform = {}) {
  const tx = transform.x != null ? transform.x : 50;
  const ty = transform.y != null ? transform.y : 50;
  const zoom = transform.zoom != null ? transform.zoom : 1;
  const safeZoom = Math.max(0.1, Math.min(4, zoom));
  // cover-style scale so image fills the slot at zoom=1
  const baseScale = Math.max(slotRect.w / srcW, slotRect.h / srcH);
  const scale = baseScale * safeZoom;
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  // Centering offsets
  const cx = slotRect.x + (slotRect.w - drawW) / 2;
  const cy = slotRect.y + (slotRect.h - drawH) / 2;
  // Pan: shift the image by a fraction of the slot dimensions
  const offX = cx + (tx - 50) / 100 * slotRect.w;
  const offY = cy + (ty - 50) / 100 * slotRect.h;
  return { x: offX, y: offY, width: drawW, height: drawH };
}

// The "inverse" — given a normalized slot rect and an editor pixel size,
// produce a CSS-friendly absolute position object {left, top, width, height}
// for use with position:absolute. The renderer's photo elements also use
// computePhotoDrawRect for pan/zoom.
function slotRectCss(slot, pw, ph, padding = 0) {
  const r = slotRect(slot, pw, ph, padding);
  return {
    left:   `${r.x}px`,
    top:    `${r.y}px`,
    width:  `${r.w}px`,
    height: `${r.h}px`,
  };
}

// ---- exports ----------------------------------------------------------------

export {
  PAGE,
  THEMES,
  THEME_BY_ID,
  LAYOUT_TEMPLATES,
  LAYOUT_BY_ID,
  getTheme,
  getLayoutTemplate,
  pickLayoutForPhotoCount,
  getPageDims,
  slotRect,
  slotRectCss,
  computePhotoDrawRect,
};
