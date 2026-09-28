# PandaLive Monitor

[简体中文](./README.md) | English

> All-in-one desktop client for pandalive.co.kr (Windows · macOS · Linux): **live monitoring · watching · recording · replay**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Built with **Electron + Vue 3**, card-style light UI. Aggregates every live channel on the platform — watch, record, and keep an eye on your favorite streamers (go-live / room-change alerts via **system notifications and in-app toasts**, with optional **Telegram Bot** push); recordings are managed in a built-in **video library**.




---

## 🛠️ Build from source

```bash
npm install            # if npm blocks postinstall scripts: node node_modules/{electron,esbuild,ffmpeg-static}/install.js one by one
npm run dev            # dev mode (HMR)
npm run build          # bundle output (out/)
npm run pack           # Windows installer + portable (release/)
npm run pack:mac       # macOS dmg + zip (run on a mac)
npm run pack:linux     # AppImage + deb (run on Linux)
npm run typecheck      # type-check (main + renderer)
```

**Release**: run `Actions → Build & Release` with a version number — it writes the version back into `package.json` (single source of truth), packages **all three platforms in parallel** (Windows NSIS/portable · macOS dmg/zip for both arches · Linux AppImage/deb), and publishes to Releases (tag: `v<version>`); the in-app update check reads that tag.

<details>
<summary><b>macOS install notes (no paid certificate)</b></summary>

The project has no Apple Developer certificate; mac artifacts are ad-hoc signed only (done automatically by an `afterPack` hook). Downloads carry the Gatekeeper quarantine attribute, so on first launch you may see **"App is damaged"** or **"cannot verify the developer"**. Either fix works:

```bash
# Option 1 (recommended): clear quarantine once and forever
xattr -cr "/Applications/PandaLive Monitor.app"
```

Option 2: System Settings → Privacy & Security → click "Open Anyway" at the bottom.

> Note: the old "right-click → Open" bypass no longer works on macOS Sequoia (15) — use the methods above.
</details>


<details>
<summary><b>Code structure</b></summary>

```
src/
├─ main/                  # main process
│  ├─ index.ts            #   entry: window/tray/stream-domain Origin header injection/Chromium data redirected to app folder
│  ├─ ipc.ts              #   IPC registration
│  ├─ i18n.ts             #   main-process strings (toasts/tray menu)
│  └─ services/
│     ├─ pandalive.ts     #   API client: rate-limit queue + risk detection + dual stacks + proxy + source cache
│     ├─ watcher.ts       #   polling engine: list mode + per-anchor + urgent/idle-pump fallback + circuit breaker
│     ├─ recorder.ts      #   recorder: ffmpeg + stall detection + segments + remux + merge + VOD + delete (Recycle Bin)
│     ├─ thumbs.ts        #   9-grid thumbnails: frame sampling + signature cache + file-set reconciliation + orphan sweep
│     ├─ authWin.ts       #   web login window (event-driven)
│     ├─ vault.ts         #   DPAPI-encrypted cookie vault
│     ├─ secrets.ts       #   encrypted credential storage (TG bot token)
│     ├─ store.ts         #   JSON persistence (follows/settings/history)
│     ├─ notify.ts        #   in-app toasts + system notifications + TG push entry
│     ├─ telegram.ts      #   Telegram Bot push (own session + proxy + rate-limit handling)
│     ├─ tgFormat.ts      #   TG message HTML card formatting
│     ├─ logger.ts        #   runtime log files
│     └─ localMedia.ts    #   plocal:// local media protocol (video + thumbnails)
├─ preload/index.ts       # contextBridge (window.api)
├─ renderer/src/          # Vue 3 (hall/following/player/recordings/library/account/settings)
│  ├─ views/LibraryView.vue       # video library: poster wall + grouping + index rail + filters
│  └─ components/CinemaOverlay.vue # frosted cinema overlay: playback + merge + delete
└─ shared/types.ts        # shared contracts + IPC channels
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

For personal study and research only; not affiliated with pandalive in any way. Recorded content is subject to local laws and the platform's terms — **do not use for commercial purposes or redistribution**. The platform contains adult content; ensure you are of legal age in your jurisdiction.

## 📄 License

[MIT](./LICENSE) · Made by [Joftal](https://github.com/Joftal)
