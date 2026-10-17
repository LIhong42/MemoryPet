// main/png_colorkey.js — run a single PNG through ffmpeg's colorkey filter
// and return the transparentized output bytes.
//
// Why: pet packs imported via the zip uploader often ship frames with a
// solid black background (e.g. ripped from a Live2D preview page). When
// the pet is dropped on the desktop, that black background shows as a
// square border around the character, which looks broken. We pipeline
// each PNG through `format=rgba,colorkey=0x000000:0.1:0.0` before it
// lands on disk so the alpha channel matches the actual silhouette.
//
// ffmpeg invocation:
//
//   ffmpeg -y -loglevel error -i <in.png> \
//     -vf "format=rgba,colorkey=0x000000:0.1:0.0" \
//     -c:v png -pix_fmt rgba <out.png>
//
// Parameters explained:
//   -y               overwrite silently; the temp filenames are unique
//                    per call so this is belt-and-suspenders
//   -loglevel error  drop stderr noise; we still capture the buffer for
//                    surfacing real errors on non-zero exit
//   -i <in.png>      input PNG written to a temp file (Windows ffmpeg
//                    refuses to read from pipe:0 in some builds — using
//                    a real file keeps us portable)
//   format=rgba      force RGBA into the filter graph so colorkey sees a
//                    known 3-channel input regardless of how ffmpeg
//                    decoded the PNG (greyscale PNGs default to gray)
//   colorkey=0x000000:0.1:0.0
//                    key color = pure black, similarity = 0.1 (tolerates
//                    anti-aliased edges that aren't exactly black),
//                    blend = 0.0 (hard cutoff)
//   -pix_fmt rgba    preserve the alpha channel in the PNG output
//
// Why a temp file instead of stdin/stdout pipes:
//   Windows ffmpeg rejects explicit `pipe:0` / `pipe:1` filenames
//   (it tries to open a literal file named "pipe:1"), and refuses to
//   emit PNG to an unnamed stdout pipe ("At least one output file must
//   be specified"). Going through `os.tmpdir()` is reliable on every
//   platform; we clean up on every exit path.
//
// The function mirrors the `runFfmpeg` pattern from
// `main/video_frame_split.js`: `spawn` + stderr buffer + `settled` flag
// to make the close/error race safe. We don't need a progress callback
// because each invocation handles one frame.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('./video_frame_split');

// Cap how much stderr we'll keep around for error messages. ffmpeg's
// PNG decoder errors are usually one or two lines; anything past a few
// KB is noise.
const MAX_STDERR_BYTES = 8 * 1024;

// Run one PNG through the colorkey pipeline. Returns a Buffer holding
// the re-encoded PNG (same width/height, now RGBA with black pixels
// turned transparent). Throws on any non-zero exit; the message
// includes the last few lines of stderr so the user can see what
// ffmpeg actually complained about.
function transparentizePng(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    return Promise.reject(new Error('transparentizePng 需要 Buffer 输入'));
  }
  // Empty / trivially-small inputs would hang ffmpeg waiting for a
  // valid PNG header. The minimum legal PNG is 24 bytes (8-byte sig +
  // 4-byte IHDR length + 4-byte type + 8-byte width/height); short-
  // circuit anything below that to a clear error rather than waiting
  // for ffmpeg's own timeout.
  if (bytes.length < 24) {
    return Promise.reject(new Error('PNG 太小，无法透明化'));
  }

  const ffmpeg = getFfmpegPath();
  // Unique per call so concurrent imports (rare but possible) never
  // collide on the same temp file.
  const nonce = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const inPath  = path.join(tmpDir, `colorkey-in-${nonce}.png`);
  const outPath = path.join(tmpDir, `colorkey-out-${nonce}.png`);

  // Stage the input before spawning so ffmpeg has a stable file to
  // open. Writing the Buffer synchronously avoids a race where ffmpeg
  // starts before the file is fully on disk.
  try {
    fs.writeFileSync(inPath, bytes);
  } catch (err) {
    return Promise.reject(new Error(`写入临时 PNG 失败：${err.message}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-y',
      '-loglevel', 'error',
      '-i', inPath,
      '-vf', 'format=rgba,colorkey=0x000000:0.1:0.0',
      '-c:v', 'png',
      '-pix_fmt', 'rgba',
      outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderrChunks = [];
    let stderrBytes = 0;
    let settled = false;

    const cleanup = () => {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    };

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (err) => {
      // 'error' fires when the binary can't even be spawned (ENOENT etc.).
      // 'close' will then follow with a non-zero code; we let 'close'
      // own the rejection so we don't double-resolve.
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ffmpeg 启动失败：${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        let outBuf;
        try {
          outBuf = fs.readFileSync(outPath);
        } catch (err) {
          cleanup();
          reject(new Error(`读取透明化结果失败：${err.message}`));
          return;
        }
        cleanup();
        resolve(outBuf);
        return;
      }
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderrTail || `signal=${signal || 'none'}`;
      cleanup();
      reject(new Error(`透明化失败 (退出码 ${code})：${detail}`));
    });
  });
}

module.exports = { transparentizePng };
