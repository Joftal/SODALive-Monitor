# SODALive Monitor

[中文](./README.md) | English

> All-in-one desktop client for **PandaLive + SOOP** (Windows · macOS · Linux): **live monitoring · watching · recording · replay download**

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

Written in Electron + Vue 3. Light and dark themes, Chinese and English UI, and it can sit in the tray.

## ✨ What it does

- Live follows from both platforms on one screen, in three views: Live following / Discover / Offline. Only Panda has a site-wide ranking — SOOP has no public feed, and the app just says so instead of showing a fake list. Once you're signed in, you can sync your site follows into the local list in one click.
- Each platform polls on its own timer, 30 s a round by default. Live state comes from one official call that returns the whole table; a room is only probed on its own when that call fails, or when the table can't tell you its state.
- When a go-live is confirmed the play source is fetched right away, so the player doesn't have to wait. Deciding that a stream ended takes two rounds in a row, so one bad network round can't announce an offline that never happened. Repeated failures back off, and each platform keeps its own count.
- Recording is `ffmpeg -c copy`, no transcoding, with 900 s segments by default; you can have it remux to MP4 automatically and merge the whole session afterwards. Panda sessions that already ended can be downloaded as replays.
- The recordings come out into the library, which is a section of the recordings page: 9-grid thumbnails, grouping by date or by anchor, platform and status filters, search by title / nickname / ID, and playback without leaving the page.
- SOOP's stream URLs don't work in a player unless the Origin and Cookie headers are there, so there's a small proxy on `127.0.0.1` that forwards them and rewrites the playlists. The practical part: "Copy" gives you the local address, and "Copy real URL" is what resolves the official one.
- Notifications are switched per platform and per event. The in-app toast is always there; system notifications, Telegram and the sound stay off until you turn them on.
- Three ways to sign in: a web login window, a pasted cookie, or managed credentials on SOOP (Panda has no credential custody). The third tab is the diagnostics page, which shows polling, throttling, caches and the log read-only.

## 📦 Install

Downloads are on [Releases](https://github.com/Joftal/pd-monitor/releases): Windows installer and portable exe, macOS dmg and zip (Intel and Apple Silicon), Linux AppImage and deb. After installing, sign in on the Account page first — public rooms can be monitored without an account, but 19+, region-locked and password rooms stay hidden.

Both platforms' APIs are hosted overseas, so if a direct connection fails, put an HTTP proxy into **Settings → Network**. Data sits next to the program on Windows (`data/` and `recording/`) and in the usual user data directory on macOS and Linux. If macOS claims the app is "damaged" the first time you open it, that's because the project has no Apple developer certificate — run `xattr -cr "/Applications/SODALive Monitor.app"` to drop the quarantine flag.

## 🛠️ Development

```bash
npm install
npm run dev            # dev mode
npm run build          # build the app bundle (out/)
npm run pack           # package for the current platform (release/); pack:mac / pack:linux for the others
npm run typecheck      # both ends
npm run verify         # behaviour regression chain: 12 pure-Node scripts (design contract / data root / source cache / keep-alive / net gate / recording pipeline / settings write chain / VOD duration / follows / image cache / deep links / notifications)
```

- CI runs typecheck and verify on every push / PR into `main`. To release, run `Actions → Build & Release` with an `x.y.z` input; the three platforms build in parallel and their artifacts are appended to one tag.
- If installing dependencies hangs on the electron or ffmpeg binaries, set `ELECTRON_MIRROR` and `FFMPEG_BINARIES_URL` and install again; packaging doesn't need them.
- Most of the logic is in `src/main/services/`: `pandalive.ts` and `soop.ts` are the two API clients, `source.ts` fetches and caches play sources, `hlsProxy.ts` is that local proxy mentioned above, `watcher.ts` is the polling engine and `recorder.ts` the recording engine. The UI is in `src/renderer/src/`, the types and defaults both ends share are in `src/shared/`, and the regression scripts are in `scripts/` (verify-*.mjs behaviour chain (12)).

## ⚠️ License

For personal study and research only, with no affiliation to PandaLive or SOOP. Please follow local law and the platforms' terms about recordings, and don't use them commercially or redistribute them. [MIT](./LICENSE) · [Joftal](https://github.com/Joftal)
