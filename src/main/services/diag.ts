import { BrowserWindow, session } from 'electron'
import type { DiagKeys, DiagLogLine, DiagLogPage, DiagSnapshot, Platform } from '../../shared/types'
import { diskFreeGb, defaultRecordRoot, diskProbeFailed } from '../util'
import { logRing } from './logger'
import { store } from './store'
import { watcher } from './watcher'
import { soopApi, SOOP_SESSION_PARTITION } from './soop'
import { api, SESSION_PARTITION } from './pandalive'
import { recorder } from './recorder'
import { thumbs } from './thumbs'
import { imgCache } from './imgCache'
import { laneSnapshot } from './netGate'
import { secrets } from './secrets'

// ============ 诊断台: 主进程内存账的只读投影 ============
// 这一层的存在理由: 界面上看不到的运行时状态, 过去只有两条路能知道 —— 翻 data/logs/ 里的文件,
// 或者临时写脚本问主进程。这一层把它们摆到屏幕上, 而且守三条死规矩:
//   1) 只读: 不发一个请求、不写一次盘、不触发任何拉源/登录/录制动作(日志是 logger 写文件时顺手留的, 不回头读盘)
//   2) 只递程序本来就在记的数: 没有账的格子宁可空着, 也不摆一个"看着合理"的估算
//   3) 只递事实, 不递凭据: Cookie 的值、代理密码、托管密码一律不出这一层, 地址的签名参数默认抹掉
// 新增字段前先问"这个数今天有人记着吗"(设计稿 0.1 规矩②)。
// ==================================================================

/** 会话罐里那几枚钥匙的读数(枚数/最早过期/有没有不带期限的)。值本身一个字节都不递出去。 */
async function keyJar(partition: string, domainSuffix: string, lastCheckAt: number, cacheTtlMs: number): Promise<DiagKeys> {
  let list: Electron.Cookie[] = []
  try {
    list = await session.fromPartition(partition).cookies.get({})
  } catch {
    /* 读罐失败=这一格空着: 编一个 0 会被读成"罐是空的", 那比没有读数更坏 */
    return { partition, cookies: -1, earliestExpireAt: 0, persistent: 0, sessionOnly: 0, lastCheckAt, cacheTtlMs }
  }
  const nowSec = Date.now() / 1000
  let earliest = 0
  let persistent = 0
  let sessionOnly = 0
  for (const c of list) {
    const d = (c.domain || '').replace(/^\./, '')
    if (!d.endsWith(domainSuffix)) continue
    if (!c.expirationDate) sessionOnly++
    else {
      persistent++
      if (c.expirationDate >= nowSec && (!earliest || c.expirationDate < earliest)) earliest = c.expirationDate
    }
  }
  return { partition, cookies: persistent + sessionOnly, earliestExpireAt: earliest * 1000, persistent, sessionOnly, lastCheckAt, cacheTtlMs }
}

/** 往外递的那一句先脱敏: 临时签名地址等于一次性门钥匙(logger.ts:8 就写着这句), Cookie/token/密码这类
 *  根本不该出现在屏上。盘上那份保持原样 —— 这里只改推给屏幕的副本。 */
const SECRET_KV = /(cookie|set-cookie|token|password|passwd|secret|authorization|aid|authticket|userticket)\s*[:=]\s*\S+/gi
const SIGNED_URL = /((?:https?:\/\/|plocal:\/\/|m3u8:\/\/)[^\s"'，、）)]*)\?[^\s"'，、）)]*/gi
export function redact(text: string): string {
  return String(text)
    .replace(SECRET_KV, (m, k) => `${k}=…(藏)`)
    .replace(SIGNED_URL, (_m, base) => `${base}?…(藏)`)
}

/** 一屏的全部读数。异步只因为读会话罐要 await —— 全程零网络、零写盘。 */
export async function snapshot(): Promise<DiagSnapshot> {
  const now = Date.now()
  const sd = soopApi.diag()
  const pd = api.diag()
  const wd = watcher.diag({ soop: sd.riskLeftMs, pandalive: pd.riskLeftMs })
  const cfg = store.getSettings()
  const rec = recorder.diag()
  const th = thumbs.diag()
  const img = imgCache.stats()
  const st = store.diag()
  const tgOn = Object.values(cfg.notify).some((rules) => Object.values(rules).some((row) => row.telegram === true))
  const keys = {} as Record<Platform, DiagKeys>
  keys.soop = await keyJar(SOOP_SESSION_PARTITION, 'sooplive.com', sd.lastCheckAt, sd.checkCacheTtlMs)
  keys.pandalive = await keyJar(SESSION_PARTITION, 'pandalive.co.kr', pd.lastCheckAt, pd.checkCacheTtlMs)
  // 剩余空间是一次同步 statfs(与录制页每 10 秒那趟同一把尺), 取一次用两处
  const recDir = cfg.savePath || defaultRecordRoot()
  return {
    at: now,
    uptimeMs: process.uptime() * 1000,
    monitoringSince: wd.startedAt || null,
    windowsOpen: BrowserWindow.getAllWindows().length,
    rounds: wd.rounds,
    sources: {
      live: { soop: sd.live, pandalive: pd.live },
      stored: sd.stored,
      storedCap: sd.storedCap,
      storedTtlMs: sd.storedTtlMs,
      epochAll: sd.epochAll
    },
    queues: {
      prewarm: wd.queues.prewarm,
      offlinePending: wd.queues.offlinePending,
      thumbs: { queued: th.queued, working: th.working },
      pandaLane: pd.lane
    },
    disk: { freeGb: diskFreeGb(recDir), probeFailed: diskProbeFailed(), thresholdGb: cfg.diskLimitGb, dir: recDir },
    db: { recovering: st.recovering, pendingWrite: st.pendingWrite, lastWriteAt: st.lastWriteAt, anchors: st.anchors },
    keys,
    rec: rec.rows,
    gates: [...sd.gates.map((g) => ({ ...g, room: `soop:${g.room}` })), ...pd.gates.map((g) => ({ ...g, room: `pandalive:${g.room}` }))],
    caches: [
      { name: 'srcPlaySoop', entries: sd.live.length, cap: null, ttlMs: null },
      { name: 'srcPlayPanda', entries: pd.live.length, cap: null, ttlMs: null },
      { name: 'srcStoredDisk', entries: sd.stored.length, cap: sd.storedCap, ttlMs: sd.storedTtlMs },
      { name: 'gateSoop', entries: sd.gates.length, cap: null, ttlMs: sd.gateTtlMs },
      { name: 'gatePanda', entries: pd.gates.length, cap: null, ttlMs: pd.gateTtlMs },
      { name: 'bnoSoop', entries: sd.bnoRooms, cap: null, ttlMs: 90_000 },
      { name: 'loginSoop', entries: sd.loginCacheRooms, cap: 128, ttlMs: sd.checkCacheTtlMs },
      { name: 'img', entries: img.entries, cap: 300, ttlMs: 60_000 }
    ],
    proxy: {
      up: sd.proxy ? sd.proxy.up : false,
      port: sd.proxy ? sd.proxy.port : 0,
      origins: sd.proxy ? sd.proxy.origins : 0,
      inflight: sd.proxy ? sd.proxy.inflight : 0,
      mergedPlays: sd.proxy ? sd.proxy.mergedPlays : 0,
      mergedSegs: sd.proxy ? sd.proxy.mergedSegs : 0
    },
    telegram: { hasToken: !!secrets.get('tgToken'), hasChat: !!cfg.tgChatId, switchOn: tgOn },
    vaultAvailable: !secrets.degraded,
    lanes: laneSnapshot(),
    // stats() 的形状与 DiagImages 一字不差(命中/合并/真发/被拒本来就在记), 这里不换算、不加减
    images: img,
    log: logRing.stats()
  }
}

/** 日志增量: 只给 seq 之后的行, 并且先脱敏。滚出去多少条由 stats 说清楚, 不在这里藏。 */
export function logs(sinceSeq: number, limit = 400): DiagLogPage {
  const rows = logRing.since(Number(sinceSeq) || 0, limit)
  const lines: DiagLogLine[] = rows.map((r) => ({ seq: r.seq, at: r.at, level: r.level, scope: r.scope, text: redact(r.text) }))
  const stats = logRing.stats()
  return { lines, nextSeq: lines.length ? lines[lines.length - 1].seq : Math.max(0, Number(sinceSeq) || 0), stats }
}
