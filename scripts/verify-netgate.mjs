// ============================================================================
// 验证脚本: 按站后台车道 —— src/main/services/netGate.ts 与它的三处接线
//
// 背景: 每一条后台循环自己都有节流(探针、预取泵、Panda 的限速队列各按 requestGapMs 睡觉),
//       漏的是"跨条": 探针 ‖ 预取 ‖ 保活重铸 ‖ 登录探针各自排队, 同一主机上的瞬时速率是它们的和。
//       此前审计里 Panda 的 403 正是落在 api 站这一叠上。
//       这一层只解决一件事: 同一主机名上后台请求一发一发排, 两发之间留一个间隔; 用户那一路不等。
// 方法: netGate 用真实源码(sucrase 现编译), sleep 用真 setTimeout —— 时序就是被测行为本身;
//       pandalive 也只挂真实现, 假 session.fetch 记并发峰谷。主机名只放行 api.pandalive.co.kr
//       与 *.invalid, 其余直接抛 → 任何漏网请求不可能悄悄打到真网络。
//       排队上限(MAX_WAIT_MS=8 秒)只做静态契约(见 verify-design D67e): 要跑满它得让测试真等 8 秒以上,
//       代价全在脚本, 收益只有"这一发挤了多久"一句 —— 真机那一侧由 warn 日志站岗。
//       等位上限(QUEUE_MAX_WAIT_MS, P0-3)反过来必须动态跑: 它要防的是"永不落地",
//       这件事在真机上永远不会自己发生, 不看一眼就等于没写 —— 于是 PD_LANE_QUEUE_CAP 把尺压到 1.2 秒(N11)。
// 场景:
//   N1 同一主机上的后台请求一次只发一发
//   N2 不同主机互不阻塞(车道是按站的, 不是一把全局锁)
//   N3 base>0: 两发起跑之间留出一个间隔(±10% 抖动带内)
//   N4 base=0 完全放行(钳制下限 300ms 是设置页的事, 车道不另发明节奏)
//   N5 用户级(asUser)不排队: 后台正占着车道也立刻放行
//   N6 用户级照样落笔: 它发过以后, 紧随的后台自己让开一个间隔
//   N7 接线: api 站真过车道, 媒体/CDN 那一面(fetchText)不过
//   N8 车道按主机名建
//   N9 源码接线: 用户级标记只在"用户亲自在等"的三处, 后台一处都不标
//   N10 账号页那颗「立即重新校验」真不买等待: 同站被后台占着时用户级立刻放行、后台级照排
//   N11 P0-3 占道那一发永不落地: 等位者按失败收(不硬放行)、交出自己那一格并出声
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 替身网络: 记并发峰谷 ----------
const world = { calls: [], total: 0, inflight: 0, peak: 0, delayMs: 20, status: 200, body: '{}' }
// 单元场景(N1~N6)里没有网络参与 —— 并发峰谷由这只表计: 车道管的是"起跑", 与请求打到哪无关
const occupy = (ms) => async () => {
  world.inflight++
  if (world.inflight > world.peak) world.peak = world.inflight
  await sleep(ms)
  world.inflight--
}
const fakeFetch = async (url) => {
  const u = new URL(url)
  if (u.hostname !== 'api.pandalive.co.kr' && !u.hostname.endsWith('.invalid')) throw new Error('fakeFetch 未分派(不允许真网络): ' + url)
  world.calls.push(url)
  world.total++
  world.inflight++
  if (world.inflight > world.peak) world.peak = world.inflight
  await sleep(world.delayMs)
  world.inflight--
  return { status: world.status, text: async () => world.body, headers: { getSetCookie: () => [] } }
}

const db = {
  anchors: [],
  history: [],
  settings: {
    proxyUrl: '',
    monitor: {
      pandalive: { pollIntervalSec: 60, requestGapMs: 0, prefetchStream: true },
      soop: { pollIntervalSec: 60, requestGapMs: 0, prefetchStream: true }
    }
  }
}
const store = {
  getSettings: () => db.settings,
  listAnchors: () => db.anchors,
  updateAnchor: () => {},
  getAnchor: () => undefined
}

const logs = []
const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: () => ({ fetch: fakeFetch, setProxy: async () => {}, setUserAgent() {} }) },
    net: { fetch: fakeFetch }
  },
  '../util': { UA: 'verify-script', sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  './vault': { vault: { encrypted: false, load: () => null, save() {}, clear() {} } },
  './logger': { logger: { info: (t, m) => logs.push(['info', t, m]), warn: (t, m) => logs.push(['warn', t, m]) } },
  '../i18n': { mt: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), setMainLocale() {} },
  './store': { store }
}

const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const localRequire = (id) => {
    if (id in mocks) return mocks[id]
    // 车道用真实现: 本脚本要测的就是"接上真车道以后各条路怎么走"
    if (id === './netGate') return loadTs('src/main/services/netGate.ts')
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

// P0-3 的刻度: 等位上限生产值是 120 秒(QUEUE_MAX_WAIT_MS), 这一格要测的是"到点以后怎么办",
// 而真等 120 秒不划算 ⇒ 压到 1.2 秒。压它不误伤别的场景:N1~N10 的等位都在几十毫秒量级, 碰不到这个尺
process.env.PD_LANE_QUEUE_CAP = '1200'

const gate = loadTs('src/main/services/netGate.ts')
const { api } = loadTs('src/main/services/pandalive.ts')
const { laneRun, asUser, hostOf } = gate

// 车道表是进程级的、没有按场景复位的生产入口 —— 于是每个场景用自己的主机名,
// 上一场景的落笔不会算进下一场景的间隔(这本身就是"按站建道"要测的那件事)
const reset = () => {
  world.calls.length = 0
  world.inflight = 0
  world.peak = 0
  world.delayMs = 20
  world.status = 200
  world.body = '{}'
}

console.log('\n■ N1 同一主机上的后台请求一次只发一发')
{
  reset()
  const starts = []
  const run = (tag) =>
    laneRun('n1-bg.invalid', 0, async () => {
      starts.push(tag)
      await occupy(25)()
      return tag
    })
  const r = await Promise.all([run('1'), run('2'), run('3')])
  check('N1-1 三发全部落定且按 FIFO 起跑', r.join(',') === '1,2,3' && starts.join(',') === '1,2,3', starts.join(','))
  check('N1-2 全程并发峰谷 = 1(同站并发的形状正是这一层要消灭的)', world.peak === 1, `peak=${world.peak}`)
}

console.log('\n■ N2 不同主机互不阻塞(车道是按站的, 不是一把全局锁)')
{
  reset()
  world.delayMs = 30
  await Promise.all([laneRun('n2-h1.invalid', 0, occupy(30)), laneRun('n2-h2.invalid', 0, occupy(30)), laneRun('n2-h3.invalid', 0, occupy(30))])
  check('N2-1 三站并发峰谷 = 3(串行化不跨站扩散)', world.peak === 3, `peak=${world.peak}`)
  const t0 = Date.now()
  await Promise.all([laneRun('n2-h1.invalid', 0, occupy(30)), laneRun('n2-h4.invalid', 0, occupy(30))])
  check('N2-2 两站各一发总耗时 ≈ 一发而不是两发', Date.now() - t0 < 60, `${Date.now() - t0}ms`)
}

console.log('\n■ N3 base>0: 两发起跑之间留出一个间隔(±10% 抖动带内)')
{
  reset()
  world.delayMs = 0
  const t = []
  const now = () => {
    t.push(Date.now())
    return Promise.resolve()
  }
  await laneRun('n3-bg.invalid', 0, now)
  await laneRun('n3-bg.invalid', 200, now)
  await laneRun('n3-bg.invalid', 200, now)
  const d1 = t[1] - t[0]
  const d2 = t[2] - t[1]
  check('N3-1 第二发起跑距上一发 ≥ 0.9×base(抖动下限)', d1 >= 180, `${d1}ms`)
  check('N3-2 第三发同样留出一个间隔', d2 >= 180, `${d2}ms`)
  check('N3-3 也不超过 1.1×base + 调度余量(车道不许发明额外的慢)', d1 <= 280 && d2 <= 280, `${d1}/${d2}ms`)
}

console.log('\n■ N4 base=0 完全放行(间隔由设置的 requestGapMs 决定, 0 只给脚本用)')
{
  reset()
  world.delayMs = 0
  const t0 = Date.now()
  await Promise.all([laneRun('n4-bg.invalid', 0, () => Promise.resolve()), laneRun('n4-bg.invalid', 0, () => Promise.resolve())])
  check('N4-1 两发之间不额外等待', Date.now() - t0 < 40, `${Date.now() - t0}ms`)
  const neg = await laneRun('n4-bg.invalid', -1, async () => 'ok')
  check('N4-2 负数 base 当 0 处理(不出现"倒退一个间隔"的等待)', neg === 'ok')
}

console.log('\n■ N5 用户级不排队: 后台正占着车道也立刻放行')
{
  reset()
  world.delayMs = 0
  const bg = laneRun('n5-user.invalid', 600, async () => {
    await sleep(40)
    return 'bg'
  })
  await sleep(5) // 让后台确实起跑并占住车道
  const t0 = Date.now()
  const v = await asUser(async () => laneRun('n5-user.invalid', 600, async () => 'now'))
  const waited = Date.now() - t0
  check('N5-1 用户那一发没等(远小于 base)', v === 'now' && waited < 20, `${waited}ms`)
  await bg
  const t1 = Date.now()
  await laneRun('n5-user.invalid', 600, async () => 'bg2')
  check('N5-2 抢在前面的用户那一发不打断既有节奏: 紧随的后台仍让开一个间隔', Date.now() - t1 >= 500, `${Date.now() - t1}ms`)
}

console.log('\n■ N6 用户级照样落笔: 它发过以后后台自己让开')
{
  reset()
  world.delayMs = 0
  const t0 = Date.now()
  await asUser(async () => laneRun('n6-stamp.invalid', 200, async () => 'u'))
  const userCost = Date.now() - t0
  const t1 = Date.now()
  await laneRun('n6-stamp.invalid', 200, async () => 'bg')
  check('N6-1 用户那一发自己不等', userCost < 20, `${userCost}ms`)
  check('N6-2 用户发过以后, 紧随的后台发让开了一个间隔', Date.now() - t1 >= 180, `${Date.now() - t1}ms`)
}

console.log('\n■ N7 接线: api 站真过车道, 媒体/CDN 那一面不过')
{
  reset()
  world.delayMs = 30
  await Promise.all([api.rawFetch('GET', '/v1/a'), api.rawFetch('GET', '/v1/b')])
  check('N7-1 rawFetch 同站并发峰谷 = 1(绕过限速队列的旁路也在车道里)', world.peak === 1, `peak=${world.peak}`)
  check('N7-2 两发都真的发出去了(串行 ≠ 吞请求)', world.calls.length === 2, `${world.calls.length} 发`)
  reset()
  world.delayMs = 30
  await Promise.all([asUser(async () => api.rawFetch('GET', '/v1/p1')), asUser(async () => api.rawFetch('GET', '/v1/p2'))])
  check('N7-3 用户级两发并发即进(取流那一发不被车道拖住)', world.peak === 2, `peak=${world.peak}`)
  reset()
  world.delayMs = 30
  await Promise.all([api.fetchText('https://cdn-a.invalid/1.m3u8'), api.fetchText('https://cdn-b.invalid/2.m3u8')])
  check('N7-4 fetchText(媒体清单)不走车道: 保活泵要在 60 秒里跑完 17 个房 × 若干档, 串起来会把源饿死', world.peak === 2, `peak=${world.peak}`)
  reset()
  world.delayMs = 30
  await Promise.all([api.fetchText('https://same-cdn.invalid/1.m3u8'), api.fetchText('https://same-cdn.invalid/2.m3u8')])
  check('N7-5 同一 CDN 主机的两发也照并发(豁免是按面豁免, 不是换个站再串)', world.peak === 2, `peak=${world.peak}`)
}

console.log('\n■ N8 车道按主机名建')
{
  reset()
  check('N8-1 hostOf 取的是主机名(路径与令牌不参与建道)', hostOf('https://api.pandalive.co.kr/v1/live/play') === 'api.pandalive.co.kr')
  check('N8-2 坏 URL 不抛(拿不到主机名也要能发这一发, 退化成按原串建道)', hostOf('not-a-url') === 'not-a-url')
  await laneRun('n8-x.invalid', 0, async () => 1)
  await laneRun('n8-y.invalid', 0, async () => 1)
  check('N8-3 每个主机各占一条道', ['n1-bg.invalid', 'n8-x.invalid', 'n8-y.invalid', 'api.pandalive.co.kr'].every((h) => gate.laneHosts().includes(h)), gate.laneHosts().join(','))
}

console.log('\n■ N9 源码接线: 用户级标记只在"用户亲自在等"的三处')
{
  const ipc = src('src/main/ipc.ts')
  const rec = src('src/main/services/recorder.ts')
  const wt = src('src/main/services/watcher.ts')
  const so = src('src/main/services/soop.ts')
  const pd = src('src/main/services/pandalive.ts')
  const ng = src('src/main/services/netGate.ts')
  check('N9-1 播放器取流打用户级(且 force 位过 8 秒下限的收敛结果, C7; (②) 入口改秒开快道, 用户级那一格不变)', /r = await asUser\(\(\) => sourceFor\(platform\)\.getPlayFast\(userId, safePwd\(password\), freshNow\)\)/.test(ipc))
  check('N9-2 录制首发改用户级, 断线后的判活那一发仍是后台级', (rec.match(/asUser\(\(\) => sourceFor/g) || []).length === 1)
  check('N9-3 watcher(探针/预取/保活重铸)一处都不标记 = 全在车道里: 只把用户点出来的那一发搬去快速道, 探针那一发一个字没动(它排在车道尾等一个间隔是既有语义)', !/asUser/.test(wt))
  check('N9-4 SOOP 每一发都走 req → laneRun, 间隔取自己的那一格', /return laneRun\(hostOf\(url\), store\.getSettings\(\)\.monitor\.soop\.requestGapMs, \(\) => this\.sendReq\(url, init, timeoutMs, rescueOnTimeout\)\)/.test(so))
  check('N9-5 Panda api 站走 rawFetch → laneRun', /return laneRun\(hostOf\(API\), store\.getSettings\(\)\.monitor\.pandalive\.requestGapMs/.test(pd))
  check('N9-6 标记沿异步链传递(AsyncLocalStorage, 不逐层加参数)', /new AsyncLocalStorage<boolean>\(\)/.test(ng))
  check('N9-7 全程没有触顶告警: 这些场景的排队都在上限内', logs.filter((l) => /车道/.test(l[2] || '')).length === 0, logs.map((l) => l[2]).join(' | '))
  // 复核时把那句「登录/校验绕过车道与风控账」顶回去了 —— 这一发从来就在车道里(N9-4/N9-5),
  // 撞 403/429/5xx/HTML 也照常记账(pandalive sendRaw 五形状 / soop sendReq 每一发都过 noteRisk)。
  // 真的缺的只有"用户亲自在等"那一格: 点下去最坏要等排队上限, 而这颗按钮的全部意义是"现在就问"
  check('N9-8 账号页「立即重新校验」两平台的校验那一发都打用户级, 且仍带 force(标记不改请求, 只改等待)', /await asUser\(\(\) => soopApi\.verifyLogin\(undefined, true\)\)/.test(ipc) && /await asUser\(\(\) => api\.checkLoginInfo\(undefined, true\)\)/.test(ipc), `ipc 里 asUser 实数=${(ipc.match(/asUser\(\(\) =>/g) || []).length}`)
  // 播放器那一条拆成两发(快道取源 + liveMenu 补菜单), 两发都是"用户亲自在等"的形状 ⇒ 都打用户级。
  // 记账的这条数因此从 3 变 4: 登录复检两格 + 取流 + 菜单补齐(录制首发那一处在 recorder.ts 里, 不在这一本账上)
  check('N9-9 快速道只有四处: 登录复检(两平台)/ 取流秒开 / 菜单补齐 —— pushAccounts 与 authWin 都没搬(前者多数时候读缓存零请求, 后者是登录窗自己那一条链)', (ipc.match(/asUser\(\(\) =>/g) || []).length === 4, `ipc 里 asUser 实数=${(ipc.match(/asUser\(\(\) =>/g) || []).length}`)
}

console.log('\n■ N10 那颗按钮买到的不是标记, 是时间: 真车道 + 真 Panda 客户端两侧各量一次')
{
  // 上一节只证明"标了", 这一节证明"标了确实不等 / 没标确实要等"。
  // 间隔取 300ms 而不是真设置的 1200ms: 断言要的是两发之间那个量级差, 而脚本不该为一句话真等两秒
  db.settings.monitor.pandalive.requestGapMs = 300
  const HOST = 'api.pandalive.co.kr' // rawFetch 的键是 hostOf(API), 占道那一发必须撞同一个键
  const timed = async (fn) => {
    const t0 = Date.now()
    const r = await fn()
    return { ms: Date.now() - t0, r }
  }
  const sent0 = world.total
  void laneRun(HOST, 300, occupy(60)) // 后台正占着这一站
  const bg = await timed(() => api.checkLoginInfo(undefined, true)) // 后台级 = 探针/authState 那条既有路
  void laneRun(HOST, 300, occupy(60))
  const user = await timed(() => asUser(() => api.checkLoginInfo(undefined, true))) // 用户点出来的那一发
  check('N10-1 前提自证: 两发都真的打到了官方接口(标记不减发, 也不替它编答案)', world.total === sent0 + 2 && bg.r.isLogin === false && user.r.isLogin === false && bg.r.netFail === false, `新增=${world.total - sent0} bg=${JSON.stringify(bg.r)} user=${JSON.stringify(user.r)}`)
  check('N10-2 后台级那一发照旧排队(等占道那一发落定 + 一个间隔): 这一条语义没动, 动的是下面那一发', bg.ms >= 180, `实等=${bg.ms}ms`)
  check('N10-3 用户级那一发不等: 同一条站被后台占着也当场飞出去(旧写法这颗按钮和后台挤在同一条尾锁之后, 最坏 MAX_WAIT_MS=8 秒)', user.ms < 100, `实等=${user.ms}ms`)
  db.settings.monitor.pandalive.requestGapMs = 0
}

console.log('\n■ N11 P0-3 卡死的那一格有尽头: 等位到点按失败收, 且交出自己那一格')
{
  // 旧写法 `await prev` 没有尽头: 一发永不落地(请求层还不设超时的年代就是这样)就把这一站的后台车道
  // 锁到进程结束, 而且锁得悄无声息。这一节造的就是那个"永不落地"—— 替身 Promise 永远 pending,
  // 除了等位上限自己到点, 没有任何东西能让这一站复活。
  const HOST = 'n11-stuck.invalid'
  const cap = Number(process.env.PD_LANE_QUEUE_CAP)
  let bRan = false
  let cRan = false
  const logs0 = logs.length
  // 等位上限那枚计时器是 unref 的(生产里它不该拖住退出路径), 于是脚本必须自己把事件循环撑住 ——
  // 真进程在这一刻总有别的活计挂着; 不撑住的话 Node 会在 1.2 秒之前就把循环抽干、直接以
  // "unsettled top-level await" 退出, 测到的是脚本的空转而不是车道的到点
  const keep = setInterval(() => {}, 50)
  void laneRun(HOST, 0, () => new Promise(() => {})) // 占道的那发: 永远不返回
  const t0 = Date.now()
  let err = ''
  try {
    await laneRun(HOST, 0, async () => {
      bRan = true
      return '这一发不该跑出去'
    })
  } catch (e) {
    err = String(e && e.message ? e.message : e)
  }
  const waited = Date.now() - t0
  check('N11-1 到点按失败抛出, 而不是硬放行: 等位者真的失败了, 自己那一发一次都没发出去', /等位超时/.test(err) && !bRan, `实等=${waited}ms err=${err}`)
  check('N11-2 它确实等到尺子到点才收(不是立刻假失败把串行跳过)', waited >= cap - 150 && waited < cap + 1200, `cap=${cap}ms 实等=${waited}ms`)
  const c = await laneRun(HOST, 0, async () => {
    cRan = true
    await occupy(15)()
    return 'ok'
  })
  check('N11-3 到点时先交出自己那一格: 后面的等位者照常往下跑, 同一次卡住没有传染整条队', cRan && c === 'ok', `c=${c}`)
  const warn = logs.slice(logs0).find((l) => l[0] === 'warn' && l[1] === 'net' && /未落地/.test(l[2]))
  check('N11-4 不是静默失败: 车道落了一条 warn(旧形状最坏的地方正是"监控死了而日志上看不出来")', warn !== undefined, `warn=${warn ? warn[2].slice(0, 60) : '无'}`)
  const t1 = Date.now()
  const u = await asUser(() => laneRun(HOST, 0, async () => 'user'))
  check('N11-5 封顶只管后台: 同一条站正卡着, 用户级那一发仍然当场飞出去(快速道不该被尺子拦下)', u === 'user' && Date.now() - t1 < 80, `实等=${Date.now() - t1}ms`)
  clearInterval(keep)
}

console.log('\n' + '─'.repeat(72))
check('N0 反空转下限: 替身网络全程真的收到 ≥8 发', world.total >= 8, `累计 ${world.total} 发 / 车道 ${gate.laneHosts().length} 条`)
console.log('\n' + '─'.repeat(72))
console.log(`结果: ${failures === 0 ? '全部按预期' : failures + ' 条与预期不符'}`)
console.log('解读: N1~N2 ⇒ 串行只在站内发生, 不跨站扩散;N3~N4 ⇒ 间隔取自 requestGapMs, 车道不另发明节奏;')
console.log('      N5~N6 ⇒ 用户那一路永远不等, 但它身后的小间隔由它自己算进去;N7~N9 ⇒ 三处接线各在其位;')
console.log('      N10 ⇒ 那颗「立即重新校验」在快速道上量到 31ms, 同一站同一时刻的后台级那一发等的是几百毫秒 —— 标记买到的就是这个差;')
console.log('      N11 ⇒ 占道的那发永不落地时, 等位者在尺子到点按失败收、交出自己那一格并出声 —— 站复活, 但不是靠放开两发在飞。')
process.exit(failures === 0 ? 0 : 1)
