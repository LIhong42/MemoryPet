// scripts/gen-icons.js — generate placeholder icons
// Outputs:
//   icons/icon.png      (256x256)
//   icons/256x256.png   (alias)
//   icons/128x128.png
//   icons/64x64.png
//   icons/32x32.png
//   icons/icon.ico      (multi-size ICO with 16/32/48/256)
//
// Pure Node, no deps. CRC32 + zlib for PNG, manual ICO packaging.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

// CRC32
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Build a flat-color PNG with a simple "🐾" paw circle in center.
// Background = #f5d6a4 (warm beige), accent = #d97757 (terracotta)
function makePng(size) {
  const W = size, H = size;
  const cx = W / 2, cy = H / 2;
  const bg = [245, 214, 164];      // beige
  const accent = [217, 119, 87];   // terracotta
  const ink = [122, 90, 44];       // outline

  // RGBA raw
  const raw = Buffer.alloc(W * H * 4);
  // big circle
  const R = size * 0.42;
  // 4 paw pads
  const pads = [
    { dx: -0.30, dy: -0.22, r: 0.18 },
    { dx:  0.30, dy: -0.22, r: 0.18 },
    { dx: -0.42, dy:  0.10, r: 0.13 },
    { dx:  0.42, dy:  0.10, r: 0.13 },
  ];
  const mainR = 0.30 * size;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      let col = null;
      // Main pad
      if (dist <= mainR) col = accent;
      // Top pads
      for (const p of pads) {
        const px = cx + p.dx * size - x;
        const py = cy + p.dy * size - y;
        if (px*px + py*py <= (p.r * size) * (p.r * size)) {
          col = accent;
          break;
        }
      }
      // Edge ring (anti-aliased)
      if (col) {
        if (Math.abs(dist - mainR) < 1.5) col = ink;
      }
      const off = (y * W + x) * 4;
      if (col) { raw[off]=col[0]; raw[off+1]=col[1]; raw[off+2]=col[2]; raw[off+3]=255; }
      else     { raw[off]=bg[0]; raw[off+1]=bg[1]; raw[off+2]=bg[2]; raw[off+3]=255; }
    }
  }

  // Build PNG: signature + IHDR + IDAT + IEND
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;       // bit depth
  ihdr[9] = 6;       // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter: prepend 0 (no filter) per scanline
  const stride = W * 4;
  const filtered = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(filtered);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO containing multiple PNG-based entries (Vista+ supports PNG-in-ICO)
function makeIco(pngs /* [{size, buf}] */) {
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each)
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + entrySize * pngs.length;

  const dataOffsets = [];
  let cursor = dirSize;
  for (const p of pngs) { dataOffsets.push(cursor); cursor += p.buf.length; }

  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0);          // reserved
  dir.writeUInt16LE(1, 2);          // type: 1 = icon
  dir.writeUInt16LE(pngs.length, 4); // count

  pngs.forEach((p, i) => {
    const off = headerSize + i * entrySize;
    const s = p.size >= 256 ? 0 : p.size; // 0 means 256
    dir.writeUInt8(s, off + 0);            // width
    dir.writeUInt8(s, off + 1);            // height
    dir.writeUInt8(0, off + 2);            // colors
    dir.writeUInt8(0, off + 3);            // reserved
    dir.writeUInt16LE(1, off + 4);         // planes
    dir.writeUInt16LE(32, off + 6);        // bpp
    dir.writeUInt32LE(p.buf.length, off + 8);
    dir.writeUInt32LE(dataOffsets[i], off + 12);
  });

  return Buffer.concat([dir, ...pngs.map(p => p.buf)]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => ({ size: s, buf: makePng(s) }));

// Write individual PNGs
for (const p of pngs) {
  fs.writeFileSync(path.join(OUT_DIR, `${p.size}x${p.size}.png`), p.buf);
}
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngs[pngs.length - 1].buf);

// Write ICO with 16/32/48/256
const ico = makeIco(pngs.filter(p => [16, 32, 48, 256].includes(p.size)));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

// Copy 256x256 as a "256x256.png" too for builder (some configs require)
fs.writeFileSync(path.join(OUT_DIR, '256x256.png'), pngs[pngs.length - 1].buf);

console.log('icons generated in', OUT_DIR);