import { BrowserWindow, net, session } from 'electron'
import * as http from 'http'
import * as https from 'https'
import * as tls from 'tls'
import * as net2 from 'net'
import { EV } from '../../shared/types'
import type { Anchor } from '../../shared/types'
import { UA, sleep } from '../util'
import { vault, CookieJar } from './vault'
import { store } from './store'
import { logger } from './logger'
import { mt } from '../i18n'

// ============ pandalive API 客户端 ============
// - 全局限速队列(串行 + 最小间隔 + 抖动), 防 IP 风控
// - 请求走 Electron net(Chromium 网络栈), 代理经 session.setProxy 生效
// - Cookie 由 vault(DPAPI 加密) 持久化
// - 风控特征识别 -> RiskError, 供 watcher 熔断
// ==================================================

const API = 'https://api.pandalive.co.kr'
export const SESSION_PARTITION = 'persist:pl'

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

export interface PlayResult {
  ok: boolean
  needPassword?: boolean
  error?: string
  m3u8?: string
  /** 回放(liveType=rec)播放结果: 录制据此走单文件下载, 前端据此切换文案 */
  vod?: boolean
  /** 解析 master 得到的变体分档(带宽降序, 第一个为最高档) */
  variants?: VariantInfo[]
  hlsBackups?: string[]
  title?: string
  nick?: string
  thumbUrl?: string
  userImg?: string
  media?: Record<string, unknown>
  /** 本源包的生成时刻(缓存写入时打戳; 缓存命中/在途复用返回同一对象, 时戳天然一致) */
  fetchedAt?: number
}

export interface VariantInfo {
  url: string
  bandwidth: number
  resolution: string
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

export function applyProxy(proxyUrl: string): void {
  const ses = session.fromPartition(SESSION_PARTITION)
  const url = (proxyUrl || '').trim()
  nodeProxyUrl = url
  if (url) {
    void ses.setProxy({ proxyRules: url })
  } else {
    void ses.setProxy({ mode: 'direct' })
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
      s.on('secureConnect', () => resolve(s))
      s.on('error', reject)
    })
    conn.on('error', reject)
    conn.end()
  })
  return doHttpsRequest(method, u, headers, body, tlsSock)
}

class PandaApi {
  /** 拉取任意绝对 URL 文本(带 pandalive Origin/Referer, 经 session/代理/Node 兜底) */
  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Origin: 'https://www.pandalive.co.kr',
      Referer: 'https://www.pandalive.co.kr/'
    }
    if (this.hasSession()) headers['Cookie'] = this.cookieHeader
    const ses = session.fromPartition(SESSION_PARTITION)
    try {
      const sesFetch = (ses as unknown as { fetch?: typeof net.fetch }).fetch
      const res = sesFetch ? await sesFetch.call(ses, url, { headers }) : await net.fetch(url, { headers })
      if (res.status !== 200) {
        // M3: HTTP 错误(403/404 等风控/过期)绝不兜底重发 —— 同一请求打两遍放大风控面
        const err = new Error(`HTTP ${res.status}`) as Error & { httpStatus?: number }
        err.httpStatus = res.status
        throw err
      }
      return await res.text()
    } catch (e) {
      if ((e as { httpStatus?: number }).httpStatus) throw e // 原则同上: 只兜网络层异常
      const res = await nodeHttpRequest('GET', url, headers, undefined, nodeProxyUrl)
      if (res.status !== 200) {
        // 与主路径同构打标: 保活泵等消费方凭 httpStatus 区分"真死(403/404)"与"网络层未知"
        const err = new Error(`HTTP ${res.status}`) as Error & { httpStatus?: number }
        err.httpStatus = res.status
        throw err
      }
      return res.text
    }
  }

  /** 求 VOD 媒体清单总时长(秒): EXTINF 求和; 失败/非清单返回 0(前端退化为不定进度) */
  async fetchPlaylistDurationSec(url: string): Promise<number> {
    try {
      const text = await this.fetchText(url)
      let sum = 0
      for (const l of text.split('\n')) {
        const m = /^#EXTINF:([\d.]+)/.exec(l.trim())
        if (m) {
          const s = Number(m[1])
          if (Number.isFinite(s)) sum += s // 脏行护栏: NaN 不进和(总时长 NaN 会击穿进度估算)
        }
      }
      return sum
    } catch {
      return 0
    }
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

  private harvestCookies(setCookies: string[]): void {
    let changed = false
    for (const c of setCookies) {
      const pair = c.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) {
        this.jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
        changed = true
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
  private async rawFetch(
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
    // (/v1/member/login 的多 Set-Cookie 响应) 会触发 net::ERR_FAILED, 回退 Node fetch
    let status: number
    let text: string
    try {
      const sesFetch = (ses as unknown as { fetch?: typeof net.fetch }).fetch
      const res = sesFetch
        ? await sesFetch.call(ses, API + path, { method, headers, body })
        : await net.fetch(API + path, { method, headers, body })
      if (!jarOverride) this.harvest(res)
      status = res.status
      text = await res.text()
    } catch (e) {
      if (e instanceof Error && e.message.includes('ERR_FAILED')) {
        // 兜底: Node 原生请求(支持代理 CONNECT 隧道, 与设置页代理一致)
        const res = await nodeHttpRequest(method, API + path, headers, body, nodeProxyUrl)
        if (!jarOverride) this.harvestCookies(res.setCookies)
        status = res.status
        text = res.text
      } else {
        throw e
      }
    }
    if (status === 403 || status === 429) {
      logger.warn('api', `疑似风控: HTTP ${status} ${method} ${path}`)
      throw new RiskError(mt('api.riskHttp', { status }), status)
    }
    if (status >= 500) {
      logger.warn('api', `服务器错误: HTTP ${status} ${method} ${path}`)
      throw new RiskError(mt('api.riskServer', { status }), status)
    }
    if (text.trimStart().startsWith('<')) {
      logger.warn('api', `返回HTML疑似风控验证页: ${method} ${path} (HTTP ${status})`)
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
  async login(loginId: string, password: string): Promise<{ ok: boolean; message: string }> {
    await this.enqueue(async () => {
      // 登录接口返回空字符串, 成功以 Set-Cookie(sessKey) 为准
      await this.rawFetch('POST', '/v1/member/login', { loginId, password })
      return null
    })
    if (!this.hasSession()) {
      return { ok: false, message: mt('auth.loginFail') }
    }
    this.saveCookies()
    // 官方校验: isLogin 为 false 说明被防自动登录验证码静默拦截 -> 回滚假会话
    const info = await this.checkLoginInfo()
    if (!info.isLogin) {
      this.clearCookies()
      this.cookieValid = false
      return {
        ok: false,
        message: mt('auth.loginBlocked')
      }
    }
    this.cookieValid = true
    return { ok: true, message: mt('auth.loginOk') }
  }

  /** 官方登录态校验: 返回 isLogin / isAdult(成人认证) 等; 可提供 jar 进行"试验证"(不落地) */
  async checkLoginInfo(jarOverride?: CookieJar): Promise<{ isLogin: boolean; isAdult: boolean; idx: number | null }> {
    try {
      const { text } = await this.rawFetch('POST', '/v1/member/login_info', {}, {}, jarOverride)
      const j = this.parseText<{
        result?: boolean
        loginInfo?: { userInfo?: { isLogin?: boolean; isAdult?: boolean; idx?: number } }
      }>(text)
      const ui = j?.loginInfo?.userInfo || {}
      return { isLogin: !!ui.isLogin, isAdult: !!ui.isAdult, idx: ui.idx ?? null }
    } catch {
      return { isLogin: false, isAdult: false, idx: null }
    }
  }

  /** 导入 cookie; infoPre = 已做过的 login_info 校验结果(传入则消重, 不重复请求) */
  async importCookies(jar: CookieJar, infoPre?: { isLogin: boolean; isAdult: boolean }): Promise<void> {
    this.jar = { ...this.jar, ...jar }
    this.saveCookies()
    this.clearPlayCache() // 新会话生效: 旧会话签发的源清空重来
    const info = infoPre ?? (await this.checkLoginInfo())
    this.cookieValid = info.isLogin
  }

  /** 拉一页全站直播列表; 响应带 loginInfo 可校验登录态; adultShowAdModeYN=Y 对认证账号开放 19+ 列表 */
  async fetchLivePage(offset: number, limit = 100): Promise<{ list: LiveItem[]; loginInfo: unknown }> {
    const j = await this.json<{ list?: LiveItem[]; loginInfo?: unknown; result?: boolean; message?: string }>(
      'GET',
      `/v1/live?hotyn=Y&adultShowAdModeYN=Y&offset=${offset}&limit=${limit}`
    )
    if ((j as { result?: boolean })?.result === false) {
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

  // ---- 拉源缓存: 不设时限, 源能用就一直用; 仅显式事件作废(重开播/录制出错/换号/手动强刷) ----
  private playCache = new Map<string, PlayResult>()

  /** "已获取有效直播源"的主播 userId 集(缓存即事实源; 卡片「秒开」徽标的用户可见投影) */
  cachedSourceIds(): string[] {
    return [...this.playCache.entries()].filter(([, v]) => v.ok).map(([k]) => k)
  }

  // ---- 源保活泵: 轻量心跳维持 IVS 会话活性 ----
  // 场景: 前期取了源退出观看, 后期房间满员无法再调 /v1/live/play —— 满员拦截的是拉源 API,
  // 不是流本身; 只要会话被持续请求养着, 旧源就能一直看。
  // 心跳 = 每源每档只拉清单(数 KB), 不拉分片; 直达 CDN, 不占用 pandalive API 限速队列。
  // 判死纪律: 只有主档 403/404(会话真死)计 strike; 网络层错误(断网/休眠/超时)不计 ——
  // 否则断网恢复瞬间全量误杀+对瘫痪 API 群重铸。连续 2 次真死才收尸; 收尸后若在播+开预取立即重铸。
  private static KEEPALIVE_MS = 15_000
  /** 泳道并发数: 串行泵在大关注量下有效心跳会被拉长(实测 100 源×5 档 ≈ 148s/源);
   *  4 泳道 + 50ms 间隙把 100 源心跳压回 ~16s, 对 CDN/本地均为平缓节奏 */
  private static KEEPALIVE_LANES = 4
  private keepaliveTimer: NodeJS.Timeout | null = null
  private keepaliveBusy = false
  private deadStreak = new Map<string, number>()
  /** 重铸串行链: 泳道并发的群体性收尸合并为链式排队, 与主请求队列同节奏(1.2s+抖动),
   *  防 API 突发触发风控(机器驱动的后台修复, 不配用 jsonPriority 的用户级特权)。
   *  风控自闭环: 重铸撞上 RiskError 即可知 API 在高压期 → 全链冷却 5 分钟闭嘴(与 watcher 熔断同语义,
   *  跨模块零依赖); 冷却期补源暂缓(徽标暂熄可接受), 用户进房 getPlayCached 仍会即时重建。 */
  private remintTail: Promise<void> = Promise.resolve()
  private remintCooldownUntil = 0
  private remintCoolLogged = false

  private enqueueRemint(userId: string): void {
    if (Date.now() < this.remintCooldownUntil) {
      if (!this.remintCoolLogged) {
        this.remintCoolLogged = true
        logger.info('api', '重铸冷却中(重铸曾撞风控), 暂缓补源 —— 徽标暂熄, 进房时即重建')
      }
      return
    }
    this.remintTail = this.remintTail.then(async () => {
      // 链步内二次检查: 前序步可能刚把冷却立起来 —— 双检查让"冷却期零重铸"成为结构保证而非时序运气
      if (Date.now() >= this.remintCooldownUntil) {
        try {
          await this.getPlayCached(userId)
          logger.info('api', `保活重铸: @${userId}`)
        } catch (e) {
          if (e instanceof RiskError) {
            this.remintCooldownUntil = Date.now() + 5 * 60_000
            this.remintCoolLogged = false
            logger.warn('api', `保活重铸撞风控(@${userId}), 全链冷却 5 分钟`)
          }
          // 其余错误(满员/网络)维持静默语义
        }
      }
      const jitter = 1200 * (0.7 + Math.random() * 0.6)
      await sleep(jitter)
    })
  }

  startKeepalive(): void {
    if (this.keepaliveTimer) return
    logger.info('api', `源保活泵已启动(基准 ${PandaApi.KEEPALIVE_MS / 1000}s, 随缓存规模 0.4s/源 自适应放宽, 封顶 120s)`)
    const loop = async (): Promise<void> => {
      try {
        await this.keepaliveTick()
      } finally {
        if (this.keepaliveTimer) {
          // 自适应间隔: 15s 基准; 每多一缓存源放宽 400ms(上限 120s) —— 大规模关注下日流量封顶 ~2.7GB,
          // 单源心跳 40s~120s 对 IVS 会话闲置容忍仍属健康量级
          const wait = Math.min(120_000, Math.max(PandaApi.KEEPALIVE_MS, this.playCache.size * 400))
          this.keepaliveTimer = setTimeout(() => void loop(), wait)
        }
      }
    }
    this.keepaliveTimer = setTimeout(() => void loop(), PandaApi.KEEPALIVE_MS)
  }

  private async keepaliveTick(): Promise<void> {
    if (this.keepaliveBusy) return
    if (!store.getSettings().keepaliveStream) return
    this.keepaliveBusy = true
    try {
      const anchors = new Map(store.listAnchors().map((a) => [a.userId, a]))
      // 快照防漂移: tick 期间缓存可能增删
      const queue = [...this.playCache.entries()].filter(([userId, pack]) => {
        if (!pack.ok || pack.vod) return false // 回放是静态分片, 无会话活性概念
        const a = anchors.get(userId)
        return !a || a.isLive // 已知下播: 会话死亡属预期, 不耗心跳; 未关注源(回访场景)照常养
      })
      const lanes = Array.from({ length: PandaApi.KEEPALIVE_LANES }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          await this.keepaliveSource(next[0], next[1], anchors.get(next[0]))
          await sleep(50)
        }
      })
      await Promise.all(lanes)
    } finally {
      this.keepaliveBusy = false
    }
  }

  /** 单源心跳: 全档齐养(只看最高档会让其它档会话饿死, 切清晰度时暴毙); 主档 403/404 才计真死 */
  private async keepaliveSource(userId: string, pack: PlayResult, a: Anchor | undefined): Promise<void> {
    const urls = [
      ...new Set((pack.variants?.length ? pack.variants.map((v) => v.url) : [pack.m3u8 || '']).filter((u): u is string => Boolean(u)))
    ]
    if (!urls.length) return
    let primaryDead = false
    for (const url of urls) {
      const isPrimary = url === urls[0]
      try {
        await Promise.race([
          this.fetchText(url),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('keepalive timeout')), 12_000))
        ])
      } catch (e) {
        const st = (e as { httpStatus?: number }).httpStatus
        if (isPrimary && (st === 403 || st === 404)) primaryDead = true
        // 网络层错误: 不计死(断网即整批阵亡的语义错误); 非主档失败: 仅观测
      }
      await sleep(50)
    }
    this.keepaliveInfo.set(userId, { at: Date.now(), ok: !primaryDead, variants: urls.length })
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
    if (a?.isLive && store.getSettings().prefetchStream) {
      this.enqueueRemint(userId)
    }
  }

  /** 源缓存变动统一广播: 渲染层据此点亮/熄灭卡片「秒开」徽标 */
  private pushSrcCache(): void {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.srcCache, this.cachedSourceIds())
  }

  invalidatePlay(userId: string): void {
    this.playCache.delete(userId)
    this.keepaliveInfo.delete(userId)
    this.pushSrcCache()
  }

  clearPlayCache(): void {
    this.playCache.clear()
    this.keepaliveInfo.clear()
    this.pushSrcCache()
  }

  // ---- 保活运行状态(供播放页"播放源卡"展示) ----
  private keepaliveInfo = new Map<string, { at: number; ok: boolean; variants: number }>()

  keepaliveStatus(userId: string): {
    enabled: boolean
    cached: boolean
    lastAt: number
    lastOk: boolean
    variants: number
  } {
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

  async getPlayCached(userId: string, password = '', forceFresh = false): Promise<PlayResult> {
    // 去重键带密码槽位: 无密码预取与用户手动输密码不共享在途(避免结果错配)
    const key = password ? userId + '#pw' : userId
    if (!forceFresh) {
      const c = this.playCache.get(userId)
      if (c && c.ok) return c
      // 在途复用: 预取泵/自动录制/手动进房并发时, 同一目标只有一发在途请求
      const flying = this.playInflight.get(key)
      if (flying) return flying
    }
    const p = (async () => {
      try {
        const r = await this.fetchPlay(userId, password)
        // 打戳写法: 随缓存对象共存亡 —— invalidate/clear 时戳自动作废, 与不设 TTL 的契约一致
        if (r.ok) {
          r.fetchedAt = Date.now()
          this.playCache.set(userId, r)
          this.pushSrcCache()
        }
        return r
      } finally {
        this.playInflight.delete(key)
      }
    })()
    this.playInflight.set(key, p)
    return p
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
      if (code === 'needAdult') return { ok: false, error: mt('api.needAdult') }
      if (code === 'needLogin') return { ok: false, error: mt('api.needLogin') }
      if (code === 'needFan') return { ok: false, error: mt('api.needFan') }
      if (code === 'needUnlimitItem') return { ok: false, error: mt('api.needUnlimitItem') }
      if (code === 'needCoinPurchase') return { ok: false, error: mt('api.needCoinPurchase') }
      if (/pw|password/i.test(code)) return { ok: false, needPassword: true, error: mt('api.needPw') }
      return { ok: false, error: `${code}: ${j.message || mt('api.playFail')}` }
    }
    if (j?.result === false) {
      const msg = j.message || ''
      if (/비밀번호|password/i.test(msg)) return { ok: false, needPassword: true, error: mt('api.needPw') }
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
      title: (j.media?.title as string) || '',
      nick: (j.media?.userNick as string) || '',
      thumbUrl: (j.media?.thumbUrl as string) || '',
      userImg: (j.media?.userImg as string) || '',
      media: j.media
    }
  }
}

export const api = new PandaApi()
