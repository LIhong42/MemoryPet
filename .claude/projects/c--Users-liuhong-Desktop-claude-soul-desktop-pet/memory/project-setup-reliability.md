---
name: project-setup-reliability
description: For SoulDesktopPet, npm install's postinstall phase is unreliable in this environment — use --ignore-scripts and manually drive the binary downloads.
metadata:
  type: project
---

When a fresh `npm install` is needed in this project, the postinstall phase that downloads the Electron and ffmpeg-static binaries hangs for 10+ minutes (stdout stays 0 bytes) and risks being aborted mid-way. A previous abort caused `node_modules/electron` to be wiped from the tree, leaving the project in a "Cannot start — node_modules/electron is missing" state even though `npm install` had reported success.

**Why:** GitHub Releases rate-limiting or .npmrc's `registry=https://registry.npmmirror.com` not applying to the binary download scripts (which read their own env vars, not NPM_CONFIG_*). See [[CLAUDE.md-independent-of-reference]] for the project's no-reference-deps rule.

**How to apply:** When `node_modules/` is empty or corrupted, do this sequence (each step foreground so progress is visible):

```bash
# 1. Install packages without postinstall scripts (14s instead of 10+min hang)
npm install --ignore-scripts --no-audit --no-fund

# 2. Download Electron binary explicitly
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules/electron/install.js

# 3. Download ffmpeg binary explicitly. NOTE: env var is FFMPEG_BINARIES_URL,
#    NOT FFMPEG_DOWNLOAD_HOST (README has it wrong). Also, install.js does
#    `fs.statSync(binaryPath).isFile()` and exits 0 if a placeholder exists,
#    so if a previous run left a stub, delete it first:
rm -f node_modules/ffmpeg-static/ffmpeg.exe
export FFMPEG_BINARIES_URL=https://npmmirror.com/mirrors/ffmpeg-static/
node node_modules/ffmpeg-static/install.js

# 4. Hoist the helper (skipped by --ignore-scripts)
node scripts/hoist-call-bind-helpers.js

# 5. Verify
npm run doctor    # expect "All checks passed"
timeout 10 node scripts/run-electron.js .   # expect "[pet_registry] loaded N pet(s)"
```

If `npm install` itself appears to hang and you kill it, RE-RUN with `--ignore-scripts` rather than restarting fresh — the partial `node_modules/` may contain enough that re-running the full install cascades into more hangs. And never TaskStop a backgrounded `npm install` while it's still touching `node_modules/electron/`; the cleanup can wipe what little it had staged.