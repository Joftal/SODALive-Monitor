# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放** 一体化桌面客户端（Windows · macOS · Linux)

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

基于 **Electron + Vue 3**，卡片式浅色界面。聚合 PandaLive 与 SOOP 双平台的在播直播间，一键观看、一键录制、长期监控心仪主播（**开播 / 下播 / 录制 / 异常** 四类事件按「平台 × 事件」矩阵推送**系统通知与应用内气泡**，并可选 **Telegram Bot** 推送）；录制产物由录制页内置的**库**分段统一管理。





---

## 🛠️ 构建开发

```bash
npm install            # 若 npm 拦截 postinstall: 逐个执行 node node_modules/{electron,esbuild,ffmpeg-static}/install.js
npm run dev            # 开发模式(HMR)
npm run build          # 产物构建(out/)
npm run pack           # 打包 Windows 安装包 + 便携版(release/)
npm run pack:mac       # 打包 macOS dmg + zip(需在本机 macOS 上跑)
npm run pack:linux     # 打包 AppImage + deb(需在本机 Linux 上跑)
npm run pack:dir       # 只出解包目录(release/win-unpacked), 排查打包问题用
npm run typecheck      # 双端类型检查
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
npm run build:icon     # 由 resources/icon.ico 派生 png/icns 与托盘模板
```

**二进制镜像**：electron 与 ffmpeg 的**安装脚本只读环境变量**（npm 11 起 `.npmrc` 里的未知键会逐条告警，npm 12 起更是不再传递给 postinstall），国内网络首次装依赖时按需带上：

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/"
$env:FFMPEG_BINARIES_URL="https://cdn.npmmirror.com/binaries/ffmpeg-static"
npm install

# macOS / Linux —— 同一对变量写成行前缀
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static npm install
```

打包期不需要任何环境变量：electron 压缩包走 `electron-builder.yml` 的 `electronDownload.mirror`，nsis / winCodeSign 等工具链走 `package.json` 的 `config.electron_builder_binaries_mirror`。

**CI**：`push` / `PR` 进 `main`·`dev` 自动跑 `typecheck` + `verify`（`.github/workflows/ci.yml`，纯 Node，不起 Electron）。

**发版**：`Actions → Build & Release` 填版本号即可——自动把版本号写回 `package.json` 并提交（唯一版本源）、**三平台并行打包**(Windows NSIS/便携版 · macOS dmg/zip 双架构 · Linux AppImage/deb）并推送 Releases（tag: `v<版本号>`），应用内「检查更新」即读取该 tag。

**数据位置**：Windows 下全部数据与程序同目录（`data/` + `electron-data/` + `recording/`，安装版与便携版一致，整个目录可备份迁移）；macOS `~/Library/Application Support/`；Linux `~/.config/`。

<details>
<summary><b>macOS 安装说明（免证书分发）</b></summary>

项目未购买 Apple 开发者证书，mac 产物仅做 ad-hoc 签名（`afterPack` 钩子自动完成）。浏览器下载的安装包自带 Gatekeeper 隔离属性，首次打开若提示 **「已损坏，无法打开」/「无法验证开发者」**，任选其一：

```bash
# 方式一(推荐): 终端清除隔离属性, 一次永久解决
xattr -cr "/Applications/SODALive Monitor.app"
```

方式二：系统设置 → 隐私与安全性 → 底部安全提示区点「仍要打开」。

> 旧版建议的"右键打开"绕过在 macOS Sequoia (15) 已失效，请用上述方式。若安装后从 dmg 直接拖到"应用程序"外其他目录，同样适用。
</details>


<details>
<summary><b>代码结构</b></summary>

```
src/
├─ main/                      # 主进程
│  ├─ index.ts                #   入口: 窗口/托盘/平台 Origin 头注入(Panda IVS 流域名)/数据根重定向(仅 Windows 打包)
│  ├─ ipc.ts                  #   IPC 注册(入参校验 + 落盘名净化)
│  ├─ i18n.ts                 #   主进程文案(通知/托盘菜单)
│  ├─ util.ts                 #   数据根定位(便携/安装/开发三态) + 统一 UA
│  └─ services/
│     ├─ pandalive.ts         #   Panda API 客户端: 限速队列 + 风控识别 + 双请求栈 + 代理 + 源缓存
│     ├─ soop.ts              #   SOOP API 客户端: 播放页解析 + 一发站内关注列表 + 会话 Cookie 续期
│     ├─ source.ts            #   跨平台取流契约(缓存命中/强制现拉/显式作废): 录制与播放不认平台
│     ├─ hlsProxy.ts          #   SOOP 本地 HLS 代理: 清单重写 + 鉴权头注入 + 预载分段过滤
│     ├─ watcher.ts           #   轮询引擎: 列表模式 + 逐个模式 + urgent/间隙泵兜底 + 熔断退避(按平台分账)
│     ├─ recorder.ts          #   录制引擎: ffmpeg + 停滞检测 + 分段(填 0 不分段·单文件) + remux + 合并 + VOD + 删除(回收站)
│     ├─ thumbs.ts            #   九宫格缩略图: 采样拼图 + 签名缓存 + 文件集对账 + 孤儿清扫
│     ├─ authWin.ts           #   网页登录窗(事件驱动)
│     ├─ vault.ts             #   系统安全存储加密 Cookie(DPAPI / Keychain / libsecret)
│     ├─ secrets.ts           #   敏感凭据加密存储(TG bot token)
│     ├─ store.ts             #   JSON 持久化(关注/设置/历史)
│     ├─ notify.ts            #   应用内气泡 + 系统通知 + TG 推送入口(平台 × 事件矩阵门控)
│     ├─ telegram.ts          #   Telegram Bot 推送(独立会话 + 代理 + 限频)
│     ├─ tgFormat.ts          #   TG 消息 HTML 卡片格式化
│     ├─ logger.ts            #   运行日志落盘
│     └─ localMedia.ts        #   plocal:// 本地媒体协议(视频 + 缩略图)
├─ preload/index.ts           # contextBridge(window.api)
├─ shared/                    # types.ts 双端数据契约 + IPC 通道 · appmeta.ts 品牌元信息与版本比较
└─ renderer/src/              # Vue3
   ├─ router.ts               #   /:plat/live · /:plat/recordings · /player/:plat/:id · /account · /settings(旧深链全部重定向)
   ├─ workspace.ts            #   一级平台落点: 记住最后所在工作区
   ├─ views/WorkspaceView.vue #   直播: 在播关注 / 站内发现 / 离线关注三视图(关注在播只在第一档, 不另挂坞)
   ├─ views/RecordingsView.vue#   录制: 概览条 + 监控总览 + 进行中 + 库
   ├─ components/LibrarySection.vue # 库(录制页内一段, 非独立页): 卡墙 + 分组 + 索引条 + 筛选搜索
   ├─ views/PlayerView.vue    #   观看页(清晰度/线路按平台真实能力呈现)
   ├─ views/AccountView.vue   #   账号: 双平台独立会话 + 登录态四态 + 校验轨迹
   ├─ views/SettingsView.vue  #   设置: 外观/录制/网络/通知与行为/数据与日志 + Panda/SOOP 两平台节 + 关于(轮询节奏三格各归各的)
   └─ components/CinemaOverlay.vue # 磨砂影院浮层: 播放 + 合并 + 删除
scripts/                      # verify-*.mjs 行为回归链(12 个) · icon-build/tray-icon-build 图标派生 · sim-keepalive-scale 保活规模仿真(手动)
docs/design/                  # sodalive-ia-v1.html 现行设计稿(唯一一份自包含 HTML, 过程稿不进仓库)
```
</details>

<details>
<summary><b>Windows 本地打包排坑(winCodeSign 权限)</b></summary>

electron-builder 解压 `winCodeSign-2.6.0.7z` 需创建符号链接（仅 mac 签名用），非管理员账户会报"客户端没有所需的特权"。用 7zip 排除两个 mac dylib 手动解压到缓存，或开启 Windows 开发者模式后重跑：

```
7za x -y -bd "-x!darwin/10.12/lib/libcrypto.dylib" "-x!darwin/10.12/lib/libssl.dylib" ^
  -o"%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" ^
  "%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/<已下载的任意 .7z>"
```
</details>

---

## ⚠️ 免责声明

本项目仅供个人学习研究使用，与 pandalive、SOOP 官方均无任何关联。录制内容请遵守当地法律法规与原平台条款，**勿用于任何商业用途或二次分发**。平台含成人内容分区，请确保你已年满当地法定年龄。

## 📄 License

[MIT](./LICENSE) · 制作 [Joftal](https://github.com/Joftal)
