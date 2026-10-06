// src/js/pages/search.js
import { api, escapeHtml, firstChar, displayName, eventKindAttr, fmtDateTime, formatRelative, categoryIcon, contactColorIndex, getCachedAvatarDataUrl, warmAvatarCache } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';

async function render(_args, params) {
  const app = document.getElementById('app');
  const q = (params.q || '').trim();

  // Keep the search input mounted across renders. Navigating to
  // `/search?q=...` on every keystroke used to call `app.innerHTML = ...`,
  // which destroyed the live <input> and broke IME composition — typing
  // "汉" dropped the intermediate pinyin strokes, and even plain backspace
  // lost the caret until the user re-clicked. By reusing an existing input
  // (preserving value, focus, selection, and IME context) we sidestep
  // all of that. Only the results container is rewritten.
  let input = document.getElementById('q');
  let results = document.getElementById('search-results');
  if (!input) {
    app.innerHTML = `
      <h1>搜索</h1>
      <div class="card">
        <input type="text" id="q" placeholder="搜联系人、事件、重要日期…" autofocus />
      </div>
      <div id="search-results"></div>
    `;
    input = document.getElementById('q');
    results = document.getElementById('search-results');
  }

  // Mirror URL → input. Only update when the URL actually has a different
  // value, otherwise we'd steal the caret mid-IME composition.
  if (input.value !== q) input.value = q;

  // Wire input handlers exactly once (guarded by a flag on the element).
  if (!input.dataset.wired) {
    input.dataset.wired = '1';
    // URL <-> input sync. We deliberately debounce through rAF + a tiny
    // settle timer so a Chinese IME that fires many `input` events during
    // composition collapses into a single navigate('/search?q=...') after the
    // user finishes typing (or pauses). The input itself is never torn
    // down, so deletion and any subsequent keystroke keep working without
    // re-clicking.
    let pendingValue = null;
    let scheduled = false;
    let settleTimer = null;
    const flush = () => {
      scheduled = false;
      settleTimer = null;
      const v = pendingValue;
      pendingValue = null;
      if (v === null) return;
      const target = v.trim()
        ? '/search?q=' + encodeURIComponent(v.trim())
        : '/search';
      // Skip if the URL already matches — avoids re-rendering on identical
      // composition events and breaks the focus-stealing loop entirely.
      const current = (location.hash || '').replace(/^#/, '');
      if (current === target) return;
      navigate(target);
    };
    const schedule = (v) => {
      pendingValue = v;
      if (settleTimer) clearTimeout(settleTimer);
      // 120ms idle settle: covers IME composition bursts on Chinese IMEs
      // (微软拼音 / 百度输入法 / sogou 等) where the IME keeps emitting
      // input events for ~50–100ms after the user picks a candidate.
      settleTimer = setTimeout(flush, 120);
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    };
    input.addEventListener('input', () => schedule(input.value));
    // IME composition boundary — flush immediately when the user confirms
    // a candidate (or cancels), so they don't wait the full 120ms.
    input.addEventListener('compositionend', () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      pendingValue = input.value;
      flush();
    });
  }

  if (q) {
    if (input !== document.activeElement) input.focus();
    await runSearch(q);
  } else {
    results.innerHTML = '';
  }
}

async function runSearch(q) {
  const out = document.getElementById('search-results');
  out.innerHTML = `<div class="empty">搜索中…</div>`;
  const r = await api.search.query(q);
  const memorial = r.memorial_events || [];
  // Pre-warm avatar caches so contact rows that have a custom photo repaint
  // on the second tick without a per-row IPC.
  for (const c of r.contacts) if (c.custom_avatar_path) warmAvatarCache(c.id);
  out.innerHTML = `
    ${r.contacts.length === 0 && r.events.length === 0 && memorial.length === 0 && r.important_dates.length === 0
      ? `<div class="empty">没有匹配结果</div>`
      : ''}
    ${r.contacts.length > 0 ? `
      <div class="section-header"><h2>联系人 (${r.contacts.length})</h2></div>
      ${r.contacts.map((c) => {
        const tone = contactColorIndex(c.name);
        const kind = c.icon_kind && c.icon_kind !== 'user' ? c.icon_kind : suggestIconKind(c.relationship);
        const avatarUrl = c.custom_avatar_path ? getCachedAvatarDataUrl(c.id) : '';
        const avatarInner = avatarUrl
          ? `<img src="${escapeHtml(avatarUrl)}" alt=""/>`
          : iconSVG(kind, { title: displayName(c) });
        return `
        <div class="card list-row clickable" data-contact-color="${tone}" data-id="${escapeHtml(c.id)}" data-action="contact">
          <div class="lr-id">
            <div class="contact-avatar" style="color: var(--contact-${tone})">${avatarInner}</div>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(displayName(c))}${c.relationship
              ? `<span class="relationship-sep">·</span><span class="relationship">${escapeHtml(c.relationship)}</span>`
              : ''}</div>
          </div>
        </div>
      `}).join('')}` : ''}
    ${r.events.length > 0 ? `
      <div class="section-header"><h2>事件 (${r.events.length})</h2></div>
      ${r.events.map((e) => {
        const kind = eventKindAttr(e);
        return `
        <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}" data-action="event">
          <div class="lr-id">
            <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title)} <span class="tag" style="margin-left:6px">${escapeHtml(categoryTagLabel(e.category))}</span>${e.tag_kind ? ` <span class="tag">${escapeHtml(tagKindLabel(e.tag_kind))}</span>` : ''}</div>
            <div class="lr-meta">${escapeHtml(kindLabel(e.remind_kind))}${e.lunar_month && e.lunar_day ? ' · 农历 ' + e.lunar_month + '-' + e.lunar_day : ''}</div>
          </div>
          <div class="lr-side"><div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.next_fire_at || e.remind_date))}</div></div>
        </div>
      `}).join('')}` : ''}
    ${memorial.length > 0 ? `
      <div class="section-header"><h2>回忆事件 (${memorial.length})</h2></div>
      ${memorial.map((e) => `
        <div class="card list-row clickable" data-kind="memorial" data-id="${escapeHtml(e.id)}" data-action="memorial">
          <div class="lr-id">
            <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(e.kind === 'first_time' ? '第一次' : '其他')}</span></div>
            <div class="lr-meta">回忆事件</div>
          </div>
          <div class="lr-side"><div class="time-chip"><span class="chip-dot"></span>${escapeHtml(formatRelative(e.occurred_at))}</div></div>
        </div>
      `).join('')}` : ''}
    ${r.important_dates.length > 0 ? `
      <div class="section-header"><h2>重要日期 (${r.important_dates.length})</h2></div>
      ${r.important_dates.map((d) => `
        <div class="card list-row" data-kind="important" data-id="${escapeHtml(d.contact_id)}" data-action="contact">
          <div class="lr-id">
            <span class="cat-icon" data-tone="important">🎂</span>
          </div>
          <div class="lr-main">
            <div class="lr-title">${escapeHtml(d.label)}</div>
            <div class="lr-meta">${d.month}/${d.day}${d.year ? ' · ' + d.year + '年生' : ''} · 每年提醒</div>
          </div>
          <div class="lr-side"><div class="time-chip muted">查看 →</div></div>
        </div>
      `).join('')}` : ''}
  `;
  out.querySelectorAll('[data-action="contact"]').forEach((el) => {
    el.onclick = () => navigate('/contacts/' + el.dataset.id);
  });
  out.querySelectorAll('[data-action="event"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
  });
  out.querySelectorAll('[data-action="memorial"]').forEach((el) => {
    el.onclick = () => navigate('/events/' + el.dataset.id + '?category=memorial');
  });
}

function kindLabel(k) {
  return ({ one_time: '一次', daily: '每天', monthly: '每月', yearly: '每年', none: '不提醒' }[k]) || k || '';
}

function categoryTagLabel(c) {
  return ({ general: '提醒', memorial: '回忆', work: '工作' }[c]) || c || '';
}

function tagKindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', festival: '节日' }[k]) || '';
}

register('/search', render);