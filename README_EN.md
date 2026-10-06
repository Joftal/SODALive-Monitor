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

### Live page (one workspace per platform)
- Three views: **Live following / Discover / Offline following** (keys `1` `2` `3`, `/` focuses search). Discover is currently **Panda-only** — it reads the site's own ranking; the SOOP slot says plainly that no public Discover feed exists there rather than showing a fake list.
- The platform buttons on top carry the **on-air count** plus a breathing badge when a new go-live arrived. The monitoring pill shows that platform's own numbers (`60 s · 1.3 s` = interval · last round cost); before the first round lands it reports only the interval, and it changes wording on cooldown / not monitored / per-room fallback / round failed, with the full reason in the tooltip and a "go sign in" exit on the workspace banner (tripped or degraded rounds). The two platforms never talk over each other — a Panda breaker never hides SOOP's healthy heartbeat.
- **Sync site follows**: once logged in, one click pulls the entire site follow list into the local list (offline anchors included); the receipt reports total / added / skipped / "un-followed on site". Existing entries are never modified, and nothing is deleted locally.
- **Check one round** (SOOP) / **Pull one round** (Panda) — a manual round sharing the same 8-second floor as the automatic polling.
- The offline view counts "days since last broadcast" off the KST clock face (no record says "no broadcast record" instead of a 1970 date), sorts by days gone, can hide anything over 90 days (the chip carries how many rows that suppressed), filter to "un-followed on site", and each row has its own auto-record toggle and unfollow button.

### Monitoring logic (this layer decides what the requests cost)
- The two platforms run on independent timers, default **30 s** per round (5~600 s adjustable); requests are throttled per settings (default 1.2 s, actual spacing jittered between 0.9× and 1.1×).
- In steady state, reading live status is exactly **that one official endpoint covering the whole table**: Panda uses the bookmark endpoint (one call for all follows, "list" mode, switchable to "per-anchor"), SOOP uses the site favorites endpoint. Only when the whole-table read fails, or a room can't be judged from it, does the app fall back to per-room watch-page probes — those have a 40-request budget per round with a rotating cursor, so a 700-room library never fans out to 700 calls. Go-live detection trusts the official answer first; per-room fan-out only becomes a detection path when the whole-table read fails.
- **Instant start on go-live**: a confirmed go-live immediately pre-fetches the play source (can be turned off); failures are re-queued at 60/120/180 s, at most three times per room per session. A pre-warm hit means the player page opens with near-zero wait.
- **Offline needs two consecutive rounds** before it flips, so a single flaky round can't raise a false offline; sessions that ended while the app was closed flip the card on the first look but never get a fake offline notification.
- **Risk control and circuit breaker**: Panda, on a risk error or 3 consecutive failed rounds → exponential backoff 1/2/4/8/15 minutes, released mid-cooldown as soon as one "oracle" probe reads through; SOOP, two unreadable rounds in a row → 5 minutes of silence. The two ledgers are separate — SOOP failures never drag Panda into a breaker trip.
- **Gated rooms** get a flat 15-minute cooldown, one ledger per platform: Panda persists its 19+ / region-locked / item-purchase classes across restarts, SOOP persists password and login-required. Expiry is not a timer that re-asks — the cost unit is "one request per gated room per cold start".
- A single anchor's data error only gets booked, never tripped through the breaker; rooms confirmed as "no such room" (renamed / deregistered / wrong id) get no further requests for the rest of this run until you unfollow and re-add them — a restart gives each one more probe.

### Recording
- Manual (from the player page) or automatic (per-anchor "record on go-live"; the global default is off); `ffmpeg -c copy`, no transcoding.
- Default **900 s segments** (0 = one file, no splitting; range 60~7200), optional **TS→MP4 auto-remux** (on by default) and **whole-session merge** (requires segments + remux). Finished Panda sessions support **replay download**: completion is ffmpeg's reported downloaded media time over the full length estimated from the m3u8 playlist — no percentage is shown when that estimate is unavailable.
- Disk-free gate (default 1 GB, rechecked every 30 s while recording), 60 s without byte growth counts as a stall, optional auto-retry (off by default; max 3 tries, 10/20/40 s backoff, each retry on a freshly fetched source).
- Files land in `<record root>/<platform>/<nickname>(<anchor ID>)/`; stopping goes through a graceful teardown, and quitting during remux gets intercepted once.

### Library (a section of the recordings page, not a separate page)
- 9-grid thumbnails sampled by ffmpeg and persisted under `data/thumbs`; grouped by date or by anchor with a sticky index rail on the right (click to jump, scroll to follow), platform filter, status filter (live / replay / whole session / error), and keyword search over title, nickname and room ID.
- The built-in frosted cinema overlay plays local files directly, and merge/delete can be started from inside it.

### Watching
- hls.js low-latency playback, outer retry cap 3 fatal network errors (then it hands off to a source refresh instead of reconnecting a dead source forever), media-error self-heal.
- **All SOOP streams go through a local HLS proxy bound to `127.0.0.1` on a random port**: it rewrites the playlist, attaches Origin/Cookie on the way out, drops preloading segments, and refuses any target it did not issue itself (per-process token on every request + a 32-entry origin allowlist). So no other local process or web page can use it as an open relay carrying your cookies. That is why "Copy" hands you a local address while "Copy real URL" resolves the official one — the local address is useless off this machine, by design.
- Quality switching (options come from the room's real master playlist; the control collapses entirely on single-bitrate rooms), Panda backup-line switching and the **source keep-alive pump** (SOOP shows "N/A — its sources are re-minted on demand"), password room and 19+/region-locked masks, follow switching, manual source refresh, plus when the source was fetched and how old it is.

### Notifications
- The in-app toast is the immediate feedback for every event and is **deliberately not governed by the matrix** (turning off system notifications shouldn't swallow what is already on screen). The matrix itself is 4 events (go-live / offline / recording / fault) × 3 columns (**System / Telegram / Sound**), **all off by default**, one panel per platform with its own "enable all / disable all" (muting one platform shouldn't silence the other); the sound column only has a switch on the go-live row.
- Telegram: bot token lives in OS secure storage (DPAPI / Keychain / libsecret), with its own optional proxy; the HTML card is localized to the app language, with rate-limit retries and over-long trimming. It is a side channel — a failed push only lands in the log and never affects the toast or system notification. **Only Panda cards carry a live link** (a SOOP source is a local proxy address, pointless to paste out).

### Account
- Three login methods: **web login window** (official site, event-driven success detection), **pasted cookie** (Panda only accepts it after server-side verification), **SOOP managed credentials** (stored only after verification passes; on session-expired error -6 the main process re-logs in once in the background, 60 s cooldown).
- The Panda side deliberately offers **no** credential custody (the two platforms have different risk-control profiles). Login state is three-valued: signed in / credentials stored but verification failed / not signed in — and "not signed in" is not shown before the first check returns.

### App level
- Light/dark themes and Chinese/English UI apply instantly; the rest of the settings use dirty tracking and only submit changed keys. Tray-resident (closing the window minimizes to tray by default), single instance (a second launch focuses the existing window).
- Frameless window 1380×880 (minimum 1024×660), global search (nickname / room title / ID).
- **Update check is manual**: it follows the `releases/latest` redirect and compares the tag it lands on — deliberately not the REST API, whose anonymous 60 req/IP/hour limit would blow up on a shared exit IP. It reports the version and opens the release page; it never downloads or installs anything.
- **Diagnostics** (the third tab): a read-only view of polling cadence, request throttling, source cache, gate cooldowns, breaker ledgers, the HLS proxy and the log tail. Polls every 2 s with a 4 s deadline per call, can be switched to manual, **pauses while the window is hidden**, and **sends no requests of its own**. It never displays cookie / token / managed-password values.

### Network prerequisite
Both platforms' APIs are hosted overseas. If a direct connection fails, set an HTTP proxy under **Settings → Network** (e.g. `http://127.0.0.1:7890`); Telegram can point at its own proxy in the Push & Behavior section, and falls back to the global one when left empty. Settings pages are laid out as Appearance / Recording / Network / Push & Behavior / Data & Logs / Panda / SOOP / About, and `?sec=` deep-links one of them.

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
