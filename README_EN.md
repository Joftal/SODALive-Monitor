# SODALive Monitor

[简体中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Built with **Electron + Vue 3**, card-style light UI. Aggregates on-air channels from both PandaLive and SOOP — watch, record, and keep an eye on your favorite streamers (**go-live / offline / recording / fault** events fan out through a per-platform × per-event matrix to **system notifications and in-app toasts**, with optional **Telegram Bot** push); recordings are managed by the **Library** section built into the recordings page.




---

## 🛠️ Build from source

```bash
npm install            # if npm blocks postinstall scripts: node node_modules/{electron,esbuild,ffmpeg-static}/install.js one by one
npm run dev            # dev mode (HMR)
npm run build          # bundle output (out/)
npm run pack           # Windows installer + portable (release/)
npm run pack:mac       # macOS dmg + zip (run on a mac)
npm run pack:linux     # AppImage + deb (run on Linux)
npm run pack:dir       # unpacked dir only (release/win-unpacked), for packaging debugging
npm run typecheck      # type-check (main + renderer)
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
npm run build:icon     # derive png/icns + tray template from resources/icon.ico
```

**Binary mirrors**: the **install scripts of electron and ffmpeg only read environment variables** (since npm 11 every unknown `.npmrc` key prints a warning, and npm 12 will stop passing them to postinstall at all). On a slow link, prefix the first install with them:

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/"
$env:FFMPEG_BINARIES_URL="https://cdn.npmmirror.com/binaries/ffmpeg-static"
npm install

# macOS / Linux — same two variables as a line prefix
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static npm install
```

Packaging needs no environment variables: the electron archive comes from `electronDownload.mirror` in `electron-builder.yml`, the nsis / winCodeSign toolchain from `config.electron_builder_binaries_mirror` in `package.json`.

**CI**: `push` / `PR` to `main`·`dev` automatically runs `typecheck` + `verify` (`.github/workflows/ci.yml`, pure Node — no Electron launched).

**Release**: run `Actions → Build & Release` with a version number — it writes the version back into `package.json` (single source of truth), packages **all three platforms in parallel** (Windows NSIS/portable · macOS dmg/zip for both arches · Linux AppImage/deb), and publishes to Releases (tag: `v<version>`); the in-app update check reads that tag.

**Data location**: on Windows everything lives next to the executable (`data/` + `electron-data/` + `recording/`, same layout for the installer and portable builds, so the whole folder is backup-and-move); macOS `~/Library/Application Support/`; Linux `~/.config/`.

<details>
<summary><b>macOS install notes (no paid certificate)</b></summary>

The project has no Apple Developer certificate; mac artifacts are ad-hoc signed only (done automatically by an `afterPack` hook). Downloads carry the Gatekeeper quarantine attribute, so on first launch you may see **"App is damaged"** or **"cannot verify the developer"**. Either fix works:

```bash
# Option 1 (recommended): clear quarantine once and forever
xattr -cr "/Applications/SODALive Monitor.app"
```

Option 2: System Settings → Privacy & Security → click "Open Anyway" at the bottom.

> Note: the old "right-click → Open" bypass no longer works on macOS Sequoia (15) — use the methods above.
</details>


<details>
<summary><b>Code structure</b></summary>

```
src/
├─ main/                      # main process
│  ├─ index.ts                #   entry: window/tray/per-platform Origin header injection (Panda IVS stream hosts)/data-root redirect (Windows packaged only)
│  ├─ ipc.ts                  #   IPC registration (argument validation + sanitized file names)
│  ├─ i18n.ts                 #   main-process strings (toasts/tray menu)
│  ├─ util.ts                 #   data root resolution (portable / installed / dev) + shared UA
│  └─ services/
│     ├─ pandalive.ts         #   Panda API client: rate-limit queue + risk detection + dual stacks + proxy + source cache
│     ├─ soop.ts              #   SOOP API client: watch-page parsing + single-shot favorites list + session cookie renewal
│     ├─ source.ts            #   cross-platform play contract (cached hit / force fetch / explicit invalidate)
│     ├─ hlsProxy.ts          #   local HLS filter proxy for SOOP: playlist rewrite + header injection + preloading-segment filter
│     ├─ watcher.ts           #   polling engine: list mode + per-anchor + urgent/idle-pump fallback + circuit breaker (per-platform accounting)
│     ├─ recorder.ts          #   recorder: ffmpeg + stall detection + segments + remux + merge + VOD + delete (Recycle Bin)
│     ├─ thumbs.ts            #   9-grid thumbnails: frame sampling + signature cache + file-set reconciliation + orphan sweep
│     ├─ authWin.ts           #   web login window (event-driven)
│     ├─ vault.ts             #   OS secure storage for cookies (DPAPI / Keychain / libsecret)
│     ├─ secrets.ts           #   encrypted credential storage (TG bot token)
│     ├─ store.ts             #   JSON persistence (follows/settings/history)
│     ├─ notify.ts            #   in-app toasts + system notifications + TG push entry (platform × event gating)
│     ├─ telegram.ts          #   Telegram Bot push (own session + proxy + rate-limit handling)
│     ├─ tgFormat.ts          #   TG message HTML card formatting
│     ├─ logger.ts            #   runtime log files
│     └─ localMedia.ts        #   plocal:// local media protocol (video + thumbnails)
├─ preload/index.ts           # contextBridge (window.api)
├─ shared/                    # types.ts shared contracts + IPC channels · appmeta.ts brand metadata + semver compare
└─ renderer/src/              # Vue 3
   ├─ router.ts               #   /:plat/live · /:plat/recordings · /player/:plat/:id · /account · /settings (legacy deep links redirect)
   ├─ workspace.ts            #   first-level platform landing: remembers the last workspace
   ├─ views/WorkspaceView.vue #   live: on-air follows / discovery / offline follows + persistent live dock
   ├─ views/RecordingsView.vue#   recordings: overview strip + watcher summary + in-progress + library
   ├─ components/LibrarySection.vue # library (a section of the recordings page, not a page): poster wall + grouping + index rail + filters
   ├─ components/LiveDock.vue #   live dock: always-visible on-air follows, survives view switches
   ├─ views/PlayerView.vue    #   player (quality/line surfaced per real platform capability)
   ├─ views/AccountView.vue   #   account: independent sessions per platform + 4-state login + verification trail
   ├─ views/SettingsView.vue  #   settings: appearance/monitor/record/network/notify/data & logs/about
   └─ components/CinemaOverlay.vue # frosted cinema overlay: playback + merge + delete
scripts/                      # verify-*.mjs behaviour chain (12) · icon-build/tray-icon-build · sim-keepalive-scale (manual scale sim)
docs/design/                  # sodalive-ia-v1.html is the current spec (the only one; draft records stay out of the repo)
```
</details>

<details>
<summary><b>Windows packaging gotcha (winCodeSign privileges)</b></summary>

electron-builder needs to create symlinks when extracting `winCodeSign-2.6.0.7z` (mac-only signing tools); non-admin accounts fail with a privilege error. Extract manually with 7zip excluding the two mac dylibs into the cache, or enable Windows Developer Mode:

```
7za x -y -bd "-x!darwin/10.12/lib/libcrypto.dylib" "-x!darwin/10.12/lib/libssl.dylib" ^
  -o"%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" ^
  "%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/<the downloaded .7z>"
```
</details>

---

## ⚠️ Disclaimer

For personal study and research only; not affiliated with pandalive or SOOP in any way. Recorded content is subject to local laws and the platform's terms — **do not use for commercial purposes or redistribution**. The platforms contain adult content; ensure you are of legal age in your jurisdiction.

## 📄 License

[MIT](./LICENSE) · Made by [Joftal](https://github.com/Joftal)
