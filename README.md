# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放下载** 一体化桌面客户端（Windows · macOS · Linux）

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

基于 Electron + Vue 3。把两个平台的在播关注聚合在一屏里：长期轮询盯开播、应用内直接看、用 ffmpeg 录制与下载回放，成片由内置的「库」管理。

## ✨ 功能

- 一屏看两个平台：在播关注 / 站内发现 / 离线关注三档视图。站内发现目前只有 Panda 有全站排行；登录后能一键把站内关注整表搬进本地。
- 后台按平台独立轮询开播（默认 30 秒一轮）。稳态每轮只发那一发覆盖全表的官方接口看状态，整表读不通或某间判不出来才回落到逐房探测。
- 确认开播就立刻预取播放源，进播放页几乎零等待；下播要连续两轮确认才发声；接口连续失败会退避熔断，两平台各记各的账，谁也不遮谁。
- 录制走 `ffmpeg -c copy` 不转码，默认 900 秒分段，可选自动转 MP4 与整场合并；Panda 的已结束场次支持下载回放。磁盘不足或字节停滞会自行收手。
- 录制页里的「库」管成片：ffmpeg 采样九宫格缩略图，按日期或主播分组、筛平台与状态、搜标题/昵称/ID，内置影院浮层直接播放与合并。
- SOOP 的流一律经本机 `127.0.0.1` 上的 HLS 代理：它只转发自己签发过的地址，所以本机其它程序或网页没法拿它当开放代理用。也因此「复制」给的是本机地址，「复制真实源」才是官方地址。
- 通知是「平台 × 事件」矩阵：应用内气泡一定弹（不受开关管制），系统通知 / Telegram / 提示音默认全关。TG bot token 存系统安全存储。
- 登录三种方式：网页登录窗、粘贴 Cookie、SOOP 托管账密；Panda 侧刻意不做账密托管。
- 明暗两套主题、中英界面切换即时生效；托盘常驻、单实例。「检查更新」是手动的，只比对 GitHub 上最新的 tag，不自动下载安装包。
- 第三个标签页是只读的诊断台，轮询节奏、请求节流、源缓存、熔断账本和日志尾部都摊在上面，它自己不发任何对外请求。

## 📦 安装

到 [Releases](https://github.com/Joftal/pd-monitor/releases) 下载对应平台的产物：Windows 有安装包与便携版，macOS 有 Intel / Apple Silicon 的 dmg 与 zip，Linux 有 AppImage 与 deb。装好后第一件事是去**账号页**登录 —— 不登录也能监控公开房间，但 19+、限区与密码房看不到。

两个平台的接口都在境外。直连不通时在 **设置 → 网络** 填 HTTP 代理（如 `http://127.0.0.1:7890`）。

**数据在哪**：Windows（安装版与便携版一致）全部与程序同目录 —— `data/` + `recording/` + `electron-data/`，整个目录可以直接备份迁移；macOS / Linux 落在系统用户数据目录。

<details>
<summary><b>macOS 首次打开提示「已损坏」</b></summary>

项目没买 Apple 开发者证书，mac 产物做的是 ad-hoc 签名。浏览器下载的包自带隔离属性，清掉即可：

```bash
xattr -cr "/Applications/SODALive Monitor.app"
```

</details>

## 🛠️ 开发

```bash
npm install            # 首次装依赖
npm run dev            # 开发模式
npm run build          # 产物构建(out/)
npm run typecheck      # 双端类型检查(tsc + vue-tsc)
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
npm run pack           # 打包当前平台安装包(release/), mac/linux 同理 pack:mac / pack:linux
```

**CI**：push / PR 进 `main` 自动跑 `typecheck` + `verify`。
**发版**：`Actions → Build & Release` 填 `x.y.z` —— 版本号写回 `package.json` 后三平台并行打包，产物追加到同一个 tag，最后一次性写入下载表与 Changelog。
**国内网络**：装依赖卡在 electron / ffmpeg 二进制时，按需带上 `ELECTRON_MIRROR` 与 `FFMPEG_BINARIES_URL` 两个环境变量（npmmirror）；打包期不需要任何环境变量。

<details>
<summary><b>代码结构</b></summary>

```
src/main/            # 主进程
  index.ts ipc.ts i18n.ts util.ts
  services/
    pandalive.ts     #   Panda API 客户端(限速队列 + 风控识别 + 双请求栈 + 门槛账)
    soop.ts          #   SOOP API 客户端(播放链解析 + 站内关注列表 + 会话续期 + 托管重登)
    source.ts        #   跨平台取流契约: 缓存命中 / 强制现拉 / 显式作废
    hlsProxy.ts      #   SOOP 本地 HLS 代理: 清单重写 + 鉴权头注入 + 本机令牌校验
    watcher.ts       #   轮询引擎(列表/逐个 + 逐房兜底 + 预取补排 + 熔断退避, 按平台分账)
    recorder.ts      #   录制引擎(ffmpeg + 停滞检测 + 磁盘闸门 + 分段/remux/合并 + 回放下载)
    thumbs.ts store.ts vault.ts secrets.ts logger.ts
    netGate.ts       #   按域节流车道 + 等位上限 + 超时按失败抛出
    imgCache.ts      #   卡片图内存缓存(键归一 + LRU 剪枝)
    settingsGuard.ts #   设置写入闸门: 越界值拒绝并保留旧值
    notify.ts telegram.ts tgFormat.ts   # 气泡 / 系统通知 / TG 推送
    diag.ts authWin.ts localMedia.ts
src/preload/         # contextBridge(window.api)
src/shared/          # 双端数据契约与默认值 · 品牌元信息 · 图缓存域判定 · m3u8 清单解析
src/renderer/src/    # Vue3: live / recordings / player / account / settings / diag 六个视图 + 组件
scripts/             # verify-*.mjs 行为回归链(12 个) · 图标派生 · mac ad-hoc 签名钩子
docs/design/         # sodalive-ia-v1.html 现行设计稿
```

</details>

## ⚠️ 免责声明

仅供个人学习研究使用，与 PandaLive、SOOP 官方均无任何关联。录制内容请遵守当地法律法规与原平台条款，**勿用于商业用途或二次分发**。平台含成人内容分区，请确保你已年满当地法定年龄。

## 📄 License

[MIT](./LICENSE) · 制作 [Joftal](https://github.com/Joftal)
