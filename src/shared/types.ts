// ============ 主进程与渲染进程共享的数据契约 / IPC 通道名 ============

// ---------- 平台与房间主键 ----------
export type Platform = 'pandalive' | 'soop'

/** 裸 ID / 历史库数据的默认归属平台 */
export const DEFAULT_PLATFORM: Platform = 'pandalive'

/** 源失效自动续录的连续失败上限(超过即停手, 等下个健康周期清白)。
 *  放在共享契约里而不是 recorder 私有常量: 播放页侧栏要如实显示这个数字,
 *  渲染层抄一份字面量必然与真实值漂移(设计稿 S5「失效自动续录 · 连续上限 N 次」)。 */
export const REC_RETRY_MAX = 3

/** 启动默认工作区(D5): remember=落在上次离开的那一页, 其余为恒定进入指定平台 */
export type WorkspacePref = 'remember' | Platform

export function isPlatform(v: unknown): v is Platform {
  return v === 'pandalive' || v === 'soop'
}

/** 房间主键: 同一 ID 在不同平台是两个房间, 一切去重/查找/Map 键都用它而非裸 userId。
 *  只做进程内标识: 目录名用裸 userId + 平台层级, 因为 ':' 在 Windows 文件名非法、
 *  而 strictName 会静默去掉它, 跨平台同 ID 就撞进同一目录。 */
export function roomKey(platform: Platform, userId: string): string {
  return `${platform}:${userId}`
}

/** 平台徽标/正文统一称谓(设计稿 5.2): 顶栏、卡片、播放页、设置页共用一枚名字,
 *  避免各处 ternary 各写各的(曾经 Panda/pandalive/潘达 三种叫法同时在线)。 */
export function platformName(platform: Platform): string {
  return platform === 'soop' ? 'SOOP' : 'Panda'
}

/** 房间地址唯一出口(卡片跳转 / 在浏览器打开 / TG 推送都从这里取, 勿再各写各的域名) */
export function roomUrl(platform: Platform, userId: string): string {
  return platform === 'soop'
    ? `https://play.sooplive.com/${userId}`
    : `https://www.pandalive.co.kr/play/${userId}`
}

/** SOOP 主播头像: 频道 ID 就写在路径里, 所以零请求。这不是猜出来的规律 —— 播放页
 *  <div id="bjThumbnail"> 的 <img src> 正是这一串(2026-10-01 实测 @apple1004l / @eunsun1944),
 *  而官方自己给它挂了 onerror: 没传过 logo 的房在这儿就是 404, 渲染层必须按「没有头像」处理。
 *  与 roomUrl 同族放共享层: 它是纯地址函数(不发请求), 轮询侧与落库侧都要拼同一个地址。 */
export function soopAvatarUrl(userId: string): string {
  return `https://stimg.sooplive.com/LOGO/${userId.slice(0, 2)}/${userId}/${userId}.jpg`
}

/** 房间 ID 的合法形态(主进程 IPC 入参校验与用户输入解析共用同一把尺):
 *  它参与 roomKey 主键, 并被**裸拼进落盘目录名**(`<根>/<平台>/<主播名>(<userId>)`), 所以
 *  路径分隔符、Windows 保留字符、控制字符、`..` 一律拒绝; 上限 80 给整条路径留余量(Windows 260 截断)。
 *  parseRoomInput 的产物是 [\w-]+, 历史库里的登录名/频道名不会超出 [\w.-], 正常调用不会被误杀。 */
export function isRoomId(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.length > 80) return false
  return /^[\w.-]+$/.test(v) && !v.includes('..') && !/[.\s]$/.test(v)
}

/** 路径片段清洗(录制目录/文件名用): 非法字符直接去除(不替换), 收拢空白, 去首尾点空格(NTFS 约束)。
 *  空串由调用方给兜底词 —— 主进程兜底走 mt('app.unnamed'), 渲染层兜底走自己的文案, 语义一致。
 *  放共享层是因为播放页侧栏要如实显示本房间的录制目录: 渲染层抄一份正则必然与真实落盘名漂移。 */
export function sanitizePathPart(s: string): string {
  return String(s || '')
    .replace(/[\\/:*?"<>|%]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim()
}

/** 用户输入(裸 ID 或任意房间链接)→ 主键。平台按域名判定, 裸 ID 归 fallback。
 *  SOOP 的 `/频道/场次号` 形态只取频道名: 场次号每次监控从页面重解析, 不进主键。
 *  无法识别返回 null, 由调用方决定是报错还是回退。 */
export function parseRoomInput(raw: string, fallback: Platform = DEFAULT_PLATFORM): { platform: Platform; userId: string } | null {
  const s = (raw || '').trim()
  if (!s) return null
  const platform: Platform = /sooplive\.com\//i.test(s)
    ? 'soop'
    : /pandalive\.co\.kr\//i.test(s)
      ? 'pandalive'
      : fallback
  const isUrl = /^https?:\/\//i.test(s)
  const path = isUrl ? s.replace(/^https?:\/\/[^/]+/i, '') : s
  const segs = path.split(/[/?#]+/).filter(Boolean)
  // pandalive 链接带 /play 路由段, SOOP 播放页第一段就是频道名(个别分享链接写作 /channel/频道名)
  const route = platform === 'pandalive' ? 'play' : 'channel'
  const cand = segs[0] === route ? segs[1] : segs[0]
  if (!cand) return null
  // 纯数字只会是 SOOP 的场次号(或误粘的数字), 不可能是任一平台的登录名
  if (isUrl && /^\d+$/.test(cand)) return null
  const userId = cand.replace(/[^\w-]/g, '')
  // 与主进程 IPC 校验(roomErr)同一把尺: 不可寻址的输入根本不入库, 免得存进去再被拒
  return isRoomId(userId) ? { platform, userId } : null
}

export interface AnchorTag {
  isAdult: boolean
  isPw: boolean
  type: string // free | fan ...
  liveType: string // live | rec
}

export interface Anchor {
  /** 归属平台; 与 userId 共同构成主键 */
  platform: Platform
  userId: string
  userIdx: number | null
  nick: string
  userImg: string
  isLive: boolean
  title: string
  tags: AnchorTag | null
  startTime: string
  viewerCount: number
  likes: number
  fans: number
  thumbUrl: string
  autoRecord: boolean
  addedAt: number
  lastSeenAt: number
  /** 上一次「我们亲眼见到他在播」的开播时刻, KST 钟面串(与 startTime 同格式), 空串=从未见过开播。
   *  与 lastSeenAt 语义不同: 后者是「最后一次拉到他」(每轮轮询都会刷新), 离线卡的「上次开播 / 未播 N 天」
   *  必须用前者, 否则永远显示「今天」。Panda 在翻离线那一轮写 startTime, SOOP 直接取关注列表的 last_broad_start。 */
  lastLiveAt: string
  /** 「上一轮已读到它报离线, 正等第二轮确认」那一格的落库时刻(原来只在进程内存)。
   *  现场实拍 2026-10-04: 06:58:09 关注列表报 @fjqbxhzl1 下播(内存里记下一轮待确认) → 07:04 实例重启 →
   *  新进程的防抖表是空的 ⇒ 那一轮的豁免分支把它判成"陈旧基线首轮翻离线", 一场我们亲眼看见的下播没有通知,
   *  而那句归因在这个样本里是假的(停摆只有 6 分钟)。
   *  只认新鲜的那一枚(见 watcher 的 OFFLINE_PENDING_FRESH_MS): 隔夜留下的旧账说的不是"刚刚", 不该再发通知 */
  offlinePendingAt?: number
  /** 「站内已取关 · 本地仍保留」(决策 D3): 只由「同步站内关注」的反向差值写入 —— 本次站内列表里没有、
   *  本地却关注的房间标 true, 重新出现在站内列表即清掉。绝不据此自动删墙;
   *  undefined(老库)= 从未同步过, 语义是"未知", 不得当成已取关展示 */
  siteGone?: boolean
  /** 平台那句「这道门槛过不去」的跨重启账。
   *  只收账号侧那三类结构性门槛(needAdult / needUnlimitItem / needCoinPurchase): 它们不会因为软件重启而改变,
   *  而实测本机一天要重启 24 次应用 ⇒ 每次冷启动都替同一批明知过不去的房间重打整条取流链。
   *  不收的两类: needFan(用户随时可能加粉, 15 分钟内存账够用)、castEnd(说的是"那一场", 新一场开播就不成立)。
   *  清账的四条路: 开播·下播定案·陈旧基线翻离线·录制出错·手动强刷(都走 invalidatePlay)、登出换号(clearPlayCache)、重取真拿到源、到期(见 gateUntil)。
   *  真机实拍 2026-10-06 01:45:51: @moem9e9 那条 22 小时的老账就是被「陈旧基线首轮翻离线」那一条撤走的 —— 散场即频道死, 下一次开播本来就要重新问一发, 所以这一撤不额外花钱。
   * 两平台同规约: SOOP 也用这一对键, 码的词表是它自己那两类 'pw' / 'login' —— 密码是房间属性(主播设的),
   *  'login' 说的是"这一路没有登录态且没有托管账密可重登", 它唯一的翻面路径是登录, 而登录必过 clearPlayCache(整本清)。
   *  省下的是同一场里连着两次冷启动那 9~10 发/间(与 Panda 那一发的代价单位不同: SOOP 被拒的那一句在整链第 3 步, 前两步已经花掉了) */
  gateCode?: string
  /** 上面那本账的到期时刻(ms)。退避不做指数、统一 15 分钟冷却: 内存与盘共用同一把 15 分钟的尺,
   *  同一格同一到期时刻 ⇒ 屏上"多久过期"与"还剩多久"说的是同一件事; 到期就当没读到, 下一次取源照旧重问一发 */
  gateUntil?: number
}

export type RecStatus = 'recording' | 'remuxing' | 'done' | 'stopped' | 'error'

export interface RecTask {
  id: string
  /** 归属平台; 与 userId 共同定位房间(录制产物目录仍按 nick(userId) 命名, 平台分叉在下一层) */
  platform: Platform
  userId: string
  nick: string
  title: string
  startedAt: number
  endedAt: number | null
  status: RecStatus
  dirPath: string
  currentFile: string
  files: string[]
  bytes: number
  error: string
  auto: boolean
  /** 回放(VOD)下载任务(旧历史记录无此字段) */
  vod?: boolean
  /** VOD: 清单总时长(秒, 拉取失败为 0 → 前端表现为不定进度) */
  vodTotalSec?: number
  /** VOD: 已下载的媒体时长(秒, 来自 ffmpeg -progress out_time) */
  vodDoneSec?: number
  /** 直播间封面(取自拉源响应; 录制卡片展示用, 旧历史记录无此字段) */
  thumbUrl?: string
  /** 进行中的管线阶段(对 status 的细化; 历史条目无此字段):
   *  fetch 拉源 → recording 录制/下载 → stopping 收尾 → remux 转码 → merge 合并 */
  stage?: 'fetch' | 'recording' | 'stopping' | 'remux' | 'merge'
  /** 阶段内件数进度(转码/合并: 第 cur/total 件; 为 0 表示未知) */
  stageCur?: number
  stageTotal?: number
}

export type RecHistoryItem = RecTask

/** 通知事件域: 矩阵的行轴。live=开播(含粉丝房/房态变更), offline=下播, record=录制开始/完成/出错,
 *  alert=异常与会话失效(熔断/整轮拉取失败/登录态作废)。开播与下播分行是现状(tgLive/tgOffline 各一开关),
 *  合成一行会让"只想收开播"的人被下播刷屏。 */
export type NotifyEvent = 'live' | 'offline' | 'record' | 'alert'
/** 一格的两个通道: 系统通知 / Telegram 推送 */
export interface NotifyRow {
  system: boolean
  telegram: boolean
}
/** 只有开播行有「声音」: 提示音的语义是"人在播", 挂到下播/录制/异常上就是改了没反应的假开关(设计稿 S6 判据) */
export interface NotifyLiveRow extends NotifyRow {
  sound: boolean
}
export interface NotifyRules {
  live: NotifyLiveRow
  offline: NotifyRow
  record: NotifyRow
  alert: NotifyRow
}
/** 按平台的通知矩阵(D4): 两平台混排后"只关一个平台"必须是能点出来的, 全局开关做不到 */
export type NotifyMatrix = Record<Platform, NotifyRules>

/** 监控节奏: 一个平台的三格 —— 多久发一轮、轮内每个请求之间隔多久、开播要不要预取源。 */
export interface MonitorRules {
  pollIntervalSec: number
  requestGapMs: number
  prefetchStream: boolean
}
/** 按平台的监控配置: 两平台的采集量级不同 —— Panda 是翻页的全站列表(每轮 N 个请求, 提速即加风控面),
 * SOOP 是一发关注列表(每个请求)。共用一格时"想早点发现 SOOP 开播"只能把 Panda 一起提速,
 *  等于拿一个平台的风险换另一个平台的读数。 */
export type MonitorMatrix = Record<Platform, MonitorRules>

export interface Settings {
  savePath: string
  /** TS 分段时长(秒); 0 = 不分段, 整场录成单个 TS(与回放同一支单文件直出, 仍不直写 MP4) */
  splitSeconds: number
  autoMp4: boolean
  deleteTs: boolean
  proxyUrl: string
  watchMode: 'list' | 'per-anchor'
  /** 轮询间隔 / 单请求节流 / 开播预取, 按平台各一套。取代旧的三个全局键 ——
   *  三个键都在这一格里, 缺哪一格由读库补齐兜住, 提交半格不抹另一平台(见 store.mergeMonitor) */
  monitor: MonitorMatrix
  /** 通知矩阵(平台 × 事件 × 通道), 取代旧的全局 notifySystem/notifySound + tg* 四开关 */
  notify: NotifyMatrix
  /** 新增关注时的「开播自动录制」初始值: 两平台的可用面不同(SOOP 有 19+/限区房), 各留一档 */
  autoRecordDefault: Record<Platform, boolean>
  closeToTray: boolean
  diskLimitGb: number
  /** 源保活: 对已缓存源做轻量心跳维持 IVS 会话活性(退出观看后满员房间仍能凭旧源继续看), 死源及时作废重铸 */
  keepaliveStream: boolean
  /** 录制收尾时自动把分段 MP4 合并为单个文件 */
  mergeMp4: boolean
  /** 合并成功后删除原分段 MP4(仅 mergeMp4 开时生效; 合并失败永远保留原分段) */
  mergeDeleteSegments: boolean
  /** 录制因源失效(停滞/中断)失败时自动重拉新源续录 —— 显式开启才生效(跨签名过期/跨天挂机场景); 每主播连续最多 3 次 */
  autoRetryRecord: boolean
  /** Telegram chatId(@BotFather 建 bot 后用 getUpdates 或 /getChatId 获取) */
  tgChatId: string
  /** Telegram 专用代理(如 http://127.0.0.1:7890); 留空则跟随全局代理 */
  tgProxy: string
  /** bot token 是否已配置(真值存 secrets 保险箱, 此处仅投影供 UI 展示) */
  tgTokenSet: boolean
  /** 机密保险箱(secrets.dat: bot token / SOOP 托管密码)当前是否真加密。
   *  safeStorage 不可用或已落盘的那份是 plain 封装时为 false —— 仅主进程投影, 渲染层提交一律忽略 */
  secretsEncrypted: boolean
  /** 界面主题: light(默认) | dark */
  theme: 'light' | 'dark'
  /** 界面语言 */
  locale: 'zh-CN' | 'en-US'
  /** 启动默认工作区(D5): remember(默认)=上次离开的那一页 */
  defaultWorkspace: WorkspacePref
}

export const DEFAULT_SETTINGS: Settings = {
  savePath: '',
  splitSeconds: 900,
  autoMp4: true,
  deleteTs: false,
  proxyUrl: '',
  watchMode: 'list',
  // 两平台同初值: 这是"从共用一格改成各用各的"的第一步, 默认值必须等于老库迁移后的样子,
  // 否则全新安装与升级安装行为不同(老用户没改过设置却被换了节奏)
  monitor: {
    pandalive: { pollIntervalSec: 30, requestGapMs: 1200, prefetchStream: true },
    soop: { pollIntervalSec: 30, requestGapMs: 1200, prefetchStream: true }
  },
  notify: {
    // 默认全关: 通知是往外发声的通道, 未经用户确认就默认出声 = 拿用户的系统通知栏替应用说话。
    // 想要哪一格由用户在矩阵里逐格打开(设置页两块面板 + 整块开/关按钮都在平台节内)
    pandalive: {
      live: { system: false, telegram: false, sound: false },
      offline: { system: false, telegram: false },
      record: { system: false, telegram: false },
      alert: { system: false, telegram: false }
    },
    soop: {
      live: { system: false, telegram: false, sound: false },
      offline: { system: false, telegram: false },
      record: { system: false, telegram: false },
      alert: { system: false, telegram: false }
    }
  },
  autoRecordDefault: { pandalive: false, soop: false },
  closeToTray: true,
  diskLimitGb: 1,
  keepaliveStream: true,
  mergeMp4: false,
  mergeDeleteSegments: true,
  autoRetryRecord: false,
  tgChatId: '',
  tgProxy: '',
  tgTokenSet: false,
  secretsEncrypted: false,
  theme: 'light',
  locale: 'zh-CN',
  defaultWorkspace: 'remember'
}

export interface AccountState {
  loggedIn: boolean
  cookieValid: boolean
  /** 真实会话登录态(经 login_info 校验, 防止被验证码静默拦截的假登录) */
  realLogin: boolean
  /** 账号是否已通过 pandalive 成人认证 */
  isAdult: boolean
  userIdx: number | null
  /** 官方校验请求本身失败(网络/风控): 与"服务端明确未登录"语义不同, 前端不得报成未登录 */
  netFail: boolean
  /** 上次真实发出 login_info 的时刻(ms, 0=从未校验过): 账号页「上次校验 / 立即重新校验」用。
   *  命中 30s 缓存时沿用缓存时刻 —— 那正是官方最后一次答复的时间, 不能刷新成"现在" */
  lastVerifyAt: number
  encrypted: boolean
}

/** SOOP 账号态: 与 PandaLive 完全独立的两套登录态, 字段按 SOOP 接口能给的信息来
 *  (Panda 以数字 idx 标识账号, SOOP 只有 LOGIN_ID/LOGIN_NICK; 且 SOOP 支持账密自动重登) */
export interface SoopAccountState {
  /** 会话罐里是否已有 .sooplive.com Cookie(匿名站点 Cookie 也算, 故只用于"有没有种过") */
  hasCookies: boolean
  /** 官方 get_private_info.php 判定已登录(LOGIN_ID 非空) —— 取 19+/限区房间的依据 */
  realLogin: boolean
  /** 请求层失败(网络/风控), 与"服务端明确未登录"语义不同 */
  netFail: boolean
  loginId: string
  nick: string
  /** 已托管的账密自动重登账号(仅用户名; 密码不出主进程) */
  credentialUser: string
  /** 上次真实发出 get_private_info 的时刻(ms, 0=从未): 与 Panda 侧同义, 缓存命中时沿用缓存时刻 */
  lastVerifyAt: number
}

export interface AccountStates {
  pandalive: AccountState
  soop: SoopAccountState
}

/** 「导入站内关注」回执(两平台共用): total=站内关注总数, added=本次新增(已在库的只跳过),
 *  siteGone=本次新标为「站内已取关」的本地房间数(D3: 只标注, 不删除) */
export interface FollowImportResult {
  total: number
  added: number
  siteGone: number
}

/** 单平台轮询态: 一级导航按平台分家后, 每个工作区必须能读到"自己"的健康状况 ——
 *  合并口径会让 Panda 冷却期里 SOOP 的正常轮询被读成"挂了", 反之 SOOP 整轮全灭也被 Panda 的健康态盖掉 */
export interface PlatformStatus {
  running: boolean
  lastRoundAt: number | null
  /** 本平台本轮耗时(ms): Panda 全站在播列表翻页与 SOOP 一发关注列表的量级差一个数量级, 合并显示没有意义 */
  roundMs: number
  monitored: number
  liveFound: number
  /** 仅 Panda 有熔断语义(串行队列撞风控); SOOP 恒 false */
  circuitOpen: boolean
  /** 本轮"读不到状态"的房间数: 只有回落到逐房探针的那些会计数, 列表整表覆盖时恒 0。
   *  部分失败既不该报成失明(那是 soopDown 的口径), 也不该报成一切正常(设计稿 7.2) */
  roundFailed: number
  /** 本平台自己的异常正文, 空串=健康; 不再与另一平台抢同一个字段 */
  message: string
  /** 降级轮: 整表那一发读不到, 本轮改由逐房那一条问 —— 站还在跑、数还在读, 但发数从 1 发涨成一堆。
   *  这一格存在的理由就是"把账说出来": 顶栏胶囊不能因为它就写「本轮失败」(那是读不到的口径), 也不能照旧画绿点 */
  degraded: boolean
}

export interface WatcherStatus {
  running: boolean
  mode: 'list' | 'per-anchor'
  lastRoundAt: number | null
  roundMs: number
  liveCount: number
  /** 大厅(全站榜)快照的取回时刻, 0=本次运行还没拉过: 轮询换用站内关注列表以后,
   *  大厅的新旧与轮次的新旧是两件事, 「这份数据多旧」只有发它的那一处知道 */
  discoveryAt: number
  monitored: number
  liveFound: number
  circuitOpen: boolean
  message: string
  byPlatform: Record<Platform, PlatformStatus>
}

// ---------- 诊断台 ----------
// 这一族类型是"主进程内存账的只读投影": 每一个字段都必须来自程序本来就在记的东西。
// 加字段前先问一句"这个数今天有人记着吗" —— 没有就先记账, 记不了就别摆上屏幕(设计稿 0.1 规矩②)。
/** ① 一个平台的节奏 */
export interface DiagRound {
  /** 本次监控会话查到第几轮 */
  roundCnt: number
  /** 实测轮距(ms): 本轮起点减上一轮起点; 与"设定的间隔"不是一件事 */
  measuredRoundMs: number
  /** 上一轮用了多久(ms), 0=还没量到 */
  lastRoundMs: number
  /** 下一轮还有多久(ms); -1=没排 */
  nextInMs: number
  inFlight: boolean
  /** 本站的"歇手钟"各还剩多久(ms), 0=没歇。全仓有五把、各管各的面, 读错一把就会误判"还在冷却":
   *  pollBackoff=轮次连败退避(watcher), risk=平台自己那层风控静默(客户端), probe=会话判死时探针的再问时刻(仅 Panda) */
  cooldowns: { pollBackoff: number; risk: number; probe: number }
  /** 这一轮用的问法: 一次问全表 / 翻全球榜 / 逐房问 */
  oracle: string
  /** 那一发覆盖到几间关注 */
  covered: number
  monitored: number
  liveFound: number
  degraded: boolean
  /** 连着几轮没在站内表里看到你关注的房(名单) */
  unlisted: string[]
  /** 已判定"查无此人"、从此不再发请求的房 */
  gone: string[]
  /** 逐房补查那一条: 每轮预算 + 发到哪了 */
  probe: { budget: number; cursor: number }
}

/** ④ 手上攥着的一包播放地址 */
export interface DiagSourceRow {
  room: string
  fetchedAt: number
  variants: number
  /** 只解了最高档 = 提前备的那一条链 */
  partial: boolean
  /** 还能用多久(ms); null=不按年龄收手(在播且仍关注, 只认显式作废) */
  ttlLeftMs: number | null
}
/** ④ 盘上留着、等下次开机对号的那一包 */
export interface DiagStoredRow {
  room: string
  fetchedAt: number
  tiers: number
  /** 按当前读数它还能不能复活 */
  reviveable: boolean
}

/** ⑤ 三条排队的活 */
export interface DiagQueues {
  prewarm: { len: number; head: string[]; retry: { room: string; attempt: number; inMs: number }[] }
  offlinePending: { len: number; cursor: number }
  thumbs: { queued: number; working: boolean }
  /** Panda 自己那层"每隔一会儿放一发"的队。它和 ⑧ 的按站车道是两层不同的闸 —— 只看一层会得出"没在堵"的假结论 */
  pandaLane: { queued: number; pumping: boolean; gapMs: number }
}

/** ⑧ 图片那一面的账(命中率/合并/真发/被拒): 请求层本来就一直在记, 这里只把读数递出来 */
export interface DiagImages {
  entries: number
  bytes: number
  hit: number
  miss: number
  send: number
  merged: number
  fail: number
  refused: number
}

/** ⑨ 磁盘: probeFailed 一旦为真, 阈值保护等于已经关掉(整页最值钱的一格) */
export interface DiagDisk {
  freeGb: number
  probeFailed: boolean
  thresholdGb: number
  dir: string
}
/** ⑨ 数据库: recovering 为真 = 此后每次改动只活在内存里 */
export interface DiagDb {
  recovering: boolean
  pendingWrite: boolean
  lastWriteAt: number
  anchors: number
}

/** ⑩ 钥匙罐: 与"有没有登录"是两件事 */
export interface DiagKeys {
  partition: string
  cookies: number
  /** 最早过期的那一枚(秒级时间戳 ×1000), 0=有一枚不带期限(重启即蒸发) */
  earliestExpireAt: number
  /** 带期限(能跨重启)的枚数 / 只剩会话期的枚数 */
  persistent: number
  sessionOnly: number
  /** 上次核对登录态的时刻, 0=本次运行没核过 */
  lastCheckAt: number
  /** 那次核对能白用多久(ms) */
  cacheTtlMs: number
}

/** ⑪ 录制内部: 大小速率录制页已有, 这里只放"重试到第几次、有没有卡住" */
export interface DiagRecRow {
  room: string
  status: string
  retryStreak: number
  /** 上一次有进展的时刻 */
  lastProgressAt: number
  stalledForMs: number
}

/** ⑫ 被平台挡在外面、一段时间内不再重打整链的房 */
export interface DiagGateRow {
  room: string
  until: number
  /** 挡它的原话: 要登录 / 要密码 / 平台结构性不给 */
  kind: string
  /** 落盘的(重启后还挡着)还是只在内存里的 */
  persisted: boolean
}

/** ⑥ 本机存了哪些: 一格一条缓存账 */
export interface DiagCacheRow {
  name: string
  entries: number
  cap: number | null
  ttlMs: number | null
}

/** ⑦ 本地转发小站 */
export interface DiagProxy {
  up: boolean
  port: number
  origins: number
  inflight: number
  mergedPlays: number
  mergedSegs: number
}

export interface DiagLogStats {
  kept: number
  total: number
  dropped: number
  warn: number
  error: number
}

/** 一次快照 = 诊断台的一屏 */
export interface DiagSnapshot {
  at: number
  uptimeMs: number
  /** 本次监控从什么时候开始, null=没在监控 */
  monitoringSince: number | null
  /** 有没有人在听: 窗口数为 0 时所有推送都是没人收的广播 */
  windowsOpen: number
  rounds: Record<Platform, DiagRound>
  sources: {
    live: Record<Platform, DiagSourceRow[]>
    stored: DiagStoredRow[]
    storedCap: number
    storedTtlMs: number
    /** 地址作废编号: 解释"为什么刚拿到的地址被吞掉了" */
    epochAll: number
  }
  queues: DiagQueues
  disk: DiagDisk
  db: DiagDb
  keys: Record<Platform, DiagKeys>
  rec: DiagRecRow[]
  gates: DiagGateRow[]
  caches: DiagCacheRow[]
  /** ⑧ 车道的"上一发落定在多久之前"(站点各一条)。堵不堵的那一格今天没有计数器, 所以这里只有这一半 */
  lanes: { host: string; sinceLastMs: number }[]
  images: DiagImages
  proxy: DiagProxy
  telegram: { hasToken: boolean; hasChat: boolean; switchOn: boolean }
  vaultAvailable: boolean
  log: DiagLogStats
}

export interface DiagLogLine {
  seq: number
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  text: string
}
export interface DiagLogPage {
  lines: DiagLogLine[]
  nextSeq: number
  stats: DiagLogStats
}

export interface PlayInfo {
  ok: boolean
  needPassword?: boolean
  /** SOOP 专有: 该房间要登录态(19+/限区/匿名降级), 前端据此给"去登录"入口而不是当成未开播 */
  needLogin?: boolean
  error?: string
  m3u8?: string
  /** 回放(liveType=rec)播放结果: 前端可据此切换"观看/下载回放"语义 */
  vod?: boolean
  /** 变体分档(带宽降序, 第一个是最高档; 用于替代短寿 master 地址) */
  variants?: { url: string; bandwidth: number; resolution: string; label?: string }[]
  title?: string
  nick?: string
  thumbUrl?: string
  userImg?: string
  tags?: AnchorTag
  startTime?: string
  /** 备用线路 master(hls.js 自动选档); 只含与主线互异的真备用 —— 平台返回同链时为空, 线路栏自动隐藏 */
  hlsBackups?: string[]
  /** 本源包在主进程缓存中的生成时刻(ms 时间戳; 切换清晰度/线路不刷新, 手动刷新/重拉才更新) */
  fetchedAt?: number
  /** 秒开快道的回话: true = 这一份只解了最高档(能播, 但清晰度菜单残缺), 请另发 liveMenu 补齐。
   *  只有 SOOP 会给 true —— Panda 的全档是从 master 一次解析白送的, 不存在"少解几档" */
  partial?: boolean
}

/** 清晰度菜单补齐(liveMenu)的回话: 只带菜单那三格, 不重播房态、不回写关注卡 */
export interface PlayMenu {
  ok: boolean
  variants?: { url: string; bandwidth: number; resolution: string; label?: string }[]
  hlsBackups?: string[]
  /** 补过一轮仍残缺(其余档一档没买到): 前端保持现有菜单, 不报错也不重问 */
  partial?: boolean
}

/** 源保活单源运行状态(播放页"播放源卡"展示) */
export interface KeepaliveStatus {
  /** 设置开关是否启用 */
  enabled: boolean
  /** 该房间当前是否持有有效源(缓存命中) */
  cached: boolean
  /** 最近一次心跳时刻(ms; 0=从未心跳) */
  lastAt: number
  /** 最近一次心跳是否正常(主档可用) */
  lastOk: boolean
  /** 该源包养着的分档数 */
  variants: number
}

/** 大厅: 全平台在播直播间条目 */
export interface DiscoveryItem {
  userId: string
  userIdx: number | null
  nick: string
  title: string
  isAdult: boolean
  isPw: boolean
  type: string
  liveType: string
  viewers: number
  likes: number
  fans: number
  bookmarks: number
  plays: number
  startTime: string
  thumbUrl: string
  userImg: string
}

export interface Toast {
  type: 'live' | 'fanLive' | 'roomChange' | 'offline' | 'rec' | 'error' | 'info' | 'session'
  /** 事件归属平台: 通知矩阵按它决定系统通知/推送/提示音三路是否出条(设计稿 D4) */
  platform: Platform
  title: string
  body: string
}

/** 关于页静态信息 */
export interface AppInfo {
  version: string
  author: string
  authorUrl: string
  repo: string
  releasesPage: string
  /** 日志目录真值: 关于页此前把 Windows 路径样式写死在模板里(mac/linux 展示是错的) */
  logsDir: string
}

/** 检查结果(ok=false 时 latest/url 可能为空) */
export interface UpdateCheckResult {
  ok: boolean
  current: string
  latest?: string
  hasUpdate?: boolean
  url?: string
  error?: string
}

/** 九宫格缩略图就绪推送 */
export interface RecThumbReady {
  id: string
  url: string
}

/** 删除录制任务结果 */
export interface RecDeleteResult {
  ok: boolean
  error?: string
  deletedFiles: number
  freedBytes: number
  missingFiles: number
}

/** 删除单个分段结果 */
export interface RecDeleteFileResult {
  ok: boolean
  error?: string
  remaining: number
  /** 删除后文件全空: 任务条目与缩略图已一并移除 */
  emptied?: boolean
}

// ---------- window.api 桥接口契约(单一事实源: preload 实现它, env.d.ts 引用它) ----------
export interface ApiBridge {
  /** 两套登录态一次给全: 顶栏双头像与账号页共用同一份事实源 */
  authState(): Promise<AccountStates>
  /** 绕过结果缓存、立即向官方重发一次登录态校验(账号页「立即重新校验」, 用户点击驱动, 非轮询) */
  authRecheck(platform: Platform): Promise<AccountStates>
  authOpenWindow(platform: Platform): Promise<{ ok: boolean; message: string }>
  authImportCookies(cookieStr: string, platform: Platform): Promise<{ ok: boolean; message: string }>
  authLogout(platform: Platform): Promise<boolean>
  /** SOOP 账密自动重登: 存下凭据并立刻登录一次; 账号传空串=解除托管, 密码不回显也不回传 */
  authSaveSoopCredentials(username: string, password: string): Promise<{ ok: boolean; message: string }>
  anchorsList(): Promise<Anchor[]>
  /** platform 省略时由输入形态推断(带域名按域名, 裸 ID 归默认平台) */
  anchorsAdd(input: string, platform?: Platform): Promise<Anchor>
  anchorsRemove(platform: Platform, userId: string): Promise<boolean>
  /** 把站内 SOOP 关注全量导入本地库(含离线房; 已在库跳过, autoRecord 恒为关) */
  anchorsImportSoop(): Promise<FollowImportResult>
  /** 把站内 Panda 关注(북마크, 官方上限 200)全量导入本地库; 落库语义与 SOOP 导入一致 */
  anchorsImportPanda(): Promise<FollowImportResult>
  anchorsSetAuto(platform: Platform, userId: string, auto: boolean): Promise<boolean>
  /** 立即触发一轮监控; 传平台只惊动那一平台(两套定时器) */
  anchorsRefresh(platform: Platform): Promise<boolean>
  livePlay(platform: Platform, userId: string, password?: string, fresh?: boolean): Promise<PlayInfo>
  /** 清晰度菜单补齐: livePlay 回了 partial 那一发之后追这一发。
   *  它与快道顺手起的后台整链在 playInflight 合流 ⇒ 在途就等它、已落地就命中缓存, 本身不问平台 */
  liveMenu(platform: Platform, userId: string, password?: string): Promise<PlayMenu>
  /** 播放器亲证"这一条清单 404/403": 主进程当场摘掉缓存里那一份说谎的源包(只摘源包, 不动防重复的账)。
   *  返回是否真摘掉了一份 —— false 也可能是缓存里那份早被换掉了(不是播放器踩死的那个) */
  liveSrcDead(platform: Platform, userId: string, deadUrl?: string): Promise<boolean>
  /** 返回 roomKey 集(非裸 userId) */
  liveSrcCache(): Promise<string[]>
  keepaliveStatus(platform: Platform, userId: string): Promise<KeepaliveStatus>
  discoveryList(): Promise<DiscoveryItem[]>
  /** 按需刷新大厅(全站榜): 轮询换用站内关注列表后, 这几页只在用户打开「发现」时才拉 */
  discoveryRefresh(force?: boolean): Promise<DiscoveryItem[]>
  recList(): Promise<RecTask[]>
  recHistory(): Promise<RecHistoryItem[]>
  recStart(platform: Platform, userId: string, password?: string): Promise<RecTask | { ok: false; needPassword?: boolean; error?: string }>
  recStop(platform: Platform, userId: string): Promise<void>
  recOpenFolder(dir: string): Promise<boolean>
  recDiskFree(): Promise<number>
  recMerge(taskId: string): Promise<{ ok: boolean; files?: string[]; error?: string }>
  recThumb(taskId: string): Promise<{ ok: boolean; url: string }>
  recDelete(taskId: string): Promise<RecDeleteResult>
  recDeleteFile(taskId: string, absPath: string): Promise<RecDeleteFileResult>
  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<Settings>
  settingsSelectDir(): Promise<string>
  /** 保存 Telegram bot token 到加密保险箱(不回显); 空串=清除; 返回刷新后的设置投影 */
  telegramSetToken(token: string): Promise<Settings>
  /** 发送测试消息: token 传空串则用保险箱已存值 */
  telegramTest(token: string, chatId: string): Promise<{ ok: boolean; message: string }>
  watcherStatus(): Promise<WatcherStatus>
  /** 诊断台: 主进程内存账的只读投影(不发请求、不写盘、不碰任何会话凭据原文) */
  diagSnapshot(): Promise<DiagSnapshot>
  /** 日志增量: 取 seq 之后的那些行(内存留档, 地址参数已脱敏) */
  diagLogs(sinceSeq: number, limit?: number): Promise<DiagLogPage>
  winControl(action: 'min' | 'max' | 'close'): Promise<void>
  openExternal(url: string): Promise<void>
  appDataDir(): Promise<string>
  openLogs(): Promise<string>
  appInfo(): Promise<AppInfo>
  checkUpdate(): Promise<UpdateCheckResult>
  /** 渲染层诊断日志入主日志文件(限流防刷屏; 勿传含 token/代理凭证的原文) */
  rendererLog(level: 'info' | 'warn', msg: string): void
  localFileUrl(absPath: string): string
  onAnchors(cb: (list: Anchor[]) => void): () => void
  onRecordings(cb: (list: RecTask[]) => void): () => void
  onWatcher(cb: (s: WatcherStatus) => void): () => void
  onAccount(cb: (s: AccountStates) => void): () => void
  onToast(cb: (t: Toast) => void): () => void
  onDiscovery(cb: (list: DiscoveryItem[]) => void): () => void
  onRecThumb(cb: (p: RecThumbReady) => void): () => void
  /** 有效直播源缓存快照(已获取源的房间 roomKey 集; 卡片「秒开」徽标依据) */
  onSrcCache(cb: (keys: string[]) => void): () => void
}

// ---------- IPC invoke 通道 ----------
export const CH = {
  authState: 'auth:state',
  authRecheck: 'auth:recheck',
  authOpenWindow: 'auth:open-window',
  authImportCookies: 'auth:import-cookies',
  authLogout: 'auth:logout',
  authSaveSoopCredentials: 'auth:save-soop-credentials',
  anchorsList: 'anchors:list',
  anchorsAdd: 'anchors:add',
  anchorsImportSoop: 'anchors:import-soop',
  anchorsImportPanda: 'anchors:import-panda',
  anchorsRemove: 'anchors:remove',
  anchorsSetAuto: 'anchors:set-auto',
  anchorsRefresh: 'anchors:refresh',
  livePlay: 'live:play',
  liveMenu: 'live:menu',
  liveSrcDead: 'live:src-dead',
  liveSrcCache: 'live:src-cache',
  liveKeepaliveStatus: 'live:keepalive-status',
  discoveryList: 'discovery:list',
  discoveryRefresh: 'discovery:refresh',
  recList: 'rec:list',
  recHistory: 'rec:history',
  recStart: 'rec:start',
  recStop: 'rec:stop',
  recOpenFolder: 'rec:open-folder',
  recDiskFree: 'rec:disk-free',
  recMerge: 'rec:merge',
  recThumb: 'rec:thumb',
  recDelete: 'rec:delete',
  recDeleteFile: 'rec:delete-file',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsSelectDir: 'settings:select-dir',
  telegramSetToken: 'telegram:set-token',
  telegramTest: 'telegram:test',
  watcherStatus: 'watcher:status',
  diagSnapshot: 'diag:snapshot',
  diagLogs: 'diag:logs',
  winControl: 'win:control',
  openExternal: 'shell:open-external',
  appDataDir: 'app:data-dir',
  appOpenLogs: 'app:open-logs',
  appInfo: 'app:info',
  appCheckUpdate: 'app:check-update',
  appLog: 'app:log'
} as const

// ---------- IPC event 通道（主进程 -> 渲染进程） ----------
export const EV = {
  anchors: 'ev:anchors',
  recordings: 'ev:recordings',
  recThumb: 'ev:rec-thumb',
  watcher: 'ev:watcher',
  account: 'ev:account',
  toast: 'ev:toast',
  discovery: 'ev:discovery',
  srcCache: 'ev:src-cache'
} as const
