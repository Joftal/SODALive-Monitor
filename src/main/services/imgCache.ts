import { net, session } from 'electron'
import { UA } from '../util'
import { logger } from './logger'
import { SESSION_PARTITION } from './pandalive'
import { parseImgSrc } from '../../shared/imgUrl'

// ============ 卡片图的本机缓存 ============
// 现场读数(2026-10-03 普查 678 发 + 2026-10-04 本机复测, 两条独立样本同结论):
//   · liveimg.sooplive.com 一个缓存指示头都没有(cache-control / etag / last-modified 全 null);
//     同一时刻带 ?随机 / 带 ?1 / 不带 query 三次取回的是同一份字节(sha256 完全一致),
//     同一路径隔 45 秒再取内容就换了(146f8e1505ff → 8b20579c08f3 → 4dada6831308)
//     ⇒ 那个 query 只是平台自己打穿缓存的版本号, 内容跟着路径走、随时间换。
//   · stimg.sooplive.com 头像回 Cache-Control: max-age=60(连 404 都带这一句), last-modified 是 2024/2026 的老值。
//   · 同窗口 Panda 的 cdn.pandalive.co.kr 是 27 个不同 URL 各 1 发 —— Chromium 本来就命中, 这一格不碰它。
// 结果(这一格后来自己把它改判了, 记下这一段是因为原始那笔读数不值得再信一遍):
//   普查(2026-10-03, 1400 秒 / 678 发)里 liveimg + stimg 共 42 个路径各 2 发 = 83 发 —— 但那份计数的键是
//   "host + pathname", query 压根没进键(整份 jsonl 里 '?' 出现 0 次), 于是平台每轮换的版本号被合并成"同一条问了两次"。
//   真机 2026-10-04 两次按同一支舞蹈切墙(首绘后约 9 秒 / 67 秒 / 90 秒各一次): 卡片图每轮都换 query ⇒ 每轮必问(那是该问的那一遍),
//   头像 Chromium 一次都没再问 ⇒ 这本账全程 hit=0 / merged=0, 34 发 = 渲染层问出来的不同地址数, 一发没省下也没多发。
//   ⇒ 这一层目前唯一实测到的作用是"同一版本被问两遍时合并"; 省发本身未实拍, 撤不撤要等它实拍到才判。
//
// 这一层的全部取舍:
//   1) 只在内存, 不落盘 —— 落盘要么扩 plocal 的文件白名单(多一条边界), 要么再造一条协议(多一次注册)。
//      而这一格要省的是"同一版本被问两遍", 那是同一次运行内的事; 跨启动那 34 发(2026-10-04 实测的首绘量)与它值不值得落盘相比
//      更接近"为不存在的东西存东西"(卡片图的地址每场都换)。
//   2) 键 = 去掉纯数字版本号之后的地址(query 的那一段不算身份)——
//      那句"query 换了通常意味着内容也换了"读数不成立: 同一条 path 用 5 个 counter(含两个编造的)
//      取回全部同一份字节, 而隔 70 秒再取内容必换 ⇒ 内容跟着**时间**走、既不跟着 query 也不跟着别的,
//      把 query 抹平不会"替平台吃掉版本号"(版本号从来不影响回包), 停帧上限仍是 TTL 那 60 秒。
//      只认 `?<纯数字>` 这一种形状(实测 28 间在播房的 thumbUrl 共用同一枚 ?29851761 ⇒ 全局计数), 其余 query 照旧进键。
//      冷启动那一对相隔 3.3 秒的双绘由此合并(3/3 在播房在 3.0 秒处字节相同 —— 实测), 每轮那一发照旧发(轮距 63.6 秒 > TTL)。
//   3) TTL 60 秒 = 两域各自说话的那个数(liveimg 实测约一分钟换一次内容 / stimg 官方 max-age=60)。
//      这一格只减「同一件东西被问了两遍」, 不减「该问的那一遍」: 到点就问, 问法与今天一字不差。
//   4) 失败分两种, 只有一种记账: 官方的 404 是答案(没传过 logo 的房), 记 15 秒短账挡掉同一面的重复问,
//      记满 60 秒则「刚传了头像」要晚一分钟才出现在卡片上 —— 展示面不值得那样;
//      而超时/5xx/非图是我方这一发没成, 手里没旧图时一律不留账(真机实测: 留了就等于把一次冷启动打嗝画成整轮空白),
//      手里有旧图才推短账 —— 卡片停在上一帧, 到点再问。
//   5) 上限跟着实测走: 暖着 0.4~1.3 秒, 冷启动整站停顿过一次约 9 秒 ⇒ 20 秒, 有界但不掐本会画好的图。
//   6) 取法跟着「设置-代理」: 走 persist:pl 那条 session(主窗口本来就挂在这一 partition, 与渲染层今天发这些请求走的是同一条道),
//      换到主进程不许悄悄把代理绕成直连。
// 车道豁免: 与 hlsProxy/流域同理(车道只管 API 站) —— 42 发排在一条尾锁后面会把卡片墙拖成白屏。
// ==========================================================

/** 一次取回的答案在本机值多久(实测两域各自给的数就是 60 秒) */
const TTL_MS = 60_000
/** 失败那一格的短账: 只挡「同一瞬一批卡片同时问同一个坏地址」, 不把坏消息留满一轮 */
const FAIL_TTL_MS = 15_000
/** 预算与上限(张数=在播房 + 头像数, 本机量级 876 关注 / 21 在播; 字节按 liveimg 29KB ~ stimg 1.5MB 的量给) */
const MAX_ENTRIES = 300
const MAX_BYTES = 24 * 1024 * 1024
// 实测(2026-10-04 本机两次取证): 暖着的那几发 447~1339ms, 而冷启动那一批整站停顿了约 9 秒
// (同一时刻登录核对也才刚落回包) —— 8 秒会把这种打嗝整批剪成失败, 上限给到 20 秒: 仍然有界, 但不再掐一张本会画好的图
const FETCH_TIMEOUT_MS = 20_000
const MAX_URL_LEN = 600

interface Entry {
  /** 失败那一格不带字节(404 也归这一格: 它是个答案, 但不是能画出来的东西) */
  bytes?: Uint8Array
  type: string
  exp: number
  /** 状态码读数: 命中缓存的 200 与命中缓存的失败都按这一格出声(渲染层据此走 onerror 兜底) */
  status: number
}

interface Fetched {
  ok: boolean
  status: number
  type: string
  bytes?: Uint8Array
}

/** 取一发的最低层: 测试套子在这里换掉真网络 */
async function fetchImage(url: string): Promise<Fetched> {
  const ses = session.fromPartition(SESSION_PARTITION)
  const sesFetch = (ses as unknown as { fetch?: typeof net.fetch }).fetch
  const res = sesFetch
    ? await sesFetch.call(ses, url, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    : await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!res.ok) {
    // 失败也先把回包读完: 半途不管的那一发会让 session.fetch 的连接留在悬挂态
    await res.arrayBuffer().catch(() => undefined)
    return { ok: false, status: res.status, type }
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  // 只收图: 这一层的消费面是 <img>, 收到别的(反代劫持页/HTML 错误页)就当没这张图
  if (!buf.byteLength || !type.startsWith('image/')) return { ok: false, status: 502, type }
  return { ok: true, status: 200, type, bytes: buf }
}

/** 缓存键: 纯数字的 query(SOOP 打穿自家缓存的版本号)不参与身份, 其余一律整条地址作键。
 * 为什么这一次可以把 query 抹平(真机实测, 推翻早前留下的那条理由):
 *    · 同一条 path 用 5 个 counter 现取(其中两个是我编的、不在真实序列里) ⇒ 全部同一份字节
 *      (a6b4caf5d923f848 / 41,769 B) ⇒ **CDN 根本不读这个 query**, 它不承载内容身份;
 *    · 同一条 path 隔 70 秒取 4 次 ⇒ hash 四次全不同 ⇒ 内容跟着 **时间** 换, 而时间本来就归 TTL 那把尺管;
 *    · 三间在播房背靠背: 3.0 秒处 3/3 字节相同, 6.5 秒处 1/3 才变 ⇒ 冷启动那对相隔 3.3 秒的双绘是**字节重复**。
 *  所以"抹平 query 会替平台吃掉版本号、卡片停在上一帧"那句是错的: 版本号从来不吃, 停帧的上限一直是 TTL=60 秒,
 *  与今天"同一地址被问两遍就命中"的旧行为完全同界。取法一字不变(仍按原地址发), 变的只有这本账的键。
 *  注意边界: 只认 `?<纯数字>` 这一种形状(实测 db 里 28 间在播房的 thumbUrl 共用同一枚 ?29851761 ⇒ 它是全局计数)。
 *  别的 query(?width= / 签名参数等)一律照旧整条作键 —— 那些域里参数可能就是身份。 */
function cacheKey(url: string): string {
  try {
    const u = new URL(url)
    // search 形如 "?29851721" 才算版本号; "?29851721&x=1" 那种不是, 不动它
    if (/^\d+$/.test(u.search.slice(1))) return u.origin + u.pathname
  } catch {
    // 不合形状的地址在 parseImgSrc 那一关就已经 403 了, 这里原样作键即可
  }
  return url
}

class ImgCache {
  /** 公开是为了"读得动": 验证套子与 CDP 取证都要按同一把尺看这本账(与 playCache/gates 同规约), 不是给外面写 */
  readonly store = new Map<string, Entry>()
  /** 同一地址同时被几张卡片问到: 只发一发(合并的是问, 不是等) */
  readonly inflight = new Map<string, Promise<Entry>>()
  private bytes = 0
  /** 读数全留给验证与取证: 命中率、合并了几发、真发了几发 */
  private stat = { hit: 0, miss: 0, send: 0, merged: 0, fail: 0, refused: 0 }

  stats(): { entries: number; bytes: number; hit: number; miss: number; send: number; merged: number; fail: number; refused: number } {
    return { entries: this.store.size, bytes: this.bytes, ...this.stat }
  }

  private async load(url: string): Promise<Entry> {
    const now = Date.now()
    // 账按 key 记、发按 url 发(见 cacheKey): 版本号换了 ≠ 图换了, 而图真的换了时靠 TTL 到点重取
    const key = cacheKey(url)
    const e = this.store.get(key)
    if (e && e.exp > now) {
      this.stat.hit++
      // 命中也要把这一格挪到队尾: 淘汰按插入顺序剪, 而"刚被要过"就是这张图还活着的证据
      this.store.delete(key)
      this.store.set(key, e)
      return e
    }
    const flying = this.inflight.get(key)
    if (flying) {
      this.stat.merged++
      return flying
    }
    this.stat.miss++
    this.stat.send++
    const p = (async (): Promise<Entry> => {
      let r: Fetched
      try {
        r = await fetchImage(url)
      } catch (err) {
        logger.warn('img', `取图失败: ${url.slice(0, 120)}(${String((err as Error).message || err).slice(0, 80)})`)
        r = { ok: false, status: 502, type: '' }
      }
      this.inflight.delete(key)
      if (r.ok && r.bytes) {
        const ent: Entry = { bytes: r.bytes, type: r.type, exp: Date.now() + TTL_MS, status: 200 }
        this.put(key, ent)
        return ent
      }
      this.stat.fail++
      // 到点重取而那一发没成功: 手里那份旧图不许跟着一起没(读不到 ≠ 这张图不存在了),
      // 留着它并把下次重取推到 FAIL_TTL 之后, 于是"取不到"最多让卡片停在上一帧, 不让卡片变破图
      if (e?.bytes) {
        e.exp = Date.now() + FAIL_TTL_MS
        this.put(key, e)
        return e
      }
      const bad: Entry = { type: '', exp: Date.now() + FAIL_TTL_MS, status: r.status || 502 }
      // 只有官方那句「没有」(404)配留一笔短账: 它是答案, 同一面卡片再问一遍就是白问。
      // 超时/5xx/非图是「我方这一发没成」而手里又没有旧图 —— 给它留账就等于把一次网络打嗝画成卡片上 15 秒的空白
      // (2026-10-04 真机第一次取证就是这么坏的: 冷启动 9 秒停顿 ⇒ 18 发全掐 ⇒ 首面卡片整轮空白)
      if (r.status === 404) this.put(key, bad)
      return bad
    })()
    this.inflight.set(key, p)
    return p
  }

  /** 落账一律按 key(版本号抹掉那把): 地址本身只活到 fetch 那一步 */
  private put(key: string, ent: Entry): void {
    const old = this.store.get(key)
    if (old?.bytes) this.bytes -= old.bytes.byteLength
    this.store.set(key, ent)
    this.bytes += ent.bytes?.byteLength || 0
    // 淘汰: 先清过期(过期那一格留着只会占预算), 再按插入顺序剪到上限
    const now = Date.now()
    for (const [k, v] of this.store) {
      if (v.exp <= now && k !== key) {
        this.bytes -= v.bytes?.byteLength || 0
        this.store.delete(k)
      }
    }
    while (this.store.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const first = this.store.keys().next().value as string | undefined
      if (first === undefined) break
      const v = this.store.get(first)
      this.bytes -= v?.bytes?.byteLength || 0
      this.store.delete(first)
    }
  }

  /** plocal://img/… 那一支的终点: 地址不合法 403, 其余一律由 load 说话 */
  async handle(reqUrl: string): Promise<Response> {
    const url = parseImgSrc(reqUrl)
    if (!url || url.length > MAX_URL_LEN) {
      this.stat.refused++
      logger.warn('img', `拒绝取图(白名单外或地址不合形状): ${String(reqUrl).slice(0, 160)}`)
      return new Response('forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    const e = await this.load(url)
    if (!e.bytes) {
      // 404 原样回 404, 别把它翻译成 200: 渲染层那句「没有头像」靠的就是这个错误事件
      return new Response('not found', { status: e.status === 404 ? 404 : 502, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    return new Response(e.bytes, {
      status: 200,
      headers: { 'Content-Type': e.type, 'Access-Control-Allow-Origin': '*' }
    })
  }
}

export const imgCache = new ImgCache()
