// main/pet_pack_import.js — adapter that ingests "desktop-pet style" character
// packs (folder or ZIP) and installs them into the current project's
// PetRegistry-compatible layout under `<userData>/MemoryPet/pets/imported-<hash>/`.
//
// What this module does NOT do:
//   * It does not modify the running PetRegistry. The caller is responsible
//     for calling `petRegistry.rescan()` after a successful install / remove.
//   * It does not modify any existing variants or PetController state.
//   * It does not touch event/reminder/contact/memorial data.
//
// Faithful copies of the desktop-pet helpers below (`safeName`, `readLimited`,
// `pngSize`). The originals are in `reference/desktop-pet/src/character-import.js`;
// CLAUDE.md requires we don't depend on `reference/`, so they're reproduced
// here from first principles — same regex, same limits, same field names —
// so future audits of either codebase read identically.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { nativeImage } = require('electron');

// ---- Limits & helpers (mirrored from reference/desktop-pet) ----
const MAX_BYTES = 64 * 1024 * 1024;        // 64 MiB per single file or zip total
const MAX_FILES = 48;                      // max entries inside a zip
const MAX_SPRITE_PIXELS = 80_000_000;      // 80M pixels
const MAX_PREVIEW_PIXELS = 4_000_000;      // 4M pixels

// State name → variant slot. Order matters: the first match wins.
// `walking` produces two sub-roots (right/left) when both right/left states
// exist; otherwise the single matched state is reused for both directions.
const VARIANT_PLAN = {
  default:  { accept: ['idle', 'waiting'],                              direction: null },
  walking:  { accept: ['runningRight', 'runningLeft', 'running'],       direction: 'split' },
  reminder: { accept: ['waving', 'jumping', 'failed', 'review'],        direction: null },
};

function safeName(name) {
  return typeof name === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(name)
    && !name.includes('..');
}

function readLimited(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new Error('文件超过 64 MiB 或不可读');
  }
  return fs.readFileSync(file);
}

function pngSize(bytes) {
  if (!bytes || bytes.length < 33) throw new Error('sprite/preview 不是合法 PNG');
  if (Buffer.from(bytes.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('sprite/preview 不是合法 PNG');
  }
  const buf = Buffer.from(bytes);
  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) {
    throw new Error('图片尺寸超出 16384 像素');
  }
  return { width, height };
}

// ---- State validation helpers ----
function validateState(name, state, rowsInSprite) {
  if (!safeName(name)) throw new Error('state 名不在白名单内');
  if (!Number.isInteger(state.row) || state.row < 0 || state.row >= rowsInSprite) {
    throw new Error(`state "${name}" 的 row 越界`);
  }
  if (!Number.isInteger(state.frames) || state.frames < 1 || state.frames > 64) {
    throw new Error(`state "${name}" 的 frames 必须是 1..64`);
  }
  if (!Number.isFinite(state.interval) || state.interval < 16 || state.interval > 60000) {
    throw new Error(`state "${name}" 的 interval 必须是 16..60000 毫秒`);
  }
}

// Pick the first accept-state that's actually present in the input.
function pickState(states, accept) {
  for (const name of accept) {
    if (states && Object.prototype.hasOwnProperty.call(states, name)) {
      return { name, def: states[name] };
    }
  }
  return null;
}

// Crop a single frame out of the sprite buffer using Electron's nativeImage.
function cropFrame(spriteBytes, x, y, w, h) {
  const img = nativeImage.createFromBuffer(spriteBytes);
  if (!img || img.isEmpty()) throw new Error('PNG 解码失败');
  const cropped = img.crop({ x, y, width: w, height: h });
  if (!cropped || cropped.isEmpty()) throw new Error('PNG 裁剪失败');
  return cropped.toPNG();
}

// ---- ZIP / folder readers ----
// Returns a normalized "pack" object: { manifest, sprite, preview, source }.
function readFolderPack(folderPath) {
  if (!fs.existsSync(folderPath)) throw new Error('找不到桌宠文件夹');
  const stat = fs.lstatSync(folderPath);
  if (!stat.isDirectory()) throw new Error('所选路径不是文件夹');

  const manifestPath = path.join(folderPath, 'character.json');
  if (!fs.existsSync(manifestPath)) throw new Error('找不到 character.json');
  const manifestRaw = readLimited(manifestPath, 262144).toString('utf8');
  const raw = JSON.parse(manifestRaw);

  const spriteName = raw.sprite || 'sprite.png';
  const previewName = raw.preview || 'preview.png';
  if (!safeName(spriteName) || !spriteName.endsWith('.png')) throw new Error('sprite 文件名不合法');
  if (!safeName(previewName) || !previewName.endsWith('.png')) throw new Error('preview 文件名不合法');

  const spritePath = path.join(folderPath, spriteName);
  const previewPath = path.join(folderPath, previewName);
  if (!fs.existsSync(spritePath)) throw new Error('找不到 sprite.png');
  if (!fs.existsSync(previewPath)) throw new Error('找不到 preview.png');

  const spriteBytes = readLimited(spritePath, MAX_BYTES);
  const previewBytes = readLimited(previewPath, MAX_BYTES);

  return finalizePack(raw, spriteBytes, previewBytes, 'folder');
}

function readZipPack(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error('找不到桌宠包');
  const stat = fs.lstatSync(zipPath);
  if (stat.isSymbolicLink()) throw new Error('符号链接不允许');
  if (stat.size > MAX_BYTES) throw new Error('桌宠包超过 64 MiB');

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) throw new Error('桌宠包包含超过 48 个文件');

  // Collect candidates (character.json + png) while enforcing zip-slip.
  const accepted = [];
  let totalBytes = 0;
  const seenManifests = new Set();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    // zip-slip guard: reject absolute paths, parent refs, or root paths.
    if (name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name) || /^[A-Za-z]:\//.test(name)) {
      throw new Error('桌宠包包含非法路径');
    }
    if (entry.header && entry.header.size > MAX_BYTES) {
      throw new Error('桌宠包中的文件超过 64 MiB');
    }
    const isManifest = /(^|\/)character\.json$/.test(name);
    const isPng = name.toLowerCase().endsWith('.png');
    if (!isManifest && !isPng) continue;
    totalBytes += (entry.header && entry.header.size) || 0;
    if (totalBytes > MAX_BYTES) throw new Error('桌宠包总体积超过 64 MiB');
    if (isManifest) {
      seenManifests.add(name);
    }
    accepted.push(entry);
  }
  if (seenManifests.size !== 1) throw new Error('桌宠包中必须有且仅有一个 character.json');

  // Find the manifest entry and compute the root prefix (everything before
  // the manifest file name) so we can strip it from sibling png paths.
  const manifestEntry = accepted.find((e) => /(^|\/)character\.json$/.test(e.entryName));
  const root = path.posix.dirname(manifestEntry.entryName);
  const stripPrefix = root === '.' ? '' : root + '/';

  const manifestRaw = manifestEntry.getData().toString('utf8');
  const raw = JSON.parse(manifestRaw);

  const spriteName = raw.sprite || 'sprite.png';
  const previewName = raw.preview || 'preview.png';
  if (!safeName(spriteName) || !spriteName.endsWith('.png')) throw new Error('sprite 文件名不合法');
  if (!safeName(previewName) || !previewName.endsWith('.png')) throw new Error('preview 文件名不合法');

  // Resolve the sprite / preview entries (may live at the root or one level
  // below — both shapes are common when zip authors wrap in a folder).
  const spriteEntry = accepted.find((e) => {
    const n = e.entryName;
    return n === spriteName || n === stripPrefix + spriteName;
  });
  const previewEntry = accepted.find((e) => {
    const n = e.entryName;
    return n === previewName || n === stripPrefix + previewName;
  });
  if (!spriteEntry) throw new Error('找不到 sprite.png');
  if (!previewEntry) throw new Error('找不到 preview.png');

  const spriteBytes = Buffer.from(spriteEntry.getData());
  const previewBytes = Buffer.from(previewEntry.getData());
  if (spriteBytes.length > MAX_BYTES || previewBytes.length > MAX_BYTES) {
    throw new Error('sprite/preview 超过 64 MiB');
  }
  if (spriteBytes.length + previewBytes.length > MAX_BYTES) {
    throw new Error('sprite + preview 总体积超过 64 MiB');
  }

  return finalizePack(raw, spriteBytes, previewBytes, 'zip');
}

// Validate, then return a normalized pack ready for install.
function finalizePack(raw, spriteBytes, previewBytes, source) {
  // PNG header checks (cheap before we ask nativeImage to decode).
  const spriteSize = pngSize(spriteBytes);
  if (spriteSize.width * spriteSize.height > MAX_SPRITE_PIXELS) {
    throw new Error('sprite 像素数超过 8000 万');
  }
  const previewSize = pngSize(previewBytes);
  if (previewSize.width * previewSize.height > MAX_PREVIEW_PIXELS) {
    throw new Error('preview 像素数超过 400 万');
  }

  const frame = raw.frame || {};
  if (![frame.width, frame.height, raw.columns].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('frame.width / frame.height / columns 必须为正整数');
  }
  if (frame.width < 16 || frame.width > 4096 || frame.height < 16 || frame.height > 4096) {
    throw new Error('frame 尺寸必须在 16..4096 之间');
  }
  if (raw.columns < 1 || raw.columns > 64) {
    throw new Error('columns 必须在 1..64 之间');
  }
  if (spriteSize.width !== frame.width * raw.columns) {
    throw new Error('sprite.png 宽度必须是 columns × frame.width');
  }
  const rowsInSprite = Math.floor(spriteSize.height / frame.height);
  if (rowsInSprite < 1) throw new Error('sprite.png 高度不足以容纳 1 行');
  if (spriteSize.height % frame.height !== 0) {
    // Non-fatal: extra pixels at the bottom are silently ignored.
  }

  const states = raw.states;
  if (!states || typeof states !== 'object') throw new Error('character.json.states 缺失');
  if (!Object.prototype.hasOwnProperty.call(states, 'idle')) {
    throw new Error('character.json.states 缺少 idle');
  }
  if (Object.keys(states).length > 128) throw new Error('states 数量超过 128');
  for (const [name, def] of Object.entries(states)) {
    validateState(name, def, rowsInSprite);
    if (def.frames > raw.columns) {
      throw new Error(`state "${name}" 的 frames 超过 columns`);
    }
  }

  // Resolve variant plan: every variant must be backed by at least one state.
  const resolvedVariants = {};
  for (const [variant, plan] of Object.entries(VARIANT_PLAN)) {
    const pick = pickState(states, plan.accept);
    if (!pick) {
      throw new Error(`角色包缺少可映射到 ${variant} 的 state (需要: ${plan.accept.join('/')})`);
    }
    resolvedVariants[variant] = pick;
  }

  // Stable id from manifest + sprite + preview bytes. Different content ⇒
  // different id; same content ⇒ same id (used for idempotent re-import).
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(raw))
    .update(spriteBytes)
    .update(previewBytes)
    .digest('hex')
    .slice(0, 24);

  // Verify Electron can actually decode both PNGs before we commit anything.
  const spriteImg = nativeImage.createFromBuffer(spriteBytes);
  if (!spriteImg || spriteImg.isEmpty()) throw new Error('sprite PNG 解码失败');
  const previewImg = nativeImage.createFromBuffer(previewBytes);
  if (!previewImg || previewImg.isEmpty()) throw new Error('preview PNG 解码失败');

  return {
    manifest: {
      // Filled in here, consumed by installPack.
      raw,
      digest,
      source,                                  // 'folder' | 'zip'
      spriteBytes,
      previewBytes,
      spriteSize,
      previewSize,
      frame,
      columns: raw.columns,
      states,
      resolvedVariants,
    },
  };
}

// ---- install / remove ----
// Install the pack into `<userDataPath>/pets/imported-<digest>/`.
function installPack(pack, userDataPath) {
  const { manifest } = pack;
  const id = `imported-${manifest.digest}`;
  const rootDir = path.join(userDataPath, 'pets');
  const targetDir = path.join(rootDir, id);
  const previewRel = 'preview.png';

  fs.mkdirSync(rootDir, { recursive: true });

  // Idempotent re-import: if the directory already exists with the same id,
  // do not rewrite — return deduped:true so the caller can show a quiet toast.
  if (fs.existsSync(targetDir) && fs.existsSync(path.join(targetDir, 'manifest.json'))) {
    return { id, deduped: true, rootDir: targetDir };
  }

  // staging dir under a hidden prefix; renamed atomically on success.
  const staging = fs.mkdtempSync(path.join(rootDir, '.import-'));
  try {
    // Write preview.png (single image, kept as-is for the UI to display).
    fs.writeFileSync(path.join(staging, previewRel), manifest.previewBytes);

    // Slice each single-direction variant directory. Walking is special —
    // it gets two physical sub-roots (walking.right / walking.left) so the
    // controller can pick a direction; the single `walking/` root would be
    // redundant.
    for (const [variant, pick] of Object.entries(manifest.resolvedVariants)) {
      if (variant === 'walking') continue;
      const variantDir = path.join(staging, variant);
      fs.mkdirSync(variantDir, { recursive: true });
      const slot = manifest.states[pick.name];
      writeVariantFrames({
        outDir: variantDir,
        variantKey: variant,
        spriteBytes: manifest.spriteBytes,
        row: slot.row,
        frames: slot.frames,
        frameW: manifest.frame.width,
        frameH: manifest.frame.height,
        columns: manifest.columns,
        interval: slot.interval,
      });
    }

    // Walking has two physical sub-roots so the controller's left/right
    // direction logic can pick them independently (mirrors vup/manifest.json).
    const walkingPick = manifest.resolvedVariants.walking;
    const walkingStates = manifest.states;
    // Pick right / left separately. If only one is present, reuse it for
    // both directions (PetRegistry.pickRandom still varies the leaf choice).
    const right = walkingStates.runningRight || walkingStates.running || walkingPick.def;
    const left  = walkingStates.runningLeft  || walkingStates.running || walkingPick.def;
    const walkingRightDir = path.join(staging, 'walking.right');
    const walkingLeftDir  = path.join(staging, 'walking.left');
    fs.mkdirSync(walkingRightDir, { recursive: true });
    fs.mkdirSync(walkingLeftDir,  { recursive: true });
    writeVariantFrames({
      outDir: walkingRightDir, variantKey: 'walking',
      spriteBytes: manifest.spriteBytes, row: right.row, frames: right.frames,
      frameW: manifest.frame.width, frameH: manifest.frame.height,
      columns: manifest.columns, interval: right.interval,
    });
    writeVariantFrames({
      outDir: walkingLeftDir, variantKey: 'walking',
      spriteBytes: manifest.spriteBytes, row: left.row, frames: left.frames,
      frameW: manifest.frame.width, frameH: manifest.frame.height,
      columns: manifest.columns, interval: left.interval,
    });

    // Build the manifest.json the existing PetRegistry understands. Extra
    // fields (source/origin/importedAt) are ignored by PetRegistry but read
    // by the /pets UI through `pet:list_installed`.
    const outManifest = {
      id,
      name: String(manifest.raw.name || 'Imported Character').slice(0, 80),
      description: String(manifest.raw.description || '').slice(0, 500),
      defaultSize: {
        w: Math.min(manifest.frame.width, 4096),
        h: Math.min(manifest.frame.height, 4096),
      },
      frameRegex: '^(.*?)_(\\d{3})_(\\d{3,4})\\.png$',
      variants: {
        default:  { roots: ['default'],     loop: true },
        walking:  { roots: ['walking.right', 'walking.left'], loop: true, needsDirection: true },
        reminder: { roots: ['reminder'],    loop: true },
      },
      source: 'imported',
      origin: manifest.source,                    // 'folder' | 'zip'
      importedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      JSON.stringify(outManifest, null, 2),
      'utf8',
    );

    // Atomic publish.
    fs.renameSync(staging, targetDir);
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw err;
  }

  return { id, deduped: false, rootDir: targetDir };
}

function writeVariantFrames({ outDir, variantKey, spriteBytes, row, frames, frameW, frameH, columns, interval }) {
  for (let i = 0; i < frames; i++) {
    const col = i % columns;
    const x = col * frameW;
    const y = row * frameH;
    const png = cropFrame(spriteBytes, x, y, frameW, frameH);
    const filename = `${variantKey}_${String(i).padStart(3, '0')}_${String(Math.round(interval)).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(outDir, filename), png);
  }
}

// ---- remove ----
function isImportedId(id) {
  return typeof id === 'string' && id.startsWith('imported-');
}

function removeImported(petId, userDataPath) {
  if (!isImportedId(petId)) {
    throw new Error('非导入桌宠不可删除');
  }
  const rootDir = path.join(userDataPath, 'pets', petId);
  if (!fs.existsSync(rootDir)) {
    throw new Error('桌宠不存在');
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
  return { removed: true, rootDir };
}

// ---- summary for the /pets UI ----
// Read manifest.json off disk so callers can list extras even if the registry
// hasn't been re-scanned yet.
function readManifestExtras(userDataPath, petId) {
  const mPath = path.join(userDataPath, 'pets', petId, 'manifest.json');
  if (!fs.existsSync(mPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    return {
      description: m.description || '',
      source: m.source || 'builtIn',
      origin: m.origin || null,
      importedAt: m.importedAt || null,
    };
  } catch {
    return null;
  }
}

module.exports = {
  readFolderPack,
  readZipPack,
  installPack,
  removeImported,
  isImportedId,
  readManifestExtras,
  VARIANT_PLAN,
};
