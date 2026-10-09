// main/pet_registry.js — combines scanner + resolver. One module owns the pet
// resource catalog and answers "give me the frame list for (petId, variant)".
//
// Lifecycle:
//   const reg = new PetRegistry();
//   await reg.init({ appPath, userDataPath });
//   reg.list();                                // manifest metadata list
//   reg.getManifest(petId);                    // raw manifest
//   reg.resolveFrames({ petId, variant, direction? });  // ordered frame list
//
// Frame URLs are file:// URLs (via Node's pathToFileURL) so the renderer can
// load them with <img src=…>. Filenames with non-ASCII (Chinese names are
// present in vup) are URL-encoded automatically.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REQUIRED_FIELDS = ['id', 'name', 'defaultSize', 'variants'];
const DEFAULT_FRAME_REGEX = /^(.*?)_(\d{3})_(\d{3,4})\.png$/;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}
function listPngs(p) {
  try {
    return fs.readdirSync(p).filter((n) => n.toLowerCase().endsWith('.png'));
  } catch { return []; }
}
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function validateManifest(m, dir) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in m)) return `missing required field: ${f}`;
  }
  if (!m.defaultSize || typeof m.defaultSize.w !== 'number' || typeof m.defaultSize.h !== 'number') {
    return 'defaultSize.w/h must be numbers';
  }
  if (typeof m.variants !== 'object' || !m.variants) {
    return 'variants must be an object';
  }
  // At least one variant must point at an existing directory.
  let anyValid = false;
  for (const [key, v] of Object.entries(m.variants)) {
    if (!Array.isArray(v.roots)) return `variant '${key}': roots must be an array`;
    for (const r of v.roots) {
      if (isDir(path.join(dir, r))) { anyValid = true; break; }
    }
  }
  if (!anyValid) return 'no variant root points at an existing directory';
  return null;
}

// Descend into random subdirectories until we hit a leaf that contains .png.
function descendToLeaf(absDir) {
  let cur = absDir;
  for (let depth = 0; depth < 16; depth++) {
    const pngs = listPngs(cur);
    const subdirs = listDirs(cur);
    if (pngs.length > 0) return cur;
    if (subdirs.length === 0) return null;
    cur = path.join(cur, pickRandom(subdirs));
  }
  return null;
}

function parseFrames(leafDir, regex) {
  const files = listPngs(leafDir);
  const parsed = [];
  for (const f of files) {
    const m = regex.exec(f);
    if (!m) continue;
    // Group 1 = index, group 2 = ms (when regex has 2 groups; old "label_NNN_ms" uses 3)
    const idx = parseInt(m[m.length - 2], 10);
    const ms = parseInt(m[m.length - 1], 10);
    if (!Number.isFinite(idx) || !Number.isFinite(ms) || ms <= 0) continue;
    parsed.push({ file: f, idx, ms });
  }
  parsed.sort((a, b) => a.idx - b.idx);
  return parsed.map((p) => ({
    url: pathToFileURL(path.join(leafDir, p.file)).href,
    ms: p.ms,
  }));
}

function readManifestSafe(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return { ok: false, reason: 'manifest.json missing' };
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { ok: false, reason: `read failed: ${e.message}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: `JSON parse failed: ${e.message}` }; }
  const err = validateManifest(parsed, dir);
  if (err) return { ok: false, reason: err };
  return { ok: true, manifest: parsed };
}

class PetRegistry {
  constructor() {
    this._pets = new Map();   // petId → { manifest, rootDir }
    this._userPetsDir = null;
  }

  async init({ appPath, userDataPath }) {
    const roots = [];
    if (appPath) roots.push(path.join(appPath, 'resources', 'pets'));
    if (userDataPath) {
      const ud = path.join(userDataPath, 'pets');
      try {
        if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true });
      } catch {}
      roots.push(ud);
      this._userPetsDir = ud;
    }
    for (const rootDir of roots) this._scanOne(rootDir);
    console.log(`[pet_registry] loaded ${this._pets.size} pet(s): ${[...this._pets.keys()].join(', ') || '(none)'}`);
  }

  _scanOne(rootDir) {
    if (!isDir(rootDir)) return;
    let entries;
    try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
    catch (e) { console.warn(`[pet_registry] readdir ${rootDir} failed: ${e.message}`); return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(rootDir, ent.name);
      const r = readManifestSafe(dir);
      if (!r.ok) {
        console.warn(`[pet_registry] skip ${ent.name}: ${r.reason}`);
        continue;
      }
      const id = r.manifest.id;
      if (this._pets.has(id)) console.warn(`[pet_registry] duplicate pet id '${id}' at ${dir}; overriding`);
      this._pets.set(id, { manifest: r.manifest, rootDir: dir });
    }
  }

  list() {
    return [...this._pets.values()].map((e) => ({
      id: e.manifest.id,
      name: e.manifest.name,
      defaultSize: e.manifest.defaultSize,
    }));
  }

  getManifest(petId) {
    const e = this._pets.get(petId);
    return e ? e.manifest : null;
  }

  getRootDir(petId) {
    const e = this._pets.get(petId);
    return e ? e.rootDir : null;
  }

  /**
   * Resolve frames for a (petId, variant, direction?) tuple.
   * @param {object} opts
   * @param {string} opts.petId
   * @param {string} opts.variant    - key in manifest.variants
   * @param {'left'|'right'} [opts.direction]
   * @returns {{frames: Array<{url, ms}>, loop: boolean, variantHint: string, size: {w,h}}}
   */
  resolveFrames({ petId, variant, direction }) {
    const entry = this._pets.get(petId);
    if (!entry) throw new Error(`unknown pet: ${petId}`);
    const { manifest, rootDir } = entry;
    const v = manifest.variants && manifest.variants[variant];
    if (!v || !Array.isArray(v.roots) || v.roots.length === 0) {
      throw new Error(`pet '${petId}' has no variant '${variant}'`);
    }

    const regexSrc = manifest.frameRegex || DEFAULT_FRAME_REGEX.source;
    const regex = new RegExp(regexSrc);

    // Try up to N times to land on a leaf with parseable frames.
    let leaf = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const root = pickRandom(v.roots);
      const rootAbs = path.join(rootDir, root);
      if (!isDir(rootAbs)) continue;
      leaf = descendToLeaf(rootAbs);
      if (leaf) break;
    }
    if (!leaf) throw new Error(`pet '${petId}' variant '${variant}': no leaf with frames`);

    const frames = parseFrames(leaf, regex);
    if (frames.length === 0) {
      throw new Error(`pet '${petId}' variant '${variant}': no parseable frames in ${leaf}`);
    }

    return {
      frames,
      loop: v.loop !== false,           // default true
      variantHint: path.relative(rootDir, leaf).replace(/\\/g, '/'),
      size: manifest.defaultSize,
    };
  }

  /**
   * Re-scan the user-data pets directory only. Built-in pets (loaded from
   * `appPath/resources/pets`) stay untouched. Called by the import / remove
   * IPC handlers after a pack is installed or deleted so the registry picks
   * up the change without a full app restart.
   *
   * Returns the new total pet count.
   */
  rescan() {
    if (!this._userPetsDir) return this._pets.size;
    for (const [id, entry] of this._pets.entries()) {
      if (entry.rootDir === this._userPetsDir) this._pets.delete(id);
    }
    this._scanOne(this._userPetsDir);
    return this._pets.size;
  }
}

module.exports = { PetRegistry };
