// ============================================================================
// 验证脚本: 源保活泵 与 全部拉取通道的交互正确性(do not depend on Electron)
//
// 方法: electron/store/notify 等依赖替换为可计数 mock; 真实加载 pandalive.ts(sucrase 现编译);
//       keepaliveTick 以私有方法直调驱动(等效 60s 定时器, 测试不等待).
// 场景:
//   S1  基线: 缓存源后 tick 只发 CDN 心跳(每源只读主档), 零 pandalive API 请求
//   S2  下播跳过: anchor 离线 → tick 对该源零请求
//   S3  网络层失败不计死: 全网络异常 × 3 tick → 缓存原样, 零重铸(防断网团灭)
//   S4  主档 404 单次不误杀: strike=1 不清缓存
//   S5  主档连续 404: 收尸 + 在播+预取 → 重铸一发, 心跳恢复
//   S6  满员重铸失败: 收尸后保持熄灭, 后续 tick 不再重复打 API
//   S7 副档不再被读: 每轮只点主档一根, 副档的死活本泵结构上看不见
//   S8  vod 回放包: tick 跳过(静态分片无活性概念)
//   S9  开关关闭: keepaliveStream=false → tick 零请求
//   S10 未关注的缓存源(临时进房): 10 分钟宽限内照常养(回访场景)
//   S11 重铸并发去重: 保活重铸与手动拉源同 userId → fetchPlay 实发一次
//   S12 tick 自重叠: 并发两 tick, 第二个立即返回(心跳不翻倍)
//   S13 状态投影: kaStatus 给播放页"播放源卡"读的一格(时刻/档位/开关/清档)
//   S14 重铸风控自闭环: 重铸撞 403 → 全链冷却 5 分钟, 排队中的后续重铸直接丢弃
//   S15 活性时限: 收手只认「不在关注表过 10 分钟」与「已下播过 30 分钟」两格,
//         下播期间本来就零心跳, 而长场次(90 分钟在播)一律照养 —— 时限不许掐活源
//   S16 闸门只关心跳不关记账: keepaliveStream=false 时年龄收手照样落地, 且这一趟零请求
//   S17 扇出收口: 每源一轮只发一发(主档), 副档一读也不读, master 也绝不进心跳
//         —— 实测依据: 变体地址静置 15 分钟 15/15 全活, 而 master 的 IVS 令牌 exp=取源+600s, 到点按令牌语义过期(403 未实拍)
//   S18 风控账统一: 任何一发风控形状(用户请求也算)都立 5 分钟静默, 后台补源据此收手;
//         满员这类业务失败不立账, 换号清账
//   S19 媒体/CDN 那一面也有尽头: fetchText 两型"连上以后不说话"都由我方尺落定,
//         且到点只报失败不换成 Node 的第二发
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0
let FAIL = 0
const fails = []
function assert(cond, name) {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    fails.push(name)
    console.log(`  [FAIL] ${name}`)
  }
}
const tick = () => api.keepaliveTick()
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ---------- 伪造世界 ----------
// 把请求尺压到 1.5 秒(生产默认 20_000, 这一格由 D109a 钉住): S19 要证的是"到点落定"这个形状,
// 不是等真钟 —— 与车道套用 PD_LANE_QUEUE_CAP 压等位上限同一手法
process.env.PD_API_DEADLINE_MS = '1500'
const world = {
  anchors: [], // {userId, isLive}
  playCalls: [], // /v1/live/play 实发记录
  cdnCalls: [], // CDN 请求记录 [{url, via}]
  variantMode: 'ok', // ok | dead404 | all404 | network | secondary404
  playOk: true, // 拉源是否成功(满员=false)
  playLatencyMs: 0,
  // 两型"连上以后不说话"(黑洞代理 hang 档的真机形状): 头也不回 / 头到手而正文停在半路
  hangCdn: false,
  hangBody: false
}

/** 永不自己落地的等待, 只认 signal 那一路(真 fetch 就是这个契约; 不接 signal 的替身测不到尺) */
const hangVia = (signal) =>
  new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) return reject(new Error('This operation was aborted'))
    signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
  })

/** 本尺自己的封顶读数: 变异 M1(把 session 那一头的 signal 摘掉)让替身永远不落地, 于是这一发既不 resolve 也不 reject
 *  —— 套子会挂在 await 上不出声。"挂住"和"绿"在无人盯屏时是同一种失败, 所以每次 await 外面再套一把 6 秒的尺,
 *  把挂起换算成一个能读的数(台架自己的尺, 不是被测代码的尺) */
const withCap = async (p, ms = 6000) => {
  let t
  const v = await Promise.race([p, new Promise((r) => { t = setTimeout(() => r('HANG'), ms) })])
  clearTimeout(t)
  return v
}

const MASTER_TEXT =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nv1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv720.m3u8\n'

const fakeRes = (status, obj) => ({
  status,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  headers: { getSetCookie: () => [] }
})

const fakeFetch = async (url, init = {}) => {
  const u = new URL(url)
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/live/play') {
    const userId = new URLSearchParams(init.body || '').get('userId')
    world.playCalls.push(userId)
    if (world.playLatencyMs) await settle(world.playLatencyMs)
    if (world.play403) return fakeRes(403, 'risk') // rawFetch → RiskError
    if (!world.playOk) return fakeRes(200, { result: false, message: '房间已满员' })
    return fakeRes(200, {
      result: true,
      PlayList: { hls: [{ url: `https://x.live-video.net/${userId}/master.m3u8` }] },
      media: { title: 't', userNick: 'n', liveType: userId === 'recroom' ? 'rec' : 'live', thumbUrl: '', userImg: '' }
    })
  }
  if (u.hostname.endsWith('live-video.net')) {
    world.cdnCalls.push(u.pathname)
    if (world.hangCdn) return await hangVia(init.signal) // 连上以后连头都不回
    if (world.hangBody)
      return { status: 200, text: () => hangVia(init.signal), headers: { getSetCookie: () => [] } } // 头到手, 正文停在半路
    if (u.pathname.endsWith('/master.m3u8')) return fakeRes(200, MASTER_TEXT) // fetchVariants 拉源时一次性
    // 分档心跳行为
    if (world.variantMode === 'network') throw new Error('ECONNRESET(sim)') // 无 httpStatus: 网络层
    if (world.variantMode === 'all404') return fakeRes(404, 'nf')
    if (world.variantMode === 'dead404' && u.pathname.endsWith('/v1080.m3u8')) return fakeRes(404, 'nf')
    if (world.variantMode === 'secondary404' && u.pathname.endsWith('/v720.m3u8')) return fakeRes(404, 'nf')
    return fakeRes(200, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\ns1.ts\n')
  }
  throw new Error('fakeFetch 未分派: ' + url)
}

// ---------- store mock ----------
const db = { anchors: [], settings: null, history: [] }
const store = {
  listAnchors: () => db.anchors,
  updateAnchor: (platform, userId, patch) => {
    const a = db.anchors.find((x) => x.platform === platform && x.userId === userId)
    if (a) Object.assign(a, patch)
  },
  addAnchor: (a) => db.anchors.push(a),
  removeAnchor: (platform, userId) => {
    db.anchors = db.anchors.filter((x) => !(x.platform === platform && x.userId === userId))
  },
  getSettings: () => db.settings,
  setSettings: (p) => {
    db.settings = { ...db.settings, ...p }
    return db.settings
  },
  flush() {},
  listHistory: () => db.history,
  addHistory() {}
}
db.settings = {
  savePath: '', splitSeconds: 900, autoMp4: true, deleteTs: false,
  // 节奏三格按平台分家: 保活泵读的是 monitor.pandalive.prefetchStream(它只养 pandalive 的源)
  monitor: {
    pandalive: { pollIntervalSec: 30, requestGapMs: 300, prefetchStream: true },
    soop: { pollIntervalSec: 30, requestGapMs: 300, prefetchStream: true }
  },
  proxyUrl: '', watchMode: 'list',
  notifySystem: false, notifySound: false, autoRecordDefault: false,
  closeToTray: false, diskLimitGb: 1, keepaliveStream: true,
  mergeMp4: false, mergeDeleteSegments: true, autoRetryRecord: false,
  theme: 'light', locale: 'zh-CN'
}

const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: () => ({ fetch: fakeFetch, setProxy: async () => {}, setUserAgent() {} }) },
    net: { fetch: fakeFetch }
  },
  '../util': { UA: 'verify-script', sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  './vault': { vault: { encrypted: false, load: () => null, save() {}, clear() {} } },
  './logger': { logger: { info() {}, warn() {} } },
  '../i18n': { mt: (k) => k, setMainLocale() {} },
  './store': { store }
}

// ---------- TS 即时编译加载 ----------
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
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const { api } = loadTs('src/main/services/pandalive.ts')

// ---------- 场景 ----------
function resetWorld() {
  db.anchors.length = 0
  world.playCalls.length = 0
  world.cdnCalls.length = 0
  world.variantMode = 'ok'
  world.playOk = true
  world.playLatencyMs = 0
  world.play403 = false
  world.hangCdn = false
  world.hangBody = false
  api.clearPlayCache()
  api.riskUntil = 0 // 风控自闭环账本跨场景复位(S14/: 生产侧随换号清账, 见 clearPlayCache)
}

const variantCount = (userId) => world.cdnCalls.filter((p) => p.includes(`/${userId}/`) && !p.endsWith('/master.m3u8')).length
const markCdn = () => world.cdnCalls.length
const markPlay = () => world.playCalls.length
// 生产侧缓存出口按复合键 roomKey(platform,userId) 报告(types.ts 的跨平台主键约定), 断言同规约
const rk = (userId) => `pandalive:${userId}`
const kaStatus = (userId) => api.keepaliveStatus('pandalive', userId)

console.log('\n===== S1-S12 源保活泵交互验证 =====\n')

// S1 基线 + S7 全档齐养
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
const apiCallsAtCache = markPlay()
await tick()
assert(variantCount('a') === 1, 'S1-1 每 tick 每源只读主档一发(扇出收口: 副档不靠心跳续命, 实测静置 15 分钟 15/15 全活)')
assert(markPlay() === apiCallsAtCache, 'S1-2 保活 tick 零 pandalive API 请求(fetchPlay/fetchBj)')
assert(api.cachedSourceIds().includes(rk('a')), 'S1-3 缓存保持有效')

// S2 下播跳过
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
db.anchors[0].isLive = false // 下播
const c0 = markCdn()
await tick()
assert(world.cdnCalls.length === c0, 'S2 已下播主播的缓存源: tick 零心跳(死亡属预期, 不耗请求)')

// S3 网络层失败 ×3 不团灭
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
world.variantMode = 'network'
await tick()
await tick()
await tick()
assert(api.cachedSourceIds().includes(rk('a')), 'S3-1 网络层异常 × 3 tick: 缓存不动, 无误收尸')
assert(world.playCalls.filter((u) => u === 'a').length === 1, 'S3-2 网络层异常: 零重铸 API 调用')

// S4 主档 404 单次不误杀
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
world.variantMode = 'dead404'
await tick()
assert(api.cachedSourceIds().includes(rk('a')), 'S4 主档 404 × 1: strike=1, 缓存保留(单次不误杀)')

// S5 连续两次真死: 收尸 + 重铸一发
await tick() // 第二次 dead404
// 重铸经串行链(含 ~1.2s 抖动间隙)延后执行: 轮询等待实发(上限 3s)
for (let i = 0; i < 30 && world.playCalls.filter((u) => u === 'a').length < 2; i++) await settle(100)
assert(world.playCalls.filter((u) => u === 'a').length === 2, 'S5-1 连续 2 次真死: 收尸后重铸 fetchPlay 一发')
assert(api.cachedSourceIds().includes(rk('a')), 'S5-2 重铸成功(房未满): 缓存复活, 心跳可恢复')
world.variantMode = 'ok'
const s5Mark = markCdn()
await tick()
assert(world.cdnCalls.length - s5Mark === 1, 'S5-3 重铸后心跳继续(新源已接管): 一轮恰好一发, 不多打副档')

// S6 满员: 重铸失败, 保持熄灭且不再骚扰 API
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'full', isLive: true })
await api.getPlayCached('full')
world.variantMode = 'dead404'
await tick()
world.playOk = false // 房间满员
await tick()
for (let i = 0; i < 30 && world.playCalls.filter((u) => u === 'full').length < 2; i++) await settle(100) // 重铸链轮询待尽
const playsAfterFull = world.playCalls.filter((u) => u === 'full').length
assert(playsAfterFull === 2 && !api.cachedSourceIds().includes(rk('full')), 'S6-1 满员: 收尸+重铸一发失败后保持熄灭')
const playsMark = world.playCalls.filter((u) => u === 'full').length
await tick()
await tick()
assert(world.playCalls.filter((u) => u === 'full').length === playsMark, 'S6-2 熄灭的源: 后续 tick 零心跳零重试(不再骚扰 API)')

// S7 副档不再被读(扇出收口)
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
world.variantMode = 'secondary404'
await tick()
await tick()
assert(api.cachedSourceIds().includes(rk('a')), 'S7-1 副档 404 × 2: 不收尸(判死只认主档)')
assert(world.playCalls.filter((u) => u === 'a').length === 1, 'S7-2 副档 404: 零重铸')
assert(
  world.cdnCalls.filter((p) => p.endsWith('/v720.m3u8')).length === 0,
  'S7-3 副档清单一次都没被读(正面证据): 旧写法每 tick 各点一根, 而它的失败在本泵只有观测价值'
)

// S8 vod 回放包跳过
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'recroom', isLive: true })
await api.getPlayCached('recroom') // liveType=rec → vod 包
const c1 = markCdn()
await tick()
assert(world.cdnCalls.length === c1, 'S8 vod 回放包: tick 零心跳(静态分片无活性)')

// S9 开关关闭零请求
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
store.setSettings({ keepaliveStream: false })
const c2 = markCdn()
await tick()
assert(world.cdnCalls.length === c2, 'S9 keepaliveStream=false: tick 零请求(开关即时生效)')
store.setSettings({ keepaliveStream: true })

// S10 未关注的缓存源照常养
resetWorld()
await api.getPlayCached('guest') // 临时进房, 不在关注列表
await tick()
assert(variantCount('guest') === 1, 'S10 未关注缓存源(回访场景): 宽限内照常一发主档')

// S11 重铸与手动拉源并发去重
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
world.variantMode = 'dead404'
world.playLatencyMs = 120
await tick() // strike=1
await tick() // strike=2: 收尸+重铸经串行链延迟
for (let i = 0; i < 30 && world.playCalls.filter((u) => u === 'a').length < 2; i++) await settle(100) // 待重铸实发(在飞, 120ms 延迟)
const manualP = api.getPlayCached('a') // 用户同时手动进房 → 应命中在途复用而非再发一发
await settle(200)
await manualP
assert(world.playCalls.filter((u) => u === 'a').length === 2, 'S11 重铸×手动并发: playInflight 去重合并, fetchPlay 实发 2 次(基线1+合并1)而非 3')

// S12 tick 自重叠防护
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
world.variantMode = 'ok'
const c3 = markCdn()
const p1 = tick()
const p2 = tick() // 应立即空返回
await Promise.all([p1, p2])
assert(variantCount('a') === 1 + 0, 'S12 并发 tick: keepaliveBusy 守卫, 心跳不翻倍')

// S13 状态投影(播放页"播放源卡"数据源)
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'a', isLive: true })
await api.getPlayCached('a')
let st = kaStatus('a')
assert(st.cached === true && st.lastAt === 0, 'S13-1 首心跳前投影: cached=true, lastAt=0(未心跳)')
await tick()
st = kaStatus('a')
assert(st.lastAt > 0 && st.lastOk && st.variants === 2 && st.enabled === true, 'S13-2 心跳后投影: 时刻/档位/开关齐备')
const at1 = st.lastAt
db.anchors[0].isLive = false
await tick()
assert(kaStatus('a').lastAt === at1, 'S13-3 下播 tick 跳过: 心跳时刻不前进')
store.setSettings({ keepaliveStream: false })
assert(kaStatus('a').enabled === false, 'S13-4 enabled 实时反映设置开关')
store.setSettings({ keepaliveStream: true })
api.invalidatePlay('a')
st = kaStatus('a')
assert(st.cached === false && st.lastAt === 0, 'S13-5 作废后状态清档(不残留尸态)')

// S14 重铸风控自闭环: 重铸撞 403 → 全链冷却 5 分钟, 后续收尸重铸直接丢弃(零请求)
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'd1', isLive: true }, { platform: 'pandalive', userId: 'd2', isLive: true })
await api.getPlayCached('d1')
await api.getPlayCached('d2')
world.variantMode = 'dead404'
world.play403 = true
world.playLatencyMs = 150 // 重铸 d1 慢行: 保证 d2 在冷却立下之前已入队 —— 专治"时序运气"(结构检查必考)
await tick() // 双双 strike=1
await tick() // 双双收尸 → d1 重铸撞 403 → 冷却; d2 入队即丢弃(链步内二次检查)
for (let i = 0; i < 30 && world.playCalls.filter((u) => u === 'd1').length < 2; i++) await settle(100)
await settle(300) // 留 d2 若有漏按的时间(不应有)
assert(kaStatus('d1').cached === false, 'S14-1 重铸撞风控后保持熄灭')
assert(world.playCalls.filter((u) => u === 'd1').length === 2, 'S14-2 d1 重铸整好一发(撞风控那发)')
assert(world.playCalls.filter((u) => u === 'd2').length === 1, 'S14-3 冷却期后续重铸被丢弃: d2 零额外 API 请求')

// S15 活性时限: 泵只养"还活得有意义的源" —— 未关注的过宽限、已下播的过时限, 都出队且不再发心跳
resetWorld()
await api.getPlayCached('guest2') // 临时进房: 不在关注表
api.playCache.get('guest2').fetchedAt -= 11 * 60_000 // 宽限 10 分钟已过
let c5 = markCdn()
await tick()
assert(kaStatus('guest2').cached === false && world.cdnCalls.length === c5, 'S15-1 未关注源过 10 分钟宽限: 源出队且这一 tick 零心跳(「秒开」徽标随之熄灭)')
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'off', isLive: true })
await api.getPlayCached('off')
db.anchors[0].isLive = false
api.playCache.get('off').fetchedAt -= 31 * 60_000 // 下播房的时限 30 分钟已过
c5 = markCdn()
await tick()
assert(kaStatus('off').cached === false && world.cdnCalls.length === c5, 'S15-2 已下播源过 30 分钟: 出队, 且下播期间本来就零心跳(老纪律 S2/S13-3 不因时限而松动)')
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'long', isLive: true })
await api.getPlayCached('long')
api.playCache.get('long').fetchedAt -= 90 * 60_000 // 在播三小时的长场次
await tick()
assert(kaStatus('long').cached === true && variantCount('long') === 1, 'S15-3 时限不许掐长场次: 仍在播的源挂 90 分钟照养(收手只认"关注表 + 在播"这两格都不满足)')

// S16 闸门只关心跳, 不关记账: 关掉保活后源缓存仍按年龄收手, 且这一趟零网络
resetWorld()
store.setSettings({ keepaliveStream: false })
db.anchors.push({ platform: 'pandalive', userId: 'off2', isLive: true })
await api.getPlayCached('off2')
db.anchors[0].isLive = false
api.playCache.get('off2').fetchedAt -= 31 * 60_000 // 下播且挂了 31 分钟: S15-2 同一格
const c6 = markCdn()
const p6 = markPlay()
await tick()
assert(kaStatus('off2').cached === false, 'S16-1 保活关闭时年龄收手照样落地: 挂满 31 分钟的下播源出队(「已缓存」徽标不再谎报)')
assert(world.cdnCalls.length === c6 && world.playCalls.length === p6, 'S16-2 收手这一趟零请求: 关掉的是心跳, 不是记账')
store.setSettings({ keepaliveStream: true })

// S17 扇出收口: 每源一轮只发一发主档 —— 依据是静置实测(3 房 × 5 档 15 分钟 15/15 全活),
//         加 master 那枚 JWT 现场解出的 exp=签发+600s(到点按令牌语义过期; 那一发 403 无自然样本, 记为量不到), 不是"少发为快"的偏好
resetWorld()
db.anchors.push(
  { platform: 'pandalive', userId: 'f1', isLive: true },
  { platform: 'pandalive', userId: 'f2', isLive: true },
  { platform: 'pandalive', userId: 'f3', isLive: true }
)
for (const id of ['f1', 'f2', 'f3']) await api.getPlayCached(id) // 每房两份档
// 只数这三房自己的路径: 前一场景(S14/S15)留下的重铸链会晚一点补一发 master, 全局计数会被它污染
const at = (suf) => world.cdnCalls.filter((p) => /^\/(f1|f2|f3)\//.test(p) && p.endsWith(suf)).length
await tick()
assert(at('/v1080.m3u8') === 3, 'S17-1 三源一轮恰好三发(旧写法 3 源 × 2 档 = 6 发): 扇出按"源"发而不按"档"发')
assert(
  at('/v720.m3u8') === 0,
  'S17-2 副档一根不点: 切档用的是缓存里那批长效地址(PlayerView 直取 variants[i].url), 与心跳无关'
)
assert(
  at('/master.m3u8') === 3,
  'S17-3 master 绝不进心跳: 每房只在拉源那一刻读过一次; 它的 IVS 令牌 exp=取源+600s(现场解码), 到点即过期, 拿来当活性判据 = 每 10 分钟误收一次尸(整批缓存源被误杀后群重铸)'
)
assert(
  ['f1', 'f2', 'f3'].every((id) => kaStatus(id).variants === 2),
  'S17-4 投影里那格报的是"档在手"(两份档仍报 2)而不是心跳发数: 减发不改变用户手上的菜单'
)

// S18 风控账统一: 冷却不再只由"重铸自己撞风控"点亮 —— 任何一发风控形状(用户那一发也算)都记账,
//         后台两条泵(补源重铸 / 开播预取)据此收手; 换号即清账。判据是"这一站正在高压", 不是"谁撞的"。
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'r1', isLive: true })
world.play403 = true
await api.getPlayCached('r1').catch(() => {}) // 用户手动拉源撞 403: 它自己不看冷却, 照抛给调用方
assert(api.riskCooling(), 'S18-1 用户请求撞风控同样记账(旧账本 remintCooldownUntil 只有重铸链看得见)')
world.play403 = false
await api.getPlayCached('r1') // 补一发有效源, 让收尸路径有的可收
const p18 = markPlay()
world.variantMode = 'dead404'
await tick()
await tick() // 连续 2 次真死 → 收尸 → enqueueRemint
await settle(400)
assert(markPlay() === p18, 'S18-2 冷却期内补源重铸被丢弃: 用户那一发立起的账同样管住后台(零额外 API 请求)')
world.variantMode = 'ok'
api.clearPlayCache()
assert(!api.riskCooling(), 'S18-3 换号即清账: 上一号的风控静默不许闷住新账号的泵(与 SOOP 换号清账同语义)')
// S18-4 非风控的失败不立账: 满员(result=false)是房间状态不是平台高压
resetWorld()
db.anchors.push({ platform: 'pandalive', userId: 'full2', isLive: true })
world.playOk = false
await api.getPlayCached('full2')
assert(!api.riskCooling(), 'S18-4 满员不发风控账: 后台冷却只认风控形状, 不许把"房间满"读成"站在高压"')

// S19 媒体/CDN 那一面也有尽头: fetchText 是那五处之外唯一裸着的请求面
//         (回放清单、master 解析、保活心跳都读它)。真机形状 = 连上以后不说话。
resetWorld()
// 「有没有打第二遍」取证读的是 noteFallback 的计数器, 不是它那一句日志: 日志自带 60 秒节流(节流之前先自增),
// 前面场景一旦点燃气门, S19 这一句就被吞掉 —— 变异 M2(删掉我方尺先抛那一句)当场让整套保持全绿, 就是这个空绿。
// 所以这里把日志那一档拨到未来(全哑), 让 fallbackCnt 在本场景内单调, 增量本身就是兜底开火的铁证。
api.fallbackLogUntil = Date.now() + 600_000
api.fallbackCnt = 0
world.hangCdn = true
const c19 = markCdn()
const t19 = Date.now()
const hung19 = await withCap(api.fetchVodPlaylist('https://x.live-video.net/h1/v1080.m3u8'))
const cost19 = Date.now() - t19
assert(
  hung19 === null && cost19 >= 1400 && cost19 < 6000,
  `S19-1 连上以后连头都不回: 这一发由我方那把尺落定并回"没有正文"(旧写法在这里永不返回, 代价不是"慢"而是"死") —— 实测 ${cost19}ms(台子把尺压到 1.5s, 生产默认 20s 由 D109a 钉; 读数若是 'HANG' 就是那一发根本没落定)`
)
assert(
  markCdn() - c19 === 1 && api.fallbackCnt === 0,
  'S19-2 到点只报失败、不换第二发: 这一面的兜底判据比 sendRaw 宽("除 HTTP 错外一律 Node 再打一遍"), 我方超时必须先于兜底抛出 —— 顺序反了就是同一请求打两遍((e) 要消灭的形状), 而 fallbackCnt 每被喂进兜底一次就 +1(日志会被自己的 60 秒节流吞掉, 计数不会)'
)
world.hangCdn = false
world.hangBody = true
const c19b = markCdn()
const t19b = Date.now()
const hung19b = await withCap(api.fetchVodPlaylist('https://x.live-video.net/h2/v1080.m3u8'))
const cost19b = Date.now() - t19b
assert(
  hung19b === null && cost19b >= 1400 && cost19b < 6000,
  `S19-3 响应头到手而正文停在半路是同一个病: 尺罩住 await res.text() 那一段(${cost19b}ms 落定) —— 只掐 fetch 的写法在这一型上照样永不落地`
)
assert(markCdn() - c19b === 1 && api.fallbackCnt === 0, 'S19-4 正文停住那一型同样只发一发: 兜底没有被"半路的失败"喂到(同一台计数器, 两型各读一次增量)')
world.hangBody = false

console.log(`\n==== 结果: ${PASS} 通过 / ${FAIL} 失败 ====`)
if (FAIL) {
  console.log('失败项:\n - ' + fails.join('\n - '))
  process.exit(1)
}
console.log(`解读: S1/S7 心跳只走 CDN 零 API 占用; S3 网络异常零收尸零重铸(断网不团灭);
      S4/S5 单次不误杀, 连续真死才收尸且重铸仅一发; S6 满员保持熄灭不骚扰;
      S2/S8 下播与回放不耗请求; S10/S15 回访源在 10 分钟宽限内同养、过限出队, 下播源 30 分钟出队(下播期间本就零心跳), 长场次一律照养;
      S11 并发合并; S12 自重叠防护; S14 重铸撞风控即全链冷却, 排队者丢弃(零请求); S16 关掉保活只关掉心跳, 记账照跑(零网络);
      S17 每源一轮一发主档, 副档与 master 都不进心跳(实测: 变体静置 15 分钟 15/15 全活; master 那枚 JWT exp=签发+600s, 到点按令牌语义过期 —— 那一发 403 没有自然样本);
      S18 风控账只认形状不认发起方: 用户那一发撞风控, 后台的补源同样收手(换号清账, 满员不算).`)
