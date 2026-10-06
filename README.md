# SODALive Monitor

中文 | [English](./README_EN.md)

> **PandaLive + SOOP** 双平台直播 **监控 / 观看 / 录制 / 回放下载** 一体化桌面客户端（Windows · macOS · Linux）

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-00a1d6)]()
[![Electron](https://img.shields.io/badge/electron-33-47848f)]()
[![Vue](https://img.shields.io/badge/vue-3-42b883)]()
[![Release](https://img.shields.io/github/v/release/Joftal/pd-monitor)](https://github.com/Joftal/pd-monitor/releases)

基于 **Electron + Vue 3 + naive-ui**，明暗两套主题、中英双语界面。把两个平台的在播关注聚合在一屏里：**长期轮询监控开播**、**应用内直接观看**、**ffmpeg 录制与回放下载**、**录制产物由内置的「库」统一管理**。**开播 / 下播 / 录制 / 异常** 一律先在应用内弹气泡，再按「平台 × 事件」矩阵决定是否额外走系统通知、Telegram Bot 与提示音。

---

## ✨ 当前功能

### 直播页（每个平台各一套工作区）
- 三档视图：**在播关注 / 站内发现 / 离线关注**（快捷键 `1` `2` `3` 切换，`/` 聚焦搜索）。站内发现目前**只有 Panda** 有全站排行，SOOP 那一格界面明写未开放、不给假列表。
- 顶部平台按钮带**在播数**与"有新开播"呼吸徽标；监控态胶囊显示该平台自己的节奏（`60 秒 · 1.3 秒` = 间隔 · 上轮耗时），首轮未落地时只报间隔，并在熔断/未监控/逐房兜底/本轮失败时改口 —— 完整原因进 tooltip，「去登录」出口挂在工作区横幅上（熔断或降级那一轮）。两平台的胶囊各说各话，Panda 熔断不会遮掉 SOOP 的正常心跳。
- **同步站内关注**：登录后一键把站内关注整表搬进本地（含离线主播），回执给出 总数/新增/跳过/「站内已取关」；已有条目不被改动。
- **立即检测一轮**（SOOP）/ **立即拉取一轮**（Panda）手动补一轮，与自动轮询同一把 8 秒地板。
- 离线页按 KST 钟面算「多少天没播」（没有开播记录就说「无开播记录」而不是 1970），可按未播天数排序、隐藏 90 天以上（chip 上带着被挡掉的条数）、只看「站内已取关」，每行有独立的自动录制开关与取关按钮。

### 监控逻辑（这一层决定了它花多少请求）
- 两平台各自独立计时，默认 **30 秒**一轮（可调 5~600 秒），请求之间按设置节流（默认 1.2 秒，实际间隔在 0.9~1.1 倍之间抖动）。
- 稳态一轮的状态读取就是**那一发覆盖全表的官方接口**：Panda 走书签接口（一发看全部关注，默认「列表」模式，可切「逐个」），SOOP 走站内关注列表接口。整表读不通、或某一间在表里判不出状态时，才回落到逐房播放页探针 —— 它每轮有 40 发的预算、带轮转游标，不会在 700 间的库上放大成 700 发。开播判定优先看官方回执，逐房扇出只在整表读不通时才当检测路径用。
- **开播秒开**：确认开播后立刻预取播放源（可关），失败按 60/120/180 秒补排最多三次；预取命中时进播放页几乎零等待。
- **下播要连续两轮确认**才发声，避免单轮抖动误报；应用关闭期间结束的场次不会被补一条假下播通知。
- **风控与熔断**：Panda 遇到风控错误或连败 3 轮 → 1/2/4/8/15 分钟指数退避，冷却期用一发"预言机"探针读通即当场解除；SOOP 连续两轮读不到 → 静默 5 分钟。两本账各记各的，SOOP 的失败不会把 Panda 拖进熔断。
- **门槛房**按 15 分钟扁平冷却（两平台各记一本）：Panda 的 19+ / 限区 / 需购买三类跨重启落盘，SOOP 的密码与需登录两类落盘 —— 到期不等于定时重问，代价单位是"每次冷启动一间一发"。
- 单主播数据错误只记账、不出熔断；被判「查无此人」（改名/注销/错 id）的房间在这一轮运行内不再发任何请求，直到你把它取关重加 —— 重启后它会重新获得一次探活机会。

### 录制
- 手动（播放页）或自动（按主播的「开播自动录制」，全局默认关）；`ffmpeg -c copy` 不转码。
- 默认 **900 秒分段**（可填 0 = 不分段单文件，范围 60~7200），可选 **TS→MP4 自动转封装**（默认开）与**整场合并**（需分段+转封装）；Panda 的已结束场次支持**回放下载**，完成度按 ffmpeg 回报的已下载时长除以 m3u8 清单算出的估算全长来显示（估算全长拿不到就不显示百分比，不猜）。
- 磁盘余量闸门（默认 1 GB，录制中每 30 秒复查）、60 秒零字节判停滞、可选自动续录（默认关；最多 3 次、10/20/40 秒退避、每次换新源）。
- 落盘路径 `<录制根>/<平台>/<昵称>(<主播 ID>)/`；停止走优雅收尾，转封装期间退出会被拦一下。

### 库（录制页内一段，不是独立页）
- 九宫格缩略图由 ffmpeg 采样、持久化在 `data/thumbs`；可按日期或按主播分组（右侧一条分组索引，点跳 + 滚动跟随高亮）、平台筛选、状态筛选（直播中/回放/整场/出错）、关键词搜索（标题/昵称/ID）。
- 内置磨砂影院浮层直接播放本地成片，并可在浮层里发起合并、删除。

### 观看
- hls.js 低延迟播放 + 外层重试上限 3 + 媒体错误自愈；**SOOP 的流全部经本机 `127.0.0.1` 随机端口的 HLS 代理**（重写清单、替请求补上 Origin/Cookie、剔除预载分段；只绑回环、每次请求必带本机令牌、且只转发本代理自己签发过的上游 origin，所以本机其它进程或网页没法把它当开放代理用）。因此面板上「复制」给的是本机地址、「复制真实源」解出官方地址 —— 本机地址离开这台机器无效，属刻意设计。
- 清晰度切换（多档才出现控件）、Panda 备线切换与**源保活泵**（SOOP 侧明确显示"不适用"）、密码房与 19+/限区遮罩、关注切换、手动刷新源、显示"取到源"的时间与年龄。

### 通知
- 应用内气泡是所有事件的即时反馈，**不受通知矩阵管制**（关掉系统通知不该把眼前的气泡一起吞掉）。矩阵管的是另外三列：**系统通知 / Telegram / 提示音**，行是四类事件（开播/下播/录制/异常），**默认全关**；每个平台一块面板、各带整块开/关（静音一个平台不会把另一个也哑掉），提示音只在开播行给开关。
- Telegram：bot token 存系统安全存储（DPAPI / Keychain / libsecret），可单独走代理；HTML 卡片按应用语言本地化，限频重试、超长截断，且属旁路 —— 推送失败只落日志，不影响气泡与系统通知；**只有 Panda 的卡片会附直播链接**（SOOP 的源是本机代理地址，贴出去没用）。

### 账号
- 三种登录方式：**网页登录窗**（官方站点，事件驱动判定成功）、**粘贴 Cookie**（Panda 必须经服务端校验才采纳）、**SOOP 托管账密**（校验通过才存，会话过期错误 -6 时后台自动重登一次，60 秒冷却）。
- Panda 侧**刻意不提供**账密托管（两平台风控特征不同）。登录态是三态呈现：已登录 / 凭证已存但校验失败 / 未登录，首检未回时不显示"未登录"。

### 应用级
- 明暗主题、中英界面（切换即时生效，其余设置脏追踪、只提交改过的键）、托盘常驻（关窗默认最小化到托盘）、单实例（二次启动聚焦已有窗口）。
- 无边框窗口 1380×880（最小 1024×660）、全局搜索（主播名/房间标题/ID）。
- **检查更新是手动**：读 GitHub Releases 最新 tag 比对版本，然后打开发布页 —— 不自动下载安装包。
- **诊断台**（第三个标签页）：只读地把轮询节奏、请求节流、源缓存、门槛冷却、熔断账本、日志尾部摊在屏上，2 秒刷新一次、**自身不发任何对外请求**、窗口隐藏时暂停。

### 网络前提
两个平台的接口都在境外。直连不通时在 **设置 → 网络** 填 HTTP 代理（如 `http://127.0.0.1:7890`）；Telegram 可在通知节单独指定代理，留空则跟随全局。

---

## 📦 安装

到 [Releases](https://github.com/Joftal/pd-monitor/releases) 下载对应平台的产物：Windows 有 NSIS 安装包与便携版两种，macOS 有 Intel / Apple Silicon 的 dmg 与 zip，Linux 有 AppImage 与 deb。装好后第一件事是在**账号页**登录（不登录也能监控公开房间，但 19+、限区与密码房看不到）。

<details>
<summary><b>数据位置</b></summary>

- **Windows（安装版与便携版一致）**：全部数据与程序同目录 —— `data/`（`db.json` 关注与设置、`vault.dat` 加密 Cookie、`secrets.dat` 加密凭据、`thumbs/`、`logs/`）+ `electron-data/`（Chromium 运行时）+ `recording/`（默认录制根）。整个目录可直接备份迁移；NSIS 升级卸载只删安装清单内的文件，`data/` 天然保留。
- **macOS / Linux 打包版**：`.app` 与 AppImage 是只读包，数据落在系统用户数据目录（macOS `~/Library/Application Support/`、Linux `~/.config/` 下的应用目录），内部同样是 `data/` + `recording/`。
- **开发态**：三平台都用项目根目录。
- 2026-09 之前内测版散落在 `%APPDATA%/pandalive-monitor/plm-data` 的数据会在首次启动时自动认领（只补缺口、不覆盖现存）。
</details>

<details>
<summary><b>macOS 安装说明（免证书分发）</b></summary>

项目未购买 Apple 开发者证书，mac 产物由 `afterPack` 钩子做 ad-hoc 深签名（并在钩子里 `codesign --verify` 自检，签名无效直接让构建失败）。浏览器下载的安装包自带 Gatekeeper 隔离属性，首次打开若提示 **「已损坏，无法打开」/「无法验证开发者」**，任选其一：

```bash
# 方式一(推荐): 终端清除隔离属性, 一次永久解决
xattr -cr "/Applications/SODALive Monitor.app"
```

方式二：系统设置 → 隐私与安全性 → 底部安全提示区点「仍要打开」。

> 旧版建议的"右键打开"绕过在 macOS Sequoia (15) 已失效，请用上述方式。从 dmg 拖到"应用程序"以外的目录同样适用。
</details>

---

## 🛠️ 构建开发

```bash
npm install            # 若 npm 拦截 postinstall: 逐个执行 node node_modules/{electron,esbuild,ffmpeg-static}/install.js
npm run dev            # 开发模式(HMR)
npm run build          # 产物构建(out/)
npm run pack           # 打包 Windows 安装包 + 便携版(release/)
npm run pack:mac       # 打包 macOS dmg + zip 双架构(需在本机 macOS 上跑)
npm run pack:linux     # 打包 AppImage + deb(需在本机 Linux 上跑)
npm run pack:dir       # 只出解包目录(release/win-unpacked), 排查打包问题用
npm run typecheck      # 双端类型检查(tsc + vue-tsc)
npm run verify         # 行为回归链: 12 个纯 Node 脚本(设计契约/数据根/源缓存/保活泵/网络闸门/录制管线/设置写入链/回放全长/关注导入/图缓存/深链/通知)
npm run build:icon     # 由 resources/icon.ico 派生 png/icns 与 mac 托盘模板
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

**CI**：`push` / `PR` 进 `main` 自动跑 `typecheck` + `verify`（`.github/workflows/ci.yml`，ubuntu，纯 Node，不起 Electron，跳过那 ~100MB 的 electron 二进制下载）。

**发版**：`Actions → Build & Release` 填 `x.y.z` 即可 —— 单一 `bump` 作业把版本号写回 `package.json` 并提交（唯一版本源，重跑同版本幂等），随后 **三平台并行打包**（Windows NSIS/便携版 · macOS dmg/zip 双架构 · Linux AppImage/deb），每个平台作业都先跑一遍 `typecheck` + `verify` 再出包，产物追加到同一个 tag（`v<版本号>`），最后由 `finalize` 一次性写入下载表格与 Changelog。应用内「检查更新」读取的就是这个 tag。

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
│     ├─ pandalive.ts         #   Panda API 客户端: 限速队列 + 风控识别 + 双请求栈 + 代理 + 源缓存 + 门槛账
│     ├─ soop.ts              #   SOOP API 客户端: 播放链解析 + 一发站内关注列表 + 会话 Cookie 续期 + 托管重登
│     ├─ source.ts            #   跨平台取流契约(缓存命中/强制现拉/显式作废): 录制与播放不认平台
│     ├─ hlsProxy.ts          #   SOOP 本地 HLS 代理: 清单重写 + 鉴权头注入 + 预载分段过滤 + 一次性令牌
│     ├─ watcher.ts           #   轮询引擎: 列表/逐个两模式 + urgent/间隙泵兜底 + 预取补排 + 熔断退避(按平台分账)
│     ├─ recorder.ts          #   录制引擎: ffmpeg + 停滞检测 + 磁盘闸门 + 分段 + remux + 合并 + 自动续录 + VOD
│     ├─ thumbs.ts            #   九宫格缩略图: 采样拼图 + 签名缓存 + 文件集对账 + 孤儿清扫
│     ├─ authWin.ts           #   网页登录窗(事件驱动判定)
│     ├─ vault.ts             #   系统安全存储加密 Cookie(DPAPI / Keychain / libsecret)
│     ├─ secrets.ts           #   敏感凭据加密存储(TG bot token / 托管账密)
│     ├─ store.ts             #   JSON 持久化(关注/设置/历史)
│     ├─ settingsGuard.ts     #   设置写入闸门: 越界值拒绝并保留旧值(不钳位)
│     ├─ netGate.ts           #   按域节流车道 + 等位上限 + 超时按失败抛出
│     ├─ imgCache.ts          #   卡片图内存缓存(键归一 + LRU 剪枝)
│     ├─ notify.ts            #   应用内气泡 + 系统通知 + TG 推送入口(矩阵门控)
│     ├─ telegram.ts          #   Telegram Bot 推送(独立会话 + 代理 + 限频)
│     ├─ tgFormat.ts          #   TG 消息 HTML 卡片格式化
│     ├─ diag.ts              #   诊断台快照投影(只读)
│     ├─ logger.ts            #   运行日志落盘
│     └─ localMedia.ts        #   plocal:// 本地媒体协议(视频 + 缩略图)
├─ preload/index.ts           # contextBridge(window.api)
├─ shared/                    # types.ts 双端数据契约与默认值 · appmeta.ts 品牌元信息与版本比较 ·
│                             #   imgUrl.ts 图缓存域判定 · hlsPlaylist.ts 清单解析
└─ renderer/src/              # Vue3
   ├─ router.ts               #   /:plat/live · /:plat/recordings · /player/:plat/:id · /account · /settings · /diag(旧深链全部重定向)
   ├─ workspace.ts            #   一级平台落点: 记住最后所在工作区
   ├─ views/WorkspaceView.vue #   直播: 在播关注 / 站内发现 / 离线关注三视图
   ├─ views/RecordingsView.vue#   录制: 概览条 + 进行中 + 库
   ├─ components/LibrarySection.vue # 库(录制页内一段): 卡墙 + 分组 + 索引条 + 筛选搜索 + 影院浮层
   ├─ views/PlayerView.vue    #   观看页(清晰度/线路按平台真实能力呈现)
   ├─ views/AccountView.vue   #   账号: 双平台独立会话 + 登录态三态 + 校验轨迹
   ├─ views/SettingsView.vue  #   设置: 外观/录制/网络/推送/存储 + Panda 节 + SOOP 节 + 关于(`?sec=` 可深链到某节)
   ├─ views/DiagnosticsView.vue # 诊断台(只读, 2 秒刷新, 自身零对外请求)
   └─ components/CinemaOverlay.vue # 磨砂影院浮层: 播放 + 合并 + 删除
scripts/                      # verify-*.mjs 行为回归链(12 个) · icon-build/tray-icon-build 图标派生 ·
│                             #   adhoc-sign-mac.js mac ad-hoc 签名钩子 · sim-keepalive-scale.mjs 保活规模仿真(手动)
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

本项目仅供个人学习研究使用，与 PandaLive、SOOP 官方均无任何关联。录制内容请遵守当地法律法规与原平台条款，**勿用于任何商业用途或二次分发**。平台含成人内容分区，请确保你已年满当地法定年龄。

## 📄 License

[MIT](./LICENSE) · 制作 [Joftal](https://github.com/Joftal)
