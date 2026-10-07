# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放下载** 一体化桌面客户端（Windows · macOS · Linux）

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/SODALive-Monitor)](https://github.com/Joftal/SODALive-Monitor/releases)

Electron + Vue 3。

## ✨ 功能

- **直播页**：在播 / 站内发现 / 离线 三视图、全局搜索、站内关注一键同步、按主播的开播自动录制开关。
- **监控**：双平台独立轮询（默认 30 秒一轮）、开播预取秒开、下播两轮确认、失败退避熔断。
- **录制**：手动录或开播自动录、`ffmpeg -c copy` 不转码、900 秒分段、TS→MP4 转封装、整场合并、Panda 回放下载。
- **库**：九宫格缩略图、按日期/主播分组、平台与状态筛选、关键词搜索、内置影院浮层播放。
- **观看**：hls.js 低延迟、清晰度切换、Panda 备线切换与源保活、密码房与 19+ 遮罩、SOOP 走本机 HLS 代理。
- **通知**：应用内气泡；系统通知 / Telegram / 提示音按「平台 × 事件」开关，默认全关。
- **账号**：网页登录窗、粘贴 Cookie、SOOP 托管账密（Panda 不托管）。
- **其他**：明暗主题、中英界面、托盘常驻、单实例、手动检查更新、只读诊断台。

## 📦 安装

[Releases](https://github.com/Joftal/SODALive-Monitor/releases) 下载对应平台的包：Windows 安装版 / 便携版，macOS dmg / zip，Linux AppImage / deb。装好后到「账号」页登录。

接口在境外，直连失败就在「设置 → 网络」填 HTTP 代理。数据在程序同目录（Windows 是 `data/` 和 `recording/`），macOS / Linux 用系统用户数据目录。macOS 首次打开提示「已损坏」时执行 `xattr -cr "/Applications/SODALive Monitor.app"`。

## 🛠️ 开发

```bash
npm install
npm run dev            # 开发模式
npm run build          # 产物构建(out/)
npm run pack           # 打包当前平台(release/), mac/linux 用 pack:mac / pack:linux
npm run typecheck      # 双端类型检查
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
```

- CI：push / PR 进 `main` 跑 typecheck + verify。
- 发版：`Actions → Build & Release` 填 `x.y.z`，三平台并行打包，产物追加到同一个 tag。
- 依赖卡在 electron / ffmpeg 二进制：加 `ELECTRON_MIRROR` 和 `FFMPEG_BINARIES_URL` 再装一次。
- 代码位置：`src/main/services/` 是主体（`pandalive.ts` / `soop.ts` API 客户端、`source.ts` 取流、`hlsProxy.ts` 本地代理、`watcher.ts` 轮询、`recorder.ts` 录制），界面在 `src/renderer/src/`，共用契约在 `src/shared/`，回归脚本在 `scripts/`（verify-*.mjs 行为回归链(12 个)）。

## ⚠️ 免责与 License

仅供个人学习研究，与 PandaLive、SOOP 官方无关；录制内容请遵守当地法律与平台条款，勿商用或二次分发。[MIT](./LICENSE) · [Joftal](https://github.com/Joftal)
