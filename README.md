# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放下载** 一体化桌面客户端（Windows · macOS · Linux）

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

用 Electron + Vue 3 写的，有明暗两套主题和中英文界面，可以常驻托盘。

## ✨ 功能

- 两个平台的在播关注放在一屏里看，分「在播 / 站内发现 / 离线」三个视图。站内发现只有 Panda 有 —— SOOP 没有公开榜单，界面会直接说明而不是给一个假列表。登录后可以一键把站内的关注同步到本地。
- 后台按平台各起一个轮询，默认 30 秒一轮。在播状态是问官方接口一次拿整张表；只有这一发失败、或者某个房间在表里看不出状态时，才会单独去探测那个房间。
- 检测到开播后会立刻把播放源取回来，点进播放页基本不用等。判定下播要连续两轮，免得一次网络抖动就报下线。连续失败会退避，两个平台的失败记录互不影响。
- 录制用 `ffmpeg -c copy` 直接封流，不转码，默认 900 秒切一段，可以自动转成 MP4、可以把整场合并。Panda 已经结束的场次能下载回放。
- 录出来的文件在录制页的「库」里管：九宫格缩略图、按日期或主播分组、按平台和状态筛、能搜标题/昵称/ID，也可以直接在这里播放。
- SOOP 的播放地址缺了 Origin 和 Cookie 就给播放器直接用不了，所以加了一层只监听 `127.0.0.1` 的本地代理来转发和改写清单。顺带的结果是面板上「复制」拿到的是本地地址，要官方地址得点「复制真实源」。
- 通知按「平台 × 事件」开：应用内的气泡一直有，系统通知、Telegram 和提示音默认全关，要得自己去开。
- 登录有三种走法：开网页登录窗、粘 Cookie、或者在 SOOP 上托管账号密码（Panda 不提供账密托管）。第三个标签页是诊断台，只读地显示轮询、节流、缓存和日志。

## 📦 安装

从 [Releases](https://github.com/Joftal/pd-monitor/releases) 下载对应平台的包：Windows 有安装版和便携版，macOS 有 dmg 和 zip（分 Intel 与 Apple Silicon），Linux 有 AppImage 和 deb。装好后先去「账号」页登录 —— 不登录也能监控公开房间，但 19+、限区和密码房看不到。

两个平台的接口都在境外，直连失败时在「设置 → 网络」填一个 HTTP 代理就行。数据放在程序同目录（Windows 是 `data/` 和 `recording/`），macOS 和 Linux 用系统默认的用户数据目录。macOS 第一次打开如果提示「已损坏」，是因为项目没有 Apple 开发者证书，执行 `xattr -cr "/Applications/SODALive Monitor.app"` 把隔离属性清掉就好。

## 🛠️ 开发

```bash
npm install
npm run dev            # 开发模式
npm run build          # 产物构建(out/)
npm run pack           # 打包当前平台(release/), mac/linux 用 pack:mac / pack:linux
npm run typecheck      # 双端类型检查
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
```

- push / PR 到 `main` 时 CI 跑 typecheck 和 verify。发版是在 `Actions → Build & Release` 里填一个 `x.y.z`，三个平台并行打包，产物追加到同一个 tag。
- 装依赖要是卡在 electron 或 ffmpeg 的二进制上，加上 `ELECTRON_MIRROR` 和 `FFMPEG_BINARIES_URL` 两个环境变量再装一次；打包阶段不需要这些。
- 主要逻辑在 `src/main/services/`：`pandalive.ts` 和 `soop.ts` 是两个平台的 API 客户端，`source.ts` 管取流与缓存，`hlsProxy.ts` 就是上面说的那个本地代理，`watcher.ts` 是轮询引擎，`recorder.ts` 是录制引擎。界面在 `src/renderer/src/`，两端共用的类型和默认值在 `src/shared/`，回归脚本在 `scripts/`（verify-*.mjs 行为回归链(12 个)）。

## ⚠️ 免责与 License

只做个人学习研究，和 PandaLive、SOOP 官方没有任何关系。录制的内容请遵守当地法律和平台条款，别商用、别二次分发。[MIT](./LICENSE) · [Joftal](https://github.com/Joftal)
