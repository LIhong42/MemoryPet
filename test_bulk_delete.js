const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bulk-'));
const dbPath = path.join(tmpDir, 'test.db');

const db = require('./main/db.js');

async function main() {
  await db.open(dbPath);

  // Create a contact
  const cid = require('crypto').randomUUID();
  const now = db.nowStr();
  db.run(
    `INSERT INTO contacts(id, name, relationship, likes_json, taboos_json, gifts_json, listed, created_at, updated_at)
     VALUES (?, 'Alice', 'friend', '[]', '[]', '[]', 1, ?, ?)`,
    [cid, now, now]
  );

  // Create 5 like entries
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = db.newId();
    ids.push(id);
    db.run(
      `INSERT INTO contact_attributes(id, contact_id, kind, description, event, created_at, updated_at)
       VALUES (?, ?, 'like', ?, NULL, ?, ?)`,
      [id, cid, `like-${i}`, now, now]
    );
  }

  console.log('before:', db.all('SELECT id FROM contact_attributes WHERE contact_id = ?', [cid]).length);

  // Test that the deleteMany SQL pattern works (mirroring ipc.js)
  const safeIds = ids.slice(0, 3);
  const placeholders = safeIds.map(() => '?').join(',');
  db.run(
    `DELETE FROM contact_attributes WHERE id IN (${placeholders})`,
    safeIds
  );

  console.log('after:', db.all('SELECT id FROM contact_attributes WHERE contact_id = ?', [cid]).length);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
