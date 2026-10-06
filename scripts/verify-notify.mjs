// ============================================================================
// 验证脚本: 通知矩阵(D4) —— 老设置迁移 + 平台 × 事件 × 通道 三路门禁 + 锚点读库补齐
//
// 方法: store.ts 用真实源码(sucrase 现编译)+ 临时 dataDir, 专测读库补齐与落盘;
//       notify.ts 用真实源码 + electron/secrets/telegram 替身, 替身只负责"有没有出货"计数.
// 场景:
//   A1  老库全局开关 → 矩阵逐格展开(一条不多一条不少, 老用户不该被默认值改行为)
//   A2  老库关掉系统通知 → 矩阵系统列全 false(不被 DEFAULT 的 true 复活)
//   A3 老库缺 tg* 键 → 回落值与 DEFAULT_SETTINGS 完全一致; 三个全局节奏键展开成两平台各一格
//   A4  老库 autoRecordDefault 是单布尔 → 铺到两平台
//   A5  迁移后落盘: 九个死键必须消失
//   A6  全新安装(无 settings 段) → 与 DEFAULT_SETTINGS.notify 同构
//   A7  新库只写半格 → 缺格回落"本事件默认", 绝不拿另一平台的值串台(通知矩阵与节奏矩阵同规约)
//   A8  setSettings 提交半格矩阵 → 未提交的格保留(浅合并会整块抹掉)
//   A9  setSettings 提交半格 autoRecordDefault / monitor → 另一平台保留
//   B1  系统通知列按平台独立
//   B2  事件行独立(同一平台的开播关、下播开)
//   B3  声音列只在开播行, 其余行必 silent
//   B4  Telegram 列按事件独立 + chatId 空则整体不推
//   B5  token 未配置 → 不推且不影响前两路
//   B6  渲染层气泡不受矩阵管制
//   B7  显式 tg.ev 决定归属行(recError 属录制域, circuit 属异常域)
//   B8  toast.type → 行的兜底映射(fanLive/roomChange 归开播, info 归录制)
//   B9  气泡/系统通知标题带平台标签(同名主播跨平台不认错, 标题自带平台词不重复)
//   C1 SOOP 已离线的房带着旧轮 19+: 读库时清成 false, 同对象其它字段不动(真机拍到 papcon0206)
//   C2  Panda 的 19+ 不许被同一条补齐擦掉; 无 tags 的房仍是 null; 缺 platform 的老行按默认平台判
//   C5  补齐幂等(清过再读不再变)
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0
let FAIL = 0
function assert(cond, name, detail = '') {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const types = loadTsFresh('src/shared/types.ts', {})
const { DEFAULT_SETTINGS } = types

/** 递归子集比对: 只要求 expected 里的格子逐一相等, actual 多字段即失败(靠 Object.keys 长度卡) */
function match(actual, expected, prefix = '') {
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return { ok: false, at: prefix || '(root)', want: JSON.stringify(expected), got: String(actual) }
    for (const k of Object.keys(expected)) {
      const r = match(actual[k], expected[k], `${prefix}${prefix ? '.' : ''}${k}`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  return actual === expected ? { ok: true } : { ok: false, at: prefix || '(root)', want: String(expected), got: String(actual) }
}
const same = (actual, expected, name) => {
  const r = match(actual, expected)
  assert(r.ok, name, r.ok ? '' : `${r.at}: 期望 ${r.want}, 实得 ${r.got}`)
}

// ---------- TS 即时编译加载(每个场景全新实例: store 有模块级 db 状态) ----------
function loadTsFresh(rel, mocks) {
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  const localRequire = (id) => {
    if (id in mocks) return mocks[id]
    if (id === '../../shared/types') return types
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const loggerMock = { logger: { info() {}, warn() {}, error() {} } }

/** 用给定 db.json 内容起一个全新 store */
function storeWith(dbJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-notify-'))
  if (dbJson !== null) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(dbJson))
  const { store } = loadTsFresh('src/main/services/store.ts', {
    '../util': { dataDir: () => dir },
    './logger': loggerMock
  })
  return { store, dir, file: path.join(dir, 'db.json') }
}

console.log('\n===== A 老设置 → 通知矩阵: 迁移必须一条不多一条不少 =====\n')

const legacyFull = {
  anchors: [],
  history: [],
  settings: {
    pollIntervalSec: 30,
    notifySystem: true, notifySound: true,
    tgLive: true, tgOffline: false, tgRecord: true, tgError: false,
    autoRecordDefault: true
  }
}

{
  const { store } = storeWith(legacyFull)
  const s = store.getSettings()
  same(s.notify.pandalive, { live: { system: true, telegram: true, sound: true }, offline: { system: true, telegram: false }, record: { system: true, telegram: true }, alert: { system: true, telegram: false } }, 'A1 Panda 四行按老全局开关展开')
  same(s.notify.soop, s.notify.pandalive, 'A1 SOOP 继承同一组老开关(老库没有平台维度, 不凭空关掉任何一路)')
  assert(s.notify.soop !== s.notify.pandalive, 'A1 两平台是各自独立的格子(改一格不牵连另一格)')
  same(s.autoRecordDefault, { pandalive: true, soop: true }, 'A4 老的单布尔 autoRecordDefault 铺到两平台')
}

{
  const { store } = storeWith({ anchors: [], history: [], settings: { ...legacyFull.settings, notifySystem: false, notifySound: false } })
  const n = store.getSettings().notify
  same(n, { pandalive: { live: { system: false, telegram: true, sound: false }, offline: { system: false, telegram: false }, record: { system: false, telegram: true }, alert: { system: false, telegram: false } }, soop: { live: { system: false, telegram: true, sound: false }, offline: { system: false, telegram: false }, record: { system: false, telegram: true }, alert: { system: false, telegram: false } } }, 'A2 老库关了系统通知/提示音 → 矩阵不得用默认 true 把它复活')
}

{
  const { store } = storeWith({ anchors: [], history: [], settings: { pollIntervalSec: 42, requestGapMs: 900, prefetchStream: false } })
  const s = store.getSettings()
  same(s.notify, DEFAULT_SETTINGS.notify, 'A3 老库连 tg* 都没有 → 回落值与 DEFAULT_SETTINGS.notify 逐格相同')
  // 三个老的全局节奏键不再是"留在原地的老字段", 它们展开成两平台各一格 —— 一条不多一条不少
  same(s.monitor.pandalive, { pollIntervalSec: 42, requestGapMs: 900, prefetchStream: false }, 'A3 老库的三个节奏键铺进 Panda 那一格(逐键取值, 不吃默认)')
  same(s.monitor.soop, { pollIntervalSec: 42, requestGapMs: 900, prefetchStream: false }, 'A3 老库只有一份节奏: SOOP 继承同一个值, 不凭空提速也不凭空变慢')
  assert(!('pollIntervalSec' in s) && !('requestGapMs' in s) && !('prefetchStream' in s), 'A3 顶层那三格随展开消失(留着就是设置的第二份真相, 且 setSettings 的浅合并会永远带着它们)')
}

{
  // 新库半格节奏: 只写 SOOP 的一格, 缺的格回落【本平台】默认, 另一平台整块不动
  const { store } = storeWith({ anchors: [], history: [], settings: { monitor: { soop: { pollIntervalSec: 15 } } } })
  const s = store.getSettings()
  assert(s.monitor.soop.pollIntervalSec === 15, 'A7b 半格节奏: 提交的那格照落')
  same(s.monitor.soop, { ...DEFAULT_SETTINGS.monitor.soop, pollIntervalSec: 15 }, 'A7b 缺的格回落本平台默认(不拿 Panda 的值串台)')
  same(s.monitor.pandalive, DEFAULT_SETTINGS.monitor.pandalive, 'A7b 未提交的平台保持默认(不被半格传染)')
}

{
  const { store } = storeWith({ anchors: [], history: [], settings: { monitor: { twitch: { pollIntervalSec: 7 }, soop: { pollIntervalSec: 15 } } } })
  const s = store.getSettings()
  assert(s.monitor.soop.pollIntervalSec === 15, 'A7c 未注册平台不连坐: 同批提交的合法平台照落')
  assert(!('twitch' in s.monitor), 'A7c 未注册平台不落库(库里多一个平台键=设置的第二份真相)')
}

{
  const { store } = storeWith({ anchors: [], history: [] })
  same(store.getSettings().notify, DEFAULT_SETTINGS.notify, 'A6 全新安装(无 settings 段)= 默认矩阵')
  const s = store.getSettings()
  assert(Object.keys(s.notify.pandalive.live).join(',') === 'system,telegram,sound', 'A6 开播行含声音列', Object.keys(s.notify.pandalive.live).join(','))
  assert(Object.keys(s.notify.pandalive.record).join(',') === 'system,telegram', 'A6 非开播行不含声音列(SOOP/Panda 都一样, 界面才敢标「—」)')
}

{
  const { store, file } = storeWith(legacyFull)
  store.setSettings({ monitor: { pandalive: { pollIntervalSec: 55 } } })
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const dead = ['notifySystem', 'notifySound', 'tgLive', 'tgOffline', 'tgRecord', 'tgError', 'pollIntervalSec', 'requestGapMs', 'prefetchStream'].filter((k) => k in onDisk.settings)
  assert(dead.length === 0, 'A5 落盘后九个死键全部消失(不再被读却永久留在库里 = 设置文件的第二份真相)', dead.join(','))
  assert(onDisk.settings.notify?.soop?.offline?.telegram === false, 'A5 落盘的是展开后的矩阵本体')
  assert(onDisk.settings.monitor.pandalive.pollIntervalSec === 55 && onDisk.settings.monitor.soop.pollIntervalSec === 30, 'A5 节奏按平台落盘: 提交的格生效, 另一平台仍是展开出来的老值')
}

{
  // 提交的格取非默认值(true): 默认全关后, 提交 false 会让「回落默认」与「整块抹成 false」长得一模一样, 断言失去分辨力
  const { store } = storeWith({
    anchors: [], history: [],
    settings: { notify: { soop: { live: { system: true } } } }
  })
  const n = store.getSettings().notify
  same(n.soop.live, { ...DEFAULT_SETTINGS.notify.soop.live, system: true }, 'A7 新库半格矩阵: 缺格回落本事件默认(DEFAULT_SETTINGS), 提交的格照落')
  same(n.soop.offline, DEFAULT_SETTINGS.notify.soop.offline, 'A7 同平台未提交的事件各自回落自己的默认(不拿别行串台)')
  same(n.pandalive, DEFAULT_SETTINGS.notify.pandalive, 'A7 未提交的平台保持默认(不被半格传染)')
}

{
  const { store } = storeWith(legacyFull)
  const before = JSON.parse(JSON.stringify(store.getSettings().notify))
  const after = store.setSettings({ notify: { soop: { live: { system: false } } } }).notify
  assert(after.soop.live.system === false, 'A8 提交的半格生效')
  same({ p: after.pandalive, soopRest: { offline: after.soop.offline, record: after.soop.record, alert: after.soop.alert }, sound: after.soop.live.sound, tg: after.soop.live.telegram },
    { p: before.pandalive, soopRest: { offline: before.soop.offline, record: before.soop.record, alert: before.soop.alert }, sound: before.soop.live.sound, tg: before.soop.live.telegram },
    'A8 半格提交不抹掉未提交的格(浅合并会把整张表换成这半格)')
  const auto = store.setSettings({ autoRecordDefault: { pandalive: false } }).autoRecordDefault
  same(auto, { pandalive: false, soop: true }, 'A9 半格 autoRecordDefault 只改本平台')
  // 节奏矩阵同规约 —— 提交半格(只给 SOOP 的一格)不许把 Panda 那一格换成默认
  store.setSettings({ monitor: { pandalive: { pollIntervalSec: 90, requestGapMs: 3000, prefetchStream: false } } })
  const mBefore = JSON.parse(JSON.stringify(store.getSettings().monitor))
  const mAfter = store.setSettings({ monitor: { soop: { pollIntervalSec: 20 } } }).monitor
  assert(mAfter.soop.pollIntervalSec === 20, 'A9b 半格节奏提交生效')
  same(mAfter.pandalive, mBefore.pandalive, 'A9b 只交 SOOP 的一格时 Panda 整格原样保住(浅合并会把另一平台换成默认)')
  same(mAfter.soop, { ...mBefore.soop, pollIntervalSec: 20 }, 'A9b 同一平台未提交的格也保住(半格≠整格覆写)')
}

console.log('\n===== B 三路门禁: 平台 × 事件 × 通道 =====\n')

// ---- notify.ts 的世界: 替身只做"有没有出货"计数 ----
const world = { sends: [], built: [], shown: [], pushes: [], token: 'TOKEN', chatId: '1' }

class NotificationMock {
  constructor(opts) {
    world.built.push(opts)
    Object.assign(this, opts)
  }
  on() {}
  show() { world.shown.push(this) }
  static isSupported() { return true }
}

function loadNotify(settings) {
  world.sends.length = 0
  world.built.length = 0
  world.shown.length = 0
  world.pushes.length = 0
  const win = { webContents: { send: (_ch, t) => world.sends.push(t) }, show() {}, focus() {} }
  const mocks = {
    electron: { BrowserWindow: { getAllWindows: () => [win] }, Notification: NotificationMock },
    './store': { store: { getSettings: () => settings } },
    './secrets': { secrets: { get: () => world.token } },
    './telegram': { tgPush: async (token, chatId, ev, toast, ctx) => { world.pushes.push({ token, chatId, ev, toast, ctx }); return { ok: true, message: 'ok' } } },
    './tgFormat': {},
    './logger': loggerMock,
    '../i18n': { mt: (k) => k }
  }
  return loadTsFresh('src/main/services/notify.ts', mocks)
}

/** B 组底: 显式全开矩阵。B 组验的是「平台 × 事件 × 通道」路由独立性, 底必须自己写死 ——
 *  拿 DEFAULT_SETTINGS 当底, 改产品默认值(2026-09-30 起全关)会静默改掉一半断言的前提 */
const ON_MATRIX = {
  pandalive: {
    live: { system: true, telegram: true, sound: true },
    offline: { system: true, telegram: true },
    record: { system: true, telegram: true },
    alert: { system: true, telegram: true }
  },
  soop: {
    live: { system: true, telegram: true, sound: true },
    offline: { system: true, telegram: true },
    record: { system: true, telegram: true },
    alert: { system: true, telegram: true }
  }
}

/** 以全开矩阵为底, 按 p.event.channel 路径打补丁 */
function cfg(patch, extra = {}) {
  const n = JSON.parse(JSON.stringify(ON_MATRIX))
  for (const [k, v] of Object.entries(patch)) {
    const [p, e, ch] = k.split('.')
    if (ch) n[p][e][ch] = v
    else n[p][e] = v
  }
  return { ...DEFAULT_SETTINGS, notify: n, tgChatId: world.chatId, ...extra }
}
const toast = (platform, type, title = 't', body = 'b') => ({ platform, type, title, body })

{
  const { sendToast } = loadNotify(cfg({ 'soop.live.system': false }))
  sendToast(toast('pandalive', 'live'))
  assert(world.shown.length === 1, 'B1 Panda 开播 → 弹系统通知')
  sendToast(toast('soop', 'live'))
  assert(world.shown.length === 1, 'B1 同一事件在 SOOP 侧关掉 → 不弹(平台列真的独立)')
  assert(world.sends.length === 2, 'B6 渲染层气泡两平台照送(矩阵只管系统通知与推送)')
}

{
  const { sendToast } = loadNotify(cfg({ 'soop.live.system': false, 'soop.offline.system': true }))
  sendToast(toast('soop', 'offline'))
  assert(world.shown.length === 1, 'B2 同平台关开播留下播: 行与行独立')
}

{
  const r1 = loadNotify(cfg({ 'pandalive.live.sound': true }))
  r1.sendToast(toast('pandalive', 'live'))
  assert(world.built[0]?.silent === false, 'B3 开播行开了提示音 → silent:false')
  const r2 = loadNotify(cfg({ 'pandalive.live.sound': false }))
  r2.sendToast(toast('pandalive', 'live'))
  assert(world.built[0]?.silent === true, 'B3 开播行关掉提示音 → silent:true(静默弹条而非不弹)')
  const r3 = loadNotify(cfg({ 'pandalive.offline': { system: true, telegram: false } }))
  r3.sendToast(toast('pandalive', 'offline'))
  assert(world.built[0]?.silent === true, 'B3 非开播行无声音列 → 恒 silent(界面该格标「—」的根据)')
}

{
  const { sendToast } = loadNotify(cfg({ 'soop.live.telegram': false, 'soop.record.telegram': true }))
  sendToast(toast('soop', 'live'))
  sendToast(toast('soop', 'rec'))
  assert(world.pushes.length === 1 && world.pushes[0].ev === 'recDone', 'B4 Telegram 列按事件独立: 开播不推、录制完成推')
  loadNotify({ ...cfg({}), tgChatId: '' }).sendToast(toast('pandalive', 'rec'))
  assert(world.pushes.length === 0, 'B4 Chat ID 为空 → 任何事件都不推(老行为: 未配置即静默)')
}

{
  const { sendToast } = loadNotify(cfg({}))
  world.token = null
  sendToast(toast('pandalive', 'rec'))
  assert(world.pushes.length === 0, 'B5 token 不在保险箱 → 不推 TG')
  assert(world.shown.length === 1, 'B5 推不动不影响系统通知(旁路不反噬主链)')
  world.token = 'TOKEN'
}

{
  // 全关: 气泡仍是唯一必达通道
  const allOff = JSON.parse(JSON.stringify(ON_MATRIX))
  for (const p of ['pandalive', 'soop']) for (const e of ['live', 'offline', 'record', 'alert']) { allOff[p][e].system = false; allOff[p][e].telegram = false; if ('sound' in allOff[p][e]) allOff[p][e].sound = false }
  const { sendToast } = loadNotify({ ...DEFAULT_SETTINGS, notify: allOff, tgChatId: world.chatId })
  sendToast(toast('soop', 'error'))
  assert(world.shown.length === 0 && world.pushes.length === 0 && world.sends.length === 1, 'B6 矩阵全关时只有应用内气泡存活')
}

{
  // type='error' 落在异常行; 显式 tg.ev 把它改判到录制行
  const { sendToast } = loadNotify(cfg({ 'pandalive.alert.system': false, 'pandalive.record.system': true }))
  sendToast(toast('pandalive', 'error'), { ev: 'recError', ctx: {} })
  assert(world.shown.length === 1, 'B7 录制出错(ev=recError)归录制域: 异常列关掉仍弹条')
  const r2 = loadNotify(cfg({ 'pandalive.alert.system': true, 'pandalive.record.system': false }))
  r2.sendToast(toast('pandalive', 'error'), { ev: 'circuit', ctx: {} })
  assert(world.shown.length === 1, 'B7 熔断(ev=circuit)归异常域: 录制列关掉仍弹条')
  assert(world.pushes.length === 1 && world.pushes[0].ev === 'circuit', 'B7 TG 卡片头沿用调用方给的语义, 不被行归属改写')
}

{
  const { sendToast } = loadNotify(cfg({ 'pandalive.live': { system: false, telegram: false, sound: false }, 'pandalive.record': { system: false, telegram: false } }))
  sendToast(toast('pandalive', 'fanLive'))
  sendToast(toast('pandalive', 'roomChange'))
  sendToast(toast('pandalive', 'info'))
  assert(world.shown.length === 0, 'B8 粉丝开播/换房归开播行, info 归录制行 —— 关掉两行即全静默')
  const r2 = loadNotify(cfg({ 'pandalive.live': { system: true, telegram: true, sound: true } }))
  r2.sendToast(toast('pandalive', 'fanLive'))
  r2.sendToast(toast('pandalive', 'roomChange'))
  assert(world.pushes.length === 2 && world.pushes[0].ev === 'fanLive' && world.pushes[1].ev === 'roomChange', 'B8 兜底映射保留各事件自己的卡片头')
}

{
  // B9 平台标签: 两平台可能有同名主播, 只写昵称的气泡会认错人(TG 卡片头早有同款标签, 应用内/系统通知补齐)
  const { sendToast } = loadNotify(cfg({}))
  sendToast(toast('pandalive', 'live', '张三 开播了'))
  sendToast(toast('soop', 'offline', '张三 下播了'))
  assert(world.sends[0].title === 'Panda · 张三 开播了', 'B9 气泡标题带平台标签', world.sends[0].title)
  assert(world.sends[1].title === 'SOOP · 张三 下播了', 'B9 同名主播在气泡里按平台分得开', world.sends[1].title)
  assert(world.built[0].title === 'Panda · 张三 开播了', 'B9 系统通知标题同标签(不能只有 TG 分得清)', world.built[0].title)
  sendToast(toast('soop', 'error', 'SOOP 监控已失效'))
  assert(world.sends[2].title === 'SOOP 监控已失效', 'B9 标题自带平台词时不重复挂前缀', world.sends[2].title)
}

console.log('\n===== C 锚点读库补齐: SOOP 的旧 19+ 残留 =====\n')

{
  // 在播房的 isAdult 每轮由列表回写成 false, 但**已经离线**的房再无写点(offPatch 保的是房间属性,
  // 而 SOOP 不带这一格)—— 真机拍到 papcon0206 下播后页头仍挂 19+ 徽标, 就在这里收敛
  const soopTagged = { platform: 'soop', userId: 'papcon0206', nick: '유아리', isLive: false, lastLiveAt: '2026-10-01 08:05:00', tags: { isAdult: true, isPw: true, type: 'fan', liveType: 'rec' } }
  const pandaTagged = { platform: 'pandalive', userId: 'lotus82', nick: '강하라', isLive: true, tags: { isAdult: true, isPw: false, type: 'fan', liveType: 'live' } }
  const noTags = { platform: 'soop', userId: 'tnwl9630', nick: 'x', isLive: false, tags: null }
  const legacyNoPlat = { userId: 'old_room', nick: '老行', isLive: false, tags: { isAdult: true, isPw: false, type: '', liveType: '' } }
  const { store } = storeWith({ anchors: [soopTagged, pandaTagged, noTags, legacyNoPlat], history: [], settings: {} })
  const get = (u) => store.listAnchors().find((a) => a.userId === u)
  same(get('papcon0206').tags, { isAdult: false, isPw: true, type: 'fan', liveType: 'rec' }, 'C1 SOOP 旧轮的 19+ 读库即清成 false, 同对象的其它字段一个都不动(只擦这一格)')
  assert(get('lotus82').tags.isAdult === true, 'C2 Panda 的 19+ 是它自己列表维护的正当真值, 补齐不许顺手擦掉')
  assert(get('tnwl9630').tags === null, 'C3 没有 tags 对象的房仍是 null —— 补齐不是"给每个房造一份标签"')
  assert(get('old_room').platform === 'pandalive' && get('old_room').tags.isAdult === true, 'C4 缺 platform 的老行按默认平台(pandalive)补齐, 不得因为"认不出来"被当 SOOP 擦旗')
  const again = storeWith({ anchors: [get('papcon0206')], history: [], settings: {} }).store
  same(again.listAnchors()[0].tags, { isAdult: false, isPw: true, type: 'fan', liveType: 'rec' }, 'C5 补齐幂等: 清过一遍再读一遍, 值与形状都不再变')
}

console.log('\n' + '─'.repeat(72))
console.log(`通过 ${PASS} / 失败 ${FAIL}`)
console.log('解读: A 组 ⇒ 老库升级后通知行为与监控节奏逐格不变(迁移不是重置), 半格提交不抹掉未提交的格;')
console.log('      B 组 ⇒ 系统通知/推送/提示音三路由「平台 × 事件」两个轴独立决定, 应用内气泡永不受管制.')
console.log('      C 组 ⇒ 读库补齐只认 soop 的旧 19+ 残留(它已不是房间属性), 正当真值与 null 形状一律不动.')
process.exit(FAIL === 0 ? 0 : 1)
