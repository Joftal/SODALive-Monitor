# SODALive Monitor

[简体中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay download**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Built with **Electron + Vue 3 + naive-ui**, light/dark themes, Chinese + English UI. On-air follows from both platforms live on one screen: **long-running polling for go-lives**, **in-app watching**, **ffmpeg recording and replay download**, with every output file managed by the **Library** section built into the recordings page. **Go-live / offline / recording / fault** events always raise an in-app toast first, then a per-platform × per-event matrix decides whether they additionally reach the system notification center, Telegram, or the speaker.

---

## ✨ What it does today

- **Interface**: one workspace per platform, three views — **Live following / Discover / Offline following** (keys `1` `2` `3`, `/` searches). The platform buttons on top carry the on-air count plus a "new go-live" badge, and the monitoring pill reports that platform's own cadence. The offline view counts "days since last broadcast" off the KST clock. Discover is currently **Panda-only** — SOOP's slot says plainly that no public feed exists there rather than showing a fake list. Once signed in, one click pulls the entire site follow list into the local one; existing entries are never modified or deleted.
- **Monitoring**: the two platforms run on independent timers, **30 s** a round by default. In steady state, reading live status is exactly that one official endpoint covering the whole table; only when the whole-table read fails — or a room can't be judged from it — does the app fall back to per-room probes, and those run on a per-round budget with a rotating cursor, so a 700-room library never fans out to 700 calls. A confirmed go-live pre-fetches the play source immediately, so the player opens with near-zero wait; going offline needs two consecutive rounds, so one flaky round can't raise a false offline. Risk errors or repeated failures back off into a breaker that a single successful probe releases early — and the two platforms keep separate ledgers, so a Panda trip never hides SOOP's healthy heartbeat.
- **Recording**: manual from the player, or automatic per anchor via "record on go-live" (off globally by default). `ffmpeg -c copy`, no transcoding, **900 s** segments by default, with optional TS→MP4 auto-remux and whole-session merge. Finished Panda sessions support **replay download** — completion is measured against the length estimated from the playlist, and no percentage is shown when that estimate isn't available. Low disk space or bytes that stop growing both halt things cleanly, and files land in `<record root>/<platform>/<nickname>(<anchor ID>)/`.
- **Library**: a section of the recordings page, not a separate page. ffmpeg samples the 9-grid thumbnails and keeps them on disk; group by date or by anchor with a sticky index rail on the right (click to jump, scroll to follow), filter by platform and status, search by title / nickname / ID. The built-in frosted cinema overlay plays local files and can start a merge or delete from inside it.
- **Watching**: hls.js low-latency playback with a cap on outer retries and media-error self-heal. **Every SOOP stream goes through a local HLS proxy bound to `127.0.0.1` on a random port** — it rewrites the playlist, attaches Origin/Cookie on the way out, and refuses any target it did not issue itself, so no other local process or web page can use it as an open relay carrying your cookies, and the local address is useless off this machine by design. That's why "Copy" hands you the local address while "Copy real URL" resolves the official one. Quality switching, backup lines and the source keep-alive pump only appear where the platform actually has that capability; password rooms and 19+/region-locked rooms get a mask.
- **Notifications**: go-live / offline / recording / fault always raise an in-app toast first, and the toast is deliberately **not** governed by any switch — turning off system notifications shouldn't swallow what's already on screen. Whether it *additionally* goes to **System / Telegram / Sound** is decided by a per-platform × per-event matrix, **all off by default**, one panel per platform. The Telegram bot token lives in OS secure storage (DPAPI / Keychain / libsecret), cards follow the app language, and it's a side channel: a failed push only lands in the log.
- **Account**: three ways in — a **web login window** on the official site, a **pasted cookie** (Panda adopts it only after server-side verification), and **SOOP managed credentials** (on a session-expired error the main process re-logs in once in the background). Panda deliberately offers no credential custody, since its risk-control profile differs. Login state is three-valued: signed in / credentials stored but verification failed / not signed in.
- **App level**: light/dark themes and the Chinese/English UI apply instantly; settings use dirty tracking and only submit changed keys; tray-resident, single instance. **The update check is manual** — it compares against the latest GitHub release tag and opens the release page, and never downloads or installs anything. The third tab is a read-only **diagnostics** view: polling cadence, request throttling, source cache, gate cooldowns, breaker ledgers and the log tail, with no requests of its own and no cookie / token / managed-password values on screen.

### Network prerequisite
Both platforms' APIs are hosted overseas. If a direct connection fails, set an HTTP proxy under **Settings → Network** (e.g. `http://127.0.0.1:7890`); Telegram can point at its own proxy in the Push & Behavior section, and falls back to the global one when left empty.

---

## 📦 Install

Grab the artifact for your platform from [Releases](https://github.com/Joftal/pd-monitor/releases): Windows has an NSIS installer and a portable build, macOS has dmg and zip for both Intel and Apple Silicon, Linux has AppImage and deb. First thing after install is signing in on the **account** page (public rooms can be monitored without a login, but 19+, region-locked and password rooms stay invisible).

<details>
<summary><b>Data location</b></summary>

- **Windows (identical for installer and portable)**: all data lives next to the executable — `data/` (`db.json` follows + settings, `vault.dat` encrypted cookies, `secrets.dat` encrypted credentials, `thumbs/`, `logs/`) + `electron-data/` (Chromium runtime) + `recording/` (default record root). The whole folder is backup-and-move; an NSIS upgrade uninstall only removes files on the install manifest, so `data/` is naturally kept.
- **macOS / Linux packaged builds**: `.app` and AppImage are read-only bundles, so data goes to the system user-data directory (an app folder under macOS `~/Library/Application Support/`, Linux `~/.config/`), with the same `data/` + `recording/` layout inside.
- **Development**: all three platforms use the project root.
- Data left over from internal builds before 2026-09, scattered in `%APPDATA%/pandalive-monitor/plm-data`, is claimed automatically on first launch (fills gaps only, never overwrites).
</details>

<details>
<summary><b>macOS install notes (no paid certificate)</b></summary>

The project has no Apple Developer certificate; mac artifacts are ad-hoc signed by an `afterPack` hook, which then runs `codesign --verify` on itself and fails the build if the signature is invalid. Downloads carry the Gatekeeper quarantine attribute, so on first launch you may see **"App is damaged"** or **"cannot verify the developer"**. Either fix works:

```bash
# Option 1 (recommended): clear quarantine once and forever
xattr -cr "/Applications/SODALive Monitor.app"
```

Option 2: System Settings → Privacy & Security → click "Open Anyway" at the bottom.

> The old "right-click → Open" bypass no longer works on macOS Sequoia (15) — use the methods above. Same applies if you drag out of the dmg somewhere other than "Applications".
</details>

---

## 🛠️ Build from source

```bash
npm install            # if npm blocks postinstall scripts: node node_modules/{electron,esbuild,ffmpeg-static}/install.js one by one
npm run dev            # dev mode (HMR)
npm run build          # bundle output (out/)
npm run pack           # Windows installer + portable (release/)
npm run pack:mac       # macOS dmg + zip, both arches (run on a mac)
npm run pack:linux     # AppImage + deb (run on Linux)
npm run pack:dir       # unpacked dir only (release/win-unpacked), for packaging debugging
npm run typecheck      # type-check both sides (tsc + vue-tsc)
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
npm run build:icon     # derive png/icns + mac tray template from resources/icon.ico
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

**CI**: `push` / `PR` to `main` automatically runs `typecheck` + `verify` (`.github/workflows/ci.yml`, ubuntu, pure Node — no Electron launched, and that ~100MB electron binary download skipped).

**Release**: run `Actions → Build & Release` with a version number — a single `bump` job writes the version back into `package.json` and commits it (the one source of truth; re-running the same version is idempotent), then **all three platforms package in parallel** (Windows NSIS/portable · macOS dmg/zip for both arches · Linux AppImage/deb). Every platform job runs `typecheck` + `verify` before producing artifacts; assets append to the same tag (`v<version>`), and `finalize` writes the download table and changelog in one pass. The in-app update check reads that tag.

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
│     ├─ pandalive.ts         #   Panda API client: rate-limit queue + risk detection + dual request stacks + proxy + source cache + gate ledger
│     ├─ soop.ts              #   SOOP API client: watch-page parsing + one-shot favorites list + session cookie renewal + managed re-login
│     ├─ source.ts            #   cross-platform play contract (cached hit / force fetch / explicit invalidate): recording and playback don't care about platform
│     ├─ hlsProxy.ts          #   SOOP local HLS proxy: playlist rewrite + auth header injection + preloading filter + token & issued-origin gate
│     ├─ watcher.ts           #   polling engine: list / per-anchor modes + urgent/idle-pump fallback + prewarm re-queue + circuit breaker (per-platform accounting)
│     ├─ recorder.ts          #   recorder: ffmpeg + stall detection + disk gate + segments + remux + merge + auto-retry + VOD + delete (Recycle Bin)
│     ├─ thumbs.ts            #   9-grid thumbnails: frame sampling + signature cache + file-set reconciliation + orphan sweep
│     ├─ authWin.ts           #   web login window (event-driven)
│     ├─ vault.ts             #   OS secure storage for cookies (DPAPI / Keychain / libsecret)
│     ├─ secrets.ts           #   encrypted credential storage (TG bot token / managed credentials)
│     ├─ store.ts             #   JSON persistence (follows/settings/history)
│     ├─ settingsGuard.ts     #   settings write gate: out-of-range values rejected, previous value kept (no clamping)
│     ├─ netGate.ts           #   per-host throttled lanes + queue-depth cap + timeouts thrown as failures
│     ├─ imgCache.ts          #   in-memory card-image cache (key normalization + LRU pruning)
│     ├─ notify.ts            #   in-app toast (always) + system notification + TG push (matrix gating)
│     ├─ telegram.ts          #   Telegram Bot push (own session + proxy + rate-limit handling)
│     ├─ tgFormat.ts          #   TG message HTML card formatting
│     ├─ diag.ts              #   diagnostics snapshot projection (read-only) + ring-buffered logs
│     ├─ logger.ts            #   runtime log files
│     └─ localMedia.ts        #   plocal:// local media protocol (video + thumbnails)
├─ preload/index.ts           # contextBridge (window.api)
├─ shared/                    # types.ts shared contracts + defaults · appmeta.ts brand metadata + semver compare ·
│                             #   imgUrl.ts image-cache domain check · hlsPlaylist.ts playlist parsing
└─ renderer/src/              # Vue 3
   ├─ router.ts               #   /:plat/live · /:plat/recordings · /player/:plat/:id · /account · /settings · /diag (legacy deep links redirect)
   ├─ workspace.ts            #   first-level platform landing: remembers the last workspace
   ├─ views/WorkspaceView.vue #   live: Live following / Discover / Offline following
   ├─ views/RecordingsView.vue#   recordings: overview strip + in-progress + library
   ├─ components/LibrarySection.vue # library (a section of the recordings page, not a page): poster wall + grouping + index rail + filters
   ├─ views/PlayerView.vue    #   player (quality/line surfaced per real platform capability)
   ├─ views/AccountView.vue   #   account: independent sessions per platform + 3-state login + verification trail
   ├─ views/SettingsView.vue  #   settings: appearance/record/network/push & behavior/data & logs/Panda/SOOP/about (`?sec=` deep-links a section)
   ├─ views/DiagnosticsView.vue # diagnostics tab (read-only, 2 s poll with a deadline, pauses when hidden)
   └─ components/CinemaOverlay.vue # frosted cinema overlay: playback + merge + delete
scripts/                      # verify-*.mjs behaviour chain (12) · icon-build/tray-icon-build icon derivation ·
│                             #   adhoc-sign-mac.js mac ad-hoc signing hook · sim-keepalive-scale.mjs keep-alive scale sim (manual)
docs/design/                  # sodalive-ia-v1.html is the current spec (the only self-contained one; draft records stay out of the repo)
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

For personal study and research only; not affiliated with PandaLive or SOOP in any way. Recorded content is subject to local laws and the platform's terms — **do not use for commercial purposes or redistribution**. The platforms contain adult content; ensure you are of legal age in your jurisdiction.

## 📄 License

[MIT](./LICENSE) · Made by [Joftal](https://github.com/Joftal)
