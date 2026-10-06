import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../util'

// ============ 文件日志 ============
// data/logs/app-YYYYMMDD.log, 按日切分, 启动时清理 N 天前旧文件
// 量小同步追加; warn/error 同时透传 console(开发期友好)
// 注意: 日志可能含临时签名 URL 等会话信息, 仅存本机, 分享前请留意
// ==================================

const KEEP_DAYS = 14

// ---- 内存留档(诊断台): 写文件的同一发顺手在内存里留一份, 不额外读盘 ----
// 只留最近 RING_CAP 条, 滚出去多少条要说得出来 —— "看着全其实是截了"比不显示更坏。
// 这里存的是原文(与盘上同一份), 脱敏在往外递的那一步做(diag.ts)。
export interface LogRecord {
  seq: number
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  text: string
}
const RING_CAP = 800
const ring: LogRecord[] = []
let seq = 0
let total = 0
const levelCount = { info: 0, warn: 0, error: 0 }

function remember(level: 'info' | 'warn' | 'error', scope: string, msg: string, at: number): void {
  total++
  levelCount[level]++
  ring.push({ seq: ++seq, at, level, scope, text: msg })
  if (ring.length > RING_CAP) ring.shift()
}

export const logRing = {
  cap: RING_CAP,
  stats(): DiagStats {
    return { kept: ring.length, total, dropped: Math.max(0, total - ring.length), warn: levelCount.warn, error: levelCount.error }
  },
  /** seq 之后的行(最旧的一条比 sinceSeq 大); 一次最多 limit 条, 超出即从旧的那头截 */
  since(sinceSeq: number, limit = 400): LogRecord[] {
    const out = ring.filter((r) => r.seq > sinceSeq)
    return out.length > limit ? out.slice(out.length - limit) : out
  }
}
type DiagStats = { kept: number; total: number; dropped: number; warn: number; error: number }

function logDir(): string {
  const dir = path.join(dataDir(), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const p2 = (n: number): string => String(n).padStart(2, '0')

function dayStamp(d = new Date()): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
}

function write(level: 'info' | 'warn' | 'error', scope: string, msg: string): void {
  remember(level, scope, msg, Date.now())
  try {
    const t = new Date()
    const ts = `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}.${String(t.getMilliseconds()).padStart(3, '0')}`
    const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}\n`
    fs.appendFileSync(path.join(logDir(), `app-${dayStamp()}.log`), line, 'utf-8')
  } catch {
    /* 日志失败永不影响主流程 */
  }
}

let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000
    for (const f of fs.readdirSync(logDir())) {
      const m = /^app-(\d{4})(\d{2})(\d{2})\.log$/.exec(f)
      if (!m) continue
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (t < cutoff) {
        try {
          fs.unlinkSync(path.join(logDir(), f))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export const logger = {
  cleanup,
  dir: logDir,
  info(scope: string, msg: string): void {
    write('info', scope, msg)
  },
  warn(scope: string, msg: string): void {
    write('warn', scope, msg)
    console.warn(`[${scope}]`, msg)
  },
  error(scope: string, msg: string): void {
    write('error', scope, msg)
    console.error(`[${scope}]`, msg)
  }
}
