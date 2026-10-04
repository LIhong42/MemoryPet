// main/ipc.js — register all ipcMain handlers (sql.js-friendly)
const { ipcMain, app, screen, Menu } = require('electron');
const db = require('./db');
const { fmtDateTime, computeNextFireEvent } = require('./time_util');

function register({ queue, winMain, winPet, setPetState, getPetState, setActiveReminder }) {
  // ---- Contacts ----
  ipcMain.handle('contacts:list', () =>
    db.all('SELECT * FROM contacts WHERE listed = 1 ORDER BY updated_at DESC'));

  ipcMain.handle('contacts:get', (_e, id) =>
    db.one('SELECT * FROM contacts WHERE id = ?', [id]));

  ipcMain.handle('contacts:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    db.run(
      `INSERT INTO contacts(id, first_name, last_name, nickname, company, job_position,
                            listed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, input.first_name || '', input.last_name || '',
       input.nickname || null, input.company || null, input.job_position || null,
       now, now]
    );
    const body = [
      input.first_name, input.last_name, input.nickname,
      input.company, input.job_position,
    ].filter(Boolean).join(' ');
    db.upsertSearch('contact', id, body);
    return db.one('SELECT * FROM contacts WHERE id = ?', [id]);
  });

  ipcMain.handle('contacts:update', (_e, id, input) => {
    const now = db.nowStr();
    db.run(
      `UPDATE contacts SET first_name=?, last_name=?, nickname=?, company=?, job_position=?,
                          updated_at=? WHERE id=?`,
      [input.first_name || '', input.last_name || '',
       input.nickname || null, input.company || null, input.job_position || null,
       now, id]
    );
    const body = [
      input.first_name, input.last_name, input.nickname,
      input.company, input.job_position,
    ].filter(Boolean).join(' ');
    db.upsertSearch('contact', id, body);
    return db.one('SELECT * FROM contacts WHERE id = ?', [id]);
  });

  ipcMain.handle('contacts:delete', (_e, id) => {
    db.run('UPDATE contacts SET listed = 0, updated_at = ? WHERE id = ?',
      [db.nowStr(), id]);
    db.deleteSearch('contact', id);
    return true;
  });

  // ---- Important dates ----
  ipcMain.handle('important_dates:list', (_e, contact_id) =>
    db.all('SELECT * FROM important_dates WHERE contact_id = ? ORDER BY month, day', [contact_id]));

  ipcMain.handle('important_dates:create', (_e, contact_id, input) => {
    const id = db.newId();
    const now = db.nowStr();
    db.run(
      `INSERT INTO important_dates(id, contact_id, label, day, month, year, kind,
                                   remind_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contact_id, input.label, input.day, input.month,
       input.year || null, input.kind || 'custom',
       input.remind_time || '09:00', now, now]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:update', (_e, id, input) => {
    const now = db.nowStr();
    db.run(
      `UPDATE important_dates SET label=?, day=?, month=?, year=?, kind=?,
                                 remind_time=?, updated_at=? WHERE id=?`,
      [input.label, input.day, input.month, input.year || null,
       input.kind || 'custom', input.remind_time || '09:00', now, id]
    );
    db.upsertSearch('important_date', id, `${input.label} ${input.kind || ''}`);
    return db.one('SELECT * FROM important_dates WHERE id = ?', [id]);
  });

  ipcMain.handle('important_dates:delete', (_e, id) => {
    db.run('DELETE FROM important_dates WHERE id = ?', [id]);
    db.deleteSearch('important_date', id);
    return true;
  });

  // ---- Events ----
  ipcMain.handle('events:list', (_e, opts = {}) => {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const args = [];
    if (opts.contact_id) { sql += ' AND contact_id = ?'; args.push(opts.contact_id); }
    if (opts.from) { sql += ' AND (next_fire_at IS NULL OR next_fire_at >= ?)'; args.push(opts.from); }
    if (opts.to) { sql += ' AND (next_fire_at IS NULL OR next_fire_at <= ?)'; args.push(opts.to); }
    sql += ' ORDER BY COALESCE(next_fire_at, remind_date, created_at) ASC';
    return db.all(sql, args);
  });

  ipcMain.handle('events:list_today', () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today_start = `${today_date} 00:00:00`;
    const today_end = `${today_date} 23:59:59`;
    return db.all(
      `SELECT * FROM events
       WHERE active = 1 AND (
         (remind_kind = 'one_time' AND remind_date = ?)
         OR (next_fire_at BETWEEN ? AND ?)
       )
       ORDER BY COALESCE(next_fire_at, remind_date) ASC`,
      [today_date, today_start, today_end]);
  });

  ipcMain.handle('events:get', (_e, id) =>
    db.one('SELECT * FROM events WHERE id = ?', [id]));

  ipcMain.handle('events:create', (_e, input) => {
    const id = db.newId();
    const now = db.nowStr();
    const nf = computeNextFireEvent({
      ...input,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
    }, new Date());
    db.run(
      `INSERT INTO events(id, contact_id, title, description, remind, remind_kind,
                          remind_time, remind_date, next_fire_at, last_fired_at, active,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      [id, input.contact_id || null, input.title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null, now, now]
    );
    db.upsertSearch('event', id, `${input.title} ${input.description || ''} ${input.remind_kind || ''}`);
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:update', (_e, id, input) => {
    const now = db.nowStr();
    const nf = computeNextFireEvent({
      ...input,
      remind: !!input.remind,
      active: true,
      next_fire_at: null,
      last_fired_at: null,
    }, new Date());
    db.run(
      `UPDATE events SET contact_id=?, title=?, description=?, remind=?, remind_kind=?,
                         remind_time=?, remind_date=?, next_fire_at=?, active=1, updated_at=?
       WHERE id=?`,
      [input.contact_id || null, input.title, input.description || null,
       input.remind ? 1 : 0, input.remind_kind || 'none',
       input.remind_time || '09:00', input.remind_date || null,
       nf ? fmtDateTime(nf) : null, now, id]
    );
    db.upsertSearch('event', id, `${input.title} ${input.description || ''} ${input.remind_kind || ''}`);
    return db.one('SELECT * FROM events WHERE id = ?', [id]);
  });

  ipcMain.handle('events:delete', (_e, id) => {
    db.run('DELETE FROM events WHERE id = ?', [id]);
    db.deleteSearch('event', id);
    return true;
  });

  ipcMain.handle('events:debug_fire_due_now', () => {
    db.run(
      `UPDATE events SET next_fire_at = ?
       WHERE active = 1 AND remind = 1 AND remind_kind != 'none'`,
      [db.nowStr()]
    );
    return true;
  });

  // ---- Search ----
  ipcMain.handle('search:query', (_e, q) => {
    q = (q || '').trim();
    if (!q) return { contacts: [], events: [], important_dates: [] };
    const like = `%${q}%`;
    const contacts = db.all('SELECT * FROM contacts WHERE listed=1 AND (first_name LIKE ? OR last_name LIKE ? OR nickname LIKE ? OR company LIKE ?)',
      [like, like, like, like]);
    const events = db.all('SELECT * FROM events WHERE title LIKE ? OR description LIKE ?', [like, like]);
    const dates = db.all('SELECT * FROM important_dates WHERE label LIKE ?', [like]);
    return { contacts, events, important_dates: dates };
  });

  // ---- Reminders ----
  ipcMain.handle('reminders:list_active', () => queue.list());

  ipcMain.handle('reminders:mark_done', (_e, source, sourceId) => {
    queue.remove(source, sourceId);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, NULL)`,
      [source, sourceId, db.nowStr()]
    );
    updatePetState({ queue, setPetState, setActiveReminder });
    return true;
  });

  ipcMain.handle('reminders:snooze', (_e, source, sourceId, minutes) => {
    const newFire = new Date(Date.now() + minutes * 60_000);
    const newFireStr = fmtDateTime(newFire);
    db.run(
      `INSERT INTO reminder_acks(source, source_id, acked_at, next_fire_at)
       VALUES (?, ?, ?, ?)`,
      [source, sourceId, db.nowStr(), newFireStr]
    );
    if (source === 'event') {
      db.run('UPDATE events SET next_fire_at = ? WHERE id = ?', [newFireStr, sourceId]);
    }
    queue.remove(source, sourceId);
    updatePetState({ queue, setPetState, setActiveReminder });
    return true;
  });

  // ---- Pet / settings / windowing ----
  ipcMain.handle('pet:get_state', () => ({
    state: getPetState() ? 'REMINDER' : 'NORMAL',
    count: queue.len(),
    head: queue.head(),
  }));

  ipcMain.handle('settings:get', (_e, key) => db.getSetting(key));
  ipcMain.handle('settings:set', (_e, key, value) => { db.setSetting(key, value); return true; });

  ipcMain.handle('pet:set_position', (_e, x, y) => {
    db.setSetting('pet_x', String(x));
    db.setSetting('pet_y', String(y));
    if (winPet && !winPet.isDestroyed()) {
      winPet.setPosition(x, y);
    }
    return true;
  });

  ipcMain.handle('pet:get_position', () => ({
    x: parseInt(db.getSetting('pet_x') || '200', 10),
    y: parseInt(db.getSetting('pet_y') || '200', 10),
  }));

  ipcMain.handle('window:show_main', () => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
    }
    return true;
  });

  ipcMain.handle('window:hide_main', () => {
    if (winMain && !winMain.isDestroyed()) winMain.hide();
    return true;
  });

  ipcMain.handle('window:open_reminder', (_e, source, sourceId) => {
    if (winMain && !winMain.isDestroyed()) {
      winMain.show();
      winMain.focus();
      winMain.webContents.send('main:open-reminder', { source, source_id: sourceId });
    }
    return true;
  });

  // ---- App-level controls ----
  ipcMain.handle('app:quit', () => {
    setTimeout(() => app.quit(), 50); // slight delay so the IPC ack reaches the renderer
    return true;
  });

  // ---- Pet drag: receive a per-tick delta from the pet window. We add it
  // to the window's current position and clamp to the display work area.
  // (Using per-tick deltas — not cumulative-from-mousedown — is the key to
  // smooth 1:1 tracking. If we accumulated from mousedown, the main process
  // would add the full cumulative delta to the window's *current* position
  // each tick and the window would run away from the cursor.)
  ipcMain.handle('pet:move_by', (_e, dx, dy) => {
    if (!winPet || winPet.isDestroyed()) return false;
    const [x, y] = winPet.getPosition();
    const w = winPet.getBounds().width;
    const h = winPet.getBounds().height;
    const nx = x + dx;
    const ny = y + dy;
    const display = screen.getDisplayMatching({ x: nx, y: ny, width: w, height: h })
      || screen.getPrimaryDisplay();
    const wa = display.workArea;
    const cx = Math.max(wa.x, Math.min(wa.x + wa.width - w, nx));
    const cy = Math.max(wa.y, Math.min(wa.y + wa.height - h, ny));
    winPet.setPosition(cx, cy);
    return true;
  });

  // ---- Pet right-click context menu (native Electron Menu at cursor) ----
  ipcMain.handle('pet:context_menu', () => {
    const state = getPetState() ? 'REMINDER' : 'NORMAL';
    const reminderLabel = state === 'REMINDER' ? '查看提醒' : '打开主窗口';
    const menu = Menu.buildFromTemplate([
      { label: '🐾 MemoryPet', enabled: false },
      { type: 'separator' },
      {
        label: reminderLabel,
        click: () => {
          if (state === 'REMINDER') {
            // Open main window + pop the reminder modal.
            if (winMain && !winMain.isDestroyed()) {
              winMain.show();
              winMain.focus();
              const head = queue.head();
              if (head) {
                winMain.webContents.send('main:open-reminder', {
                  source: head.source,
                  source_id: head.source_id,
                });
              }
            }
          } else if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
          }
        },
      },
      {
        label: '设置…',
        click: () => {
          if (winMain && !winMain.isDestroyed()) {
            winMain.show();
            winMain.focus();
            winMain.webContents.send('main:navigate', '/settings');
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出 MemoryPet',
        click: () => {
          setTimeout(() => app.quit(), 50);
        },
      },
    ]);
    menu.popup({ window: winPet });
    return true;
  });
}

function updatePetState({ queue, setPetState, setActiveReminder }) {
  const len = queue.len();
  if (len > 0) {
    setPetState(true);
    setActiveReminder(queue.head());
  } else {
    setPetState(false);
    setActiveReminder(null);
  }
}

module.exports = { register };