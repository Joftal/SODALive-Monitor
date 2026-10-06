import { BrowserWindow } from 'electron'
import { api, RiskError, BjNotFoundError, LiveItem, PlayResult } from './pandalive'
import { soopApi, SoopFavoriteRow } from './soop'
import { sourceFor, applyPlayMeta } from './source'
import { store } from './store'
import { EV, Platform, platformName, roomKey, soopAvatarUrl, WatcherStatus, Settings, Anchor, DiscoveryItem } from '../../shared/types'
import type { DiagRound } from '../../shared/types'
import { recorder } from './recorder'
import { sendToast } from './notify'
import { sleep } from '../util'
import { logger } from './logger'
import { mt } from '../i18n'

// ============ 轮询引擎 ============
// list 模式: 每轮一发站内关注列表(/v1/live/bookmark, 实测 158 关注/90KB/1 发)判全部关注的在播与下播
//            —— 它只覆盖"我自己关注的人", 请求面与关注数无关, 是防封主力; 列表不可用(未登录/风控/改版)
//            才回落全站榜分页匹配(旧链路)。全站榜自此不再搭轮询的车, 大厅按需拉。
// per-anchor 模式: 逐个 member/bj (兜底, 限速队列生效)
// SOOP: 每轮一发站内关注列表(myapi/favorite)本地匹配, 列表覆盖不到的房才回落播放页探针
// 站内关注表里没有的离线关注(应用内自增/官网侧取关, pumpIdle): 轮次间隙按 gap 持续轮扫,
//            开播发现延迟 ≈ N×gap, 与轮询间隔脱钩
// 熔断: 连续失败 N 轮 -> 暂停 + 指数退避, 并通知 UI
// ==================================

const MAX_PAGES = 5
const PAGE_SIZE = 100

/** 「待第二轮确认」那一格在本机还作数的时长(下播防抖落库后的新鲜度上限)。
 *  它要同时吃掉两头: 太短就等于没修(实测那一段停摆是 6 分钟 —— 06:58 报下播、07:04 重启),
 * 太长就会把隔夜的旧账当"刚刚下播"再报一次通知, 而这一格立的就是"停摆期间的散场不许冒充现值"。
 *  10 分钟 = 常态轮距(Panda 120s / SOOP 60s)的 5~10 个轮距, 够覆盖"关掉再打开"这一类, 又一定短于一夜。
 * 超过它的旧账不当 pending 使: 那一格的 lastSeenAt 至少也老了 10 分钟 > 2×轮距, 于是照冷启动豁免走 */
const OFFLINE_PENDING_FRESH_MS = 10 * 60_000

/** 全站榜一轮分页的产物: 已翻到的部分 + 列表响应自带的 loginInfo + 中途的错(没有则 null) */
type PageHarvest = { liveMap: Map<string, LiveItem>; loginInfo: unknown; err: unknown | null }

/** 平台 startTime("YYYY-MM-DD HH:MM:SS", 韩国时区) -> 已播秒数; 解析失败/未来时间归 0 */
function liveElapsedSec(startTime: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(startTime || '').trim())
  if (!m) return 0
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6]) // KST=UTC+9
  if (Number.isNaN(ts)) return 0
  return Math.max(0, Math.floor((Date.now() - ts) / 1000))
}

/** 一个平台的调度态: 自己的定时器 / 在飞标志 / 上次发车时刻 / 轮次计数。
 *  旧实现只有一条 timer 跑完两平台, 所以 Panda 熔断把间隔压到 30s 时 SOOP 被同一条时间轴带着,
 * 只能靠 lastSoopRoundAt 单独设一道闸门 —— 那个字段随分家一起作废( C1 之后连这一压也撤了,
 *  熔断期不再改轮距, 分家后每一站只剩"按自己那一格走"这一条规则)。 */
interface Loop {
  timer: NodeJS.Timeout | null
  inFlight: boolean
  lastAt: number
  roundCnt: number
  /** 轮次卡死的看门狗(P0-4): 只负责出声, 详见 runRound 那一句 */
  watchdog: NodeJS.Timeout | null
  /** 诊断台: 排定的下一轮到期时刻(0=没排)与本轮/上一轮起点 —— 实测轮距只有起点减起点这一种算法 */
  nextAt: number
  prevBegin: number
  measuredRoundMs: number
}

const newLoop = (): Loop => ({ timer: null, inFlight: false, lastAt: 0, roundCnt: 0, watchdog: null, nextAt: 0, prevBegin: 0, measuredRoundMs: 0 })
const PLATS: Platform[] = ['pandalive', 'soop']

/** watcher.diag() 的形状: 诊断台①⑤的料(排队里的缩略图作业与推送计数由 diag.ts 从各自服务合并) */
export interface WatcherDiag {
  startedAt: number
  running: boolean
  rounds: Record<Platform, DiagRound>
  queues: {
    prewarm: { len: number; head: string[]; retry: { room: string; attempt: number; inMs: number }[] }
    offlinePending: { len: number; cursor: number }
  }
  /** 三笔"降级/失明"连败留痕: 它们决定的是"数还在不在读", 不是"站有没有挂" */
  blindStreaks: { panda: number; soop: number; soopFail: number }
}

class Watcher {
  running = false
  /** 本次监控从什么时候开始(①「这次监控从 18:07 开始」), 0=没在监控。随 start/stop 起落 */
  watchStartedAt = 0
  private loop: Record<Platform, Loop> = { pandalive: newLoop(), soop: newLoop() }
  /** 连败 / 退避 / 会话作废三枚是 Panda 独有的账本(它才发得出 RiskError, 也只有它有登录态可失效) */
  private errorStreak = 0
  private cooldownUntil = 0
  /** (C1) 冷却期那一发预言机的再问时刻。旧写法冷却整轮 return, 于是 1~15 分钟里 Panda 的 158 个关注
   *  一个都看不见 —— 而这一站最便宜的一发(1 发覆盖全关注)恰恰是唯一能判断"它自己好了没有"的读数。
   *  熔断的成因正是同一发, 所以这里是抬节奏(5 分钟一发)而不是取消冷却; 读通即当场解除退避。 */
  private cooldownOracleAt = 0
  private static COOLDOWN_ORACLE_MS = 5 * 60_000
  private sessionDeadStreak = 0
  private discovery: DiscoveryItem[] = []
  /** 大厅快照的在飞请求: 全站榜不再搭轮询的车, 谁打开谁触发, 60 秒内复用(时刻记在 status.discoveryAt) */
  private discoveryInFlight: Promise<DiscoveryItem[]> | null = null
  /** 会话判死态下 login_info 探针的再问时刻: 30s 结果缓存短于轮询间隔, 判死期等于每轮白付一发 */
  private pandaProbeUntil = 0
  private static LOGIN_PROBE_COOL_MS = 5 * 60_000
  /** 本轮 Panda 用的是哪条真值链 + 预言机覆盖到的关注数(只服务轮次摘要日志, 让"1 发覆盖 158"可被事后核对) */
  private pandaOracle: 'bookmark' | 'list' = 'bookmark'
  private pandaCovered = 0
  /** Panda 侧的"降级轮"账本与留痕口径: 与 soopBlindStreak同一件事的两面 ——
   *  预言机不可用而兜底链读得动的那些轮次, 逐房扇出面(全站榜 5 页 + member/bj)会吃满 api 站的车道,
   *  而这一面过去在日志里完全隐形(fetchBj 成功路径零日志)。只留痕 + 风控期收手, 不给自己加预算:
   *  全站榜不含离线关注(它只有 500 个在播房间), 那些房在降级轮【只有】逐房这一条路能读到 */
  private pandaBlindStreak = 0
  private pandaUrgentCnt = 0
  /** 在播数分平台记: Panda 冷却/熔断的那几轮不复查 Panda, 只能沿用上次已知值, 不能被 SOOP 覆盖成 0 */
  private pandaLiveFound = 0
  private soopLiveFound = 0
  /** SOOP 连续"整轮全灭"轮数: 单轮失败可能是抖动, 连续两轮说明改版/风控/断网, 必须让用户看见 */
  private soopFailStreak = 0
  /** 降级探针的每轮预算: 列表整表不可用时"每房一发"会放大成 718 发/轮, 网络越坏越打越凶。
   *  40 发/轮在默认 1200ms 节流下 ≈58s, 正好贴着最短一档轮询; 718 个关注约 18 轮盖完一遍 */
  private static SOOP_PROBE_BUDGET = 40
  /** 上一轮发到哪: 预算切出来的那一刀必须轮换, 不能让排在后面的房永远不被读 */
  private soopProbeCursor = 0
  /** SOOP 自己的退避终点: 连续两轮读不到就静默 5 分钟 —— 与 Panda 的熔断同语义但各记各的,
   *  合并 status.circuitOpen 仍只跟 Panda(引擎只有一条链瞎了不该遮掉另一条的读数面) */
  private soopCooldownUntil = 0
  private static SOOP_COOLDOWN_MS = 5 * 60_000
  /** 关注列表连续"整表不可用"的轮数(留痕): 列表拿不到(未登录/改版/整表解析失败)而整页探针读得动时,
   *  失明判据 allFail 永远不成立 —— 冷却、连败、提醒一条都不触发, 日志里也只剩"这一轮读成功了 N 发"。
   *  这个计数只负责把那一种降级形状写进留痕(见 roundSoop 的降级探针回执), 不参与任何收手判断:
   *  rows===null 时这条逐房整页就是检测路径, 压它的节奏等于压开播发现延迟, 要减得先由用户认下时效那笔账。 */
  private soopBlindStreak = 0
  /** 留痕: 「整表读通了、而我这一间不在表里」那一支的房名账。这一支从前一个字都不出 ——
   *  `row === undefined` 既不走上面那句 logger(`if (row)` 把它挡在外面)，又被 `covered = anchors.length - probe.length`
   *  从失明判据里扣掉，于是某间关注每天 ≈1,358 发整页在日志里是隐形的。
   * 只记名不出声是不行的，逐轮报名也不行(那条老纪律: 常态是个位数、每轮同几个人，会把日志刷成计数器)
   *  ⇒ 只在**变化**那一点出声: 新掉出站内表报一次，回到表里报一次。 */
  private soopUnlisted = new Set<string>()
  status: WatcherStatus = {
    running: false,
    mode: 'list',
    lastRoundAt: null,
    roundMs: 0,
    liveCount: 0,
    discoveryAt: 0,
    monitored: 0,
    liveFound: 0,
    circuitOpen: false,
    message: '',
    byPlatform: {
      pandalive: { running: false, lastRoundAt: null, roundMs: 0, monitored: 0, liveFound: 0, circuitOpen: false, roundFailed: 0, message: '', degraded: false },
      soop: { running: false, lastRoundAt: null, roundMs: 0, monitored: 0, liveFound: 0, circuitOpen: false, roundFailed: 0, message: '', degraded: false }
    }
  }

  getDiscovery(): DiscoveryItem[] {
    return this.discovery
  }

  /** 诊断台(①⑤): 调度态与排队链的只读投影。riskLeftMs 由调用方从两个客户端的账里带来 ——
   *  这一格在这里再算一遍就是让诊断页替全站多跑一趟投影, 而这一页的规矩是一个数都不许换。 */
  diag(riskLeftMs: Record<Platform, number>): WatcherDiag {
    const now = Date.now()
    const rounds = {} as Record<Platform, DiagRound>
    for (const p of PLATS) {
      const L = this.loop[p]
      const st = this.status.byPlatform[p]
      rounds[p] = {
        roundCnt: L.roundCnt,
        measuredRoundMs: L.measuredRoundMs,
        lastRoundMs: st.roundMs,
        nextInMs: L.nextAt ? Math.max(0, L.nextAt - now) : -1,
        inFlight: L.inFlight,
        cooldowns: {
          pollBackoff: Math.max(0, (p === 'pandalive' ? this.cooldownUntil : this.soopCooldownUntil) - now),
          risk: riskLeftMs[p],
          probe: p === 'pandalive' ? Math.max(0, this.pandaProbeUntil - now) : 0
        },
        oracle: p === 'pandalive' ? this.pandaOracle : 'list',
        covered: p === 'pandalive' ? this.pandaCovered : 0,
        monitored: st.monitored,
        liveFound: st.liveFound,
        degraded: st.degraded,
        unlisted: p === 'soop' ? [...this.soopUnlisted] : [],
        gone: [...this.bjGone].filter((k) => k.startsWith(`${p}:`)).map((k) => k.slice(p.length + 1)),
        probe: p === 'soop' ? { budget: Watcher.SOOP_PROBE_BUDGET, cursor: this.soopProbeCursor } : { budget: 0, cursor: this.idleCursor }
      }
    }
    const retry: { room: string; attempt: number; inMs: number }[] = []
    for (const [key, at] of this.prewarmRetryAt) {
      retry.push({ room: key, attempt: this.prewarmRetryCnt.get(key) || 0, inMs: Math.max(0, at - now) })
    }
    return {
      startedAt: this.watchStartedAt,
      running: this.running,
      rounds,
      queues: {
        prewarm: {
          len: this.prewarmQueue.pandalive.length + this.prewarmQueue.soop.length,
          head: [...this.prewarmQueue.pandalive.map((u) => roomKey('pandalive', u)), ...this.prewarmQueue.soop.map((u) => roomKey('soop', u))].slice(0, 6),
          retry
        },
        offlinePending: { len: this.idleQueue.length, cursor: this.idleCursor }
      },
      blindStreaks: { panda: this.pandaBlindStreak, soop: this.soopBlindStreak, soopFail: this.soopFailStreak }
    }
  }

  private push(): void {
    const win = BrowserWindow.getAllWindows()[0]
    this.status.running = this.running
    // 合并视图 = 两平台之和/或: 供日志与 TG 侧用; 渲染层一律读 byPlatform[当前平台]
    const b = this.status.byPlatform
    b.pandalive.running = this.running
    b.soop.running = this.running
    this.status.monitored = b.pandalive.monitored + b.soop.monitored
    this.status.liveFound = b.pandalive.liveFound + b.soop.liveFound
    this.status.circuitOpen = b.pandalive.circuitOpen
    this.status.message = [b.pandalive.message, b.soop.message].filter(Boolean).join(' · ')
    win?.webContents.send(EV.watcher, JSON.parse(JSON.stringify(this.status)) as WatcherStatus)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.watchStartedAt = Date.now()
    this.errorStreak = 0
    this.cooldownUntil = 0
    this.cooldownOracleAt = 0 // 新会话第一次撞冷却就该立刻问那一发, 不许继承上一场的那次问闸
    this.soopFailStreak = 0
    this.soopCooldownUntil = 0
    // 重启即作废失明连败账本: 留痕里的轮数必须是本轮会话的真实连续长度(与 D55d 同规约)
    this.soopBlindStreak = 0
    this.soopUnlisted.clear() // 与上面同规约: 报过"掉出站内表"的名册属于本场会话, 重启后要重新出一份
    this.pandaProbeUntil = 0 // 冷启动第一轮照旧问一次 login_info(探针保证不因清账而退)
    // 轮数同样按"本场会话"起算。roundCnt 是进程级的, 关-开监控时它仍停在上一场的数字上,
    // 于是 :270 那条"首轮后补预取"在一台开着监控跑了几小时、关掉、再打开的机器上永远不会再来 ——
    // 而它正是"源被清过之后, 在播房重新排队"的唯一入口(在播房不会再触发开播翻转)。
    for (const p of PLATS) {
      this.loop[p].roundCnt = 0
      this.schedule(p, 300)
    }
    this.push()
  }

  stop(): void {
    this.running = false
    this.watchStartedAt = 0
    for (const p of PLATS) {
      const L = this.loop[p]
      if (L.timer) clearTimeout(L.timer)
      L.timer = null
      // 诊断台: 停轮之后"下一轮还有多久"与实测轮距都不再成立, 留在账上就是给下一场读数掺假
      L.nextAt = 0
      L.prevBegin = 0
      L.measuredRoundMs = 0
      // 停轮即停泵: 两条队列都是"下一发要发真请求"的待办, 只清定时器会把它们留在手里 ——
      // 泵自己还在排空(它原先只看熔断/冷却, 不看 running), 于是关掉监控之后仍然逐房拉源。
      this.prewarmQueue[p] = []
    }
    // 预取失败的补排定时器同属"下一发要发真请求"的待办, 与两条队列一起撤(键含平台, 整本清)
    for (const t of this.prewarmRetryTimers.values()) clearTimeout(t)
    this.prewarmRetryTimers.clear()
    this.prewarmRetryAt.clear()
    this.idleQueue = []
    this.push()
  }

  /** 立即触发一轮(不等待定时器); 指定平台就只惊动那一条 —— 工作区里的「立即刷新」不该顺手把
   *  另一个平台的请求也发出去。省略参数=两平台各一轮(设置页改完即时生效走这条)。
   *  在飞的那一条跳过; schedule() 会覆盖它未触发的旧定时器, 连续 tick 自然合并为一轮。
   * 每平台 8 秒下限: 正常态一轮 = 一发整站列表(SOOP 实测 374KB), 连点即连发 —— 这是
   *  唯一由人手放大的请求面, 刚落地一轮时再点本来也读不到新东西 */
  private static TICK_MIN_MS = 8_000

  tick(platform?: Platform): void {
    for (const p of platform ? [platform] : PLATS) {
      const L = this.loop[p]
      if (!this.running || L.inFlight) continue
      const since = Date.now() - L.lastAt
      if (L.lastAt && since < Watcher.TICK_MIN_MS) {
        logger.info('watcher', `${platformName(p)} 立即刷新节流: 距上一轮 ${Math.round(since / 1000)}s, 不发新的一轮`)
        continue
      }
      this.schedule(p, 0)
    }
  }

  /** 下一轮等多久: 各按自己那一格, 两站在任何状态下都只认这一格。
   * 旧写法在 Panda 熔断期返回 30_000("为早点探到自己恢复"), 这一笔把它撤了, 三个理由:
   *  ① 风控期把轮距砍短 = 在我们自己判定"这一站正在防我们"的那段时间里加倍发问, 方向与这一格要防的相反;
   * ② 它买不到额外的探针机会: 冷却期一轮只发那一发站内预言机, 而它由 cooldownOracleAt + 5 分钟
   *     自己排班, 30 秒一跳的那一轮多半整轮零网络空转, 省下的只是等待, 省下不了请求;
   *  ③ 它还顺手把 staleOnFirstLook 的阈值(2 × 轮距)从两个轮距压成 60 秒, 熔断期里"陈旧基线"会被批量误判。
   *  1s 下限只防手改库写出 0 —— 那等于让定时器每毫秒发一轮 */
  private intervalFor(platform: Platform): number {
    return Math.max(1, store.getSettings().monitor[platform].pollIntervalSec) * 1000
  }

  private schedule(platform: Platform, delay: number): void {
    const L = this.loop[platform]
    if (L.timer) clearTimeout(L.timer)
    L.nextAt = Date.now() + delay
    L.timer = setTimeout(() => void this.runRound(platform), delay)
  }

  private async runRound(platform: Platform): Promise<void> {
    if (!this.running) return
    const L = this.loop[platform]
    if (L.inFlight) return
    L.inFlight = true
    const begin = Date.now()
    // 实测轮距: 与"设定的间隔"不是一件事 —— 卡死一轮、退避一轮, 差的就是这几秒
    if (L.prevBegin) L.measuredRoundMs = begin - L.prevBegin
    L.prevBegin = begin
    L.nextAt = 0
    // 卡死必须出声(P0-4)。这里只报不医: 强清 inFlight 会让两轮并发写同一批 anchor(撞上 epoch 合并
    // 与离线判定的时序假设), 比它省下的一段延迟更贵。真正治卡死的是上游那两把尺 —— 请求层超时
    // (pandalive.ts API_DEADLINE_MS)与等位上限(netGate.ts QUEUE_MAX_WAIT_MS); 这一句的作用只是
    // 把"监控死了而日志上看不出来"从故障清单里划掉: 阈值取 4 个自己的轮距, 120 秒兜底防手改库写出 1 秒。
    L.watchdog = setTimeout(
      () => logger.warn('watcher', `${platformName(platform)} 轮次超过 ${Math.round(Math.max(4 * this.intervalFor(platform), 120_000) / 1000)} 秒未完成, 后续轮次待它落定(检查这一站是不是卡在哪一发没回来的请求上)`),
      Math.max(4 * this.intervalFor(platform), 120_000)
    )
    L.watchdog.unref?.()
    const st = this.status.byPlatform[platform]
    try {
      if (platform === 'pandalive') await this.roundPanda(store.getSettings())
      else await this.roundSoopTop(store.getSettings())
    } catch (e) {
      // 连败账本只记 Panda 的: SOOP 一条轮次失败不许推高 errorStreak, 更不许把 Panda 拖进熔断
      // (旧实现两条链排在同一个 round 里, 靠 pandaErr 延后抛出做到这点)
      if (platform === 'pandalive') this.noteFailure(e)
      else logger.warn('watcher', `SOOP 轮次异常: ${String((e as Error).message || e)}`)
    } finally {
      if (L.watchdog) {
        clearTimeout(L.watchdog)
        L.watchdog = null
      }
      L.inFlight = false
      L.lastAt = Date.now()
      this.status.lastRoundAt = Date.now()
      this.status.roundMs = Date.now() - begin
      // 轮次心跳: 每 10 轮落一行摘要 —— 事后可证"轮询在这些小时里活着且看得见全站"
      // (每轮都写会刷屏: 30s 间隔下一天 2880 行; 抽稀到 ~5 分钟一行, 14 天约 100KB)
      if (++L.roundCnt % 10 === 0) {
        const all = `${platformName(platform)} 第 ${L.roundCnt} 轮 关注=${st.monitored} 在播=${st.liveFound}`
        const tail = `本轮=${Date.now() - begin}ms`
        // Panda 的 list 模式现在跑两条形不同的链: 预言机那条形同"1 发问完 158 个关注",
        // 全站榜那条才真的看过全站 —— 日志必须说清是哪条, 否则「全站=」会读成上一份大厅快照
        logger.info(
          'watcher',
          platform !== 'pandalive' || this.status.mode !== 'list'
            ? `${all} ${tail}`
            : this.pandaOracle === 'bookmark'
              ? `${all} 站内覆盖=${this.pandaCovered} ${tail}`
              : `${all} 全站=${this.status.liveCount} ${tail}`
        )
      }
      // 首轮落地后才补预取: 旧实现是开机瞬间按库里的 isLive(上一场的快照)逐个拉源 ——
      // 实测每次启动头 90 秒 14~36 发整页读 + 16~21 发取流, 其中相当一部分房其实已经下播
      if (L.roundCnt === 1) this.prewarmSweep(platform)
      this.push()
      if (this.running) {
        store.flush()
        this.schedule(platform, this.intervalFor(platform))
        if (platform === 'pandalive') void this.pumpIdle() // 轮次间隙: 离线关注兜底泵(幂等, 在跑则 no-op)
        void this.pumpPrewarm(platform) // 让路出去的预取在这里续上(幂等, 在跑则 no-op)
      }
    }
  }

  /** Panda 一轮: list(全站列表 + 本地匹配 + 大厅) 或 per-anchor(逐个 member/bj)。
   * 冷却期只发那一发预言机(5 分钟一次), 扇出面一条不发 —— 读数沿用上一轮, 但失明不再有整段 */
  private async roundPanda(cfg: Settings): Promise<void> {
    const P = this.status.byPlatform.pandalive
    this.status.mode = cfg.watchMode
    api.setGap(cfg.monitor.pandalive.requestGapMs)
    // 本引擎只认 pandalive(api 即 pandalive 客户端): 必须按平台取子集,
    // 否则 SOOP 关注会被当成"列表里缺失的主播"送去 member/bj 复查 —— 拿频道名打错站接口。
    const anchors = store.listAnchors().filter((a) => a.platform === 'pandalive')
    P.monitored = anchors.length

    // 零关注的早退(SOOP 那一条:283-292 的孪生): 没有东西可失明就连退避时间戳一起作废,
    // 而大厅不靠这一轮 —— 之后那几页只在用户真站在「发现」那一屏时才发(refreshDiscovery 自带
    // 60 秒复用 + 8 秒下限)。旧写法是"零关注也每轮翻满五页全站榜", 那一轮一个读数都不为谁而读
    if (!anchors.length) {
      this.pandaLiveFound = 0
      this.errorStreak = 0
      this.cooldownUntil = 0
      P.circuitOpen = false
      P.liveFound = 0
      P.message = ''
      return
    }

    const pBegin = Date.now()
    let sent = false
    try {
      if (Date.now() < this.cooldownUntil) {
        // 冷却期只停"扇出面"(全站榜分页、逐房 member/bj 复查、间隙泵快照), 不停那一发预言机:
        // 它买的是全部关注的在播/下播, 是这一站每分钟最便宜的一次读数。读得到 = 这一站还在答话,
        // 退避当场解除。 这一发探针就是"早点探到自己恢复"唯一的实现: 轮距不再为熔断期让步
        // (旧写法把轮距压到 30s, 可那 30 秒到点的一轮仍会走到上面那句 return, 探针根本没发出去过,
        // 提速只买到空转与更短的陈旧阈值), 它改由 cooldownOracleAt + 5 分钟自己排班、搭每一轮的便车,
        // 代价是探测时刻最多比 5 分钟线晚一个轮距(默认 120s); 读不到就照旧安静到到期
        if (Date.now() >= this.cooldownOracleAt + Watcher.COOLDOWN_ORACLE_MS) {
          this.cooldownOracleAt = Date.now()
          const found = await this.roundByBookmark(anchors, true)
          if (found !== null) {
            // 读到才算"这一轮真发了请求": null 那一支可能是没罐/探针节流(整轮零网络),
            // 顶栏「上次拉取」不许被这种空转刷成刚刚
            sent = true
            // 在播数随手记下: 下面 finally 那句 P.liveFound 读的就是这一枚(不在这里落, 顶栏要显示上一场的数)
            this.pandaLiveFound = found
            this.cooldownUntil = 0
            this.errorStreak = 0
            P.circuitOpen = false
            P.message = ''
            P.degraded = false // 预言机读通 = 整表又能一发覆盖全关注, 降级那一句当场收回
            logger.info('watcher', `冷却期预言机读通: 退避提前解除(关注=${anchors.length} 在播=${found})`)
            return
          }
        }
        const remain = Math.ceil((this.cooldownUntil - Date.now()) / 1000)
        P.message = mt('watcher.cooling', { remain })
        return
      }
      sent = true
      // 降级轮的账要在界面上持续说话(用户拍板: 只把账说出来, 不减发): 现场实拍那一轮 158 个关注
      // 靠 10 发逐房复查 + 155 间间隙泵快照来问, 而界面上一个字都没有 —— 只有事后翻日志才知道在烧什么
      let degradeMsg = ''
      if (cfg.watchMode === 'list') {
        // 站内关注列表优先(1 发覆盖全部关注, 实测 158 条/90KB): 它直接对"我关注的人"发言,
        // 请求数与全站热度无关, 是这一站的风控面下限
        // 风控账管到轮次扇出面: 这一站已经亲口报过 403/429/≥500/接口回 HTML(那本账在
        // pandalive.noteRisk), 而旧写法只有预取泵与保活重铸看它 —— 于是"被拦下"这一事件本身就成为
        // 换发数的扳机: bookmark 被选择性拦掉 → 同一轮改打全站榜 5 页 + 上轮在播逐房复查(现场 5~7 发)
        // + 间隙泵在轮距窗口里吃得下的约 100 发快照(那本账: 120s ÷ 1.2s ≈ 100 间)
        // ⇒ 现场量级 ≈110 发/轮, 轮距 120s 就是 ≈8 万发/天, 而健康的一轮只有 1 发。收手窗口 ≤5 分钟, 期间平台在拒答,
        // 那些请求一发也换不回读数 —— 与 SOOP 的探针收手(:847)同语义, 不是拿时效换流量。
        // 预言机那一发照发: 它读通了就是"这一站还在答话", 当场把整表真值落进卡里, 一分钟时效都不丢。
        // 这一格换成"整表那一发自己被拒"而不是总账: 逐房那一发(bj/play)报的限流话术属于
        // 死会话期的检测路径本身, 由它顶掉轮次扇出就是拿时效换流量 —— 用户 2026-10-03 拍板「只把账说出来, 不减发」。
        const riskHold = api.oracleRiskCooling()
        const viaBookmark = await this.roundByBookmark(anchors, riskHold)
        if (viaBookmark === null && riskHold) {
          this.pandaBlindStreak++
          P.message = mt('watcher.degradeHold', { n: this.pandaBlindStreak, why: this.pandaDegradeWhy() })
          P.degraded = true
          logger.info('watcher', `风控冷却中: 本轮只发站内关注那一发, 全站榜与逐房复查收手(连续 ${this.pandaBlindStreak} 轮列表不可用)`)
          return
        }
        if (viaBookmark === null) {
          this.pandaBlindStreak++
          this.pandaLiveFound = await this.roundByList(anchors)
          // 留痕: 这一面在日志里过去是彻底隐形的 —— fetchBj 成功路径零日志、限速队列也不落行,
          // 于是"降级轮把整站吃满"这件事只有事后数包才知道。口径抄 SOOP 那句降级探针回执:
          // 只在列表不可用的轮次出声, 并把连续不可用的轮数带上(与降级留痕一样: 减发要先谈时效, 这里只留痕)
          if (this.pandaUrgentCnt || this.idleQueue.length) {
            logger.info(
              'watcher',
              `降级轮留痕: 站内关注列表连续 ${this.pandaBlindStreak} 轮不可用, 本轮逐房复查 ${this.pandaUrgentCnt} 发 + 间隙泵快照 ${this.idleQueue.length} 间在排队`
            )
          }
          // 同一句话落进界面那一行(工作区本平台横幅 + 顶栏胶囊提示), 数字取的是刚刚这一轮的账 ——
          // roundByList 已经把 rest 快照灌进 idleQueue, 这里读到的是这一轮排上的量
          degradeMsg = mt('watcher.degraded', {
            n: this.pandaBlindStreak,
            why: this.pandaDegradeWhy(),
            r: this.pandaUrgentCnt,
            q: this.idleQueue.length
          })
        } else {
          this.pandaBlindStreak = 0
          this.pandaLiveFound = viaBookmark
        }
      } else {
        // 逐个模式只管"怎么查我的关注", 大厅是另一件事(全站榜按需刷新, 与 watchMode 无关),
        // 所以这里不再清空快照 —— 旧实现清它是为了让大厅报"模式不可用", 现在同一个 tab 自己会去拉
        this.idleQueue = [] // per-anchor 每轮全量复查: list 残留的 rest 快照作废, 间隙泵在此模式无职责
        this.pandaLiveFound = await this.roundByBj(anchors)
      }
      this.errorStreak = 0
      P.circuitOpen = false
      P.message = degradeMsg
      P.degraded = Boolean(degradeMsg)
    } finally {
      // 真发了请求才记时: 冷却期里那一轮什么都没发(连那句"还在退避"都不刷新时间戳),
      // 顶栏「上次拉取耗时」不许被空转轮刷成刚刚
      if (sent) {
        P.liveFound = this.pandaLiveFound
        P.roundMs = Date.now() - pBegin
        P.lastRoundAt = Date.now()
      }
    }
  }

  /** 降级轮的归因: 界面上那一行要说清"为什么这一轮在逐房问", 而不是只报在逐房问。
   *  三条真值全来自 Panda 客户端自己, 零额外请求: jar 里有没有 sessKey(没登录)、官方 login_info 认不认
   *  这枚 cookie(被服务端作废 —— 现场实拍那种"cookie=30 枚 会话=有 官方校验=未登录")、都不是=平台在拒答或改了版。
   *  这一格只负责把那三种情况分开说一句人话, 不据此减任何一发 */
  private pandaDegradeWhy(): string {
    if (!api.hasSession()) return mt('watcher.degradeNoLogin')
    if (!api.cookieValid) return mt('watcher.degradeSessionDead')
    return mt('watcher.degradeRefused')
  }

  /** SOOP 一轮: 一发站内关注列表(myapi/favorite)覆盖全部站内关注, 列表覆盖不到的房才逐发播放页探针。
   *  (全站列表 main_broad_list_api.php 匿名可用但要翻满 43 页/2.7MB 才盖到小主播, 大厅/搜索另开一期)
   * 间隔与节流都取 SOOP 自己那一格: Panda 在不在冷却、Panda 的节流调到多少, 与它无关 */
  private async roundSoopTop(cfg: Settings): Promise<void> {
    const S = this.status.byPlatform.soop
    const soopAnchors = store.listAnchors().filter((a) => a.platform === 'soop')
    S.monitored = soopAnchors.length
    if (!soopAnchors.length) {
      this.soopLiveFound = 0
      this.soopFailStreak = 0
      // 一个房都不剩 = 没有东西可失明: 连冷却时间戳一起作废, 否则日后重新加回关注会被上一场的旧冷却闷住 5 分钟
      this.soopCooldownUntil = 0
      S.liveFound = 0
      S.roundFailed = 0
      S.message = ''
      return
    }
    // 冷却轮整轮零请求: 失明时"每一轮都重发"的形状正是风控最忌讳的, 而这段时间本来也没有可读的数。
    // 不推进 lastRoundAt/roundMs(真发了请求才记时, 与 Panda 冷却同一把尺)
    // 「冷却轮不出声」不补一句倒计时 —— 那是重复读数:
    // 退避只由 soopFailStreak>=2 武装, 而武装那一轮的 message 已经是 watcher.soopDown(关注数 + 连续失明轮数),
    // 冷却轮跳过整轮 = 那句原样留在顶栏/工作区, 加上 D46c 那颗共用 heartbeat —— 盲区从来不静默, 补一句只是把它说两遍
    if (Date.now() < this.soopCooldownUntil) return
    const sBegin = Date.now()
    this.soopLiveFound = await this.roundSoop(soopAnchors, cfg.monitor.soop.requestGapMs)
    S.liveFound = this.soopLiveFound
    S.roundMs = Date.now() - sBegin
    S.lastRoundAt = Date.now()
    // SOOP 探针永不抛错(防 Panda 连坐), 所以它瞎了必须由这里出声: 顶栏绿点照常跳、卡片保留旧状态,
    // 用户读到的却是"一切正常"。单轮失败可能是抖动, 连续两轮才够格说"这一站在我们眼里已经哑了"
    S.message =
      this.soopFailStreak >= 2
        ? mt('watcher.soopDown', { n: soopAnchors.length, r: this.soopFailStreak })
        : // 整轮全灭以外的情况: 探到几个读不到就说几个, 卡片保留旧读数不等于状态正常(设计稿 7.2「整轮部分失败」)
          S.roundFailed > 0
          ? mt('watcher.soopPartial', { n: S.roundFailed })
          : ''
  }

  // ---- 查无此人(改名/注销/错 id)单点处置: 标离线 + 一次性提醒 + 后续不再发请求 ----
  // 绝不计入 errorStreak/熔断: 单主播数据错误无权拖垮全局轮询
  private bjGone = new Set<string>()
  private onBjNotFound(a: Anchor): void {
    this.bjGone.add(roomKey(a.platform, a.userId))
    // 与 onLiveEnd 同规约: 判死当场收尸缓存源。查无此人=这个 id 已不存在, 旧源必死,
    // 留着只会让卡片挂着「秒开」徽标骗人, 点进去 404
    sourceFor(a.platform).invalidatePlay(a.userId)
    if (a.isLive) {
      store.updateAnchor(a.platform, a.userId, this.offPatch(a))
      this.pushAnchors()
    }
    logger.warn('watcher', `关注的主播查无此人(改名/注销/错 id): @${a.userId}`)
    sendToast(
      { type: 'info', platform: a.platform, title: mt('watcher.bjGone', { id: a.userId }), body: mt('watcher.bjGoneHint') },
      { ev: 'generic', ctx: { anchor: a, detail: mt('watcher.bjGoneHint') } }
    )
  }
  /** 该房间是否已确认不存在: true 则所有 bj 复查路径直接跳过(不再发请求) */
  private isGone(a: Anchor): boolean {
    return this.bjGone.has(roomKey(a.platform, a.userId))
  }

  /** 关注增删时清除"查无此人"标记: 移除可重加, 改名/错 id 修正(或平台恢复)后重新探活 */
  unmarkGone(platform: Platform, userId: string): void {
    this.bjGone.delete(roomKey(platform, userId))
  }

  /** 翻离线的统一补丁。lastLiveAt 必须在这里、在 Object.assign 之前从 a.startTime 取:
   *  updateAnchor 改的就是 listAnchors 返回的那个 a 本体, 调用点之后再读 a.startTime 恒为空串,
   *  「上次开播」会被自己抹掉。拿不到开播时刻(旧数据)时保留原值, 不写空。
   *  tags 按"房态"与"本场"分家: isAdult/type 是房间属性, 下播后依然成立, 整对象清 null 会把
   * 已知真值抹成"无标签"(SOOP 不带房间级属性, 这一支实际为 Panda 的 19+/粉丝团服务);
   *  isPw/liveType 属于这一场, 场次结束就是没有, 必须清。 */
  private offPatch(a: Anchor, extra: Partial<Anchor> = {}): Partial<Anchor> {
    return {
      isLive: false,
      title: '',
      tags: a.tags ? { isAdult: a.tags.isAdult, isPw: false, type: a.tags.type, liveType: '' } : null,
      startTime: '',
      viewerCount: 0,
      thumbUrl: '',
      lastLiveAt: a.startTime || a.lastLiveAt,
      ...extra
    }
  }

  /** 轮询/间隙泵统一失败处置: 连续失败熔断 + 指数退避 + UI 通知(原 round catch 原语义)
   *  只作用于 Panda: 这两个泵发的都是 pandalive 请求, SOOP 探针自己攒 soopFailStreak */
  private noteFailure(e: unknown): void {
    const P = this.status.byPlatform.pandalive
    this.errorStreak++
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof RiskError || this.errorStreak >= 3) {
      // 指数退避: 1min -> 2 -> 4 -> ... 上限 15min
      const minutes = Math.min(15, 2 ** Math.min(4, this.errorStreak - 1))
      this.cooldownUntil = Date.now() + minutes * 60_000
      P.circuitOpen = true
      P.message = mt('watcher.circuit', { msg, minutes })
      logger.warn('watcher', P.message)
      sendToast({ type: 'error', platform: 'pandalive', title: mt('watcher.circuitTitle'), body: P.message }, { ev: 'circuit', ctx: { detail: P.message } })
    } else {
      P.message = mt('watcher.roundFail', { msg })
      logger.warn('watcher', `本轮失败(#${this.errorStreak}): ${msg}`)
    }
  }

  /** Panda 轮询的预言机: 站内关注列表(/v1/live/bookmark)一发给出每个关注的在播/下播与场次元数据。
   *  返回 null = 列表不可用(未登录/风控/改版/整表脏, fetchBookmarks 内部已收敛为一句话),
   *  调用方必须回落到全站榜那一轮 —— 绝不把"没读到"当成"全员下播"。
   *  与 SOOP 那一轮同规约: 三态必分, 下播要两轮才翻转(这一翻要发通知并作废旧源)。
   * oracleOnly(冷却期探针): 只买这一发整表, 列表覆盖不到的那些房本轮不逐房复查、也不交间隙泵,
   *  读不到也不把预言机记成 'list' —— 那一轮根本没打过全站榜, 写了就是一个假读数(轮次摘要会拿它说话) */
  private async roundByBookmark(anchors: Anchor[], oracleOnly = false): Promise<number | null> {
    // 这一发要活会话才说话(实测匿名态必回 result:false): 没罐就直接不试, 全站榜那条是匿名用户的既有链路
    if (!api.hasSession()) {
      if (!oracleOnly) this.pandaOracle = 'list'
      return null
    }
    // 罐里有 cookie ≠ 会话已证明: cookieValid 冷启动是 false, 服务端判死也翻回 false —— "没证明"与"已判死"共用一个假值。
    // 直接把它当"别发这一发", 冷启动第一轮就整轮落回全站榜四页(实测 403KB)。这里补问一句 login_info:
    // 30 秒缓存 + 在飞合并, 与启动自愈那次同源(通常零增量), 答案是要的 → 预言机立刻上车;
    // 答案是"没登录"的 → 本轮照旧走兜底链, 代价是每 30 秒一发小请求, 远小于它省下的那四页
    if (!api.cookieValid) {
      // 判死态下这一发探针 30s 缓存短于轮询间隔 = 每轮白付一发。
      // 服务端明确回"没登录"后 5 分钟内不再问: 紧随其后的全站榜响应本来就带 loginInfo 在替它说话。
      // netFail(网络/风控)不节流 —— 读不到 ≠ 判死, 下一轮照问
      if (Date.now() < this.pandaProbeUntil) {
        if (!oracleOnly) this.pandaOracle = 'list'
        return null
      }
      const info = await api.checkLoginInfo()
      if (!info.isLogin) {
        if (!info.netFail) this.pandaProbeUntil = Date.now() + Watcher.LOGIN_PROBE_COOL_MS
        if (!oracleOnly) this.pandaOracle = 'list'
        return null
      }
      api.cookieValid = true
    }
    const rows = await api.fetchBookmarks()
    if (rows === null) {
      if (!oracleOnly) {
        this.pandaOracle = 'list'
        logger.warn('watcher', '站内关注列表不可用, 本轮回落全站榜分页')
      }
      return null
    }
    this.pandaOracle = 'bookmark'
    this.pandaCovered = rows.length
    const now = Date.now()

    const byId = new Map(rows.map((r) => [r.userId, r]))
    let liveFound = 0
    const missing: Anchor[] = []
    for (const a of anchors) {
      const row = byId.get(a.userId)
      if (!row || (row.isLive && !row.live)) {
        // 站内没这条关注(应用内添加/官网侧已取关) 或"说在播却没给场次"= 判不了, 交回原探针链路
        if (row && !oracleOnly) logger.info('watcher', `站内关注列表报在播但无场次信息, 回落 member/bj @${a.userId}`)
        missing.push(a)
        continue
      }
      const wasLive = a.isLive
      const prevTags = a.tags // updateAnchor 原地改 a, 变更判定必须先拍旧标签快照
      if (!row.isLive) {
        if (!wasLive) {
          const patch: Partial<Anchor> = {}
          if (row.nick && row.nick !== a.nick) patch.nick = row.nick
          if (Object.keys(patch).length) store.updateAnchor(a.platform, a.userId, patch)
        }
        this.markPandaOffline(a, wasLive, now)
        continue
      }
      const live = row.live as NonNullable<typeof row.live>
      const patch: Partial<Anchor> = {
        isLive: true,
        nick: row.nick || a.nick,
        userIdx: row.userIdx ?? a.userIdx,
        userImg: live.userImg || row.userImg || a.userImg,
        title: live.title || '',
        tags: { isAdult: live.isAdult, isPw: live.isPw, type: live.type, liveType: live.liveType },
        startTime: live.startTime || '',
        viewerCount: live.viewers,
        likes: live.likes,
        fans: live.fans,
        thumbUrl: live.thumbUrl || '',
        lastSeenAt: now,
        // 在播期间就落「上次开播」: 未必守得到他下播那一轮(应用退出/关注移除), 事后无从补
        lastLiveAt: live.startTime || a.lastLiveAt
      }
      store.updateAnchor(a.platform, a.userId, patch)
      this.clearOfflinePending(a)
      liveFound++
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      else this.onRoomShift(a, prevTags, patch.tags as NonNullable<Anchor['tags']>)
    }

    // 列表覆盖不到的关注: 与旧链路同一份兜底(轮内复查曾开播的, 离线的那些交间隙泵)
    // 冷却探针不买这一单: 逐房 member/bj 与间隙泵快照都是扇出面, 正是退避期要停的那一类 ——
    // 它们要等的下一发是"退解除之后的那一轮", 而这一发的读数已经落进卡里了
    if (!oracleOnly) {
      const urgent = missing.filter((a) => a.isLive && !this.isGone(a))
      this.pandaUrgentCnt = urgent.length // 降级轮留痕要报的就是这个数
      for (const a of urgent) {
        try {
          liveFound += await this.applyBj(a, await api.fetchBj(a.userId))
        } catch (e) {
          if (e instanceof BjNotFoundError) {
            this.onBjNotFound(a)
            continue // 单点数据错误: 不污染本轮(不升级熔断/连败)
          }
          throw e // 其余错误维持轮次失败语义
        }
      }
      this.setIdleQueue(missing.filter((a) => !a.isLive)) // 新快照整批替换, 但从上一窗口没扫到的那一间起排
    }

    // 会话存续证据: result:true 的整表只可能来自活会话(判死/风控都在 fetchBookmarks 里折成 null)
    if (api.hasSession()) {
      this.sessionDeadStreak = 0
      api.cookieValid = true
    }
    this.pushAnchors()
    return liveFound
  }

  /** 全站榜 → 大厅读数(按观众数降序) + 全站在播数。两条入口共用: 兜底轮与按需刷新 */
  private publishDiscovery(liveMap: Map<string, LiveItem>): void {
    this.status.liveCount = liveMap.size
    this.status.discoveryAt = Date.now()
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
    // 大厅时刻随快照广播: 全站榜不再搭轮询的车以后, "这一屏的数据多旧"只有发它的那一处知道,
    // 而轮次那一条 push 得可能比快照新得多 —— 让页头去读 lastRoundAt 就是把轮次的钟挂在大厅上
    this.push()
  }

  /** 全站榜分页: 翻到短页或 MAX_PAGES 为止。错误不抛出去, 挂在 err 上一并带回已翻到的部分 ——
   *  大厅要"失败也不空表"(用部分), 兜底轮要"本轮失败"(推给熔断计数), 同一发请求两种吃法。
   *  两条链共用的正是这条在飞锁, 不是各自的壳 */
  private pageHarvest: Promise<PageHarvest> | null = null
  private async harvestPages(): Promise<PageHarvest> {
    if (this.pageHarvest) return this.pageHarvest
    const p = (async (): Promise<PageHarvest> => {
      const liveMap = new Map<string, LiveItem>()
      let loginInfo: unknown = undefined
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await api.fetchLivePage(page * PAGE_SIZE, PAGE_SIZE)
          if (r.loginInfo) loginInfo = r.loginInfo
          for (const item of r.list) liveMap.set(item.userId, item)
          if (r.list.length < PAGE_SIZE) break
        }
      } catch (e) {
        return { liveMap, loginInfo, err: e }
      }
      return { liveMap, loginInfo, err: null }
    })()
    this.pageHarvest = p
    void p.finally(() => {
      if (this.pageHarvest === p) this.pageHarvest = null
    })
    return p
  }

  /** 大厅(全站榜)按需刷新: 轮询换用站内关注列表后, 这几页只在用户真的站在「发现」那一屏时才拉。
   *  60 秒内的快照直接复用 —— 来回切视图/翻页/搜索都不该再打官网四页(实测 4 页 / 403KB)。
   *  熔断或退避期不发(与 pumpIdle 同语义), 调用方继续看旧快照; 在飞的那次合并, 不重复发。
   *  失败不空表: 一页都没取到就保留上一份, "没读到"绝不画成"全站没人播"。 */
  async refreshDiscovery(force = false): Promise<DiscoveryItem[]> {
    if (this.discoveryInFlight) return this.discoveryInFlight
    const since = Date.now() - this.status.discoveryAt
    if (!force && since < 60_000) return this.discovery
    // force(工作区「立即刷新」站在发现那一屏)只豁免 60 秒复用, 不豁免 8 秒下限:
    // 渲染层那个 2.5s 冷却管的是按钮自身, 连点仍然会每 2.5s 打四到五页整表 ——
    // 与 tick() 同一条下限、同一句节流留痕, 刚拉过一屏时再点本来也读不到新东西
    if (force && since < Watcher.TICK_MIN_MS) {
      logger.info('watcher', `大厅刷新节流: 距上次拉取 ${Math.round(since / 1000)}s, 不发新的一页`)
      return this.discovery
    }
    if (this.status.byPlatform.pandalive.circuitOpen || Date.now() < this.cooldownUntil) return this.discovery
    const p = (async () => {
      const { liveMap, err } = await this.harvestPages()
      if (err) logger.warn('watcher', `大厅刷新失败, 沿用上一份快照: ${String((err as Error).message || err)}`)
      if (liveMap.size) this.publishDiscovery(liveMap)
      return this.discovery
    })()
    this.discoveryInFlight = p
    void p.finally(() => {
      if (this.discoveryInFlight === p) this.discoveryInFlight = null
    })
    return p
  }

  /** 这张卡的"在播"还是不是现值: lastSeenAt 老于两个轮距 = 中间没有任何一轮读数替它说话过
   *  (应用关了几小时/隔夜醒来), 那上面的 isLive 记的是"上一场我们最后一次看见它在播", 不是"现在在播"。
   *  现场实拍 2026-10-03 14:05 冷启动: 153 张这样的陈旧在播卡要靠两轮规则各走两轮才肯翻假,
   *  于是"这一场其实几小时前就散了"这件事要等第二个轮距(默认 120s)才落地 —— 而平台那一发本来就报的是离线,
   *  多等的一轮买不到任何新读数, 只买到一次误报的下播通知。
   *  lastSeenAt 为 0(旧库/从没写过) 不算陈旧: 这一格判的是"证明它旧", 而"没记过"证明不了任何事 ——
   *  证不出来就维持两轮防抖, 宁可晚一轮报下播, 也不凭猜把一场可能真在播的场静默摘掉。
   * 但"只看时间"这一条把稳态的下播通知整条吞了, 实测: 阈值 2×轮距 恰是两轮防抖自己保证会超过的数
   *  (第一轮读到离线时距今=1 个轮距, 第二轮=2 个轮距+轮内耗时), 于是"待第二轮确认"之后必然走豁免分支。
   *  现场实拍 2026-10-03: 落地后 22:17 起「下播:」0 条, 落地前同一日志 168 条; 中途 5 次散场 5/5 都是
   *  「待第二轮确认」→「陈旧基线首轮翻离线」, 一次通知都没发出去。所以 pending>0(已排进防抖)不再豁免 ——
   *  第二次确认读数就是新基线, 该发的通知照发; 豁免只留给"这一轮第一次看到它报离线"的冷启动旧账 */
  private staleOnFirstLook(a: Anchor, platform: Platform, pending: boolean): boolean {
    return !pending && a.lastSeenAt > 0 && Date.now() - a.lastSeenAt > 2 * this.intervalFor(platform)
  }

  /** 这一间正等"第二轮确认下播": 上一轮读数已亲口报它不在播, 只是单轮读数不翻转状态。
   * 读的是锚点行上那一枚时间戳, 不是进程内存(现场: 06:58 报下播 → 07:04 重启 → 旧账丢了,
   *  一场亲眼看见的下播被静默成「散于应用停摆期间」), 且只认新鲜的 —— 见 OFFLINE_PENDING_FRESH_MS。
   * 同一格还替预取泵挡一道: 检测面照旧按原节奏走(两轮规则要的就是第二发读数, 这里一发都不减),
   *  但泵不该再为它买一整条取源链 —— 那一串买的是"秒开", 而平台说这一场已经散了(实拍: 首轮后补扫 22 发整页, 读数全部 offline=true) */
  private offlinePending(a: Anchor): boolean {
    const at = a.offlinePendingAt || 0
    return at > 0 && Date.now() - at <= OFFLINE_PENDING_FRESH_MS
  }

  /** 读到在播就把那一格收回(旧形状是 map.delete, 现在是写 0): 脏账的含义是"平台说这一场散了",
   *  而他正开着 —— 这句不收回就会让预取泵白挡一间、让下一次判离线少排一轮 */
  private clearOfflinePending(a: Anchor): void {
    if (a.offlinePendingAt) store.updateAnchor(a.platform, a.userId, { offlinePendingAt: 0 })
  }

  /** 陈旧基线遇到"报离线"的第一轮读数: 只翻状态, 不发下播事件。
   *  新基线的两轮防抖一条不减(抖动照样要两轮), 这里豁免的只是"那场结束我们根本没在场"的那一次通知 ——
   *  onLiveEnd 会发吐司/TG 并作废旧源, 前两者把一个几小时前的散场报成刚刚的下播, 是拿旧账冒充现值;
   *  源作废与卡片落库照做(留着只会挂着「秒开」徽标骗人) */
  private settleStaleOffline(a: Anchor, now: number): void {
    store.updateAnchor(a.platform, a.userId, this.offPatch(a, { lastSeenAt: now, offlinePendingAt: 0 }))
    sourceFor(a.platform).invalidatePlay(a.userId)
    logger.info('watcher', `陈旧基线首轮翻离线(那场散于应用停摆期间, 不发下播通知): ${a.nick}(@${a.userId})`)
  }

  /** 预言机报"没在播": 单轮读数不翻转状态(瞬回离线/改版丢字段都可能), 连续两轮才判下播。
   * 例外: 基线本身是陈旧的(冷启动/长停), 第一轮就翻状态但不报下播
   * 例外只给第一轮(见 staleOnFirstLook 的实测改判)
   * 那"一轮"从此跨重启: 排进去的那一格写在锚点行上 */
  private markPandaOffline(a: Anchor, wasLive: boolean, now: number): void {
    if (!wasLive) return
    const pending = this.offlinePending(a)
    if (this.staleOnFirstLook(a, a.platform, pending)) {
      this.settleStaleOffline(a, now)
      return
    }
    if (!pending) {
      store.updateAnchor(a.platform, a.userId, { offlinePendingAt: now })
      logger.info('watcher', `站内关注列表报下播, 待第二轮确认 @${a.userId}`)
      return
    }
    store.updateAnchor(a.platform, a.userId, this.offPatch(a, { lastSeenAt: now, offlinePendingAt: 0 }))
    this.onLiveEnd(a)
  }

  /** list 模式: 拉全站列表, 本地匹配; 全量列表同时作为大厅数据源。返回 Panda 侧在播数 */
  private async roundByList(anchors: Anchor[]): Promise<number> {
    // 分页与大厅共走一条在飞锁; 轮次这一路要失败语义: 部分页不许冒充成功
    const { liveMap, loginInfo, err } = await this.harvestPages()
    if (err) throw err
    this.publishDiscovery(liveMap)

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
        lastSeenAt: now,
        // 在播期间就落「上次开播」: 未必守得到他下播那一轮(应用退出/关注移除), 事后无从补
        lastLiveAt: item.startTime || a.lastLiveAt
      }
      store.updateAnchor(a.platform, a.userId, patch)
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      else this.onRoomShift(a, prevTags, patch.tags as NonNullable<Anchor['tags']>)
    }

    // 兜底: 列表不可见的关注主播(19+/隐藏房/500名外) member/bj 节流复查
    // - urgent: 上轮还在播的, 全部立即复查(防止误判下播) —— 轮内完成
    // - rest: 离线关注交间隙泵(pumpIdle)在轮询空档持续轮扫 —— 发现延迟 ≈ N×gap, 与轮询间隔脱钩
    const urgent = missing.filter((a) => a.isLive && !this.isGone(a))
    this.pandaUrgentCnt = urgent.length // 降级轮留痕要报的就是这一个数
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
    this.setIdleQueue(missing.filter((a) => !a.isLive)) // 新快照整批替换, 但从上一窗口没扫到的那一间起排

    // 登录态检测: loginInfo 非空即视为 cookie 有效(结构宽容);
    // 有效→无效 连续 2 轮才宣判作废(单轮缺字段可能是末页响应抖动)。
    // 判死前 cookieValid 保持 true(它同时是"未通知过"闩锁), 宣判当轮才翻 false 并通知一次;
    // 启动即死/曾通知过都不再重复, 重新登录(importCookies)会重新置 true 武装下次检测
    if (api.hasSession()) {
      const alive = Boolean(loginInfo)
      if (alive) {
        this.sessionDeadStreak = 0
        api.cookieValid = true
      } else if (api.cookieValid && ++this.sessionDeadStreak >= 2) {
        this.sessionDeadStreak = 0
        api.cookieValid = false
        logger.warn('watcher', '会话已被服务端作废: 列表响应连续 2 轮不再返回 loginInfo')
        sendToast({ type: 'session', platform: 'pandalive', title: mt('watcher.sessionDeadT'), body: mt('watcher.sessionDeadB') })
      }
    } else {
      api.cookieValid = false
      this.sessionDeadStreak = 0
    }
    this.pushAnchors()
    return liveFound
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
        lastSeenAt: now,
        lastLiveAt: media.startTime || a.lastLiveAt
      }
      store.updateAnchor(a.platform, a.userId, patch)
      this.clearOfflinePending(a)
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      else this.onRoomShift(a, prevTags, patch.tags as NonNullable<Anchor['tags']>)
      return 1
    }
    if (wasLive) {
      // 逐房这一发同样会撞见冷启动留下的旧账: 散场发生在应用停摆期间,
      // 这里翻状态但不发那场"下播"(它在两轮规则之外, 本来是第一轮就宣判的)
      // 已在防抖里排着一轮的, 这一发读数就当作确认轮, 通知照发
      if (this.staleOnFirstLook(a, 'pandalive', this.offlinePending(a))) {
        this.settleStaleOffline(a, now)
        return 0
      }
      // 确认轮就地收账: 旧的内存表在这一支从不删键, 落库后必须删 —— 否则这一间的下一场散场
      // 会被这格旧账当作"已排过一轮", 跳过防抖直接宣判
      store.updateAnchor(a.platform, a.userId, this.offPatch(a, { offlinePendingAt: 0 }))
      this.onLiveEnd(a)
    }
    if (nick && nick !== a.nick) store.updateAnchor(a.platform, a.userId, { nick })
    return 0
  }

  /** per-anchor 模式: 逐个 member/bj。返回 Panda 侧在播数 */
  private async roundByBj(anchors: Anchor[]): Promise<number> {
    let liveFound = 0
    for (const a of anchors) {
      if (this.isGone(a)) continue
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
    this.pushAnchors()
    return liveFound
  }

  /** SOOP 轮询: 优先「一发关注列表 + 本地匹配」(myapi/favorite 带 is_live/broad_info, 718 关注也只需一发),
   *  列表不可用(未登录/风控/改版)或该房不在列表里(应用内关注 ≠ 站内关注)→ 逐房回落到播放页探针。
   *  - 三态必分沿用旧规约: 在播 / 明确下播 / 读数不足则本轮不动它, 绝不把"没读到"写成"已下播"
   *  - 节流: 兜底探针与 Panda 共用 requestGapMs; 列表模式下不发探针, 平台压力从 N 发/轮降到 1 发/轮
   * - 探针有每轮预算(见上方 SOOP_PROBE_BUDGET): 列表整表失效时"每房一发"会放大成 718 发/轮
   *    (实测 ≈5.7 万发/天, 且网络越坏越打越凶), 预算之下按游标轮转 —— 小集合(≤预算)与旧行为一字不差 */
  private async roundSoop(anchors: Anchor[], gapMs: number): Promise<number> {
    const now = Date.now()

    // 头像补齐: SOOP 的关注列表整行没有一个图片字段, 但 logo 的地址就是频道 ID 的函数(零请求, 见 shared 的 soopAvatarUrl)。
    // 只补空的那批 —— 一轮跑完就收敛, 之后每轮这里都是零写入; 老库里 718 行头像全空, 靠这一步补上
    for (const a of anchors) if (!a.userImg) store.updateAnchor(a.platform, a.userId, { userImg: soopAvatarUrl(a.userId) })

    let found = 0
    // 这一发绝不能把异常抛出去: roundSoop 的契约是"永不抛错"(防 Panda 连坐熔断), 列表挂了就等于没列表
    const rows = anchors.length
      ? await soopApi.fetchFavorites().catch((e) => {
          logger.warn('soop', `关注列表异常: ${String((e as Error).message || e)}`)
          return null
        })
      : null
    const byId = rows ? new Map(rows.map((r) => [r.userId, r])) : null
    // 列表里判不了状态的房回落播放页探针: 整表拿不到(未登录/风控/改版)=全部回落,
    // 单房缺席(应用内关注 ≠ 站内关注)或"说在播却没给场次"=只回落它
    const probe: Anchor[] = []
    for (const a of anchors) {
      const row = byId?.get(a.userId)
      if (row && (!row.isLive || row.live)) {
        if (byId && this.soopUnlisted.delete(a.userId)) logger.info('soop', `回到站内关注表, 整页回落结束 @${a.userId}`)
        found += this.applySoopRow(a, row, now)
      } else {
        if (row) logger.info('soop', `列表报在播但无场次信息, 回落播放页 @${a.userId}`)
        // 整表可用而这一间不在里面 —— 它就是"每轮一发整页且全程静默"那一支(根因不在这儿, 减不减由用户定,
        // 但不能再无人知晓)。掉出站内表通常是「站内已取关」或频道改名, 「同步站内关注」能把同一件事标到卡片上
        else if (byId && !this.soopUnlisted.has(a.userId)) {
          this.soopUnlisted.add(a.userId)
          logger.warn('soop', `不在站内关注表(应用内关注 ≠ 站内关注), 每轮回落整页 @${a.userId}`)
        }
        probe.push(a)
      }
    }

    // 列表给了可读判据的房数, 提前算好: 失明判据过去读的是 rows===null, 而现场更常见的形状是
    // "列表读通了, 但我的关注一个都不在里面"(应用内关注 ≠ 站内关注 / 整表只覆盖了别人)。
    // 那种轮次 rows 不是 null ⇒ soopBlindStreak 永远归零, 那道"失明期预取不再为没有场次号的房
    // 买整页"的闸门从不落地(实测 22 发整页全回 offline=true, 连续多轮 blind=0)。
    // covered===0 才是"列表这一轮对我等于没有"的原本那句话 —— 只改判据, 不减一发
    const covered = anchors.length - probe.length

    // 每轮预算 + 游标轮转: 只在真的超预算时才切刀, 于是"少数几个房不在列表里"这一常态一字不改
    const budget = Watcher.SOOP_PROBE_BUDGET
    let sent: Anchor[] = probe
    if (probe.length > budget) {
      const start = this.soopProbeCursor % probe.length
      sent = [...probe.slice(start), ...probe.slice(0, start)].slice(0, budget)
      this.soopProbeCursor = (start + budget) % probe.length
      logger.info('soop', `探针超预算: 本轮发 ${budget}/${probe.length} 个(游标=${start}), 其余 ${probe.length - budget} 房本轮不读`)
    } else {
      this.soopProbeCursor = 0
    }

    // 接口报过风控信号(403/429/5xx 非 515 / 接口回 HTML)→ 冷却期内探针整批收手。
    // 关注列表那一发照旧每轮发: 1 发/轮不是风控忌讳的形状, 停它会直接丢开播时效;
    // 收手的房不记进 fail 而是留在 probe 里 —— 下面那行按"预算挡下"的同一口径计入
    // roundFailed(顶栏「本轮 N 个房间未读到状态」据此仍然成立), 两处都记会把同一批房数两遍。
    // 读数沿用上一轮 —— 三态必分不动, 绝不把"没读到"写成"已下播"
    if (soopApi.riskCooling() && sent.length) {
      logger.info('soop', `接口风控冷却中: 本轮 ${sent.length} 发探针收手, 沿用上次读数`)
      sent = []
    }
    let fail = 0
    let probeLive = 0
    for (const a of sent) {
      const st = await this.probeSoopOne(a, now)
      if (st === 'live') {
        found++
        probeLive++
      } else if (st === 'fail') fail++
      if (gapMs > 0) await sleep(Math.max(300, gapMs) * (0.8 + Math.random() * 0.4))
    }
    // 留痕(原 P1-1 的减发那半已改判): 探针那一发走的是 quiet(只有失败才 warn),
    // 于是"这一轮烧了多少发最贵的整页"在日志里看不见。只在列表失明的轮次出声, 并把连续失明的轮数带上
    // —— 列表正常时 probe 是个位数的常态, 每轮一行会把日志刷成计数器。
    // 全灭那一轮不重复出声: 下面 allFail 那句 warn 报的正是同一件事(两句是重复读数面)。
    // 为什么不做占空比: covered===0 时这条逐房整页【就是】检测路径(全站榜对 SOOP 不存在, 站内列表又读不到),
    // 压它的节奏等于压开播发现延迟; 而探针每轮 40 发已经是这一面的上限。要再减, 得先由用户认下时效那笔账。
    // 判据从 rows===null 换成 covered===0 —— "列表这一轮对我一个房都没说清"就是失明,
    // 不管它是整表不可用还是整表里没有我关注的人
    this.soopBlindStreak = covered === 0 && anchors.length ? this.soopBlindStreak + 1 : 0
    if (sent.length && covered === 0 && fail < sent.length) {
      logger.info(
        'soop',
        `降级探针回执: ${sent.length}/${probe.length} 发整页(在播=${probeLive} 未读到/下播=${sent.length - probeLive - fail} 失败=${fail}; 关注列表已连续 ${this.soopBlindStreak} 轮没覆盖到我的关注)`
      )
    }

    // 失明判据: 列表一个房都没覆盖(整表不可用, 或全部关注都不在站内) 且实际发出的探针全灭。
    // 有了每轮预算以后不能再拿 fail===anchors.length 当判据 —— 40 发永远追不上 718 个关注,
    // 那条老判据会从"平台瞎了"悄悄退化成"永远不会瞎"
    // 冷却收手时 sent 被清空, 这一发都没出去 ≠ 没瞎 —— 此时"覆盖 0 且有房待读"本身就是全灭,
    // 不能让风控冷却反过来把连坐提醒(discovery 第 2 轮弹的那句)绕过去
    // covered 的算法上移到了探针之前(失明判据与留痕都要读它), 这里直接沿用
    const allFail = anchors.length > 0 && covered === 0 && (sent.length > 0 ? fail === sent.length : probe.length > 0)
    // 「未读到状态」的口径随预算一起改口: 发出去且失败的 + 本轮被预算挡下的 = 这一轮没读到的房数,
    // 顶栏/工作区那句「本轮 N 个房间未读到状态, 卡片保留上次读数」据此仍然成立, 不新增读数面
    this.status.byPlatform.soop.roundFailed = fail + (probe.length - sent.length) // 列表整表覆盖时 probe=0, 这里同时负责复位
    this.soopFailStreak = allFail ? this.soopFailStreak + 1 : 0
    if (allFail) logger.warn('watcher', `SOOP 本轮 ${sent.length}/${anchors.length} 个频道取页全失败(网络/风控/改版) 连续 ${this.soopFailStreak} 轮`)
    if (this.soopFailStreak === 2) {
      // 只在跨阈值时提醒一次(与登录失效同语义): 恢复后 streak 归零才会重新武装
      sendToast(
        { type: 'error', platform: 'soop', title: mt('watcher.soopDownT'), body: mt('watcher.soopDown', { n: anchors.length, r: this.soopFailStreak }) },
        { ev: 'generic', ctx: { detail: mt('watcher.soopDown', { n: anchors.length, r: this.soopFailStreak }) } }
      )
    }
    // 连败到阈值就静默 5 分钟: 每一轮都重发的形状正是风控最忌讳的(网络本身坏时尤其如此),
    // 而冷却期内本来也没有可读的数 —— 零请求, 读数沿用上一轮。每个失明轮都重新武装, 恢复当轮归零
    if (this.soopFailStreak >= 2) this.soopCooldownUntil = Date.now() + Watcher.SOOP_COOLDOWN_MS
    this.pushAnchors()
    return found
  }

  /** 关注列表行 → Anchor: 列表把 is_live/broad_info 直接给了, 连开播时刻都是原值
   *  (播放页 HTML 里没有任何时间串, 旧链路只能靠拉源回 BTIME 反推)。返回 1=本轮在播 */
  private applySoopRow(a: Anchor, row: SoopFavoriteRow, now: number): number {
    const wasLive = a.isLive // updateAnchor 原地改 a, 翻转判定必须先拍旧状态
    const live = row.live
    if (row.isLive && live) {
      const patch: Partial<Anchor> = {
        isLive: true,
        nick: row.nick || a.nick,
        title: live.title || a.title,
        // 新开播必须落列表给的 broad_start; 拿不到(格式异常)才沿用上一轮 —— 清空会让卡片时长归零,
        // 沿用上一场的旧值则由 applyPlayMeta 用 BTIME 真值再修正一次
        startTime: live.startTime || a.startTime,
        thumbUrl: live.thumbUrl || a.thumbUrl,
        viewerCount: live.viewers,
        // 按字段合并而不是整包覆写: 单帧列表没带 is_password(布尔缺席)= 这一轮不知道, 必须保住上一轮的真值。
        // isAdult 恒为 false 不是"读到的值", 是"这一路根本不取这个标记"(见 soop.ts parseFavoriteRow):
        // 平台会在同一场里自己改口, 而它只用于展示 —— 顺带把旧轮次残留的 true 清掉, 卡片与页头自此不画 19+
        tags: {
          isAdult: false,
          isPw: live.isPw ?? a.tags?.isPw ?? false,
          type: '', // SOOP 结构性没有粉丝团(没有这一档就不摆行): 这里的 '' 是断言, 不是缺席
          liveType: 'live'
        },
        lastSeenAt: now,
        // 在播期间就同步落「上次开播」: 我们未必守得到他下播那一轮(应用退出/关注移除), 事后无从补
        lastLiveAt: live.startTime || a.startTime || a.lastLiveAt
      }
      store.updateAnchor(a.platform, a.userId, patch)
      this.clearOfflinePending(a)
      if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
      return 1
    }
    if (wasLive) {
      // 单轮读数不翻转状态: 列表瞬回离线/改版丢字段都可能, 而这一翻要发通知+停自录
      // 例外同 Panda 侧: 基线是冷启动留下的旧账, 第一轮就翻状态、只不发那场散场的通知
      // 例外只给第一轮(见 staleOnFirstLook 的实测改判)
      // 排进去的那一格写在锚点行上, 从此跨重启
      const pending = this.offlinePending(a)
      if (this.staleOnFirstLook(a, 'soop', pending)) {
        this.settleStaleOffline(a, now)
        return 0
      }
      if (!pending) {
        store.updateAnchor(a.platform, a.userId, { offlinePendingAt: now })
        logger.info('soop', `关注列表报下播, 待第二轮确认 @${a.userId}`)
      } else {
        store.updateAnchor(a.platform, a.userId, this.offPatch(a, { lastSeenAt: now, offlinePendingAt: 0 }))
        this.onLiveEnd(a)
      }
    } else {
      // 离线行: 站内直接给了 last_broad_start, 它比我们自己的观测权威 —— 我们未必守得到他那一整场
      const patch: Partial<Anchor> = {}
      if (row.nick && row.nick !== a.nick) patch.nick = row.nick
      if (row.lastStartTime && row.lastStartTime !== a.lastLiveAt) patch.lastLiveAt = row.lastStartTime
      if (Object.keys(patch).length) store.updateAnchor(a.platform, a.userId, patch)
    }
    return 0
  }

  /** 播放页探针(列表覆盖不到的房): 三态必分, 单房失败只算它自己 */
  private async probeSoopOne(a: Anchor, now: number): Promise<'live' | 'other' | 'fail'> {
    try {
      // fresh=true: 探针就是"这个房现在怎么样"的唯一裁判, 10 秒微缓存会让两轮读到同一份旧页
      // (最短轮询间隔只有 5 秒), 于是"没读到变化"会被读成"还没开播"
      const m = await soopApi.fetchPageMeta(a.userId, true, true, '探针')
      const wasLive = a.isLive
      if (m.living) {
        const patch: Partial<Anchor> = {
          isLive: true,
          nick: m.hostName || a.nick,
          title: m.roomName || a.title,
          // 开播时刻: 播放页 HTML 里没有任何时间串(实测), 唯一真值是随后拉源回的 BTIME 反推
          // (applyPlayMeta 负责写)。所以新开播这一发必须清空 —— 沿用上一场的旧值等于
          // 把"昨晚开了 3 小时"贴到今天刚开播的房上, 通知与卡片时长一起失真。
          startTime: wasLive ? a.startTime : '',
          // 截图就在同一份播放页 HTML 里(szBroadThumPath), 不额外发请求; 取不到则保留上一轮的
          thumbUrl: m.thumbUrl || a.thumbUrl,
          lastSeenAt: now
        }
        store.updateAnchor(a.platform, a.userId, patch)
        this.clearOfflinePending(a) // 在播即清零(下播判定只数连续轮)
        if (!wasLive) this.onLiveStart({ ...a, ...patch } as Anchor)
        return 'live'
      }
      if (m.explicitOffline) {
        if (wasLive) {
          // 单轮读数不翻转状态: 播放页改版/风控插页都可能瞬回"无场次", 而这一翻要发通知+停自录。
          // 与 Panda 侧"列表缺失→轮内 member/bj 复查再判"同规约, 代价是下播提醒晚一轮
          // 陈旧基线例外(见 staleOnFirstLook): 冷启动第一轮读到散场 = 翻状态, 不报那场下播
          // 例外只给第一轮, 第二轮确认读数一律走 onLiveEnd
          // 排进去的那一格写在锚点行上, 从此跨重启
          const pending = this.offlinePending(a)
          if (this.staleOnFirstLook(a, 'soop', pending)) {
            this.settleStaleOffline(a, now)
            return 'other'
          }
          if (!pending) {
            store.updateAnchor(a.platform, a.userId, { offlinePendingAt: now })
            logger.info('soop', `播放页报下播, 待第二轮确认 @${a.userId}`)
          } else {
            store.updateAnchor(a.platform, a.userId, this.offPatch(a, { lastSeenAt: now, offlinePendingAt: 0 }))
            this.onLiveEnd(a)
          }
        } else if (m.hostName && m.hostName !== a.nick) {
          store.updateAnchor(a.platform, a.userId, { nick: m.hostName, lastSeenAt: now })
        }
      }
      // 第三态(既无场次号也没说下播): 页面异常, 保持上次已知状态
      return 'other'
    } catch (e) {
      logger.warn('watcher', `SOOP 轮询失败 @${a.userId}: ${String((e as Error).message || e)}`)
      return 'fail'
    }
  }

  // ---- 轮次间隙兜底泵: rest(离线且列表不可见的关注)在轮询空档持续轮扫 ----
  // 与主轮询共用同一限速队列(gap+抖动), 单请求速率与轮内完全一致, 但节奏摊平到整条
  // 时间轴: 发现延迟 ≈ N×gap(50 离线 ≈ 60s), 与 pollIntervalSec 无关 —— 不论 30s 还是
  // 300s 一档, 空闲时间轴全部利用起来。让路规则: Panda 轮次进行中不跑(SOOP 那一轮与这条
  // 队列无关, 它发的是 pandalive 请求); 熔断期清空停扫; 每人每轮至多扫一次(快照消费制, 新 round 发新快照)。
  private idleQueue: Anchor[] = []
  private idlePumping = false
  /** 间隙泵的续扫游标: 快照每轮【整批替换】(见 roundByBookmark / roundByList 末尾), 而泵是 shift 消费。
   *  没有游标时, 只要"离线且列表不可见的关注"多于一个轮次间隙吃得下的量(默认 120s / 1.2s ≈ 100 房,
   *  实测 158 关注里离线 148), 就是队首每轮被重扫、队尾一次都扫不到 —— 尾部主播的开播只能靠轮次自己的
   *  列表命中, 而这条队列存在的理由恰恰是"列表此刻不可用"。同一形状还是 member/bj 的 ~0.8 发/秒持续流量。
   *  idleDrained 记这一窗口实际消费了几发, 换快照时据此把游标续到没扫过的位置(与 SOOP 探针同一环形规约) */
  private idleCursor = 0
  private idleDrained = 0

  /** 轮次交给间隙泵的新一批快照: 从上一窗口没扫到的那一间起排 */
  private setIdleQueue(rest: Anchor[]): void {
    const n = rest.length
    this.idleCursor = n ? (this.idleCursor + this.idleDrained) % n : 0
    this.idleDrained = 0
    this.idleQueue = n > 1 ? [...rest.slice(this.idleCursor), ...rest.slice(0, this.idleCursor)] : rest
  }

  private async pumpIdle(): Promise<void> {
    if (this.idlePumping) return
    this.idlePumping = true
    try {
      while (this.idleQueue.length) {
        // 让路: 下一轮开始即停(下轮会发新快照); 停轮(stop)同样中止
        if (!this.running || this.loop.pandalive.inFlight) break
        if (this.status.byPlatform.pandalive.circuitOpen) {
          // 熔断高压期避开(与 prewarm 泵同语义)
          this.idleQueue.length = 0
          break
        }
        // 风控冷却期这条泵也收手 —— 它吃的正是同一站同凭证的逐房那一发, 而轮次收手若只收一半,
        // 间隙里它照样把车道填满。与熔断那一条不同: 不清队列(下一轮 setIdleQueue 会换上新快照)
        // 读的是整表那一格而不是总账 —— 这一泵发的是逐房状态读数(检测路径), 让它被
        // "某个后台拉源撞了限流"顶掉, 就是把开播发现延迟算进了风控的账; 与轮次同一格才收得齐整
        if (api.oracleRiskCooling()) break
        const a = this.idleQueue.shift()!
        // 消费计数: 换快照时游标要续到"这一窗口实际看过几间"之后 —— 被守卫跳过的那几间也算看过
        this.idleDrained++
        // 快照生成后被取关: 跳过(不再为其发请求; 事件层另有 onLiveStart/onLiveEnd 守卫双保险)
        if (!this.stillMonitored(a.platform, a.userId)) continue
        if (this.isGone(a)) continue // 查无此人: 不发请求(每轮都会被快照带回, 必须在消费前挡)
        api.setGap(store.getSettings().monitor.pandalive.requestGapMs) // 与轮内同节奏(设置页改动即时生效)
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

  // ---- 开播预取源泵: 逐个节流拉源写缓存, 点进房间即命中(取流走 sourceFor 契约) ----
  // 队列与泵各平台一条: 节流各用自己的 requestGapMs, 而 Panda 熔断停的是 Panda 自己的预取 ——
  // 旧实现共用一条队列, 那一次 length=0 会把排在队里的 SOOP 房一起丢掉(它们本可以继续秒开)。
  // 队列里只存 userId: 平台已由队列本身表达, 再拼 roomKey 就得在取出时反解回来。
  private prewarmQueue: Record<Platform, string[]> = { pandalive: [], soop: [] }
  private prewarmPumping: Record<Platform, boolean> = { pandalive: false, soop: false }
  /** 预取失败的补排账: 每房这一场已补排几次 + 待触发的那一枚定时器(键=roomKey, 平台在里面) */
  private prewarmRetryCnt = new Map<string, number>()
  private prewarmRetryTimers = new Map<string, NodeJS.Timeout>()
  /** 诊断台: 补排到点的时刻。定时器本身读不出到期时间, 记一格比"看得见队看不见钟"强 */
  private prewarmRetryAt = new Map<string, number>()
  /** 退避基准(第 n 次补排等 n×这一格 = 60/120/180 秒)。60 秒下界的理由: 实测健康期一整条 SOOP 取流链
   *  ≈10 秒、一次抖动通常一两轮(60~120 秒)自己过去; 再短就是在跟平台抢同一秒钟。验证台子压刻度用这一格 */
  private prewarmRetryBaseMs = 60_000
  private static PREWARM_RETRY_MAX = 3

  private enqueuePrewarm(platform: Platform, userId: string): boolean {
    // 密码房不预取: 预取这一路永远没有密码, 这一发注定换回一句"要密码"
    // —— 而 SOOP 那句"要密码"背后是整条取源链(实测每多一档多两发)。用户带着密码进房的那一条不受影响。
    const a = store.listAnchors().find((x) => x.platform === platform && x.userId === userId)
    if (a?.tags?.isPw) return false
    // 正等第二轮确认下播的房不排队
    if (a && this.offlinePending(a)) return false
    const q = this.prewarmQueue[platform]
    if (q.includes(userId)) return false
    // 自录房排到队首: 队列排空要几分钟(实测 103 个房 ≈12 分钟), 而自录那一头是"开播就得有源",
    // 排在尾巴上等于让录制自己等一整轮泵。请求数一字不减, 只是把同一批发出的活排得更早
    if (a?.autoRecord) q.unshift(userId)
    else q.push(userId)
    void this.pumpPrewarm(platform)
    return true
  }

  /** (C4) 手工添加的离线房当场进间隙泵: 旧写法它要等下一轮才被 setIdleQueue 收进快照
   *  (实测 Panda 轮距 120s), 之后再排到那条几百间长的队尾 —— 而他刚刚才点"添加"。
   *  排到队首而不是队尾: 这一间是用户主动要的, 与续扫游标那套"防尾部饿死"的公平账不冲突
   *  (游标只服务整批快照轮换)。多花的至多是那一发 member/bj 的时刻, 不是次数: 下一轮它本来也要被扫 */
  trackIdle(platform: Platform, userId: string): void {
    if (platform !== 'pandalive') return // SOOP 没有间隙泵: 它的逐房探针每轮按游标重切整表, 新房当场就在里面
    const a = store.listAnchors().find((x) => x.platform === platform && x.userId === userId)
    if (!a || a.isLive || this.isGone(a)) return
    if (this.idleQueue.some((x) => x.platform === platform && x.userId === userId)) return
    this.idleQueue.unshift(a)
    void this.pumpIdle()
  }

  /** 对外入口: 关注"已在播"主播时补一发预取(列表模式下该类主播永不再触发 onLiveStart, 预取泵对其缺席) */
  prewarmNow(platform: Platform, userId: string): void {
    this.enqueuePrewarm(platform, userId)
  }

  /** 对外入口: 登录成功把源清账之后, 立刻重跑一次补扫。
   *  clearPlayCache 拿走的是全部在播房的源, 而这些房本轮早已是"在播"—— 状态没有翻转, onLiveStart 不会为它们再响,
   *  于是 ipc.ts 那句「登录后一律重取」实际要等到用户点进播放器 / 房主下一场开播 / 下一台重启才兑现。
   *  补扫按真值重排在播且手上无源的房, 已排队的房由 enqueuePrewarm 去重 ⇒ 发数只补差集, 不重复买。 */
  resweepPrewarm(platform?: Platform): void {
    for (const p of platform ? [platform] : PLATS) this.prewarmSweep(p)
  }

  /** 首轮之后的预取补扫: 只认首轮刚落地的真值, 且跳过手上已有有效源的房。
   *  泵本身按 gap 逐个节流, 所以这里只负责"该不该排队", 不负责速率。
   * 排队顺序按观众数降序(自录房仍由 enqueuePrewarm 顶到队首): 队列排空要几分钟
   *  (实测 103 个房 ≈12 分钟, 现场那 30 间就是按库里加的先后排), 表序把"用户最可能点的那一间"
   *  排到了尾巴上 —— 排在前面的小观众房买到的秒开没人用, 排在后面的大房还没排到就散场。
   *  这是排序, 不是砍量: 发数一字不变 */
  private prewarmSweep(platform: Platform): void {
    if (!store.getSettings().monitor[platform].prefetchStream) return
    const cached = new Set(sourceFor(platform).cachedSourceIds())
    const candidates = store
      .listAnchors()
      .filter((a) => a.platform === platform && a.isLive && !this.isGone(a) && !cached.has(roomKey(platform, a.userId)))
      .sort((x, y) => (y.viewerCount || 0) - (x.viewerCount || 0))
    let queued = 0
    for (const a of candidates) {
      // 排队与否由 enqueuePrewarm 定(正等第二轮确认下播的房不买), 这里的计数只报真排上的
      if (this.enqueuePrewarm(platform, a.userId)) queued++
    }
    if (queued) logger.info('watcher', `${platformName(platform)} 首轮后补预取: ${queued} 个在播房排队(按观众数从高到低)`)
  }

  private async pumpPrewarm(platform: Platform): Promise<void> {
    if (this.prewarmPumping[platform]) return
    this.prewarmPumping[platform] = true
    const q = this.prewarmQueue[platform]
    let skippedNoBno = 0
    let skippedPending = 0
    try {
      while (q.length) {
        // 让路: 停轮即停泵、轮次在飞时先不发预取 —— 与 pumpIdle 同规约。
        // 旧写法只在 Panda 熔断时收手, 于是"关掉监控"与"一轮正在打整表"这两种时刻,
        // 这条泵仍按 1.2s 一发逐房拉源(单房 2~6 发), 停轮语义只清了定时器没清泵。
        // 队列不清空: 轮次落地后 runRound 的 finally 重新点泵, 排在后面的房照旧秒开。
        if (!this.running || this.loop[platform].inFlight) break
        // 熔断期间不预取(避免高压撞墙) —— 只挡 Panda 自己这条队列
        if (platform === 'pandalive' && this.status.byPlatform.pandalive.circuitOpen) {
          q.length = 0
          break
        }
        // SOOP 的接口自己报过风控形状 → 这条后台队列整条收手。
        // 预取是"能晚一点就多晚一点"的那一类请求(用户真点开播时还有一条按需拉源的活路),
        // 而拉源买的是 8~10 发链(每档 2 发), 正是冷却期最不该重发的形状
        if (platform === 'soop' && soopApi.riskCooling()) {
          q.length = 0
          break
        }
        // Panda 这一侧此前对风控完全失明 —— 下面那句 .catch(=> undefined) 把 RiskError 吞了,
        // 于是取流撞 403 既进不了熔断(noteFailure 只有轮次与间隙泵两个调用点), 也不进任何自闭环,
        // 整条队列会按 1.2s 一发一路打到底。现在与 SOOP 同规约: 客户端自己记风控账, 后台泵看它收手,
        // 而用户手动进房那一条一律不看它(快道自有标记) —— 冷却期把用户意图也挡下是拿时效换安全, 这笔交易没谈过
        if (platform === 'pandalive' && api.riskCooling()) {
          q.length = 0
          break
        }
        const uid = q.shift()!
        // 入队后被取关: 不再为其拉源(与 pumpIdle/事件守卫同规约; 开播入口(onLiveStart)已挡)
        // 同一次查找顺手重判"现在还在不在播"。队列是首轮落地那一刻的快照, 而排空要几分钟
        // (实测 103 个房 ≈12 分钟), 泵到达时场次早已散掉的房仍会被拉一整条链 —— 实测 22 发整页 HTML
        // 全回 offline=true、那 22 个房现在全部离线 = 100% 白付。秒开只对在播房有意义,
        // 掉线的那一间下一场开播会由 onLiveStart 重新排队, 这里跳过不亏时效
        const a = store.listAnchors().find((x) => x.platform === platform && x.userId === uid)
        if (!a || !a.isLive) continue
        // 排队之后才被预言机报"这一场散了"(正等第二轮确认)的房, 出队这一头同样不买。
        // P2-1 那一格管"已经判死", 这一格管"正在判" —— 队列是排队那一刻的快照, 泵排空要几分钟, 中间会变。
        // 排回队尾不作废: 第二轮真读回在播(瞬回离线的抖动)时那一格一清, 下一趟泵就照买
        if (this.offlinePending(a)) {
          q.push(uid)
          if (++skippedPending >= q.length) break // 整条队列都在等确认 = 这一趟无事可做, 出泵等下一轮读数
          continue
        }
        // 关注列表连续失明的那一段, 预取不再为"手上没有场次号"的房间买那一整页。
        // 整页在这段是逐房检测路径(每轮 ≤40 发, 由探针预算与环形游标管着)—— 那一面照旧一发不少;
        // 预取再买一份就是同一页两遍, 而它买的是"秒开", 没有人在等。排回队尾不作废:
        // 探针那一发真读到的页会把号写进同一本账(soop.ts:770), 轮次落地的续泵(:243)会再来一趟,
        // 于是这一房只是晚一场拿到源
        if (platform === 'soop' && this.soopBlindStreak >= 3 && !soopApi.hasBroadNo(uid)) {
          q.push(uid)
          if (++skippedNoBno >= q.length) break // 整条队列都是这一形状 = 这一趟无事可做, 出泵等下一次点泵
          continue
        }
        const gap = store.getSettings().monitor[platform].requestGapMs
        if (platform === 'pandalive') api.setGap(gap)
        const r = await sourceFor(platform).getPlayCached(uid).catch(() => undefined) // 失败静默(不打扰用户流)
        if (r) applyPlayMeta(platform, uid, r) // SOOP: 顺手把 BTIME 反推的开播时刻/密码房标记写回关注卡
        // "没拿到源"本身要成为一次事件, 否则这一间从这条队列出去就再也不回来
        this.notePrewarmResult(platform, uid, r)
        // 泵这一头跟随设置值(旧写法在这里夹了 `Math.max(1200, gap)`) —— 设置页那把尺的允许区间是
        // 300~10000 ms, 而 300~1199 这一段传到泵上会被抬回 1200, 用户把间隔往下调等于没调(死带)。
        // 现在照读设置值, 抖动保留: `gap` 已在 settingsGuard 钳到 ≥300, 泵这一头的下限由设置说了算, 不由这里代劳
        await sleep(gap * (0.8 + Math.random() * 0.4))
      }
    } finally {
      this.prewarmPumping[platform] = false
    }
  }

  /** 预取失败要有下一次。入队点此前只有两处 —— 首轮补扫(:267, 只认 roundCnt===1)与状态翻转
   *  那一瞬(:1388)，而"这一发失败了"本身不是事件，于是一次抖动就把这间永久逐出预取集：真机那一次
   *  12:15:07 进队 → 12:15:24 我方 15 秒尺 abort → 之后直到重启再无一次尝试，那 10 分钟里这间的
   *  「已缓存」徽标一直熄灭(徽标说的是实话，但"这间本该有源"这件事悄悄丢了)。
   *  现在按 60/120/180 秒退避补排，每房每场最多 3 次 = 最多多 3 发/房，且只在真失败时才花。
   *  两类答案不补：needPassword(预取这一路永远没有密码，重打整链只换回同一句)与 needLogin(缺的是登录态，
   *  不是重试)。门槛回执那类不用挑：它走 getPlayCached 的短路，补排只是占一次队列，零请求。 */
  private notePrewarmResult(platform: Platform, userId: string, r: PlayResult | undefined): void {
    const key = roomKey(platform, userId)
    if (r?.ok) {
      this.prewarmRetryCnt.delete(key) // 源到手: 上一次的失败次数不再欠着(下一次再失败是新的三次)
      return
    }
    if (r?.needPassword || r?.needLogin) return
    const tried = this.prewarmRetryCnt.get(key) || 0
    if (tried >= Watcher.PREWARM_RETRY_MAX || this.prewarmRetryTimers.has(key)) return
    this.prewarmRetryCnt.set(key, tried + 1)
    const t = setTimeout(
      () => {
        this.prewarmRetryTimers.delete(key)
        this.prewarmRetryAt.delete(key)
        // 到点重新过一遍闸: 停轮/取关/关掉预取这三种时候这一发不该发出去
        if (!this.running || !this.stillMonitored(platform, userId)) return
        if (!store.getSettings().monitor[platform].prefetchStream) return
        if (this.enqueuePrewarm(platform, userId))
          logger.info('watcher', `${platformName(platform)} 预取失败补排(第 ${tried + 1}/${Watcher.PREWARM_RETRY_MAX} 次): @${userId}`)
      },
      this.prewarmRetryBaseMs * (tried + 1)
    )
    t.unref?.() // 不拖退出路径(与看门狗同规约)
    this.prewarmRetryTimers.set(key, t)
    this.prewarmRetryAt.set(key, Date.now() + this.prewarmRetryBaseMs * (tried + 1))
  }

  /** 翻转事件统一守卫: 拉列表/拉 bj 飞行窗口内主播可能已被取关; 事件不得落(防幽灵 toast/自录) */
  private stillMonitored(platform: Platform, userId: string): boolean {
    return store.listAnchors().some((x) => x.platform === platform && x.userId === userId)
  }

  private onLiveStart(a: Anchor): void {
    if (!this.stillMonitored(a.platform, a.userId)) return
    sourceFor(a.platform).invalidatePlay(a.userId) // 主播(重)开播: 旧源作废
    // 新一场开播 = 新的三次补排预算(上一场为旧场次烧光的那几次不该带进这一场)
    this.prewarmRetryCnt.delete(roomKey(a.platform, a.userId))
    logger.info('watcher', `开播: ${a.nick}(@${a.userId}) title"${a.title}" 自录=${a.autoRecord ? '开' : '关'}`)
    const cfg = store.getSettings()
    if (cfg.monitor[a.platform].prefetchStream) this.enqueuePrewarm(a.platform, a.userId) // 后台预取新源写缓存
    if (a.tags?.type === 'fan') {
      // 粉丝房开播: 专用通知(与普通开播区分, 仍进系统通知与应用内气泡)
      sendToast({ type: 'fanLive', platform: a.platform, title: mt('watcher.fanLiveStart', { nick: a.nick }), body: a.title || mt('watcher.clickWatch') }, { ev: 'fanLive', ctx: { anchor: a } })
    } else {
      sendToast({ type: 'live', platform: a.platform, title: mt('watcher.liveStart', { nick: a.nick }), body: a.title || mt('watcher.clickWatch') }, { ev: 'live', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime) } })
    }
    if (a.autoRecord) {
      // getSettings 恒返回对象(恒真判定已移除)
      void recorder.start({ platform: a.platform, userId: a.userId, nick: a.nick, title: a.title, password: '', auto: true }).catch(() => undefined)
    }
  }

  /** 持续在播中的房态翻转: 由不敏感变为 19+ 房 或 粉丝房时补发一次通知(新开播走 onLiveStart, 不在此列) */
  private onRoomShift(a: Anchor, oldTags: Anchor['tags'], newTags: NonNullable<Anchor['tags']>): void {
    if (!oldTags) return // 上轮无标签(理论不达: wasLive 分支上轮已在播): 不臆断为变更
    const toAdult = !oldTags.isAdult && newTags.isAdult
    const toFan = oldTags.type !== 'fan' && newTags.type === 'fan'
    if (!toAdult && !toFan) return
    if (!this.stillMonitored(a.platform, a.userId)) return
    const kind = toAdult && toFan ? mt('watcher.roomBoth') : toAdult ? mt('watcher.roomAdult') : mt('watcher.roomFan')
    logger.info('watcher', `房态变更: ${a.nick}(@${a.userId}) ${kind}`)
    sendToast(
      { type: 'roomChange', platform: a.platform, title: `${a.nick} ${kind}`, body: a.title || mt('watcher.clickWatch') },
      { ev: 'roomChange', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime), detail: kind } }
    )
  }

  private onLiveEnd(a: Anchor): void {
    if (!this.stillMonitored(a.platform, a.userId)) return // 同 onLiveStart 守卫: 已取关不弹下播
    logger.info('watcher', `下播: ${a.nick}(@${a.userId})`)
    // 下播即频道死(实测: 之后 play 宽限期还会假发旧频道源, master 必 404) ——
    // 缓存源必须当场作废: 保活泵对已知下播不再心跳, 不清就会留死源骗"秒开"徽标, 点播放/录制必暴毙
    sourceFor(a.platform).invalidatePlay(a.userId)
    sendToast({ type: 'offline', platform: a.platform, title: mt('watcher.liveEnd', { nick: a.nick }), body: '' }, { ev: 'offline', ctx: { anchor: a, liveSec: liveElapsedSec(a.startTime) } })
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
