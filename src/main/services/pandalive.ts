import { BrowserWindow, net, session } from 'electron'
import * as http from 'http'
import * as https from 'https'
import * as tls from 'tls'
import * as net2 from 'net'
import { EV, isRoomId, Platform, roomKey } from '../../shared/types'
import type { Anchor, DiagGateRow, DiagSourceRow } from '../../shared/types'
import { UA, sleep } from '../util'
import { vault, CookieJar } from './vault'
import { store } from './store'
import { hostOf, laneRun } from './netGate'
import { logger } from './logger'
import { mt } from '../i18n'

// ============ pandalive API 客户端 ============
// - 全局限速队列(串行 + 最小间隔 + 抖动), 防 IP 风控
// - 队列外的旁路(jsonPriority/登录探针)与 SOOP 那侧一起过「按站车道」(见 netGate): 同一主机后台一发一发排, 用户级让路
// - 请求走 Electron net(Chromium 网络栈), 代理经 session.setProxy 生效
// - Cookie 由 vault(DPAPI 加密) 持久化
// - 风控特征识别 -> RiskError, 供 watcher 熔断
// ==================================================

const API = 'https://api.pandalive.co.kr'
export const SESSION_PARTITION = 'persist:pl'

/** 会话请求的截止时刻(P0-1)。此前这一发没有上界: Chromium 自己的 ~30 秒只在"连不上"时出声,
 *  连上以后不回话(代理回 200 再沉默 / 响应体半路停)就永远不落地 —— 而它的代价不是"慢"而是"死":
 *  那一发占着 api 站的后台车道尾锁(netGate.ts:74), 又让这一轮的 inFlight 永远为真(watcher.ts:217
 *  从此每一轮被无声跳过)。真机量到的那一次: 12 分钟里 Panda 总共只发出 2 发, 没有一行 本轮失败/熔断,
 *  开播检测死了而且不吭声。20 秒的尺是"健康态实测 0.4~1.3 秒 / 冷启动整站停顿过一次约 9 秒"之上留的余量,
 *  与 SOOP 那一侧同规约(soop.ts 常规 15 秒 / 大回包 20 秒)。
 *  超时抛的是 AbortError, 不含 ERR_FAILED ⇒ 不会走下面那条 Node 兜底, 不会把同一请求打第二遍。
 * env 那一格与 PD_LANE_QUEUE_CAP 同门: 只给验证台子压刻度用, 生产路径不设置。 */
const API_DEADLINE_MS = Number(process.env.PD_API_DEADLINE_MS || 20_000)
/** Node 兜底那条链的 TLS 握手截止(P0-2)。上面那句 15 秒管的是 CONNECT 那一问,
 *  代理回了 "200 Connection established" 之后再沉默就归这一段管: 没有它, secureConnect 不来、error 也不来,
 *  这个 Promise 永不落地(受控复现: 让代理接受 CONNECT 并回 200 但不建上游, SOOP 侧从此只剩沉默) */
const TLS_HANDSHAKE_MS = 15_000

/** 录制直连 IVS 源时必带的头(实测缺则分段 403) */
export const PANDALIVE_DL_HEADERS: Record<string, string> = {
  Origin: 'https://www.pandalive.co.kr',
  Referer: 'https://www.pandalive.co.kr/'
}

export class RiskError extends Error {
  constructor(
    message: string,
    public readonly status = 0
  ) {
    super(message)
    this.name = 'RiskError'
  }
}

/** 查无此人(改名/注销/错 id): 单主播数据错误 —— 非风控, watcher 单点处置, 绝不得升级为全局熔断 */
export class BjNotFoundError extends Error {
  constructor(
    message: string,
    public readonly userId: string
  ) {
    super(message)
    this.name = 'BjNotFoundError'
  }
}

export interface LiveItem {
  userId: string
  userIdx: number
  userNick: string
  title: string
  isAdult: boolean
  isPw: boolean
  type: string
  liveType: string
  user: number
  likeCnt: number
  fanCnt: number
  bookmarkCnt: number
  playCnt: number
  startTime: string
  isLive: boolean
  thumbUrl: string
  userImg: string
}

/** 站内关注(북마크)行里的在播信息: 直接取自 media 子对象(与全站列表同构的字段名) */
export interface PandaBookmarkLive {
  title: string
  thumbUrl: string
  userImg: string
  startTime: string
  viewers: number
  likes: number
  fans: number
  isAdult: boolean
  isPw: boolean
  type: string
  liveType: string
}

/** 站内关注一行。media 只在该房开播时下发(实测 158 关注中 13 条带), 离线行只剩昵称/头像 */
export interface PandaBookmarkRow {
  userId: string
  userIdx: number | null
  nick: string
  userImg: string
  isLive: boolean
  live: PandaBookmarkLive | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 单条关注 → 行; userId 不可寻址(改版/脏数据)则丢弃这一条, 绝不让它变成一张坏卡 */
function parseBookmarkRow(x: unknown): PandaBookmarkRow | null {
  const r = x as { userId?: unknown; userIdx?: unknown; userNick?: unknown; userImg?: unknown; media?: Record<string, unknown> } | null
  const userId = str(r?.userId)
  if (!isRoomId(userId)) return null
  const m = r?.media
  const live = m && m.isLive ? m : null
  return {
    userId,
    userIdx: typeof r?.userIdx === 'number' ? r.userIdx : null,
    nick: str(r?.userNick) || userId,
    userImg: str(r?.userImg),
    isLive: Boolean(live),
    live: live
      ? {
          title: str(live.title),
          thumbUrl: str(live.thumbUrl) || str(live.ivsThumbnail) || str(live.thumbUrlOrigin),
          userImg: str(live.userImg),
          startTime: str(live.startTime),
          viewers: num(live.user),
          likes: num(live.likeCnt),
          fans: num(live.fanCnt),
          isAdult: Boolean(live.isAdult),
          isPw: Boolean(live.isPw),
          type: str(live.type),
          liveType: str(live.liveType) || 'live'
        }
      : null
  }
}

export interface PlayResult {
  ok: boolean
  needPassword?: boolean
  /** SOOP 专有: 房间要登录态(19+/限区/匿名降级), 上层据此给"去登录"入口而不是当成未开播 */
  needLogin?: boolean
  error?: string
  m3u8?: string
  /** 回放(liveType=rec)播放结果: 录制据此走单文件下载, 前端据此切换文案 */
  vod?: boolean
  /** 解析 master 得到的变体分档(带宽降序, 第一个为最高档) */
  variants?: VariantInfo[]
  /** true = 这一份只解了最高档(预取泵用的省发型): 卡片仍算"有源", 但清晰度菜单要等真进房补齐全档。
   *  只有 SOOP 会置位 —— Panda 的全档是从 master 一次解析白送的, 不存在"少解几档"的收益 */
  partial?: boolean
  hlsBackups?: string[]
  title?: string
  nick?: string
  /** 开播时刻("YYYY-MM-DD HH:MM:SS", KST 钟面): SOOP 由 CHANNEL.BTIME 反推, 用于回写关注卡的已播时长 */
  startTime?: string
  thumbUrl?: string
  userImg?: string
  media?: Record<string, unknown>
  /** 本源包的生成时刻(缓存写入时打戳; 缓存命中/在途复用返回同一对象, 时戳天然一致) */
  fetchedAt?: number
  /** 只有 SOOP 会置位: 这一包是为哪一场次(broadNo)买的。
   *  源包跨重启留存后, 它是唯一的零请求判据 —— 重启后列表说这房在播但号变了 = 新一场, 手里那份立刻作废;
   *  号没变才谈得上"同一条签名地址还能不能用"。Panda 的 master 令牌本就写死 600 秒过期, 没有留存的余地, 故不填 */
  bno?: string
  /** 录制侧 ffmpeg 需要注入的请求头(平台各异; SOOP 走本地代理带头, 此处为空) */
  dlHeaders?: Record<string, string>
}

export interface VariantInfo {
  url: string
  bandwidth: number
  resolution: string
  /** 平台给的清晰度名(SOOP 的 sd/hd/original 等), 用于档位文案; 无则前端按分辨率命名 */
  label?: string
  /** SOOP 的档位菜单内部名(VIEWPRESET 的 name): 已买档位复用账按它对前缀, 源留存跨重启复活时要靠它把"这一档已经付过"递回那本账 */
  name?: string
}

/** checkLoginInfo 结果: netFail=true 表示请求本身失败(网络/风控), 与"服务端明确未登录"语义不同 */
interface LoginInfoResult {
  isLogin: boolean
  isAdult: boolean
  idx: number | null
  netFail: boolean
  /** 这一份是 30 秒结果缓存里的旧答案(本轮没向官方发问): 缺席 = 真发。
   *  「登录态核对」那行日志每次都落, 不带这一格就没法按行数复请求数(实测 6 行 ≈ 2 发) */
  fromCache?: boolean
  /** 在途合并: 这一份是别人正在飞的那一发带回来的, 不是本次问出来的(那行留痕要说「合并」, 不能替这一发冒充「真发」) */
  merged?: boolean
}

interface QueueJob<T> {
  run: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

/** 宽口径: 在响应 JSON 树中递归寻找 m3u8 地址(回放房 PlayList 字段结构未文档化, 先兜底后校准) */
function scanM3u8(node: unknown, depth = 0): string {
  if (depth > 6 || node == null) return ''
  if (typeof node === 'string') {
    return /^https?:\/\/\S+?\.m3u8(\?\S*)?$/.test(node) ? node : ''
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = scanM3u8(v, depth + 1)
      if (r) return r
    }
    return ''
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const r = scanM3u8(v, depth + 1)
      if (r) return r
    }
  }
  return ''
}

let nodeProxyUrl = ''
/** 当前代理地址(供 Telegram 等旁路请求的 Node 兜底通道复用同一代理) */
export const proxyUrl = (): string => nodeProxyUrl

// 需要跟随「设置-代理」的会话分区清单: 各平台客户端在自己的分区上初始化时登记。
// 代理必须全平台一致生效, 否则同一份设置换一个平台就变成直连(SOOP 限区场景即全盘失败)。
const proxyPartitions = new Set<string>([SESSION_PARTITION])

export function registerProxyPartition(partition: string): void {
  proxyPartitions.add(partition)
}

export function applyProxy(proxyUrl: string): void {
  const url = (proxyUrl || '').trim()
  nodeProxyUrl = url
  for (const p of proxyPartitions) {
    const ses = session.fromPartition(p)
    if (url) {
      void ses.setProxy({ proxyRules: url })
    } else {
      void ses.setProxy({ mode: 'direct' })
    }
  }
}

// ---- Node 原生请求(兜底通道): 支持 http 代理 CONNECT 隧道 ----
interface NodeResp {
  status: number
  text: string
  setCookies: string[]
}

function doHttpsRequest(
  method: 'GET' | 'POST',
  u: URL,
  headers: Record<string, string>,
  body: string | undefined,
  sock?: net2.Socket | tls.TLSSocket
): Promise<NodeResp> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        host: u.hostname,
        path: u.pathname + u.search,
        headers,
        agent: false,
        timeout: 20000,
        ...(sock ? { createConnection: () => sock } : {})
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString('utf-8'),
            setCookies: res.headers['set-cookie'] || []
          })
        )
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(mt('net.timeout')))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export async function nodeHttpRequest(
  method: 'GET' | 'POST',
  urlStr: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxyStr: string
): Promise<NodeResp> {
  const u = new URL(urlStr)
  if (!proxyStr) return doHttpsRequest(method, u, headers, body)

  // 经 HTTP 代理建立 CONNECT 隧道
  const p = proxyStr.includes('://') ? new URL(proxyStr) : new URL('http://' + proxyStr)
  const proxyAuth = p.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
    : ''
  const tlsSock = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const conn = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      timeout: 15000,
      ...(proxyAuth ? { headers: { 'Proxy-Authorization': proxyAuth } } : {})
    })
    conn.on('timeout', () => conn.destroy(new Error(mt('net.proxyTimeout'))))
    conn.on('connect', (res, sock) => {
      if (res.statusCode !== 200) {
        sock.destroy()
        reject(new Error(mt('net.proxyFail', { code: res.statusCode ?? 0 })))
        return
      }
      const s = tls.connect({ socket: sock, servername: u.hostname })
      // 握手这一段单独计时(P0-2, 见 TLS_HANDSHAKE_MS 那句): conn 的 15 秒在拿到 200 之后就下班了,
      // 而"代理回 200 然后沉默"是现实存在的一型 —— 不给 secureConnect 也不给 error, 只给沉默
      const handshake = setTimeout(() => s.destroy(new Error(mt('net.proxyTimeout'))), TLS_HANDSHAKE_MS)
      s.on('secureConnect', () => {
        clearTimeout(handshake)
        resolve(s)
      })
      s.on('error', (e) => {
        clearTimeout(handshake)
        reject(e)
      })
    })
    conn.on('error', reject)
    conn.end()
  })
  return doHttpsRequest(method, u, headers, body, tlsSock)
}

/** api.diag() 的形状: 诊断台④⑫⑧那几块的料, 全部来自内存账 */
export interface PandaDiag {
  live: DiagSourceRow[]
  gates: DiagGateRow[]
  epochAll: number
  riskLeftMs: number
  lastCheckAt: number
  checkCacheTtlMs: number
  inflightBuys: number
  deadStreakRooms: number
  /** Panda 自己那层"每 1.2 秒放一发"的队(与 netGate 那层是两层, 只看一层会得出"没在堵"的假结论) */
  lane: { queued: number; pumping: boolean; gapMs: number }
  fallbackCnt: number
  keepalive: { on: boolean; rooms: number }
  gateTtlMs: number
  /** vault(DPAPI 加密)里那本 Cookie 账的枚数 —— 与 Electron 会话罐是两处, 取流读的是这一本 */
  vaultCookies: number
}

class PandaApi {
  /** 兜底重发的留痕: 会话请求撞上 Chromium 网络层错误(ERR_FAILED / DNS 黑洞 / 超时)时,
   *  同一句话由 Node 再打一遍 —— 旧写法一声不吭, 请求数凭空翻倍却没有痕迹, 审计只能从"拉源成功"的计数倒推。
   *  逐条写会在断网期把日志刷成计数器(那一形态每请求都触发), 所以 60 秒只出声一次, 静默窗口内的次数在下一句里一起报 */
  private fallbackCnt = 0
  private fallbackLogUntil = 0
  private noteFallback(reason: string, target: string): void {
    this.fallbackCnt++
    const now = Date.now()
    if (now < this.fallbackLogUntil) return
    this.fallbackLogUntil = now + 60_000
    const n = this.fallbackCnt
    this.fallbackCnt = 0
    logger.warn('api', `会话请求失败(${reason}) → Node 兜底重发 ×${n}: ${target.replace(/^https?:\/\//, '').slice(0, 48)}`)
  }

  /** 拉取任意绝对 URL 文本(带 pandalive Origin/Referer, 经 session/代理/Node 兜底)
   *  Cookie 仅对 pandalive 域附带: 媒体源(CDN)不需要也不应拿到会话凭证 */
  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Origin: 'https://www.pandalive.co.kr',
      Referer: 'https://www.pandalive.co.kr/'
    }
    if (/(^|\.)pandalive\.co\.kr$/.test(new URL(url).hostname) && this.hasSession()) headers['Cookie'] = this.cookieHeader
    const ses = session.fromPartition(SESSION_PARTITION)
    // 同一把尺补到媒体/CDN 这一面: 那五处改的是 API 面(sendRaw), 而这一发此前仍然裸着 ——
    // 连上以后不回话就永不落地, 代价与那条一样是"静默"。上面那条 keepaliveSource 的 12 秒 race
    // 只替调用方自己出头, 它到点收手之后这一发仍占着 Chromium 的连接与一条不结束的 Promise。
    // 尺同样罩住 fetch 与 res.text() 两段(头到手而正文半路停住是同一个病)。
    const ctrl = new AbortController()
    const deadline = setTimeout(() => ctrl.abort(), API_DEADLINE_MS)
    try {
      const sesFetch = (ses as unknown as { fetch?: typeof net.fetch }).fetch
      const res = sesFetch
        ? await sesFetch.call(ses, url, { headers, signal: ctrl.signal })
        : await net.fetch(url, { headers, signal: ctrl.signal })
      if (res.status !== 200) {
        // M3: HTTP 错误(403/404 等风控/过期)绝不兜底重发 —— 同一请求打两遍放大风控面
        const err = new Error(`HTTP ${res.status}`) as Error & { httpStatus?: number }
        err.httpStatus = res.status
        throw err
      }
      return await res.text()
    } catch (e) {
      if ((e as { httpStatus?: number }).httpStatus) throw e // 原则同上: 只兜网络层异常
      // 与 sendRaw 的分别在这一句: sendRaw 的兜底只认 ERR_FAILED(我方 abort 天然进不去),
      // 而这里的判据是"除 HTTP 错外一律 Node 再打一遍", 所以我方尺到点必须先抛 ——
      // 落进兜底就是把同一请求打第二遍, 正是(e)要消灭的那个形状
      if (ctrl.signal.aborted) throw new Error(mt('net.timeout'))
      this.noteFallback(String((e as Error).message || e), url)
      const res = await nodeHttpRequest('GET', url, headers, undefined, nodeProxyUrl)
      if (res.status !== 200) {
        // 与主路径同构打标: 保活泵等消费方凭 httpStatus 区分"真死(403/404)"与"网络层未知"
        const err = new Error(`HTTP ${res.status}`) as Error & { httpStatus?: number }
        err.httpStatus = res.status
        throw err
      }
      return res.text
    } finally {
      clearTimeout(deadline) // 落定即下班: 计时器不许在已经返回的请求上放空枪
    }
  }

  /** 回放(VOD)清单单次读取: 一份正文同时给出进度分母(sec)与交棒给 ffmpeg 的清单体(text)。
   *  旧写法 fetchPlaylistDurationSec 只求和就把正文丢掉, ffmpeg 随后自己再去读同一份清单 —— 串行双读,
   *  两发之间不重叠(合流拦不住, 且 Panda 回放根本不走本地代理), 每次回放多 1 发。
   *  回 null = 这一发没给出可用清单(拉不到 / 非清单正文 / 没有 EXTINF 段行), 调用方必须退回把 URL 交给 ffmpeg:
   *  「0 秒」不是分母, 「没有正文」也不是正文。 */
  async fetchVodPlaylist(url: string): Promise<{ sec: number; text: string } | null> {
    let text: string
    try {
      text = await this.fetchText(url)
    } catch {
      return null
    }
    if (!/^#EXTM3U/.test(text.trim())) return null // 风控 HTML / 空串: 不能当清单交棒
    let sum = 0
    let segs = 0
    for (const l of text.split('\n')) {
      const m = /^#EXTINF:([\d.]+)/.exec(l.trim())
      if (m) {
        segs++
        const s = Number(m[1])
        if (Number.isFinite(s)) sum += s // 脏行护栏: NaN 不进和(总时长 NaN 会击穿进度估算)
      }
    }
    if (!segs) return null // master 清单(只有 variant 行): 分母本就算不出, 该由 ffmpeg 去读它那一层
    return { sec: sum, text }
  }

  /** 解析 master m3u8, 取变体分档列表(带宽降序);
   *  拉到清单但无变体行 = 单流直放, 回退 master 本身;
   *  master 拉不到(404/403 等)返回 null —— 那是 IVS 频道已销毁(下播宽限期 play 仍发死源),
   *  伪装成"档位=1 的可用源"会让播放/录制必然暴毙, 必须由调用方判拉源失败 */
  async fetchVariants(masterUrl: string): Promise<VariantInfo[] | null> {
    let text: string
    try {
      text = await this.fetchText(masterUrl)
    } catch (e) {
      console.warn('master playlist unreachable (dead channel?):', String(e))
      return null
    }
    try {
      const lines = text.split('\n')
      const out: VariantInfo[] = []
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (!l.startsWith('#EXT-X-STREAM-INF')) continue
        const bw = Number(/BANDWIDTH=(\d+)/.exec(l)?.[1] || 0)
        const res = /RESOLUTION=(\d+x\d+)/.exec(l)?.[1] || ''
        // 下一行非注释即分档地址
        for (let j = i + 1; j < lines.length; j++) {
          const v = lines[j].trim()
          if (!v) continue
          if (v.startsWith('#')) break
          out.push({ url: new URL(v, masterUrl).href, bandwidth: bw, resolution: res })
          break
        }
      }
      out.sort((a, b) => b.bandwidth - a.bandwidth)
      if (out.length) return out
    } catch (e) {
      console.warn('fetchVariants parse failed, fallback to master:', String(e))
    }
    return [{ url: masterUrl, bandwidth: 0, resolution: 'master' }]
  }

  private jar: CookieJar = {}
  private queue: QueueJob<unknown>[] = []
  private pumping = false
  gapMs = 1200
  cookieValid = false

  setGap(ms: number): void {
    this.gapMs = Math.max(300, ms)
  }

  // ---------- cookie ----------
  restoreCookies(): void {
    const jar = vault.load()
    if (jar) this.jar = jar
  }

  private saveCookies(): void {
    vault.save(this.jar)
  }

  clearCookies(): void {
    this.jar = {}
    vault.clear()
    this.clearPlayCache() // 登出/换号: 旧账号签发的源凭证全部作废
  }

  hasSession(): boolean {
    return Boolean(this.jar['sessKey'])
  }

  /** 诊断用: 当前 jar 里的 cookie 条数 */
  get cookieCount(): number {
    return Object.keys(this.jar).length
  }

  private harvestCookies(setCookies: string[]): void {
    let changed = false
    for (const c of setCookies) {
      const pair = c.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) {
        const k = pair.slice(0, i).trim()
        const v = pair.slice(i + 1).trim()
        // 仅在值真正变化时记 changed: 官网常态回吐同值 Set-Cookie, 全等则跳过 vault 落盘
        if (this.jar[k] !== v) {
          this.jar[k] = v
          changed = true
        }
      }
    }
    if (changed && this.hasSession()) this.saveCookies()
  }

  private cookieHeaderOf(jar: CookieJar): string {
    return Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  get cookieHeader(): string {
    return this.cookieHeaderOf(this.jar)
  }

  private harvest(res: { headers: Headers }): void {
    this.harvestCookies(res.headers.getSetCookie?.() ?? [])
  }

  // ---------- 限速队列 ----------
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: fn, resolve, reject } as QueueJob<unknown>)
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    while (this.queue.length) {
      const job = this.queue.shift()!
      try {
        const v = await job.run()
        job.resolve(v)
      } catch (e) {
        job.reject(e)
      }
      const jitter = this.gapMs * (0.7 + Math.random() * 0.6)
      await sleep(jitter)
    }
    this.pumping = false
  }

  // ---------- 底层请求 ----------
  /** api 站的每一发都过一遍按站车道(见 netGate)。限速队列自己那条节奏不动 —— 它睡在"上一发落定之后",
   *  车道要求的是"距上一发起跑一个间隔", 队列里排着的活天然已经满足, 于是这条队列不会被罚两遍;
   *  真正被管住的是绕过队列的那两条旁路(jsonPriority 与登录探针)。
   *  媒体/CDN 那一面(fetchText)不进车道: 播放在看的分片不能被排队, 保活泵一轮也要跑完全部在播源,
   *  串成一条会把源饿死, 而 CDN 的 403/404 是"源死了"不是风控 —— 那一句写进 netGate 的抬头。 */
  private async rawFetch(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
    extraHeaders: Record<string, string> = {},
    jarOverride?: CookieJar
  ): Promise<{ status: number; text: string }> {
    return laneRun(hostOf(API), store.getSettings().monitor.pandalive.requestGapMs, () => this.sendRaw(method, path, form, extraHeaders, jarOverride))
  }

  private async sendRaw(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
    extraHeaders: Record<string, string> = {},
    jarOverride?: CookieJar
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Origin: 'https://www.pandalive.co.kr',
      Referer: 'https://www.pandalive.co.kr/',
      'x-device-info': '{"t":"webPc","v":"1.0","ui":24631221}',
      ...extraHeaders
    }
    const useJar = jarOverride ?? this.jar
    if (useJar['sessKey']) headers['Cookie'] = this.cookieHeaderOf(useJar)
    let body: string | undefined
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    const ses = session.fromPartition(SESSION_PARTITION)
    // 优先用 session.fetch(走该 session 的代理配置); Chromium 网络栈对个别端点
    // (如多 Set-Cookie 响应) 会触发 net::ERR_FAILED, 回退 Node fetch
    // 截止时刻那一格(尺与理由见文件头 API_DEADLINE_MS): 它同时罩住 fetch 与 res.text() 两段 ——
    // 响应头到手而正文半路停住, 同样是"这一发永不落地", 而那正是把整条车道与整轮次锁死的形状
    const ctrl = new AbortController()
    const deadline = setTimeout(() => ctrl.abort(), API_DEADLINE_MS)
    let status: number
    let text: string
    try {
      const sesFetch = (ses as unknown as { fetch?: typeof net.fetch }).fetch
      const res = sesFetch
        ? await sesFetch.call(ses, API + path, { method, headers, body, signal: ctrl.signal } as RequestInit)
        : await net.fetch(API + path, { method, headers, body, signal: ctrl.signal } as RequestInit)
      if (!jarOverride) this.harvest(res)
      status = res.status
      text = await res.text()
    } catch (e) {
      if (e instanceof Error && e.message.includes('ERR_FAILED')) {
        // 兜底: Node 原生请求(支持代理 CONNECT 隧道, 与设置页代理一致)
        this.noteFallback(e.message, path)
        const res = await nodeHttpRequest(method, API + path, headers, body, nodeProxyUrl)
        if (!jarOverride) this.harvestCookies(res.setCookies)
        status = res.status
        text = res.text
      } else {
        throw e
      }
    } finally {
      clearTimeout(deadline)
    }
    if (status === 403 || status === 429) {
      logger.warn('api', `疑似风控: HTTP ${status} ${method} ${path}`)
      this.noteRisk(`HTTP ${status} ${method} ${path}`, path)
      throw new RiskError(mt('api.riskHttp', { status }), status)
    }
    if (status >= 500) {
      logger.warn('api', `服务器错误: HTTP ${status} ${method} ${path}`)
      this.noteRisk(`HTTP ${status} ${method} ${path}`, path)
      throw new RiskError(mt('api.riskServer', { status }), status)
    }
    if (text.trimStart().startsWith('<')) {
      logger.warn('api', `返回HTML疑似风控验证页: ${method} ${path} (HTTP ${status})`)
      this.noteRisk(`接口回 HTML ${method} ${path}`, path)
      throw new RiskError(mt('api.riskHtml'), status)
    }
    return { status, text }
  }

  private parseText<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch {
      if (text === '' || text === '""') return {} as T
      logger.warn('api', '响应不是JSON(疑似风控)')
      this.noteRisk('接口不回 JSON')
      throw new RiskError(mt('api.riskJson'))
    }
  }

  private async json<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    return this.enqueue(async () => {
      const { text } = await this.rawFetch(method, path, form)
      return this.parseText<T>(text)
    })
  }

  /** 绕过限速队列的请求(拉源/意外退出探针等用户意图驱动场景), 仍走风控检测 */
  async jsonPriority<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    const { text } = await this.rawFetch(method, path, form)
    return this.parseText<T>(text)
  }

  // ---------- 业务接口 ----------
  /** 官方登录态校验: 返回 isLogin / isAdult(成人认证) 等; 可提供 jar 进行"试验证"(不落地, 不经缓存)
   *  netFail=true 表示请求本身失败(网络/风控), 与"服务端明确未登录"语义不同, 调用方不得据此判死会话
   *  无 jarOverride 时走 30s 结果缓存 + 在途合并: 启动期 authState/自愈核对/pushAccounts 三连发收敛为一发;
   *  缓存以 cookieHeader 为键, jar 任何变更(登录/导入/轮换)天然失配; netFail 不缓存, 下次仍真实复检 */
  private loginInfoCache: { at: number; header: string; info: LoginInfoResult } | null = null
  private loginInfoInflight: { header: string; p: Promise<LoginInfoResult> } | null = null
  /** 最后一次真实发出 login_info 的时刻(含 netFail 的失败尝试): 账号页要把它摊给用户看 */
  private loginCheckedAt = 0

  get lastLoginCheckAt(): number {
    return this.loginCheckedAt
  }

  async checkLoginInfo(jarOverride?: CookieJar, force = false): Promise<LoginInfoResult> {
    if (jarOverride) return this.fetchLoginInfo(jarOverride)
    const header = this.cookieHeader
    if (!force && this.loginInfoCache && this.loginInfoCache.header === header && Date.now() - this.loginInfoCache.at < 30_000) {
      return { ...this.loginInfoCache.info, fromCache: true }
    }
    if (!force && this.loginInfoInflight && this.loginInfoInflight.header === header) {
      // 合流: 接别人那一发的结果, 自己没出门 ⇒ 挂 merged 旗(内容原样, 只多这一格)
      const r = await this.loginInfoInflight.p
      return { ...r, merged: true }
    }
    const p = this.fetchLoginInfo().finally(() => {
      if (this.loginInfoInflight?.p === p) this.loginInfoInflight = null
    })
    this.loginInfoInflight = { header, p }
    return p
  }

  private async fetchLoginInfo(jarOverride?: CookieJar): Promise<LoginInfoResult> {
    let out: LoginInfoResult
    if (!jarOverride) this.loginCheckedAt = Date.now()
    try {
      const { text } = await this.rawFetch('POST', '/v1/member/login_info', {}, {}, jarOverride)
      const j = this.parseText<{
        result?: boolean
        loginInfo?: { userInfo?: { isLogin?: boolean; isAdult?: boolean; idx?: number } }
      }>(text)
      const ui = j?.loginInfo?.userInfo || {}
      out = { isLogin: !!ui.isLogin, isAdult: !!ui.isAdult, idx: ui.idx ?? null, netFail: false }
    } catch {
      out = { isLogin: false, isAdult: false, idx: null, netFail: true }
    }
    if (!jarOverride && !out.netFail) this.loginInfoCache = { at: Date.now(), header: this.cookieHeader, info: out }
    return out
  }

  /** 导入 cookie; infoPre = 已做过的 login_info 校验结果(传入则消重, 不重复请求) */
  async importCookies(jar: CookieJar, infoPre?: { isLogin: boolean; isAdult: boolean }): Promise<void> {
    this.jar = { ...this.jar, ...jar }
    this.saveCookies()
    this.clearPlayCache() // 新会话生效: 旧会话签发的源清空重来
    const info = infoPre ?? (await this.checkLoginInfo())
    this.cookieValid = info.isLogin
  }

  /** 启动自愈: vault 快照被服务端判死时, 尝试接管 persist:pl 浏览器存储里的 cookie
   *  (网页登录窗/官网请求的轮换都落在存储里, 可能比 vault 快照更新) —— 试验证通过才落地 */
  async healFromStore(): Promise<boolean> {
    try {
      const cookies = await session.fromPartition(SESSION_PARTITION).cookies.get({ domain: '.pandalive.co.kr' })
      const jar: CookieJar = {}
      for (const c of cookies) jar[c.name] = c.value
      if (!jar['sessKey']) return false
      if (jar['sessKey'] === this.jar['sessKey']) return false // 与 vault 同源, 无愈可取
      const info = await this.checkLoginInfo(jar)
      if (!info.isLogin) return false
      this.jar = jar
      this.saveCookies()
      this.clearPlayCache()
      this.cookieValid = true
      logger.info('api', `登录态自愈: 已接管本地浏览器存储的 cookie(${Object.keys(jar).length} 枚)`)
      return true
    } catch (e) {
      logger.warn('api', `登录态自愈失败: ${String(e)}`)
      return false
    }
  }

  /** 拉一页全站直播列表; 响应带 loginInfo 可校验登录态; adultShowAdModeYN=Y 对认证账号开放 19+ 列表 */
  async fetchLivePage(offset: number, limit = 100): Promise<{ list: LiveItem[]; loginInfo: unknown }> {
    const j = await this.json<{ list?: LiveItem[]; loginInfo?: unknown; result?: boolean; message?: string }>(
      'GET',
      `/v1/live?hotyn=Y&adultShowAdModeYN=Y&offset=${offset}&limit=${limit}`
    )
    if ((j as { result?: boolean })?.result === false) {
      this.noteRisk('整表接口 result=false', '/v1/live')
      throw new RiskError(`live list result=false: ${(j as { message?: string })?.message || ''}`)
    }
    return { list: j.list ?? [], loginInfo: j.loginInfo }
  }

  async fetchBj(
    userId: string
  ): Promise<{ nick: string; userIdx: number | null; userImg: string; media: LiveItem | null }> {
    const j = await this.json<{
      result?: boolean
      bjInfo?: { id?: string; nick?: string; img?: string; profileImage?: string }
      media?: LiveItem & { userImg?: string }
      message?: string
    }>('POST', '/v1/member/bj', { userId, info: 'media' })
    if (j.result === false) {
      const msg = j.message || mt('api.bjFail')
      // "유저 정보가 없습니다(查无此人)"类业务错误: 非风控 —— 抛 BjNotFoundError 由 watcher 单点处置
      if (/유저|없습|not[\s_-]?found/i.test(msg)) throw new BjNotFoundError(msg, userId)
      // 业务码里的限流话术(HTTP 仍 200, 旧账本完全看不见): 记总账让三条后台收手。
      // 不记整表那一格 —— 逐房这一发正是死会话期的检测路径本身, 轮次扇出走用户 2026-10-03 那笔拍板(只报账, 不减发)
      if (PandaApi.isRateLimitMsg(j.message || '')) this.noteRisk(`bj 限流话术 @${userId}: ${j.message}`, '/v1/member/bj')
      throw new RiskError(`@${userId}: ${msg}`)
    }
    const media = j.media ?? null
    return {
      nick: j.bjInfo?.nick || media?.userNick || userId,
      userIdx: media?.userIdx ?? null,
      userImg: media?.userImg || j.bjInfo?.img || j.bjInfo?.profileImage || '',
      media
    }
  }

  /** 站内关注全量(官方上限 200 个): 一发 limit=200 收满(2026-10-02 实测 158 条/90KB/page.lastPage=1),
   *  分页循环保留作"上限被抬高"的保险, 按 page.total 收满或短页即停。
   *  返回 null = 列表不可用(未登录/风控/改版/整表脏): 调用方必须报失败,
   *  绝不能把"没读到"当成"一个关注都没有"而清库或判全员下播。 */
  async fetchBookmarks(): Promise<PandaBookmarkRow[] | null> {
    const limit = 200
    const out: PandaBookmarkRow[] = []
    let collected = 0
    let dropped = 0
    try {
      for (let page = 0; page < 10; page++) {
        const j = await this.json<{ list?: unknown; page?: { total?: number }; result?: boolean; message?: string }>('POST', '/v1/live/bookmark', {
          offset: String(page * limit),
          limit: String(limit)
        })
        if (j.result === false || !Array.isArray(j.list)) {
          logger.warn('api', `关注列表不可用(result=${String(j.result)}, list=${Array.isArray(j.list) ? 'ok' : typeof j.list})`)
          // 限流话术要记账, 但只有这一句才记: 未登录/改版是这一站正常的"读不到",
          // 把轮次扇出闷掉就是拿时效换流量 —— 死会话那一案的改判是"只把账说出来, 不减发"
          if (PandaApi.isRateLimitMsg(j.message || '')) this.noteRisk(`关注列表限流话术: ${j.message}`, '/v1/live/bookmark')
          return null
        }
        collected += j.list.length
        for (const x of j.list) {
          const row = parseBookmarkRow(x)
          if (row) out.push(row)
          else dropped++
        }
        const total = Number(j.page?.total ?? NaN)
        if (j.list.length < limit || (Number.isFinite(total) && collected >= total)) break
      }
      if (dropped) logger.warn('api', `关注列表丢弃 ${dropped} 条不可寻址记录(共取 ${collected} 条)`)
      if (!out.length && collected) {
        logger.warn('api', '关注列表字段改版? 全部记录都不可寻址')
        return null
      }
      return out
    } catch (e) {
      // RiskError(403/429/5xx/HTML 验证页)与其它异常一律降级为"本轮没有列表"
      logger.warn('api', `关注列表异常: ${String((e as Error).message || e)}`)
      return null
    }
  }

  // ---- 拉源缓存: 命中就一直用, 仅显式事件作废(重开播/录制出错/换号/手动强刷);
  //      另有保活泵按活性时限收手: 不在表的过宽限、已下播的过时限即出队 —— 缓存不再只增不减
  private playCache = new Map<string, PlayResult>()

  /** "已获取有效直播源"的房间主键集(缓存即事实源; 卡片「秒开」徽标的用户可见投影)。
   *  本客户端只服务 pandalive, 裸 userId 键在此出口补成 roomKey —— 渲染层 srcCache 一律复合键。 */
  cachedSourceIds(): string[] {
    return [...this.playCache.entries()].filter(([, v]) => v.ok).map(([k]) => roomKey('pandalive', k))
  }

  // ---- 源保活泵: 每源一轮只读主档清单, 判"这份缓存还能不能用" ----
  // 场景: 前期取了源退出观看, 后期房间满员无法再调 /v1/live/play —— 满员拦截的是拉源 API,
  // 不是流本身; 缓存里那批长效变体地址还能直接播, 所以"别把旧源丢掉"是本泵的第一职责。
  // 心跳 = 只拉主档清单(数 KB), 不拉分片; 直达 CDN, 不进 API 站车道(媒体面豁免, 见 netGate 抬头)。
  // 判死纪律: 只有主档 403/404(会话真死)计 strike; 网络层错误(断网/休眠/超时)不计 ——
  // 否则断网恢复瞬间全量误杀+对瘫痪 API 群重铸。连续 2 次真死才收尸; 收尸后若在播+开预取立即重铸。
  // 周期与覆盖面依据(+两次实测, 真机关泵): master 令牌的 exp = 取源 +585~600s 就过期(403 未实拍, 判据是解码出来的 exp),
  // 而由它解析出的变体地址在此后**无任何心跳**的情况下仍连续 200 并持续出新段 —— 量到 27.1 分钟
  // 5/5 档全活, 复量 3 房 × 5 档静置 15 分钟 15/15 全活; master 的过期判据来自现场解码的 JWT exp(=签发 +600~602s), 那一发 403 今天没有自然样本(记为量不到)。
  // ⇒ 变体地址不靠心跳续命(令牌按时间过期, 读它一次并不把 exp 往后推), 而副档失败在本泵只有观测价值,
  //    于是"全档齐养"那 4/5 发是纯流量(15s 一轮 × 4 源 × 5 档 ≈ 11.5 万发/天)。
  // 基准 60s → 5 分钟: 同一批实测说明心跳在这里从来不是续命手段, 它只负责"尽早发现真死"。
  // 判死要 2 次连击 ⇒ 最坏 10 分钟收尸, 而实测无心跳 27 分钟变体仍 5/5 全活, 收尸点远在水位线之前;
  // 现场一天里「保活连续真死」只有 1 次(其余心跳全是"还活着"这一句话), 60s 那一档买到的是重复的同一句话。
  // 规模自适应改为每源 2s、封顶 15 分钟: 每源摊 2s ⇒ 全场心跳之和在 150~450 源这一段与源数无关
  // (恒 ≈4.3 万发/天 = 86400/2), 150 源以内是 288×N(基准 5 分钟), 450 源以上由 900s 封顶重新变成 96×N ——
  // 那一道封顶买的是"单源判死延迟不超过 15 分钟×2", 不许把它读成总量上限。单源日流量 N×1440 → N×288。
  private static KEEPALIVE_MS = 300_000
  /** 源缓存的活性时限: 泵不再无限养旧源 —— 只有"仍在关注且仍在播"才值得继续心跳。
   *  到期即 invalidatePlay(「已缓存」徽标随之熄灭, 与重铸冷却同语义: 宁熄灭不骗人), 下次进房重建。
   *  已下播/本地报离线的缓存源 30 分钟后收手; 不在关注表里的(应用内添加/官网侧已取关/临时进房回访) 10 分钟宽限后收手 */
  private static KEEPALIVE_OFFLINE_TTL_MS = 30 * 60_000
  private static KEEPALIVE_GUEST_TTL_MS = 10 * 60_000
  /** 泳道并发数: 串行泵在大关注量下有效心跳会被拉长(实测 100 源 × 5 档 ≈ 148s/源);
   * 扇出收口后每源一发, 4 泳道 + 50ms 间隙把 100 源的一轮压回 ~19s, 对 CDN/本地均为平缓节奏 */
  private static KEEPALIVE_LANES = 4
  private keepaliveTimer: NodeJS.Timeout | null = null
  private keepaliveBusy = false
  private deadStreak = new Map<string, number>()
  /** 重铸串行链: 泳道并发的群体性收尸合并为链式排队, 与主请求队列同节奏(1.2s+抖动),
   *  防 API 突发触发风控(机器驱动的后台修复, 不配用 jsonPriority 的用户级特权)。
   *  冷却期补源暂缓(徽标暂熄可接受), 用户进房 getPlayCached 仍会即时重建。
   * 判"要不要收手"读下面那本统一的风控账, 链自己不再单独计时。 */
  private remintTail: Promise<void> = Promise.resolve()

  // ---- 风控自闭环: 客户端自己记的那本账 ----
  // 熔断(watcher 的 circuitOpen)只管"整表轮次"这一面, 后台的两条泵(预取泵 / 保活重铸链)此前对风控完全失明:
  // 熔断开着仍按 1.2s 一发逐房拉源(单房 2~6 发), 冷却期最不该重发的形状恰恰是它俩在发。
  // 与 SOOP 的 riskCooling() 同语义 —— 任何风控形状(403/429/≥500/接口回 HTML/非 JSON)一落地即静默 5 分钟,
  // 只让后台的泵收手; 用户那一条(进房、手动拉源、登录探针)照走, 不受牵连。
  // 两处补: ① 业务码里那句「请求太多」(HTTP 仍 200)进门, bj/关注列表/play 三个 result=false 出口都记;
  // ② 这本账分成两格 —— 总账只管后台的秒开与补源, 轮次/间隙那两条检测路只认"整表那一发自己被拒"。
  private riskUntil = 0
  /** 整表那一发被拒的单独一格: 只有它能拨动轮次的扇出闸。
   *  与总账分家的理由来自用户 2026-10-03 那笔拍板(死会话 ≈5 万发/天 那一案「只把账说出来, 不减发」):
   *  逐房那一条(fetchBj/fetchPlay)的失败常常是"这一号会话已死"或"这一个房受限", 它们既是检测路径本身,
   *  又不代表平台在拒答整表 —— 让它们顶掉轮次扇出, 就是把时效换成了流量。
   *  真正会吞掉读数的只有"整表那一发亲口被拦": 那时 5 页全站榜 + 逐房复查 + 间隙快照一起发出去也换不回一行字。 */
  private oracleRiskUntil = 0
  private static RISK_COOL_MS = 5 * 60_000

  /** 整表那一发的路径族: 全站榜(/v1/live, 带查询串)与站内关注(/v1/live/bookmark)。
   *  写成两个分支而不是 `/v1/live` 前缀, 因为前缀会把 `/v1/live/play`(逐房拉源)一起圈进来 */
  private static isOraclePath(path: string): boolean {
    return path === '/v1/live/bookmark' || path === '/v1/live' || path.startsWith('/v1/live?')
  }

  /** 平台不改 HTTP 状态、只在 message 里说"请求太多"的那一类业务码。
   *  现场样本: bj 与 play 双双回 HTTP 200 + 「너무 많은 요청이 발생했습니다」, 而旧账本只认 403/429/≥500/HTML/非 JSON
   *  ⇒ 这一站在高压的时刻, 客户端的自闭环完全看不见, 三条后台照旧按 gap 一路打到底 */
  private static isRateLimitMsg(msg: string): boolean {
    return /너무 많은 요청|too many requests|rate.?limit|请求过多|请求太频繁|слишком много запросов/i.test(msg)
  }

  private noteRisk(why: string, path = ''): void {
    // 每个静默窗口只报一次: 高压期成串命中时, 每一发都念一遍只是刷屏
    if (!this.riskCooling()) logger.warn('api', `疑似风控信号(${why}), 后台泵收手 ${PandaApi.RISK_COOL_MS / 60_000} 分钟`)
    this.riskUntil = Date.now() + PandaApi.RISK_COOL_MS
    if (PandaApi.isOraclePath(path)) this.oracleRiskUntil = Date.now() + PandaApi.RISK_COOL_MS
  }

  /** 后台的泵读这一格(预取、重铸): 冷却期内一律收手; 用户请求不看它 */
  riskCooling(): boolean {
    return Date.now() < this.riskUntil
  }

  /** 轮次的扇出闸只读这一格: 逐房那一发的失败不许把整表轮次闷掉 */
  oracleRiskCooling(): boolean {
    return Date.now() < this.oracleRiskUntil
  }

  private remintCoolLogged = false

  private enqueueRemint(userId: string): void {
    if (this.riskCooling()) {
      if (!this.remintCoolLogged) {
        this.remintCoolLogged = true
        logger.info('api', '后台风控冷却中, 暂缓补源 —— 徽标暂熄, 进房时即重建')
      }
      return
    }
    this.remintTail = this.remintTail.then(async () => {
      // 链步内二次检查: 前序步可能刚把冷却立起来 —— 双检查让"冷却期零重铸"成为结构保证而非时序运气
      if (!this.riskCooling()) {
        try {
          await this.getPlayCached(userId)
          logger.info('api', `保活重铸: @${userId}`)
        } catch (e) {
          // 撞风控即把整本账交给 noteRisk(sendRaw 里那一发落地时就已记下), 这里只管收手语义
          if (e instanceof RiskError) this.remintCoolLogged = false
          // 其余错误(满员/网络)维持静默语义
        }
      }
      const jitter = 1200 * (0.7 + Math.random() * 0.6)
      await sleep(jitter)
    })
  }

  startKeepalive(): void {
    if (this.keepaliveTimer) return
    logger.info('api', `源保活泵已启动(基准 ${PandaApi.KEEPALIVE_MS / 1000}s, 随缓存规模 2s/源 自适应放宽, 封顶 900s; 只在关注且在播的源入队)`)
    const loop = async (): Promise<void> => {
      try {
        await this.keepaliveTick()
      } finally {
        if (this.keepaliveTimer) {
          // 自适应间隔: 5 分钟基准; 每多一缓存源放宽 2s, 封顶 15 分钟 —— 300 源以内恒为基准,
          // 更大规模时全场心跳之和不再随源数线性增长。而实测无心跳 27 分钟变体仍活, 这个节奏离"会话饿死"极远
          const wait = Math.min(900_000, Math.max(PandaApi.KEEPALIVE_MS, this.playCache.size * 2000))
          this.keepaliveTimer = setTimeout(() => void loop(), wait)
        }
      }
    }
    this.keepaliveTimer = setTimeout(() => void loop(), PandaApi.KEEPALIVE_MS)
  }

  private async keepaliveTick(): Promise<void> {
    if (this.keepaliveBusy) return
    this.keepaliveBusy = true
    try {
      // 关注表按复合键索引(playCache 本身是裸 userId, 出口处补 'pandalive'):
      // 直接用裸 userId 建表会让同号的 SOOP 关注覆盖 Panda 关注, 保活判定读到别人的 isLive
      const anchors = new Map(store.listAnchors().map((a) => [roomKey(a.platform, a.userId), a]))
      // 快照防漂移: tick 期间缓存可能增删
      const snapshot = [...this.playCache.entries()]
      const queue: [string, PlayResult][] = []
      for (const [userId, pack] of snapshot) {
        if (!pack.ok || pack.vod) continue // 回放是静态分片, 无会话活性概念
        const a = anchors.get(roomKey('pandalive', userId))
        // 无 fetchedAt = 不是经缓存写入路径来的源: 不收手, 交给判死那一条(宁漏一次清理也不误杀)
        const age = pack.fetchedAt ? Date.now() - pack.fetchedAt : 0
        if (!a) {
          if (age <= PandaApi.KEEPALIVE_GUEST_TTL_MS) queue.push([userId, pack]) // 未关注源(回访场景): 宽限内照常养
          else {
            logger.info('api', `保活收手: @${userId} 不在关注表且已过宽限, 源出队`)
            this.invalidatePlay(userId)
          }
          continue
        }
        if (!a.isLive) {
          // 已知下播: 会话死亡属预期, 一次心跳都不发(这条老纪律不因本改动静动 —— 下播房的心跳是纯浪费)。
          // 时限只管一件事: 挂在手里太久的旧源不再算"有源", 收尸让「秒开」徽标说实话
          if (age > PandaApi.KEEPALIVE_OFFLINE_TTL_MS) {
            logger.info('api', `保活收手: @${userId} 已下播且源挂了 ${Math.round(age / 60_000)} 分钟, 源出队`)
            this.invalidatePlay(userId)
          }
          continue
        }
        queue.push([userId, pack])
      }
      // 闸门只关心跳, 不关记账: 旧写法把整段扫描都压在 keepaliveStream 之后, 于是关掉保活
      // 就等于源缓存再也不按年龄收手 —— 上面那两条时限全靠这一趟扫描落地, 而它同时是
      // 「已缓存」徽标与 getPlayCached 不说谎的前提。扫描零网络, 关掉时照跑。
      if (!store.getSettings().keepaliveStream) return
      const lanes = Array.from({ length: PandaApi.KEEPALIVE_LANES }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          await this.keepaliveSource(next[0], next[1], anchors.get(roomKey('pandalive', next[0])))
          await sleep(50)
        }
      })
      await Promise.all(lanes)
    } finally {
      this.keepaliveBusy = false
    }
  }

  /** 单源心跳: 只读主档(扇出收口)。两条实测把"全档齐养"那条理由推翻了 ——
   *  ① 变体是长效签名地址: 杀掉实例静置 15 分钟, 3 房 × 5 档全部 200 且清单仍在推进, 而令牌是按时钟过期的,
   *     心跳读它一次并不把 exp 往后推 —— "副档不养会饿死"这件事没有发生;
   *  ② 非主档失败在本函数里只有观测价值(判死只认主档), 于是那 4/5 发是纯流量。
   *  切清晰度用的是缓存里那批长效地址(PlayerView 直接取 variants[i].url), 与心跳无关。
   *  master(pack.m3u8) 绝不能进这一轮: 它的 IVS 令牌写死 exp = 取源 + 600 秒(现场解码得到, 403 本身未实拍), 到点即过期,
   *  把它当活性判据 = 每 10 分钟误收一次尸。真死仍由主档 403/404 判定(连续两轮 → 收尸 + 重铸)。 */
  private async keepaliveSource(userId: string, pack: PlayResult, a: Anchor | undefined): Promise<void> {
    const primary = pack.variants?.[0]?.url || ''
    if (!primary) return
    let primaryDead = false
    try {
      await Promise.race([
        this.fetchText(primary),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('keepalive timeout')), 12_000))
      ])
    } catch (e) {
      const st = (e as { httpStatus?: number }).httpStatus
      if (st === 403 || st === 404) primaryDead = true
      // 网络层错误: 不计死(断网即整批阵亡的语义错误)
    }
    this.keepaliveInfo.set(userId, { at: Date.now(), ok: !primaryDead, variants: pack.variants?.length || 1 })
    if (!primaryDead) {
      this.deadStreak.delete(userId)
      return
    }
    const n = (this.deadStreak.get(userId) || 0) + 1
    this.deadStreak.set(userId, n)
    if (n < 2) return
    this.deadStreak.delete(userId)
    logger.warn('api', `保活连续真死(403/404), 源收尸: @${userId}`)
    this.invalidatePlay(userId)
    // 立即重铸(串行链, 与主请求队列同节奏): 房间未满即秒回有效态; 满员/风控高压则静默失败, 徽标保持熄灭(诚实态)
    if (a?.isLive && store.getSettings().monitor.pandalive.prefetchStream) {
      this.enqueueRemint(userId)
    }
  }

  /** 源缓存变动统一广播: 渲染层据此点亮/熄灭卡片「已缓存」徽标 */
  private pushSrcCache(): void {
    broadcastSrcCache()
  }

  /** 种一枚刚现拉到的有效源: 续录复用中断探针那一发, 不再打第二条完整取流链 */
  seedPlay(userId: string, pack: PlayResult): void {
    if (!pack.ok) return
    pack.fetchedAt = Date.now()
    this.playCache.set(userId, pack)
    this.pushSrcCache()
  }

  /** 只摘源包, 不动门槛账/保活读数, 不 bump 纪元(契约见 source.ts):
   *  播放器亲证的是"这一份地址死了", 而门槛账记的是平台那句话、它不会因为源包被摘就作废 ——
   *  一起撤就是让下一次进房重打整链(加请求)。
   *  Panda 的播放地址不经本地代理(实测 23:33:38 那次 404 主进程一行都没读到), 所以这一格是渲染层那句判决
   *  唯一能落地的地方: 保活的双测要再等两次心跳才追认, 那 5min14s 里徽标一直亮着。 */
  dropCachedPlay(userId: string, provenDeadUrl?: string): boolean {
    const pack = this.playCache.get(userId)
    if (!pack) return false
    // 给了亲证地址就对一遍: 手里这份不含它 = 源早被换掉, 那一份不是播放器踩死的那个, 不许顺手摘
    if (provenDeadUrl && pack.m3u8 !== provenDeadUrl && !pack.variants?.some((v) => v.url === provenDeadUrl))
      return false
    this.playCache.delete(userId)
    this.pushSrcCache()
    return true
  }

  invalidatePlay(userId: string): void {
    this.bumpEpoch(userId)
    this.playCache.delete(userId)
    this.keepaliveInfo.delete(userId)
    // 事件(重开播/录制出错/手动强刷)一发生就该重新问一次平台: 门槛账只许活到下一个事件。
    // 这一句现在连盘上那一格一起清 —— 落盘的那本跨重启, 留着它就是让"新一场"去吃上一场的旧话
    this.forgetGate(userId)
    this.playInflight.delete(userId)
    this.playInflight.delete(userId + '#pw')
    this.pushSrcCache()
  }

  clearPlayCache(): void {
    this.playEpochAll++ // 换号: 所有在飞的链一律不许落缓存
    this.playCache.clear()
    this.keepaliveInfo.clear()
    this.gates.clear() // 上一个账号的"爱心余额不足/粉丝门槛"对这一个账号毫无意义
    // 盘上同理 —— 换号后上一号那本结构性门槛账对新号毫无意义, 一格都不许留
    for (const a of store.listAnchors()) {
      if (a.platform === 'pandalive' && (a.gateCode || a.gateUntil)) store.updateAnchor('pandalive', a.userId, { gateCode: '', gateUntil: 0 })
    }
    this.gatesHydrated = false // 读回的那一本是上一号的; 新号第一次取源重读一次盘(此时盘已空)
    this.playInflight.clear()
    this.riskUntil = 0 // 上一号的风控静默不该闷住新账号的泵(与 SOOP 换号清账同语义,)
    this.oracleRiskUntil = 0 // 整表那一格同批清: 换号后的第一发整表问到答没答, 与上一号无关
    this.pushSrcCache()
  }

  // ---- 门槛回执的账: 平台明说过不去的那一类, 一段时间内不再替它重打整链 ----
  /** 只收"账号/房间门槛"这类不会自己好的码; 密码类与登录态类由上层重试, 不记账 */
  private static GATE_CODES = ['needAdult', 'needFan', 'needUnlimitItem', 'needCoinPurchase', 'castEnd']
  /** 退避一律不做指数 —— 内存与盘两本账共用这一把 15 分钟的尺, 同一格同一到期时刻。
   *  门槛多半是暂时的(充值 / 成年验证过了 / 主播中途撤了道具), 挡满一天等于把"已经好了"押到明天;
   *  代价是永久过不去的那一类每天重问 96 发, 而受限回执就来自 `/v1/live/play` 那一次 POST, 不必重打整链 */
  private static GATE_TTL_MS = 15 * 60_000
  /** 其中配落盘的三类: 说的是"这个账号过不了这道槛" ——
   *  实测本机 24 次冷启动/日, 每次都要替同一批明知过不去的房间重打整条取流链(真机留痕: 一天 81 行受限回执、4 间)。
   *  needFan 不落盘: 用户点一下加粉就翻, 15 分钟内存账是给它定的; castEnd 不落盘: 那句说的是"那一场已断", 新一场开播就不成立 */
  private static GATE_PERSIST = ['needAdult', 'needUnlimitItem', 'needCoinPurchase']
  /** 复核: 每格自带平台那句原始码。诊断台的 kind/persisted 从前是从 pack.error 那句**已本地化**的话里
   *  split(':')[0] 反推的 —— 只有落不进映射表的码才长成 "code: msg", 于是盘上那三类反而永远推不出码 ⇒
   *  「重启后还挡着」那颗徽章真机实拍永不亮, 而 kind 绕过渲染层自己的 i18n 映射(换语言就把旧话钉在旧语言上) */
  private gates = new Map<string, { until: number; pack: PlayResult; code: string }>()
  /** 盘上那本门槛账只读回一次(首次取源时), 之后内存是唯一的账本 */
  private gatesHydrated = false

  /** 把盘上那几格门槛账读回内存(不覆盖内存里已有的更新的一格), 顺手把过期的那一格从盘上抹掉 */
  private hydrateGates(): void {
    if (this.gatesHydrated) return
    this.gatesHydrated = true
    const now = Date.now()
    for (const a of store.listAnchors()) {
      if (a.platform !== 'pandalive' || !a.gateCode) continue
      // 认盘上那个时刻, 但最多认从现在起一把尺: 上一版(24 小时 / 退避阶梯)留下的长到期日不该把新尺子押到明天
      const until = Math.min(a.gateUntil || 0, now + PandaApi.GATE_TTL_MS)
      // 码不归落盘那三类 = 上一版残留的旧格 ⇒ 抹掉(它说的不是这一间这道槛)
      if (!PandaApi.GATE_PERSIST.includes(a.gateCode)) {
        this.dropPersistedGate(a.userId)
        continue
      }
      // 到期 = 盘上那句旧话过点了: 清掉这一格, 下一次取源照旧重问一发(内存那本没有这一格 ⇒ 不会被短路)
      if (until <= now) {
        this.dropPersistedGate(a.userId)
        continue
      }
      const cur = this.gates.get(a.userId)
      if (cur && cur.until > now) continue
      this.gates.set(a.userId, { until, pack: this.gateResult(a.gateCode, ''), code: a.gateCode })
    }
  }

  /** 盘上那一格: 只在真有账时才写, 免得每一次正常作废都带一次 db 覆写。
   *  清账的语义是"这句旧话过点了/不算数了", 下一次被挡重新从 15 分钟起 */
  private dropPersistedGate(userId: string): void {
    const a = store.listAnchors().find((x) => x.platform === 'pandalive' && x.userId === userId)
    if (!a || !(a.gateCode || a.gateUntil)) return
    store.updateAnchor('pandalive', userId, { gateCode: '', gateUntil: 0 })
  }

  /** 门槛账一起撤(内存 + 盘): 平台改口了(拿到源)、事件发生了(新一场/强刷/出错)、账号换了 —— 三种都是"那句旧话不算数了" */
  private forgetGate(userId: string): void {
    this.gates.delete(userId)
    this.dropPersistedGate(userId)
  }

  /** 受限码 → 给用户的那句话(唯一的映射处, 整链现拉与短路复用同一份) */
  private gateResult(code: string, message: string): PlayResult {
    if (code === 'needAdult') return { ok: false, error: mt('api.needAdult') }
    if (code === 'needLogin') return { ok: false, error: mt('api.needLogin') }
    if (code === 'needFan') return { ok: false, error: mt('api.needFan') }
    if (code === 'needUnlimitItem') return { ok: false, error: mt('api.needUnlimitItem') }
    if (code === 'needCoinPurchase') return { ok: false, error: mt('api.needCoinPurchase') }
    if (/pw|password/i.test(code)) return { ok: false, needPassword: true, error: mt('api.needPw') }
    return { ok: false, error: `${code}: ${message || mt('api.playFail')}` }
  }

  /** 诊断台(④⑫⑧⑩): 与 soopApi.diag 同一形状的那一块料, 全部来自内存账 —— 零请求、零写盘。
   *  Panda 的 playCache 不按年龄收手(只显式作废 + 保活泵续), 所以 ttlLeftMs 一律给 null:
   *  编一个"看起来对称"的时限比不给这一格更坏。 */
  diag(): PandaDiag {
    const now = Date.now()
    const live: DiagSourceRow[] = []
    for (const [userId, pack] of this.playCache) {
      live.push({ room: userId, fetchedAt: pack.fetchedAt || 0, variants: (pack.variants || []).length, partial: !!pack.partial, ttlLeftMs: null })
    }
    const gates: DiagGateRow[] = []
    for (const [userId, g] of this.gates) {
      if (g.until <= now) continue
      gates.push({ room: userId, until: g.until, kind: g.pack.needPassword ? 'pw' : g.pack.needLogin ? 'login' : g.code, persisted: PandaApi.GATE_PERSIST.includes(g.code) })
    }
    return {
      live,
      gates,
      epochAll: this.playEpochAll,
      riskLeftMs: Math.max(0, this.riskUntil - now),
      lastCheckAt: this.loginCheckedAt,
      // 30 秒: checkLoginInfo 那一发的结果能白用的时长(与上面判据同一个字面值)
      checkCacheTtlMs: 30_000,
      inflightBuys: this.playInflight.size,
      deadStreakRooms: this.deadStreak.size,
      lane: { queued: this.queue.length, pumping: this.pumping, gapMs: this.gapMs },
      fallbackCnt: this.fallbackCnt,
      keepalive: { on: store.getSettings().keepaliveStream, rooms: this.keepaliveInfo.size },
      gateTtlMs: PandaApi.GATE_TTL_MS,
      vaultCookies: Object.keys(this.jar).length
    }
  }

  // ---- 保活运行状态(供播放页"播放源卡"展示) ----
  private keepaliveInfo = new Map<string, { at: number; ok: boolean; variants: number }>()

  keepaliveStatus(platform: Platform, userId: string): {
    enabled: boolean
    cached: boolean
    lastAt: number
    lastOk: boolean
    variants: number
  } {
    // 本客户端只保活 pandalive 源: 他平台同名房间必须空态, 防跨平台串数据
    if (platform !== 'pandalive')
      return { enabled: store.getSettings().keepaliveStream, cached: false, lastAt: 0, lastOk: true, variants: 0 }
    const info = this.keepaliveInfo.get(userId)
    return {
      enabled: store.getSettings().keepaliveStream,
      cached: this.playCache.get(userId)?.ok === true,
      lastAt: info?.at || 0,
      lastOk: info?.ok ?? true,
      variants: info?.variants || 0
    }
  }

  private playInflight = new Map<string, Promise<PlayResult>>()

  /** 作废纪元: 与 soop 同策 —— 显式作废过一次的房, 先于它发出的链不许再把源写回来 */
  private playEpoch = new Map<string, number>()
  private playEpochAll = 0
  private epochOf(userId: string): number {
    return this.playEpochAll + (this.playEpoch.get(userId) || 0)
  }

  private bumpEpoch(userId: string): void {
    this.playEpoch.set(userId, (this.playEpoch.get(userId) || 0) + 1)
  }

  async getPlayCached(userId: string, password = '', forceFresh = false): Promise<PlayResult> {
    // 去重键带密码槽位: 无密码预取与用户手动输密码不共享在途(避免结果错配)
    const key = password ? userId + '#pw' : userId
    if (!forceFresh) {
      this.hydrateGates() // 冷启动第一次走到这儿把盘上那本门槛账读回来, 之后内存是唯一的账本
      const c = this.playCache.get(userId)
      if (c && c.ok) return c
      // 门槛回执的短路: 平台明说"这门槛过不去"(付费/成人/粉丝/道具/本场已断)的那句话不是网络故障,
      // 同一房在期限内重打整链只会换回同一句 —— 而这些码一个都不是分钟级会翻转的事。
      // 期限就是一把 15 分钟的尺(不做递增退避); 门槛多是暂时的, 一次挡满一天会把"已经好了"押到明天。
      // 用户手动强刷(forceFresh)与"带着密码来"的那几次照旧即时试; 开播/作废事件即解除(见 invalidatePlay)
      const g = this.gates.get(userId)
      if (g && g.until > Date.now() && !password) return { ...g.pack }
      // 在途复用: 预取泵/自动录制/手动进房并发时, 同一目标只有一发在途请求
      const flying = this.playInflight.get(key)
      if (flying) return flying
    }
    const e0 = this.epochOf(userId)
    const t0 = Date.now()
    const p = (async () => {
      try {
        const r = await this.fetchPlay(userId, password)
        // 平台这一回答应了 ⇒ 手里那本"过不去"的旧账当场作废(内存 + 盘)。
        // 纪元不合那份不落缓存, 但"这个账号现在过得去这道槛"这句话与落不落缓存无关, 照清。
        // 没有这一笔, 落盘那一格就成了死期: 用户充值/解封之后, 短路口仍会替他挡掉整条链
        if (r.ok) this.forgetGate(userId)
        // 打戳写法: 随缓存对象共存亡 —— 时戳既是播放页「上次取源」的读数, 也是保活泵收手的依据
        // 纪元不合 = 这条链出发后被作废过: 结果照还给调用方, 但不落缓存
        if (r.ok && this.epochOf(userId) === e0) {
          r.fetchedAt = Date.now()
          this.playCache.set(userId, r)
          this.pushSrcCache()
        } else if (forceFresh && !r.ok && !r.needPassword) {
          // 强制重取真打出去了却没拿到源, 手里那份就不再是"上一轮的现值"(现场 2026-10-03
          // 23:33:38 播放器亲证清单 404, 那份缓存却挂到 23:38:52 才被保活的双测追认 —— 5min14s 里徽标一直亮着);
          // needPassword 不算证据 —— 那句说的是"这次没带密码"
          const cur = this.playCache.get(userId)
          // 只作废"这条链出发之前"的那一份: 期间另一条链(无密/带密的键不同)写进了更新的源, 那份没说谎
          if (cur && (cur.fetchedAt || 0) < t0) {
            logger.warn('api', `强制重取没拿到源, 当场作废手里那份: @${userId}(${r.error || '无回包'})`)
            this.dropCachedPlay(userId) // 只摘源包: 门槛账留下, 下一次问价不必重打整链
          }
        }
        return r
      } finally {
        this.playInflight.delete(key)
      }
    })()
    this.playInflight.set(key, p)
    return p
  }

  /** 秒开快道: 与 getPlayCached(fullVariants=true) 同一条契约, 唯一的区别是
   *  "手里那份只解了最高档的包也照给" —— 播放器先出画, 缺的清晰度档由调用方另发一发补齐
   *  (那一发命中的是同一条在途链, 请求数一字不加)。Panda 的包从来不是 partial, 故直接同路。 */
  async getPlayFast(userId: string, password = '', forceFresh = false): Promise<PlayResult> {
    return this.getPlayCached(userId, password, forceFresh)
  }

  async fetchPlay(userId: string, password = ''): Promise<PlayResult> {
    const j = await this.jsonPriority<{
      result?: boolean
      message?: string
      errorData?: { code?: string }
      PlayList?: { hls?: { url: string }[]; hls2?: { url: string }[]; hls3?: { url: string }[] }
      media?: Record<string, unknown>
    }>('POST', '/v1/live/play', { action: 'watch', userId, password, shareLinkType: '' })

    const code = j?.errorData?.code
    if (code) {
      logger.info('api', `拉源受限 @${userId}: ${code}`) // 付费/成人/粉丝门槛: 用户可见也留痕
      const gate = this.gateResult(code, j.message || '')
      // 只有"账号/房间门槛"这一类才记账: needLogin 会由后台自愈重登, 密码错误用户下一次可能改对
      if (PandaApi.GATE_CODES.includes(code)) {
        const persist = PandaApi.GATE_PERSIST.includes(code)
        // 两本账同一把尺(退避不做指数) —— 内存与盘写的是同一个到期时刻, 不落盘那两类只把盘上可能残留的旧格清掉
        const until = Date.now() + PandaApi.GATE_TTL_MS
        this.gates.set(userId, { until, pack: gate, code })
        if (persist) store.updateAnchor('pandalive', userId, { gateCode: code, gateUntil: until })
        else this.dropPersistedGate(userId)
      }
      return gate
    }
    if (j?.result === false) {
      const msg = j.message || ''
      if (/비밀번호|password/i.test(msg)) return { ok: false, needPassword: true, error: mt('api.needPw') }
      // 现场实拍撞到的正是这一句(「너무 많은 요청이 발생했습니다」配 HTTP 200), 而旧账本只认
      // 403/429/≥500/HTML/非 JSON —— 平台亲口喊停的这一刻, 预取泵与重铸链照旧按 gap 一路打到底
      if (PandaApi.isRateLimitMsg(msg)) this.noteRisk(`拉源限流话术 @${userId}: ${msg}`, '/v1/live/play')
      logger.warn('api', `拉源失败 @${userId}: ${msg || '(无 message)'}`)
      return { ok: false, error: msg || mt('api.playFail') }
    }
    const pl = j?.PlayList
    const vod = String((j.media as { liveType?: string } | undefined)?.liveType || '') === 'rec'
    let hls = pl?.hls?.[0]?.url || ''
    let scanned = false
    if (!hls) {
      // 回放房: PlayList 结构与直播可能不同, 宽口径整树扫描 m3u8 兜底
      hls = scanM3u8(j)
      scanned = Boolean(hls)
      if (!hls) {
        if (vod) {
          // 校准通道: 原始响应落日志(截断), 真机一轮即可定位真实字段
          logger.warn('api', `回放流地址未解析到(@${userId}), 原始响应: ${JSON.stringify(j).slice(0, 4000)}`)
          return { ok: false, error: mt('api.vodParseFail') }
        }
        return { ok: false, error: mt('api.noStream') }
      }
    }
    const backups: string[] = []
    if (!scanned) {
      // 平台现状(2026-09 实勘多房间): hls/hls2/hls3 返回同一 URL, 且 master 令牌一回取即焚 ——
      // 同链"备用线路"点击必 403 无播放意义, 只保留与主线互异的真备用; 全同则去空(前端线路栏自动收起)
      for (const u of [pl?.hls2?.[0]?.url, pl?.hls3?.[0]?.url]) {
        if (u && u !== hls && !backups.includes(u)) backups.push(u)
      }
    }
    if (vod || scanned) {
      // 校准辅助: 回放源域名若不在流域名注入白名单(live-video.net / cloudfront.net),
      // 渲染层 hls.js 播放可能因缺 Origin 头被 403(ffmpeg 录制不受影响, 它自带头)
      try {
        const host = new URL(hls).hostname
        if (!/(^|\.)live-video\.net$/.test(host) && !/(^|\.)cloudfront\.net$/.test(host)) {
          logger.warn('api', `回放源域名 ${host} 不在头注入白名单(index.ts), 播放若 403 需要扩展注入域清单`)
        }
      } catch {
        /* ignore */
      }
    }
    // master 只活 10 分钟: 解析出长效变体地址供播放/录制直接使用
    const variants = await this.fetchVariants(hls)
    if (!variants) {
      // 平台宽限期: 下播后 play 仍可能 result:true 发已销毁频道的 URL —— 当场判死, 不入缓存
      logger.warn('api', `拉源判死 @${userId}: master 清单不可达(疑似已销毁频道)`)
      return { ok: false, error: mt('api.deadChannel') }
    }
    logger.info('api', `拉源成功 @${userId}${vod || scanned ? '[回放]' : ''} 档位=${variants.length}`)
    return {
      ok: true,
      vod: vod || scanned,
      m3u8: hls,
      variants,
      hlsBackups: backups,
      dlHeaders: PANDALIVE_DL_HEADERS,
      title: (j.media?.title as string) || '',
      nick: (j.media?.userNick as string) || '',
      thumbUrl: (j.media?.thumbUrl as string) || '',
      userImg: (j.media?.userImg as string) || '',
      media: j.media
    }
  }
}

// ---- 源缓存列表(跨平台并集) ----
// 渲染层「已缓存」徽标认的是 roomKey 列表, 两平台的缓存必须合成一份广播。
// 本客户端只认识自己, 其它平台客户端在模块初始化时把自家的列表登记进来。
const srcCacheProviders: Array<() => string[]> = []

export function registerSrcCacheProvider(list: () => string[]): void {
  srcCacheProviders.push(list)
}

/** 当前拿到有效直播源的全部房间主键(跨平台) */
export function cachedSourceIdsAll(): string[] {
  return [...api.cachedSourceIds(), ...srcCacheProviders.flatMap((p) => p())]
}

/** 源缓存变动统一广播(两平台共用) */
export function broadcastSrcCache(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(EV.srcCache, cachedSourceIdsAll())
}

export const api = new PandaApi()
