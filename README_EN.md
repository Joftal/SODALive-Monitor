# SODALive Monitor

[中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay download**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/SODALive-Monitor)](https://github.com/Joftal/SODALive-Monitor/releases)

Electron + Vue 3.

## ✨ Features

- **Live page**: Live following / Discover / Offline views, global search, one-click sync of site follows, per-anchor auto-record toggle.
- **Monitoring**: independent per-platform polling (30 s by default), go-live source pre-fetch, two-round offline confirmation, backoff on repeated failures.
- **Recording**: manual or automatic on go-live, `ffmpeg -c copy` without transcoding, 900 s segments, TS→MP4 remux, whole-session merge, Panda replay download.
- **Library**: 9-grid thumbnails, grouping by date or anchor, platform and status filters, keyword search, built-in overlay player.
- **Watching**: hls.js low latency, quality switching, Panda backup lines and source keep-alive, password and 19+ masks, SOOP through a local HLS proxy.
- **Notifications**: in-app toast; System / Telegram / Sound gated by platform × event, all off by default.
- **Account**: web login window, pasted cookie, managed credentials on SOOP (no custody on Panda).
- **Misc**: light/dark themes, Chinese/English UI, tray residency, single instance, manual update check, read-only diagnostics tab.

## 📦 Install

Get the package for your platform from [Releases](https://github.com/Joftal/SODALive-Monitor/releases): Windows installer / portable exe, macOS dmg / zip, Linux AppImage / deb. Sign in on the Account page after installing.

Both APIs are hosted overseas — if a direct connection fails, set an HTTP proxy under **Settings → Network**. Data lives next to the program on Windows (`data/` and `recording/`) and in the user data directory on macOS / Linux. If macOS reports the app as "damaged" on first launch, run `xattr -cr "/Applications/SODALive Monitor.app"`.

## 🛠️ Development

```bash
npm install
npm run dev            # dev mode
npm run build          # build the app bundle (out/)
npm run pack           # package for the current platform (release/); pack:mac / pack:linux for the others
npm run typecheck      # both ends
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
```

- CI: typecheck + verify on every push / PR into `main`.
- Release: `Actions → Build & Release` with an `x.y.z` input; three platforms build in parallel and append to one tag.
- Stalls on the electron / ffmpeg binaries: set `ELECTRON_MIRROR` and `FFMPEG_BINARIES_URL`, then install again.
- Where things are: `src/main/services/` holds the core (`pandalive.ts` / `soop.ts` API clients, `source.ts` source fetching, `hlsProxy.ts` local proxy, `watcher.ts` polling, `recorder.ts` recording), `src/renderer/src/` the UI, `src/shared/` the shared contracts, and `scripts/` the regression suite (verify-*.mjs behaviour chain (12)).

## ⚠️ License

Personal study and research only, unaffiliated with PandaLive or SOOP; follow local law and the platforms' terms about recordings, no commercial use or redistribution. [MIT](./LICENSE) · [Joftal](https://github.com/Joftal)
