# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放下载** 一体化桌面客户端（Windows · macOS · Linux）

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

基于 Electron + Vue 3，明暗两套主题、中英界面，托盘常驻、单实例。

## ✨ 功能

- 一屏看两个平台的在播关注，三档视图：在播 / 站内发现 / 离线。登录后能一键把站内关注整表搬进本地。
- 按平台独立轮询开播，默认 30 秒一轮。状态读取优先走那一发覆盖全表的官方接口，读不通或某间判不出来才回落逐房探测。
- 确认开播就立刻预取播放源，进播放页几乎零等待；下播要连续两轮确认才发声。连续失败退避熔断，两平台各记各的账。
- 录制走 `ffmpeg -c copy` 不转码，默认 900 秒分段，可自动转 MP4、整场合并；Panda 的已结束场次支持下载回放。
- 录制页里的「库」管成片：九宫格缩略图、按日期或主播分组、筛平台与状态、搜标题/昵称/ID，影院浮层直接播放。
- SOOP 的流一律经本机 HLS 代理，只转发它自己签发过的地址，本机其它程序占不了这个便宜；「复制真实源」才给官方地址。
- 通知是「平台 × 事件」矩阵：应用内气泡一定弹，系统通知 / Telegram / 提示音默认全关。
- 登录三种方式：网页登录窗、粘贴 Cookie、SOOP 托管账密（Panda 刻意不托管账密）。第三个标签页是只读的诊断台。

## 📦 安装

从 [Releases](https://github.com/Joftal/pd-monitor/releases) 下载对应平台的产物（Windows 安装包 / 便携版，macOS dmg / zip，Linux AppImage / deb），装好后先到**账号页**登录 —— 不登录只能看公开房间。

两个平台的接口都在境外，直连不通时在 **设置 → 网络** 填 HTTP 代理。数据 Windows 与程序同目录（`data/` + `recording/`），macOS / Linux 在系统用户数据目录。macOS 首次打开若提示「已损坏」，执行 `xattr -cr "/Applications/SODALive Monitor.app"`（项目未买开发者证书）。

## 🛠️ 开发

```bash
npm install
npm run dev            # 开发模式
npm run build          # 产物构建(out/)
npm run pack           # 打包当前平台(release/), mac/linux 用 pack:mac / pack:linux
npm run typecheck      # 双端类型检查
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
```

- CI 在 push / PR 进 `main` 时跑 typecheck + verify；发版走 `Actions → Build & Release` 填 `x.y.z`，三平台并行打包后追加到同一个 tag。
- 装依赖卡在 electron / ffmpeg 二进制时，按需带上 `ELECTRON_MIRROR` 与 `FFMPEG_BINARIES_URL` 两个环境变量；打包期不需要。
- 主体在 `src/main/services/`：`pandalive.ts` / `soop.ts` 两平台 API 客户端、`source.ts` 跨平台取流、`hlsProxy.ts` SOOP 本地代理、`watcher.ts` 轮询、`recorder.ts` 录制；渲染层在 `src/renderer/src/`，双端契约在 `src/shared/`，回归脚本在 `scripts/`（verify-*.mjs 行为回归链(12 个)）。

## ⚠️ 免责与 License

仅供个人学习研究，与 PandaLive、SOOP 官方无任何关联；录制内容请遵守当地法规与平台条款，勿商用或二次分发。[MIT](./LICENSE) · 制作 [Joftal](https://github.com/Joftal)
