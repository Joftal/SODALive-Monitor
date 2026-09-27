import { BrowserWindow } from 'electron'
import { api, RiskError, BjNotFoundError, LiveItem } from './pandalive'
import { store } from './store'
import { EV, WatcherStatus, Anchor, DiscoveryItem } from '../../shared/types'
import { recorder } from './recorder'
import { sendToast } from './notify'
import { sleep } from '../util'
import { logger } from './logger'
import { mt } from '../i18n'

// ============ 轮询引擎 ============
// list 模式: 每轮拉全站直播列表(分页, 每页一个请求), 本地匹配监控主播 —— 防封核心
// per-anchor 模式: 逐个 member/bj (兜底, 限速队列生效)
// 列表外离线关注(pumpIdle): 轮次间隙按 gap 持续轮扫, 开播发现延迟 ≈ N×gap, 与轮询间隔脱钩
// 熔断: 连续失败 N 轮 -> 暂停 + 指数退避, 并通知 UI
// ==================================

const MAX_PAGES = 5
const PAGE_SIZE = 100

/** 平台 startTime("YYYY-MM-DD HH:MM:SS", 韩国时区) -> 已播秒数; 解析失败/未来时间归 0 */
function liveElapsedSec(startTime: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(startTime || '').trim())
  if (!m) return 0
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6]) // KST=UTC+9
  if (Number.isNaN(ts)) return 0
  return Math.max(0, Math.floor((Date.now() - ts) / 1000))
}

class Watcher {
  running = false
  private timer: NodeJS.Timeout | null = null
  private errorStreak = 0
  private cooldownUntil = 0
  private roundInFlight = false
  private discovery: DiscoveryItem[] = []
  status: WatcherStatus = {
    running: false,
    mode: 'list',
    lastRoundAt: null,
    roundMs: 0,
    liveCount: 0,
    monitored: 0,
    liveFound: 0,
    circuitOpen: false,
    message: ''
  }

  getDiscovery(): DiscoveryItem[] {
    return this.discovery
  }

  private push(): void {
    const win = BrowserWindow.getAllWindows()[0]
    this.status.running = this.running
    win?.webContents.send(EV.watcher, { ...this.status })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.errorStreak = 0
    this.cooldownUntil = 0
    this.schedule(300)
    this.push()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.push()
  }

  /** 立即触发一轮(不等待定时器); 一轮进行中则跳过; schedule() 会覆盖未触发的旧定时器, 连续 tick 自然合并为一轮 */
  tick(): void {
    if (this.running && !this.roundInFlight) this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.round(), delay)
  }

  private async round(): Promise<void> {
    if (!this.running || this.roundInFlight) return
    this.roundInFlight = true
    const begin = Date.now()
    const cfg = store.getSettings()
    this.status.mode = cfg.watchMode
    api.setGap(cfg.requestGapMs)

    try {
      if (Date.now() < this.cooldownUntil) {
        const remain = Math.ceil((this.cooldownUntil - Date.now()) / 1000)
        this.status.message = mt('watcher.cooling', { remain })
        // 注意: 此分支的 schedule/push 由 finally 统一兜底, 不写重复调用
        return
      }

      const anchors = store.listAnchors()
      this.status.monitored = anchors.length

      if (cfg.watchMode === 'list') {
        await this.roundByList(anchors)
      } else {
        // 逐个模式下大厅无数据源: 清空并广播, 让大厅显示"模式不可用"空态
        this.idleQueue = [] // per-anchor 每轮全量复查: list 残留的 rest 快照作废, 间隙泵在此模式无职责
        if (this.discovery.length) {
          this.discovery = []
          this.pushDiscovery()
        }
        await this.roundByBj(anchors)
      }

      this.errorStreak = 0
      this.status.circuitOpen = false
      this.status.message = ''
      // 轮次心跳: 每 10 轮落一行摘要 —— 事后可证"轮询在这些小时里活着且看得见全站"
      // (每轮都写会刷屏: 30s 间隔下一天 2880 行; 抽稀到 ~5 分钟一行, 14 天约 100KB)
      if (++this.roundCnt % 10 === 0) {
        logger.info(
          'watcher',
          this.status.mode === 'list'
            ? `第 ${this.roundCnt} 轮 list 全站=${this.status.liveCount} 关注=${this.status.monitored} 在播=${this.status.liveFound} 本轮=${Date.now() - begin}ms`
            : `第 ${this.roundCnt} 轮 per-anchor 关注=${this.status.monitored} 在播=${this.status.liveFound} 本轮=${Date.now() - begin}ms`
        )
      }
    } catch (e) {
      this.noteFailure(e)
    } finally {
      this.roundInFlight = false
      this.status.lastRoundAt = Date.now()
      this.status.roundMs = Date.now() - begin
      this.push()
      if (this.running) {
        store.flush()
        const interval = this.status.circuitOpen ? 30_000 : store.getSettings().pollIntervalSec * 1000
        this.schedule(interval)
        void this.pumpIdle() // 轮次间隙: 启动离线关注兜底泵(幂等, 在跑则 no-op)
      }
    }
  }

  // ---- 查无此人(改名/注销/错 id)单点处置: 标离线 + 一次性提醒 + 后续不再发请求 ----
  // 绝不计入 errorStreak/熔断: 单主播数据错误无权拖垮全局轮询
  private bjGone = new Set<string>()
  private onBjNotFound(a: Anchor): void {
    this.bjGone.add(a.userId)
    if (a.isLive) {
      store.updateAnchor(a.userId, { isLive: false, title: '', tags: null, startTime: '', viewerCount: 0, thumbUrl: '' })
      this.pushAnchors()
    }
    logger.warn('watcher', `关注的主播查无此人(改名/注销/错 id): @${a.userId}`)
    sendToast({ type: 'info', title: mt('watcher.bjGone', { id: a.userId }), body: mt('watcher.bjGoneHint') }, { ev: 'generic', ctx: { anchor: a, detail: mt('watcher.bjGoneHint') } })
  }
  /** 该锚点是否已确认不存在: true 则所有 bj 复查路径直接跳过(不再发请求) */
  private isGone(userId: string): boolean {
    return this.bjGone.has(userId)
  }

  /** 关注增删时清除"查无此人"标记: 移除可重加, 改名/错 id 修正(或平台恢复)后重新探活 */
  unmarkGone(userId: string): void {
    this.bjGone.delete(userId)
  }

  /** 轮询/间隙泵统一失败处置: 连续失败熔断 + 指数退避 + UI 通知(原 round catch 原语义) */
  private noteFailure(e: unknown): void {
    this.errorStreak++
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof RiskError || this.errorStreak >= 3) {
      // 指数退避: 1min -> 2 -> 4 -> ... 上限 15min
      const minutes = Math.min(15, 2 ** Math.min(4, this.errorStreak - 1))
      this.cooldownUntil = Date.now() + minutes * 60_000
      this.status.circuitOpen = true
      this.status.message = mt('watcher.circuit', { msg, minutes })
      logger.warn('watcher', this.status.message)
      sendToast({ type: 'error', title: mt('watcher.circuitTitle'), body: this.status.message }, { ev: 'circuit', ctx: { detail: this.status.message } })
    } else {
      this.status.message = mt('watcher.roundFail', { msg })
      logger.warn('watcher', `本轮失败(#${this.errorStreak}): ${msg}`)
    }
  }

  /** list 模式: 拉全站列表, 本地匹配; 全量列表同时作为大厅数据源 */
  private async roundByList(anchors: Anchor[]): Promise<void> {
    const liveMap = new Map<string, LiveItem>()
    let page = 0
    let loginInfo: unknown = undefined
    while (page < MAX_PAGES) {
      const { list, loginInfo: li } = await api.fetchLivePage(page * PAGE_SIZE, PAGE_SIZE)
      loginInfo = li
      for (const item of list) liveMap.set(item.userId, item)
      // 没到满页即已到列表底部
      if (list.length < PAGE_SIZE) break
      page++
    }
    this.status.liveCount = liveMap.size

    // 全量在播列表 -> 大厅(按观众数降序)
    this.discovery = [...liveMap.values()]
      .sort((a, b) => (b.user || 0) - (a.user || 0))
      .map((x) => ({
        userId: x.userId,
        userIdx: x.userIdx ?? null,
        nick: x.userNick || x.userId,
        title: x.title || '',
        isAdult: !!x.isAdult,
        isPw: !!x.isPw,
        type: x.type || '',
        liveType: x.liveType || '',
        viewers: x.user || 0,
        likes: x.likeCnt || 0,
        fans: x.fanCnt || 0,
        bookmarks: x.bookmarkCnt || 0,
        plays: x.playCnt || 0,
        startTime: x.startTime || '',
        thumbUrl: x.thumbUrl || '',
        userImg: x.userImg || ''
      }))
    this.pushDiscovery()

    const now = Date.now()
    let liveFound = 0
    const missing: Anchor[] = []
    for (const a of anchors) {
      const item = liveMap.get(a.userId)
      if (!item) {
        missing.push(a)
        continue
      }
      const wasLive = a.isLive
      const prevTags = a.tags // updateAnchor 原地改 a, 变更判定必须先拍旧标签快照
      liveFound++
      const patch: Partial<Anchor> = {
        isLive: true,
        nick: item.userNick || a.nick,
        userIdx: item.userIdx ?? a.userIdx,
        userImg: item.userImg || a.userImg,
        title: item.title || '',
        tags: { isAdult: !!item.isAdult, isPw: !!item.isPw, type: item.type || '', liveType: item.liveType || '' },
        startTime: item.startTime || '',
        viewerCount: item.user || 0,
        likes: item.likeCnt || 0,
        fans: item.fanCnt || 0,
        thumbUrl: item.thumbUrl || '',
        lastSeenAt: now
      }
      store.updateAnchor(a.userId, patch)
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      else this.onRoomShift(a, prevTags, patch.tags as NonNullable<Anchor['tags']>)
    }

    // 兜底: 列表不可见的关注主播(19+/隐藏房/500名外) member/bj 节流复查
    // - urgent: 上轮还在播的, 全部立即复查(防止误判下播) —— 轮内完成
    // - rest: 离线关注交间隙泵(pumpIdle)在轮询空档持续轮扫 —— 发现延迟 ≈ N×gap, 与轮询间隔脱钩
    const urgent = missing.filter((a) => a.isLive && !this.isGone(a.userId))
    for (const a of urgent) {
      try {
        const info = await api.fetchBj(a.userId)
        liveFound += await this.applyBj(a, info)
      } catch (e) {
        if (e instanceof BjNotFoundError) {
          this.onBjNotFound(a)
          continue // 单点数据错误: 不污染本轮(不升级熔断/连败)
        }
        throw e // 其余错误维持轮次失败语义
      }
    }
    this.idleQueue = missing.filter((a) => !a.isLive) // 新快照整批替换(上轮未扫完的按最新状态重排)

    this.status.liveFound = liveFound
    // 登录态检测: loginInfo 非空即视为 cookie 有效(结构宽容)
    if (api.hasSession()) api.cookieValid = Boolean(loginInfo)
    if (!api.hasSession()) api.cookieValid = false
    this.pushAnchors()
  }

  /** 用 member/bj 的响应更新主播状态, 返回 1=在播 0=离线 */
  private async applyBj(
    a: Anchor,
    info: { nick: string; userIdx: number | null; userImg: string; media: LiveItem | null }
  ): Promise<number> {
    const now = Date.now()
    const { nick, userIdx, userImg, media } = info
    // 先拍翻转快照: updateAnchor 是原地 Object.assign(listAnchors 返回原数组, 改的就是 a 本体),
    // 改后再读 a.isLive 恒为新值 → 开播翻转判定会被吞(通知/预取/自录/源作废全丢);
    // 与主循环 wasLive 同规约
    const wasLive = a.isLive
    const prevTags = a.tags // 同主循环: updateAnchor 原地改 a, 变更判定先拍旧标签
    if (media && media.isLive) {
      const patch: Partial<Anchor> = {
        isLive: true,
        nick: media.userNick || nick,
        userIdx,
        userImg: (media as unknown as { userImg?: string }).userImg || userImg,
        title: media.title || '',
        tags: { isAdult: !!media.isAdult, isPw: !!media.isPw, type: media.type || '', liveType: media.liveType || '' },
        startTime: media.startTime || '',
        viewerCount: media.user || 0,
        likes: media.likeCnt || 0,
        fans: media.fanCnt || 0,
        thumbUrl: (media as unknown as { thumbUrl?: string }).thumbUrl || '',
        lastSeenAt: now
      }
      store.updateAnchor(a.userId, patch)
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      else this.onRoomShift(a, prevTags, patch.tags as NonNullable<Anchor['tags']>)
      return 1
    }
    if (wasLive) {
      store.updateAnchor(a.userId, { isLive: false, title: '', tags: null, startTime: '', viewerCount: 0, thumbUrl: '' })
      this.onLiveEnd(a)
    }
    if (nick && nick !== a.nick) store.updateAnchor(a.userId, { nick })
    return 0
  }

  /** per-anchor 模式: 逐个 member/bj */
  private async roundByBj(anchors: Anchor[]): Promise<void> {
    let liveFound = 0
    for (const a of anchors) {
      if (this.isGone(a.userId)) continue
      try {
        liveFound += await this.applyBj(a, await api.fetchBj(a.userId))
      } catch (e) {
        if (e instanceof BjNotFoundError) {
          this.onBjNotFound(a)
          continue
        }
        throw e
      }
    }
    this.status.liveFound = liveFound
    this.pushAnchors()
  }

  // ---- 轮次间隙兜底泵: rest(离线且列表不可见的关注)在轮询空档持续轮扫 ----
  // 与主轮询共用同一限速队列(gap+抖动), 单请求速率与轮内完全一致, 但节奏摊平到整条
  // 时间轴: 发现延迟 ≈ N×gap(50 离线 ≈ 60s), 与 pollIntervalSec 无关 —— 不论 30s 还是
  // 300s 一档, 空闲时间轴全部利用起来。让路规则: round 进行中不跑; 熔断期清空停扫;
  // 每人每轮至多扫一次(快照消费制, 新 round 发新快照)。
  private idleQueue: Anchor[] = []
  private idlePumping = false

  private async pumpIdle(): Promise<void> {
    if (this.idlePumping) return
    this.idlePumping = true
    try {
      while (this.idleQueue.length) {
        // 让路: 下一轮开始即停(下轮会发新快照); 停轮(stop)同样中止
        if (!this.running || this.roundInFlight) break
        if (this.status.circuitOpen) {
          // 熔断高压期避开(与 prewarm 泵同语义)
          this.idleQueue.length = 0
          break
        }
        const a = this.idleQueue.shift()!
        // 快照生成后被取关: 跳过(不再为其发请求; 事件层另有 onLiveStart/onLiveEnd 守卫双保险)
        if (!this.stillMonitored(a.userId)) continue
        if (this.isGone(a.userId)) continue // 查无此人: 不发请求(每轮都会被快照带回, 必须在消费前挡)
        api.setGap(store.getSettings().requestGapMs) // 与轮内同节奏(设置页改动即时生效)
        try {
          const info = await api.fetchBj(a.userId)
          if (!this.running) break // 请求在飞期间已停轮: 事件不落, 剩余快照直接作废
          const found = await this.applyBj(a, info)
          if (found) this.pushAnchors() // rest 上"在播"恒为开播翻转: 即时点亮 UI(不等下一轮)
        } catch (e) {
          if (e instanceof BjNotFoundError) {
            this.onBjNotFound(a)
            continue // 查无此人: 不熔断不停泵, 继续消磨剩余快照
          }
          this.noteFailure(e)
          this.push()
          break // 出错即停, 剩余待下轮新快照(保守: 不在风控/坏网下硬闯)
        }
      }
    } finally {
      this.idlePumping = false
    }
  }

  // ---- 开播预取源泵: 逐个节流拉源写缓存, 点进房间即命中 ----
  private prewarmQueue: string[] = []
  private prewarmPumping = false

  private enqueuePrewarm(userId: string): void {
    if (this.prewarmQueue.includes(userId)) return
    this.prewarmQueue.push(userId)
    void this.pumpPrewarm()
  }

  /** 对外入口: 关注"已在播"主播时补一发预取(列表模式下该类主播永不再触发 onLiveStart, 预取泵对其缺席) */
  prewarmNow(userId: string): void {
    this.enqueuePrewarm(userId)
  }

  private async pumpPrewarm(): Promise<void> {
    if (this.prewarmPumping) return
    this.prewarmPumping = true
    try {
      while (this.prewarmQueue.length) {
        // 熔断期间不预取(避免高压撞墙)
        if (this.status.circuitOpen) {
          this.prewarmQueue.length = 0
          break
        }
        const uid = this.prewarmQueue.shift()!
        // 入队后被取关: 不再为其拉源(与 pumpIdle/事件守卫同规约; 开播入口(onLiveStart)已挡)
        if (!this.stillMonitored(uid)) continue
        const cfg = store.getSettings()
        api.setGap(cfg.requestGapMs)
        await api.getPlayCached(uid).catch(() => undefined) // 失败静默(不打扰用户流)
        await sleep(Math.max(1200, cfg.requestGapMs) * (0.8 + Math.random() * 0.4))
      }
    } finally {
      this.prewarmPumping = false
    }
  }

  /** 翻转事件统一守卫: 拉列表/拉 bj 飞行窗口内主播可能已被取关; 事件不得落(防幽灵 toast/自录) */
  private stillMonitored(userId: string): boolean {
    return store.listAnchors().some((x) => x.userId === userId)
  }

  private roundCnt = 0

  private onLiveStart(a: Anchor): void {
    if (!this.stillMonitored(a.userId)) return
    api.invalidatePlay(a.userId) // 主播(重)开播: 旧源作废
    logger.info('watcher', `开播: ${a.nick}(@${a.userId}) title"${a.title}" 自录=${a.autoRecord ? '开' : '关'}`)
    const cfg = store.getSettings()
    if (cfg.prefetchStream) this.enqueuePrewarm(a.userId) // 后台预取新源写缓存
    if (a.tags?.type === 'fan') {
      // 粉丝房开播: 专用通知(与普通开播区分, 仍进系统通知与应用内气泡)
      sendToast({ type: 'fanLive', title: mt('watcher.fanLiveStart', { nick: a.nick }), body: a.title || mt('watcher.clickWatch') }, { ev: 'fanLive', ctx: { anchor: a } })
    } else {
      sendToast({ type: 'live', title: mt('watcher.liveStart', { nick: a.nick }), body: a.title || mt('watcher.clickWatch') }, { ev: 'live', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime) } })
    }
    if (a.autoRecord) {
      // getSettings 恒返回对象(恒真判定已移除)
      void recorder.start({ userId: a.userId, nick: a.nick, title: a.title, password: '', auto: true }).catch(() => undefined)
    }
  }

  /** 持续在播中的房态翻转: 由不敏感变为 19+ 房 或 粉丝房时补发一次通知(新开播走 onLiveStart, 不在此列) */
  private onRoomShift(a: Anchor, oldTags: Anchor['tags'], newTags: NonNullable<Anchor['tags']>): void {
    if (!oldTags) return // 上轮无标签(理论不达: wasLive 分支上轮已在播): 不臆断为变更
    const toAdult = !oldTags.isAdult && newTags.isAdult
    const toFan = oldTags.type !== 'fan' && newTags.type === 'fan'
    if (!toAdult && !toFan) return
    if (!this.stillMonitored(a.userId)) return
    const kind = toAdult && toFan ? mt('watcher.roomBoth') : toAdult ? mt('watcher.roomAdult') : mt('watcher.roomFan')
    logger.info('watcher', `房态变更: ${a.nick}(@${a.userId}) ${kind}`)
    sendToast(
      { type: 'roomChange', title: `${a.nick} ${kind}`, body: a.title || mt('watcher.clickWatch') },
      { ev: 'roomChange', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime), detail: kind } }
    )
  }

  private onLiveEnd(a: Anchor): void {
    if (!this.stillMonitored(a.userId)) return // 同 onLiveStart 守卫: 已取关不弹下播
    logger.info('watcher', `下播: ${a.nick}(@${a.userId})`)
    // 下播即频道死(实测: 之后 play 宽限期还会假发旧频道源, master 必 404) ——
    // 缓存源必须当场作废: 保活泵对已知下播不再心跳, 不清就会留死源骗"秒开"徽标, 点播放/录制必暴毙
    api.invalidatePlay(a.userId)
    sendToast({ type: 'offline', title: mt('watcher.liveEnd', { nick: a.nick }), body: '' }, { ev: 'offline', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime) } })
  }

  private pushAnchors(): void {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.anchors, store.listAnchors())
  }

  private pushDiscovery(): void {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.discovery, this.discovery)
  }
}

export const watcher = new Watcher()
