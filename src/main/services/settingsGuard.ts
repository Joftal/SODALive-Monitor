import * as path from 'path'
import { DEFAULT_SETTINGS, MonitorRules, Platform, Settings } from '../../shared/types'

// ============================================================================
// 设置补丁入站闸门(渲染层 → settings:set 的唯一校验点)
//
// 为什么必须存在: 这个通道的写入是 `store.setSettings(patch)` 直接落盘, 此前零校验。
// 一个非字符串的 proxyUrl 能进盘, 之后每次保存都在 applyProxy 里抛 TypeError ——
// 而盘已经写完了, 于是界面报错、磁盘却是新值(渲染层与数据分叉), 只能重启才解。
// 所以规则是: 不合格的键【不收】, 而不是收了再兜底; 收下的值保证类型/区间/枚举合法。
//
// 期望形状全部从 DEFAULT_SETTINGS 推导: 以后加设置项只改默认值那一处, 闸门自动跟上。
// ============================================================================

/** 数值区间: 与设置页控件的 min/max 同口径(闸门是第二道, 不是唯一一道) */
const NUM_RANGE: Partial<Record<keyof Settings, readonly [number, number]>> = {
  splitSeconds: [60, 7200],
  diskLimitGb: [0.5, 100]
}

/** 监控格的区间: 与设置页两平台节里的控件同口径。逐格登记是因为这三格现在嵌在平台节内,
 *  顶层 NUM_RANGE 按 Settings 的键索引, 已经管不到它们 */
const MONITOR_RANGE: Record<'pollIntervalSec' | 'requestGapMs', readonly [number, number]> = {
  pollIntervalSec: [5, 600],
  requestGapMs: [300, 10000]
}

/** 允许取 0 的数值项: 0 不是"越界被夹到区间下界", 而是"这一档关掉"的显式取值
 *  (splitSeconds = 0 → 不分段, 整场录成单文件)。负数仍然走夹取, 非 0 小值仍然抬到 60 */
const ZERO_OK: readonly (keyof Settings)[] = ['splitSeconds']

/** 联合类型设置项的合法取值 */
const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  theme: ['light', 'dark'],
  locale: ['zh-CN', 'en-US'],
  watchMode: ['list', 'per-anchor'],
  defaultWorkspace: ['remember', 'pandalive', 'soop']
}

/** 主进程投影字段: 真值在 secrets 保险箱, 渲染层回传一律忽略(防状态开关被当设置落盘) */
const PROJECTED: readonly string[] = ['tgTokenSet', 'secretsEncrypted']

export interface GuardedPatch {
  patch: Partial<Settings>
  /** 被拒键 + 原因, 由调用方落日志(不静默吞掉: 前端越界要看得见) */
  dropped: string[]
}

export function sanitizeSettingsPatch(input: unknown): GuardedPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { patch: {}, dropped: ['<补丁本身不是对象>'] }
  }
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k as keyof Settings
    if (!(key in DEFAULT_SETTINGS)) {
      dropped.push(`${k}(未注册设置项)`)
      continue
    }
    if (PROJECTED.includes(k)) {
      dropped.push(`${k}(主进程投影字段)`)
      continue
    }
    const allowed = ENUMS[key]
    if (allowed) {
      if (typeof v !== 'string' || !allowed.includes(v)) dropped.push(`${k}(取值不在枚举内)`)
      else out[k] = v
      continue
    }
    const want = typeof DEFAULT_SETTINGS[key]
    if (want === 'string') {
      if (typeof v !== 'string') {
        dropped.push(`${k}(应为字符串)`)
        continue
      }
      const s = v.trim()
      // 保存目录会被直接 mkdirSync/写文件: 相对路径等于把落点交给进程 cwd, 只认绝对路径
      if (key === 'savePath' && s && !path.isAbsolute(s)) {
        dropped.push(`${k}(须为绝对路径或留空)`)
        continue
      }
      out[k] = s
    } else if (want === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        dropped.push(`${k}(应为有限数值)`)
        continue
      }
      const r = NUM_RANGE[key]
      out[k] = r ? (v === 0 && ZERO_OK.includes(key) ? 0 : Math.min(r[1], Math.max(r[0], v))) : v
    } else if (want === 'boolean') {
      if (typeof v !== 'boolean') dropped.push(`${k}(应为布尔)`)
      else out[k] = v
    } else if (key === 'monitor') {
      const m = sanitizeMonitor(v, dropped)
      if (Object.keys(m).length) out.monitor = m
    } else if (key === 'notify') {
      const n = sanitizeNotify(v, dropped)
      if (Object.keys(n).length) out.notify = n
    } else if (key === 'autoRecordDefault') {
      const a = sanitizeAutoRec(v, dropped)
      if (Object.keys(a).length) out.autoRecordDefault = a
    } else {
      dropped.push(`${k}(未登记的结构类型)`)
    }
  }
  return { patch: out as Partial<Settings>, dropped }
}

/** 通知矩阵: 平台/事件/通道三层的键集合全部照 DEFAULT_SETTINGS 点验, 一格一因。
 *  返回值刻意是 Record<string, unknown> —— 它只进 out(同类型), 收口在 sanitizeSettingsPatch
 *  末尾那一次断言; 逐层 as 到 NotifyRules 只会把校验强度换成类型体操。 */
function sanitizeNotify(v: unknown, dropped: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    dropped.push('notify(应为对象)')
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const [p, events] of Object.entries(v as Record<string, unknown>)) {
    if (!(p in DEFAULT_SETTINGS.notify)) {
      dropped.push(`notify.${p}(未注册平台)`)
      continue
    }
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      dropped.push(`notify.${p}(应为对象)`)
      continue
    }
    const defRows = new Map<string, unknown>(Object.entries(DEFAULT_SETTINGS.notify[p as Platform]))
    const pe: Record<string, unknown> = {}
    for (const [e, row] of Object.entries(events as Record<string, unknown>)) {
      const defRow = defRows.get(e)
      if (!defRow || typeof defRow !== 'object') {
        dropped.push(`notify.${p}.${e}(未注册事件)`)
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        dropped.push(`notify.${p}.${e}(应为对象)`)
        continue
      }
      const defCells = new Map<string, unknown>(Object.entries(defRow))
      const cells: Record<string, boolean> = {}
      for (const [c, val] of Object.entries(row as Record<string, unknown>)) {
        if (typeof defCells.get(c) !== 'boolean') dropped.push(`notify.${p}.${e}.${c}(未注册通道)`)
        else if (typeof val !== 'boolean') dropped.push(`notify.${p}.${e}.${c}(应为布尔)`)
        else cells[c] = val
      }
      if (Object.keys(cells).length) pe[e] = cells
    }
    if (Object.keys(pe).length) out[p] = pe
  }
  return out
}

/** 监控配置: 平台 × 三格(间隔 / 节流 / 预取), 平台键与格名都照 DEFAULT_SETTINGS.monitor 点验。
 *  数值按 MONITOR_RANGE 夹紧(与顶层数值键同口径), 非有限数值与错类型逐格拒收并各留一条原因。 */
function sanitizeMonitor(v: unknown, dropped: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    dropped.push('monitor(应为对象)')
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const [p, cells] of Object.entries(v as Record<string, unknown>)) {
    const def = DEFAULT_SETTINGS.monitor[p as Platform]
    if (!def) {
      dropped.push(`monitor.${p}(未注册平台)`)
      continue
    }
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
      dropped.push(`monitor.${p}(应为对象)`)
      continue
    }
    const pe: Record<string, unknown> = {}
    for (const [c, val] of Object.entries(cells as Record<string, unknown>)) {
      const want = def[c as keyof MonitorRules]
      if (want === undefined) {
        dropped.push(`monitor.${p}.${c}(未注册设置项)`)
        continue
      }
      const ck = `monitor.${p}.${c}`
      if (typeof want === 'number') {
        if (typeof val !== 'number' || !Number.isFinite(val)) dropped.push(`${ck}(应为有限数值)`)
        else {
          const r = MONITOR_RANGE[c as keyof typeof MONITOR_RANGE]
          pe[c] = r ? Math.min(r[1], Math.max(r[0], val)) : val
        }
      } else if (typeof want === 'boolean') {
        if (typeof val !== 'boolean') dropped.push(`${ck}(应为布尔)`)
        else pe[c] = val
      } else dropped.push(`${ck}(未登记的结构类型)`)
    }
    if (Object.keys(pe).length) out[p] = pe
  }
  return out
}

function sanitizeAutoRec(v: unknown, dropped: string[]): Partial<Settings['autoRecordDefault']> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    dropped.push('autoRecordDefault(应为对象)')
    return {}
  }
  const out: Partial<Settings['autoRecordDefault']> = {}
  for (const [p, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(p in DEFAULT_SETTINGS.autoRecordDefault)) dropped.push(`autoRecordDefault.${p}(未注册平台)`)
    else if (typeof val !== 'boolean') dropped.push(`autoRecordDefault.${p}(应为布尔)`)
    else out[p as Platform] = val
  }
  return out
}
