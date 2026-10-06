import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../util'
import { Anchor, DEFAULT_PLATFORM, isPlatform, MonitorMatrix, MonitorRules, NotifyLiveRow, NotifyMatrix, NotifyRow, NotifyRules, Platform, RecHistoryItem, Settings, DEFAULT_SETTINGS } from '../../shared/types'
import { logger } from './logger'

interface DbShape {
  anchors: Anchor[]
  settings: Settings
  history: RecHistoryItem[]
}

const FILE = () => path.join(dataDir(), 'db.json')

/** 旧版本库缺字段的补默认(幂等): platform 缺 → 默认平台; lastLiveAt 缺 → 从未见过开播。
 *  判据走 isPlatform 而非信任类型 —— 磁盘 JSON 里的值实际可能是 undefined。
 * SOOP 的 tags.isAdult 在读库时清成 false: 这一格整条不取, 在播房每轮由列表回写覆盖,
 *  而**已经离线**的房再也没有写点(offPatch 保的是房间属性, 对 SOOP 这一格已不成立),
 *  旧轮次留下的 true 会永久挂在播放页页头(实机拍到 papcon0206 下播后仍带 19+ 徽标)。 */
function migrateAnchor(x: Anchor): Anchor {
  const a: Anchor = { ...(isPlatform(x.platform) ? x : { ...x, platform: DEFAULT_PLATFORM }), lastLiveAt: x.lastLiveAt || '' }
  if (a.platform === 'soop' && a.tags?.isAdult) a.tags = { ...a.tags, isAdult: false }
  return a
}

function migrateHistory(x: RecHistoryItem): RecHistoryItem {
  return isPlatform(x.platform) ? x : { ...x, platform: DEFAULT_PLATFORM }
}

/** 通知矩阵(D4)的读库补齐: 老库是"全局一组开关", 新库是"平台 × 事件" —— 迁移必须一条不多一条不少,
 *  所以逐格取值、缺格回落默认, 而不是整块覆盖。旧键映射: notifySystem 铺满各行的系统列,
 *  notifySound 只落开播行, tgLive/tgOffline/tgRecord/tgError 是四行的推送列。 */
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
/** 数值格只认有限数: 磁盘上的 JSON 可能是 NaN/字符串(手改过的库、写坏的一半),
 *  而轮询间隔会被直接乘进 setTimeout —— 非有限值等于让定时器每毫秒发一轮 */
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
function toRow(raw: unknown, def: NotifyRow): NotifyRow {
  const o = obj(raw)
  return { system: boolOr(o.system, def.system), telegram: boolOr(o.telegram, def.telegram) }
}
function toLive(raw: unknown, def: NotifyLiveRow): NotifyLiveRow {
  return { ...toRow(raw, def), sound: boolOr(obj(raw).sound, def.sound) }
}
function toRules(raw: unknown, def: NotifyRules): NotifyRules {
  const o = obj(raw)
  return { live: toLive(o.live, def.live), offline: toRow(o.offline, def.offline), record: toRow(o.record, def.record), alert: toRow(o.alert, def.alert) }
}
function toMatrix(raw: unknown, legacy: (key: string, def: boolean) => boolean, systemOn: boolean, soundOn: boolean): NotifyMatrix {
  const o = obj(raw)
  if (!o.pandalive && !o.soop) {
    // 老库: 按旧全局开关展开。带键的老库逐格等价(迁移不是重置); 缺键 = 用户从未配置过,
    // 回落值与 DEFAULT_SETTINGS 同值(全关) —— 全新安装走这条也不会凭空出声
    const one = (): NotifyRules => ({
      live: { system: systemOn, telegram: legacy('tgLive', false), sound: soundOn },
      offline: { system: systemOn, telegram: legacy('tgOffline', false) },
      record: { system: systemOn, telegram: legacy('tgRecord', false) },
      alert: { system: systemOn, telegram: legacy('tgError', false) }
    })
    return { pandalive: one(), soop: one() }
  }
  return { pandalive: toRules(o.pandalive, DEFAULT_SETTINGS.notify.pandalive), soop: toRules(o.soop, DEFAULT_SETTINGS.notify.soop) }
}

/** 监控配置的一格: 逐格取值, 缺格回落【本平台】的默认 —— 绝不拿另一平台的值来补 */
function toMonitorRules(raw: unknown, def: MonitorRules): MonitorRules {
  const o = obj(raw)
  return { pollIntervalSec: numOr(o.pollIntervalSec, def.pollIntervalSec), requestGapMs: numOr(o.requestGapMs, def.requestGapMs), prefetchStream: boolOr(o.prefetchStream, def.prefetchStream) }
}

function migrateSettings(raw: unknown): Settings {
  const r = obj(raw)
  const s = { ...DEFAULT_SETTINGS, ...r } as Settings
  s.notify = toMatrix(r.notify, (k, d) => boolOr(r[k], d), boolOr(r.notifySystem, false), boolOr(r.notifySound, false))
  // 旧库的 autoRecordDefault 是单布尔: 铺到两平台同值(新库是 { pandalive, soop })
  const legacyAuto = typeof r.autoRecordDefault === 'boolean' ? r.autoRecordDefault : false
  const a = obj(r.autoRecordDefault)
  s.autoRecordDefault = { pandalive: boolOr(a.pandalive, legacyAuto), soop: boolOr(a.soop, legacyAuto) }
  // 旧库的三个全局监控键 → 两平台各铺一份同值(迁移不是重置: 只是把"这一格归谁"说清楚,
  // 老用户没碰过的节奏升级后必须一模一样)。已是新库则逐格取值, 缺格回落本平台默认。
  const mm = obj(r.monitor)
  const legacyMon: MonitorRules = {
    pollIntervalSec: numOr(r.pollIntervalSec, DEFAULT_SETTINGS.monitor.pandalive.pollIntervalSec),
    requestGapMs: numOr(r.requestGapMs, DEFAULT_SETTINGS.monitor.pandalive.requestGapMs),
    prefetchStream: boolOr(r.prefetchStream, DEFAULT_SETTINGS.monitor.pandalive.prefetchStream)
  }
  const hasMon = Boolean(mm.pandalive || mm.soop)
  s.monitor = {
    pandalive: toMonitorRules(mm.pandalive, hasMon ? DEFAULT_SETTINGS.monitor.pandalive : legacyMon),
    soop: toMonitorRules(mm.soop, hasMon ? DEFAULT_SETTINGS.monitor.soop : legacyMon)
  }
  // 旧全局开关与三个监控标量已并入矩阵: 展开后即删除, 否则这些死键会跟着 setSettings 的浅合并永久留在 db.json
  for (const k of [
    'notifySystem',
    'notifySound',
    'tgLive',
    'tgOffline',
    'tgRecord',
    'tgError',
    'pollIntervalSec',
    'requestGapMs',
    'prefetchStream'
  ])
    delete (s as unknown as Record<string, unknown>)[k]
  return s
}

/** IPC 提交的是嵌套结构: 只给半格时浅合并会把另一平台/另一事件整格抹掉, 所以逐格与现值兜底合并 */
function mergeNotify(base: NotifyMatrix, inc: unknown): NotifyMatrix {
  const o = obj(inc)
  return { pandalive: toRules(o.pandalive ?? base.pandalive, base.pandalive), soop: toRules(o.soop ?? base.soop, base.soop) }
}
function mergeMonitor(base: MonitorMatrix, inc: unknown): MonitorMatrix {
  const o = obj(inc)
  return { pandalive: toMonitorRules(o.pandalive ?? base.pandalive, base.pandalive), soop: toMonitorRules(o.soop ?? base.soop, base.soop) }
}
function mergeAutoRec(base: Record<Platform, boolean>, inc: unknown): Record<Platform, boolean> {
  const o = obj(inc)
  return { pandalive: boolOr(o.pandalive, base.pandalive), soop: boolOr(o.soop, base.soop) }
}

/** 读库带重试: Windows 下应用被强杀后立刻重启, db.json 句柄可能尚未释放(EBUSY/EPERM),
 *  此时若静默回退默认态 + 轮询 flush 会把真数据覆写丢 —— 重试 + dbRecovering 写守卫双保险 */
let dbRecovering = false

function load(retryMs = 0): DbShape {
  try {
    const raw = fs.readFileSync(FILE(), 'utf-8')
    const j = JSON.parse(raw)
    dbRecovering = false
    return {
      anchors: (Array.isArray(j.anchors) ? j.anchors : []).map(migrateAnchor),
      settings: migrateSettings(j.settings),
      history: (Array.isArray(j.history) ? j.history : []).map(migrateHistory)
    }
  } catch (e) {
    if (retryMs > 0 && fs.existsSync(FILE())) {
      const until = Date.now() + retryMs
      while (Date.now() < until) { /* 自旋短等(启动早期, 仅百毫秒级) */ }
      return load(0) // 只重试一次
    }
    // 真没有库(全新安装) → 默认态; 文件存在但读不出 → 恢复态标记(禁写覆真库)
    dbRecovering = fs.existsSync(FILE())
    return { anchors: [], settings: { ...DEFAULT_SETTINGS }, history: [] }
  }
}

let db: DbShape = load(150)
let saveTimer: NodeJS.Timeout | null = null
/** 上一次真落盘的时刻与在不在等定时器: 「改了没生效」的第一问就是这两格 */
let lastWriteAt = 0

function persist(immediate = false): void {
  const write = () => {
    if (dbRecovering) {
      // 恢复态禁止覆写; 异步重试(不在定时器回调里自旋阻塞事件循环)
      const re = load(0)
      if (dbRecovering) {
        logger.warn('store', 'db.json 读取仍失败, 稍后重试落盘(避免覆写)')
        setTimeout(() => persist(true), 160)
        return
      }
      db = re
      logger.warn('store', 'db.json 已恢复正常; 恢复窗口内的个别改动可能未落盘')
    }
    try {
      const tmp = FILE() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf-8')
      fs.renameSync(tmp, FILE())
      lastWriteAt = Date.now()
    } catch (e) {
      console.error('db persist failed', e)
    }
  }
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    write()
    return
  }
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      write()
    } catch (e) {
      console.error('db persist failed', e)
    }
  }, 400)
}

export const store = {
  /** 诊断台: 库现在到底在不在写。recovering=true 意味着此后每次改动只活在内存里,
   *  程序一崩就全丢 —— 这把锁今天没有任何地方显示, 是这一页最值钱的一格 */
  diag(): { recovering: boolean; pendingWrite: boolean; lastWriteAt: number; anchors: number } {
    return { recovering: dbRecovering, pendingWrite: saveTimer !== null, lastWriteAt, anchors: db.anchors.length }
  },
  // ----- anchors -----
  listAnchors(): Anchor[] {
    return db.anchors
  },
  addAnchor(a: Anchor): void {
    if (!db.anchors.find((x) => x.platform === a.platform && x.userId === a.userId)) {
      db.anchors.push(a)
      persist()
    }
  },
  removeAnchor(platform: Platform, userId: string): void {
    db.anchors = db.anchors.filter((x) => !(x.platform === platform && x.userId === userId))
    persist()
  },
  updateAnchor(platform: Platform, userId: string, patch: Partial<Anchor>): void {
    const a = db.anchors.find((x) => x.platform === platform && x.userId === userId)
    if (a) {
      Object.assign(a, patch)
      persist()
    }
  },
  // ----- settings -----
  getSettings(): Settings {
    return db.settings
  },
  setSettings(patch: Partial<Settings>): Settings {
    if (typeof patch.proxyUrl === 'string') patch = { ...patch, proxyUrl: patch.proxyUrl.trim() }
    if (patch.notify) patch = { ...patch, notify: mergeNotify(db.settings.notify, patch.notify) }
    if (patch.monitor) patch = { ...patch, monitor: mergeMonitor(db.settings.monitor, patch.monitor) }
    if (patch.autoRecordDefault) patch = { ...patch, autoRecordDefault: mergeAutoRec(db.settings.autoRecordDefault, patch.autoRecordDefault) }
    db.settings = { ...db.settings, ...patch }
    persist(true)
    return db.settings
  },
  // ----- history -----
  addHistory(item: RecHistoryItem): void {
    db.history.unshift(item)
    if (db.history.length > 500) db.history.length = 500
    persist()
  },
  listHistory(): RecHistoryItem[] {
    return db.history
  },
  updateHistory(id: string, patch: Partial<RecHistoryItem>): void {
    const h = db.history.find((x) => x.id === id)
    if (h) {
      Object.assign(h, patch)
      persist()
    }
  },
  clearHistory(): void {
    db.history = []
    persist(true)
  },
  removeHistory(id: string): void {
    const n = db.history.length
    db.history = db.history.filter((x) => x.id !== id)
    if (db.history.length < n) persist(true)
  },
  flush(): void {
    persist(true)
  }
}
