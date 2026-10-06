import { session } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { logger } from './logger'

// ============ 本地 HLS 过滤代理 ============
// SOOP 的播放清单有两处坑, 直接喂给 ffmpeg / hls.js 都会出事:
//   1. 清单里的分段是相对地址且需要带 Origin/Referer/Cookie —— 渲染层拿不到、ffmpeg 传头也嫌脏;
//   2. 尾部可能挂 name 含 preloading 的预载分段, 内容尚未写完, 取到就是半截 TS(实测偶发, 不代表常态)。
// 因此所有 SOOP 流统一走 127.0.0.1 的一层本地代理: 播放清单在本地重写并把分段收进 /media,
// 上游请求头由本模块注入。用户看到的"播放源"是代理地址, 复制到外部播放器会失效(设计上已说明)。
// 访问面三道闸: 只绑回环 + 目标 origin 必须是本代理签发过的(表有上限、按活跃度淘汰)
// + 每个 URL 带一次性令牌(?t=, 仅 playlistUrl / 清单重写产出的地址里有)。
// ==========================================

/** 伴随标签: 过滤预载分段时要连同它们一起丢弃, 否则留下"有 EXTINF 无 URI"的非法清单 */
const URI_TAG_PREFIXES = [
  '#EXTINF',
  '#EXT-X-BYTERANGE',
  '#EXT-X-STREAM-INF',
  '#EXT-X-PROGRAM-DATE-TIME',
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-CUE-OUT',
  '#EXT-X-CUE-IN',
  '#EXT-X-DATERANGE'
]

function isUriTag(line: string): boolean {
  return URI_TAG_PREFIXES.some((p) => line.startsWith(p))
}

function looksLikePlaylist(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('.m3u8') || lower.endsWith('.m3u')
}

/** 重写 m3u8: 分段与 EXT-X-MAP 的 URI 收进本地 /media, 顺带剔除预载分段 */
export function rewritePlaylist(content: string, baseUrl: string, mediaUrlOf: (abs: string) => string, filterPreloading: boolean): string {
  const out: string[] = []
  let pending: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const rewritten = rewriteTagUri(line, baseUrl, mediaUrlOf)
      if (isUriTag(line)) pending = [...pending, rewritten]
      else {
        out.push(...pending, rewritten)
        pending = []
      }
      continue
    }
    const abs = new URL(line, baseUrl).href
    if (filterPreloading && abs.includes('preloading')) {
      pending = [] // 预载段连同其 EXTINF 等伴随标签一起丢
      continue
    }
    out.push(...pending, mediaUrlOf(abs))
    pending = []
  }
  out.push(...pending)
  return out.join('\n') + '\n'
}

/** 只重写标签里第一个 URI="..."(EXT-X-MAP 等), 其余原样保留 */
function rewriteTagUri(line: string, baseUrl: string, mediaUrlOf: (abs: string) => string): string {
  const start = line.indexOf('URI="')
  if (start < 0) return line
  const valueStart = start + 5
  const end = line.indexOf('"', valueStart)
  if (end < 0) return line
  const raw = line.slice(valueStart, end)
  try {
    return line.slice(0, valueStart) + mediaUrlOf(new URL(raw, baseUrl).href) + line.slice(end)
  } catch {
    return line
  }
}

/** 一次上游读的成品(状态/内容类型/已读满的正文): 清单给字符串, 分片给 Buffer —— 合流分发给每个本地读者 */
interface ProxyRead {
  status: number
  type: string
  body: Buffer | string
}

export interface HlsProxyOptions {
  /** 每次上游请求现取请求头(登录态会变, 不能在建代理时冻结) */
  headers: (target: string) => Promise<Record<string, string>> | Record<string, string>
  /** 拉上游用哪个 session(继承其代理设置); 传空则走默认 session */
  sessionPartition?: string
  /** 上游清单判死(403/404 = 场次凭证已作废): 调用方据此收掉对应源缓存。
   *  5xx/超时不回调 —— 那是上游抖动, 收尸会把好源误杀 */
  onDeadUpstream?: (target: string, status: number) => void
}

export class HlsProxy {
  private server = createServer((req, res) => void this.handle(req, res))
  private port = 0
  /** 本代理签发过的上游 origin。代理会替请求附上 SOOP 登录 Cookie, 目标地址绝不能由请求方任意指定:
   *  只放行自家签发过的地址(playlistUrl + 清单重写时逐条登记), 本机其它进程/网页便无法把它当开放代理用
   *  Map 记"最后一次被签发的时刻"而不是 Set: 长跑挂机每轮换 CDN 会让这张表只增不减, 面越铺越宽 */
  private readonly allowedOrigins = new Map<string, number>()
  /** 同时保活的签发 origin 上限: SOOP 一场直播只用 1~2 个 CDN, 32 已远超需要, 超出按最久未签发淘汰 */
  private static readonly MAX_ORIGINS = 32
  /** 每次请求必须带的令牌: 端口是回环随机口, 但本机任意进程都能扫到它并借它带着用户 Cookie 出网。
   *  令牌只出现在本代理自己签发的 playlistUrl / mediaUrl 里, 第三方构造不出可用地址 */
  private readonly token = randomBytes(16).toString('hex')

  constructor(private readonly opts: HlsProxyOptions) {
    // ffmpeg/hls.js 会复用长连接取分段: 服务端一旦主动掐掉空闲 keep-alive, 下一发请求就是连接重置。
    // 只设请求侧超时, 不给连接设超时。
    this.server.keepAliveTimeout = 0
    this.server.requestTimeout = 0
    this.server.headersTimeout = 0
  }

  /** 绑定随机空闲端口; 失败即抛, 调用方据此判定取流失败(soop.ts 不做直连回落) */
  listen(): Promise<void> {
    if (this.port) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      // 只绑回环: 代理会替请求附上登录 Cookie, 不能暴露到局域网
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        // once(reject) 已自我摘除: 运行期再来的 'error' 若无人接管就是未捕获异常, 这里补一个常驻出口
        this.server.on('error', (e) => logger.warn('hls', `HLS 代理运行期错误: ${String((e as Error).message || e)}`))
        logger.info('hls', `SOOP HLS 代理已启动: 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  /** 诊断台: 这一页只问"小站活着没、在途几条"。它起不来 = 所有 SOOP 地址一起不能用,
   *  而今天界面上的表现只是"打不开"。mergedPlays/Segs 是近 60 秒的合流数(noteMerge 出声即清零) */
  diag(): { up: boolean; port: number; origins: number; maxOrigins: number; inflight: number; mergedPlays: number; mergedSegs: number } {
    return {
      up: this.port > 0,
      port: this.port,
      origins: this.allowedOrigins.size,
      maxOrigins: HlsProxy.MAX_ORIGINS,
      inflight: this.inflightReads.size,
      mergedPlays: this.mergedPlays,
      mergedSegs: this.mergedSegs
    }
  }

  /** 播放清单入口: 上游 m3u8 经本地重写后回给播放器/ffmpeg */
  playlistUrl(upstream: string): string {
    this.allowTarget(upstream)
    return `http://127.0.0.1:${this.port}/playlist.m3u8?t=${this.token}&url=${encodeURIComponent(upstream)}`
  }

  private allowTarget(raw: string): void {
    try {
      const origin = new URL(raw).origin
      // 重复签发 = 刷新时效(活跃 CDN 永不被淘汰), 新 origin 超上限时淘汰最久未签发的那个
      this.allowedOrigins.set(origin, Date.now())
      if (this.allowedOrigins.size > HlsProxy.MAX_ORIGINS) {
        let oldest = ''
        let at = Infinity
        for (const [o, t] of this.allowedOrigins) if (t < at && o !== origin) ((at = t), (oldest = o))
        if (oldest) {
          this.allowedOrigins.delete(oldest)
          logger.info('hls', `签发 origin 表已满(${HlsProxy.MAX_ORIGINS}), 淘汰最久未用: ${oldest}`)
        }
      }
    } catch {
      /* 非法地址: 不登记, handle() 里也一律拒 */
    }
  }

  /** 分段/EXT-X-MAP 的本地地址: 顺带放行其 origin —— 清单里指向哪个 CDN, 下一次 /media 才取得到 */
  private mediaUrlOf = (abs: string): string => {
    this.allowTarget(abs)
    return `http://127.0.0.1:${this.port}/media?t=${this.token}&url=${encodeURIComponent(abs)}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      if (u.pathname !== '/playlist.m3u8' && u.pathname !== '/media') {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
        res.end('not found')
        return
      }
      // 令牌先于一切校验: 少这一道, 本机任何进程扫到端口就能借用户 Cookie 拉任意已签发 origin
      if (u.searchParams.get('t') !== this.token) {
        res.writeHead(403, { 'Access-Control-Allow-Origin': '*' })
        res.end('bad token')
        return
      }
      const raw = u.searchParams.get('url') || ''
      if (!/^https?:\/\//i.test(raw)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' })
        res.end('bad url')
        return
      }
      // 目标必须是本代理签发过的 origin, 否则等于开着带凭证的任意转发口
      let origin = ''
      try {
        origin = new URL(raw).origin
      } catch {
        origin = ''
      }
      if (!this.allowedOrigins.has(origin)) {
        res.writeHead(403, { 'Access-Control-Allow-Origin': '*' })
        res.end('target not allowed')
        return
      }
      if (u.pathname === '/playlist.m3u8' || looksLikePlaylist(raw)) {
        await this.servePlaylist(raw, res)
        return
      }
      await this.serveRaw(raw, res)
    } catch (e) {
      logger.warn('hls', `HLS 代理处理失败: ${String((e as Error).message || e)}`)
      if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' })
      res.end('proxy error')
    }
  }

  private async fetchUpstream(target: string, timeoutMs: number): Promise<Response> {
    const headers = await this.opts.headers(target)
    const ses = this.opts.sessionPartition ? session.fromPartition(this.opts.sessionPartition) : session.defaultSession
    // 走 session.fetch 与主进程其它请求同享代理设置; net.fetch 自身无超时, 用 AbortController 兜住
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    return ses
      .fetch(target, { headers, signal: ctrl.signal })
      .finally(() => clearTimeout(timer))
  }

  /** 在途合流: 同一个上游地址在同一瞬时被两个本地读者要 —— 最常见的形状是"边播边录同一房"
   *  (播放器与 ffmpeg 各自轮询同一份清单、各自要同一个分片)。旧写法是一比一发往上游打,
   *  分片字节数翻倍而内容一字不差。
   *  只合流、不加 TTL 缓存: 直播清单的正确读法本来就是"每一轮都要新的", 缓存会把新段读成旧段。
   *  读满进内存再分发给各读者: 任一客户端中途断开都不影响另一个(共享流式体做不到这一点) */
  private inflightReads = new Map<string, Promise<ProxyRead>>()

  /** 合流计数: 每一次命中省下的是一遍"内容一字不差的上游读", 不记就永远不知道这条链在替谁省。
   *  分片是高频件, 逐次写会把日志刷成计数器 ⇒ 60 秒出声一次, 清单/分片各记各的数 */
  private mergedPlays = 0
  private mergedSegs = 0
  private mergedLogUntil = 0
  private noteMerge(kind: 'playlist' | 'segment'): void {
    if (kind === 'playlist') this.mergedPlays++
    else this.mergedSegs++
    const now = Date.now()
    if (now < this.mergedLogUntil) return
    this.mergedLogUntil = now + 60_000
    const p = this.mergedPlays
    const s = this.mergedSegs
    this.mergedPlays = 0
    this.mergedSegs = 0
    logger.info('hls', `上游在途合流 ×${p} 清单 / ×${s} 分片(近 60 秒): 后到的读者共用这一次上游读, 不再重打`)
  }

  private readUpstream(target: string, timeoutMs: number, kind: 'playlist' | 'segment'): Promise<ProxyRead> {
    const flying = this.inflightReads.get(target)
    if (flying) {
      this.noteMerge(kind)
      return flying
    }
    const p = (async (): Promise<ProxyRead> => {
      const up = await this.fetchUpstream(target, timeoutMs)
      const type = up.headers.get('content-type') || (kind === 'playlist' ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
      if (kind === 'playlist')
        return {
          status: up.status,
          type,
          body: up.status === 200 ? rewritePlaylist(await up.text(), target, this.mediaUrlOf, true) : `upstream ${up.status}`
        }
      return { status: up.status, type, body: Buffer.from(await up.arrayBuffer()) }
    })().finally(() => {
      if (this.inflightReads.get(target) === p) this.inflightReads.delete(target) // 按身份撒锁(与全站榜翻页同规约)
    })
    this.inflightReads.set(target, p)
    return p
  }

  private async servePlaylist(target: string, res: ServerResponse): Promise<void> {
    const r = await this.readUpstream(target, 15_000, 'playlist')
    if (r.status !== 200) {
      if (r.status === 403 || r.status === 404) this.opts.onDeadUpstream?.(target, r.status)
      res.writeHead(r.status || 502, { 'Access-Control-Allow-Origin': '*' })
      res.end(typeof r.body === 'string' ? r.body : `upstream ${r.status}`)
      return
    }
    res.writeHead(200, {
      'Content-Type': r.type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    })
    res.end(r.body)
  }

  private async serveRaw(target: string, res: ServerResponse): Promise<void> {
    const r = await this.readUpstream(target, 30_000, 'segment')
    const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body)
    res.writeHead(r.status === 0 ? 502 : r.status, {
      'Content-Type': r.type,
      'Content-Length': String(buf.length),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    })
    res.end(buf)
  }
}
