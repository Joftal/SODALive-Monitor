# SODALive Monitor

[中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay download**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Built on Electron + Vue 3, with light/dark themes, a Chinese/English UI, tray residency and single-instance startup.

## ✨ What it does

- Both platforms' live follows on one screen, in three views: Live following / Discover / Offline. Once signed in, one click pulls your whole site follow list into the local one.
- Each platform polls on its own timer, 30 s a round by default. Live state comes from that one official endpoint covering the whole table; per-room probing only happens when that read fails or can't judge a given room.
- A confirmed go-live pre-fetches the play source right away, so the player opens with near-zero wait. Going offline takes two consecutive rounds. Repeated failures back off into a breaker, with a separate ledger per platform.
- Recording uses `ffmpeg -c copy` (no transcoding), 900 s segments by default, with optional auto-remux to MP4 and whole-session merge. Finished Panda sessions can be downloaded as replays.
- The library — part of the recordings page — handles the output: 9-grid thumbnails, grouping by date or anchor, platform and status filters, search, and a cinema overlay that plays files in place.
- Every SOOP stream goes through a local HLS proxy that only forwards targets it issued itself, so no other local process can use it as an open relay carrying your cookies; "Copy real URL" is what gives you the official address.
- Notifications are a per-platform × per-event matrix: the in-app toast always fires, while System / Telegram / Sound are off by default.
- Three ways to sign in: web login window, pasted cookie, or managed credentials on SOOP (Panda deliberately has no credential custody). The third tab is a read-only diagnostics view.

## 📦 Install

Grab the build for your platform from [Releases](https://github.com/Joftal/pd-monitor/releases) (Windows installer or portable exe, macOS dmg/zip, Linux AppImage/deb), then sign in on the **Account** page — public rooms can be monitored without logging in, but 19+, region-locked and password rooms stay hidden.

Both platforms' APIs are hosted overseas; if a direct connection fails, set an HTTP proxy under **Settings → Network**. On Windows the data sits next to the program (`data/` + `recording/`); macOS and Linux use the standard user data directory. If macOS calls the app "damaged" on first launch, run `xattr -cr "/Applications/SODALive Monitor.app"` (the project has no developer certificate).

## 🛠️ Development

```bash
npm install
npm run dev            # dev mode
npm run build          # build the app bundle (out/)
npm run pack           # package for the current platform (release/); also pack:mac / pack:linux
npm run typecheck      # both ends
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
```

- CI runs typecheck + verify on every push / PR into `main`; releasing is `Actions → Build & Release` with an `x.y.z` input — three platforms package in parallel and append to one tag.
- If dependency install stalls on the electron / ffmpeg binaries, set `ELECTRON_MIRROR` and `FFMPEG_BINARIES_URL`; packaging needs no environment variables.
- The bulk lives in `src/main/services/`: `pandalive.ts` / `soop.ts` (API clients), `source.ts` (cross-platform source contract), `hlsProxy.ts` (SOOP local proxy), `watcher.ts` (polling), `recorder.ts` (recording); the UI is in `src/renderer/src/`, shared contracts in `src/shared/`, regression scripts in `scripts/` (verify-*.mjs behaviour chain (12)).

## ⚠️ License

Personal study and research only, unaffiliated with PandaLive or SOOP; respect local law and the platforms' terms, and don't use recordings commercially or redistribute them. [MIT](./LICENSE) · by [Joftal](https://github.com/Joftal)
