// src/js/icons.js — Lucide-style glyph library for contact avatars.
//
// Lucide (ISC license) ships every icon as a single SVG file with a 24x24
// viewBox. We don't depend on the npm package — the SVG path data is inlined
// here so the renderer stays offline-friendly. Each entry's `paths` field
// holds the inner markup that goes between `<svg>` and `</svg>` (e.g.
// `<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>`).
//
// Two entry points matter to the rest of the app:
//   * `iconSVG(name, opts)` — returns an inline `<svg ...>` string for a
//     named glyph, sized for the contact-avatar box by default.
//   * `suggestIconKind(relationship)` — picks a glyph based on the
//     relationship keywords ("家人", "朋友", "同事"...).
//
// Custom-uploaded photos are handled separately by storing
// `custom_avatar_path` on the contact row; callers check that first and
// fall through to `iconSVG()` only when there's no image to show.

// Order matters for `suggestIconKind` — earlier rules win when keywords
// overlap (e.g. "男朋友" → heart, not user). Labels are short Chinese
// hints shown in the editor's icon-picker grid.
export const ICONS = [
  {
    name: 'user',
    label: '通用',
    keywords: [],
    paths: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  },
  {
    name: 'heart',
    label: '家人/伴侣',
    keywords: ['家人', '父亲', '母亲', '爸爸', '妈妈', '爸', '妈', '老公', '老婆', '丈夫', '妻子', '伴侣', '恋人', '男友', '女友', '男朋友', '女朋友', '爱人'],
    paths: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>',
  },
  {
    name: 'baby',
    label: '孩子',
    keywords: ['孩子', '儿子', '女儿', '宝贝', '小孩', '宝宝', 'baby', 'kid'],
    paths: '<path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/><path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"/>',
  },
  {
    name: 'users',
    label: '朋友',
    keywords: ['朋友', '兄弟', '姐妹', '闺蜜', '哥们', '铁哥们', 'buddy', 'friend'],
    paths: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  },
  {
    name: 'briefcase',
    label: '同事',
    keywords: ['同事', '上司', '下属', '老板', '客户', '合伙人', '工作'],
    paths: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  },
  {
    name: 'graduation-cap',
    label: '老师',
    keywords: ['老师', '导师', '教授', 'teacher', 'mentor'],
    paths: '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0Z"/><path d="M22 10v6"/><path d="M6 14.17v3.34a2 2 0 0 0 1.13 1.79l1.87.9"/><path d="M18 14.17v3.34a2 2 0 0 1-1.13 1.79l-1.87.9"/>',
  },
  {
    name: 'stethoscope',
    label: '医生',
    keywords: ['医生', '护士', '大夫', '医师', 'doctor'],
    paths: '<path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/>',
  },
  {
    name: 'paw-print',
    label: '宠物',
    keywords: ['宠物', '猫', '狗', '仓鼠', '兔子'],
    paths: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="11" cy="13" r="2"/><path d="M8 21c-1.5 0-2.5-1.5-2.5-3 0-1.5 1-3 2.5-3 1.5 0 2.5 1.5 2.5 3 0 1.5-1 3-2.5 3Z"/><path d="M14 21c-1.5 0-2.5-1.5-2.5-3 0-1.5 1-3 2.5-3 1.5 0 2.5 1.5 2.5 3 0 1.5-1 3-2.5 3Z"/>',
  },
  {
    name: 'chef-hat',
    label: '厨师',
    keywords: ['厨师', '厨子'],
    paths: '<path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z"/><line x1="6" y1="17" x2="18" y2="17"/>',
  },
  {
    name: 'book-open',
    label: '同学',
    keywords: ['同学', '校友'],
    paths: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  },
  {
    name: 'dumbbell',
    label: '健身/教练',
    keywords: ['教练', '健身', '私教'],
    paths: '<path d="M14.4 14.4 9.6 9.6"/><path d="M18.66 4.2a2 2 0 0 1 2.83 2.83l-1.42 1.42 1.42 1.42a2 2 0 1 1-2.83 2.83l-1.42-1.42-1.41 1.41a2 2 0 1 1-2.83-2.83l1.42-1.41-1.42-1.42a2 2 0 0 1 2.83-2.83l1.41 1.42 1.42-1.42Z"/><path d="m8.49 9.6-1.42 1.41a2 2 0 1 1-2.83-2.82l1.42-1.42L4.25 5.35a2 2 0 1 1-2.83-2.83l1.42-1.41a2 2 0 0 1 2.83 0Z"/><path d="m15.51 14.4 1.42 1.41a2 2 0 1 0 2.83-2.82l-1.42-1.42 1.42-1.41a2 2 0 1 0-2.83-2.83l-1.42 1.41a2 2 0 0 0 0 2.83Z"/>',
  },
  {
    name: 'music',
    label: '音乐人',
    keywords: ['音乐', '歌手', '音乐人', '演奏'],
    paths: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  },
  {
    name: 'camera',
    label: '摄影师',
    keywords: ['摄影师', '拍照'],
    paths: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  },
  {
    name: 'car',
    label: '司机',
    keywords: ['司机', '驾驶员'],
    paths: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18 7.6 15 4 12 4s-6 3.6-8.5 7.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  },
  {
    name: 'coffee',
    label: '咖啡/茶',
    keywords: ['咖啡', '茶友'],
    paths: '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>',
  },
  {
    name: 'smile',
    label: '熟人',
    keywords: ['熟人', '邻居'],
    paths: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  },
  {
    name: 'star',
    label: '偶像',
    keywords: ['偶像', '明星', '爱豆', 'idol'],
    paths: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  },
  {
    name: 'gift',
    label: '礼物相关',
    keywords: ['送礼'],
    paths: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  },
  {
    name: 'home',
    label: '家人(同住)',
    keywords: ['同住', '室友'],
    paths: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 12H5a2 2 0 0 1-2-2Z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  },
  {
    name: 'phone',
    label: '客服',
    keywords: ['客服'],
    paths: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  },
  {
    name: 'mail',
    label: '笔友',
    keywords: ['笔友', '网友'],
    paths: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  },
  {
    name: 'map-pin',
    label: '邻居',
    keywords: ['邻居'],
    paths: '<path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  },
  {
    name: 'circle-user',
    label: '自己',
    keywords: ['自己', '本人', 'me'],
    paths: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.66V19a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1.66"/>',
  },
  {
    name: 'user-cog',
    label: '其他',
    keywords: [],
    paths: '<circle cx="18" cy="15" r="3"/><circle cx="9" cy="7" r="4"/><path d="M10 15H6a4 4 0 0 0-4 4v2"/><path d="m21.7 16.4-.9-.3"/><path d="m15.2 13.9-.9-.3"/><path d="m16.6 18.7.3-.9"/><path d="m19.1 12.2.3-.9"/><path d="m19.6 18.7-.4-1"/><path d="m16.8 16.3-1-.4"/><path d="m21.3 14.2-1-.4"/>',
  },
];

const ICON_BY_NAME = Object.fromEntries(ICONS.map((i) => [i.name, i]));

// Default rendered SVG size. The avatar box is 40×40 so a 22px glyph leaves
// breathing room around the stroke — same proportions as the existing emoji
// glyphs in `.cat-icon`.
const DEFAULT_SIZE = 22;

/**
 * Render an inline SVG for the named icon. Returns the `user` SVG when the
 * name is missing or unknown so a corrupt DB row never crashes the renderer.
 *
 *   opts.size      — pixel width/height (default 22)
 *   opts.title     — accessible title; when set, aria-hidden is removed and
 *                    a <title> child is rendered.
 */
export function iconSVG(name, opts = {}) {
  const icon = (name && ICON_BY_NAME[name]) || ICON_BY_NAME['user'];
  const size = Number.isFinite(opts.size) ? opts.size : DEFAULT_SIZE;
  const title = opts.title ? `<title>${escapeText(opts.title)}</title>` : '';
  const a11y = title ? 'role="img"' : 'aria-hidden="true"';
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" ${a11y}>${title}${icon.paths}</svg>`
  );
}

/**
 * Pick a glyph name based on the user's relationship text. Returns
 * `'user'` (the generic person silhouette) when no keyword matches.
 * Matching is case-insensitive substring search over the user's `label`/
 * `keywords` fields.
 */
export function suggestIconKind(relationship) {
  const text = (relationship == null ? '' : String(relationship)).trim().toLowerCase();
  if (!text) return 'user';
  for (const icon of ICONS) {
    if (!icon.keywords || icon.keywords.length === 0) continue;
    for (const kw of icon.keywords) {
      if (text.includes(kw.toLowerCase())) return icon.name;
    }
  }
  return 'user';
}

/**
 * Search the icon library by query. Used by the editor's picker to filter
 * the grid when the user types in the search box. Matches against
 * `label` and `keywords`.
 */
export function searchIcons(query) {
  const q = (query == null ? '' : String(query)).trim().toLowerCase();
  if (!q) return ICONS;
  return ICONS.filter((icon) => {
    if (icon.label.toLowerCase().includes(q)) return true;
    return (icon.keywords || []).some((k) => k.toLowerCase().includes(q));
  });
}

function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}