import { Anchor, AnchorTag, Platform } from '../../shared/types'
import { api, PlayResult } from './pandalive'
import { soopApi } from './soop'
import { store } from './store'

// ============ 跨平台取流入口 ============
// 录制/播放不认平台, 只认这套同语义契约:
//   getPlayCached = 命中有效缓存零请求, 未命中才拉源(在途去重)
//   getPlayFast   = 同上, 但"只解了最高档"的那一份也照给(播放器不等清晰度菜单)
//   fetchPlay     = 强制现拉(直播探针)
//   invalidatePlay= 显式作废该房间源包
//   dropCachedPlay= 只摘掉缓存里那一份源包(播放器亲证它死了), 不动任何防重复的账
//   seedPlay      = 把刚现拉到的有效源种进缓存(探针结果复用, 省一条链)
//   cachedSourceIds = 手上已有有效源的房间主键(卡片「已缓存」徽标的事实源)
// 新增平台只需再实现一个同契约客户端并在此登记。
// =======================================

export interface RoomSource {
  /** fullVariants: 是否要解析全部清晰度档。只有 SOOP 有意义 —— 它每档要发 2 个请求,
   *  所以后台预取只要最高档(返回的源包带 partial:true), 真进房才补齐全档;
   *  Panda 的全档是从 master 一次解析白送的, 该客户端收下这个参数但无需理会。 */
  getPlayCached(id: string, password?: string, forceFresh?: boolean, fullVariants?: boolean): Promise<PlayResult>
  /** 秒开快道(播放器专用入口): 手里那份能播就先给, 哪怕清晰度菜单只解了最高档 ——
   *  进房那一发不再为"补齐没人点的档"等着。缺档由这一发顺手起的后台整链补, 而补齐那一发
   *  (getPlayCached(fullVariants=true) / liveMenu) 命中的正是同一条在途链 ⇒ 请求数与旧写法一字不差。
   *  返回包上带 partial 的调用方要知道去补菜单(见 ipc 的 liveMenu)。 */
  getPlayFast(id: string, password?: string, forceFresh?: boolean): Promise<PlayResult>
  fetchPlay(id: string, password?: string): Promise<PlayResult>
  invalidatePlay(id: string): void
  /** 只把缓存里那一份源包摘掉, 与 invalidatePlay 的区别就是这一笔的全部取舍:
   *  门槛账/本场已买档/保活读数记的是"平台那句话"和"这一场次", 源包死了不等于它们也失效 ——
   *  跟着一起撤等于让下一次问价重买整链(加请求)。纪元同样不 bump: 在飞的链是此刻向平台问的新价,
   *  它带回来的正是我们要的那一份。
   *  provenDeadUrl = 播放器亲证 404/403 的那条地址: 给了就只在"手里这份确实包含它"时摘(已经不是那份就说明源早被换掉),
   *  返回是否真摘掉了一份。 */
  dropCachedPlay(id: string, provenDeadUrl?: string): boolean
  seedPlay(id: string, pack: PlayResult): void
  cachedSourceIds(): string[]
}

export function sourceFor(platform: Platform): RoomSource {
  return platform === 'soop' ? soopApi : api
}

/** 取流结果里的主播元数据回写关注记录 —— 只对 SOOP 生效:
 *  SOOP 的开播时刻(BTIME 反推)和密码房标记只有 CHANNEL 接口给, 轮询侧只读播放页, 拿不到;
 *  Panda 这两个值每轮都由列表/bj 的平台原值维护, 再回写一份等于两套真值打架, 故不碰。
 *  仅在值确有变化时写(每次写都会触发落盘)。
 *  按字段合并而不是整包覆写: 这一路只观察得到 isPw/liveType —— 看不到的字段写 false 等于替它下结论,
 * 每次开播都擦一次真值(实机抓到过)。SOOP 侧的 19+ 整条不取, 这里保住的 prev.isAdult 恒为 false。
 *  返回合并后的房态, 让渲染层拿到与库里同一份。 */
export function applyPlayMeta(platform: Platform, userId: string, r: PlayResult): AnchorTag | null {
  if (platform !== 'soop' || !r.ok) return null
  const a = store.listAnchors().find((x) => x.platform === platform && x.userId === userId)
  if (!a) return null
  const patch: Partial<Anchor> = {}
  if (r.startTime && r.startTime !== a.startTime) patch.startTime = r.startTime
  const m = (r.media || {}) as { isPw?: boolean; isAdult?: boolean; type?: string; liveType?: string }
  const prev = a.tags
  const tags: AnchorTag = {
    isAdult: typeof m.isAdult === 'boolean' ? m.isAdult : !!prev?.isAdult,
    isPw: typeof m.isPw === 'boolean' ? m.isPw : !!prev?.isPw,
    type: m.type ?? String(prev?.type || ''),
    liveType: m.liveType ?? String(prev?.liveType || 'live')
  }
  if (JSON.stringify(tags) !== JSON.stringify(prev)) patch.tags = tags
  if (Object.keys(patch).length) store.updateAnchor(platform, userId, patch)
  return tags
}
