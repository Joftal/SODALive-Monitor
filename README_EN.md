# SODALive Monitor

[中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay download**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Built on Electron + Vue 3. It keeps both platforms' live follows on one screen: polls for go-lives in the background, plays streams in-app, records with ffmpeg, and manages the resulting files in a built-in library.

## ✨ What it does

- One screen for both platforms, with three views: Live following / Discover / Offline following. Discover is currently Panda-only (the site has no public feed for SOOP, and the app says so instead of faking a list). Once signed in, one click pulls your entire site follow list into the local one.
- Each platform polls on its own timer, 30 s a round by default. A steady round reads live state from that one official endpoint covering the whole table; per-room probing only happens when the whole-table read fails or can't judge a given room.
- A confirmed go-live pre-fetches the play source immediately, so the player opens with near-zero wait. Going offline takes two consecutive rounds before it announces anything. Repeated failures back off into a breaker, and the two platforms keep separate ledgers — one going quiet never hides the other's heartbeat.
- Recording uses `ffmpeg -c copy` (no transcoding), 900 s segments by default, with optional auto-remux to MP4 and whole-session merge. Finished Panda sessions can be downloaded as replays. Low disk space or stalled byte growth stops things on their own.
- The library — a section of the recordings page — manages the output: ffmpeg-sampled 9-grid thumbnails, grouping by date or anchor, platform and status filters, search by title / nickname / ID, and a frosted cinema overlay that plays files in place.
- Every SOOP stream goes through a local HLS proxy on `127.0.0.1`: it only forwards targets it issued itself, so no other local process or web page can use it as an open relay carrying your cookies. That's why "Copy" hands you the local address and "Copy real URL" resolves the official one.
- Notifications are a per-platform × per-event matrix: the in-app toast always fires (it's deliberately not governed by any switch), while System / Telegram / Sound are off by default. The Telegram bot token lives in OS secure storage.
- Three ways to sign in: web login window, pasted cookie, or managed credentials on SOOP. Panda deliberately offers no credential custody.
- Light and dark themes and the Chinese/English UI apply instantly; tray-resident, single instance. The in-app "check for updates" is manual — it compares against the latest GitHub release tag and never downloads or installs anything.
- The third tab is a read-only diagnostics view — polling cadence, request throttling, source cache, breaker ledgers and the log tail — which sends no requests of its own.

## 📦 Install

Grab the build for your platform from [Releases](https://github.com/Joftal/pd-monitor/releases): installer or portable exe on Windows, dmg/zip for Intel and Apple Silicon on macOS, AppImage and deb on Linux. First thing after installing is signing in on the **Account** page — public rooms can be monitored without logging in, but 19+, region-locked and password rooms stay hidden.

Both platforms' APIs are hosted overseas. If a direct connection fails, set an HTTP proxy under **Settings → Network** (e.g. `http://127.0.0.1:7890`).

**Where the data lives**: on Windows (installer and portable alike) everything sits next to the program — `data/` + `recording/` + `electron-data/`, so the folder can be backed up and moved as a whole. macOS and Linux use the standard user data directory.

<details>
<summary><b>macOS says the app is "damaged" on first launch</b></summary>

The project has no Apple developer certificate, so mac builds are ad-hoc signed. Files downloaded by a browser carry the quarantine flag; clear it once:

```bash
xattr -cr "/Applications/SODALive Monitor.app"
```

</details>

## 🛠️ Development

```bash
npm install            # first-time deps
npm run dev            # dev mode
npm run build          # build the app bundle (out/)
npm run typecheck      # both ends (tsc + vue-tsc)
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
npm run pack           # package for the current platform (release/); also pack:mac / pack:linux
```

**CI**: `push` / `PR` into `main` runs `typecheck` + `verify`.
**Releasing**: `Actions → Build & Release`, enter `x.y.z` — the version is written back to `package.json`, three platforms package in parallel, artifacts are appended to one tag, and the download table plus changelog are written once at the end.
**Slow mirrors**: if installing dependencies stalls on the electron / ffmpeg binaries, set `ELECTRON_MIRROR` and `FFMPEG_BINARIES_URL` (npmmirror) for that install; packaging needs no environment variables.

<details>
<summary><b>Code layout</b></summary>

```
src/main/            # main process
  index.ts ipc.ts i18n.ts util.ts
  services/
    pandalive.ts     #   Panda API client (rate-limited queue + risk detection + dual request stacks + gate ledger)
    soop.ts          #   SOOP API client (playback chain parsing + site favorites + session renewal + managed re-login)
    source.ts        #   cross-platform source contract: cache hit / force refetch / explicit invalidate
    hlsProxy.ts      #   SOOP local HLS proxy (playlist rewrite + auth headers + local token check)
    watcher.ts       #   polling engine (list/per-anchor + per-room fallback + prewarm retries + per-platform backoff)
    recorder.ts      #   recording engine (ffmpeg + stall detection + disk gate + segments/remux/merge + replay download)
    thumbs.ts store.ts vault.ts secrets.ts logger.ts
    netGate.ts       #   per-domain throttle lanes + queue cap + timeouts raised as failures
    imgCache.ts      #   in-memory card image cache (key normalization + LRU pruning)
    settingsGuard.ts #   settings write gate: out-of-range values rejected, old value kept
    notify.ts telegram.ts tgFormat.ts   # toast / system notification / TG push
    diag.ts authWin.ts localMedia.ts
src/preload/         # contextBridge (window.api)
src/shared/          # shared data contracts and defaults · brand metadata · image cache domain · m3u8 parsing
src/renderer/src/    # Vue3: live / recordings / player / account / settings / diag views + components
scripts/             # verify-*.mjs behaviour chain (12) · icon derivation · mac ad-hoc signing hook
docs/design/         # sodalive-ia-v1.html, the current design mockup
```

</details>

## ⚠️ Disclaimer

Personal study and research only, unaffiliated with PandaLive or SOOP. Respect local law and the platforms' terms when recording, and **do not use it commercially or redistribute recordings**. Both platforms carry adult sections — make sure you're of legal age where you are.

## 📄 License

[MIT](./LICENSE) · by [Joftal](https://github.com/Joftal)
