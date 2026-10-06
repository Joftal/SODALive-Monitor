// ============================================================================
// 验证脚本: 大厅轮询刷新是否会清掉直播源缓存(do not depend on Electron)
//
// 方法: electron/store/notify/recorder 等依赖替换为可计数 mock;
//       src/main/services/pandalive.ts 与 watcher.ts 用真实源码(sucrase 现编译).
// 场景:
//   T1  主命题: A 已关注+列表可见+持续在播 — 轮询后缓存必须仍命中(问题应不复现)
//   T2  主命题: A 未关注 — 同上
//   T3  主命题: A 已关注但列表不可见(missing→urgent 复查), 持续在播 — 同上
//   T4  对照组: 列表内翻转(离线→在播) — onLiveStart 必须触发(作废+通知+预取+自录)
//   T5  回归: 列表不可见主播经 rotate 复查发现开播 — onLiveStart 必须触发(原被吞 bug)
//   T6  回归: per-anchor 模式下任意开播 — onLiveStart 必须触发(原被吞 bug)
//   T24 双平台隔离: SOOP 关注只走 SOOP 链路(替身模块), 不污染 Panda 请求/计数/熔断,
//       也不被 Panda 冷却/风控连坐 —— 详见该段断言清单
//   T26 监控配置分家: 预取/轮询间隔各按平台那一格 —— 邻居的开关与熔断都带不走本平台
//   T27 Panda 轮询换真值源: 一发站内关注列表判全部关注(下播两轮/列表不可用即回落/会话两道门),
//       全站榜改按需(进发现页才拉 + 60 秒复用 + 熔断期拒发 + 失败保留旧快照)
//   T28 SOOP 降级探针的每轮预算与环形轮换
//   T29 ② 作废纪元门(在飞链不许复活缓存)与 seedPlay 复用(种子命中零请求)
//   T30 立即刷新的每平台 8 秒下限 T31 login_info 探针的判死节流(netFail 不节流)
//   T32 全站榜分页单飞锁(兜底轮与大厅共用) + 失败语义的两种吃法
//   T33 预取补扫改到首轮之后、按真值过滤、跳过已有源的房
//   T34 Panda 门槛回执账(五码 15 分钟短路, 带密码/强刷/作废/换号即解除) + 密码房不进预取队列
//   T35 SOOP 预取那一发的形状: 只解最高档(fullVariants=false), 不强制重打(forceFresh=false)
//   T36 预取泵的让路语义: 轮次在飞/停轮都不发, 让路是 break 不是清队, 停轮才两队一起清
//   T10b 间隙泵同一条 break 的直接取证(T10 那一发被共享限速队列顺带挡住, 撤掉 break 照样绿)
//   T37 SOOP 降级态(P1-1 改判): 列表整表不可用而整页读得动时只加留痕、不减发(那一发就是检测路径),
//         锁"四个失明轮每轮发满预算" + 留痕只在读得动的失明轮出声 + 全灭轮不重复出声 + 常态安静
//   T38 预取泵两道新闸: Panda 自己那本风控账(旧写法这条泵对风控完全失明) + 出队时重判在播(散场房不再拉整条链)
//   T39 间隙泵续扫游标: 一轮扫不完的那一批下一轮从没扫到的那一间接着扫(队首重扫/队尾饿死的修法)
//   T37-E ① 整表可用而某间不在里面: 掉出/回来各报一次, 中间不许报名, 探针一发不减
//   T34c ③ 结构性门槛账跨重启落盘(读回/到期/改口/事件/换号五条路的清账), needFan 与 castEnd 不落盘
//   T59 预取失败要有下一次: 有界退避封顶三次 / 成功即销账 / 门槛房补排零重买 /
//       needPassword 不补 / 停轮·取关·关掉预取到点都重新过闸(旧写法"失败"不是事件 ⇒ 一次抖动永久逐出预取集)
//   T60 清账之后谁再排队: 关-开监控把轮数归零(下一轮真算首轮, 补扫再来一次) /
//       登录成功清完源账当场给在播房重新排队(差集、去重、不越平台、不越开关)
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 伪造世界(请求计数 + 可控的平台状态) ----------
const liveItem = (over = {}) => ({
  userId: 'aaa', userIdx: 1, userNick: '主播', title: '测试直播',
  isAdult: false, isPw: false, type: 'free', liveType: 'live',
  user: 100, likeCnt: 10, fanCnt: 5, bookmarkCnt: 0, playCnt: 0,
  startTime: '2026-09-04 10:00:00', isLive: true, thumbUrl: '', userImg: '', ...over
})

// 站内关注行(/v1/live/bookmark 的真接口形状): 在播行带 media, 离线行只有昵称/头像
const bmLive = (userId, over = {}) => ({ userId, userIdx: 1, userNick: `nick_${userId}`, userImg: '', media: liveItem({ userId, ...over }) })
const bmOff = (userId, over = {}) => ({ userId, userIdx: 1, userNick: `nick_${userId}`, userImg: '', ...over })

const world = {
  inList: {},     // userId -> bool: 全站列表里是否可见
  bjMedia: {},    // userId -> liveItem|null: member/bj 返回的 media
  bj403: {},      // userId -> bool: member/bj 返回 403(触发 RiskError 熔断链)
  bjThrow: {},    // userId -> bool: member/bj 抛普通网络错误(不触发节点兜底, 直抛)
  bjNotFound: {}, // userId -> bool: member/bj 返回 result:false "유저 정보가 없습니다."(查无此人)
  // userId -> message: HTTP 仍是 200、业务码里那句「너무 많은 요청」(现场实拍, 旧账本只读状态码所以完全看不见)
  bjMsg: {},
  latency: { liveMs: 0, bjMs: {}, liMs: 0 }, // 请求人为延迟(T10 让路/T11 取关时序窗口; liMs 给 T55 的在飞合流开窗口)
  // 站内关注列表(预言机): null=该端点不接待(所有旧场景保持匿名→走全站榜那条既有链),
  // 数组=服务端给的关注行(在播带 media, 离线只有昵称); bmStatus/bmResultFalse 用来造风控与死会话
  bm: null,
  bmStatus: 200,
  bmResultFalse: false,
  bmFalseMsg: '',  // 那一发 result:false 回的那句话: 默认「要登录」, 演限流话术的场景自己换词
  bmCalls: [],   // /v1/live/bookmark 请求记录(预言机的核心读数: 一轮必须恰好 1 发)
  // 会话证明: login_info 的替身。null=服务端说没登录; watchLoginInfo=null 时"未证明"的罐会被问一次
  loginInfo: { userInfo: { isLogin: true } },
  liCalls: [],   // /v1/member/login_info 请求记录(冷启动那道门补问的代价: 每 30 秒最多一发)
  // 那一问的两种答案要分开: 服务端明确"没登录"(可节流) vs 请求本身失败(不可节流)
  liThrow: false,
  liveLoginInfo: true, // false ⇒ 全站榜响应不再带 loginInfo(会话判死期的列表形态)
  liveFail: false, // true ⇒ /v1/live 直接抛错(大厅按需刷新要证的"拉不到 ≠ 全站没人播")
  playCalls: [],   // /v1/live/play 真实发起记录(判定"是否重新拉源"的唯一依据)
  playGate: {},    // userId -> 门槛码: 让 /v1/live/play 回 errorData.code(付费/成人/粉丝/道具/本场已断)
  // userId -> bool: 让 /v1/live/play 直接抛(不含 ERR_FAILED ⇒ 会话请求直抛, 不进 Node 兜底)
  // 预取泵那一头的形状是 getPlayCached 拒绝 ⇒ r=undefined, 与"200 + 一句非门槛话术"是两种失败
  playThrow: {},
  // userId -> message: 门槛码之外那一类"200 + 一句限流"(现场拉源实拍就是这一形状)
  playMsg: {},
  liveCalls: [],   // /v1/live 分页请求记录(T16 复用性断言 + "轮询不再搭全站榜的车")
  bjCalls: [],     // /v1/member/bj 调用记录 [{userId, at}](轮扫覆盖/时刻断言)
  toasts: [],      // sendToast 记录
  anchorWrites: [], // store.updateAnchor 的落笔记录 [{platform,userId,patch}]: 那一格只在有账时写
  logs: [],        // logger 记录 "级别|标签|正文"(留痕本身是一项职责, 看不见的那句等于没写)
  soopMeta: {},    // channel -> Partial<PageMeta>: SOOP 播放页三态替身(Panda 场景用不到, 仅防御)
  soopThrow: {},   // channel -> bool: SOOP 取页抛错(T24 平台隔离: 单平台故障不得连坐)
  soopCalls: [],   // 任何落到 SOOP 替身的调用(断言 Panda 场景零越界)
  soopFresh: [],   // 以 fresh=true 发出的取页(探针那一发必须是新页, 微缓存不许拦它)
  soopCached: [],  // 替身手上"已有有效源"的频道(首轮补扫要跳过它们)
  soopPlayArgs: [], // 落到 SOOP 取源的调用参数(断言"预取只解最高档 / 进房解满档")
  soopBno: {},      // SOOP 替身手上那本"场次号"账: channel -> 记入时刻(hasBroadNo 读它)
  recStarts: [],   // recorder.start 记录
  recStops: [],    // recorder.stop 记录
  recStartThrow: false, // true 时 recorder.start 抛错(T21 自录失败不伤链路)
  stopDelayMs: 0,  // recorder.stop 人为延迟(T22 R5 时序窗口)
}

const fakeRes = (status, obj) => ({
  status,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  headers: { getSetCookie: () => [] }
})

const fakeFetch = async (url, init = {}) => {
  const u = new URL(url)
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/member/bj' && world.bjNotFound?.[new URLSearchParams(init.body || '').get('userId')]) {
    // 查无此人专用拦截(仅 notFound 时接管, 其余调用落原分支, 不双重计数)
    world.bjCalls.push({ userId: new URLSearchParams(init.body || '').get('userId'), at: Date.now() })
    return fakeRes(200, { result: false, message: '유저 정보가 없습니다.' }) // → BjNotFoundError
  }
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/live/bookmark') {
    // 预言机: 这一发要活会话才接待(hasSession/cookieValid 两道门在 watcher 里)
    world.bmCalls.push({ at: Date.now() })
    if (world.bmResultFalse) return fakeRes(200, { result: false, message: world.bmFalseMsg || '로그인이 필요합니다.' })
    if (world.bmStatus !== 200) return fakeRes(world.bmStatus, { result: false, message: 'blocked' }) // → RiskError
    if (world.bm === null) throw new Error('fakeFetch 未分派: ' + url)
    return fakeRes(200, { result: true, list: world.bm, page: { offset: 0, limit: 200, total: world.bm.length, lastPage: 1 } })
  }
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/member/login_info') {
    // 「罐在但没证明」那一问: 答案是没登录 → 本轮落回全站榜那条链; 是要的 → 预言机立刻上车
    world.liCalls.push({ at: Date.now() })
    if (world.liThrow) throw new Error('boom(sim)') // 请求失败 = netFail: 读不到 ≠ 判死, 不得被节流
    if (world.latency.liMs) await new Promise((r) => setTimeout(r, world.latency.liMs))
    return fakeRes(200, { loginInfo: world.loginInfo })
  }
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/live') {
    world.liveCalls.push(u.searchParams.get('offset') || '0')
    if (world.liveFail) throw new Error('boom') // 普通网络错误: 刷新方必须"沿用旧快照", 不空表
    if (world.latency.liveMs) await new Promise((r) => setTimeout(r, world.latency.liveMs))
    const list = Object.keys(world.inList).filter((id) => world.inList[id]).map((id) => liveItem({ userId: id, userNick: `nick_${id}` }))
    return fakeRes(200, { result: true, list, loginInfo: world.liveLoginInfo ? { userInfo: { isLogin: true } } : undefined })
  }
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/member/bj') {
    const userId = new URLSearchParams(init.body || '').get('userId')
    world.bjCalls.push({ userId, at: Date.now() })
    if (world.bj403[userId]) return fakeRes(403, { result: false, message: 'blocked' }) // rawFetch → RiskError
    if (world.bjThrow[userId]) throw new Error('boom') // 不含 ERR_FAILED: rawFetch 直抛, 不兜 Node 通道
    // 200 + 一句限流话术: 走 fetchBj 的 result:false 出口(抛 RiskError 但只记总账那一格)
    if (world.bjMsg[userId]) return fakeRes(200, { result: false, message: world.bjMsg[userId] })
    const d = world.latency.bjMs[userId] || 0
    if (d) await new Promise((r) => setTimeout(r, d))
    return fakeRes(200, { result: true, bjInfo: { id: userId, nick: `nick_${userId}`, img: '' }, media: world.bjMedia[userId] ?? null })
  }
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/live/play') {
    const body = new URLSearchParams(init.body || '')
    world.playCalls.push({ userId: body.get('userId'), password: body.get('password') || '' })
    if (world.playThrow[body.get('userId')]) throw new Error('boom(sim)') // 请求层失败: getPlayCached 拒绝, 泵那一头拿到 undefined
    const gate = world.playGate[body.get('userId')]
    if (world.playMsg[body.get('userId')]) return fakeRes(200, { result: false, message: world.playMsg[body.get('userId')] })
    if (gate)
      return fakeRes(200, {
        result: false,
        message: '조건이 충족되지 않았습니다.',
        errorData: { code: gate }
      })
    return fakeRes(200, {
      result: true,
      PlayList: { hls: [{ url: `https://cdn.live-video.net/${body.get('userId')}/master.m3u8` }] },
      media: { title: 't', userNick: 'n', liveType: 'live', thumbUrl: '', userImg: '' }
    })
  }
  if (u.hostname.endsWith('live-video.net')) {
    return fakeRes(200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080p.m3u8\n')
  }
  throw new Error('fakeFetch 未分派: ' + url)
}

// ---------- store mock(关键: listAnchors 返回原数组引用, 复刻 store.ts 语义) ----------
// 关注表主键是 roomKey(platform,userId): 增删改一律按 (platform,userId) 复合定位,
// 只按 userId 找会让同号的两平台记录互相串改
const db = { anchors: [], settings: null, history: [] }
const store = {
  listAnchors: () => db.anchors,
  updateAnchor: (platform, userId, patch) => {
    // 落库面自己也要能取证: "只在真有账时写那一格"这种约定, 不记写次就永远只是说说
    world.anchorWrites.push({ platform, userId, patch })
    const a = db.anchors.find((x) => x.platform === platform && x.userId === userId)
    if (a) Object.assign(a, patch)
  },
  addAnchor: (a) => { db.anchors.push(a) },
  removeAnchor: (platform, userId) => { db.anchors = db.anchors.filter((x) => !(x.platform === platform && x.userId === userId)) },
  getSettings: () => db.settings,
  setSettings: (p) => { db.settings = { ...db.settings, ...p }; return db.settings },
  flush() {}, listHistory: () => db.history, addHistory() {}
}
// 每场一份: monitor 是嵌套对象, 浅拷 {...x} 只拷最外层, 场景里写 db.settings.monitor.pandalive.xxx
// 会写穿模板本身, 下一场就"继承"上一场的开关(分家后 monitor 由标量三格变成一个子对象, 这条必须改)
const mkSettings = () => ({
  savePath: '', splitSeconds: 900, autoMp4: true, deleteTs: false,
  // 节奏三格已按平台分家, 顶层不再有 pollIntervalSec/requestGapMs/prefetchStream(留 3600s 是为了
  // 让 runRound finally 的 schedule 在测试窗口内不自跑 —— 两平台各一格都要压住)
  monitor: {
    pandalive: { pollIntervalSec: 3600, requestGapMs: 300, prefetchStream: true },
    soop: { pollIntervalSec: 3600, requestGapMs: 300, prefetchStream: true }
  },
  proxyUrl: '', watchMode: 'list',
  notifySystem: false, notifySound: false, autoRecordDefault: false,
  closeToTray: false, diskLimitGb: 1, keepaliveStream: false,
  mergeMp4: false, mergeDeleteSegments: true, autoRetryRecord: false,
  tgLive: false, tgOffline: false, tgRecord: false, tgError: false,
  tgChatId: '', tgProxy: '', tgTokenSet: false,
  theme: 'light', locale: 'zh-CN'
})

const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: () => ({ fetch: fakeFetch, setProxy: async () => {}, setUserAgent() {} }) },
    net: { fetch: fakeFetch }
  },
  '../util': { UA: 'verify-script', sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  './vault': { vault: { encrypted: false, load: () => null, save() {}, clear() {} } },
  './logger': { logger: { info: (tag, msg) => world.logs.push(`info|${tag}|${String(msg ?? '')}`), warn: (tag, msg) => world.logs.push(`warn|${tag}|${String(msg ?? '')}`) } },
  '../i18n': { mt: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), setMainLocale() {} },
  './store': { store },
  './notify': { sendToast: (t) => world.toasts.push(t) },
  // SOOP 客户端替身: 本脚本的关注全为 Panda, 只需让 source.ts/watcher.ts 的 import 可解析,
  // 并让误入的 SOOP 调用留下可见痕迹(soopPlayCalls)而非静默走真网络
  './soop': {
    SOOP_SESSION_PARTITION: 'persist:soop',
    maskLoginId: (id) => String(id || ''),
    soopApi: {
      // 关注列表替身: 本脚本一律回"拿不到", 让 roundSoop 走全量逐房探针(与列表化改造前的行为一致)
      fetchFavorites: async () => {
        world.soopCalls.push('favorites')
        return world.soopFavorites ?? null
      },
      fetchPageMeta: async (channel, quiet, fresh) => {
        world.soopCalls.push('pageMeta:' + channel)
        if (fresh) world.soopFresh.push(channel)
        if (world.soopThrow[channel]) throw new Error('soop 取页失败(sim)')
        return {
          channel,
          broadNo: null,
          explicitOffline: false,
          living: false,
          hostName: '',
          roomName: '',
          thumbUrl: '',
          ...(world.soopMeta[channel] || {})
        }
      },
      getPlayCached: async (channel, password, forceFresh, fullVariants) => {
        world.soopCalls.push('getPlayCached:' + channel)
        // 档位扇出是 caller 传的第四格 —— 替身必须把它记下来, 否则"预取只解最高档"这一条打不中
        world.soopPlayArgs.push({ channel, password: password || '', forceFresh: !!forceFresh, fullVariants: !!fullVariants })
        return { ok: false, error: 'soop stub' }
      },
      fetchPlay: async (channel) => {
        world.soopCalls.push('fetchPlay:' + channel)
        return { ok: false, error: 'soop stub' }
      },
      invalidatePlay: (channel) => world.soopCalls.push('invalidatePlay:' + channel),
      // 新增的两格: 替身必须同契约, 否则首轮补扫一碰 cachedSourceIds 就 TypeError(静默把场景打歪)
      seedPlay: (channel) => world.soopCalls.push('seedPlay:' + channel),
      cachedSourceIds: () => (world.soopCached || []).map((c) => `soop:${c}`),
      // 风控静默台账: 本脚本一律回"没在冷却", 需要演冷却的场景改 world.soopRiskCooling
      riskCooling: () => !!world.soopRiskCooling,
      // 预取泵问"这一间手上有没有场次号"再决定要不要买整页。真源码里这本账由列表整表(soop.ts:718)
      // 与任何一次真读到的页面(soop.ts:770)共同维护, 本脚本的 SOOP 是替身 ⇒ 账目由场景自己摆(world.soopBno)
      hasBroadNo: (channel) => Boolean(world.soopBno[channel])
    }
  },
  './recorder': {
    recorder: {
      start: async (opt) => {
        if (world.recStartThrow) throw new Error('disk full(sim)')
        world.recStarts.push(opt)
        return { id: 'x' }
      },
      // 生产签名: stop(platform, userId) —— 录制任务按复合键定位
      stop: async (platform, userId) => {
        world.recStops.push({ platform, userId })
        if (world.stopDelayMs) await new Promise((r) => setTimeout(r, world.stopDelayMs))
      },
      list: () => [],
      hasTask: () => false
    }
  }
}

// ---------- TS 即时编译加载(同一文件单例缓存 → pandalive/watcher 拿到同一 api) ----------
const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const localRequire = (id) => {
    if (id in mocks) return mocks[id]
    if (id === './pandalive') return loadTs('src/main/services/pandalive.ts')
    // 车道挂真实现(不另写替身): 替身绿而真车道从未被跑过, 正是这套脚本此前踩过的坑
    if (id === './netGate') return loadTs('src/main/services/netGate.ts')
    if (id === './source') return loadTs('src/main/services/source.ts')
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const { api } = loadTs('src/main/services/pandalive.ts')
const { watcher } = loadTs('src/main/services/watcher.ts')
// 复刻"进程重启": 只把 watcher 那一份从单例缓存里撤掉再加载一次 ⇒ 新实例没有任何进程内存,
// 而 store/api/缓存这些模块仍是同一份(= 同一台机器、同一个 db.json)。落在锚点行上的状态活得过这一道,
// 落在内存里的活不过 —— 这一句就是那一笔修复的行为取证
const reloadTs = (rel) => { moduleCache.delete(rel); return loadTs(rel) }

// ---------- 测试基建 ----------
let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const playCount = (uid) => world.playCalls.filter((c) => c.userId === uid).length
// 关注记录的主键是 (platform,userId) 复合键(types.ts 跨平台约定), 测试夹具默认 Panda
const mkAnchor = (userId, over = {}) => ({
  platform: 'pandalive', userId, userIdx: 1, nick: `nick_${userId}`, userImg: '', isLive: false, title: '', tags: null,
  startTime: '', viewerCount: 0, likes: 0, fans: 0, thumbUrl: '', autoRecord: false,
  addedAt: Date.now(), lastSeenAt: 0, ...over
})
const recStopped = (uid) => world.recStops.some((r) => r.platform === 'pandalive' && r.userId === uid)
// 「待第二轮确认」那一格现在写在锚点行上(跨重启), 取证就读那一枚时间戳本身
const pendingAt = (uid, plat = 'pandalive') => db.anchors.find((a) => a.platform === plat && a.userId === uid)?.offlinePendingAt || 0
// 落笔里"带着这一格"的那几次(收账写 0 / 排账写 now): 读的是写次而不是终值, 才测得出"没账时不白写"
const pendingWrites = (uid) => world.anchorWrites.filter((w) => w.userId === uid && 'offlinePendingAt' in w.patch)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitUntil = async (fn, ms = 1500) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50) } return fn() }

async function reset() {
  // 先断开间隙泵/预取泵的后续轮扫 + 等上一场在飞请求落完, 再清计数 —— 否则残留 bj/play/soop 调用污染下一场断言
  watcher.idleQueue = []
  // 预取队列/泵各平台一条: 清场要两平台各自清空, 不能整体换成数组(读端按平台索引)
  // 必须是就地清空: 泵拿的是入队那一刻的数组引用(q = this.prewarmQueue[p]), 换数组会让它继续
  // 磨完上一场那一批 —— 那正是 T38-B2 少一发的根因
  for (const p of ['pandalive', 'soop']) watcher.prewarmQueue[p].length = 0
  // 泵标志必须等它自己放下再清: 上一场那条泵可能正卡在 1.2s 的间隔睡眠里, 先硬清 false
  // 会让下一场的 waitUntil(!prewarmPumping) 立刻为真, 而它随后醒来把那批房扫掉(实测 T38-B2 因此少一发)
  await waitUntil(
    () => !watcher.idlePumping && !watcher.prewarmPumping.pandalive && !watcher.prewarmPumping.soop && !watcher.loop.pandalive.inFlight && !watcher.loop.soop.inFlight,
    6000
  )
  // 兜底: 等满 6s 仍举着标志的(极少数被在飞轮次拖住的)按旧语义硬清, 不留跨场死锁
  for (const p of ['pandalive', 'soop']) watcher.prewarmPumping[p] = false
  // 熔断/冷却状态一并复位(跨场景隔离; pump/round 的熔断语义由 T9/T13 负责触发与观察)
  watcher.errorStreak = 0
  watcher.cooldownUntil = 0
  // 冷却期预言机的问闸时间戳同属跨场景状态: 留着上一场的"5 分钟前刚问过"会让下一场第一次撞冷却白等
  watcher.cooldownOracleAt = 0
  watcher.soopFailStreak = 0
  // SOOP 自己的退避与轮转游标也属跨场景状态: 不清就会让下一场开头几个断言跑在上一场的冷却期里
  watcher.soopCooldownUntil = 0
  watcher.soopProbeCursor = 0
  // 失明连败账本同属这一类: 上一场"整表不可用"留下的轮数必须当场作废(留痕的那句"连续 N 轮"只读本会话)
  watcher.soopBlindStreak = 0
  // 站内表缺席名册同一本会话账: 不清就会让下一场第一轮那句"掉出站内表"被上一场留下的那一格吞掉
  watcher.soopUnlisted?.clear?.()
  // Panda 那一侧同一本账(降级轮留痕说"连续 N 轮"时读的就是它) + 本轮逐房复查的计数
  watcher.pandaBlindStreak = 0
  watcher.pandaUrgentCnt = 0
  // 间隙泵的续扫游标: 上面那句 idleQueue=[] 是绕过 setIdleQueue 的硬清, 游标得跟着归零
  watcher.idleCursor = 0
  watcher.idleDrained = 0
  // login_info 探针的判死节流与分页在飞锁同样跨场景: 不清就会让下一场开头几轮"根本没问"
  watcher.pandaProbeUntil = 0
  watcher.pageHarvest = null
  watcher.status.circuitOpen = false
  watcher.status.message = ''
  // 大厅是按需的: 上一场刷新留下的快照与它的钟会污染下一场的"这一轮没碰全站榜"断言
  watcher.status.discoveryAt = 0
  watcher.discovery = []
  // 合并读数是 push 从 byPlatform 现算的(熔断账本已按平台分家): 只清顶层那两格会被下一轮覆盖回去
  for (const p of ['pandalive', 'soop']) {
    watcher.status.byPlatform[p].circuitOpen = false
    watcher.status.byPlatform[p].message = ''
    watcher.status.byPlatform[p].roundFailed = 0
    watcher.loop[p].roundCnt = 0
  }
  db.anchors = []
  db.settings = mkSettings()
  world.inList = {}; world.bjMedia = {}; world.bj403 = {}; world.bjThrow = {}; world.bjNotFound = {}; world.latency = { liveMs: 0, bjMs: {}, liMs: 0 }
  // 那三句"200 + 业务码里的一句话"同属一场一份: 留着上一场那句限流会让下一场的账本凭空armed
  world.bjMsg = {}; world.playMsg = {}; world.bmFalseMsg = ''
  // api 自己那两格风控账: clearPlayCache 里已经一起撤, 这里再写一次是让"下一场从干净账本起步"这句话在本套里可读
  api.riskUntil = 0
  api.oracleRiskUntil = 0
  world.playGate = {} // 门槛回执替身同样一场一份(不清会让下一场白捡一条短路)
  world.playThrow = {} // 请求层失败的替身同样一场一份
  watcher.prewarmRetryBaseMs = 60_000 // 退避刻度复位: 上一场压到几十毫秒的刻度不许留给下一场
  watcher.prewarmRetryCnt?.clear?.()
  for (const t of watcher.prewarmRetryTimers?.values() ?? []) clearTimeout(t) // 待触发的补排是"下一发要发真请求"的待办
  watcher.prewarmRetryTimers?.clear?.()
  world.soopMeta = {}; world.soopThrow = {}; world.soopCalls.length = 0; world.soopFresh.length = 0
  world.soopCached = [] // 替身那份"已有源"清单同样一场一份
  world.soopPlayArgs.length = 0
  world.soopBno = {} // 替身那本场次号账同样一场一份
  world.liThrow = false; world.liveLoginInfo = true // 探针答案复位
  world.soopFavorites = null // 默认"列表整条不接待": 想要预言机那场的场景自己摆行; world.soopFresh.length = 0
  // 预言机场景隔离: 默认 bm=null(端点不接待) + 无会话罐(匿名) → 每一场都从"走全站榜那条链"起步,
  // 想要预言机的场景自己把三件套凑齐: jar={sessKey} + world.bm=[行] + 会话 Either 已证明(cookieValid=true)
  // Either 能被 login_info 一问证真(world.loginInfo 默认 isLogin:true, 冷启动那条路就是这么走的)
  world.bm = null; world.bmStatus = 200; world.bmResultFalse = false; world.bmCalls.length = 0
  world.loginInfo = { userInfo: { isLogin: true } }; world.liCalls.length = 0
  api.loginInfoCache = null // login_info 有 30 秒缓存 + 在飞合并: 跨场景不清就会"继承"上一场的答案
  api.loginInfoInflight = null
  world.liveFail = false
  api.jar = {}
  api.cookieValid = false
  watcher.pandaOracle = 'bookmark'
  watcher.pandaCovered = 0
  // 「待第二轮确认」那一格从进程内存搬进了锚点行(为了跨重启), 清场就必须连着行一起清:
  // 留着上一场那一枚 pending, 下一场的第一轮离线读数会直接当确认轮宣判 —— 跨场景状态要么全清, 要么谁都别信
  for (const a of db.anchors) a.offlinePendingAt = 0
  watcher.discovery = []
  watcher.status.discoveryAt = 0
  watcher.discoveryInFlight = null
  watcher.status.liveCount = 0
  watcher.bjGone?.clear?.() // 查无此人内存集跨场景复位(T23)
  world.playCalls.length = 0; world.liveCalls.length = 0; world.bjCalls.length = 0; world.toasts.length = 0; world.recStarts.length = 0
  world.logs.length = 0 // 留痕断言读的是这一场的日志(跨场不清会把上一场那一句算进这一场)
  world.soopRiskCooling = false // SOOP 风控冷却替身同样一场一份
  world.recStops.length = 0; world.recStartThrow = false; world.stopDelayMs = 0
  world.anchorWrites.length = 0 // 落笔记录同样一场一份
  api.clearPlayCache()
  watcher.running = true // 绕过 start() 的 schedule; round 由脚本手动驱动
}
// 两套独立定时器: 旧的 watcher.round 一条链跑两平台已作废。脚本的 round 保持"两平台各一轮"
// 的旧语义(无 SOOP 关注时 roundSoopTop 零请求, 不会污染 Panda 场景的请求计数), 需要单独惊动一个
// 平台的场景用 roundOne(p)。TS private 于 JS 运行时不存在, 所以能直接驱动 runRound。
const roundOne = (p) => watcher.runRound(p)
const round = async () => {
  await roundOne('pandalive')
  await roundOne('soop')
}

// ============================================================================
console.log('\n■ T1 主命题: A 已关注+列表可见+持续在播, 大厅轮询刷新后源缓存必须仍命中')
await reset()
db.anchors = [mkAnchor('aaa', { isLive: true })]
world.inList = { aaa: true }
{
  const r1 = await api.getPlayCached('aaa')
  check('T1-0 首次进房拉源', r1.ok && playCount('aaa') === 1)
  await round()
  check('T1-1 轮询一轮未发源请求', playCount('aaa') === 1)
  const r2 = await api.getPlayCached('aaa')
  check('T1-2 重新进房缓存命中(0 新请求)', playCount('aaa') === 1 && r2.m3u8 === r1.m3u8)
  check('T1-3 fetchedAt 未变(同一缓存对象)', r2.fetchedAt === r1.fetchedAt)
  await round(); await round()
  const r3 = await api.getPlayCached('aaa')
  check('T1-4 多轮后依旧命中', playCount('aaa') === 1 && r3.fetchedAt === r1.fetchedAt)
}

console.log('\n■ T2 主命题: A 未关注, 轮询与缓存互不相干')
await reset()
world.inList = { aaa: true }
{
  await api.getPlayCached('aaa')
  await round()
  const r2 = await api.getPlayCached('aaa')
  check('T2-1 未关注主播轮询后缓存仍命中', playCount('aaa') === 1 && r2.ok)
}

console.log('\n■ T3 主命题: A 已关注但列表不可见(missing→urgent 复查), 持续在播缓存仍命中')
await reset()
db.anchors = [mkAnchor('aaa', { isLive: true })]
world.inList = {} // A 不在全站列表(19+/隐藏/排名 500 外)
world.bjMedia = { aaa: liveItem({ userId: 'aaa' }) } // 但 bj 复查确认在播
{
  await api.getPlayCached('aaa')
  await round()
  const r2 = await api.getPlayCached('aaa')
  check('T3-1 urgent 复查后缓存未作废', playCount('aaa') === 1 && r2.ok)
}

console.log('\n■ T4 对照组: 列表内翻转(离线→在播) — 缓作废/通知/预取/自录 应全部发生')
await reset()
db.anchors = [mkAnchor('ddd', { isLive: false, autoRecord: true })]
world.inList = { ddd: true }
{
  await api.getPlayCached('ddd') // 旧缓存
  const before = playCount('ddd')
  await round()                  // ddd 在列表(在播) 且 db.isLive=false → wasLive=false → onLiveStart
  await waitUntil(() => playCount('ddd') > before)
  check('T4-1 开播 toast 已发', world.toasts.some((t) => t.type === 'live'))
  check('T4-2 旧源作废后预取拉新源', playCount('ddd') === 2)
  check('T4-3 自动录制已启动', world.recStarts.some((r) => r.userId === 'ddd'))
  const r2 = await api.getPlayCached('ddd')
  check('T4-4 再进房用新源', playCount('ddd') === 2 && r2.ok)
}

console.log('\n■ T5 回归: 列表不可见主播经 rotate 复查发现开播 — onLiveStart 必须触发(修复验证)')
await reset()
db.anchors = [mkAnchor('bbb', { isLive: false, autoRecord: true })]
world.inList = {} // bbb 列表不可见
world.bjMedia = { bbb: liveItem({ userId: 'bbb' }) } // rotate 复查发现在播
{
  await api.getPlayCached('bbb') // 旧缓存(开播后应作废)
  await round()                  // missing rest 队列仅 bbb → rotate 必复查 → applyBj
  await waitUntil(() => playCount('bbb') === 2)
  check('T5-1 开播 toast 已发', world.toasts.some((t) => t.type === 'live'))
  check('T5-2 自动录制已启动', world.recStarts.some((r) => r.userId === 'bbb'))
  check('T5-3 旧源作废+预取新源', playCount('bbb') === 2, `play 请求数=${playCount('bbb')}`)
  check('T5-4 isLive 状态已更新', db.anchors[0].isLive === true)
}

console.log('\n■ T6 回归: per-anchor 模式下开播 — onLiveStart 必须触发(修复验证)')
await reset()
db.settings.watchMode = 'per-anchor'
db.anchors = [mkAnchor('ccc', { isLive: false, autoRecord: true })]
world.bjMedia = { ccc: liveItem({ userId: 'ccc' }) }
{
  await round() // roundByBj → 全部走 applyBj
  check('T6-1 per-anchor 开播 toast 已发', world.toasts.some((t) => t.type === 'live'))
  check('T6-2 per-anchor 开播自动录制已启动', world.recStarts.some((r) => r.userId === 'ccc'))
}

// ============================================================================
watcher.running = false
console.log('\n' + '─'.repeat(72))
console.log(`结果: ${failures === 0 ? '全部按预期' : failures + ' 条与预期不符'}`)
console.log('\n■ T7 场景: 主播开播时不在前 500(列表不可见) — 间隙泵扫到后 通知+数据+后续每轮跟进')
await reset()
// 4 个离线关注(a1..c4), 全都不在列表; 只有 ccc 实际已开播
db.anchors = ['a1', 'b2', 'ccc', 'd4'].map((id) => mkAnchor(id, { isLive: false, autoRecord: id === 'ccc' }))
world.inList = {}
world.bjMedia = { ccc: liveItem({ userId: 'ccc', userNick: 'C酱', title: '500名外的开播', user: 321, fanCnt: 77, thumbUrl: 'https://img/x.jpg' }) }
{
  await round() // 主轮询仅拉列表; rest 4 人交间隙泵, 开播发现是异步的 → 等泵扫到再断言
  check('T7-0 间隙泵已扫到 ccc 开播', await waitUntil(() => db.anchors.find((a) => a.userId === 'ccc').isLive, 6000))
  check('T7-1 开播 toast 已发(rotate 通道)', world.toasts.some((t) => t.type === 'live'))
  check('T7-2 自动录制已启动', world.recStarts.some((r) => r.userId === 'ccc'))
  await waitUntil(() => playCount('ccc') >= 1)
  check('T7-3 开播预取已跑', playCount('ccc') >= 1)
  const c = db.anchors.find((a) => a.userId === 'ccc')
  check('T7-4 开播数据完整(nick/title/观众/粉丝/封面/标签/开播时间)',
    c.isLive && c.nick === 'C酱' && c.title === '500名外的开播' && c.viewerCount === 321 &&
    c.fans === 77 && c.thumbUrl === 'https://img/x.jpg' && !!c.tags && c.startTime === '2026-09-04 10:00:00')
  check('T7-5 同批扫到的未开播主播保持离线', !db.anchors.find((a) => a.userId === 'a1').isLive && !db.anchors.find((a) => a.userId === 'b2').isLive)

  // 被发现后进入 urgent 通道: 下一轮起每轮复查, 数据实时跟进
  world.bjMedia.ccc = liveItem({ userId: 'ccc', userNick: 'C酱', title: '换了标题', user: 999 })
  await round()
  const c2 = db.anchors.find((a) => a.userId === 'ccc')
  check('T7-6 下一轮 urgent 复查数据跟进(标题/观众数)', c2.title === '换了标题' && c2.viewerCount === 999)
}

console.log('\n■ T8 场景: 轮询间隔 300s + 8 个离线关注(第 7 个开播) — 间隙兜底泵发现延迟与间隔脱钩')
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 300 // 长间隔: 旧 rotate 方案下最坏 ⌈8/3⌉×300s = 900s 才发现
db.settings.monitor.pandalive.requestGapMs = 300    // 限速下限(setGap min 300): 泵节奏 ≈300ms/请求
const ids = Array.from({ length: 8 }, (_, i) => `t${i + 1}`)
db.anchors = ids.map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
world.bjMedia = { t7: liveItem({ userId: 't7', userNick: 'T7酱' }) } // 第 7 个开播
{
  const t0 = Date.now()
  await round() // 主轮询仅拉列表; rest 8 人整体交间隙泵
  const found = await waitUntil(() => db.anchors.find((a) => a.userId === 't7').isLive, 6000)
  check('T8-1 间隙内发现开播(不等下一个 300s 间隔)', found)
  const cost = Date.now() - t0
  check('T8-2 发现耗时 ≈ N×gap 量级(远小于一个间隔)', cost < 10000, `实际 ${(cost / 1000).toFixed(1)}s`)
  await waitUntil(() => new Set(world.bjCalls.map((c) => c.userId)).size >= 8, 6000)
  const seen = new Set(world.bjCalls.map((c) => c.userId))
  check('T8-3 本个离线关注全部被轮扫一遍', ids.every((id) => seen.has(id)), `${seen.size}/8`)
  check('T8-4 每人至多一次(快照消费制, 无重复)', world.bjCalls.length === seen.size, `${world.bjCalls.length} 次/${seen.size} 人`)
  check('T8-5 开播 toast 已发(applyBj 链路)', world.toasts.some((t) => t.type === 'live'))
}

console.log('\n■ T9 熔断交互: 间隙泵请求 403(RiskError) → 立即熔断+停扫, 不误伤后续')
await reset()
db.anchors = ['f1', 'f2', 'f3'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
world.bj403 = { f2: true }
{
  await round()
  await waitUntil(() => watcher.status.circuitOpen, 5000)
  await waitUntil(() => !watcher.idlePumping, 3000)
  const idsCalled = world.bjCalls.map((c) => c.userId)
  check('T9-1 RiskError 立即熔断', watcher.status.circuitOpen === true)
  check('T9-2 熔断 toast 已发', world.toasts.some((t) => t.type === 'error'))
  check('T9-3 403 之后泵停扫(f3 未被请求)', idsCalled.join(',') === 'f1,f2', idsCalled.join(','))
}

console.log('\n■ T15 熔断闭环(承接 T9): 冷却压制 → 过期恢复 → 间隙泵重启补扫')
{
  await round() // 冷却分支: 匿名态(无 jar)连那一发预言机都不发 → 整轮零请求; 登录态那一发见 T40
  check('T15-1 冷却分支压制(circuitOpen 保持, message=cooling)',
    watcher.status.circuitOpen === true && String(watcher.status.message).startsWith('watcher.cooling'))
  const bjN0 = world.bjCalls.length
  const liveN0 = world.liveCalls.length
  const bmN0 = world.bmCalls.length
  check('T15-2 冷却中无任何复查请求(匿名态连那一发预言机都不发 —— 登录态那一发见 T40)',
    world.bjCalls.length === bjN0 && world.liveCalls.length === liveN0 && world.bmCalls.length === bmN0,
    `bj=${world.bjCalls.length}/${bjN0} live=${world.liveCalls.length}/${liveN0} bm=${world.bmCalls.length}/${bmN0}`)
  watcher.cooldownUntil = Date.now() - 1000 // 伪造冷却过期
  // 风控账也要跟着到期: T9 那一发 403 把 api.riskUntil 点到了 +5 分钟, 而恢复轮现在认这本账
  // (冷却期只发预言机那一发, 逐房复查与间隙泵收手) —— 这里要断的是"两本账都过了"之后的补扫, 不是"只过了一本"
  api.riskUntil = 0
  world.bj403 = {}                           // 撤掉风控源
  await round()                              // 恢复轮: 成功 → 熔断复位 + idleQueue 新快照
  check('T15-3 恢复后熔断复位(errorStreak 清零)', watcher.status.circuitOpen === false && watcher.errorStreak === 0)
  const got = await waitUntil(() => world.bjCalls.some((c) => c.userId === 'f3'), 6000)
  check('T15-4 上轮断档的 f3 已被间隙泵补扫', got)
}

console.log('\n■ T10 让路: round 进行中间隙泵不得消费(loop.pandalive.inFlight 检查)')
await reset()
db.anchors = ['g1', 'g2'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
{
  await round() // round1 结束 → 泵启动扫 g1(bj 慢 2.5s)
  world.latency.bjMs = { g1: 2500 }
  await sleep(900)                    // 泵的 bj(g1) 正在飞
  world.latency.liveMs = 4500         // round2 主体持续 ~4.5s, 覆盖 bj(g1) 落地窗口
  const p2 = round()                  // round2 开始: loop.pandalive.inFlight=true
  // bj(g1) 落地后泵应 break; round2 结束后 pumpIdle 才把 g2 发出
  const got = await waitUntil(() => world.bjCalls.some((c) => c.userId === 'g2'), 20000)
  await p2
  const g2At = world.bjCalls.find((c) => c.userId === 'g2')?.at || 0
  check('T10-1 g2 最终被扫到', got)
  check('T10-2 g2 的请求发出时刻 ≥ round2 结束时刻(让路生效)', g2At >= watcher.status.lastRoundAt,
    `g2.at=${g2At} round2End=${watcher.status.lastRoundAt}`)
}
await reset()
console.log('\n■ T10b 让路那条 break 本身要站得住: T10 那一发同时被共享限速队列挡着, 撤掉 break 它照样绿')
db.anchors = ['h1', 'h2'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
{
  watcher.loop.pandalive.inFlight = true // 直接摆"一轮正在打整表"这一态, 不靠时序撞
  watcher.idleQueue = db.anchors.slice()
  await watcher.pumpIdle()
  check('T10b-1 轮次在飞时一房不扫(0 请求)', world.bjCalls.length === 0, `实发=${world.bjCalls.length}`)
  check('T10b-2 让路是停脚不是作废: 两枚还在队里', watcher.idleQueue.length === 2, `队列=${watcher.idleQueue.length}`)
  watcher.loop.pandalive.inFlight = false
  await watcher.pumpIdle()
  check('T10b-3 轮次落地后重新点泵: 排队的房照旧扫到(下播发现延迟不因此变大)', world.bjCalls.length === 2 && watcher.idleQueue.length === 0, `实发=${world.bjCalls.length}`)
}

console.log('\n■ T11 取关守卫: 快照内主播被取关 → 不再发请求 / 开播事件不落')
await reset()
db.anchors = ['x1', 'x2'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
world.latency.bjMs = { x1: 400 } // 给取关留时序窗口
{
  await round()              // 泵 shift x1(飞 400ms)
  store.removeAnchor('pandalive', 'x2')   // 快照生成后取关 x2
  await waitUntil(() => !watcher.idlePumping, 4000)
  const idsCalled = world.bjCalls.map((c) => c.userId)
  check('T11-1 已取关的 x2 不再发请求', idsCalled.join(',') === 'x1', idsCalled.join(','))
}
// 取关主播恰在飞行窗口开播: 事件不得落(幽灵 toast/自录双保险)
await reset()
db.anchors = [mkAnchor('x3', { isLive: false, autoRecord: true }), mkAnchor('x4', { isLive: false })]
world.inList = {}
world.bjMedia = { x3: liveItem({ userId: 'x3', userNick: 'X3酱' }) }
world.latency.bjMs = { x3: 400 }
{
  await round()              // 泵 shift x3(飞 400ms)
  store.removeAnchor('pandalive', 'x3')   // 飞行窗口内取关
  await waitUntil(() => !watcher.idlePumping, 4000)
  check('T11-2 取关主播开播 toast 被守卫拦下', !world.toasts.some((t) => t.type === 'live'))
  check('T11-3 取关主播自动录制未启动', !world.recStarts.some((r) => r.userId === 'x3'))
  check('T11-4 未取关的 x4 照常轮扫', world.bjCalls.some((c) => c.userId === 'x4'))
}
// R4 同源: 预取泵——开播翻转把 z2 排进 prewarm 队列后, 节流窗口内取关 → 队列残留不得再拉源
await reset()
db.anchors = [mkAnchor('z1', { isLive: false }), mkAnchor('z2', { isLive: false })]
world.inList = { z1: true, z2: true } // 双主播同轮开播 → prewarmQueue=[z1,z2]
{
  await round() // 两个 onLiveStart: 预取泵启动, shift z1 拉源后进入 ~1.2s 节流 sleep
  store.removeAnchor('pandalive', 'z2') // 节流窗口内取关 z2(尚未被 shift)
  await waitUntil(() => !watcher.prewarmPumping.pandalive && !watcher.prewarmPumping.soop && !watcher.idlePumping, 6000)
  const pulled = new Set(world.playCalls.map((c) => c.userId))
  check('T11-5 z1(在监控)预取已完成', pulled.has('z1'))
  check('T11-6 z2(节流窗口内取关)未再拉源', !pulled.has('z2'), [...pulled].join(','))
}

console.log('\n■ T12 模式切换: list→per-anchor 后 idleQueue 清空, 泵无职责')
await reset()
db.anchors = ['m1', 'm2'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
world.latency.bjMs = { m2: 1200 } // 切换时 m2 应在飞
{
  await round()                    // 泵扫 m1 → shift m2(飞 1.2s)
  await sleep(300)
  db.settings = { ...db.settings, watchMode: 'per-anchor' }
  await round()                    // roundByBj 全量扫 m1,m2; 分支应清 idleQueue
  check('T12-1 per-anchor 分支清空 idleQueue', watcher.idleQueue.length === 0)
  const n0 = world.bjCalls.length
  await sleep(1600)                // 若泵未清, 残留会继续发请求
  check('T12-2 切换后间隙泵无新请求', world.bjCalls.length === n0, `${n0} → ${world.bjCalls.length}`)
}

console.log('\n■ T13 普通错误: 出错即停(不熔断), 下轮新快照恢复')
await reset()
db.anchors = ['e1', 'e2', 'e3'].map((id) => mkAnchor(id, { isLive: false }))
world.inList = {}
world.bjThrow = { e1: true }
{
  await round()
  await waitUntil(() => !watcher.idlePumping, 4000)
  const idsCalled = world.bjCalls.map((c) => c.userId)
  check('T13-1 出错即停(e2/e3 未扫)', idsCalled.join(',') === 'e1', idsCalled.join(','))
  check('T13-2 记 1 次失败但不熔断', watcher.errorStreak === 1 && watcher.status.circuitOpen === false)
  world.bjThrow = {}
  await round() // 新一轮: 新快照整批重排
  await waitUntil(() => new Set(world.bjCalls.map((c) => c.userId)).size >= 3, 6000)
  const seen = new Set(world.bjCalls.map((c) => c.userId))
  check('T13-3 下轮全员补扫恢复', ['e1', 'e2', 'e3'].every((id) => seen.has(id)), [...seen].join(','))
}

console.log('\n■ T14 urgent 回归: 列表外在播主播仍轮内每轮全查(不入间隙泵)')
await reset()
db.anchors = [mkAnchor('u1', { isLive: true }), mkAnchor('v1', { isLive: false })]
world.inList = {}
world.bjMedia = { u1: liveItem({ userId: 'u1', userNick: 'U1酱' }) } // u1 在播但列表不可见
{
  await round() // u1 走 urgent(轮内); v1 交泵(间隙)
  await waitUntil(() => world.bjCalls.some((c) => c.userId === 'v1'), 4000)
  await round() // 第二轮: u1 仍 urgent
  await waitUntil(() => world.bjCalls.filter((c) => c.userId === 'v1').length >= 2, 6000)
  const u1Calls = world.bjCalls.filter((c) => c.userId === 'u1').length
  check('T14-1 u1(在播) 每轮 urgent 恰好 1 次(泵未重复扫)', u1Calls === 2, `2 轮共 ${u1Calls} 次`)
  check('T14-2 v1(离线) 每轮间隙泵 1 次', world.bjCalls.filter((c) => c.userId === 'v1').length === 2)
}

console.log('\n■ T16 复用性: 大厅与关注主播共享一份列表请求 — 列表可见关注零增量, 仅不可见者单独查')
await reset()
// p1..p3: 关注且列表可见(在播); q1: 关注+离线+列表不可见(rest); q2: 关注+在播+列表不可见(urgent)
db.anchors = [
  ...['p1', 'p2', 'p3'].map((id) => mkAnchor(id, { isLive: false })),
  mkAnchor('q1', { isLive: false }),
  mkAnchor('q2', { isLive: true })
]
world.inList = { p1: true, p2: true, p3: true }
world.bjMedia = { q2: liveItem({ userId: 'q2', userNick: 'Q2酱' }) }
{
  await round()
  await waitUntil(() => world.bjCalls.some((c) => c.userId === 'q1'), 5000)
  const bjOf = (id) => world.bjCalls.filter((c) => c.userId === id).length
  check('T16-1 列表请求本轮仅 1 页(首页即到底)', world.liveCalls.length === 1, `${world.liveCalls.length} 次`)
  check('T16-2 大厅数据源来自同一份列表(discovery=3 条在播)', watcher.getDiscovery().length === 3)
  check('T16-3 列表可见的 p1/p2/p3 零增量 bj 请求', bjOf('p1') + bjOf('p2') + bjOf('p3') === 0, `p合计=${bjOf('p1') + bjOf('p2') + bjOf('p3')}`)
  check('T16-4 p1..p3 数据已从列表 patch(全部翻转为在播)', ['p1', 'p2', 'p3'].every((id) => db.anchors.find((a) => a.userId === id).isLive))
  check('T16-5 q2(urgent) 轮内恰好 1 次 bj', bjOf('q2') === 1, `${bjOf('q2')} 次`)
  check('T16-6 q1(rest) 仅间隙泵 1 次 bj, 无重复通道', bjOf('q1') === 1, `${bjOf('q1')} 次`)
  const total = world.liveCalls.length + world.bjCalls.length
  check('T16-7 全轮总请求 = 1(列表) + 1(urgent) + 1(rest泵) = 3', total === 3, `实测 ${total}`)
}

console.log('\n■ T17 粉丝房开播: fanLive 专用通知 + 自动录制照常')
await reset()
db.anchors = [mkAnchor('fan1', { isLive: false, autoRecord: true })]
// fakeFetch 的列表项由 inList 生成(恒 type=free) → 走 rest 泵 bj 通道注入 type=fan;
// onLiveStart 的 fanLive 判定读 tags.type, 任何通道同源
world.inList = {}
world.bjMedia = { fan1: liveItem({ userId: 'fan1', type: 'fan', title: '粉丝专场' }) }
{
  await round() // missing → rest 快照 → 间隙泵
  await waitUntil(() => world.toasts.length > 0, 5000)
  check('T17-1 粉丝房开播 toast 为 fanLive 类型', world.toasts.some((t) => t.type === 'fanLive'))
  check('T17-2 不再重复发普通 live toast', !world.toasts.some((t) => t.type === 'live'))
  check('T17-3 粉丝房自动录制照常启动', world.recStarts.some((r) => r.userId === 'fan1'))
}

console.log('\n■ T18 下播通知链路: 在播→复查判下播 → offline toast 单发; 再查仍离线不重复发')
await reset()
db.anchors = [mkAnchor('u9', { isLive: true, autoRecord: false })]
world.inList = {} // 列表不可见 → urgent 通道
world.bjMedia = { u9: liveItem({ userId: 'u9' }) }
{
  await round() // urgent 复查: 仍在播(数据跟进, 无事件)
  check('T18-0 持续在播无事件', world.toasts.length === 0)
  world.bjMedia.u9 = null // 下播
  await round() // urgent 复查 media=null → applyBj 下播分支
  check('T18-1 判下播后 isLive=false', db.anchors[0].isLive === false)
  check('T18-2 offline toast 发出(恰好一次)', world.toasts.filter((t) => t.type === 'offline').length === 1)
  await round() // 下一轮: u9 进 rest → 间隙泵复查仍 media=null → 不得重复通知
  await waitUntil(() => world.bjCalls.filter((c) => c.userId === 'u9').length >= 3, 6000)
  check('T18-3 重复判离线不重复发 toast', world.toasts.filter((t) => t.type === 'offline').length === 1)
}

console.log('\n■ T19 下播守卫: urgent 复查飞行窗口取关 → onLiveEnd 不落')
await reset()
db.anchors = [mkAnchor('u8', { isLive: true }), mkAnchor('u7', { isLive: false })]
world.inList = {}
world.bjMedia = {} // u8 media=null(下播), 但 bj 响应慢 400ms
world.latency.bjMs = { u8: 400 }
{
  const p = round()          // urgent 循环 await fetchBj(u8)(飞 400ms)
  await sleep(120)           // 确认请求在飞
  store.removeAnchor('pandalive', 'u8')   // 飞行窗口取关
  await p
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T19-1 取关后下播 toast 被守卫拦下', !world.toasts.some((t) => t.type === 'offline'))
  check('T19-2 未取关的 u7 仍被 rest 泵复查', world.bjCalls.some((c) => c.userId === 'u7'))
}

console.log('\n■ T20 双通道竞态: 泵在飞时发现开播 + 主循环同轮发现 → 通知/自录仅单发')
await reset()
db.anchors = [mkAnchor('d5', { isLive: false, autoRecord: true })]
world.inList = {}
world.bjMedia = { d5: liveItem({ userId: 'd5', userNick: 'D5酱' }) }
world.latency.bjMs = { d5: 700 } // 泵的 bj 慢 700ms
{
  await round() // round1: rest=[d5], 泵 shift d5, fetchBj 飞 700ms(media 在播)
  world.inList = { d5: true } // 同时 d5 出现在全站列表
  const p = round()           // round2 立即开始: 主循环命中 d5 → onLiveStart(第一发)
  await p
  await waitUntil(() => !watcher.idlePumping, 4000) // 泵的 bj(d5) 后落地: wasLive 已为 true → 跳过
  check('T20-1 开播 toast 恰好一次', world.toasts.filter((t) => t.type === 'live').length === 1,
    `${world.toasts.filter((t) => t.type === 'live').length} 次`)
  check('T20-2 自动录制恰好一次', world.recStarts.filter((r) => r.userId === 'd5').length === 1)
}

console.log('\n■ T21 自录失败不伤链路: recorder.start 抛错 → toast 照发/计数不涨/他人照常')
await reset()
db.anchors = [mkAnchor('bad1', { isLive: false, autoRecord: true }), mkAnchor('ok2', { isLive: false, autoRecord: true })]
world.inList = { bad1: true, ok2: true } // 双主播同轮开播
world.recStartThrow = true // 所有 start 都抛
{
  await round()
  check('T21-1 自录失败但开播 toast 照发', world.toasts.filter((t) => t.type === 'live').length === 2)
  check('T21-2 watcher 失败计数不涨(recorder 静默兜底)', watcher.errorStreak === 0)
  check('T21-3 熔断未误开', watcher.status.circuitOpen === false)
  world.recStartThrow = false
  await round() // 正常轮, 无翻转无事件
  check('T21-4 后续轮询正常无异常', watcher.errorStreak === 0 && watcher.status.circuitOpen === false)
}

console.log('\n■ T22 录制开关矩阵: autoRecord=false 不起录; R5 取关时序(先取关后停录)窗口无孤儿录制')
await reset()
db.anchors = [mkAnchor('norec', { isLive: false, autoRecord: false })]
world.inList = { norec: true }
{
  await round()
  check('T22-1 autoRecord=false: 通知有/起录无', world.toasts.some((t) => t.type === 'live') && world.recStarts.length === 0)
}
// R5: 模拟修复后的 ipc 顺序——先 removeAnchor 再慢 stop; stop 窗口内开播翻转不得新建录制
await reset()
db.anchors = [mkAnchor('w9', { isLive: false, autoRecord: true })]
world.inList = { w9: true } // w9 开播中(列表可见)
world.stopDelayMs = 600
{
  store.removeAnchor('pandalive', 'w9') // 第一步: 取关落库(ipc 修复后顺序)
  const stopP = (async () => {
    world.recStops.push({ platform: 'pandalive', userId: 'w9' }) // 第二步: 慢 stop 进行中
    await sleep(world.stopDelayMs)
  })()
  await round() // stop 窗口内的轮询: w9 已不在监控 → 主循环不遍历, 即便翻转也无自录
  await stopP
  check('T22-2 R5时序: stop 窗口内无孤儿录制', !world.recStarts.some((r) => r.userId === 'w9'))
  check('T22-3 R5时序: stop 已对该主播执行', recStopped('w9'))
  check('T22-4 R5时序: 开播在列表里仍不发通知(守卫)', !world.toasts.some((t) => t.type === 'live'))
}

console.log('\n■ T23 隔离: 关注主播查无此人(注销/改名/错 id) — 不熔断不连败, 标离线+一次性提醒+不再请求')
await reset()
db.anchors = [mkAnchor('ghost', { isLive: true })]
world.inList = {} // 列表不可见 → missing(在播) → urgent 路径
world.bjNotFound = { ghost: true }
{
  await round()
  check('T23-1 查无此人被标离线(不再示在播)', db.anchors[0].isLive === false)
  check('T23-2 一次性提醒已发(带 userId)', world.toasts.some((t) => t.type === 'info' && String(t.title).includes('ghost')))
  check('T23-3 无熔断无连败(单点错误不扩散)', watcher.status.circuitOpen === false && watcher.errorStreak === 0)
  await sleep(600) // 给间隙泵机会(不应)发请求
  const n1 = world.bjCalls.filter((c) => c.userId === 'ghost').length
  await round()
  await sleep(600)
  const n2 = world.bjCalls.filter((c) => c.userId === 'ghost').length
  check('T23-4 后续轮次不再为其发请求', n1 === 1 && n2 === 1, `ghost bj 请求数恒定=${n2}`)
  check('T23-5 提醒不重复', world.toasts.filter((t) => t.type === 'info').length === 1)
  // T23-6: 解除标记(移除/重加或账号恢复)后可重新探活
  watcher.unmarkGone('pandalive', 'ghost')
  world.bjNotFound = {}
  world.bjMedia = { ghost: liveItem({ userId: 'ghost' }) } // 账号恢复且在播
  await round()
  const revived = await waitUntil(() => db.anchors[0].isLive === true, 3000)
  check('T23-6 解除标记后重新探活(恢复开播翻转)', revived === true && world.bjCalls.filter((c) => c.userId === 'ghost').length >= 2)
}

console.log('\n■ T24 双平台隔离: SOOP 关注只走 SOOP 链路, 既不污染 Panda 请求/计数/熔断, 也不被 Panda 故障连坐')
await reset()
db.anchors = [mkAnchor('p24', { isLive: true }), mkAnchor('s24', { platform: 'soop', isLive: false, autoRecord: true })]
world.inList = { p24: true } // Panda 那位在列表可见(零增量 bj); SOOP 同号频道绝不该被当"列表缺失的 Panda 主播"打错站
world.soopMeta = { s24: { broadNo: 999, living: true, hostName: 'S主播', roomName: 'S标题', thumbUrl: 's.jpg' } }
{
  await round()
  check('T24-1 SOOP 关注零 pandalive 请求(member/bj 与 play 均未越界)', world.bjCalls.every((c) => c.userId !== 's24') && playCount('s24') === 0)
  check('T24-2 SOOP 开播翻转写回关注卡(昵称/标题/截图同轮落地)', db.anchors[1].isLive === true && db.anchors[1].nick === 'S主播' && db.anchors[1].title === 'S标题' && db.anchors[1].thumbUrl === 's.jpg')
  // 探针就是"这房现在怎么样"的裁判, 拿到上一轮的旧页等于把"还没开播"读成结论
  check('T24-2b 播放页探针以 fresh 发问(绕过页面微缓存)', world.soopFresh.includes('s24'))
  const prewarmed = await waitUntil(() => world.soopCalls.includes('getPlayCached:s24'), 3000)
  check('T24-3 开播链路走 SOOP 契约: 旧源作废 + 预取均落 SOOP', world.soopCalls.includes('invalidatePlay:s24') && prewarmed)
  check('T24-4 自动录制按复合键起录(platform=soop)', world.recStarts.some((r) => r.platform === 'soop' && r.userId === 's24'))
  check('T24-5 计数分域: 大厅在播只算 Panda, 关注数含双平台', watcher.status.liveCount === 1 && watcher.status.monitored === 2)
  check('T24-6 Panda 侧状态未被 SOOP 扰动(p24 仍在播)', db.anchors[0].isLive === true)

  // 第三态: 页面既没场次号也没说下播(风控页/改版) → 本轮不动已知状态
  world.soopMeta = { s24: {} }
  const t0 = world.toasts.length
  await round()
  check('T24-7 第三态("没读到"≠"已下播"): 状态与通知全保持', db.anchors[1].isLive === true && world.toasts.length === t0)

  // 明确下播: 需连续两轮读数一致才翻转(这一翻要发通知并停自录, 单页抖动无权定罪)
  world.soopMeta = { s24: { living: false, explicitOffline: true } }
  await round()
  check('T24-8a 首轮下播读数: 状态与通知按兵不动(去抖)', db.anchors[1].isLive === true && world.toasts.filter((x) => x.type === 'offline').length === 0)
  await round()
  check('T24-8b 次轮确认才判下播: 状态翻转 + offline 通知单发', db.anchors[1].isLive === false && world.toasts.filter((x) => x.type === 'offline').length === 1)
  check('T24-9 下播即作废 SOOP 源(不留死源骗秒开徽标)', world.soopCalls.filter((c) => c === 'invalidatePlay:s24').length >= 2)
  world.soopMeta = { s24: { living: true, broadNo: 999, hostName: 'S主播' } }
  await round()
  world.soopMeta = { s24: { living: false, explicitOffline: true } }
  await round()
  check('T24-9b 复播清零下播计数: 复播后的首轮下播同样不去抖成秒判', db.anchors[1].isLive === true)
  await round()
  check('T24-9c 复播后次轮确认: 正常判下播(去抖只延后一轮, 不吞事件)', db.anchors[1].isLive === false)

  // 单平台失明: SOOP 整轮全错不得开 Panda 熔断(连败只属于 SOOP)
  world.soopThrow = { s24: true }
  await round()
  await round()
  check('T24-10 SOOP 连续全灭: 不开 Panda 熔断、不计 Panda 连败', watcher.status.circuitOpen === false && watcher.errorStreak === 0)
  check('T24-11 SOOP 失明跨阈值出声一次(顶栏不得假绿)', world.toasts.filter((x) => x.title === 'watcher.soopDownT').length === 1)
  const Ssoop = watcher.status.byPlatform.soop
  const coolingOn = watcher.soopCooldownUntil > Date.now()
  const probeBefore = world.soopCalls.filter((c) => c === 'pageMeta:s24').length
  const roundAtBefore = Ssoop.lastRoundAt
  const costBefore = Ssoop.roundMs
  await round()
  check('T24-12 连败期间不重复刷屏', world.toasts.filter((x) => x.title === 'watcher.soopDownT').length === 1)
  // 退避是这一轮真正该验的东西: 失明时"每轮都重发"的形状正是风控最忌讳的
  check('T24-12b 失明跨阈值即武装退避(soopCooldownUntil 落在未来)', coolingOn)
  check('T24-12c 冷却轮整轮零请求(探针一发不发)', world.soopCalls.filter((c) => c === 'pageMeta:s24').length === probeBefore)
  check('T24-12d 冷却轮不刷心跳读数: lastRoundAt/roundMs 沿用上一轮, 未读数不得归零',
    Ssoop.lastRoundAt === roundAtBefore && Ssoop.roundMs === costBefore && Ssoop.roundFailed === 1)
  // 的平台分家: SOOP 哑了只写自己那半截状态。推熔断位会把 Panda 专供的「去登录」挂到 SOOP 顶栏上,
  // 而合并视图的 circuitOpen 恒等于 Panda —— 用户会被带去重新登录一个根本没失效的账号
  check('T24-12e SOOP 失明不开自己的熔断位, 合并读数也不被推高', Ssoop.circuitOpen === false && watcher.status.circuitOpen === false)
  world.soopThrow = {}
  world.soopMeta = { s24: { living: false, explicitOffline: true } }
  watcher.soopCooldownUntil = Date.now() - 1 // 真实恢复路径就是等退避到期: 到期后的第一轮才该重新发问
  await round()
  check('T24-13 SOOP 恢复即归零连败(重新武装提醒)', watcher.soopFailStreak === 0 && world.soopCalls.filter((c) => c === 'pageMeta:s24').length === probeBefore + 1)

  // 部分失败(设计稿 7.2「整轮部分失败」): 读不到 1 个房 ≠ 全灭, 也 ≠ 一切正常
  db.anchors.push(mkAnchor('s24b', { platform: 'soop', isLive: false }))
  world.soopThrow = { s24b: true }
  await round()
  const S24 = watcher.status.byPlatform.soop
  check('T24-15 部分失败只数读不到的房, 不升格成全灭(streak 不增、不重复出声)',
    S24.roundFailed === 1 && watcher.soopFailStreak === 0 && world.toasts.filter((x) => x.title === 'watcher.soopDownT').length === 1)
  check('T24-16 部分失败必须出声: 本平台 message 带条数(顶栏不得假绿)', String(S24.message).startsWith('watcher.soopPartial'))
  world.soopThrow = {}
  await round()
  check('T24-17 下一轮读到了: 计数与正文同时清零(不残留旧告警)', S24.roundFailed === 0 && S24.message === '')

  // 反向连坐: Panda 冷却期 SOOP 探针照常(两套域名/会话, Panda 被风控无权停 SOOP)
  await reset()
  db.anchors = [mkAnchor('p24', { isLive: false }), mkAnchor('s24', { platform: 'soop', isLive: false })]
  world.soopMeta = { s24: { living: true, broadNo: 1, hostName: 'S主播' } }
  watcher.cooldownUntil = Date.now() + 60_000
  await round()
  check('T24-14 Panda 冷却期: 扇出面(全站榜/逐房探针)零请求, SOOP 探针不连坐(匿名态预言机那一发同样不发, 登录态见 T40)',
    world.liveCalls.length === 0 && world.bjCalls.length === 0 && world.bmCalls.length === 0 && world.soopCalls.includes('pageMeta:s24') && db.anchors[1].isLive === true)
}

// ============ T25 取源回写的房态合并 (2026-10-01 实机抓到: 19+ 房一开播, 旗就被抹掉) ============
{
  console.log('\n--- T25 applyPlayMeta: 这一路看不到的字段不许写 false ---')
  const { applyPlayMeta } = loadTs('src/main/services/source.ts')
  await reset()
  db.anchors = [mkAnchor('s25', { platform: 'soop', isLive: true, tags: { isAdult: true, isPw: false, type: '', liveType: 'live' } })]
  const t1 = applyPlayMeta('soop', 's25', { ok: true, media: { liveType: 'live', isPw: true } })
  check('T25-1 回包没有 isAdult ⇒ 列表真值保留(取源看不到 19+, 补 false 等于每次开播擦一次)', t1.isAdult === true && db.anchors[0].tags.isAdult === true)
  check('T25-2 回包真观察到的 isPw 照样落卡', t1.isPw === true && db.anchors[0].tags.isPw === true)
  const t2 = applyPlayMeta('soop', 's25', { ok: true, media: { isAdult: false, liveType: 'live', isPw: true } })
  check('T25-3 回包明确给 false ⇒ 按回包办(既不臆断, 也不拿旧值遮蔽真观察)', t2.isAdult === false && db.anchors[0].tags.isAdult === false)
  await reset()
  db.anchors = [mkAnchor('p25', { isLive: true, tags: { isAdult: true, isPw: false, type: 'fan', liveType: 'live' } })]
  const t3 = applyPlayMeta('pandalive', 'p25', { ok: true, media: { isAdult: false, type: '' } })
  check('T25-4 Panda 一律不回写房态(每轮由列表原值维护, 两处写=两套真值)', t3 === null && db.anchors[0].tags.isAdult === true && db.anchors[0].tags.type === 'fan')
}

// ============ T26 监控配置按平台分家: 预取与轮询间隔各走自己那一格 ============
console.log('\n■ T26 分家实证: 关掉邻居那一格不得带走本平台; Panda 熔断只压自己那条时间轴')
await reset()
db.anchors = [mkAnchor('p26', { isLive: false }), mkAnchor('s26', { platform: 'soop', isLive: false })]
db.settings.monitor.pandalive.prefetchStream = false // 只关 Panda 那一格
world.inList = { p26: true }
world.soopMeta = { s26: { living: true, broadNo: 1, hostName: 'S26酱' } }
{
  await round()
  check('T26-1 Panda 预取关: 开播通知照发但不拉源(事件链路不被开关带走)',
    world.toasts.some((x) => x.type === 'live' && x.platform === 'pandalive') && playCount('p26') === 0)
  const prewarmSoop = await waitUntil(() => world.soopCalls.includes('getPlayCached:s26'), 3000)
  check('T26-2 同轮开播的 SOOP 房照旧预取(邻居说"不要秒开"无权代它决定)', prewarmSoop && db.anchors[1].isLive === true)
}
// 反向: 只关 SOOP 的预取
await reset()
db.anchors = [mkAnchor('p26b', { isLive: false }), mkAnchor('s26b', { platform: 'soop', isLive: false })]
db.settings.monitor.soop.prefetchStream = false
world.inList = { p26b: true }
world.soopMeta = { s26b: { living: true, broadNo: 2, hostName: 'S26b酱' } }
{
  await round()
  const prewarmPanda = await waitUntil(() => playCount('p26b') > 0, 3000)
  check('T26-3 只关 SOOP: Panda 侧秒开不受影响', prewarmPanda)
  check('T26-4 SOOP 自己不拉源, 但开播状态照常翻转(开关只关预取, 不关监控)',
    world.soopCalls.filter((c) => c === 'getPlayCached:s26b').length === 0 && db.anchors[1].isLive === true)
}
{
  db.settings.monitor.pandalive.pollIntervalSec = 120
  db.settings.monitor.soop.pollIntervalSec = 45
  check('T26-5 下一轮等多久 = 各自那一格', watcher.intervalFor('pandalive') === 120_000 && watcher.intervalFor('soop') === 45_000)
  watcher.status.byPlatform.pandalive.circuitOpen = true
  check('T26-6 熔断期不改轮距(C1 撤掉了那一压), 且两站各按各的格子: SOOP 永远不陪着 Panda 变',
    watcher.intervalFor('pandalive') === 120_000 && watcher.intervalFor('soop') === 45_000)
  watcher.status.byPlatform.pandalive.circuitOpen = false
  db.settings.monitor.soop.pollIntervalSec = 0 // 手改库写出 0: 定时器不得每毫秒发一轮
  check('T26-7 间隔下限只防坏数据, 不改变正常值', watcher.intervalFor('soop') === 1_000)
}

// ============ T27 Panda 轮询的预言机: 一发站内关注列表判全部 + 全站榜改按需 ============
// 实测基线(2026-10-02): 158 关注 = 1 发 / 90KB / page.lastPage=1 —— 请求面与关注数无关。
// 上预言机要三件套齐: jar 有 sessKey + cookieValid=true + 服务端给关注行(缺一条必须落回全站榜那条链)
const login = (rows) => {
  api.jar = { sessKey: 't27' }
  api.cookieValid = true
  world.bm = rows
}

console.log('\n■ T27-A 预言机一轮一发: 全部关注由它判定, 全站榜与逐房探针同时下车')
await reset()
login([bmLive('aaa', { user: 28, title: '预言机标题', startTime: '2026-10-02 18:52:55' }), bmOff('ddd')])
db.anchors = [mkAnchor('aaa', { isLive: false }), mkAnchor('ddd', { isLive: false })]
{
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T27-A1 一轮恰好一发站内关注列表', world.bmCalls.length === 1, `bm 发数=${world.bmCalls.length}`)
  check('T27-A2 轮询不再搭全站榜的车(大厅改按需)', world.liveCalls.length === 0, `全站榜页数=${world.liveCalls.length}`)
  check('T27-A3 列表覆盖到的离线关注不再逐房探针/进间隙泵', world.bjCalls.length === 0 && watcher.idleQueue.length === 0)
  check('T27-A4 在播/离线各按列表原值判定', db.anchors[0].isLive === true && db.anchors[1].isLive === false)
  const a = db.anchors[0]
  check('T27-A5 场次元数据一次到位(标题/观众/开播时刻/房态标签)',
    a.title === '预言机标题' && a.viewerCount === 28 && a.startTime === '2026-10-02 18:52:55' && !!a.tags && a.tags.type === 'free')
  check('T27-A6 读数分家: 在播数来自预言机, 全站在播数不再由轮询刷新',
    watcher.pandaOracle === 'bookmark' && watcher.status.byPlatform.pandalive.liveFound === 1 && watcher.status.liveCount === 0 && watcher.pandaCovered === 2)
  check('T27-A7 大厅的钟不跟轮次走(预言机一轮不碰 discoveryAt, 页头那格才不能借 lastRoundAt)',
    watcher.status.discoveryAt === 0)
}

console.log('\n■ T27-B 预言机里的开播翻转: 通知/预取/自录一样不少(换真值源不换事件链路)')
await reset()
db.anchors = [mkAnchor('eee', { isLive: false, autoRecord: true })]
login([bmLive('eee')])
{
  await roundOne('pandalive')
  const prefetched = await waitUntil(() => playCount('eee') > 0, 3000)
  check('T27-B1 开播 toast + 自动录制 + 预取拉源',
    world.toasts.some((x) => x.type === 'live') && world.recStarts.some((r) => r.userId === 'eee') && prefetched)
}

console.log('\n■ T27-C 下播要两轮: 单轮读数不翻转(这一翻要发通知+作废源缓存)')
await reset()
db.anchors = [mkAnchor('fff', { isLive: true, autoRecord: true })]
login([bmOff('fff')])
{
  await api.getPlayCached('fff') // 先在播, 已取过一次源
  await roundOne('pandalive')
  check('T27-C1 第一轮报下播: 状态/通知/源缓存全部按兵不动',
    db.anchors[0].isLive === true && world.toasts.filter((x) => x.type === 'offline').length === 0 && playCount('fff') === 1)
  await roundOne('pandalive')
  check('T27-C2 第二轮确认才判下播: 状态翻转 + offline 通知单发',
    db.anchors[0].isLive === false && world.toasts.filter((x) => x.type === 'offline').length === 1,
    `isLive=${db.anchors[0].isLive} offline=${world.toasts.filter((x) => x.type === 'offline').length} oracle=${watcher.pandaOracle}`)
  await api.getPlayCached('fff')
  check('T27-C3 判下播当轮旧源即作废(假发的旧频道源点播放必暴毙)', playCount('fff') === 2)
  await roundOne('pandalive')
  check('T27-C4 已离线后重复读数不再重复发通知', world.toasts.filter((x) => x.type === 'offline').length === 1)
}

console.log('\n■ T27-D 列表覆盖不到的关注(应用内自增/官网侧取关): 原探针链路一条不少')
await reset()
login([bmLive('aaa')])
db.anchors = [mkAnchor('aaa', { isLive: true }), mkAnchor('ggg', { isLive: true }), mkAnchor('hhh', { isLive: false })]
world.bjMedia = { ggg: liveItem({ userId: 'ggg' }), hhh: null }
{
  await roundOne('pandalive')
  check('T27-D1 列表外且仍在播的: 轮内立即复查(urgent)', world.bjCalls.some((c) => c.userId === 'ggg'))
  check('T27-D2 列表内已判在播的: 不重复发探针', !world.bjCalls.some((c) => c.userId === 'aaa'))
  check('T27-D3 列表外的离线关注交间隙泵轮扫(与旧链路同一份兜底)', await waitUntil(() => world.bjCalls.some((c) => c.userId === 'hhh'), 4000))
  await waitUntil(() => !watcher.idlePumping, 4000)
  check('T27-D4 覆盖数=列表行数(轮次日志那句「站内覆盖」的同一枚读数)', watcher.pandaCovered === 1 && db.anchors[0].isLive === true && db.anchors[1].isLive === true)
}

console.log('\n■ T27-E 列表不可用 = 回落, 绝不等于「全员下播」')
await reset()
login(null) // 端点整条不接待 → fetchBookmarks 内部收敛为 null
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: true })]
{
  await roundOne('pandalive')
  check('T27-E1 读不到列表 → 本轮走全站榜分页(旧链路完好)', watcher.pandaOracle === 'list' && world.liveCalls.length > 0)
  check('T27-E2 在播主播没被「没读到」误判下播', db.anchors[0].isLive === true && world.toasts.filter((x) => x.type === 'offline').length === 0)
}
await reset()
login([bmOff('aaa')])
world.bmStatus = 403 // 这一发被风控
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: true })]
{
  await roundOne('pandalive')
  check('T27-E3 403 同样降级(不解析成"全部关注都下播"), 连败计数仍由全站榜那轮说了算',
    watcher.pandaOracle === 'list' && watcher.errorStreak === 0 && db.anchors[0].isLive === true)
}
await reset()
login([bmLive('aaa')])
world.bmResultFalse = true // 服务端回"没登录"(瞬时/改版)
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: true })]
{
  await roundOne('pandalive')
  world.bmResultFalse = false
  await roundOne('pandalive')
  check('T27-E4 降级不自闭: 服务端恢复说话, 下一轮预言机自动再上车',
    world.bmCalls.length === 2 && watcher.pandaOracle === 'bookmark')
}

console.log('\n■ T27-F 会话门: 匿名不发这一发; "罐在但没证明"先问一句 login_info(冷启动不再整轮落回四页)')
await reset()
world.bm = [bmLive('aaa')]
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: true })]
{
  await roundOne('pandalive')
  check('T27-F1 没有会话罐: 预言机零请求(连那一问都不发), 全站榜那条照跑(匿名用户的既有链路)',
    world.bmCalls.length === 0 && world.liCalls.length === 0 && world.liveCalls.length > 0 && watcher.pandaOracle === 'list')
}
await reset()
api.jar = { sessKey: 't27' } // 罐还在, 但服务端说没登录(判死)
api.cookieValid = false
world.loginInfo = null // 那一问的答案: 没登录
world.bm = [bmLive('aaa')]
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: true })]
{
  await roundOne('pandalive')
  check('T27-F2 判死期问一句就收: 不发那一发注定 result:false 的 POST', world.liCalls.length === 1 && world.bmCalls.length === 0 && world.liveCalls.length > 0)
  check('T27-F3 全站榜那条从 loginInfo 把会话重新点亮(自愈不靠运气)', api.cookieValid === true)
  await roundOne('pandalive')
  check('T27-F4 点亮后下一轮预言机自动再上车(1 发, 全站榜不再被搭, 也不用再问)',
    world.bmCalls.length === 1 && world.liCalls.length === 1 && watcher.pandaOracle === 'bookmark')
}
await reset()
api.jar = { sessKey: 't27' } // 冷启动: vault 里有罐, 但本次运行还没证明过(cookieValid 初值 false)
api.cookieValid = false
world.bm = [bmLive('aaa')]
world.inList = { aaa: true }
db.anchors = [mkAnchor('aaa', { isLive: false })]
{
  await roundOne('pandalive')
  check('T27-F5 冷启动第一轮: login_info 说要的 → 当场转上预言机(不再整轮落回四页全站榜)',
    world.liCalls.length === 1 && world.bmCalls.length === 1 && world.liveCalls.length === 0 && db.anchors[0].isLive === true)
  await roundOne('pandalive')
  check('T27-F6 证明过一次就不再每轮硬闯: 第二问为 0, 全站榜仍是 0', world.liCalls.length === 1 && world.bmCalls.length === 2 && world.liveCalls.length === 0)
}

console.log('\n■ T27-G 大厅(全站榜)改按需: 谁站在发现页谁拉, 60 秒内复用')
await reset()
world.inList = { h1: true, h2: true }
{
  const d1 = await watcher.refreshDiscovery()
  check('T27-G1 进发现页才拉全站榜(短页即到底: 1 页)', world.liveCalls.length === 1 && d1.length === 2 && watcher.status.discoveryAt > 0, `页数=${world.liveCalls.length}`)
  const d2 = await watcher.refreshDiscovery()
  check('T27-G2 60 秒内的快照直接复用(切视图/翻页/搜索不再打官网)', world.liveCalls.length === 1 && d2.length === 2)
  const t0 = watcher.status.discoveryAt
  await new Promise((r) => setTimeout(r, 3))
  await watcher.refreshDiscovery(true)
  check('T27-G3 8 秒下限之内连点: force 也不发(force 只豁免 60 秒复用窗口, 不豁免这条下限)', world.liveCalls.length === 1 && watcher.status.discoveryAt === t0)
  watcher.status.discoveryAt = t0 - 8_100 // 把钟拨到下限之外: 真实场景就是"上一份大厅快照是 8 秒以前拉的"
  await watcher.refreshDiscovery(true)
  check('T27-G3b 过了下限, 手动刷新强制越过复用窗口', world.liveCalls.length === 2)
  check('T27-G3c 快照换了钟就跟着换(页头"拉取于"读的就是这一枚)', watcher.status.discoveryAt > t0)
}
await reset()
world.inList = { h1: true }
await watcher.refreshDiscovery(true)
{
  const n = world.liveCalls.length
  watcher.status.byPlatform.pandalive.circuitOpen = true
  const d3 = await watcher.refreshDiscovery(true)
  check('T27-G4 熔断期一发都不发, 用户继续看旧快照', world.liveCalls.length === n && d3.length === 1)
  watcher.status.byPlatform.pandalive.circuitOpen = false
  watcher.cooldownUntil = Date.now() + 60_000
  await watcher.refreshDiscovery(true)
  check('T27-G5 退避期同规约(冷却里不硬闯)', world.liveCalls.length === n)
  watcher.cooldownUntil = 0
}
await reset()
world.inList = { h1: true }
await watcher.refreshDiscovery(true)
world.liveFail = true
{
  const d4 = await watcher.refreshDiscovery(true)
  check('T27-G6 刷新失败保留上一份快照(绝不画成"全站没人播"), 且不计轮次连败',
    d4.length === 1 && watcher.getDiscovery().length === 1 && watcher.errorStreak === 0)
  world.liveFail = false
}
await reset()
world.inList = { h1: true }
world.latency.liveMs = 250
{
  const [ra, rb] = await Promise.all([watcher.refreshDiscovery(true), watcher.refreshDiscovery(true)])
  check('T27-G7 并发刷新合并在飞的那一次(不重复发整批页)', world.liveCalls.length === 1 && ra === rb)
  world.latency.liveMs = 0
}

console.log('\n■ T27-H 逐个模式不再清空大厅(全站榜与 watchMode 解耦)')
await reset()
world.inList = { h1: true }
db.settings.watchMode = 'per-anchor'
db.anchors = [mkAnchor('ccc', { isLive: false })]
world.bjMedia = { ccc: liveItem({ userId: 'ccc' }) }
{
  await watcher.refreshDiscovery(true)
  check('T27-H0 大厅先有一份快照', watcher.getDiscovery().length === 1)
  await roundOne('pandalive')
  check('T27-H1 逐个模式的一轮不清快照(它只管"怎么查我的关注")', watcher.getDiscovery().length === 1 && db.anchors[0].isLive === true)
  check('T27-H2 逐个模式同样不搭全站榜的车(请求数=那一发刷新)', world.liveCalls.length === 1)
}

// ============ T28 SOOP 降级探针的每轮预算 + 游标轮转 ============
// 实测基线(2026-10-02 真库): 718 个 SOOP 关注, 列表整表不可用时"每房一发"= 718 发/轮 ≈ 5.7 万发/天,
// 且网络越坏发得越凶。预算 40 + 游标轮转后一轮最多 40 发, 被挡下的房下一轮排到队首, 不会被永久饿死。
// 这一场把 requestGapMs 设成 0: 探针之间的节流是按发数睡觉, 300ms × 40 会让单场断言跑十几秒
// (真实下限由设置钳制在 300, 与预算无关 —— 预算管发数, 节流管发速)
const soopSent = () => world.soopCalls.filter((c) => c.startsWith('pageMeta:')).map((c) => c.slice('pageMeta:'.length))
// 点 SOOP 预取泵的公共一段: runRound 的 finally 自己会 void pumpPrewarm(轮次落地重新点泵),
// 而 pumpPrewarm 进门第一句是 `if (prewarmPumping) return` —— 不等那条泵放下就推队列,
// 我这一条直接 return, 断言"零发"会因为竞态而绿(那正是记过的形状: "替身绿而真链路从未被跑")
const soopPump = async (uids) => {
  await waitUntil(() => !watcher.prewarmPumping.soop, 6000)
  watcher.prewarmQueue.soop.length = 0 // 就地改: 上面那条泵拿的就是这一个数组
  watcher.prewarmQueue.soop.push(...uids)
  await watcher.pumpPrewarm('soop')
}
const BUDGET = 40 // 与 Watcher.SOOP_PROBE_BUDGET 同值(改一处必须改两处, 由 D55 契约站岗)

console.log('\n■ T28-A 预算: 整表失明时一轮最多 40 发, 其余本轮不读')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null // 列表整条不接待 → 全部关注落逐房探针
db.anchors = Array.from({ length: 45 }, (_, i) => mkAnchor(`b${String(i).padStart(2, '0')}`, { platform: 'soop', isLive: i >= 40 }))
{
  await roundOne('soop')
  const sent = soopSent()
  check('T28-A1 一轮发数=预算(45 个关注只读 40)', sent.length === BUDGET, `实发=${sent.length}`)
  check('T28-A2 队尾那 5 个房本轮没被问', new Set(sent).size === BUDGET && !sent.includes('b44'))
  check('T28-A3 未读数按新口径把挡下的也数进去(顶栏那句仍成立)', watcher.status.byPlatform.soop.roundFailed === 45 - BUDGET)
  check('T28-A4 被挡下的在播房保持原读数, 且不因为"本轮没读"发下播通知', db.anchors.slice(40).every((a) => a.isLive === true) && world.toasts.length === 0)

  await roundOne('soop')
  const sent2 = soopSent().slice(sent.length)
  check('T28-B1 第二轮仍是预算发数', sent2.length === BUDGET, `实发=${sent2.length}`)
  check('T28-B2 上一轮被挡下的房这一轮排到队首(轮换不饿死任何房)', ['b40', 'b41', 'b42', 'b43', 'b44'].every((c) => sent2.includes(c)))
  check('T28-B3 两轮并集覆盖全部 45 个房', new Set([...sent, ...sent2]).size === 45)
}

console.log('\n■ T28-C 常态(列表覆盖绝大部分关注): 预算不切刀, 与改造前一字不差')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = Array.from({ length: 45 }, (_, i) => ({ userId: `b${String(i).padStart(2, '0')}`, isLive: false, nick: '', lastStartTime: '' })).filter((r) => r.userId !== 'b07' && r.userId !== 'b23')
db.anchors = Array.from({ length: 45 }, (_, i) => mkAnchor(`b${String(i).padStart(2, '0')}`, { platform: 'soop', isLive: false }))
{
  await roundOne('soop')
  check('T28-C1 只有列表缺席的 2 个房被探针问(预算没动刀)', soopSent().length === 2 && soopSent().includes('b07') && soopSent().includes('b23'), `发数=${soopSent().length}`)
  check('T28-C2 未超预算即游标归零(常态无需轮转)', watcher.soopProbeCursor === 0)
  check('T28-C3 列表覆盖的 43 个房由列表判离线(整表覆盖时探针不得数进未读)', watcher.status.byPlatform.soop.roundFailed === 0 && watcher.status.byPlatform.soop.liveFound === 0)
}

console.log('\n■ T28-D 预算之上的失明: 整表全灭仍须判"这一站哑了"(判据只看实际发出的那一批)')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null
db.anchors = Array.from({ length: 45 }, (_, i) => mkAnchor(`d${String(i).padStart(2, '0')}`, { platform: 'soop', isLive: false }))
for (const a of db.anchors) world.soopThrow[a.userId] = true // 网络/风控: 每一发取页都抛错
{
  await roundOne('soop')
  await roundOne('soop')
  check('T28-D1 连续两轮"发出的全失败"即判失明(streak=2, 40 发不必追上 45 个)', watcher.soopFailStreak === 2, `streak=${watcher.soopFailStreak}`)
  check('T28-D2 失明只出声一次, 同时武装退避(下一轮一发都不发)', world.toasts.filter((x) => x.title === 'watcher.soopDownT').length === 1 && watcher.soopCooldownUntil > Date.now())
  check('T28-D3 未读数=发出失败的 40 + 被预算挡下的 5 = 整表一个都没读到', watcher.status.byPlatform.soop.roundFailed === 45, `未读=${watcher.status.byPlatform.soop.roundFailed}`)
}

// ============ T29 作废纪元: 显式作废之后, 先于它发出的那条链不得把源写回来 ============
// 复现的正是 2026-10-02 审计里的形状: invalidatePlay 只删了 playCache, 在飞的链回来照旧 set ——
// "缓存复活"在用户那边就是"下播的房还能秒开 / 换号后仍用旧账号签发的源".
console.log('\n■ T29 纪元门: 在飞取流链遇到 invalidatePlay / clearPlayCache 即不许落缓存')
await reset()
{
  const p = api.getPlayCached('r4', '', true) // 链已出发(请求在飞)
  api.invalidatePlay('r4') // 出发之后被判作废(下播/源收尸/换号)
  const r = await p
  check('T29-1 结果照还给调用方(该给的一发不少)', r.ok === true)
  check('T29-2 但这条链不许复活缓存', api.cachedSourceIds().length === 0, JSON.stringify(api.cachedSourceIds()))
  const n0 = playCount('r4')
  const r2 = await api.getPlayCached('r4')
  check('T29-3 下一次进房重新一发(缓存里确实是空的)', playCount('r4') === n0 + 1 && r2.ok)
}
await reset()
{
  const p = api.getPlayCached('r5', '', true)
  api.clearPlayCache() // 换号/登出: 旧账号签发的源整表作废
  await p
  check('T29-4 整表作废同样挡住在飞链(旧会话的源不复活)', api.cachedSourceIds().length === 0)
  api.clearPlayCache()
  check('T29-5 二次作废幂等且不补发请求', api.cachedSourceIds().length === 0 && playCount('r5') === 1)
}
await reset()
{
  const pack = await api.getPlayCached('r6', '', true)
  check('T29-6 正常拉源照旧落缓存(纪元门不放水好源)', api.cachedSourceIds().includes('pandalive:r6'))
  api.invalidatePlay('r6')
  api.seedPlay('r6', pack) // 续录复用中断探针刚现拉到的那一发
  const n0 = playCount('r6')
  const hit = await api.getPlayCached('r6')
  check('T29-7 种子命中: 下一次取流零新请求(省掉整条五步链/一次重铸)', playCount('r6') === n0 && hit.m3u8 === pack.m3u8)
  api.seedPlay('r7', { ...pack, ok: false })
  check('T29-8 坏源不许种(种子只认真拿到手的源)', !api.cachedSourceIds().includes('pandalive:r7'))
}

// ============ T30 立即刷新的 8 秒下限: 唯一由人手放大的请求面 ============
console.log('\n■ T30 立即刷新节流: 刚落地一轮时连点不再整站重扫, 过了下限那一格照发')
await reset()
world.inList = { t1: true }
db.anchors = [mkAnchor('t1')]
{
  watcher.loop.pandalive.lastAt = 0 // 冷态: 本场还没跑过轮
  const n0 = world.liveCalls.length
  watcher.tick('pandalive')
  const started = await waitUntil(() => world.liveCalls.length > n0, 2000)
  check('T30-1 首轮没有被下限挡住(lastAt 未落地 = 不发才怪)', started)
  await waitUntil(() => !watcher.loop.pandalive.inFlight, 3000)
  const n1 = world.liveCalls.length
  watcher.tick('pandalive')
  watcher.tick('pandalive')
  await sleep(400)
  check('T30-2 一轮刚落地: 连点两下零请求(整站列表那一发不被手放大)', world.liveCalls.length === n1, `页数=${world.liveCalls.length - n1}`)
  check('T30-3 被挡下的那几下有出声(节流不是失灵)', watcher.loop.pandalive.inFlight === false)
  watcher.loop.pandalive.lastAt = Date.now() - 9000
  watcher.tick('pandalive')
  const after = await waitUntil(() => world.liveCalls.length > n1, 2000)
  check('T30-4 过了下限那一格照发(功能没被换成禁用)', after)
  await waitUntil(() => !watcher.loop.pandalive.inFlight, 3000)
  const soopN = world.soopCalls.length
  watcher.tick('soop') // 另一条时间轴刚跑过(round 里两平台各一轮)→ 同样被挡
  await sleep(300)
  check('T30-5 节流按平台各算各的: 点 SOOP 只问 SOOP', world.soopCalls.length === soopN)
}

// ============ T31 判死期的 login_info 探针: 30 秒缓存短于轮询间隔 = 每轮白付一发 ============
console.log('\n■ T31 login_info 探针节流: 明确"没登录"后 5 分钟不再问, 请求失败下一轮照问')
await reset()
api.jar = { sessKey: 't31' }
api.cookieValid = false
world.loginInfo = null // 服务端明确: 没登录
world.liveLoginInfo = false // 全站榜也不替它说话(否则会自愈点亮, 探针根本不再被需要)
world.inList = { u1: true }
db.anchors = [mkAnchor('u1', { isLive: true })]
{
  // 一问有 30 秒结果缓存(就有的机制): 真机上轮询间隔 ≥ 这一档时它天然不重复。
  // 这里每轮手动清一次缓存 = 把"轮与轮之间隔了半分钟"这一常态复刻出来, 让 5 分钟节流单独受审
  const cold = () => { api.loginInfoCache = null; api.loginInfoInflight = null }
  cold()
  await roundOne('pandalive')
  check('T31-1 判死第一轮问一句', world.liCalls.length === 1)
  cold()
  await roundOne('pandalive')
  cold()
  await roundOne('pandalive')
  check('T31-2 明确"没登录"之后不再每轮复读', world.liCalls.length === 1, `问数=${world.liCalls.length}`)
  check('T31-3 节流只省探针: 回落的全站榜那条链一轮都不少', world.liveCalls.length >= 3, `页数=${world.liveCalls.length}`)
  check('T31-4 预言机仍被挡在外面(读数说 list)', watcher.pandaOracle === 'list')
  watcher.pandaProbeUntil = 0 // 退避到期
  cold()
  await roundOne('pandalive')
  check('T31-5 到期后重新问一句(节流不等于永久哑)', world.liCalls.length === 2, `问数=${world.liCalls.length}`)
}
await reset()
api.jar = { sessKey: 't31b' }
api.cookieValid = false
world.liThrow = true // 请求本身失败(断网/风控)
world.liveLoginInfo = false
world.inList = { u2: true }
db.anchors = [mkAnchor('u2')]
{
  await roundOne('pandalive')
  await roundOne('pandalive')
  check('T31-6 读不到 ≠ 判死: netFail 不节流, 下一轮照问', world.liCalls.length === 2, `问数=${world.liCalls.length}`)
  check('T31-7 netFail 那一问不武装退避', watcher.pandaProbeUntil === 0)
}

// ============ T32 全站榜分页只有一处实现: 兜底轮与大厅共走一条在飞锁 ============
console.log('\n■ T32 分页单飞: 轮询兜底与大厅刷新同时启动只翻一趟页; 同一发失败的两种吃法')
await reset()
world.inList = { v1: true }
world.latency.liveMs = 250 // 让两条链真重叠(微任务里各自跑完就等于没测到锁)
db.anchors = [mkAnchor('v1')]
{
  const pr = roundOne('pandalive')
  const pd = watcher.refreshDiscovery(true)
  await Promise.all([pd, pr])
  check('T32-1 两条链合计翻了一趟页, 不是两趟', world.liveCalls.length === 1, `页数=${world.liveCalls.length}`)
  check('T32-2 大厅与轮次拿到的是同一份快照', watcher.getDiscovery().length === 1 && watcher.status.discoveryAt > 0)
  check('T32-3 在飞锁用完即撒(下一轮还能真发)', watcher.pageHarvest === null)
  await roundOne('pandalive')
  check('T32-4 撒锁后下一轮自己翻页(锁不是缓存)', world.liveCalls.length === 2)
}
await reset()
world.inList = { v2: true }
db.anchors = [mkAnchor('v2', { isLive: true })]
{
  await watcher.refreshDiscovery(true)
  const snap = watcher.getDiscovery().slice()
  world.latency.liveMs = 0
  world.liveFail = true
  const d = await watcher.refreshDiscovery(true)
  check('T32-5 大厅: 拉不到不抛错、不空表(沿用上一份快照)', d.length === snap.length && watcher.getDiscovery().length === snap.length)
  const before = watcher.errorStreak
  await roundOne('pandalive')
  check('T32-6 轮次: 同一发失败必须是本轮失败(部分页不许冒充成功)', watcher.errorStreak === before + 1, `streak=${watcher.errorStreak}`)
  check('T32-7 失败轮不改口(没读到 ≠ 全员下播, 在播读数保持)', db.anchors[0].isLive === true)
}

// ============ T33 预取补扫挪到首轮之后: 只认刚落地的真值, 且跳过手上已有源的房 ============
console.log('\n■ T33 首轮后补扫: 排队发生在真值写回之后, 已有源的房不再预取, 且只跑首轮')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
world.inList = { w1: true, w2: true }
db.anchors = [mkAnchor('w1', { isLive: true }), mkAnchor('w2', { isLive: true })]
{
  await api.getPlayCached('w1') // 手上已有一枚有效源
  world.playCalls.length = 0
  await roundOne('pandalive')
  check('T33-1 补扫排在首轮摘要之后(不在开机那一瞬)', watcher.loop.pandalive.roundCnt === 1)
  const drained = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 3000)
  check('T33-2 没源的在播房排队(w2 恰好一发)', drained && playCount('w2') === 1, `w2=${playCount('w2')}`)
  check('T33-3 已有源的房跳过(w1 零发)', playCount('w1') === 0)
  world.playCalls.length = 0
  db.anchors.push(mkAnchor('w3', { isLive: true }))
  world.inList.w3 = true
  await roundOne('pandalive')
  await sleep(400)
  check('T33-4 补扫只属于首轮: 稳态轮不再群发(新开播自有事件)', playCount('w3') === 0 && watcher.prewarmQueue.pandalive.length === 0)
}
await reset()
db.settings.monitor.pandalive.prefetchStream = false
world.inList = { w4: true }
db.anchors = [mkAnchor('w4', { isLive: true })]
{
  await roundOne('pandalive')
  await sleep(400)
  check('T33-5 那一格关着 = 补扫零排队(开关读的是本平台那一格)', playCount('w4') === 0 && watcher.prewarmQueue.pandalive.length === 0)
}
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null
world.soopMeta = { y1: { living: true, broadNo: 11 }, y2: { living: true, broadNo: 12 } }
world.soopCached = ['y2'] // 替身手上已有 y2 的源
db.anchors = [mkAnchor('y1', { platform: 'soop', isLive: true }), mkAnchor('y2', { platform: 'soop', isLive: true })]
{
  await roundOne('soop')
  const drained = await waitUntil(() => !watcher.prewarmPumping.soop, 3000)
  check('T33-6 补扫走本平台那份契约: SOOP 没源的房排队', drained && world.soopCalls.includes('getPlayCached:y1'))
  check('T33-7 跨平台不串台: 缓存清单读的是 SOOP 那一份(y2 跳过)', !world.soopCalls.includes('getPlayCached:y2'))
}

console.log('\n■ T34 门槛回执账 + 密码房不预取: 平台明说过不去的门槛不重打整链')
await reset()
{
  world.playGate.g1 = 'needCoinPurchase'
  db.anchors = [mkAnchor('g1', { isLive: true })]
  const r1 = await api.getPlayCached('g1')
  check('T34-1 门槛回执原样还给调用方(整链恰好一发)', r1.ok === false && playCount('g1') === 1, `实发=${playCount('g1')}`)
  const r2 = await api.getPlayCached('g1')
  check('T34-2 15 分钟内同房第二次取源零请求(那句门槛话不是网络故障, 重打只会换回同一句)', r2.ok === false && playCount('g1') === 1, `实发=${playCount('g1')}`)
  await api.getPlayCached('g1', 'pw')
  check('T34-3 带着密码来问的那一发不吃门(用户下一次可能改对)', playCount('g1') === 2, `实发=${playCount('g1')}`)
  await api.getPlayCached('g1', '', true)
  check('T34-4 手动强刷(forceFresh)照旧即时试(账不拦用户意图)', playCount('g1') === 3, `实发=${playCount('g1')}`)
  api.invalidatePlay('g1')
  await api.getPlayCached('g1')
  check('T34-5 作废即清账: 事件(重开播/录制出错/强刷)之后重新问平台', playCount('g1') === 4, `实发=${playCount('g1')}`)
  world.playGate.g2 = 'needLogin'
  db.anchors.push(mkAnchor('g2', { isLive: true }))
  await api.getPlayCached('g2')
  await api.getPlayCached('g2')
  check('T34-6 账只认那五个码: needLogin 不记账(后台自愈重登后必须能立刻再试)', playCount('g2') === 2, `实发=${playCount('g2')}`)
  world.playGate.g3 = 'castEnd'
  db.anchors.push(mkAnchor('g3', { isLive: true }))
  await api.getPlayCached('g3')
  await api.getPlayCached('g3')
  check('T34-7 castEnd 在账上: 本场已断的那句话 15 分钟内不再复读', playCount('g3') === 1, `实发=${playCount('g3')}`)
  api.clearPlayCache()
  await api.getPlayCached('g3')
  check('T34-8 换号/登出清账: 上一个账号的"爱心余额不足"对新账号毫无意义', playCount('g3') === 2, `实发=${playCount('g3')}`)
}
await reset()
console.log('\n■ T34b 密码房不进预取队列(预取那一路永远没有密码, 那一发注定换回"要密码")')
{
  db.anchors = [mkAnchor('pw1', { isLive: true, tags: { isAdult: false, isPw: true, type: 'free' } })]
  watcher.enqueuePrewarm('pandalive', 'pw1')
  const drained = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 2000)
  check('T34b-1 密码房零发且不入队', drained && playCount('pw1') === 0 && watcher.prewarmQueue.pandalive.length === 0, `实发=${playCount('pw1')}`)
  db.anchors.push(mkAnchor('pw2', { isLive: true }))
  watcher.enqueuePrewarm('pandalive', 'pw2')
  await waitUntil(() => playCount('pw2') > 0, 2000)
  check('T34b-2 对照: 非密码房照旧排队拉源', playCount('pw2') === 1, `实发=${playCount('pw2')}`)
}
await reset()
console.log('\n■ T34c ③ 结构性门槛账跨重启落盘: 重启不改账号, 每次冷启动重打整链就是白付(实测 24 次/日、一天 81 行受限回执)')
{
  const gWrites = () => world.anchorWrites.filter((w) => 'gateCode' in w.patch)
  const A = (uid) => db.anchors.find((x) => x.userId === uid)
  world.playGate.h1 = 'needCoinPurchase'
  world.playGate.h2 = 'needFan'
  db.anchors = [mkAnchor('h1', { isLive: true }), mkAnchor('h2', { isLive: true })]
  const r1 = await api.getPlayCached('h1')
  check('T34c-1 结构性那一类落盘: 码 + 到期时刻两格进锚点行(话不入库, 由码现生成)', r1.ok === false && A('h1').gateCode === 'needCoinPurchase' && A('h1').gateUntil > Date.now() + 14 * 60_000 && A('h1').gateUntil < Date.now() + 16 * 60_000, `gateCode=${A('h1').gateCode} 剩=${((A('h1').gateUntil - Date.now()) / 60_000).toFixed(1)}分`)
  check('T34c-1b 被挡一次只挡 15 分钟, 不是一天(用户定「退避统一 15 分钟冷却」: 门槛多半是暂时的, 一次挡满一天把"已经好了"押到明天)', A('h1').gateUntil - Date.now() < 60 * 60_000, `剩=${((A('h1').gateUntil - Date.now()) / 60_000).toFixed(1)}分`)
  check('T34c-1c 内存那一本与盘上那一格同一个到期时刻(旧写法内存 15 分钟 / 盘 24 小时, 屏上的数只在冷启动之后成立)', Math.abs(api.gates.get('h1').until - A('h1').gateUntil) < 2000, `内存=${api.gates.get('h1').until} 盘=${A('h1').gateUntil}`)
  check('T34c-2 落盘只有这一笔: 取源链路没有多出一次锚点写', gWrites().length === 1 && gWrites()[0].userId === 'h1', `写次=${gWrites().length}`)
  const r2 = await api.getPlayCached('h2')
  check('T34c-3 needFan 不落盘(用户点一下加粉就翻, 那本账只配活 15 分钟)', r2.ok === false && !A('h2').gateCode && !A('h2').gateUntil, `盘上=${JSON.stringify([A('h2').gateCode, A('h2').gateUntil])}`)
  // 变异刀 K8 逼出来的: 不落盘那两类吃的是内存那把尺, 不吃阶梯 —— 只静态钉 GATE_TTL_MS 的话, 把它改成 20 分钟两套都是绿的
  const h2left = api.gates.get('h2').until - Date.now()
  check('T34c-3b 不落盘的那两类仍是内存那把尺的那一档(15 分钟, 不跟着阶梯走)', h2left > 14 * 60_000 && h2left < 16 * 60_000, `剩=${(h2left / 60_000).toFixed(1)}分`)
  await api.getPlayCached('h2')
  check('T34c-4 不落盘 ≠ 不再短路: 内存那一本对 h2 照旧生效(第二次零发)', playCount('h2') === 1, `实发=${playCount('h2')}`)

  // 重启的诚实形状: 进程内存(Map)清空, 盘上那两格跟着 db.json 活下来
  api.gates.clear()
  api.playCache.clear()
  api.gatesHydrated = false
  const r3 = await api.getPlayCached('h1')
  check('T34c-5 冷启动后同一间零发: 读回来的仍是平台那句话(不是把受限当成取流失败)', r3.ok === false && r3.error === 'api.needCoinPurchase' && playCount('h1') === 1, `实发=${playCount('h1')} 话=${r3.error}`)
  await api.getPlayCached('h2')
  check('T34c-6 没落盘的那一类重启后照旧重问一发(落盘范围就是这一格的全部取舍)', playCount('h2') === 2, `实发=${playCount('h2')}`)

  A('h1').gateUntil = Date.now() - 1000 // 过期的那一格: 当没读到, 并顺手从盘上抹掉
  api.gates.clear()
  api.gatesHydrated = false
  await api.getPlayCached('h1')
  check('T34c-7 到期即自愈: 读回时先把那一格从盘上抹掉(过期账不留成永久挡)', world.anchorWrites.some((w) => w.userId === 'h1' && w.patch.gateCode === '' && w.patch.gateUntil === 0))
  check('T34c-7b 抹完照旧问平台, 新账与第一格同一把尺(15 分钟, 不往后挪)', playCount('h1') === 2 && A('h1').gateUntil > Date.now() + 14 * 60_000 && A('h1').gateUntil < Date.now() + 16 * 60_000, `实发=${playCount('h1')} 剩=${((A('h1').gateUntil - Date.now()) / 60_000).toFixed(1)}分`)
  // 上一版(一天 / 递增阶梯)在盘上留下的长到期日不许把新尺子押到明天 —— 读回时钳到"从现在起最多一把尺"
  A('h1').gateUntil = Date.now() + 20 * 3600_000
  api.gates.clear()
  api.gatesHydrated = false
  await api.getPlayCached('h1')
  check('T34c-7c 读回钳位: 盘上写着 20 小时后放行, 内存那一格最多认到 15 分钟, 且这一发仍被短路(钳位不是重问)', (api.gates.get('h1') || {}).until > 0 && api.gates.get('h1').until - Date.now() < 16 * 60_000 && playCount('h1') === 2, `内存剩=${((api.gates.get('h1').until - Date.now()) / 60_000).toFixed(1)}分 实发=${playCount('h1')}`)

  world.playGate.h1 = '' // 门槛解了(充值/成年验证过了): 强制重取真拿到源
  const ok1 = await api.getPlayCached('h1', '', true)
  check('T34c-8 平台改口当场把两本账一起撤(内存 + 盘, 上一格那枚 20 小时的长到期日也一并抹净)—— 没有这一笔, 落盘那格就成了单向棘轮', ok1.ok === true && !api.gates.has('h1') && !A('h1').gateCode && A('h1').gateUntil === 0, `盘=${JSON.stringify([A('h1').gateCode, A('h1').gateUntil])}`)
  const w8 = gWrites().length
  await api.getPlayCached('h1')
  check('T34c-9 源在手时不再重打整链, 也不再为"没账"写盘(无账不写)', playCount('h1') === 3 && gWrites().length === w8, `实发=${playCount('h1')} 写次=${gWrites().length - w8}`)

  world.playGate.h1 = 'needCoinPurchase' // 重新挂上门槛(下一场又付一次), 先让源作废
  api.dropCachedPlay('h1')
  await api.getPlayCached('h1')
  check('T34c-10 重新记账并再次落盘(落盘跟着平台那句话走, 不是一次性写死); 成功过一次 ⇒ 下一次被挡仍从 15 分钟起', A('h1').gateCode === 'needCoinPurchase' && playCount('h1') === 4 && A('h1').gateUntil - Date.now() > 14 * 60_000 && A('h1').gateUntil - Date.now() < 16 * 60_000, `实发=${playCount('h1')} 剩=${((A('h1').gateUntil - Date.now()) / 60_000).toFixed(1)}分`)
  const w10 = gWrites().length
  api.invalidatePlay('h1') // 事件: 新一场开播 / 录制出错 / 手动强刷
  check('T34c-11 事件即清连盘一起清(内存与盘当场都空, 且只落一笔清账写)', !A('h1').gateCode && A('h1').gateUntil === 0 && !api.gates.has('h1') && gWrites().length === w10 + 1, `本段写次=${gWrites().length - w10}`)
  await api.getPlayCached('h1')
  check('T34c-12 清完重新问平台 —— 事件那一句的全部意义就是"再见一次"', playCount('h1') === 5, `实发=${playCount('h1')}`)

  api.clearPlayCache() // 换号/登出: 上一号的结构性账对新号毫无意义
  check('T34c-13 换号连盘一起清: 盘上一格都不许留给下一个账号', A('h1').gateUntil === 0 && !A('h1').gateCode && !api.gates.has('h1'), `盘=${JSON.stringify([A('h1').gateCode, A('h1').gateUntil])}`)
  const c13 = playCount('h1')
  await api.getPlayCached('h1')
  check('T34c-14 清完读回也是空: 新账号第一次照问平台(不继承上一号的"过不去")', playCount('h1') === c13 + 1, `新增=${playCount('h1') - c13}`)

  // 退避不做指数(用户定「统一 15 分钟冷却, 不要指数」): 连着被挡不许一档一档往后挪 —— 但每被挡一次仍要重新落一次账,
  // 且两本账逐次都是同一个到期时刻。这一格是变异逼出来的: 只比"第一次被挡"时两本相不相等是弱格(把内存改回固定值、
  // 盘上另写一个数, 第一次照样相等), 必须连着比六次才验得出"两本是同一格"
  const gaps = []
  const memGap = []
  for (let i = 0; i < 6; i++) {
    api.gates.delete('h1')
    A('h1').gateUntil = Date.now() - 1000
    api.gatesHydrated = false
    await api.getPlayCached('h1')
    gaps.push(Math.round((A('h1').gateUntil - Date.now()) / 60_000))
    memGap.push(Math.round(((api.gates.get('h1') || {}).until || 0) - A('h1').gateUntil))
  }
  check('T34c-15 连着被挡六次, 每一次都是 15 分钟(没有一档一档往后挪, 也没有封顶这一说)', gaps.join(',') === '15,15,15,15,15,15', gaps.join(','))
  check('T34c-16 每一次都真问平台: 六次被挡 = 六发取源, 没有一次被短路放过去(冷却到期就是该再问一次)', playCount('h1') === c13 + 7, `实发=${playCount('h1') - c13}`)
  check('T34c-17 六次逐次比, 内存与盘都是同一个到期时刻(只比第一次是弱格)', memGap.every((g) => Math.abs(g) < 2000), `逐次差(ms)=${memGap.join(',')}`)
  check('T34c-18 盘上那一格从头到尾只有码与时刻两笔, 没有第三本账(阶梯计数器 gateTries 已随退避一起删净)', !('gateTries' in A('h1')) && Object.keys(A('h1')).filter((k) => k.startsWith('gate')).join(',') === 'gateCode,gateUntil', Object.keys(A('h1')).filter((k) => k.startsWith('gate')).join(','))

  // 复核: 诊断台⑫的 kind / 「重启后还挡着」从前是从**已本地化**的那句话里 split(':') 反推码的 ——
  // 只有落不进映射表的码才长成 "code: msg", 于是盘上那三类反而永远推不出码, 真机实拍五间一颗徽章都没亮。
  await api.getPlayCached('h2') // T34c-13 换号把那本内存账整本清过, 不再问一次就没有 needFan 那一格可数
  // 投影本身此前没有任何行为面在数, 这里补上: 静态契约管得住写法, 管不住"数从哪儿来"
  const d1 = api.diag().gates.find((x) => x.room === 'h1')
  const d2 = api.diag().gates.find((x) => x.room === 'h2')
  check('T34c-19 ⑫读数: 落盘那一类带的是平台原始码 + 「重启后还挡着」(kind 是给渲染层查表的键, 不是已经翻好的那句话)', d1?.kind === 'needCoinPurchase' && d1?.persisted === true, JSON.stringify(d1))
  check('T34c-20 不落盘的那一类不许亮徽章(needFan 点一下加粉就翻, 对它说"重启后还挡着"是假话)', d2?.kind === 'needFan' && d2?.persisted === false, JSON.stringify(d2))
  api.gates.clear()
  api.gatesHydrated = false
  const c21 = playCount('h1')
  await api.getPlayCached('h1')
  const cold = api.diag().gates.find((x) => x.room === 'h1')
  check('T34c-21 冷启动从盘上读回来的那一格同样带码与徽章, 且一发不多(真机那五间走的就是这条路)', cold?.kind === 'needCoinPurchase' && cold?.persisted === true && playCount('h1') === c21, JSON.stringify(cold) + ` 实发=${playCount('h1') - c21}`)
}
await reset()
console.log('\n■ T35 预取的档位扇出: 后台那一发只买最高档, 满档由"真的进房"那一次买')
{
  world.soopFavorites = null
  world.soopMeta = { z1: { living: true, broadNo: 21 } }
  db.anchors = [mkAnchor('z1', { platform: 'soop', isLive: true })]
  await roundOne('soop')
  await waitUntil(() => !watcher.prewarmPumping.soop, 3000)
  const arg = world.soopPlayArgs.find((x) => x.channel === 'z1')
  check('T35-1 预取那一发 fullVariants=false(每多一档多两发: 1 aid + 1 调度)', !!arg && arg.fullVariants === false, JSON.stringify(arg))
  check('T35-2 预取不带 forceFresh(泵不许把在途/缓存命中变成强制重打)', !!arg && arg.forceFresh === false, JSON.stringify(arg))
}

await reset()
db.settings.monitor.pandalive.requestGapMs = 0
console.log('\n■ T36 预取泵让路(与 pumpIdle 同规约): 轮次在飞/停轮都不发, 但让路是 break 不是清队')
{
  db.anchors = [mkAnchor('lv1', { isLive: true }), mkAnchor('lv2', { isLive: true })]
  watcher.loop.pandalive.inFlight = true // 伪造"一轮正在打整表"
  watcher.enqueuePrewarm('pandalive', 'lv1')
  watcher.enqueuePrewarm('pandalive', 'lv2')
  void watcher.pumpPrewarm('pandalive')
  await sleep(300)
  check('T36-1 轮次在飞时预取零发(单房 2~6 发不许叠在整表那一发上)', playCount('lv1') === 0 && playCount('lv2') === 0, `lv1=${playCount('lv1')} lv2=${playCount('lv2')}`)
  check('T36-2 让路把两枚留在队里(清队等于把秒开的时效赔进去)', watcher.prewarmQueue.pandalive.length === 2, `队列=${watcher.prewarmQueue.pandalive.length}`)
  watcher.loop.pandalive.inFlight = false
  void watcher.pumpPrewarm('pandalive') // 生产里这一脚由 runRound 的 finally 补上(幂等)
  const drained = await waitUntil(() => playCount('lv1') > 0 && playCount('lv2') > 0, 3000)
  check('T36-3 轮次落地后重新点泵: 排队的房照旧秒开', drained, `lv1=${playCount('lv1')} lv2=${playCount('lv2')}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.running = false // 停轮: 生产里 stop() 第一件事就是立这面旗(入队会顺手点泵, 所以旗要先立)
  db.anchors = [mkAnchor('lv3', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 'lv3')
  await sleep(300)
  check('T36-4 停轮即停泵: 关掉监控以后这条泵不再逐房拉源', playCount('lv3') === 0, `实发=${playCount('lv3')}`)
  watcher.running = true
  watcher.prewarmQueue.pandalive = ['q1', 'q2']
  watcher.idleQueue = [mkAnchor('q3')]
  watcher.stop()
  check('T36-5 停轮同时清队: 只清定时器会把"下一发要发真请求"的待办留在手里', watcher.prewarmQueue.pandalive.length === 0 && watcher.idleQueue.length === 0, `预取=${watcher.prewarmQueue.pandalive.length} 兜底=${watcher.idleQueue.length}`)
}

// ============ T37 (P1-1 改判) SOOP 降级态: 只加留痕, 不加占空比 ============
// 结论: 这一格要治的"40 发/轮 × 1440 轮 ≈ 5.76 万发整页/天"确实成立,
// 但 rows===null 时这条逐房整页【就是】检测路径(全站榜对 SOOP 不存在, 站内列表又读不到):
// 718 个关注 ÷ 40 发/轮 ≈ 18 轮扫一遍, 把批次拉到 8 分钟就等于把开播发现延迟拉到小时级 ——
// 那是拿时效换流量, 这笔交易要用户点头才做。所以只把这一形状写进日志, 不减发。
// 这三场因此锁的是"没有偷偷减发" + "留痕只在该出声时出声"。
console.log('\n■ T37-A 连续失明轮: 探针发数一轮不少(占空比已撤销), 但每一轮都在日志里留一句')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null // 列表整条不接待 → 全部关注落逐房整页探针
db.anchors = Array.from({ length: 45 }, (_, i) => mkAnchor(`s${String(i).padStart(2, '0')}`, { platform: 'soop', isLive: false }))
for (const a of db.anchors) world.soopMeta[a.userId] = { living: false, explicitOffline: true }
{
  const perRound = []
  const receipts = []
  for (let r = 1; r <= 4; r++) {
    const before = soopSent().length
    const log0 = world.logs.length
    await roundOne('soop')
    perRound.push(soopSent().length - before)
    receipts.push(world.logs.slice(log0).filter((l) => /降级探针回执/.test(l)))
  }
  check('T37-A1 四个失明轮每轮发满预算: 没有任何一格在暗地里压这一面的速率', perRound.every((n) => n === BUDGET), `实发=${perRound.join(',')}`)
  // 那句话从"不可用"改口成"没覆盖到我的关注" —— 判据换成 covered===0 之后, 整表读通而我的关注一个不在
  // 也算失明, 再说"列表不可用"就是撒谎(与 D76d 同一条)
  check('T37-A2 每轮一句留痕, 且把连续失明的轮数带上(4 句分别是 1~4 轮)', receipts.every((x) => x.length === 1) && /连续 4 轮没覆盖到我的关注/.test(receipts[3][0]))
  check('T37-A3 留痕报的是这一轮的账(40 发整页、0 在播、40 报下播、0 失败)', /^info\|soop\|降级探针回执: 40\/45 发整页\(在播=0 未读到\/下播=40 失败=0/.test(receipts[3][0]))
  check('T37-A4 读得动的失明轮不武装任何收手: 冷却、连败、提醒全部按兵不动', watcher.soopCooldownUntil === 0 && watcher.soopFailStreak === 0 && world.toasts.length === 0)
  check('T37-A5 未读数口径不因留痕而变(被预算挡下的 5 间才算没读到)', watcher.status.byPlatform.soop.roundFailed === 5, `roundFailed=${watcher.status.byPlatform.soop.roundFailed}`)
  const fav0 = world.soopCalls.filter((c) => c === 'favorites').length
  await roundOne('soop')
  check('T37-A6 列表那一发照旧每轮: 它是"这一站恢复了吗"的唯一眼睛', world.soopCalls.filter((c) => c === 'favorites').length === fav0 + 1)
}

console.log('\n■ T37-B 探针自己也全灭时: 已有那句 warn 在报这一轮的账, 留痕不重复出声, 连败一路走到跨阈值')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null
db.anchors = Array.from({ length: 5 }, (_, i) => mkAnchor(`q${i}`, { platform: 'soop', isLive: false }))
for (const a of db.anchors) world.soopThrow[a.userId] = true
{
  await roundOne('soop')
  await roundOne('soop')
  const sentC = soopSent().length
  const logC = world.logs.filter((l) => /降级探针回执/.test(l)).length
  await roundOne('soop')
  check('T37-B1 全灭判据照旧成立(留痕那一格不参与任何判定, 所以不可能把"这一站哑了"读成"没瞎")', watcher.soopFailStreak === 2, `streak=${watcher.soopFailStreak}`)
  check('T37-B2 失明提醒只一句', world.toasts.filter((x) => x.title === 'watcher.soopDownT').length === 1)
  check('T37-B3 整轮静默由连败武装', watcher.soopCooldownUntil > Date.now())
  check('T37-B4 全灭轮不单发留痕: 那句「取页全失败」已经在报同一件事, 两句是重复读数面', soopSent().length === sentC && world.logs.filter((l) => /降级探针回执/.test(l)).length === logC, `探针=${soopSent().length}/${sentC}`)
}

console.log('\n■ T37-C 常态(列表读得到): 探针是个位数的常态, 留痕不许把它刷成计数器')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = [{ userId: 'n1', isLive: false, nick: '', lastStartTime: '' }]
db.anchors = [mkAnchor('n1', { platform: 'soop', isLive: false }), mkAnchor('n2', { platform: 'soop', isLive: false })]
{
  await roundOne('soop')
  await roundOne('soop')
  check('T37-C1 列表覆盖的那一间由列表判离线, 只有站内缺席的走探针', soopSent().length === 2 && soopSent().includes('n2'), `探针=${soopSent().join(',')}`)
  check('T37-C2 常态轮不出声: 失明账本没立, 日志里没有回执那一句', watcher.soopBlindStreak === 0 && !world.logs.some((l) => /降级探针回执/.test(l)))
}

console.log('\n■ T37-D 列表恢复当轮: 失明账本当场作废(留痕那句"连续 N 轮"必须是本会话的真实长度)')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null
db.anchors = [mkAnchor('z1', { platform: 'soop', isLive: false }), mkAnchor('z2', { platform: 'soop', isLive: false })]
for (const a of db.anchors) world.soopMeta[a.userId] = { living: false, explicitOffline: true }
{
  await roundOne('soop')
  await roundOne('soop')
  check('T37-D1 两个失明轮记到 2', watcher.soopBlindStreak === 2)
  world.soopFavorites = db.anchors.map((a) => ({ userId: a.userId, isLive: false, nick: '', lastStartTime: '' }))
  const sent4 = soopSent().length
  const log5 = world.logs.length
  await roundOne('soop')
  check('T37-D2 恢复当轮账本归零且探针归位(只剩列表缺席者, 这里为 0)', watcher.soopBlindStreak === 0 && soopSent().length === sent4)
  check('T37-D3 恢复轮不再发降级回执', !world.logs.slice(log5).some((l) => /降级探针回执/.test(l)))
}

// ============ T37-E ① 「整表读通而这一间不在表里」那一支: 从前全天一个字都不出 ============
// 真机读数: hag1947 一天 ≈1,358 发整页、日志里只有 1 行, 因为 row===undefined 那一支
// 既被 `if (row)` 挡在留痕外面, 又被 covered 从失明判据里扣掉 ⇒ 只加可见性, 一发不减(减不减是用户的三档)。
console.log('\n■ T37-E 整表可用而某间不在里面: 掉出报一次、回来报一次, 中间每轮不许报名, 也不许少发一发')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = [{ userId: 'u1', isLive: false, nick: '', lastStartTime: '' }]
db.anchors = [mkAnchor('u1', { platform: 'soop', isLive: false }), mkAnchor('u2', { platform: 'soop', isLive: false })]
{
  const out = () => world.logs.filter((l) => /不在站内关注表/.test(l))
  const back = () => world.logs.filter((l) => /回到站内关注表/.test(l))
  await roundOne('soop')
  check('T37-E1 第一轮就把这一支报出来, 且是 warn 级带房名', out().length === 1 && /^warn\|soop\|.*@u2$/.test(out()[0]), out().join(' / ') || '(无)')
  await roundOne('soop')
  await roundOne('soop')
  check('T37-E2 三轮仍只一句: 报名的是"变化"那一格, 不是每轮同一个人(那条老纪律)', out().length === 1, `条数=${out().length}`)
  check('T37-E3 一发没减: u2 每轮照走整页探针(3 发), u1 由整表判离线零发', soopSent().join(',') === 'u2,u2,u2', `探针=${soopSent().join(',')}`)
  check('T37-E4 常态轮不立失明账本(covered=1 那一格一字未动)', watcher.soopBlindStreak === 0)
  world.soopFavorites.push({ userId: 'u2', isLive: false, nick: '', lastStartTime: '' })
  const sent5 = soopSent().length
  await roundOne('soop')
  check('T37-E5 回到表里当天报一句收场, 探针跟着停下(它不再是回落那一支)', back().length === 1 && /^info\|soop\|.*@u2$/.test(back()[0]) && soopSent().length === sent5, `${back().join('/')}|探针=${soopSent().length - sent5}`)
  world.soopFavorites = world.soopFavorites.filter((r) => r.userId !== 'u2')
  await roundOne('soop')
  check('T37-E6 再掉出去会再报一次(边沿触发要双向都能复报, 不是只报头一回)', out().length === 2 && soopSent().slice(-1)[0] === 'u2', `条数=${out().length}`)
  const out6 = out().length
  world.soopFavorites = null // 整表读不通那一支: 全部回落, 与"这一间被站内表漏掉"是两件事, 不许在这里报名
  await roundOne('soop')
  check('T37-E7 整表不可用那一支仍只走降级回执, 不往缺席名册里塞人', out().length === out6 && world.logs.some((l) => /降级探针回执/.test(l)), `条数=${out().length}`)
}

// ============ T38 预取泵的两道新闸: Panda 自己的风控账 + 出队时重判"还在播吗" ============
console.log('\n■ T38-A Panda 预取泵看 api.riskCooling() 收手(旧写法这条泵对风控完全失明)')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  db.anchors = [mkAnchor('p1', { isLive: true }), mkAnchor('p2', { isLive: true })]
  api.riskUntil = Date.now() + 60_000 // 账在 api 上: 用户那一发或重铸那一发撞过风控
  watcher.enqueuePrewarm('pandalive', 'p1')
  watcher.enqueuePrewarm('pandalive', 'p2')
  await waitUntil(() => !watcher.prewarmPumping.pandalive, 2000)
  check('T38-A1 冷却期整条队列收手(预取买的是 8~10 发链, 正是冷却期最不该重发的形状)', playCount('p1') === 0 && playCount('p2') === 0, `p1=${playCount('p1')}`)
  check('T38-A2 收手是清队而不是留着慢慢发: 与 SOOP 那一条同规约', watcher.prewarmQueue.pandalive.length === 0)
  api.riskUntil = 0
  watcher.enqueuePrewarm('pandalive', 'p1')
  const ok = await waitUntil(() => playCount('p1') > 0, 3000)
  check('T38-A3 账一撤就恢复: 冷却期过了照常秒开, 不是永久哑火', ok)
}

console.log('\n■ T38-B 出队时重判在播: 排空要几分钟, 泵到达时场次早已散的房不再为其拉整条链')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  db.anchors = [mkAnchor('k1', { isLive: true }), mkAnchor('k2', { isLive: true }), mkAnchor('k3', { isLive: true })]
  watcher.prewarmQueue.pandalive = ['k1', 'k2', 'k3']
  db.anchors.find((a) => a.userId === 'k2').isLive = false // 排队之后、泵到达之前这一间下了播
  void watcher.pumpPrewarm('pandalive')
  const done = await waitUntil(() => !watcher.prewarmPumping.pandalive, 5000)
  check('T38-B1 已下播的那一间零发(实测 22 发整页全回 offline=true = 100% 白付)', playCount('k2') === 0, `k2=${playCount('k2')}`)
  check('T38-B2 在播的两间照旧拿到源(跳过只针对掉线者)', done && playCount('k1') === 1 && playCount('k3') === 1, `k1=${playCount('k1')} k3=${playCount('k3')}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  db.anchors = [mkAnchor('m1', { isLive: true })]
  watcher.prewarmQueue.pandalive = ['m1', 'ghost'] // ghost 排进去之后被取关(不在关注表里)
  void watcher.pumpPrewarm('pandalive')
  const done = await waitUntil(() => !watcher.prewarmPumping.pandalive, 5000)
  check('T38-C 取关守卫不因为这次改动而松动: 同一次查找顺手判"还在表里吗"(旧写法两条各查一遍)', done && playCount('m1') === 1 && !world.playCalls.some((c) => c.userId === 'ghost'))
}

// ============ T39 (P1-2) 间隙泵续扫游标: 快照整批替换 + shift 消费 = 队首重扫、队尾饿死 ============
console.log('\n■ T39 一轮扫不完的那一批, 下一轮要从没扫到的那一间接着扫')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  const six = Array.from({ length: 6 }, (_, i) => mkAnchor(`r${i}`, { isLive: false }))
  db.anchors = six
  world.inList = {}
  const order = (arr) => arr.map((a) => a.userId).join(',')
  const base = order(six)
  watcher.setIdleQueue([...six])
  check('T39-1 游标归零时按原序排(常态与改造前一字不差)', order(watcher.idleQueue) === base)
  void watcher.pumpIdle()
  const drained = await waitUntil(() => world.bjCalls.length === 6 && !watcher.idlePumping, 5000)
  check('T39-2 一批扫到底: 每间只记一次消费(双计会让游标一次跳两间, 等于一半关注永远扫不到)', drained && watcher.idleDrained === 6, `bj=${world.bjCalls.length} drained=${watcher.idleDrained}`)
  watcher.setIdleQueue([...six])
  check('T39-3 上一窗口扫完整批 → 游标 (0+6)%6 回原点: 取模不留越界的游标', order(watcher.idleQueue) === base)
  watcher.idleDrained = 2 // 这一窗口只扫得动两发(生产里由轮次抢先让路停下)
  watcher.setIdleQueue([...six])
  check('T39-4 下一张快照从没扫到的那一间起排: 队首 r2、队尾 r1', watcher.idleQueue[0].userId === 'r2' && watcher.idleQueue[5].userId === 'r1', order(watcher.idleQueue))
  check('T39-5 轮换不丢房: 这一批仍是那六间, 只换了起点', new Set(watcher.idleQueue.map((a) => a.userId)).size === 6)
  const heads = []
  for (let k = 0; k < 3; k++) {
    watcher.idleDrained = 2
    watcher.setIdleQueue([...six])
    heads.push(...watcher.idleQueue.slice(0, 2).map((a) => a.userId))
  }
  check('T39-6 三个"只扫得动两发"的窗口并集覆盖全部六间(旧写法是同一对房扫三遍)', new Set(heads).size === 6, heads.join(','))
  watcher.idleDrained = 4
  watcher.setIdleQueue([]) // 全员在播/列表覆盖了: 快照为空
  check('T39-7 空快照即游标归零: 不许留一枚指向不存在位置的游标', watcher.idleCursor === 0 && watcher.idleQueue.length === 0)
  watcher.setIdleQueue([...six])
  check('T39-8 空窗之后的第一批从头排(游标没被上一场的 4 发带偏)', order(watcher.idleQueue) === base)
}

// ============ T40 (C1) 冷却期那一发预言机: 退避停的是扇出面, 不是这一站最便宜的一次全场读数 ============
// 旧形态: 退避 1~15 分钟里 intervalFor 把轮距压到 30s"为了早点探到恢复", 可那 30 秒到点的一轮
// 走到 cooling 分支就 return 了 —— 探针根本没发出去过, 那句话是个开环的承诺。
// 现在: 冷却期每 5 分钟问一发 /v1/live/bookmark(1 发覆盖全部关注), 读到当场解除退避。
// 那一压撤掉了: 探测只由这一发预言机承担, 轮距在任何状态下都等于用户那一格(判据在 T53-2/T26-6)。
console.log('\n■ T40-A 登录态冷却轮: 恰好一发预言机, 读到即退场')
await reset()
login([bmLive('aaa'), bmOff('ddd')])
db.anchors = [mkAnchor('aaa', { isLive: false }), mkAnchor('ddd', { isLive: false }), mkAnchor('ggg', { isLive: true })]
world.bjMedia = { ggg: liveItem({ userId: 'ggg' }) } // 列表覆盖不到的那一间: 常态轮会为它发逐房探针
{
  const P = watcher.status.byPlatform.pandalive
  // 退避状态由 T9/T15 那条链负责造成, 这里只验证"处在退避里的一轮做什么"
  watcher.errorStreak = 2
  watcher.cooldownUntil = Date.now() + 60_000
  P.circuitOpen = true
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 2000)
  check('T40-A1 冷却轮恰好一发预言机', world.bmCalls.length === 1, `bm=${world.bmCalls.length}`)
  check('T40-A2 扇出面一条不发: 全站榜 0 页 / 逐房探针 0 / 间隙泵快照空',
    world.liveCalls.length === 0 && world.bjCalls.length === 0 && watcher.idleQueue.length === 0,
    `live=${world.liveCalls.length} bj=${world.bjCalls.length} idle=${watcher.idleQueue.length}`)
  check('T40-A3 读到即退场: 冷却作废 + 连败清零 + 熔断复位 + 正文清空',
    watcher.cooldownUntil === 0 && watcher.errorStreak === 0 && P.circuitOpen === false && P.message === '')
  check('T40-A4 读数当场落地: 在播卡点亮, 顶栏在播数取自预言机',
    db.anchors[0].isLive === true && P.liveFound === 1 && watcher.pandaOracle === 'bookmark')
  check('T40-A5 出声: 退避提前解除这件事得有痕迹(用户不必知道机制, 但要知道它什么时候解的)',
    world.logs.some((l) => /冷却期预言机读通/.test(l)))
  check('T40-A6 这一轮算"真发了请求": 顶栏「上次拉取」被推进', P.lastRoundAt > 0)
  const lr1 = P.lastRoundAt

  console.log('\n■ T40-B 问闸: 冷却未解时不到 5 分钟不再重复问(风控期最忌"每一轮都重发")')
  watcher.errorStreak = 2
  watcher.cooldownUntil = Date.now() + 10 * 60_000
  P.circuitOpen = true
  const bm1 = world.bmCalls.length
  await roundOne('pandalive')
  check('T40-B1 这一轮整轮零网络', world.bmCalls.length === bm1 && world.liveCalls.length === 0 && world.bjCalls.length === 0)
  check('T40-B2 空转轮不刷新「上次拉取」(没有新读数就不许把钟拨到刚刚)', P.lastRoundAt === lr1)
  check('T40-B3 安静但不静默: 倒计时照写、冷却账原样留着',
    String(P.message).startsWith('watcher.cooling') && watcher.cooldownUntil > Date.now())

  console.log('\n■ T40-C 窗口一过自动再问; 读不到就照旧安静(且不把预言机记成"已改走全站榜")')
  watcher.cooldownOracleAt = Date.now() - 5 * 60_000 // 伪造"上一次问已是 5 分钟前"
  world.bmStatus = 403 // 这一发仍被风控(fetchBookmarks 把 RiskError 收敛为 null)
  await roundOne('pandalive')
  check('T40-C1 窗口一过自动再问(不等退避到期): 仍是恰好一发',
    world.bmCalls.length === bm1 + 1 && world.liveCalls.length === 0 && world.bjCalls.length === 0)
  check('T40-C2 读不到 = 什么都不改: 冷却不解禁、熔断不解除、预言机不背锅改口',
    watcher.cooldownUntil > Date.now() && P.circuitOpen === true && watcher.pandaOracle === 'bookmark')
  check('T40-C3 问闸在"读不到"这一支同样落下: 下一次要等满 5 分钟(这一发已经打过平台了)',
    watcher.cooldownOracleAt > Date.now() - 60_000)
}

console.log('\n■ T40-D 匿名态: 那一发注定换回 result:false, 冷却轮整轮零请求(既有链路不变)')
await reset()
db.anchors = [mkAnchor('kk', { isLive: false })]
{
  const P = watcher.status.byPlatform.pandalive
  P.lastRoundAt = 0
  watcher.cooldownUntil = Date.now() + 60_000
  await roundOne('pandalive')
  check('T40-D1 没会话罐: 预言机与那一问都不发, 扇出面照旧停',
    world.bmCalls.length === 0 && world.liCalls.length === 0 && world.liveCalls.length === 0 && world.bjCalls.length === 0)
  check('T40-D2 空转轮不记时, 但倒计时照写(盲区可以存在, 不许静默)',
    P.lastRoundAt === 0 && String(P.message).startsWith('watcher.cooling'))
}

// ============ T41 (C4) 手工添加的离线房当场进间隙泵(旧写法要等下一轮才被快照收走) ============
console.log('\n■ T41 trackIdle: 用户刚点"添加"的那一间排到队首, 守卫一条不松')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  const { roomKey } = loadTs('src/shared/types.ts')
  db.anchors = [mkAnchor('t1'), mkAnchor('t2'), mkAnchor('t3'), mkAnchor('t4', { isLive: true }), mkAnchor('gone'), mkAnchor('t1', { platform: 'soop' })]
  watcher.bjGone.add(roomKey('pandalive', 'gone')) // 先立"查无此人"的那本账
  watcher.idlePumping = true // 举着泵: 队列留在手里可查, 放闸后按序消费
  watcher.setIdleQueue([db.anchors[1], db.anchors[2]]) // 常态快照: t2、t3
  const q0 = watcher.idleQueue.length
  watcher.trackIdle('pandalive', 't1')
  check('T41-1 新添加的离线房进队且排到队首(它排在队尾 = 几百间长队之后再等一次)',
    watcher.idleQueue.length === q0 + 1 && watcher.idleQueue[0].userId === 't1', watcher.idleQueue.map((a) => a.userId).join(','))
  watcher.trackIdle('pandalive', 't1')
  check('T41-2 重复惊动不加队(连点两次"添加"不该多发一发探针)', watcher.idleQueue.filter((a) => a.userId === 't1' && a.platform === 'pandalive').length === 1)
  watcher.trackIdle('pandalive', 't4')
  watcher.trackIdle('pandalive', 'gone')
  watcher.trackIdle('pandalive', 'nope')
  watcher.trackIdle('soop', 't1')
  check('T41-3 四条守卫一条不松: 已在播/查无此人/表里没有/SOOP 无间隙泵 —— 各自不进队',
    !watcher.idleQueue.some((a) => a.userId === 't4' || a.userId === 'gone' || a.userId === 'nope') &&
      !watcher.idleQueue.some((a) => a.platform === 'soop'))
  check('T41-4 同号双平台不串味: 队首那间是 Panda 的记录(找房按 (platform,userId) 复合键)',
    watcher.idleQueue[0].platform === 'pandalive' && watcher.idleQueue[0] === db.anchors[0])
  watcher.idlePumping = false
  void watcher.pumpIdle()
  const done = await waitUntil(() => world.bjCalls.length === 3 && !watcher.idlePumping, 5000)
  check('T41-5 放闸后按序消费: 用户刚加的那一间第一个被探针(下一轮它本来也要被扫, 多花的只是时刻不是次数)',
    done && world.bjCalls.map((c) => c.userId).join(',') === 't1,t2,t3', world.bjCalls.map((c) => c.userId).join(','))
}

// ============ T42 (C8) 自录房排到预取队首: 队列排空要几分钟, 录制不能自己等一整轮泵 ============
console.log('\n■ T42 预取排队顺序: autoRecord 那一间第一个拿到源(请求数一字不减, 只是排得更早)')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  db.anchors = [mkAnchor('c1', { isLive: true }), mkAnchor('c2', { isLive: true, autoRecord: true }), mkAnchor('c3', { isLive: true })]
  watcher.prewarmPumping.pandalive = true // 举着泵看排队, 放闸看消费顺序
  watcher.enqueuePrewarm('pandalive', 'c1')
  watcher.enqueuePrewarm('pandalive', 'c3')
  watcher.enqueuePrewarm('pandalive', 'c2')
  check('T42-1 自录房插到队首, 其余按到队顺序(不是"自录优先"整条重排)',
    watcher.prewarmQueue.pandalive.join(',') === 'c2,c1,c3', watcher.prewarmQueue.pandalive.join(','))
  watcher.enqueuePrewarm('pandalive', 'c2')
  check('T42-2 去重仍在插队之前: 重复入队不产生第二个 c2', watcher.prewarmQueue.pandalive.join(',') === 'c2,c1,c3')
  watcher.prewarmPumping.pandalive = false
  void watcher.pumpPrewarm('pandalive')
  const done = await waitUntil(() => world.playCalls.length === 3 && !watcher.prewarmPumping.pandalive, 5000)
  check('T42-3 放闸后自录房第一个被拉源(泵是 shift 队首, 插队即生效)',
    done && world.playCalls.map((c) => c.userId).join(',') === 'c2,c1,c3', world.playCalls.map((c) => c.userId).join(','))
}

// ============ T43 (C2) Panda 零关注早退: 没有东西可失明, 连退避时间戳一起作废 ============
console.log('\n■ T43 零关注的 Panda 一轮: 不翻全站榜, 也不留旧冷却')
await reset()
db.anchors = [mkAnchor('s43', { platform: 'soop', isLive: false })] // 只有 SOOP 关注: Panda 那一格为空
{
  const P = watcher.status.byPlatform.pandalive
  watcher.errorStreak = 2
  watcher.cooldownUntil = Date.now() + 60_000
  P.circuitOpen = true
  P.message = 'watcher.circuit'
  await roundOne('pandalive')
  check('T43-1 匿名态零关注: 全站榜/逐房/预言机全零(旧写法这一轮照样翻满五页, 一个读数都不为谁而读)',
    world.liveCalls.length === 0 && world.bjCalls.length === 0 && world.bmCalls.length === 0)
  check('T43-2 退避账一并作废(否则日后加回关注会被上一场的旧冷却闷住)',
    watcher.cooldownUntil === 0 && watcher.errorStreak === 0 && P.circuitOpen === false && P.message === '')
  check('T43-3 读数归位: 监控数 0 / 在播 0', P.monitored === 0 && P.liveFound === 0)

  await reset()
  login([bmOff('zz')])
  db.anchors = []
  await roundOne('pandalive')
  check('T43-4 登录态零关注同样整轮零请求(早退在预言机上游: 不为空表发那一发)',
    world.bmCalls.length === 0 && world.liveCalls.length === 0 && world.liCalls.length === 0)
}

// ============ T44 + Panda 风控冷却期的扇出面: 只发那一发预言机, 其余收手且出声 ============
// 这一本账分成两格之后, 能拨动轮次扇出的只有"整表那一发亲口被拒"那一格(oracleRiskUntil)。
// 真实形状里整表那一发撞 403 会同时抬起两格(noteRisk 里 if(isOraclePath)), 所以场景也照那一次记账摆两格。
console.log('\n■ T44-A 风控冷却中且列表读不到: 一轮恰好一发, 全站榜/逐房复查一条不发')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('r1')])
world.bmResultFalse = true // 这一站在拦着: bookmark 那一发回 result:false ⇒ fetchBookmarks 收敛为 null
db.anchors = [mkAnchor('r1', { isLive: true }), mkAnchor('r2', { isLive: true })] // 两间都"在播而列表覆盖不到" = 旧写法的 urgent 源头
{
  const P = watcher.status.byPlatform.pandalive
  api.riskUntil = api.oracleRiskUntil = Date.now() + 60_000
  const log0 = world.logs.length
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T44-A1 冷却轮恰好一发(站内关注列表), 全站榜 0 页', world.bmCalls.length === 1 && world.liveCalls.length === 0, `bm=${world.bmCalls.length} live=${world.liveCalls.length}`)
  check('T44-A2 逐房 member/bj 一发不发(旧写法这一轮改打 5 页全站榜 + 逐房复查 + 间隙泵约 100 发快照 = 现场量级 ≈110 发/轮)', world.bjCalls.length === 0, `bj=${world.bjCalls.length}`)
  check('T44-A3 "被拦下"这件事从此有留痕, 且带上连续失明的轮数', world.logs.slice(log0).some((l) => /风控冷却中: 本轮只发站内关注那一发[\s\S]*连续 1 轮列表不可用/.test(l)))
  check('T44-A4 冷却轮不武装熔断、不刷退避(它只是收手, 不是失败)', watcher.errorStreak === 0 && watcher.cooldownUntil === 0 && P.circuitOpen === false)
  // 收手这件事过去只在日志里, 顶栏那一格说的是"空闲" —— 现场那 40 分钟无人知情
  check('T44-A4b 收手轮的界面那一格要说"在逐房问"并且归因(降级旗 + 那句带轮数的话)',
    P.degraded === true && String(P.message).startsWith('watcher.degradeHold') && /"n":1/.test(String(P.message)), `msg=${P.message} degraded=${P.degraded}`)
  const log1 = world.logs.length
  await roundOne('pandalive')
  check('T44-A5 第二轮照旧一发且轮数累加(5 分钟窗口内每一轮都只问这一发, 不是只收手一轮)',
    world.bmCalls.length === 2 && world.liveCalls.length === 0 && world.logs.slice(log1).some((l) => /连续 2 轮列表不可用/.test(l)))
  api.riskUntil = api.oracleRiskUntil = 0 // 撤账: 冷却窗口过了(两格一起撤, 与 noteRisk 那一次记账对称)
  world.bjMedia = { r1: liveItem({ userId: 'r1' }), r2: liveItem({ userId: 'r2' }) }
  const log2 = world.logs.length
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T44-A6 撤账当轮立刻回落全站榜那条链(5 页 + 两间逐房复查), 时效不因收手而变慢',
    world.liveCalls.length > 0 && world.bjCalls.length >= 2, `live=${world.liveCalls.length} bj=${world.bjCalls.length}`)
  check('T44-A7 降级轮的扇出面有数可核: 连续轮数 + 逐房发数 + 间隙泵快照量都在那一格里',
    world.logs.slice(log2).some((l) => /降级轮留痕: 站内关注列表连续 3 轮不可用, 本轮逐房复查 2 发/.test(l)),
    world.logs.slice(log2).filter((l) => /降级轮/.test(l)).join(' | '))
  check('T44-A7b 那一格同样把降级轮的账说给用户(不是只说风控收手那一格): 归因取自客户端已有读数, 一发不新增',
    P.degraded === true && String(P.message).startsWith('watcher.degraded') && /degradeRefused/.test(String(P.message)) && world.liCalls.length === 0,
    `msg=${P.message} degraded=${P.degraded}`)
  world.bmResultFalse = false // 列表读通了
  const log3 = world.logs.length
  await roundOne('pandalive')
  check('T44-A8 读通当轮失明账本归零(那句"连续 N 轮"必须是本会话的真实长度)', watcher.pandaBlindStreak === 0)
  check('T44-A8b 读通当轮把降级旗与那一行一起摘掉: 顶栏不许停在上一场的状态', P.degraded === false && P.message === '')
  check('T44-A9 常态轮不出降级留痕, 也不报风控冷却: 两句都只在各自的形状里出声',
    !world.logs.slice(log3).some((l) => /降级轮留痕|风控冷却中/.test(l)))
}

console.log('\n■ T44-B 间隙泵同看这一本账, 但只停脚不清队')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [mkAnchor('i1', { isLive: false }), mkAnchor('i2', { isLive: false })]
{
  watcher.idleQueue = db.anchors.slice()
  api.oracleRiskUntil = Date.now() + 60_000 // 这一泵读的是整表那一格, 与轮次同进同退
  await watcher.pumpIdle()
  check('T44-B1 冷却期间隙泵零请求(轮次收手而它照发 = 只收了一半)', world.bjCalls.length === 0, `实发=${world.bjCalls.length}`)
  check('T44-B2 快照原样留着: 等的只是 5 分钟, 不是整轮重排(与熔断那条清队不同)', watcher.idleQueue.length === 2)
  api.oracleRiskUntil = 0
  await watcher.pumpIdle()
  check('T44-B3 撤账后同一份快照照扫到(收手不是永久哑火)', world.bjCalls.length === 2 && watcher.idleQueue.length === 0, `实发=${world.bjCalls.length}`)
}

// ============ T45 SOOP 连续失明第 3 轮起: 预取不为"手上没有场次号"的房买整页 ============
console.log('\n■ T45-A 失明第 3 轮: 有号的房照旧秒开, 没号的房排回队尾不作废')
await reset()
db.settings.monitor.soop.requestGapMs = 0
db.anchors = [mkAnchor('b1', { platform: 'soop', isLive: true }), mkAnchor('b2', { platform: 'soop', isLive: true })]
{
  watcher.soopBlindStreak = 3
  world.soopBno = { b2: Date.now() } // b2 的号在账上(列表整表或某一次真读到的页面写过)
  watcher.prewarmQueue.soop = ['b1', 'b2']
  await watcher.pumpPrewarm('soop')
  const got = world.soopCalls.filter((c) => c.startsWith('getPlayCached:'))
  check('T45-A1 有号的 b2 照常预取, 没号的 b1 一发没买(它要的那一发是整页 HTML, 而这正与检测面同一页)',
    got.join(',') === 'getPlayCached:b2', got.join(','))
  check('T45-A2 跳过=排回队尾而不是作废: 探针读到号以后它照拿秒开, 只是晚一场', watcher.prewarmQueue.soop.join(',') === 'b1', watcher.prewarmQueue.soop.join(','))
  check('T45-A3 泵自己放下标志(不留下跨场死锁)', watcher.prewarmPumping.soop === false)

  await reset()
  db.settings.monitor.soop.requestGapMs = 0
  db.anchors = [mkAnchor('b1', { platform: 'soop', isLive: true }), mkAnchor('b2', { platform: 'soop', isLive: true })]
  watcher.soopBlindStreak = 2 // 未到门槛: 一轮抖动不该把秒开关掉一整场
  watcher.prewarmQueue.soop = ['b1', 'b2']
  await watcher.pumpPrewarm('soop')
  check('T45-A4 失明未到 3 轮时两间都预取(闸只看连续轮数这一格)',
    world.soopCalls.filter((c) => c.startsWith('getPlayCached:')).length === 2, `实发=${world.soopCalls.filter((c) => c.startsWith('getPlayCached:')).length}`)
}

console.log('\n■ T45-B 检测面一发不少 + 整条队列都没号时出泵')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null // 列表整条不接待 = 失明那一形状
db.anchors = [mkAnchor('c1', { platform: 'soop', isLive: false }), mkAnchor('c2', { platform: 'soop', isLive: false })]
for (const a of db.anchors) world.soopMeta[a.userId] = { living: false, explicitOffline: true }
{
  watcher.soopBlindStreak = 3
  const sent0 = soopSent().length
  await roundOne('soop')
  check('T45-B1 逐房整页探针仍两间各一发: 这一面就是检测路径, 压它等于拿开播时效换流量(这一格一字不动)',
    soopSent().length - sent0 === 2, `实发=${soopSent().length - sent0}`)
  await reset()
  db.settings.monitor.soop.requestGapMs = 0
  db.anchors = [mkAnchor('c1', { platform: 'soop', isLive: true })]
  watcher.soopBlindStreak = 3
  watcher.prewarmQueue.soop = ['c1'] // 整条队列都是"没号"这一形状
  const done = await Promise.race([watcher.pumpPrewarm('soop').then(() => true), sleep(4000).then(() => false)])
  check('T45-B2 队列里没有一件可买时出泵而不是原地空转(shift/push 会把这一趟变成死循环)', done === true)
  check('T45-B3 仍然不作废: 那一间还在队里等下一趟', watcher.prewarmQueue.soop.join(',') === 'c1')
}

// ============ T47 那本风控账分成两格: 逐房那一句话只抬总账, 整表那一句话两格一起抬 ============
// 现场实拍: bj 与 play 双双回 HTTP 200 + 「너무 많은 요청이 발생했습니다」, 而旧账本只认 403/429/≥500/HTML/非 JSON
// ⇒ 平台亲口喊停的那一刻, 客户端的自闭环完全看不见。收下这句话之后新的问题是"它该管到哪一面":
// 总账管后台的便利面(预取 2~6 发链、保活重铸), 整表格只管"整表那一发亲口被拒"的轮次扇出 ——
// 把逐房那一发的失败也算到检测头上, 就是拿开播时效换流量(用户 2026-10-03 拍板: 只把账说出来, 不减发)
console.log('\n■ T47-A 逐房那一发亲口喊限流: 记总账, 但不许顶掉检测面')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('e1')])
world.bmResultFalse = true // 整表读不到(但不是限流那句话) ⇒ 这一轮本该走扇出那条检测链
db.anchors = [mkAnchor('e1', { isLive: true }), mkAnchor('e2', { isLive: true })]
{
  world.bjMsg = { e1: '너무 많은 요청이 발생했습니다.' }
  let threw = ''
  try {
    await api.fetchBj('e1')
  } catch (e) {
    threw = String(e?.message || e)
  }
  world.bjMsg = {} // 只演那一发, 后面那一轮要的是正常的检测链
  check('T47-A1 那句"200 + 业务码里的一句话"从此有账(旧账本只读状态码 ⇒ 一条都不记)', threw !== '' && api.riskCooling(), `抛回=${threw}`)
  check('T47-A2 但它只抬总账: 整表那一格没被逐房那一发顶掉', !api.oracleRiskCooling())
  const live0 = world.liveCalls.length
  const bj0 = world.bjCalls.length
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T47-A3 总账 armed 的下一轮: 全站榜与逐房复查一条不少(把检测面闷掉 = 把开播发现延迟记进风控账)',
    world.liveCalls.length > live0 && world.bjCalls.length > bj0, `live=${world.liveCalls.length - live0} bj=${world.bjCalls.length - bj0}`)
  watcher.enqueuePrewarm('pandalive', 'e2')
  await waitUntil(() => !watcher.prewarmPumping.pandalive, 3000)
  check('T47-A4 而后台那一条便利面照旧收手: 整条队列清空、0 发拉源(它买的是"秒开", 没有人在等)',
    playCount('e2') === 0 && watcher.prewarmQueue.pandalive.length === 0, `play=${playCount('e2')}`)
}

console.log('\n■ T47-B 整表那一发亲口喊限流: 两格一起抬, 下一轮扇出面真的收手')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('f1')])
world.bmResultFalse = true
world.bmFalseMsg = '너무 많은 요청이 발생했습니다.' // 同一句"读不到", 换成平台亲口喊停的那一版
db.anchors = [mkAnchor('f1', { isLive: true })]
{
  const rows = await api.fetchBookmarks()
  check('T47-B1 关注列表回 null 的契约一字没动(记账不许改变调用方看到的东西)', rows === null)
  check('T47-B2 整表那一发被限流: 总账与整表格一起抬(noteRisk 里那一句 if(isOraclePath))', api.riskCooling() && api.oracleRiskCooling())
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  await waitUntil(() => !watcher.idlePumping, 3000)
  check('T47-B3 于是下一轮真的收手: 只补问站内关注那一发, 全站榜/逐房复查/间隙泵 0 发',
    world.bmCalls.length === bm0 + 1 && world.liveCalls.length === 0 && world.bjCalls.length === 0,
    `bm=${world.bmCalls.length - bm0} live=${world.liveCalls.length} bj=${world.bjCalls.length}`)

  await reset()
  login([bmOff('f2')])
  world.bmResultFalse = true // 默认那句「로그인이 필요합니다」= 未登录/改版那两种读不到
  db.anchors = [mkAnchor('f2', { isLive: true })]
  await roundOne('pandalive')
  check('T47-B4 但"未登录/改版"那两种读不到根本不进这本账: 死会话期的逐房复查正是检测路径本身, 那句话不是平台在喊停',
    !api.riskCooling() && !api.oracleRiskCooling() && world.liveCalls.length > 0, `live=${world.liveCalls.length}`)
}

console.log('\n■ T47-C 拉源那一发是第三个出口: 记总账, 返回契约原样')
await reset()
db.anchors = [mkAnchor('g1', { isLive: true })]
{
  world.playMsg = { g1: '너무 많은 요청이 발생했습니다.' }
  const r = await api.fetchPlay('g1')
  check('T47-C1 拉源撞限流从此有账, 而调用方看到的还是那一句原文(ok:false + error=平台那句话)',
    r.ok === false && api.riskCooling() && /너무/.test(String(r.error)), `error=${r.error}`)
  check('T47-C2 它同样只抬总账: 拉源是后台便利面, 不该把检测面一起闷掉', !api.oracleRiskCooling())
}

// ============ T48 预取泵认那张"正等第二轮确认下播"的表: 排队与出队两头都挡, 检测面一发不少 ============
console.log('\n■ T48-A 排队那一头: 预言机刚报它这一场散了, 就不为它排一整条取源链')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  db.anchors = [mkAnchor('h1', { isLive: true }), mkAnchor('h2', { isLive: true })]
  db.anchors[0].offlinePendingAt = Date.now() // 刚报下播, 还差第二轮确认(状态尚未翻转; 那一格落在行上)
  check('T48-A1 入队即挡(现场实拍: 首轮后补扫 22 发整页, 读数全部 offline=true = 100% 白付)',
    watcher.enqueuePrewarm('pandalive', 'h1') === false && watcher.prewarmQueue.pandalive.length === 0)
  watcher.enqueuePrewarm('pandalive', 'h2')
  const ok = await waitUntil(() => playCount('h2') > 0 && !watcher.prewarmPumping.pandalive, 5000)
  check('T48-A2 那张表里没写的房照旧排队照拿源: 闸门只认这一句, 不顺手关掉别的', ok && playCount('h1') === 0)

  console.log('\n■ T48-B 出队那一头: 排队之后才报下播的房不买, 且排回队尾不作废')
  await reset()
  db.settings.monitor.pandalive.requestGapMs = 0
  {
    db.anchors = [mkAnchor('h1', { isLive: true }), mkAnchor('h2', { isLive: true })]
    watcher.prewarmQueue.pandalive = ['h1', 'h2'] // 排队那一刻两间都还在播(P2-1 那一格放行)
    db.anchors[0].offlinePendingAt = Date.now() // 队列排空要几分钟, 中途预言机报了 h1 散场
    void watcher.pumpPrewarm('pandalive')
    const done = await waitUntil(() => !watcher.prewarmPumping.pandalive, 5000)
    check('T48-B1 泵到达时才报下播的那一间零发(队列是排队那一刻的快照, 中间会变)', playCount('h1') === 0)
    check('T48-B2 在播的那一间照旧拿到源', done && playCount('h2') === 1, `h2=${playCount('h2')}`)
    check('T48-B3 跳过=排回队尾而不是作废(与 D88a 同规约): 瞬回离线的抖动不该把秒开永久摘掉',
      watcher.prewarmQueue.pandalive.join(',') === 'h1', watcher.prewarmQueue.pandalive.join(','))
    check('T48-B4 整条队列都在等确认时出泵, 不许 shift/push 原地空转', watcher.prewarmPumping.pandalive === false)
    db.anchors[0].offlinePendingAt = 0 // 第二轮真读回在播: 那一格一清
    void watcher.pumpPrewarm('pandalive')
    const back = await waitUntil(() => playCount('h1') > 0, 5000)
    check('T48-B5 账一撤下一趟泵照买(收手只到那一句话被下一发读数推翻为止)', back)
  }
}

console.log('\n■ T48-C 检测面一发不少: 预取跳过的那一间照样被逐房探针读到, 下播判定不被拖慢')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = null // 整表不接待 ⇒ 全部关注走逐房整页探针(检测路径)
db.anchors = [mkAnchor('c1', { platform: 'soop', isLive: true })]
world.soopMeta = { c1: { living: false, explicitOffline: true } }
{
  const sent0 = soopSent().length
  await roundOne('soop') // 第一轮报下播 → 只在锚点行上记那一格, 不翻转状态
  check('T48-C1 这一间现在正等第二轮确认(那一格写的就是这一句, 而且它在行上、不在内存里)',
    pendingAt('c1', 'soop') > 0 && db.anchors[0].isLive === true, `pending=${pendingAt('c1', 'soop')}`)
  await soopPump(['c1'])
  check('T48-C2 预取那一头两发都不给(入队挡 + 出队也挡)',
    world.soopCalls.filter((c) => c === 'getPlayCached:c1').length === 0 && watcher.prewarmQueue.soop.join(',') === 'c1',
    watcher.prewarmQueue.soop.join(','))
  await roundOne('soop')
  check('T48-C3 而检测面那一发照发 —— 下播判定要的就是这第二发读数, 预取无权替它收手',
    soopSent().length - sent0 === 2, `实发=${soopSent().length - sent0}`)
  check('T48-C4 第二发到 → 当场判下播并翻状态(闸门挡在中间, 一分钟时效都没多花)',
    db.anchors[0].isLive === false && world.toasts.some((t) => t.type === 'offline'))
}

// ============ T49 失明判据改口: 整表读通了而我的关注一个都不在里面, 从此也算失明 ============
// 旧判据 rows===null 只说"接口没回东西", 而现场更常见的形状是"接口回了一整表, 但那一整表里没有我的人"
// (应用内关注 ≠ 站内关注) ⇒ blind 恒 0, 那道预取闸门从不落地。只改判据, 不减一发。
console.log('\n■ T49 整表读通却不覆盖我的关注: 三轮记到 3, 那道既有闸门才第一次落地')
await reset()
db.settings.monitor.soop.requestGapMs = 0
world.soopFavorites = [{ userId: 'zz-other', isLive: false, nick: '', lastStartTime: '' }] // 整表读得通, 一个我的关注都没有
db.anchors = [mkAnchor('m1', { platform: 'soop', isLive: false }), mkAnchor('m2', { platform: 'soop', isLive: false })]
for (const a of db.anchors) world.soopMeta[a.userId] = { living: false, explicitOffline: true }
{
  for (let r = 1; r <= 3; r++) await roundOne('soop')
  check('T49-1 这一形状旧写法永远记 0(判据读的是"有没有列表"而不是"列表对我覆盖了几房")', watcher.soopBlindStreak === 3, `blind=${watcher.soopBlindStreak}`)
  check('T49-2 检测面一轮不减: 三间次各两发整页 = 六发, 与改判前后一字不差', soopSent().length === 6, `实发=${soopSent().length}`)
  check('T49-3 留痕每一轮都在, 且那句话改口成实话(说"列表不可用"会在整表读通时撒谎)',
    world.logs.filter((l) => /降级探针回执/.test(l)).length === 3 &&
      /关注列表已连续 3 轮没覆盖到我的关注/.test(world.logs.filter((l) => /降级探针回执/.test(l)).pop() || ''))
  db.anchors.push(mkAnchor('m3', { platform: 'soop', isLive: true })) // 卡片说它在播, 而我手上没有它的场次号
  await soopPump(['m3'])
  check('T49-4 连续第 3 轮起, 那道"没有场次号就不买整页"的闸门第一次真落地(旧写法从不落地)',
    world.soopCalls.filter((c) => c === 'getPlayCached:m3').length === 0 && watcher.prewarmQueue.soop.join(',') === 'm3',
    `买页=${world.soopCalls.filter((c) => c === 'getPlayCached:m3').length}`)
  world.soopFavorites = db.anchors.map((a) => ({ userId: a.userId, isLive: false, nick: '', lastStartTime: '' }))
  await roundOne('soop')
  check('T49-5 列表覆盖到我的关注当轮: 账本归零, 闸门跟着开(那句"连续 N 轮"只读本会话的真实长度)',
    watcher.soopBlindStreak === 0)
  // m3 在这一轮被列表报了"不在播", 从此归那张"待第二轮确认"的表管(T48 已单独取证那一面);
  // 这里要验的是"失明闸门跟着账本一起开", 所以换一间同样手上没号、只是没被报过下播的房
  db.anchors.push(mkAnchor('m4', { platform: 'soop', isLive: true }))
  await soopPump(['m4'])
  check('T49-6 归零后同一形状(手上没场次号)的房照买: 那道闸门只跟着连续失明轮数走, 失明期一结束秒开立刻回来',
    world.soopCalls.filter((c) => c === 'getPlayCached:m4').length === 1,
    `买页=${world.soopCalls.filter((c) => c === 'getPlayCached:m4').length}`)
}

// ============ T50 那一行的三种归因: 全用客户端已有读数, 为归因再发一发就是新增请求面 ============
console.log('\n■ T50 降级轮界面上那句"为什么在逐房问": 未登录 / 会话被服务端作废 两条各说一句, 且一发不新增')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [mkAnchor('a50', { isLive: true })]
world.bmResultFalse = true
{
  const P = watcher.status.byPlatform.pandalive
  // ① 匿名: 罐里就没有 sessKey
  await roundOne('pandalive')
  check('T50-1 没登录就说没登录(界面那一行的归因直接读 jar, 且旗要跟着举起来)',
    P.degraded === true && String(P.message).startsWith('watcher.degraded') && /degradeNoLogin/.test(String(P.message)) && world.liCalls.length === 0, `msg=${P.message} degraded=${P.degraded}`)

  // ② 罐在而官方校验不认 —— 现场挂了 40 分钟那一形状(cookie=30 枚 会话=有 官方校验=未登录)
  await reset()
  db.settings.monitor.pandalive.requestGapMs = 0
  db.anchors = [mkAnchor('a50', { isLive: true })]
  world.bmResultFalse = true
  api.jar = { sessKey: 't50' }
  api.cookieValid = false
  world.loginInfo = { userInfo: { isLogin: false } } // 官方那一问答"没登录", 于是"没证明"不会被自证清掉
  world.liveLoginInfo = false // 全站榜响应里那句 loginInfo 也会替它说话: 关掉才留得住"罐在而不被认"这一形状
  await roundOne('pandalive')
  const li1 = world.liCalls.length
  await roundOne('pandalive')
  check('T50-2 罐在而服务端不认这一枚: 归因说"会话已失效"而不是含糊一句',
    /degradeSessionDead/.test(String(P.message)) && P.degraded === true, `msg=${P.message}`)
  check('T50-3 归因本身零请求: 那一句用的是 login_info 已经答过的那一格(第二轮没有再问一遍)',
    world.liCalls.length === li1 && li1 === 1, `li=${world.liCalls.length}`)
  check('T50-4 持续说话: 第二轮那一行还在(现场那 40 分钟无人知情, 就是因为它在每一轮都沉默)',
    String(P.message).startsWith('watcher.degraded') && P.degraded === true)

  // ③ 读通当轮摘旗: 降级旗与那一行同一个来源(下面那条"摘掉"的不落空前提, 是 T50-2/T50-4 已当场核过旗确实举着)
  world.bm = [bmOff('a50')]
  world.bmResultFalse = false
  world.loginInfo = { userInfo: { isLogin: true } }
  api.cookieValid = true
  await roundOne('pandalive')
  check('T50-5 列表读通那一轮把旗与那一行一起摘(顶栏停在上一场的状态 = 绿点骗人的另一种写法)',
    P.degraded === false && P.message === '' && world.liCalls.length === li1, `msg=${P.message} degraded=${P.degraded}`)
}

// ============ T51 冷启动留下的旧账: 陈旧基线第一轮就翻状态, 但不发那场"下播" ============
// 现场实拍 2026-10-03 14:05: 醒来第一轮读到 153 张 isLive=true 的卡, 而它们的 lastSeenAt 停在应用关掉的那一刻。
// 旧写法每张都要走完两轮规则才肯翻假 ⇒ 真下播的读数要再等一个轮距(默认 120s)才落地,
// 而多等的那一轮买不到任何新读数(平台这一发本来就报的是离线), 只买到一次把旧账当现值的下播通知。
console.log('\n■ T51 陈旧基线第一轮翻离线: 状态翻/通知不发/一发不加, 而新基线的两轮防抖一条不减')
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60 // 阈值 = 2 个轮距 = 120 秒
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('s1')])
db.anchors = [mkAnchor('s1', { isLive: true, title: '旧标题', lastSeenAt: Date.now() - 30 * 60_000 })]
{
  await api.getPlayCached('s1') // 卡上挂着冷启动留下的"秒开"徽标
  const play0 = playCount('s1')
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  check('T51-1 陈旧基线遇到第一轮离线读数即翻状态(旧写法要再等一个轮距)',
    db.anchors[0].isLive === false && db.anchors[0].title === '' && db.anchors[0].lastSeenAt > 0, `isLive=${db.anchors[0].isLive}`)
  check('T51-2 不发下播通知: 那场散于应用停摆期间, 我们根本没在场', world.toasts.filter((t) => t.type === 'offline').length === 0, JSON.stringify(world.toasts.map((t) => t.type)))
  check('T51-3 旧源当场作废(留着死源骗徽标, 点播放必暴毙)', playCount('s1') === play0 + 0 && (await api.getPlayCached('s1'), playCount('s1') === play0 + 1), `play=${playCount('s1')}`)
  check('T51-4 判这一件事用的还是那一发整表: 零增量请求', world.bmCalls.length - bm0 === 1 && world.bjCalls.length === 0, `bm+${world.bmCalls.length - bm0} bj=${world.bjCalls.length}`)
  check('T51-5 那一格当场收账(翻了就不该再排第二轮, 预取泵也不为该房白挡; 它现在落在行上, 不写 0 就是把旧账留在盘上)',
    db.anchors[0].offlinePendingAt === 0, `pendingAt=${db.anchors[0].offlinePendingAt}`)
  check('T51-6 留痕出声: 日志里那句要写明"不发下播通知"的原因', world.logs.some((l) => /陈旧基线首轮翻离线/.test(String(l))), JSON.stringify(world.logs.slice(-3)))
}
await reset()
console.log('\n■ T51b 真机回读追出来的一条: 散场那一翻顺手把两本门槛账一起撤掉(@moem9e9 那 22 小时的老账就是这么消失的, 屏上撤得干净才对)')
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('s1b')])
db.anchors = [mkAnchor('s1b', { isLive: true, lastSeenAt: Date.now() - 30 * 60_000 })]
{
  world.playGate.s1b = 'needCoinPurchase'
  await api.getPlayCached('s1b') // 先挂上一道门槛: 内存 + 盘各一格, 同一到期时刻
  const before = playCount('s1b')
  const bm0 = world.bmCalls.length
  check('T51b-0 前置成立: 散场之前这间确实挂着门槛账(内存有格、盘上有码且 15 分钟后到期)', api.gates.has('s1b') && db.anchors[0].gateCode === 'needCoinPurchase' && db.anchors[0].gateUntil - Date.now() < 16 * 60_000, JSON.stringify([api.gates.has('s1b'), db.anchors[0].gateCode, ((db.anchors[0].gateUntil - Date.now()) / 60_000).toFixed(1)]))
  await roundOne('pandalive')
  check('T51b-1 翻离线把两本账一起撤(invalidatePlay 那一条路的后果, ⑫表里当场消失, 下一次开播照旧重问一发)', !api.gates.has('s1b') && !db.anchors[0].gateCode && db.anchors[0].gateUntil === 0, JSON.stringify([api.gates.has('s1b'), db.anchors[0].gateCode, db.anchors[0].gateUntil]))
  check('T51b-2 撤账一发不多: 判离线用的还是那一发整表, 没有为门槛再敲一次', playCount('s1b') === before && world.bmCalls.length === bm0 + 1, `play=${playCount('s1b') - before} bm+${world.bmCalls.length - bm0}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('s2')])
db.anchors = [mkAnchor('s2', { isLive: true, lastSeenAt: Date.now() })]
{
  // 对照组(豁免只给"证明得了陈旧"那一支): 刚刚才被读过的卡, 同一句读数仍走两轮
  await roundOne('pandalive')
  check('T51-7 新基线照旧两轮防抖: 第一轮不动、只记账(瞬回离线的抖动仍拦得住)',
    db.anchors[0].isLive === true && pendingAt('s2') > 0 && world.toasts.filter((t) => t.type === 'offline').length === 0,
    `pendingAt=${db.anchors[0].offlinePendingAt}`)
  await roundOne('pandalive')
  check('T51-8 第二轮才翻, 且那一次通知照发(它真是我们看着散的那场), 账随即销掉',
    db.anchors[0].isLive === false && db.anchors[0].offlinePendingAt === 0 && world.toasts.filter((t) => t.type === 'offline').length === 1,
    `pendingAt=${db.anchors[0].offlinePendingAt} toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('s3')])
db.anchors = [mkAnchor('s3', { isLive: true, lastSeenAt: 0 })]
{
  // 第三组: lastSeenAt=0(旧库/从没写过) 证不出"它旧", 于是不豁免 —— 走的仍是预言机那一条两轮规则
  await roundOne('pandalive')
  check('T51-9 lastSeenAt=0 不算陈旧: 证不出来就维持两轮, 宁可晚一轮也不凭猜静默摘掉一场',
    db.anchors[0].isLive === true && pendingAt('s3') > 0 && world.toasts.length === 0,
    `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [mkAnchor('s4', { isLive: true, lastSeenAt: Date.now() - 30 * 60_000 })]
world.bjMedia = { s4: null }
{
  // 第四条读数面(逐房 member/bj, applyBj 原本第一轮就宣判): 同样只免通知, 不免翻转
  const live0 = world.liveCalls.length
  await roundOne('pandalive')
  check('T51-10 逐房那一发撞上旧账: 状态照翻、那场"下播"不报(与预言机那一条同判据, 不看读数从哪条链来)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === 0)
  check('T51-11 发数一字未改: 降级轮该发的分页与那一发复查照发', world.liveCalls.length > live0 && world.bjCalls.length === 1, `live=${world.liveCalls.length} bj=${world.bjCalls.length}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 1 // 阈值 = 2 个轮距 = 2 秒: 用真时钟跨过去(见下面那两句 clearTimeout —— runRound 落地会自己续一颗 1 秒的定时器, 不清就会在后面的组里连发轮次)
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('s5')])
db.anchors = [mkAnchor('s5', { isLive: true, lastSeenAt: Date.now() - 1100 })]
{
  // T51-7/8 那组对照看不见的那一条: 稳态里 lastSeenAt 每轮都在写, 而"两轮防抖"自己保证
  // 第二轮到达时年龄 = 2 个轮距 + 轮内耗时 —— 判据只看时间 ⇒ 每一次正常散场都走进豁免支, 通知 100% 不发。
  // 现场 2026-10-03: 落地后「下播:」0 条 vs 落地前 168 条, 中途 5 次散场 5/5 全中。
  // 这一组用真时间跨那个间距(不 stub Date.now: 桩过的时钟会把 lastRoundAt/冷却窗写成未来值, 毒到后面几组)。
  const stopTimer = () => {
    if (watcher.loop.pandalive.timer) clearTimeout(watcher.loop.pandalive.timer)
    watcher.loop.pandalive.timer = null
  }
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  stopTimer()
  check('T51-12 真间距下的第一轮: 年龄 = 1 个轮距(没到 2×) 不算旧账, 只记第一轮的账',
    db.anchors[0].isLive === true && pendingAt('s5') > 0 && world.toasts.length === 0,
    `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt} toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
  await sleep(1400) // 年龄真的越过 2×轮距(≈2.5s > 2s), 复刻第二轮确认的实际间距
  await roundOne('pandalive')
  stopTimer()
  check('T51-13 已排进防抖的第二轮: 年龄越过了阈值也不豁免 ⇒ 下播通知照发(实测这一支把 5/5 吞了)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === 1,
    `isLive=${db.anchors[0].isLive} toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
  check('T51-14 这一组用的还是那两发整表: 修通知不发一发新请求',
    world.bmCalls.length - bm0 === 2 && world.bjCalls.length === 0, `bm+${world.bmCalls.length - bm0} bj=${world.bjCalls.length}`)
}

// ============ T57 「待第二轮确认」那一格跨重启: 6 分钟的停摆不许把亲眼看见的下播静默掉 ============
// 现场 2026-10-04: 06:58:09 关注列表报 @fjqbxhzl1 下播(内存表里记下一轮待确认)→ 07:04 实例重启 →
// 新进程的表是空的 ⇒ 那一轮的豁免分支把它判成「陈旧基线首轮翻离线」, 一句通知都没发,
// 而日志那句归因在这个样本里是假的(停摆只有 6 分钟, 场就在我们眼前散的)。修复 = 把那一格写在锚点行上。
console.log('\n■ T57 下播防抖跨重启: 行上那一格活得过进程, 隔夜那一种死账仍旧只翻状态不报下播')
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60 // 阈值 = 2 个轮距 = 120 秒(和 6 分钟的停摆比, 它一定已经越过)
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('r1')])
db.anchors = [mkAnchor('r1', { isLive: true, lastSeenAt: Date.now() })]
{
  const bm0 = world.bmCalls.length
  await roundOne('pandalive') // 旧进程的第一轮: 报离线, 只排防抖
  check('T57-1 旧进程那一轮: 不翻状态、不发通知, 那一格落在锚点行上(旧形状落在这里读不到的地方)',
    db.anchors[0].isLive === true && db.anchors[0].offlinePendingAt > 0 && world.toasts.length === 0,
    `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt}`)
  // 把时钟推进到现场那一段的形状: 报下播 → 6 分钟后新进程起来(行上两格一起变老, 不 stub Date.now)
  db.anchors[0].lastSeenAt -= 6 * 60_000
  db.anchors[0].offlinePendingAt -= 6 * 60_000
  const w2 = reloadTs('src/main/services/watcher.ts').watcher // 进程内存全空, 只剩 db 里那一行
  w2.running = true
  const toff0 = world.toasts.filter((t) => t.type === 'offline').length
  await w2.runRound('pandalive')
  check('T57-2 新进程的第一轮就是确认轮: 翻状态且下播通知照发(旧形状在这里丢账, 走的是下面那条静默支)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === toff0 + 1,
    `isLive=${db.anchors[0].isLive} toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
  check('T57-3 留痕里没有「陈旧基线首轮翻离线」: 那一句出现在这里就是拿旧账冒充现值的错归因',
    !world.logs.some((l) => /陈旧基线首轮翻离线/.test(String(l))), JSON.stringify(world.logs.slice(-2)))
  check('T57-4 通知发完当场销账(=0 而不是留着): 下一场不许继承这一场的旧账',
    db.anchors[0].offlinePendingAt === 0, `pendingAt=${db.anchors[0].offlinePendingAt}`)
  check('T57-5 两头发数一字未改: 修那一格不给平台加任何一发',
    world.bmCalls.length - bm0 === 2 && world.bjCalls.length === 0, `bm+${world.bmCalls.length - bm0} bj=${world.bjCalls.length}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('r2')])
db.anchors = [mkAnchor('r2', { isLive: true, lastSeenAt: Date.now() - 8 * 3600_000, offlinePendingAt: Date.now() - 8 * 3600_000 })]
{
  // 另一头: 隔夜留下的旧账。那一格说的是"8 小时前排过一轮", 不是"刚刚散场" —— 报通知就是把昨天那场播成今天
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  check('T57-6 超过新鲜上限的旧账不当 pending 使: 走的还是冷启动豁免(翻状态、不发那场下播)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === 0 &&
      world.logs.some((l) => /陈旧基线首轮翻离线/.test(String(l))),
    `toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
  check('T57-7 死账随翻转一起销掉', db.anchors[0].offlinePendingAt === 0, `pendingAt=${db.anchors[0].offlinePendingAt}`)
  check('T57-8 这一头同样零增量请求', world.bmCalls.length - bm0 === 1 && world.bjCalls.length === 0, `bm+${world.bmCalls.length - bm0}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [mkAnchor('r3', { isLive: true, lastSeenAt: Date.now(), offlinePendingAt: Date.now() })]
world.bjMedia = { r3: null }
{
  // 第四条读数面(逐房 member/bj): 它自己不走两轮, 一发就宣判 —— 那一格若不清, 这一间的下一场散场会少排一轮
  await roundOne('pandalive')
  check('T57-9 逐房那一发作确认轮: 通知照发, 且行上那一格当场销掉(旧内存表在这一支从不删键)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === 1 && db.anchors[0].offlinePendingAt === 0,
    `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt} toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
login([bmLive('r4', { user: 12, title: '还在播', startTime: '2026-10-04 07:00:00' }), bmLive('r6', { user: 8, title: '也在播', startTime: '2026-10-04 07:00:00' })])
db.anchors = [
  mkAnchor('r4', { isLive: true, lastSeenAt: Date.now(), offlinePendingAt: Date.now() }),
  mkAnchor('r6', { isLive: true, lastSeenAt: Date.now() }) // 一间从没挂账的作对照: 它一轮都不许被写
]
{
  // 反过来: 读回在播就得把脏账收回。留着它的含义是"平台说这一场散了", 而他正开着
  const pendWrites = () => world.anchorWrites.filter((w) => 'offlinePendingAt' in w.patch)
  await roundOne('pandalive')
  check('T57-10 瞬回离线的抖动被下一发读数推翻: 状态不动、那一格收回(旧写法靠 map.delete, 落库后必须写 0 而不是"不写")',
    db.anchors[0].isLive === true && db.anchors[0].offlinePendingAt === 0 && world.toasts.filter((t) => t.type === 'offline').length === 0,
    `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt}`)
  check('T57-11 收回就是恰好一笔落库(有账才写): 全轮带这一格的写数看整轮而不是只看这间 —— 没账的房每轮白写一格 = 平白多一次写盘, 718 个关注一轮就是 718 笔',
    pendWrites().length === 1 && pendingWrites('r4').length === 1, `全轮写次=${pendWrites().length} r4=${JSON.stringify(pendWrites().map((w) => [w.userId, w.patch]))}`)
  await roundOne('pandalive')
  check('T57-12 账已清的房下一轮不再为它写 0(上面那一句不是"每轮都写一次刚好一次")',
    pendWrites().length === 1 && db.anchors[0].isLive === true, `全轮写次=${pendWrites().length}`)
}
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 60
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [mkAnchor('r5', { isLive: true, lastSeenAt: Date.now(), offlinePendingAt: Date.now() })]
world.bjMedia = { r5: null }
{
  // 这一组的最后一格是变异(M1)替我找出来的盲区: 逐房那一发自己不走两轮, 它读那一格只为了一个用途 ——
  // 分清"停摆 6 分钟(我们在场, 通知该发)"与"停摆隔夜(不在场, 只翻状态)"。
  // 前面那条 T57-9 把 lastSeenAt 留在当下, 两种形状在它眼里是同一个, 所以那一格必须自己站一班。
  db.anchors[0].lastSeenAt -= 6 * 60_000 // 现场那一段: 报下播后 6 分钟新进程起来, 只有账是新鲜的
  const toff0 = world.toasts.filter((t) => t.type === 'offline').length
  await roundOne('pandalive')
  check('T57-13 逐房那一发也读同一本账: 账新鲜而 lastSeenAt 已越过阈值 ⇒ 仍按确认轮发通知(读不出账就掉进静默支)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === toff0 + 1 &&
      !world.logs.some((l) => /陈旧基线首轮翻离线/.test(String(l))),
    `toasts=${JSON.stringify(world.toasts.map((t) => t.type))}`)
  check('T57-14 这一头同样零增量请求', world.bjCalls.length === 1, `bj=${world.bjCalls.length}`)
}

// ============ T52 预取队列改按观众数排队: 秒开排在最可能被人点的那一间前面(不砍量) ============
// 队列排空要几分钟(实测 103 个房 ≈12 分钟), 而表序把大房排在尾巴上 —— 前面那些小观众房买到的秒开没人用,
// 排在后面的大房还没排到就散场。这一笔改的是顺序, 不是发数。
console.log('\n■ T52 首轮后补预取的排队顺序: 观众数从高到低, 自录房仍在最前')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [
  mkAnchor('p1', { isLive: true, viewerCount: 5 }),
  mkAnchor('p2', { isLive: true, viewerCount: 900 }),
  mkAnchor('p3', { isLive: true, viewerCount: 60 })
]
{
  watcher.prewarmPumping.pandalive = true // 举着泵看排队(与 T42 同一手法): 入队会顺手点泵, 不举就读不到顺序
  watcher.prewarmSweep('pandalive')
  check('T52-1 排队顺序 = 观众数降序(旧写法按库里加的先后排)', watcher.prewarmQueue.pandalive.join(',') === 'p2,p3,p1', watcher.prewarmQueue.pandalive.join(','))
  check('T52-2 三间排三发: 这是排序不是砍量', watcher.prewarmQueue.pandalive.length === 3)
  watcher.prewarmPumping.pandalive = false
  void watcher.pumpPrewarm('pandalive')
  const done = await waitUntil(() => world.playCalls.length === 3 && !watcher.prewarmPumping.pandalive, 5000)
  const order = world.playCalls.map((c) => c.userId).join(',')
  check('T52-3 泵照那个顺序发源(第一间就是 900 人那间), 总发数仍是 3', done && order === 'p2,p3,p1' && world.playCalls.length === 3, order)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [
  mkAnchor('q1', { isLive: true, viewerCount: 500 }),
  mkAnchor('q2', { isLive: true, viewerCount: 1, autoRecord: true })
]
{
  watcher.prewarmPumping.pandalive = true
  watcher.prewarmSweep('pandalive')
  check('T52-4 自录房仍插在最前(与 T42 同规约: 观众数排不到"开播就得有源"前面)', watcher.prewarmQueue.pandalive.join(',') === 'q2,q1', watcher.prewarmQueue.pandalive.join(','))
  watcher.prewarmPumping.pandalive = false
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.anchors = [
  mkAnchor('t1', { isLive: true, viewerCount: 500 }),
  mkAnchor('t2', { isLive: false, viewerCount: 900 }),
  mkAnchor('t3', { isLive: true, viewerCount: 20 })
]
{
  watcher.prewarmPumping.pandalive = true
  watcher.prewarmSweep('pandalive')
  check('T52-5 排序不放宽入围条件: 离线那间(哪怕 900 人)依旧不排, 在播的两间按高低排',
    watcher.prewarmQueue.pandalive.join(',') === 't1,t3', watcher.prewarmQueue.pandalive.join(','))
  watcher.prewarmPumping.pandalive = false
  watcher.prewarmQueue.pandalive.length = 0
}

// ============ T53 那架退避阶梯现场到底长什么样(用户 2026-10-03 拍板: 维持现状不改, 这一节把现状钉成契约) ============
// 机制: noteFailure 用 2^(streak-1) 分钟做指数退避, 而冷却期那一发预言机读通时把 errorStreak 一起清零 ——
// 于是阶梯永远爬不过第二级: 被拦 → 退避 1 分钟 → 下一轮到点时探针读通(清零+解除) → 扇出恢复开火 → 再被拦 → 还是 1 分钟。
// 现场两个样本相隔 141 秒(14:07:51 与 14:09:26), 正是这个循环走完一圈(那时的轮距是熔断期压出来的 30s, 见 T53-9)。
console.log('\n■ T53 退避阶梯的现状: 预言机一发读通即清零 ⇒ 退避恒为一分钟级, 扇出在几十秒内恢复开火')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.settings.monitor.pandalive.pollIntervalSec = 120 // 取本机 data/db.json 的真值(2026-10-04 读: pandalive=120s / soop=60s)
db.anchors = [mkAnchor('k1', { isLive: true })]
world.bj403 = { k1: true }
{
  const P = watcher.status.byPlatform.pandalive
  await roundOne('pandalive')
  const cd1 = watcher.cooldownUntil - Date.now()
  check('T53-1 一发 403 立即熔断并退避 1 分钟(streak=1 ⇒ 2^0 分钟)',
    watcher.errorStreak === 1 && P.circuitOpen === true && cd1 > 55_000 && cd1 <= 60_000, `streak=${watcher.errorStreak} cd=${(cd1 / 1000).toFixed(0)}s`)
  check('T53-2 熔断期不提速: 轮距仍等于用户那一格(C1 撤掉 30s 那一压 —— 风控期加倍发问与这一格要防的相反)',
    P.circuitOpen === true && watcher.intervalFor('pandalive') === 120_000)
  watcher.cooldownUntil = Date.now() - 1 // 等价于等满这一分钟(下面要的是"第二次失败"这个状态)
  await roundOne('pandalive')
  const cd2 = watcher.cooldownUntil - Date.now()
  check('T53-3 阶梯本身确实会爬: 中间没有成功读数时, 第二次失败退避 2 分钟',
    watcher.errorStreak === 2 && cd2 > 110_000 && cd2 <= 120_000, `streak=${watcher.errorStreak} cd=${(cd2 / 1000).toFixed(0)}s`)
  watcher.cooldownUntil = Date.now() - 1
  await roundOne('pandalive')
  const cd3 = watcher.cooldownUntil - Date.now()
  check('T53-4 第三次 4 分钟(指数段 2^(streak-1) 在, 上限 15 分钟由 D 段契约守着)',
    watcher.errorStreak === 3 && cd3 > 230_000 && cd3 <= 240_000, `cd=${(cd3 / 1000).toFixed(0)}s`)

  // 现场那一步: 退避还没到期, 冷却期那一轮只发站内关注那一发 —— 而它读通了
  watcher.cooldownUntil = Date.now() + 50_000
  login([bmOff('k1')])
  const bj0 = world.bjCalls.length
  const live0 = world.liveCalls.length
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  check('T53-5 冷却期那一轮只发预言机一发(逐房与全站榜的扇出面一条不碰)',
    world.bmCalls.length - bm0 === 1 && world.bjCalls.length === bj0 && world.liveCalls.length === live0,
    `bm+${world.bmCalls.length - bm0} bj+${world.bjCalls.length - bj0} live+${world.liveCalls.length - live0}`)
  check('T53-6 读通即三格一起清零: cooldownUntil=0 / errorStreak=0 / circuitOpen=false(日志那句"退避提前解除"就是这一格)',
    watcher.cooldownUntil === 0 && watcher.errorStreak === 0 && P.circuitOpen === false && world.logs.some((l) => /冷却期预言机读通/.test(String(l))))

  // 于是清零之后的下一次失败又回到 1 分钟 —— 这一条就是"限流后几十秒恢复开火、约两分钟再被拦"的根
  world.bm = null // 整表重新不接待 ⇒ 落回降级那条链(逐房复查照发)
  const bj1 = world.bjCalls.length
  await roundOne('pandalive')
  const cd4 = watcher.cooldownUntil - Date.now()
  check('T53-7 扇出面在读通那一轮之后就恢复开火(逐房复查照发)', world.bjCalls.length > bj1, `bj+${world.bjCalls.length - bj1}`)
  check('T53-8 再来一发 403 退避仍是 1 分钟而不是 4 分钟: 阶梯被清零顶在第二级(现状如此)',
    watcher.errorStreak === 1 && cd4 > 55_000 && cd4 <= 60_000, `streak=${watcher.errorStreak} cd=${(cd4 / 1000).toFixed(0)}s`)
  check('T53-9 一圈 = 退避 + 下一次到点的轮: 改前本机是 1 分钟 + 熔断期的 30s(现场实测 141 秒), C1 撤掉那一压之后是 1 分钟 + 120s ⇒ ≈180 秒量级(改后这一格未实拍: 风控窗口不能按需复现, 只能按同一算式外推)',
    cd4 > 55_000 && cd4 <= 60_000 && watcher.intervalFor('pandalive') === 120_000, `cd=${(cd4 / 1000).toFixed(0)}s iv=${watcher.intervalFor('pandalive') / 1000}s`)
}

// ============ T54 播放器亲证死源: 作废只摘那一份源包, 防重复的那本账一条不动 ============
// 现场(2026-10-03 23:33:38 @kurzzang123): 播放器拿到 manifestLoadError http=404, 主进程那份缓存却直到
// 23:38:52 才被保活的双测追认 —— Panda 的播放地址不过本地代理, 渲染层是这一句判决唯一的证人。
// 这一节的判据是"作废那一句的宽度": 跟着走 invalidatePlay 会把 T34 那本门槛账一起撤(见 T34-5),
// 于是下一次问价重打整链 —— 拿一次作废换来的是加请求, 与用户定的口径相反。
console.log('\n■ T54 亲证地址对得上才摘, 摘完零请求, 门槛账/保活读数/纪元一条不动')
await reset()
{
  const p1 = await api.getPlayCached('d1', '', true)
  check('T54-1 先正常拉一枚进缓存(下面才有"那一份死源"可摘)', p1.ok === true && api.cachedSourceIds().includes('pandalive:d1'), p1.error)
  api.gates.set('d1', { until: Date.now() + 600_000, pack: { ok: false, error: 'gate(sim)' } })
  api.keepaliveInfo.set('d1', { at: Date.now(), ok: true, variants: 1 })
  const e0 = api.epochOf('d1')
  const n0 = world.playCalls.length
  check('T54-2 报的地址不是手里这一份 ⇒ 不摘(源早被换过, 播放器踩死的是旧的那一串)',
    api.dropCachedPlay('d1', 'https://cdn.live-video.net/d1/NOT.m3u8') === false && api.playCache.has('d1'))
  check('T54-3 报的正是手里这一份 ⇒ 摘', api.dropCachedPlay('d1', p1.m3u8) === true && !api.cachedSourceIds().includes('pandalive:d1'))
  check('T54-4 作废本身零请求', world.playCalls.length === n0, `实发=${world.playCalls.length - n0}`)
  check('T54-5 门槛账/保活读数/纪元三条一条没动(旧写法跟着撤的就是这几本)',
    api.gates.has('d1') && api.keepaliveInfo.has('d1') && api.epochOf('d1') === e0)
  const p2 = await api.getPlayCached('d1')
  check('T54-6 摘过之后非强制取流吃的仍是门槛账短路 = 一发不发("作废不加请求"的落地读数)',
    world.playCalls.length === n0 && p2.ok === false, `实发=${world.playCalls.length - n0}`)
}

console.log('\n■ T54b 强制重取没拿到源: 作废的是这条链出发之前那一份, 而"这次没带密码"不是证据')
await reset()
{
  const p = await api.getPlayCached('d2', '', true)
  check('T54b-1 缓存里先有一枚', p.ok === true && api.playCache.has('d2'), p.error)
  // 让手里这份老于之后每一条链的出发时刻: 不然该摘的那一格会被时戳判据先挡掉(毫秒级的巧合会把变异藏起来)
  const held2 = api.playCache.get('d2')
  if (held2) held2.fetchedAt -= 5000
  world.playMsg.d2 = '비밀번호가 올바르지 않습니다.' // 那句"密码不对": needPassword 出口
  world.logs.length = 0
  const r = await api.getPlayCached('d2', '', true)
  check('T54b-2 needPassword 不作废 —— 它说的是"这次没带密码", 不是"源死了"(带过密码的那份照旧能用)',
    r.needPassword === true && api.playCache.has('d2'))
  check('T54b-3 这一格不出声(留痕是职责, 假痕是骗人)', !world.logs.some((l) => /当场作废手里那份/.test(String(l))))
  world.playMsg.d2 = '' // 替身里那句"200 + 一句话"排在门槛码之前: 不撤掉它, 下一档门槛码根本不会被读到
  world.playGate.d2 = 'needCoinPurchase' // 平台改口要充值: 这一发真打出去了且没拿到源
  const n1 = world.playCalls.length
  world.logs.length = 0
  const r2 = await api.getPlayCached('d2', '', true)
  check('T54b-4 手里那份是这条链出发之前的 ⇒ 当场作废(挂着「秒开」就是骗人的那一个)',
    r2.ok === false && !api.playCache.has('d2'))
  check('T54b-5 作废在日志里出声', world.logs.some((l) => /强制重取没拿到源, 当场作废手里那份: @d2/.test(String(l))))
  check('T54b-6 代价只有重取那一发(作废不搭请求)', world.playCalls.length - n1 === 1, `实发=${world.playCalls.length - n1}`)
  check('T54b-7 门槛账留下: 下一次问价短路, 不再重打整链', api.gates.has('d2'))
  // 在飞窗口里另一条链(带密码那一把键)写进了更新的源 —— 那份没说谎, 摘它就是白删一次秒开
  const p3 = await api.getPlayCached('d3', '', true)
  check('T54b-8 对照组之前先给 d3 一枚', p3.ok === true, p3.error)
  world.playGate.d3 = 'castEnd'
  const n2 = world.playCalls.length
  world.logs.length = 0
  const flying = api.getPlayCached('d3', '', true) // 链已出发(t0 已落)
  check('T54b-8b 在飞表里还有它 ⇒ 下面那次 set 发生在这一条链落地之前(没有这一句, 整组只是碰巧的时序)', api.playInflight.has('d3'))
  const newer = { ...p3, m3u8: 'https://cdn.live-video.net/d3/newer.m3u8', fetchedAt: Date.now() }
  api.playCache.set('d3', newer) // 出发之后落地的新源
  const r3 = await flying
  check('T54b-9 出发之后写进来的那份活着(旧写法一律 invalidatePlay = 把刚买到的好源一起撤)',
    r3.ok === false && api.playCache.get('d3')?.m3u8 === newer.m3u8, api.playCache.get('d3')?.m3u8)
  check('T54b-10 这一趟同样只有重取那一发, 且没为 d3 留那句作废痕',
    world.playCalls.length - n2 === 1 && world.logs.every((l) => !/当场作废手里那份: @d3/.test(String(l))), `实发=${world.playCalls.length - n2}`)
}

console.log('\n■ T55 在途合流那一问不再冒充「真发」: 旗挂上, 发数与内容一字未改')
await reset()
{
  world.latency.liMs = 60 // 给合流开一个真窗口: 两问若在同一个微任务里跑完就等于没测到这条分支
  const q1 = api.checkLoginInfo()
  await new Promise((r) => setTimeout(r, 10)) // 第一条链已登记在飞表(没有这一句, 下面那一次只是碰巧的时序)
  const q2 = api.checkLoginInfo()
  const [r1, r2] = await Promise.all([q1, q2])
  check('T55-1 两问只发一发(合并这一格本来就在, 这一节补的是它那句自证)', world.liCalls.length === 1, `实发=${world.liCalls.length}`)
  check('T55-2 出门那一问两旗都不带 ⇒ 日志读作「真发」', r1.merged === undefined && r1.fromCache === undefined, JSON.stringify(r1))
  check('T55-3 合流那一问挂 merged 且不带 fromCache(两档互斥, 混成一档就分不清"缓存里读的"和"接别人那一发")', r2.merged === true && r2.fromCache === undefined, JSON.stringify(r2))
  check('T55-4 合流拿到的就是同一条真答案, 除了旗什么都不差(记账不改返回契约, 与 D90e/D97b 同规约)',
    r2.isLogin === r1.isLogin && r2.isAdult === r1.isAdult && r2.idx === r1.idx && r2.netFail === r1.netFail, JSON.stringify([r1, r2]))
  world.latency.liMs = 0
  const r3 = await api.checkLoginInfo()
  check('T55-5 落定后再问是「缓存」档(fromCache 且 merged 不亮), 发数仍是那一发', r3.fromCache === true && r3.merged === undefined && world.liCalls.length === 1, JSON.stringify(r3))
  check('T55-6 在飞表落定即清(合流不许留下第二把锁)', api.loginInfoInflight === null, String(api.loginInfoInflight))
  const n = world.liCalls.length
  const r4 = await api.checkLoginInfo(undefined, true)
  check('T55-7 force 那一档照旧真问、两旗都不带(账号页「立即重新校验」不许被这面旗冒充)',
    world.liCalls.length === n + 1 && r4.merged === undefined && r4.fromCache === undefined, `新增发数=${world.liCalls.length - n}`)
  check('T55-8 这一节没为标记多问一发: 上面四问的总发数 = 出门那一发 + force 那一发', world.liCalls.length === 2, `实发=${world.liCalls.length}`)
  // 带 jarOverride 的"试验证"(Cookie 导入)不经缓存也不经在飞表: 这一格的旗一律不该亮
  const n2 = world.liCalls.length
  const r5 = await api.checkLoginInfo({ PHPSESSID: 'trial' })
  check('T55-9 试验证那一问自己发、自己回, 不带 merged/fromCache(它本来就是"这一次真实问出来的")',
    world.liCalls.length === n2 + 1 && r5.merged === undefined && r5.fromCache === undefined, `实发=${world.liCalls.length - n2}`)
  check('T55-10 五问三发(出门 / force / 试验证各一发, 合流与缓存零发): 标记本身一发不搭 —— 行数 ≠ 发数这句话现在有四档说话',
    world.liCalls.length === 3, `实发=${world.liCalls.length}`)
}

console.log('\n■ T55b 合流的那一问接来的若是失败链: netFail 与 merged 各说各的, 一发不许多')
await reset()
{
  world.liThrow = true
  world.latency.liMs = 60
  const f1 = api.checkLoginInfo()
  await new Promise((r) => setTimeout(r, 10)) // 第一条链已登记在飞表
  const f2 = await api.checkLoginInfo()
  const f1r = await f1
  check('T55b-1 两问仍是一发(失败链照样被合流, 不会因为"没答案"就多打一遍)', world.liCalls.length === 1, `实发=${world.liCalls.length}`)
  check('T55b-2 出门那一问: netFail 且两旗不带', f1r.netFail === true && f1r.merged === undefined && f1r.fromCache === undefined, JSON.stringify(f1r))
  check('T55b-3 合流那一问: netFail 原样接来 + merged 亮("我没出门"与"那一发失败了"是两格, 不许互相冒充)',
    f2.netFail === true && f2.merged === true && f2.fromCache === undefined && f2.isLogin === false, JSON.stringify(f2))
  world.latency.liMs = 0
  const n = world.liCalls.length
  const f3 = await api.checkLoginInfo()
  check('T55b-4 失败答案不进 30 秒结果缓存: 下一问照旧真发, 且那一问是自己出门的(merged 不亮)',
    world.liCalls.length === n + 1 && f3.merged === undefined && f3.fromCache === undefined, `新增发数=${world.liCalls.length - n} ${JSON.stringify(f3)}`)
}

// ============ T56 熔断期不再加速轮距: 轮距与它牵着的陈旧阈值都不因 circuitOpen 变形 ============
// 本机真格子: data/db.json(2026-10-04 读) pandalive.pollIntervalSec=120。旧那一压把熔断期变成 30 秒一跳,
// 而冷却期一轮只发那一发预言机(5 分钟才轮到一次) —— 那多出来的几轮多半整轮零网络, 省的是等待不是请求。
// 它唯一真改动了行为的地方在别处: staleOnFirstLook 的阈值是 2×轮距, 于是熔断期从 240 秒被压成 60 秒,
// "上一场刚散、我们看着它散"的卡会在熔断轮里被当成冷启动旧账, 首轮就翻、且不发那场下播通知。
// 下面这一组取的是现场真存在的那一态: 冷却刚到期而 circuitOpen 还没被成功读数摘下(它要等这一轮读完才落)。
console.log('\n■ T56 熔断轮里陈旧阈值 = 2×用户轮距(不是 2×30s): 该走两轮的照走两轮, 通知照发, 请求数一条不多')
await reset()
db.settings.monitor.pandalive.pollIntervalSec = 120
db.settings.monitor.pandalive.requestGapMs = 0
login([bmOff('c1')])
db.anchors = [mkAnchor('c1', { isLive: true, lastSeenAt: Date.now() - 150_000 })] // 150s: 老于改前熔断阈值(60s), 新于改后阈值(240s)
{
  const P = watcher.status.byPlatform.pandalive
  P.circuitOpen = true
  const bm0 = world.bmCalls.length
  await roundOne('pandalive')
  check('T56-1 同一句离线读数在熔断轮里仍走两轮防抖(改前那一压把阈值压成 60 秒, 这一张会被当成陈旧旧账首轮就翻)',
    db.anchors[0].isLive === true && pendingAt('c1') > 0, `isLive=${db.anchors[0].isLive} pendingAt=${db.anchors[0].offlinePendingAt}`)
  check('T56-2 熔断轮里没有"陈旧基线首轮翻离线"那句留痕(豁免判据这次不成立)',
    !world.logs.some((l) => /陈旧基线首轮翻离线/.test(String(l))), JSON.stringify(world.logs.slice(-2)))
  await roundOne('pandalive')
  check('T56-3 第二轮照常翻状态、照常发下播通知(撤提速没有把稳态的下播一起吞掉)',
    db.anchors[0].isLive === false && world.toasts.filter((t) => t.type === 'offline').length === 1, JSON.stringify(world.toasts.map((t) => t.type)))
  check('T56-4 两轮各一发整表: 检测面一条不少(撤的是节奏不是请求)', world.bmCalls.length - bm0 === 2, `bm+${world.bmCalls.length - bm0}`)
  check('T56-5 两站在熔断态与常态读到的是同一格(唯一读 circuitOpen 的那一行已被撤)',
    P.circuitOpen === false && watcher.intervalFor('pandalive') === 120_000 && watcher.intervalFor('soop') === 3_600_000)
}

// ============ T59 预取失败要有下一次: 一次抖动不许把这一间永久逐出预取集 ============
// 真机那一次(2026-10-05 12:15): 进队 → 我方 15 秒尺 abort → 之后直到重启再无一次尝试, 那 10 分钟里这一间的
// 「已缓存」徽标一直熄灭(徽标说的是实话, 丢的是"这间本该有源"这件事)。旧写法里"失败"不是事件 ——
// 入队点只有首轮补扫(只认 roundCnt===1)与状态翻转那一瞬。
console.log('\n■ T59 (1) 预取失败补排: 有界退避、封顶三次、成功即销账、门槛房零重买、不补的两类、停轮即撤')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.prewarmRetryBaseMs = 300 // 压刻度: 生产那一格(60/120/180 秒)由契约钉, 这里测的是形状不是钟
  // 300 而不是 30: T59-1 要读的是"失败那一瞬定时器还挂着", 压太狠会在同一次轮询里就落地
  world.playMsg.n1 = '일시적 오류' // 200 + 一句非门槛非限流的话 ⇒ {ok:false}, 且门槛账不记(所以补排要真再问一次)
  db.anchors = [mkAnchor('n1', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 'n1')
  await waitUntil(() => playCount('n1') >= 1, 1500)
  check('T59-1 第一次失败当场只发一发(补排是定时器, 不是就地重打)', playCount('n1') === 1 && watcher.prewarmRetryTimers.size === 1, `实发=${playCount('n1')} 待触发=${watcher.prewarmRetryTimers.size}`)
  const ok2 = await waitUntil(() => playCount('n1') >= 2, 2500)
  check('T59-2 退避到点同一间重新排上并真再发一发(旧写法这一发永远不会来)', ok2, `实发=${playCount('n1')}`)
  check('T59-3 留痕说得出这是第几次补排(看不见的那一句等于没写)', world.logs.some((l) => /预取失败补排\(第 1\/3 次\): @n1/.test(String(l))), JSON.stringify(world.logs.filter((l) => /补排/.test(String(l)))))
  await waitUntil(() => playCount('n1') >= 4, 6000)
  await sleep(600)
  check('T59-4 封顶三次: 1 发原试 + 3 次补排 = 最多 4 发, 到顶就不再来', playCount('n1') === 4 && watcher.prewarmRetryTimers.size === 0, `实发=${playCount('n1')} 待触发=${watcher.prewarmRetryTimers.size}`)
  world.playMsg.n1 = '' // 抖动过去了
  watcher.prewarmRetryCnt.clear()
  watcher.enqueuePrewarm('pandalive', 'n1')
  const got = await waitUntil(() => api.playCache.get('n1')?.ok === true, 2500)
  await sleep(400)
  check('T59-5 拿到源即销账: 次数清零、不留待触发的定时器, 此后不再为这一间发补排', got && watcher.prewarmRetryCnt.size === 0 && watcher.prewarmRetryTimers.size === 0 && playCount('n1') === 5, `实发=${playCount('n1')} 账=${watcher.prewarmRetryCnt.size} 待触发=${watcher.prewarmRetryTimers.size}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.prewarmRetryBaseMs = 30
  world.playThrow.t1 = true // 请求层直接抛(泵那一头拿到的是 undefined, 与"200 + 一句话"是两种失败形状)
  db.anchors = [mkAnchor('t1', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 't1')
  await waitUntil(() => playCount('t1') >= 2, 2500)
  check('T59-6 抛出去的那一发同样补排: 失败形状两种, 闸门只有一道', playCount('t1') >= 2, `实发=${playCount('t1')}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.prewarmRetryBaseMs = 30
  world.playGate.g1 = 'needCoinPurchase' // 平台那句"这门槛过不去"会记进门槛账, 15 分钟内短路零请求
  db.anchors = [mkAnchor('g1', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 'g1')
  await waitUntil(() => playCount('g1') >= 1, 1500)
  const swept = await waitUntil(() => world.logs.some((l) => /补排\(第 3\/3 次\): @g1/.test(String(l))), 5000)
  await sleep(400)
  check('T59-7 门槛房补排三次而一发不多: 补排吃的是门槛账的短路, 不是再买一遍整链', swept && playCount('g1') === 1, `实发=${playCount('g1')}`)
  world.playGate.g1 = ''
  world.playMsg.g1 = ''
  api.clearPlayCache()
  api.gates.clear()
  watcher.prewarmRetryCnt.clear() // 上一格那三次的账清掉, 这一格要读的是"一次都没补过"
  world.playMsg.pw1 = '비밀번호가 올바르지 않습니다.' // → needPassword: 预取这一路永远没有密码
  db.anchors = [mkAnchor('pw1', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 'pw1')
  await waitUntil(() => playCount('pw1') >= 1, 1500)
  await sleep(300)
  check('T59-8 needPassword 不补排(重打整链只换回同一句)', playCount('pw1') === 1 && watcher.prewarmRetryTimers.size === 0 && watcher.prewarmRetryCnt.size === 0, `实发=${playCount('pw1')} 待触发=${watcher.prewarmRetryTimers.size}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.prewarmRetryBaseMs = 400 // 这一格故意不压到 30: 要的就是"定时器还活着"那一段
  world.playMsg.s1 = '일시적 오류'
  db.anchors = [mkAnchor('s1', { isLive: true })]
  watcher.enqueuePrewarm('pandalive', 's1')
  await waitUntil(() => playCount('s1') >= 1, 1500)
  const armed = watcher.prewarmRetryTimers.size === 1
  watcher.stop()
  // 就在 stop() 之后立刻读: 再等下去, 那枚没被撤的定时器会自己进回调摘帽(回调第一句就是 delete),
  // 于是"清了的"和"没清的"在 900 ms 后读数一样 —— 变异 M6 第一次就是这样全绿的
  const sweptAtStop = watcher.prewarmRetryTimers.size === 0
  await sleep(900)
  check('T59-9 停轮即撤补排: 那一枚定时器与两条队列同属"下一发要发真请求"的待办', armed && sweptAtStop && watcher.prewarmRetryTimers.size === 0 && playCount('s1') === 1, `撤前 armed=${armed} 停轮当刻已清空=${sweptAtStop} 实发=${playCount('s1')}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
{
  watcher.prewarmRetryBaseMs = 250
  world.playMsg.x1 = '일시적 오류'
  db.anchors = [mkAnchor('x1', { isLive: true })]
  // 这道闸的取证不能只读"实发数": 泵出队那一头本来还有一道 stillMonitored, 取关房到点即使排进队列也发不出请求
  // ⇒ 两种写法实发都是 1(变异 M7 第一次就是这样全绿的)。所以这一格盯的是"到点有没有去排队"这件事本身 ——
  // 替身只记账不改语义(生产那一句该拦的仍然交给闸门拦), 读完即摘
  const enqSeen = []
  const enqOrig = watcher.enqueuePrewarm.bind(watcher)
  watcher.enqueuePrewarm = (p, u) => {
    enqSeen.push(`${p}:${u}`)
    return enqOrig(p, u)
  }
  watcher.enqueuePrewarm('pandalive', 'x1')
  await waitUntil(() => playCount('x1') >= 1, 1500)
  store.removeAnchor('pandalive', 'x1') // 补排还在等的这一段里被取关
  await sleep(900)
  const requeued = enqSeen.filter((k) => k === 'pandalive:x1').length > 1 // 第 1 次是这里主动排的那一发
  check('T59-10 取关之后那一发补排不许落地(与泵出队、事件守卫同一道闸)', playCount('x1') === 1 && watcher.prewarmRetryTimers.size === 0 && !requeued, `实发=${playCount('x1')} 排队点=${enqSeen.join(',')}`)
  delete watcher.enqueuePrewarm // 替身只为本格而装, 读完即摘(留着会把后面几格的排队读数也算进同一本账)
  // 关掉预取开关这一段: 补排走的是同一条 enqueuePrewarm, 但到点要重新过一遍"本平台还开预取吗"
  db.anchors = [mkAnchor('x2', { isLive: true })]
  world.playMsg.x2 = '일시적 오류'
  watcher.prewarmRetryBaseMs = 250
  watcher.enqueuePrewarm('pandalive', 'x2')
  await waitUntil(() => playCount('x2') >= 1, 1500)
  const armed2 = watcher.prewarmRetryTimers.size === 1
  db.settings.monitor.pandalive.prefetchStream = false // 补排还在等的这一段里把这一格的预取关了
  await sleep(900)
  check('T59-11 补排不绕过预取开关: 到点先重读本平台那一格, 关了就只有账、没有请求', armed2 && playCount('x2') === 1 && watcher.prewarmQueue.pandalive.length === 0, `armed=${armed2} 实发=${playCount('x2')} 队列=${watcher.prewarmQueue.pandalive.length}`)
}

// ============ T60 「清过源账之后谁再排队」: 两条入口都必须是活的 ============
// 补扫此前只认 roundCnt===1, 而 roundCnt 是进程级的: 一台"开着监控跑了几小时 → 关掉 → 再打开"的机器
// 之后再也不会有一次补扫; 而登录成功那一头把 playCache 整表清了(ipc.ts 写着「登录后一律重取」),
// 在播房的状态并没有翻转 ⇒ onLiveStart 不会为它们再响。两处合起来的后果是同一件事:
// 源被清掉之后, 除非用户亲手点进播放器, 这批房在整台机器的剩余寿命里都不再有源。
console.log('\n■ T60 清账后的排队: 关-开监控重算首轮 / 登录清账当场补排(差集、去重、不越平台、不越开关)')
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
world.inList = { z1: true }
world.soopMeta = { zs: { living: true, broadNo: 20 } }
db.anchors = [mkAnchor('z1', { isLive: true }), mkAnchor('zs', { platform: 'soop', isLive: true })]
{
  await roundOne('pandalive')
  const d0 = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 3000)
  check('T60-1 舞台: 开局首轮把在播房排上并拿到源(此后轮数只往上走)', d0 && playCount('z1') === 1 && watcher.loop.pandalive.roundCnt === 1, `实发=${playCount('z1')} 轮数=${watcher.loop.pandalive.roundCnt}`)
  await roundOne('pandalive')
  await roundOne('pandalive')
  await roundOne('soop') // SOOP 那条时间轴也要数起来: 只归一个平台的半刀, 在两平台都数过之前看不见(变异 M1b 就是这样全绿的)
  const before = `${watcher.loop.pandalive.roundCnt}/${watcher.loop.soop.roundCnt}`
  watcher.stop() // 用户关掉监控
  watcher.start() // 再打开 —— 这一格改的那一行就落在这一头
  watcher.stop() // 只为撤掉 start() 排的 300ms 定时器: 台子里轮次由脚本手动驱动(见 reset 末尾那一格)
  watcher.running = true
  check('T60-2 关-开监控即把两平台轮数各自归零(归零只在 start() 那一头, stop() 不碰它)', before === '3/1' && watcher.loop.pandalive.roundCnt === 0 && watcher.loop.soop.roundCnt === 0, `归零前=${before} 现 panda=${watcher.loop.pandalive.roundCnt} soop=${watcher.loop.soop.roundCnt}`)
  api.clearPlayCache() // 给补扫留出"手上没源"的差集(等价于登录/换号清账那一步)
  world.playCalls.length = 0
  await roundOne('pandalive')
  const d1 = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 3000)
  check('T60-3 归零之后的第一轮真算作首轮: 补扫再来一次, 这一间不点播放器也重新拿到源(旧写法这一发永远不会来)', watcher.loop.pandalive.roundCnt === 1 && d1 && playCount('z1') === 1, `本轮=${watcher.loop.pandalive.roundCnt} 实发=${playCount('z1')}`)
}
await reset()
db.settings.monitor.pandalive.requestGapMs = 0
db.settings.monitor.soop.requestGapMs = 0
world.inList = { z2: true, z3: true }
world.soopMeta = { z9: { living: true, broadNo: 21 } }
db.anchors = [mkAnchor('z2', { isLive: true }), mkAnchor('z3', { isLive: true }), mkAnchor('z9', { platform: 'soop', isLive: true })]
{
  await roundOne('pandalive')
  const d0 = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 3000)
  check('T60-4 舞台: 首轮之后两间各有源, 且此刻 roundCnt=1 的补扫已经用掉', d0 && playCount('z2') === 1 && playCount('z3') === 1, `z2=${playCount('z2')} z3=${playCount('z3')}`)
  // 登录成功那一步的形状(storeCookies/importCookies 内部都是 clearPlayCache): 清账 + 当场点名补扫
  api.clearPlayCache()
  watcher.resweepPrewarm('pandalive')
  const d1 = await waitUntil(() => !watcher.prewarmPumping.pandalive && watcher.prewarmQueue.pandalive.length === 0, 3000)
  check('T60-5 清账当场重新排队: 两间各再发一发(旧写法要等用户点进播放器 / 房主下一场开播 / 下次重启)', d1 && playCount('z2') === 2 && playCount('z3') === 2, `z2=${playCount('z2')} z3=${playCount('z3')}`)
  watcher.resweepPrewarm('pandalive')
  watcher.resweepPrewarm('pandalive')
  await sleep(250)
  check('T60-6 补扫只补差集: 源已到手或还在队列里的房一发不多(连点三次不多买一整链)', playCount('z2') === 2 && playCount('z3') === 2 && watcher.prewarmQueue.pandalive.length === 0, `z2=${playCount('z2')} z3=${playCount('z3')} 队列=${watcher.prewarmQueue.pandalive.length}`)
  check('T60-7 只点名的那一台: SOOP 那条替身一次调用没有(不顺手替邻居买源)', !world.soopCalls.some((c) => String(c).startsWith('getPlayCached:')))
  db.settings.monitor.pandalive.prefetchStream = false
  api.clearPlayCache()
  watcher.resweepPrewarm('pandalive')
  await sleep(250)
  check('T60-8 不绕过预取开关: 关着就是零排队、零请求(复用首轮那一格, 开关判据同源)', playCount('z2') === 2 && watcher.prewarmQueue.pandalive.length === 0, `实发=${playCount('z2')} 队列=${watcher.prewarmQueue.pandalive.length}`)
}

console.log('解读: T1/T2/T3 PASS ⇒ 「大厅轮询刷新会清源缓存」不成立(真实源码+可计数请求实证);')
console.log('      T4 PASS ⇒ 列表内开播翻转的作废链路正常工作(对照);')
console.log('      T17 PASS ⇒ 粉丝房 fanLive 专用通知+自录正常; T18 PASS ⇒ 下播 toast 单发, 重复判离线不重复;')
console.log('      T19/T20 PASS ⇒ 下播守卫/双通道竞态: 取关不播下播通知, 双通道同发现仍单发; T21/T22 PASS ⇒ 自录失败不伤链路, 开关矩阵闭合.')
console.log('      T5/T6 PASS ⇒ applyBj 快照修复生效: 列表外/单独模式开播的 通知+预取+自录+源作废 全链路恢复;')
console.log('      T7 PASS ⇒ 开播时 500 名外: 兜底通道能完整拿到 通知/自录/预取/开播数据, 发现后 urgent 每轮跟进;')
console.log('      T8 PASS ⇒ 方案A间隙泵: 发现延迟 ≈ N×gap(秒~分钟级), 与轮询间隔(30s/300s)完全脱钩;')
console.log('      T9/T13 PASS ⇒ 泵失败语义: RiskError 立即熔断停扫, 普通错误即停不熔断, 下轮新快照恢复;')
console.log('      T15 PASS ⇒ 熔断闭环: 冷却零请求压制 → 过期恢复熔断复位 → 断档者补扫;')
console.log('      T10 PASS ⇒ 让路语义: round 进行中泵不消费(loop.pandalive.inFlight), 轮后才继续;')
console.log('      T10b PASS ⇒ 同一条 break 的直接取证(T10 那一发同时被共享限速队列挡着, 撤掉 break 也测不出差别):')
console.log('                    在飞即零请求、队列原样留着、轮次落地后照扫.')
console.log('      T11 PASS ⇒ 取关守卫: 快照内取关者不发请求, 飞行窗口开播事件不落(无幽灵 toast/自录), 预取队列残留同挡;')
console.log('      T12 PASS ⇒ 模式切换: per-anchor 分支清 idleQueue, 泵无重复职责;')
console.log('      T14 PASS ⇒ urgent 回归: 列表外在播主播仍轮内每轮全查, 不被泵重复;')
console.log('      T16 PASS ⇒ 大厅/关注一份请求两用: 列表可见关注零增量, 全轮请求数恒等于 页数+urgent+rest.')
console.log('      T25 PASS ⇒ 取源回写按字段合并: 这一路观察不到的 isAdult 不再被写成 false(19+ 旗不被抹掉), 观察得到的 isPw 照写.')
console.log('      T26 PASS ⇒ 监控分家: 预取开关只关本平台那格的秒开, 轮询间隔各按自己那一格, Panda 熔断只压自己那条时间轴.')
console.log('      T27 PASS ⇒ 预言机: 一轮一发覆盖全部关注(0 全站榜/0 探针/覆盖数可核对), 开播事件链路不变, 下播两轮才翻,'
  + ' 列表不可用/风控/匿名/判死会话四种情形都回落且不把"没读到"判成"全员下播"; 会话门只挡匿名, "罐在但没证明"先问一句 login_info(冷启动第一轮当场转上预言机, 不再整轮落回四页);'
  + ' 大厅改按需(60 秒复用、手动强刷、熔断与退避期拒发、失败保留旧快照、并发合并在飞那次、快照换了钟跟着换).')
console.log('      T24-12b/c/d PASS ⇒ SOOP 失明跨阈值即武装自己的退避: 冷却轮整轮零请求、不刷心跳读数、未读数不归零; 到期后第一轮才恢复判定.')
console.log('      T28 PASS ⇒ 降级探针有每轮预算: 45 个关注一轮 40 发, 被挡下的下一轮排到队首(两轮并集覆盖全部), 未读数把挡下的一起数进去;'
  + ' 列表覆盖常态 2 个缺席房就发 2 发, 预算不动刀(与改造前一字不差).')
console.log('      T29 PASS ⇒ 作废纪元: 显式作废/换号之后, 先于它发出的那条链照还给调用方但不落缓存, 种子只认真源(坏源不种),'
  + ' 种子命中下一次取流零请求(续录不再打第二条完整链).')
console.log('      T30 PASS ⇒ 立即刷新有每平台 8 秒下限: 一轮刚落地的连点零请求, 过了下限那一格照发, 两平台各算各的.')
console.log('      T31 PASS ⇒ 判死期的 login_info 探针 5 分钟不再复读(30 秒结果缓存短于轮询间隔这一段由手动清缓存复刻),'
  + ' 但 netFail(请求失败)不节流也不武装 —— 读不到 ≠ 判死; 到期后重新问一句.')
console.log('      T32 PASS ⇒ 全站榜分页只有一处实现: 兜底轮与大厅同时启动共走一条在飞锁(一趟页), 锁用完即撒;'
  + ' 同一发失败的两种吃法 —— 大厅保留旧快照不抛错, 轮次必须记为本轮失败且不把在播读数改口.')
console.log('      T33 PASS ⇒ 预取补扫挪到首轮之后: 排队发生在真值写回之后, 跳过手上已有源的房, 只跑首轮, 开关读本平台那一格, 缓存清单也读本平台那一份.')
console.log('      T34/T34b PASS ⇒ 门槛回执记账: 那五个码 15 分钟内不再重打整链, 而带密码/强刷/作废/换号四种事件都即时重新问;'
  + ' 密码房根本不进预取队列(预取那一路永远没有密码).')
console.log('      T35 PASS ⇒ 预取那一发只解最高档(fullVariants=false)且不强制重打(forceFresh=false) —— 满档由用户真的进房那一次买.')
console.log('      T36 PASS ⇒ 预取泵与 pumpIdle 同规约: 一轮在飞时零发(单房 2~6 发不叠在整表那一发上)、停轮即停泵且两队一起清,'
  + ' 而让路本身不清队 —— 轮次落地重新点泵, 排在后面的房照旧秒开.')
console.log('      T37 PASS ⇒ 降级态只加留痕、不减发(P1-1 改判): 列表整表不可用而整页读得动的那一种形状, 旧写法在日志里完全隐形'
  + ' (冷却/连败/提醒一条都不触发 ⇒ 5.76 万发整页/天可以永远不停), 现在每轮一句带连续轮数的回执;'
  + ' 而"压探针节奏"这一半撤销了 —— rows===null 时逐房整页就是检测路径, 压它等于拿开播时效换流量, 这笔交易没谈过.')
console.log('      T37-E PASS ⇒ ① 「整表读通而这一间不在里面」那一支出声了(真机 hag1947: 一天 ≈1,358 发整页、全天只有 1 行留痕):'
  + ' 掉出报一次、回来报一次、中间每轮不许报名, 且探针一发没减(减不减是用户的三档, 不是这层偷偷定的).')
console.log('      T34c PASS ⇒ ③ 结构性门槛账(needAdult/needUnlimitItem/needCoinPurchase)跨重启落盘: 冷启动读回同一句话零发(实测 24 次冷启动/日、一天 81 行受限回执),'
  + ' needFan/castEnd 不落盘; 到期、平台改口(真拿到源)、开播事件、换号四条路都连盘一起清, 无账不写.')
console.log('      T38 PASS ⇒ 预取泵两道新闸: Panda 那本风控账(任何一发风控形状都记账, 冷却期整条队列收手、撤账即恢复)'
  + ' + 出队时按当下真值重判在播(排空要几分钟, 散场房不再为其拉整条链; 取关守卫同一次查找顺手判, 没有松动).')
console.log('      T39 PASS ⇒ 间隙泵有续扫游标: 快照整批替换 + shift 消费 ⇒ 一轮扫不完的下一轮从没扫到的那一间接着扫(三批×两发覆盖六间,'
  + ' 旧写法是同一对房扫三遍而队尾一次都轮不到); 消费每间只计一次, 空快照即游标归零.')
console.log('      T40 PASS ⇒ (C1) 冷却期不再全盲: 每 5 分钟一发站内关注列表, 读到当场解除退避(那句"30s 是为了早点探到恢复"从此有落点),'
  + ' 读不到就安静且不改口; 扇出面(全站榜分页/逐房探针/间隙泵)在退避期仍是一条不发; 匿名态那一发注定没人接, 整轮零请求照旧.')
console.log('      T41 PASS ⇒ (C4) 手工添加的离线房当场进间隙泵且排到队首(旧写法等下一轮才被快照收走);'
  + ' 在播/判死/表里没有/SOOP 四条守卫与去重一条不松, 双平台同号不串味.')
console.log('      T42 PASS ⇒ (C8) 自录房插到预取队首(队列排空要几分钟, 录制不该自己等一整轮泵); 请求数一字不减, 去重与密码房守卫不变.')
console.log('      T43 PASS ⇒ (C2) 零关注的 Panda 一轮整轮零请求(旧写法照样翻满全站榜页, 一个读数都不为谁而读), 且退避账一并作废 ——'
  + ' 日后加回关注不会被上一场的旧冷却闷住; 早退在预言机上游, 登录态也不为空表发那一发.')
console.log('      T44 PASS ⇒ 风控账管到轮次扇出面: 冷却期读不到整表时只发站内关注那一发, 全站榜/逐房复查/间隙泵一起收手'
  + ' (旧写法把"被拦下"当换更贵问法的扳机 ⇒ 现场量级 ≈110 发/轮、轮距 120s ≈8 万发/天, 而那段请求一发也换不回读数);'
  + ' 撤账当轮立刻回落那条链(时效没被换掉), 间隙泵收手不清队, 且这两面在日志里第一次有了数(连续轮数+逐房发数+快照量).')
console.log('      T45 PASS ⇒ SOOP 连续失明第 3 轮起, 预取不再为"手上没有场次号"的房买那一整页(有号的照旧秒开);'
  + ' 跳过=排回队尾不作废, 整条队列都是这一形状时出泵不空转; 检测面那两间各一发一字不少 —— 那是开播发现路径, 压它就是拿时效换流量(的判据).')
console.log('      T47 PASS ⇒ 风控账收下"HTTP 200 + 业务码里那句请求太多"(bj/关注列表/play 三个出口), 且这本账分成两格:'
  + ' 逐房那一发只抬总账(后台预取与重铸收手), 整表那一发亲口被拒才抬整表格(轮次扇出与间隙泵收手) —— 未登录/改版那两种读不到一句都不记;'
  + ' 记账三个出口的返回契约一字没动(回 null 仍回 null, 报错仍报错).')
console.log('      T48 PASS ⇒ 预取泵认那张"预言机已报下播、正等第二轮确认"的表: 排队与出队两头都挡(现场实拍 22 发整页全回 offline=true),'
  + ' 跳过=排回队尾不作废且整队都在等时出泵, 读数一推翻下一趟照买; 检测面那一发照发 —— 下播判定要的就是第二发读数, 预取无权替它收手.')
console.log('      T49 PASS ⇒ 失明判据从 rows===null 改口 covered===0: 整表读通而我的关注一个都不在里面那一种形状过去永远记 0,'
  + ' 于是那道预取闸门从不落地(实测 22 发整页白付、blind 恒 0); 现在三轮记到 3 且闸门真落地, 列表覆盖到的当轮归零、闸门立刻开 —— 只改判据, 检测面六发一字不减.')
console.log('      T50 PASS ⇒ 降级轮那一行的三种归因各说一句(未登录 / 会话被服务端作废 / 平台在拒答), 判据全取客户端已有读数:'
  + ' 为归因再问一句 login_info 就是新增请求面(第二轮没有再问), 列表读通当轮旗与那一行一起摘 —— 现场那 40 分钟无人知情的形状从此在界面上持续说话, 而这一轮的发数一字未改.')
console.log('      T59 PASS ⇒ (1) 预取失败有了下一次: 60/120/180 秒退避补排、每房每场封顶三次(最多多 3 发),'
  + ' 拿到源即销账; 门槛房补排三次而一发不多(吃的是门槛账的短路), needPassword 那一句根本不补;'
  + ' 停轮·取关·关掉本平台预取到点都重新过闸 —— 旧写法一次抖动就把这间永久逐出预取集(真机 12:15:24 那一发之后再无尝试).'
  + ' 三处取证手法是变异逼出来的: S19 类"读日志"会被自己的 60 秒节流吞掉(改读计数器), 停轮那一格必须在下停的当刻读(未撤的定时器会自己摘帽),'
  + ' 取关那一格必须盯"有没有去排队"(泵出队那头还有一道同族闸门替它挡住了实发数).')
console.log('      T60 PASS ⇒ 两条"清过源账之后谁再排队"都是活的: start 把两平台轮数归零 ⇒ 关-开监控后的第一轮真算作首轮、补扫再来一次;'
  + ' 登录成功清完 playCache 之后当场点名补扫 ⇒ 在播房不必等用户点进播放器就重新拿到源。补扫复用首轮那一格, 所以旧闸一起跟着:'
  + ' 只补差集(源已到手或仍在队里的房一发不多)、只动点名的那个平台(邻居零调用)、关掉本平台预取即零排队零请求。'
  + ' 两处旧写法合起来的形状是: 源被清掉之后, 除非用户亲手点进播放器, 这批房在这台机器剩下的寿命里都不再有源.')
process.exit(failures === 0 ? 0 : 1)
