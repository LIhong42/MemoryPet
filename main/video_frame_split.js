// main/video_frame_split.js — extract per-frame images from a video file.
//
// Pipeline:
//   ffmpeg -y -i <input> -vf fps=<fps> <outDir>/frame_%05d.<ext>
//
// We use the bundled ffmpeg-static binary (the project already depends on it
// for album_video.js) so the user doesn't need an extra runtime install.
//
// Progress is parsed from ffmpeg's stderr lines that look like
//   frame=  123 fps=... time=00:00:01.23 ...
// We extract the `frame=` value, divide by the total expected frame count
// (frames = duration * fps), and ship back a percent in [0, 100].
//
// Cancellation:
//   We spawn ffmpeg directly via child_process.spawn so we keep a child
//   handle. The caller passes a `cancelCheck` callback (returns true when
//   the user clicked 取消); we poll it every 250 ms while ffmpeg is
//   running. Once true, we SIGTERM the child and propagate a synthetic
//   `{ killed: true }` error up so the IPC layer can clean up the half-
//   written zip and the temp dir.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let _ffmpegPath = null;
function getFfmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  if (typeof ffmpegStatic === 'string') {
    _ffmpegPath = ffmpegStatic;
  } else if (ffmpegStatic && typeof ffmpegStatic === 'object' && ffmpegStatic.path) {
    _ffmpegPath = ffmpegStatic.path;
  } else {
    throw new Error('ffmpeg-static did not return a binary path');
  }
  return _ffmpegPath;
}

// Probe the source video to recover its duration + frame rate so we can
// compute an accurate percent. ffmpeg prints `Duration: HH:MM:SS.xx` on
// stderr; we parse it once and pass the seconds-equivalent up.
function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let resolved = false;
    ff.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    ff.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });
    ff.on('close', () => {
      if (resolved) return;
      resolved = true;
      // `Duration: HH:MM:SS.xx` is the most reliable line; some files
      // also include `Stream #0:0` fps= but we keep it simple and key
      // off Duration since the user only cares about progress %.
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (!m) return resolve(null);
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const ss = Number(m[3]);
      resolve(hh * 3600 + mm * 60 + ss);
    });
  });
}

// Run ffmpeg to extract frames.
//
// Args (all required unless marked optional):
//   inputPath   — absolute path to the source video
//   outDir      — absolute path to an empty directory; PNG/JPG files are
//                 written here as frame_<5-digit zero-padded number>.ext
//   fps         — frames per second to extract, > 0 (e.g. 1 means one
//                 frame per second of video)
//   format      — 'png' | 'jpg' (lowercased)
//   cancelCheck — () => boolean; returns true when the user cancelled
//                 (caller is expected to have stopped listening by then)
//   progressCb  — (opts) => void; opts = { phase, percent, note, frame? }
//                 where phase ∈ 'preparing'|'encoding'|'finalizing'|'done'
function extractFrames({ inputPath, outDir, fps, format, cancelCheck, progressCb }) {
  return new Promise((resolve, reject) => {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return reject(new Error('视频文件不存在'));
    }
    if (!outDir) return reject(new Error('outDir is required'));
    if (!(fps > 0)) return reject(new Error('fps 必须大于 0'));
    const ext = String(format || 'png').toLowerCase();
    if (ext !== 'png' && ext !== 'jpg') return reject(new Error('format 仅支持 png / jpg'));

    fs.mkdirSync(outDir, { recursive: true });

    let killed = false;
    const progress = (phase, percent, note, frame) => {
      try {
        if (typeof progressCb === 'function') {
          progressCb({ phase, percent, note: note || null, frame: frame || null });
        }
      } catch (e) {
        console.error('[video_frame_split] progressCb threw:', e);
      }
    };

    progress('preparing', 0, '正在解析视频');

    let totalSec = null;
    probeDuration(inputPath)
      .then((d) => {
        totalSec = d;
        if (cancelCheck && cancelCheck()) {
          killed = true;
          throw new Error('cancelled');
        }
        return runFfmpeg({
          inputPath, outDir, fps, ext, cancelCheck,
          onFrame: (frame) => {
            // Expected frames = totalSec * fps, clamped at >= 1 to avoid
            // div-by-zero on a zero-duration probe. We fall back to the
            // raw frame count when totalSec is missing.
            const expected = (totalSec && totalSec > 0) ? Math.max(1, Math.ceil(totalSec * fps)) : null;
            const percent = expected ? Math.min(99, Math.round((frame / expected) * 100))
                                    : null;
            progress('encoding', percent, `已提取 ${frame} 帧`, frame);
          },
        });
      })
      .then((writtenCount) => {
        if (killed) throw new Error('cancelled');
        progress('finalizing', 100, `已生成 ${writtenCount} 张图片`);
        resolve({ frames: writtenCount });
      })
      .catch((err) => {
        if (killed || (err && err.killed) || (err && err.message === 'cancelled')) {
          const e = new Error('cancelled');
          e.killed = true;
          return reject(e);
        }
        reject(err);
      });
  });
}

function runFfmpeg({ inputPath, outDir, fps, ext, cancelCheck, onFrame }) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      getFfmpegPath(),
      ['-y', '-i', inputPath, '-vf', `fps=${fps}`, path.join(outDir, `frame_%05d.${ext}`)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderrBuf = '';
    // Track whether we've resolved/rejected; ffmpeg can fire 'close' AND
    // 'error' on a SIGTERM, so the second one is a no-op.
    let settled = false;
    let cancelPoll = null;

    const cancel = () => {
      try { ff.kill('SIGTERM'); } catch {}
      // Give ffmpeg a moment to release the file handles, then escalate.
      setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 1000);
      const err = new Error('cancelled');
      err.killed = true;
      if (!settled) { settled = true; if (cancelPoll) clearInterval(cancelPoll); reject(err); }
    };

    if (typeof cancelCheck === 'function') {
      cancelPoll = setInterval(() => {
        try {
          if (cancelCheck()) cancel();
        } catch {}
      }, 250);
      // Don't keep the event loop alive just for the poller.
      if (typeof cancelPoll.unref === 'function') cancelPoll.unref();
    }

    ff.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      // Process complete lines so `frame=  123 …` updates flow promptly.
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const fm = /\bframe=\s*(\d+)/.exec(line);
        if (fm) {
          try { onFrame && onFrame(Number(fm[1])); } catch {}
        }
      }
    });

    ff.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (cancelPoll) clearInterval(cancelPoll);
      reject(err);
    });

    ff.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (cancelPoll) clearInterval(cancelPoll);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        const e = new Error('cancelled');
        e.killed = true;
        return reject(e);
      }
      if (code !== 0) {
        return reject(new Error(`ffmpeg 退出码 ${code}`));
      }
      // Count what landed. ffmpeg uses our zero-padded template, so a
      // simple glob-equivalent readdir sorted-alphabetically works.
      let count = 0;
      try {
        const entries = fs.readdirSync(outDir)
          .filter((n) => n.startsWith('frame_') && n.endsWith('.' + ext));
        count = entries.length;
      } catch (e) {
        console.error('[video_frame_split] count readdir failed:', e);
      }
      resolve(count);
    });
  });
}

module.exports = { extractFrames, probeDuration, getFfmpegPath };
