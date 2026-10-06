import { AsyncLocalStorage } from 'node:async_hooks'
import { sleep } from '../util'
import { logger } from './logger'

// ============ 按站后台车道 ============
// 审出来的形状不是"某一个循环发得太快" —— 每一条后台循环自己都有节流(探针、预取泵、Panda 的限速队列都按
// requestGapMs 睡觉)。漏的是"跨条": 探针循环、预取泵、保活重铸、登录探针各自排队, 谁也不知道同一站上
// 别人此刻正在发第几发, 于是 N 条循环撞在同一站上就是 N 倍瞬时速率, 而 60 秒一轮里它们的相位还会漂移对齐
// (实测 Panda 的 403 就落在 api 站)。这一层只管一件事: 同一个主机名上, 后台请求一次只发一发,
// 并且两发之间留出一个间隔 —— 用户那一路除外(见 asUser)。
//
// 只管 API 站, 不管媒体/CDN: 分片与清单要的是"不断流"(播放器边看边拉分片, 保活泵一轮还要跑完全部在播源),
// 把它们串成一条会直接把源饿死 —— 那正好触发重铸风暴, 比省下的那几发贵得多。媒体面的重复已经在
// hlsProxy 的在途合流里收口, 扇出面(该养几档)是另一条账。
// =========================================

/** 排队上限: 车道再挤也不许把一次后台读取拖过这个数。超了就按上限等 ——
 *  时效性是这一层的第一目标, 宁可这一发挤一挤, 也不让预取队列整体滞后 */
const MAX_WAIT_MS = 8_000

/** 等位上限(P0-3): MAX_WAIT_MS 钳的是"上一发落定之后还要不要再睡", 下面那句 `await prev` 钳的是
 *  "上一发自己结不结束" —— 后者过去没有尽头: 一发永不落地(请求层不设超时的年代就是这样)就把这一站的
 *  后台车道锁到进程结束, 而且锁得悄无声息。120 秒远超实测最深合法排队(单发最长 20 秒 + gap 1.2 秒,
 *  队列是一格一格往下传的, 每个等位者只等自己前一格), 所以它不误伤"挤一挤"的常态, 只给"永不落地"封顶。
 *  到点按失败抛出, 不硬放行: 硬放行等于同一站上同时放开两发在飞, 而那正是这一层要消灭的形状。
 *  环境变量只给验证套子压刻度用(真等 120 秒不划算), 生产不设。 */
const QUEUE_MAX_WAIT_MS = Number(process.env.PD_LANE_QUEUE_CAP || 120_000)

type Lane = { last: number; tail: Promise<unknown> }

const lanes = new Map<string, Lane>()

/** 空道共用同一枚已落定的 Promise: 等位者一眼看出"前面没人", 不必为它再挂一次计时 */
const IDLE: Promise<unknown> = Promise.resolve()

/** 等位到点的计时器: 到点回 true(前格落定则回 false), 撤销时把 pending 那一格结掉以免吊着一条链 */
function waitCap(ms: number): { promise: Promise<boolean>; cancel: () => void } {
  let done: (v: boolean) => void = () => {}
  const t = setTimeout(() => done(true), ms)
  // 不设防的计时器会让退出路径多等一截; 测试套子里 process 也常有这一格
  t.unref?.()
  return {
    promise: new Promise<boolean>((r) => {
      done = r
    }),
    cancel: () => {
      clearTimeout(t)
      done(false)
    }
  }
}

/** 用户级标记: 沿异步链一路传到底, 于是取流链中间任何一跳都知道"这一发是谁要的"。
 *  用 AsyncLocalStorage 而不是逐个函数加参数: 快速道要覆盖的是整条链,
 *  而 fetchPlay → runPlayChain → fetchAid → req 中间隔着四个私有函数, 加参数等于把每一层都改一遍 */
const userMark = new AsyncLocalStorage<boolean>()

/** 把这段调用标成"用户亲自在等"(点播放、点录制): 车道上的后台请求一律给它让路 */
export function asUser<T>(fn: () => Promise<T>): Promise<T> {
  return userMark.run(true, fn)
}

export function isUserCall(): boolean {
  return userMark.getStore() === true
}

/** 用户那一路也在这里落笔: 它不排队, 但它发过之后后台要自己让开一个间隔
 *  (否则"用户点一下 + 后台 17 发"会在同一站上叠成同一瞬时的 18 发) */
function stamp(lane: Lane): void {
  lane.last = Date.now()
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 40)
  }
}

let overCnt = 0
let overLogUntil = 0

/** 走一趟按站车道。baseMs=0 即完全放行(设置的钳制下限是 300ms, 0 只有验证脚本会用到) */
export async function laneRun<T>(host: string, baseMs: number, run: () => Promise<T>): Promise<T> {
  const lane: Lane = lanes.get(host) || { last: 0, tail: IDLE }
  lanes.set(host, lane)
  if (isUserCall()) {
    stamp(lane)
    try {
      return await run()
    } finally {
      stamp(lane)
    }
  }
  // 在飞的后台请求一次只允许一个: 后来者排在上一发的落定之后(同站并发的形状正是这一层要消灭的)
  const prev = lane.tail
  let release = () => {}
  lane.tail = new Promise<void>((r) => {
    release = r
  })
  // 等位也要有尽头(尺与取舍见 QUEUE_MAX_WAIT_MS): 前一发永不落地时, 这一格过去写的是"排到进程结束"。
  // 到点交出的自己那一格不许省 —— 不交就等于把同一次卡住传染给整条队
  if (prev !== IDLE) {
    const cap = waitCap(QUEUE_MAX_WAIT_MS)
    const timedOut = await Promise.race([
      prev.then(
        () => false,
        () => false
      ),
      cap.promise
    ])
    cap.cancel()
    if (timedOut) {
      release()
      logger.warn('net', `${host} 后台车道前一发超过 ${Math.round(QUEUE_MAX_WAIT_MS / 1000)} 秒未落地, 这一发按失败收(不硬放行: 同一站两发在飞正是这一层要消灭的形状)`)
      throw new Error(`netGate: ${host} 等位超时`)
    }
  }
  const want = lane.last + Math.max(0, baseMs) * (0.9 + Math.random() * 0.2) - Date.now()
  const wait = Math.min(Math.max(want, 0), MAX_WAIT_MS)
  if (want > MAX_WAIT_MS) {
    // 挤到超出上限 = 这一站的后台活排不过来了; 60 秒报一次, 静默窗口内的次数在下一句里一起报
    overCnt++
    const now = Date.now()
    if (now >= overLogUntil) {
      overLogUntil = now + 60_000
      logger.warn('net', `${host} 后台车道排队超出 ${Math.round(MAX_WAIT_MS / 1000)} 秒上限 ×${overCnt}, 按上限等待后放行`)
      overCnt = 0
    }
  }
  if (wait > 0) await sleep(wait)
  stamp(lane)
  try {
    return await run()
  } finally {
    release()
  }
}

/** 诊断读数: 当前有几条车道(每站一条, 站点数是个位数, 不需要回收) */
export function laneHosts(): string[] {
  return [...lanes.keys()]
}

/** 诊断台: 每条车道"上一发落定在多久之前"。这个数大不等于堵 —— 它正是按节流放行的形状。
 *  真堵的那一格(前一发永不落地、把尾锁攥在手里)今天没有计数器, 那是 P1 要新记的账, 这里不假装看得见。 */
export function laneSnapshot(): { host: string; sinceLastMs: number }[] {
  const now = Date.now()
  return [...lanes.entries()].map(([host, l]) => ({ host, sinceLastMs: l.last ? now - l.last : 0 }))
}
