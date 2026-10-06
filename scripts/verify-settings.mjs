// ============================================================================
// 验证脚本: 设置写入链(入站闸门 → store 合并 → db.json → 差量提交)
//
// 起因(2026-09-30 设置页全面审查 P0): 「保存设置」在实机上是静默 no-op ——
//   渲染层提交 {...form.value} 时, notify 矩阵与 autoRecordDefault 仍是 Pinia 响应式代理,
//   IPC 载荷走 structured clone, 代理不可克隆 ⇒ 整个补丁被拒 ⇒ 只有走单键通道的主题/语言存得下去。
//   而 settings:set 此前零校验: 一个非字符串 proxyUrl 能进盘, 之后每次保存都在 applyProxy 抛错,
//   盘已写完 / 界面报错 = 数据与界面分叉。
//
// 方法: sucrase 现编译真实源码(settingsGuard.ts / store.ts / shared/types.ts), 不抄一遍逻辑;
//       dataDir 指向临时目录, logger 收成数组, vue 的 reactive 用来复现「代理不可克隆」。
// 场景:
//   A 闸门逐键: 类型 / 区间夹紧 / 枚举 / 绝对路径 / 投影键 / 未注册键 / 矩阵逐格
//   B 覆盖性: DEFAULT_SETTINGS 的每个键闸门都认识(加设置项只改默认值, 闸门自动跟上)
//   C 端到端: 闸门 → store.setSettings → db.json 真回读(坏值不落盘, 死键不进第二份真相)
//   D P0 复现: 响应式浅展开进 IPC 必抛, 深拷贝脱代理后过
//   E 差量提交: 另一写入方刚落的新值不被旧快照回滚(全量提交就是回滚)
// ============================================================================
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const { reactive, toRaw } = require('vue')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0
let FAIL = 0
const fails = []
function assert(cond, name, detail = '') {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    fails.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------- 临时世界 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-settings-'))
const DATA = path.join(TMP, 'data')
fs.mkdirSync(DATA, { recursive: true })
const DB = path.join(DATA, 'db.json')
const ABS_DIR = path.join(TMP, 'rec')

const logs = { warn: [] }
const mocks = {
  path: require('path'),
  fs: require('fs'),
  '../util': { dataDir: () => DATA, UA: 'ua' },
  './logger': {
    logger: {
      info: () => {},
      warn: (tag, msg) => logs.warn.push(String(msg)),
      error: (tag, msg) => logs.warn.push(String(msg)),
      debug() {},
      flush() {}
    }
  }
}

const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id]
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const types = loadTs('src/shared/types.ts')
const { DEFAULT_SETTINGS } = types
const { sanitizeSettingsPatch } = loadTs('src/main/services/settingsGuard.ts')
const { store } = loadTs('src/main/services/store.ts')

/** 监控节奏的补丁写法: 三格住在 monitor[平台] 里, 提交必须带平台壳 ——
 *  测试里若还写顶层 pollIntervalSec, 那本身就是一次"闸门该不该拒收"的考题, 不该混进场景里 */
const mon = (p, over) => ({ monitor: { [p]: { ...DEFAULT_SETTINGS.monitor[p], ...over } } })

/** 闸门判定: 返回收下的补丁与逐键拒收原因(未收的键取值给 MISSING) */
const MISSING = Symbol('missing')
function gate(patch) {
  const r = sanitizeSettingsPatch(patch)
  return {
    patch: r.patch,
    dropped: r.dropped,
    get: (k) => (Object.prototype.hasOwnProperty.call(r.patch, k) ? r.patch[k] : MISSING)
  }
}
const rejected = (g, k) => g.dropped.some((d) => d.startsWith(`${k}(`))

/** 与设置页 clone() 同一形态: toRaw + structuredClone(代理不可克隆) */
const cloneOf = (s) => structuredClone(toRaw(s))
/** 与设置页 dirtyKeys 同一判据: 逐键 JSON 比对, 主进程投影键不计 */
const PROJECTED = ['tgTokenSet', 'secretsEncrypted']
function diffOf(form, base) {
  const out = {}
  for (const k of Object.keys(form)) {
    if (PROJECTED.includes(k)) continue
    if (JSON.stringify(form[k]) !== JSON.stringify(base[k])) out[k] = form[k]
  }
  return out
}

console.log('\n===== A 入站闸门逐键判定 =====\n')

// A1 合法值原样收下, 一个都不掉
{
  const g = gate({ monitor: { pandalive: { pollIntervalSec: 45 } }, proxyUrl: 'http://127.0.0.1:7899', theme: 'dark' })
  assert(g.dropped.length === 0, 'A1 合法补丁零拒收', g.dropped.join(', '))
  assert(g.get('monitor').pandalive.pollIntervalSec === 45 && g.get('theme') === 'dark', 'A1b 收下的值不变形')
}
// A2 未注册键拒收且点名(而不是静默落盘成第二份真相)
{
  const g = gate({ evilKey: 1, ...mon('pandalive', { pollIntervalSec: 45 }) })
  assert(rejected(g, 'evilKey'), 'A2 未注册键拒收并点名')
  assert(g.get('evilKey') === MISSING, 'A2b 未注册键不进补丁')
  assert(g.get('monitor').pandalive.pollIntervalSec === 45, 'A2c 一键越界不连坐其它键')
}
// A3/A4 主进程投影字段: 真值在保险箱, 渲染层回传一律忽略
{
  const g = gate({ tgTokenSet: false, secretsEncrypted: false, theme: 'light' })
  assert(rejected(g, 'tgTokenSet') && rejected(g, 'secretsEncrypted'), 'A3 投影键(tgTokenSet/secretsEncrypted)不回写')
  assert(g.get('tgTokenSet') === MISSING && g.get('secretsEncrypted') === MISSING, 'A4 投影键不进补丁(否则界面状态开关能把保险箱状态"改"成已加密)')
}
// A5 字符串类型闸: 非字符串 proxyUrl 拒收 —— 它过去会让之后每一次保存都在 applyProxy 抛错
{
  const g = gate({ proxyUrl: 123 })
  assert(rejected(g, 'proxyUrl'), 'A5 非字符串 proxyUrl 拒收')
  const g2 = gate({ proxyUrl: '  http://127.0.0.1:7899  ' })
  assert(g2.get('proxyUrl') === 'http://127.0.0.1:7899', 'A5b 字符串两端空白 trim 后落盘')
}
// A6 区间夹紧(渲染层控件是第一道, 闸门是第二道)
{
  assert(gate(mon('pandalive', { pollIntervalSec: 99999 })).patch.monitor.pandalive.pollIntervalSec === 600, 'A6 轮询间隔上限夹紧 600')
  assert(gate(mon('pandalive', { pollIntervalSec: 1 })).patch.monitor.pandalive.pollIntervalSec === 5, 'A6b 轮询间隔下限夹紧 5')
  assert(gate(mon('soop', { pollIntervalSec: 99999 })).patch.monitor.soop.pollIntervalSec === 600, 'A6h 夹紧按平台各算(SOOP 越界不该改写成 Panda 那一格)')
  assert(gate({ splitSeconds: 5 }).get('splitSeconds') === 60, 'A6c 分片秒数下限夹紧 60')
  assert(gate({ splitSeconds: 0 }).get('splitSeconds') === 0, 'A6e splitSeconds=0 原样收下(0 是「不分段」这一档, 不是越界)')
  assert(!rejected(gate({ splitSeconds: 0 }), 'splitSeconds'), 'A6f 0 不被当成不合格键拒收(拒收等于让人以为设置没生效)')
  assert(gate({ splitSeconds: -1 }).get('splitSeconds') === 60, 'A6g 负数仍然夹到 60(0 是显式取值, 负数仍是越界)')
  assert(gate({ diskLimitGb: 0 }).get('diskLimitGb') === 0.5, 'A6d 磁盘护栏下限夹紧 0.5(0 = 永不触发, 等于关掉护栏)')
}
// A7 非有限数值
{
  assert(rejected(gate(mon('pandalive', { requestGapMs: NaN })), 'monitor.pandalive.requestGapMs'), 'A7 NaN 拒收(而非写成 null 落盘)')
  assert(rejected(gate(mon('pandalive', { requestGapMs: Infinity })), 'monitor.pandalive.requestGapMs'), 'A7b Infinity 拒收')
  assert(rejected(gate(mon('pandalive', { requestGapMs: '1200' })), 'monitor.pandalive.requestGapMs'), 'A7c 字符串数值拒收(不做隐式转换)')
  // 一格坏 ≠ 整平台坏: 同平台另一格必须照收(否则用户看到的是"改了没生效")
  const mixedCell = gate(mon('soop', { pollIntervalSec: NaN, requestGapMs: 800 }))
  assert(rejected(mixedCell, 'monitor.soop.pollIntervalSec') && mixedCell.patch.monitor?.soop?.requestGapMs === 800, 'A7d 同平台一格越界不连坐另一格')
}
// A8 落盘目录必须是绝对路径: 相对路径等于把落点交给进程 cwd
{
  assert(rejected(gate({ savePath: 'rec/out' }), 'savePath'), 'A8 相对保存目录拒收')
  assert(gate({ savePath: ABS_DIR }).get('savePath') === ABS_DIR, 'A8b 绝对保存目录收下')
  assert(gate({ savePath: '' }).get('savePath') === '', 'A8c 空串 = 跟随默认目录, 允许')
}
// A9 枚举
{
  assert(rejected(gate({ theme: 'neon' }), 'theme'), 'A9 枚举外 theme 拒收')
  assert(rejected(gate({ watchMode: 'grid' }), 'watchMode'), 'A9b 枚举外 watchMode 拒收')
  assert(rejected(gate({ defaultWorkspace: 'yesterday' }), 'defaultWorkspace'), 'A9c 枚举外 defaultWorkspace 拒收')
  assert(gate({ locale: 'en-US' }).get('locale') === 'en-US', 'A9d 合法枚举收下')
}
// A10 布尔
{
  assert(rejected(gate({ closeToTray: 'true' }), 'closeToTray'), 'A10 字符串 "true" 不当真(closeToTray 应为布尔)')
  assert(gate({ mergeMp4: false }).get('mergeMp4') === false, 'A10b 合法布尔收下')
}
// A11~A15 通知矩阵逐格: 平台 / 事件 / 通道三层都照 DEFAULT_SETTINGS 点验
{
  const g = gate({ notify: { pandalive: { live: { system: false } } } })
  assert(g.dropped.length === 0 && g.patch.notify.pandalive.live.system === false, 'A11 半格矩阵提交生效')
  assert(rejected(gate({ notify: { twitch: { live: { system: true } } } }), 'notify.twitch'), 'A12 未注册平台拒收')
  assert(rejected(gate({ notify: { soop: { buzz: { system: true } } } }), 'notify.soop.buzz'), 'A13 未注册事件拒收')
  assert(rejected(gate({ notify: { soop: { offline: { sound: true } } } }), 'notify.soop.offline.sound'), 'A14 非开播行没有声音通道(界面标「—」的根据, 闸门同样不认)')
  assert(rejected(gate({ notify: { soop: { live: { system: 'yes' } } } }), 'notify.soop.live.system'), 'A15 单元格非布尔拒收')
  const half = gate({ notify: { soop: { live: { sound: false, telegram: true } } } })
  assert(half.dropped.length === 0 && half.patch.notify.soop.live.sound === false, 'A15b 开播行的 sound 通道合法')
  assert(rejected(gate({ notify: 'x' }), 'notify'), 'A15c notify 不是对象 → 整块拒收')
  assert(rejected(gate({ autoRecordDefault: { twitch: true } }), 'autoRecordDefault.twitch'), 'A16 自录默认值按平台点验')
  assert(gate({ autoRecordDefault: { soop: true } }).patch.autoRecordDefault.soop === true, 'A16b 合法自录默认值收下')
}
// A16c~A16i 监控节奏: 三格住进 monitor[平台], 旧顶层键必须不再被认识
{
  assert(rejected(gate({ pollIntervalSec: 30 }), 'pollIntervalSec'), 'A16c 旧顶层 pollIntervalSec 已成未注册键(拒收而不是悄悄落盘成第二份真相)')
  assert(rejected(gate({ requestGapMs: 1200 }), 'requestGapMs'), 'A16d 旧顶层 requestGapMs 同上')
  assert(rejected(gate({ prefetchStream: true }), 'prefetchStream'), 'A16e 旧顶层 prefetchStream 同上')
  assert(rejected(gate({ monitor: { twitch: { pollIntervalSec: 30 } } }), 'monitor.twitch'), 'A16f 未注册平台拒收')
  assert(rejected(gate({ monitor: { soop: { pollIntervalSecs: 30 } } }), 'monitor.soop.pollIntervalSecs'), 'A16g 未注册设置项拒收(拼错的格名不能落盘)')
  assert(rejected(gate({ monitor: 'x' }), 'monitor'), 'A16h monitor 不是对象 → 整块拒收')
  const onlyOne = gate({ monitor: { soop: { pollIntervalSec: 60 } } })
  assert(
    onlyOne.dropped.length === 0 && onlyOne.patch.monitor.soop.pollIntervalSec === 60 && !onlyOne.patch.monitor.pandalive,
    'A16i 半格提交只交这一格(未提交的平台不进补丁)',
    JSON.stringify(onlyOne.patch.monitor)
  )
}
// A17 补丁本身
{
  for (const [name, v] of [['null', null], ['数组', []], ['字符串', 'theme'], ['undefined', undefined]]) {
    const r = sanitizeSettingsPatch(v)
    assert(Object.keys(r.patch).length === 0 && r.dropped.length > 0, `A17 补丁本身不是对象(${name})→ 空补丁且点名`)
  }
  assert(sanitizeSettingsPatch({}).dropped.length === 0, 'A17b 空补丁合法(不动盘)')
}

console.log('\n===== B 覆盖性: 闸门跟着 DEFAULT_SETTINGS 走 =====\n')
{
  const g = gate(structuredClone(DEFAULT_SETTINGS))
  // 默认值里本来就含两枚投影字段: 它们被拒是对的, 除此之外一个都不该掉
  const expectedDrops = PROJECTED.map((k) => `${k}(主进程投影字段)`)
  assert(JSON.stringify(g.dropped) === JSON.stringify(expectedDrops), 'B1 全量默认值只掉两枚投影字段(其余零拒收)', g.dropped.join(', '))
  const missed = Object.keys(DEFAULT_SETTINGS).filter((k) => !PROJECTED.includes(k) && !(k in g.patch))
  assert(missed.length === 0, 'B2 每个可写的已注册设置项都被闸门认识(加设置项只改默认值, 闸门自动跟上)', missed.join(', '))
  const expect = structuredClone(DEFAULT_SETTINGS)
  for (const k of PROJECTED) delete expect[k]
  assert(JSON.stringify(g.patch) === JSON.stringify(expect), 'B3 全量收下的值与默认值逐字段相等(闸门不改写合法值)')
  // 闸门表里的键必须真实存在: 设置项改名后残留的旧键名会让"夹紧"静默失效。
  // 按表分别点验 —— 顶层表(NUM_RANGE/ENUMS)认 Settings 顶层键, monitor 表认 monitor 的格名,
  // 合成一个集合来判会漏掉"格名撞上了另一个平台的顶层键"这类假通过
  const guard = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'settingsGuard.ts'), 'utf8')
  const table = (name) => {
    const m = guard.match(new RegExp(`const ${name}[^]*?\\n\\}`))
    return m ? [...m[0].matchAll(/^\s{2}(\w+):/gm)].map((x) => x[1]) : []
  }
  const topKeys = new Set(Object.keys(DEFAULT_SETTINGS))
  const monKeys = new Set(Object.keys(DEFAULT_SETTINGS.monitor.pandalive))
  const listed = [...table('NUM_RANGE'), ...table('ENUMS'), ...table('MONITOR_RANGE')]
  const stale = [
    ...table('NUM_RANGE').filter((k) => !topKeys.has(k)),
    ...table('ENUMS').filter((k) => !topKeys.has(k)),
    ...table('MONITOR_RANGE').filter((k) => !monKeys.has(k))
  ]
  assert(listed.length >= 8, 'B4 区间/枚举表解析合理(≥8 项)', `${listed.length} 项`)
  assert(stale.length === 0, 'B5 区间/枚举表里没有已改名的旧设置项(否则那一格的校验静默失效)', stale.join(', '))
  assert(table('MONITOR_RANGE').length === 2, 'B5b 监控那两格数值都有区间可夹(第三格是布尔, 不进表)', table('MONITOR_RANGE').join(', '))
  assert(!table('NUM_RANGE').some((k) => monKeys.has(k)), 'B5c 节奏键已离开顶层表(还留在 NUM_RANGE 就是给未注册键做夹紧)', table('NUM_RANGE').join(', '))
}

console.log('\n===== C 端到端: 闸门 → store → db.json =====\n')
{
  store.setSettings(structuredClone(DEFAULT_SETTINGS)) // 先落一份: 之后比对的是"文件有没有被写坏"
  // 第一轮: 全是坏值 → 盘上必须一个字都不变
  const before = fs.readFileSync(DB, 'utf8')
  const bad = gate({ proxyUrl: 123, savePath: 'relative/dir', theme: 'neon', evilKey: 1, monitor: { pandalive: { pollIntervalSec: NaN } } })
  store.setSettings(bad.patch)
  assert(fs.readFileSync(DB, 'utf8') === before, 'C1 全坏补丁落盘后 db.json 未变(不是"报错但已经写了")')
  assert(store.getSettings().proxyUrl === '', 'C1b 坏值没有替掉在用的代理设置')

  // 第二轮: 混着好坏 → 好的收, 坏的不进盘
  const mixed = gate({ proxyUrl: 'http://127.0.0.1:7899', theme: 'neon', ...mon('pandalive', { pollIntervalSec: 45 }) })
  store.setSettings(mixed.patch)
  const onDisk = JSON.parse(fs.readFileSync(DB, 'utf8')).settings
  assert(onDisk.proxyUrl === 'http://127.0.0.1:7899' && onDisk.monitor.pandalive.pollIntervalSec === 45, 'C2 合格键真的落盘')
  assert(onDisk.theme === 'light', 'C2b 越界 theme 留在旧值(不是被写成 undefined)')
  assert(!('evilKey' in onDisk), 'C2c 未注册键不在 db.json 里(否则它就是设置的第二份真相)')
  assert(onDisk.monitor.soop.pollIntervalSec === DEFAULT_SETTINGS.monitor.soop.pollIntervalSec, 'C2d 只交 Panda 那一格时, SOOP 的间隔保持原值(半格提交不许把另一平台一起写掉)')

  // 第三轮: 坏值之后再存好值 —— 一次越界不能把这条通道永久毒掉
  const ok = gate({ proxyUrl: 'http://127.0.0.1:7890' })
  store.setSettings(ok.patch)
  assert(JSON.parse(fs.readFileSync(DB, 'utf8')).settings.proxyUrl === 'http://127.0.0.1:7890', 'C3 越界值被拒后同一键仍可正常保存(不永久污染)')

  // 空串是"清除代理"而不是"忽略": 闸门必须收下
  store.setSettings(gate({ proxyUrl: '   ' }).patch)
  assert(JSON.parse(fs.readFileSync(DB, 'utf8')).settings.proxyUrl === '', 'C4 全空白代理清成空串(直连), 不是留着旧值)')

  // 半格矩阵落盘: 只改 SOOP 一格, Panda 侧与同事件另一通道都得保住
  // 底先铺一组「显式开」的格: 产品默认全关后, 拿默认值当底验「没被抹掉」是空转(false 抹成 false 看不出来)
  const halfBase = structuredClone(DEFAULT_SETTINGS)
  halfBase.notify.soop.live.system = true
  halfBase.notify.soop.offline.system = true
  halfBase.notify.pandalive.live.system = true
  store.setSettings(halfBase)
  store.setSettings(gate({ notify: { soop: { live: { system: false } } } }).patch)
  const m = JSON.parse(fs.readFileSync(DB, 'utf8')).settings.notify
  assert(m.soop.live.system === false, 'C5 提交的这一格生效')
  assert(m.soop.live.telegram === false && m.soop.offline.system === true, 'C5b 没提交过的格不被半格提交抹掉(浅合并会把整张表换成这半格)')
  assert(m.pandalive.live.system === true, 'C5c 另一平台完全不动')
}

console.log('\n===== D P0 复现: 响应式代理不可进 IPC =====\n')
{
  const persisted = reactive(structuredClone(DEFAULT_SETTINGS))
  // ① 浅展开: 顶层拆开了, notify 与 autoRecordDefault 仍是代理 ⇒ structured clone 抛错
  let threw = ''
  try {
    structuredClone({ ...persisted })
  } catch (e) {
    threw = e.name
  }
  assert(threw === 'DataCloneError', 'D1 提交 {...form.value} 必然被 IPC 拒收(浅展开留代理)', `实际: ${threw || '未抛错'}`)
  // ② 深拷贝脱代理: 这就是设置页现在走的 clone()
  const clone = (s) => structuredClone(toRaw(s))
  let payload = null
  let threw2 = ''
  try {
    payload = { ...clone(persisted), theme: 'dark' }
    structuredClone(payload)
  } catch (e) {
    threw2 = e.name
  }
  assert(payload && threw2 === '', 'D2 深拷贝后整包可过 IPC(structuredClone 不抛)', `实际: ${threw2 || '未抛错'}`)
  // ③ 脱代理不能只是"看起来深": 改副本不能碰到持久化那份(翻转而不是写死 false: 默认全关后写死 false 等于没改)
  const beforeClone = persisted.notify.soop.live.system
  payload.notify.soop.live.system = !beforeClone
  assert(persisted.notify.soop.live.system === beforeClone, 'D3 副本改动不回流到 store 那份(否则脏比对恒相等, 保存按钮永远点不动)')
  // ④ 真实提交形态(差量补丁 + 已脱代理)过闸门零拒收
  const diff = diffOf(payload, structuredClone(DEFAULT_SETTINGS))
  const g = gate(diff)
  assert(g.dropped.length === 0, 'D4 差量提交的可克隆载荷过闸门零拒收', g.dropped.join(', '))
  assert(Object.keys(g.patch).sort().join(',') === 'notify,theme', 'D4b 差量恰好含改过的两键', Object.keys(g.patch).sort().join(','))
}

console.log('\n===== E 差量提交: 旧快照不回滚别人的新值 =====\n')
{
  // ① 全量提交为什么是事故: 提交的是进页那一刻的快照, 编辑期间别人落的新值被一并盖回去
  store.setSettings(structuredClone(DEFAULT_SETTINGS))
  const snap = cloneOf(store.getSettings())
  const edited = { ...snap, theme: snap.theme === 'dark' ? 'light' : 'dark' }
  store.setSettings(mon('pandalive', { pollIntervalSec: 45 }))
  store.setSettings(structuredClone(edited))
  assert(
    store.getSettings().monitor.pandalive.pollIntervalSec === DEFAULT_SETTINGS.monitor.pandalive.pollIntervalSec,
    'E1 全量提交确实会回滚并发写入(所以差量提交不是洁癖)',
    String(store.getSettings().monitor.pandalive.pollIntervalSec)
  )

  // ② 差量提交: 基线是「进页快照」, 只有用户真改过的键进补丁
  store.setSettings(structuredClone(DEFAULT_SETTINGS))
  const base = cloneOf(store.getSettings())
  const form = cloneOf(base)
  form.theme = 'dark'
  store.setSettings(mon('pandalive', { pollIntervalSec: 45 })) // 编辑期间另一写入方
  const diff = diffOf(form, base)
  assert(Object.keys(diff).length === 1 && diff.theme === 'dark', 'E2 脏清单恰好只含用户改过的那一键(别人的新值不算脏)', Object.keys(diff).join(','))
  store.setSettings(structuredClone(gate(diff).patch))
  assert(store.getSettings().monitor.pandalive.pollIntervalSec === 45, 'E3 并发写入的新值保住', String(store.getSettings().monitor.pandalive.pollIntervalSec))
  assert(store.getSettings().theme === 'dark', 'E3b 用户改过的那一格确实落了')

  // ③ 基线为什么必须是快照而不是实时投影: 拿实时投影当基线, 「别人刚改的」会被读成「你没保存的」
  const wrongBase = diffOf(form, store.getSettings())
  assert(
    JSON.stringify(wrongBase.monitor?.pandalive) === JSON.stringify(DEFAULT_SETTINGS.monitor.pandalive),
    'E4 用实时投影当基线会把别人的新值判成脏并提交回去(回滚链)',
    Object.keys(wrongBase).join(',')
  )

  // ④ 投影键不算脏: 真值在保险箱, 盘上没有这一格
  const withProj = { ...base, secretsEncrypted: !base.secretsEncrypted, tgTokenSet: !base.tgTokenSet }
  assert(Object.keys(diffOf(withProj, base)).length === 0, 'E5 投影键变化不算脏(否则密钥环恢复加密后那一格永远"未保存")')

  // ⑤ 已单独落盘的键要同步基线: 主题/语言走即时通道, 基线不动就永远挂着「1 项未保存」
  store.setSettings(structuredClone(DEFAULT_SETTINGS))
  const b2 = cloneOf(store.getSettings())
  const f2 = cloneOf(b2)
  f2.theme = 'dark'
  store.setSettings(gate({ theme: 'dark' }).patch)
  assert(Object.keys(diffOf(f2, b2)).length === 1, 'E6 即时通道落盘后若不同步基线, 界面仍报未保存(所以 applyTheme 要 adopt)')
  b2.theme = 'dark'
  assert(Object.keys(diffOf(f2, b2)).length === 0, 'E6b 基线同步后脏标记归零')
}

// ---------- 收尾 ----------
console.log('\n' + '─'.repeat(72))
console.log(`通过 ${PASS} / 失败 ${FAIL}`)
if (FAIL) {
  console.log('\n失败项:')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('解读: A~B ⇒ settings:set 的入站闸门逐键判定且覆盖全部已注册设置项;')
console.log('      C ⇒ 越界值不落盘、不落盘后仍可正常保存、半格提交不抹掉别格;')
console.log('      D ⇒ 浅展开必被 IPC 拒收的 P0 机制在案, 深拷贝为唯一合法提交形态;')
console.log('      E ⇒ 差量提交保住并发写入, 投影键不算脏.')
