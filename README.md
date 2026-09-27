# PandaLive Monitor

中文 | [English](./README_EN.md)

> pandalive.co.kr 直播 **监控 / 观看 / 录制 / 回放** 一体化桌面客户端（Windows · macOS · Linux)

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

基于 **Electron + Vue 3**，卡片式浅色界面。聚合全站在播直播间，一键观看、一键录制、长期监控心仪主播；录制产物由内置**视频库**统一管理。





---

## 🛠️ 构建开发

```bash
npm install            # 若 npm 拦截 postinstall: 逐个执行 node node_modules/{electron,esbuild,ffmpeg-static}/install.js
npm run dev            # 开发模式(HMR)
npm run build          # 产物构建(out/)
npm run pack           # 打包 Windows 安装包 + 便携版(release/)
npm run pack:mac       # 打包 macOS dmg + zip(需在本机 macOS 上跑)
npm run pack:linux     # 打包 AppImage + deb(需在本机 Linux 上跑)
npm run typecheck      # 双端类型检查
```

**发版**：`Actions → Build & Release` 填版本号即可——自动把版本号写回 `package.json` 并提交（唯一版本源）、**三平台并行打包**(Windows NSIS/便携版 · macOS dmg/zip 双架构 · Linux AppImage/deb）并推送 Releases（tag: `v<版本号>`），应用内「检查更新」即读取该 tag。

<details>
<summary><b>macOS 安装说明（免证书分发）</b></summary>

项目未购买 Apple 开发者证书，mac 产物仅做 ad-hoc 签名（`afterPack` 钩子自动完成）。浏览器下载的安装包自带 Gatekeeper 隔离属性，首次打开若提示 **「已损坏，无法打开」/「无法验证开发者」**，任选其一：

```bash
# 方式一(推荐): 终端清除隔离属性, 一次永久解决
xattr -cr "/Applications/PandaLive Monitor.app"
```

方式二：系统设置 → 隐私与安全性 → 底部安全提示区点「仍要打开」。

> 旧版建议的"右键打开"绕过在 macOS Sequoia (15) 已失效，请用上述方式。若安装后从 dmg 直接拖到"应用程序"外其他目录，同样适用。
</details>


<details>
<summary><b>代码结构</b></summary>

```
src/
├─ main/                  # 主进程
│  ├─ index.ts            #   入口: 窗口/托盘/流域名 Origin 头注入/Chromium 数据随程序目录
│  ├─ ipc.ts              #   IPC 注册
│  └─ services/
│     ├─ pandalive.ts     #   API 客户端: 限速队列 + 风控识别 + 双请求栈 + 代理 + 源缓存
│     ├─ watcher.ts       #   轮询引擎: 列表模式 + 逐个模式 + urgent/间隙泵兜底 + 熔断退避
│     ├─ recorder.ts      #   录制引擎: ffmpeg + 停滞检测 + 分段 + remux + 合并 + VOD + 删除(回收站)
│     ├─ thumbs.ts        #   九宫格缩略图: 采样拼图 + 签名缓存 + 文件集对账 + 孤儿清扫
│     ├─ authWin.ts       #   网页登录窗(事件驱动)
│     ├─ vault.ts         #   DPAPI 加密 Cookie 保险箱
│     ├─ store.ts         #   JSON 持久化(关注/设置/历史)
│     ├─ notify.ts        #   应用内气泡 + 系统通知
│     ├─ logger.ts        #   运行日志落盘
│     └─ localMedia.ts    #   plocal:// 本地媒体协议(视频 + 缩略图)
├─ preload/index.ts       # contextBridge(window.api)
├─ renderer/src/          # Vue3(大厅/已关注/播放/录制/视频库/账号/设置)
│  ├─ views/LibraryView.vue       # 视频库: 卡墙 + 分组 + 索引条 + 筛选搜索
│  └─ components/CinemaOverlay.vue # 磨砂影院浮层: 播放 + 合并 + 删除
└─ shared/types.ts        # 双端数据契约 + IPC 通道
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

本项目仅供个人学习研究使用，与 pandalive 官方无任何关联。录制内容请遵守当地法律法规与原平台条款，**勿用于任何商业用途或二次分发**。平台含成人内容分区，请确保你已年满当地法定年龄。

## 📄 License

[MIT](./LICENSE) · 制作 [Joftal](https://github.com/Joftal)
