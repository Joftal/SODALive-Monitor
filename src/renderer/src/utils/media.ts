import type { RecHistoryItem } from '@shared/types'

// ============ 录制产物判定与格式化(库/影院浮层/录制页共用) ============

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return Math.max(0, Math.round(n / 1024)) + ' KB'
}

/** 秒 → h:mm:ss / mm:ss */
export function fmtDurHMS(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 录制时长: start→end(空则到当前), h:mm:ss / mm:ss */
export function fmtDur(start: number, end: number | null): string {
  return fmtDurHMS(Math.floor(((end ?? Date.now()) - start) / 1000))
}

/** 文件基名(去目录) */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 时刻 → 本地 HH:mm:ss: 「上次轮询/上次收尾」这类钟面在全应用至少四处出现,
 *  各自 toLocaleString 会得到 4 种格式(带不带秒、上午下午), 收在一处 */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 轮次耗时: 毫秒 → 秒(一位小数, 不带单位词, 单位词归文案).
 *  收在一处是因为同一个 roundMs 曾经有两套读法 —— 顶栏胶囊 8.6 秒 / 设置页 8600 ms,
 *  单位词进 locale 而不是进代码, 中文才不用再混一个拉丁 s */
export function fmtRoundCost(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1)
}

/** 错误串清洗: 去掉前缀 "xxx Error: " */
export function errText(e: unknown): string {
  return String((e as Error)?.message || e).replace(/^.*Error: /, '')
}

/** 大数字缩写: 中文 ≥1万→万, 英文 ≥1000→k(isZh 由调用方 locale 决定; 千/万不得混用) */
export function fmtNum(n: number, isZh: boolean): string {
  if (isZh) return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n)
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
}

/** 开播时长: pandalive startTime("YYYY-MM-DD HH:mm:ss", 韩国时间 KST=UTC+9) → 时长文案(card.h/card.m)
 *  实勘: startTime 为 KST 钟面, 裸解析会按本地时区落点 —— 非 KST 地区时长错误(UTC+8 下前 1 小时恒显 0 分, 之后恒少 1h) */
export function fmtLiveDuration(startTime: string | undefined, t: (key: string, p?: Record<string, unknown>) => string): string {
  if (!startTime) return ''
  const ts = new Date(startTime.replace(' ', 'T') + '+09:00').getTime()
  const dsec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (!Number.isFinite(dsec)) return ''
  const h = Math.floor(dsec / 3600)
  const m = Math.floor((dsec % 3600) / 60)
  return t(h > 0 ? 'card.h' : 'card.m', { h, m })
}

/** 整文件: 盘上就一个 MP4、不带 _NNNN/_vod 分段后缀 —— 手动合并的产物与「不分段」录出来的
 *  成品是同一个形状(合并时本就要合成单文件, 不合并时直接落单文件), 库里归一类 */
export function isWholeTask(h: RecHistoryItem): boolean {
  const mp4s = (h.files || []).filter((f) => f.toLowerCase().endsWith('.mp4'))
  if (h.vod || mp4s.length !== 1 || (h.files || []).length !== 1) return false
  const name = mp4s[0].split(/[\\/]/).pop() || ''
  return !/_(\d{4}|vod)\.mp4$/i.test(name)
}

/** 进行中的任务是不是单文件直出: 当前文件名不带 _NNNN 段号。
 *  读的是盘上形状而不是设置值 —— 中途改「分段时长」不会让已经在写的文件变成两段;
 *  还没有文件时(开录头两秒 stat 未跑)如实回 false, 交给「N 段」那句, 不猜 */
export function isSingleFileTask(currentFile: string): boolean {
  const name = baseName(currentFile || '')
  return !!name && !/_(\d{4})\.(ts|mp4)$/i.test(name)
}

/** 可手动合并: 分段(MP4≥2 或 TS≥2) 且不存在已合并整文件 */
export function mergeableTask(h: RecHistoryItem): boolean {
  const mp4s = (h.files || []).filter((f) => f.toLowerCase().endsWith('.mp4'))
  const tss = (h.files || []).filter((f) => f.toLowerCase().endsWith('.ts'))
  const segs = mp4s.length >= 2 ? mp4s : tss
  if (segs.length < 2) return false
  const base = (segs[0].split(/[\\/]/).pop() || '').replace(/_(\d{4}|vod)\.(mp4|ts)$/i, '')
  return !mp4s.some((f) => (f.split(/[\\/]/).pop() || '').toLowerCase() === `${base}.mp4`.toLowerCase())
}
