<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import { platformName, type DiagCacheRow, type DiagLogLine, type DiagRound, type DiagSnapshot, type Platform } from '@shared/types'
import { fmtBytes, fmtClock, fmtNum, fmtRoundCost } from '@/utils/media'

const { t, locale } = useI18n()
const store = useAppStore()
const route = useRoute()

// ============ 诊断台 ============
// 这一页只看不动: 没有任何开关, 也不会因为"想看一眼"多发一个请求。
// 所有数字来自 diag.ts 那份只读投影(程序本来就在记的账), 每 2 秒拉一次增量。
// ==========================================

const PLATS: Platform[] = ['pandalive', 'soop']
const POLL_MS = 2000
/** 屏幕上最多留多少行日志: 比主进程那本环形账(800)小, 是因为这一页不需要把 800 行都堆进 DOM */
const LINE_CAP = 600

const snap = ref<DiagSnapshot | null>(null)
const lines = ref<DiagLogLine[]>([])
const auto = ref(true)
/** 读数那一发 4 秒没回话(读会话罐那一步是唯一可能慢的地方): 整屏停的是刚才那一屏 */
const noAnswer = ref(false)
/** 日志那一发没回话: 挂住的只有列表, 与整屏那一格分开举 —— 把没坏的也说成停了, 比不举更坏 */
const logStale = ref(false)
/** 已经读到第几条: 每次只取这一条之后的增量(主进程那边是环形缓冲, 拉得慢就有一段永远读不到) */
let sinceSeq = 0
let lastDropped = 0
let busy = false
let timer: ReturnType<typeof setInterval> | null = null

/** 每一发都要有尽头: 桥面那一头永远不落地时, busy 会一直举着, 屏幕上停着的那一屏就再也没人说明它为什么不动了 */
function withDeadline<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let kick: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    p.finally(() => { if (kick) clearTimeout(kick) }),
    new Promise<T>((_, rej) => { kick = setTimeout(() => rej(new Error('diag-timeout')), ms) })
  ])
}

onMounted(() => {
  void poll()
  timer = setInterval(() => {
    // 窗口在托盘里藏着的时候不拉: 没人看的那一屏不该占主进程的 IPC
    if (auto.value && document.visibilityState === 'visible') void poll()
  }, POLL_MS)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})

async function poll(): Promise<void> {
  if (busy) return
  busy = true
  try {
    let snapOk = false
    try {
      const s = await withDeadline(api.diagSnapshot())
      // 快照先进账: 日志那一发挂住只该让列表停在刚才, 不该把整屏十二节一起抹成空白
      snap.value = s
      noAnswer.value = false
      snapOk = true
    } catch {
      /* 读不到就留着上一屏: 这一页自己出毛病不该把别的工作区拖坏。但"留着上一屏"必须说出来,
         否则屏幕上下停着的那一屏会被读成现在的 */
      noAnswer.value = true
    }
    if (snapOk) {
      try {
        let page = await withDeadline(api.diagLogs(sinceSeq, LINE_CAP))
        // 缓冲滚走了一批 ⇒ 中间有一段增量永久丢了。这时候整本重来, 而不是假装屏幕上这就是全部
        if (page.stats.dropped > lastDropped) {
          sinceSeq = 0
          lines.value = []
          page = await withDeadline(api.diagLogs(0, LINE_CAP))
        }
        lastDropped = page.stats.dropped
        if (page.lines.length) {
          lines.value = [...lines.value, ...page.lines].slice(-LINE_CAP)
          sinceSeq = page.nextSeq
        }
        logStale.value = false
      } catch {
        logStale.value = true
      }
    }
  } finally {
    busy = false
  }
}

/** 快照那一刻就是"现在": 全页的"多久了"都以它为基准, 免得同一屏里两种此刻 */
const nowAt = computed(() => snap.value?.at ?? Date.now())

function dur(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return t('diag.dSec', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('diag.dMin', { n: m })
  return t('diag.dHour', { h: Math.floor(m / 60), m: m % 60 })
}
function ago(ms: number): string {
  return t('diag.agoText', { v: dur(ms) })
}
/** 节流间隔: 1200 毫秒这种写法屏幕上念不出来, 也看不出「一秒钟放几发」—— 一律收成秒(一位小数) */
function gapText(ms: number): string {
  return t('diag.dSec', { n: fmtRoundCost(ms) })
}
function clock(v: number): string {
  return v > 0 ? t('diag.clockLeft', { v: dur(v) }) : t('diag.clockIdle')
}
function timeOf(ms: number): string {
  return ms ? fmtClock(ms) : '—'
}
function pollSec(p: Platform): number | null {
  const s = store.settings?.monitor?.[p]?.pollIntervalSec
  return typeof s === 'number' && s > 0 ? s : null
}
/** 房间串可能是 "soop:@chan" 这种带平台的键, 也可能是台账里光秃秃的频道号 */
function roomOf(key: string): { plat: Platform | null; id: string } {
  const i = key.indexOf(':')
  if (i > 0) {
    const p = key.slice(0, i)
    if (p === 'soop' || p === 'pandalive') return { plat: p, id: key.slice(i + 1) }
  }
  return { plat: null, id: key }
}
function oracleText(p: Platform, r: DiagRound): string {
  if (p === 'soop') return t('diag.oracleList')
  return r.oracle === 'bookmark' ? t('diag.oracleBookmark') : t('diag.oracleBoard')
}
function ttlText(v: number | null): string {
  if (v === null) return t('diag.ttlLive')
  if (v <= 0) return t('diag.ttlExpired')
  return t('diag.ttlLeft', { v: dur(v) })
}
function gateKind(k: string): string {
  const map: Record<string, string> = {
    pw: t('diag.kindPw'),
    login: t('diag.kindLogin'),
    needAdult: t('diag.kindAdult'),
    needUnlimitItem: t('diag.kindUnlimit'),
    needCoinPurchase: t('diag.kindCoin'),
    needFan: t('diag.kindFan'),
    castEnd: t('diag.kindCastEnd'),
    other: t('diag.kindOther')
  }
  return map[k] || k
}
function recStatus(s: string): string {
  const map: Record<string, string> = {
    recording: t('diag.stRecording'),
    remuxing: t('diag.stRemuxing'),
    done: t('diag.stDone'),
    stopped: t('diag.stStopped'),
    error: t('diag.stError')
  }
  return map[s] || s
}
function cacheName(n: string): string {
  // 名字是主进程那边点的名, 这边只有翻译表: 表里没有就把原名摆出来, 不能把 diag.cacheName.xxx 这样的键码印到普通人屏幕上
  const k = `diag.cacheName.${n}`
  const lbl = t(k)
  return lbl === k ? n : lbl
}
/** 多久过期这一格全部由主进程报(这边不重抄字面值); null = 那一本不按年龄收手 */
function ttlCell(c: DiagCacheRow): string {
  return c.ttlMs === null ? t('diag.ttlNone') : dur(c.ttlMs)
}
function scopeName(s: string): string {
  const k = `diag.scopeName.${s}`
  const lbl = t(k)
  return lbl === k ? s : lbl
}

const metaLine = computed(() => {
  const s = snap.value
  if (!s) return ''
  const parts = [t('diag.openedFor', { v: dur(s.uptimeMs) })]
  parts.push(s.monitoringSince ? t('diag.since', { time: timeOf(s.monitoringSince) }) : t('diag.sinceNone'))
  parts.push(t('diag.windows', { n: s.windowsOpen }))
  return parts.join(' · ')
})

const liveTotal = computed(() => {
  const s = snap.value
  return s ? s.sources.live.pandalive.length + s.sources.live.soop.length : 0
})
const queueTotal = computed(() => {
  const s = snap.value
  if (!s) return 0
  return s.queues.prewarm.len + s.queues.offlinePending.len + s.queues.thumbs.queued + s.queues.pandaLane.queued
})

// ---- 日志筛选 ----
const lvOn = ref({ info: true, warn: true, error: true })
const scopeSel = ref('')
const kw = ref('')
const scopes = computed(() => Array.from(new Set(lines.value.map((l) => l.scope))).sort())
const shownLogs = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return [...lines.value]
    .reverse()
    .filter((l) => lvOn.value[l.level] && (!scopeSel.value || l.scope === scopeSel.value) && (!k || l.text.toLowerCase().includes(k)))
})
const logStats = computed(() => snap.value?.log ?? { kept: 0, total: 0, dropped: 0, warn: 0, error: 0 })

// ---- 左侧锚点导航(与设置页同一套手动 scrollspy) ----
type NavKey = 'round' | 'sources' | 'queues' | 'caches' | 'net' | 'proxy' | 'disk' | 'keys' | 'rec' | 'gates' | 'log'
const navGroups = computed<{ label: string; items: { key: NavKey; label: string; n?: string }[] }[]>(() => [
  { label: t('diag.grpRun'), items: [{ key: 'round', label: t('diag.navRound') }] },
  {
    label: t('diag.grpHold'),
    items: [
      { key: 'sources', label: t('diag.navSources'), n: String(liveTotal.value) },
      { key: 'queues', label: t('diag.navQueues'), n: String(queueTotal.value) },
      { key: 'caches', label: t('diag.navCaches') }
    ]
  },
  { label: t('diag.grpOut'), items: [{ key: 'net', label: t('diag.navNet') }, { key: 'proxy', label: t('diag.navProxy') }] },
  {
    label: t('diag.groupBox'),
    items: [
      { key: 'disk', label: t('diag.navDisk') },
      { key: 'rec', label: t('diag.navRec'), n: String(snap.value?.rec.length ?? 0) },
      { key: 'keys', label: t('diag.navKeys') },
      { key: 'gates', label: t('diag.navGates'), n: String(snap.value?.gates.length ?? 0) }
    ]
  },
  { label: '', items: [{ key: 'log', label: t('diag.navLog'), n: String(logStats.value.warn + logStats.value.error) }] }
])
const navs = computed(() => navGroups.value.flatMap((g) => g.items))

const scrollRef = ref<HTMLElement | null>(null)
const activeNav = ref<NavKey>('round')

function scrollToSec(key: NavKey): void {
  activeNav.value = key
  scrollRef.value?.querySelector(`[data-sec="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 深链 ?sec=sources: 别处(设置页/工作区)能一句"跳过去看那一格"。
 *  视图身份不含 query, 所以已在诊断台时再换 ?sec= 不会重挂 —— watch 必须同时盯 route.query.sec 本身 */
watch(
  () => [scrollRef.value, route.query.sec] as const,
  ([el]) => {
    const sec = String(route.query.sec ?? '') as NavKey
    if (!el || !navs.value.some((n) => n.key === sec)) return
    scrollToSec(sec)
  },
  { immediate: true }
)

function onScroll(): void {
  const box = scrollRef.value
  if (!box) return
  const boxTop = box.getBoundingClientRect().top
  let cur: NavKey = 'round'
  for (const n of navs.value) {
    const el = box.querySelector(`[data-sec="${n.key}"]`)
    if (el && el.getBoundingClientRect().top - boxTop <= 96) cur = n.key
  }
  activeNav.value = cur
}

/** 下一轮倒计时那条进度: 走过整格间隔的比例(间隔未知就不画条, 而不是画一根 0% 的死条) */
function nextPct(r: DiagRound, p: Platform): number | null {
  const sec = pollSec(p)
  if (!sec || r.nextInMs < 0) return null
  const span = sec * 1000
  return Math.max(0, Math.min(100, (1 - r.nextInMs / span) * 100))
}
function nextText(r: DiagRound): string {
  if (r.inFlight) return t('diag.nextInFlight')
  if (r.nextInMs < 0) return t('diag.nextNone')
  return t('diag.nextIn', { v: dur(r.nextInMs) })
}
function num(n: number): string {
  return fmtNum(n, locale.value.startsWith('zh'))
}
const isZh = computed(() => locale.value.startsWith('zh'))
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="px-7 pt-5 pb-4 shrink-0 flex items-start gap-3">
      <div class="min-w-0">
        <h1 class="page-h">
          {{ t('diag.title') }}
          <span v-if="snap" class="text-[11.5px] font-normal text-ink3 truncate">{{ metaLine }}</span>
        </h1>
        <div class="page-sub">{{ t('diag.sub') }}</div>
      </div>
      <div class="ml-auto shrink-0 flex items-center gap-2">
        <!-- 停住的那一屏必须自己承认停住了: 屏上的读数看着和刚才一样, 唯一的区别是它不再是现在 -->
        <span v-if="noAnswer" class="badge badge-md bg-warn/[0.14] text-warnink">{{ t('diag.noAnswer') }}</span>
        <button class="chip" :class="auto ? 'on' : ''" @click="auto = true">{{ t('diag.autoOn') }}</button>
        <button class="chip" :class="auto ? '' : 'on'" @click="auto = false">{{ t('diag.autoOff') }}</button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex px-7 gap-5 pb-4">
      <nav class="w-[200px] shrink-0 pt-0.5 overflow-y-auto no-scrollbar">
        <template v-for="(g, gi) in navGroups" :key="gi">
          <div v-if="g.label" class="px-3 grp-h" :class="gi === 0 ? 'pb-1' : 'mt-3.5 pb-1'">{{ g.label }}</div>
          <button
            v-for="n in g.items"
            :key="n.key"
            class="flex items-center gap-2.5 w-full px-3 py-2 rounded-ctl text-[13px] transition-colors text-left"
            :class="activeNav === n.key ? 'bg-card text-ink1 font-semibold shadow-card' : 'text-ink2 hover:text-ink1 hover:bg-fillh'"
            @click="scrollToSec(n.key)"
          >
            <span class="flex-1 min-w-0 truncate">{{ n.label }}</span>
            <span v-if="n.n && n.n !== '0'" class="sec-n tabular-nums">{{ n.n }}</span>
          </button>
        </template>
      </nav>

      <div v-if="snap" ref="scrollRef" class="flex-1 min-w-0 overflow-y-auto pb-1" @scroll="onScroll">
        <!-- ① 节奏与心跳 -->
        <section data-sec="round" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navRound') }}</h2>
            <span class="sec-tools">{{ t('diag.whyRound') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3 space-y-3">
            <div v-for="p in PLATS" :key="p" class="border-b border-line pb-3 last:border-0 last:pb-0">
              <div class="flex items-center gap-2.5 flex-wrap">
                <i class="pdot" :class="p === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>
                <span class="text-[12.5px] font-bold text-ink1">{{ platformName(p) }}</span>
                <span class="text-[11.5px] text-ink2 tabular-nums">{{ t('diag.roundCnt', { n: snap.rounds[p].roundCnt }) }}</span>
                <span v-if="snap.rounds[p].measuredRoundMs" class="text-[11.5px] text-ink3 tabular-nums">
                  {{ t('diag.measured', { v: fmtRoundCost(snap.rounds[p].measuredRoundMs), sec: pollSec(p) ?? '?' }) }}
                </span>
                <span
                  class="ml-auto text-[11px] font-bold"
                  :class="snap.rounds[p].inFlight ? 'text-brand' : snap.rounds[p].degraded ? 'text-warnink' : 'text-okink'"
                >
                  {{ snap.rounds[p].inFlight ? t('diag.flying') : snap.rounds[p].degraded ? t('diag.degradedNow') : t('diag.flyingNo') }}
                </span>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <span v-if="nextPct(snap.rounds[p], p) !== null" class="meter flex-1"><i :style="{ width: nextPct(snap.rounds[p], p) + '%' }"></i></span>
                <span v-else class="flex-1"></span>
                <span class="text-[11.5px] text-ink3 tabular-nums">{{ nextText(snap.rounds[p]) }}</span>
              </div>
              <div class="mt-1.5">
                <div class="kv">
                  <span class="kv-k">{{ t('diag.clockPoll') }}</span>
                  <span class="kv-v">{{ clock(snap.rounds[p].cooldowns.pollBackoff) }}</span>
                </div>
                <div class="kv">
                  <span class="kv-k">{{ t('diag.clockRisk') }}</span>
                  <span class="kv-v">{{ clock(snap.rounds[p].cooldowns.risk) }}</span>
                </div>
                <div v-if="p === 'pandalive'" class="kv">
                  <span class="kv-k">{{ t('diag.clockProbe') }}</span>
                  <span class="kv-v">{{ clock(snap.rounds[p].cooldowns.probe) }}</span>
                </div>
                <div class="kv">
                  <span class="kv-k">{{ t('diag.oracle') }}</span>
                  <span class="kv-v">
                    {{ oracleText(p, snap.rounds[p]) }}
                    <span v-if="snap.rounds[p].covered" class="text-ink3">({{ t('diag.covered', { n: snap.rounds[p].covered }) }})</span>
                  </span>
                </div>
                <div v-if="snap.rounds[p].probe.budget" class="kv">
                  <span class="kv-k">{{ t('diag.probeBudget') }}</span>
                  <span class="kv-v">{{ t('diag.probeAt', { budget: snap.rounds[p].probe.budget, cur: snap.rounds[p].probe.cursor }) }}</span>
                </div>
                <div class="kv">
                  <span class="kv-k">{{ t('diag.unlisted') }}</span>
                  <span class="kv-v">
                    <span v-if="!snap.rounds[p].unlisted.length" class="text-ink3">{{ t('diag.unlistedNone') }}</span>
                    <span v-else class="text-warnink">{{ snap.rounds[p].unlisted.map((x) => '@' + x).join(' ') }}</span>
                  </span>
                </div>
                <div class="kv">
                  <span class="kv-k">{{ t('diag.goneList') }}</span>
                  <span class="kv-v">
                    <span v-if="!snap.rounds[p].gone.length" class="text-ink3">{{ t('diag.goneNone') }}</span>
                    <span v-else class="text-liveink">{{ snap.rounds[p].gone.map((x) => '@' + x).join(' ') }}</span>
                  </span>
                </div>
              </div>
            </div>
            <div class="text-[11px] text-ink3">{{ t('diag.clocksNote') }}</div>
          </div>
        </section>

        <!-- ④ 直播地址台账 -->
        <section data-sec="sources" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navSources') }}<span class="sec-n tabular-nums">{{ liveTotal }}</span></h2>
            <span class="sec-tools">{{ t('diag.whySources') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <template v-for="p in PLATS" :key="p">
              <div class="grp-h mt-2 mb-1">{{ platformName(p) }} · {{ t('diag.rowCount', { n: snap.sources.live[p].length }) }}</div>
              <div class="flex items-center gap-2 px-2 text-[10.5px] text-ink3">
                <span class="w-[128px] shrink-0">{{ t('diag.colRoom') }}</span>
                <span class="w-[66px] shrink-0">{{ t('diag.colAt') }}</span>
                <span class="w-[58px] shrink-0">{{ t('diag.colAge') }}</span>
                <span class="w-[42px] shrink-0 text-right">{{ t('diag.colTiers') }}</span>
                <span class="flex-1 min-w-0">{{ t('diag.colNote') }}</span>
                <span class="w-[104px] shrink-0 text-right">{{ t('diag.colTtl') }}</span>
              </div>
              <div v-if="!snap.sources.live[p].length" class="px-2 py-1.5 text-[11.5px] text-ink3">{{ t('diag.srcEmpty') }}</div>
              <div
                v-for="r in snap.sources.live[p]"
                :key="r.room"
                class="flex items-center gap-2 px-2 py-1.5 rounded-ctl hover:bg-fill text-[11.5px]"
              >
                <span class="w-[128px] shrink-0 truncate text-ink1 font-medium">{{ roomOf(r.room).id || r.room }}</span>
                <span class="w-[66px] shrink-0 tabular-nums text-ink3">{{ timeOf(r.fetchedAt) }}</span>
                <span class="w-[58px] shrink-0 tabular-nums text-ink3">{{ r.fetchedAt ? ago(nowAt - r.fetchedAt) : '—' }}</span>
                <span class="w-[42px] shrink-0 text-right tabular-nums">{{ t('diag.tiersN', { n: r.variants }) }}</span>
                <span class="flex-1 min-w-0 truncate text-ink3">{{ r.partial ? t('diag.srcPartial') : '' }}</span>
                <span class="w-[104px] shrink-0 text-right tabular-nums" :class="r.ttlLeftMs !== null && r.ttlLeftMs <= 10 * 60_000 ? 'text-warnink' : 'text-ink2'">
                  {{ ttlText(r.ttlLeftMs) }}
                </span>
              </div>
            </template>

            <div class="mt-3 border-t border-line pt-2.5">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="text-[12px] font-bold text-ink1">{{ t('diag.storedTitle') }}</span>
                <span class="text-[11.5px] tabular-nums text-ink2">{{ snap.sources.stored.length }} / {{ snap.sources.storedCap }}</span>
                <span class="meter w-[120px]"><i :style="{ width: Math.min(100, (snap.sources.stored.length / snap.sources.storedCap) * 100) + '%' }"></i></span>
                <span class="text-[11px] text-ink3">{{ t('diag.storedTtl', { v: dur(snap.sources.storedTtlMs) }) }}</span>
              </div>
              <div class="mt-1 text-[11.5px] text-ink3">{{ t('diag.storedPandaNote') }}</div>
              <div
                v-for="r in snap.sources.stored"
                :key="r.room"
                class="flex items-center gap-2 px-2 py-1 rounded-ctl text-[11.5px]"
              >
                <span class="w-[128px] shrink-0 truncate text-ink1">{{ roomOf(r.room).id || r.room }}</span>
                <span class="w-[66px] shrink-0 tabular-nums text-ink3">{{ timeOf(r.fetchedAt) }}</span>
                <span class="w-[58px] shrink-0 tabular-nums text-ink3">{{ r.fetchedAt ? ago(nowAt - r.fetchedAt) : '—' }}</span>
                <span class="w-[42px] shrink-0 text-right tabular-nums">{{ t('diag.tiersN', { n: r.tiers }) }}</span>
                <span class="flex-1 min-w-0 truncate text-ink3">{{ t('diag.storedAgo') }}</span>
                <span class="w-[104px] shrink-0 text-right" :class="r.reviveable ? 'text-okink' : 'text-ink3'">
                  {{ r.reviveable ? t('diag.reviveYes') : t('diag.reviveNo') }}
                </span>
              </div>
              <div class="kv mt-1">
                <span class="kv-k">{{ t('diag.epoch') }}</span>
                <span class="kv-v tabular-nums">{{ snap.sources.epochAll }}</span>
              </div>
              <div class="text-[11px] text-ink3">{{ t('diag.epochNote') }}</div>
            </div>
          </div>
        </section>

        <!-- ⑤ 排队的活 -->
        <section data-sec="queues" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navQueues') }}<span class="sec-n tabular-nums">{{ queueTotal }}</span></h2>
            <span class="sec-tools">{{ t('diag.whyQueues') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div class="kv">
              <span class="kv-k">{{ t('diag.qPrewarm') }}</span>
              <span class="kv-v">
                <span v-if="!snap.queues.prewarm.len" class="text-ink3">{{ t('diag.qEmpty') }}</span>
                <span v-else>{{ t('diag.qRooms', { n: snap.queues.prewarm.len }) }}</span>
              </span>
            </div>
            <div v-if="snap.queues.prewarm.head.length" class="flex flex-wrap gap-1.5 px-2 pb-1.5">
              <span v-for="h in snap.queues.prewarm.head" :key="h" class="badge badge-sm bg-fill text-ink2">{{ roomOf(h).id }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.qRetry') }}</span>
              <span class="kv-v">
                <span v-if="!snap.queues.prewarm.retry.length" class="text-ink3">{{ t('diag.qEmpty') }}</span>
              </span>
            </div>
            <div v-for="r in snap.queues.prewarm.retry" :key="r.room" class="px-2 text-[11.5px] text-ink2">
              {{ roomOf(r.room).id }} · {{ t('diag.qRetryAttempt', { n: r.attempt }) }} · {{ t('diag.qRetryIn', { v: dur(r.inMs) }) }}
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.qOffline') }}</span>
              <span class="kv-v tabular-nums">{{ t('diag.qOfflineAt', { n: snap.queues.offlinePending.len, cur: snap.queues.offlinePending.cursor }) }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.qThumbs') }}</span>
              <span class="kv-v">{{ t('diag.qThumbsN', { n: snap.queues.thumbs.queued }) }} · {{ snap.queues.thumbs.working ? t('diag.busyYes') : t('diag.busyNo') }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.qPandaLane') }}</span>
              <span class="kv-v">{{ t('diag.qPandaLaneN', { n: snap.queues.pandaLane.queued, v: gapText(snap.queues.pandaLane.gapMs) }) }} · {{ snap.queues.pandaLane.pumping ? t('diag.busyYes') : t('diag.busyNo') }}</span>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.qNote') }}</div>
          </div>
        </section>

        <!-- ⑥ 本机存了哪些 -->
        <section data-sec="caches" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navCaches') }}</h2>
            <span class="sec-tools">{{ t('diag.whyCaches') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div class="flex items-center gap-2 px-2 text-[10.5px] text-ink3">
              <span class="flex-1 min-w-0">{{ t('diag.colBook') }}</span>
              <span class="w-[70px] shrink-0 text-right">{{ t('diag.colCount') }}</span>
              <span class="w-[110px] shrink-0 text-right">{{ t('diag.colCap') }}</span>
              <span class="w-[120px] shrink-0 text-right">{{ t('diag.colTtl2') }}</span>
            </div>
            <div v-for="c in snap.caches" :key="c.name" class="flex items-center gap-2 px-2 py-1.5 rounded-ctl hover:bg-fill text-[11.5px]">
              <span class="flex-1 min-w-0 truncate text-ink1">{{ cacheName(c.name) }}</span>
              <span class="w-[70px] shrink-0 text-right tabular-nums">{{ c.entries }}</span>
              <span class="w-[110px] shrink-0 text-right tabular-nums" :class="c.cap === null ? 'text-ink3' : 'text-ink2'">
                {{ c.cap === null ? t('diag.capNone') : c.cap }}
              </span>
              <span class="w-[120px] shrink-0 text-right tabular-nums" :class="c.ttlMs === null ? 'text-ink3' : 'text-ink2'">
                {{ ttlCell(c) }}
              </span>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.cachesNote') }}</div>
          </div>
        </section>

        <!-- ⑧ 网络出口 -->
        <section data-sec="net" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navNet') }}</h2>
            <span class="sec-tools">{{ t('diag.whyNet') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div class="grp-h mb-1">{{ t('diag.lanesTitle') }}</div>
            <div v-if="!snap.lanes.length" class="px-2 py-1 text-[11.5px] text-ink3">{{ t('diag.lanesEmpty') }}</div>
            <div v-for="l in snap.lanes" :key="l.host" class="flex items-center gap-2 px-2 py-1 text-[11.5px]">
              <span class="flex-1 min-w-0 truncate text-ink1">{{ l.host }}</span>
              <span class="w-[132px] shrink-0 text-right tabular-nums text-ink2">{{ l.sinceLastMs ? ago(l.sinceLastMs) : t('diag.laneNever') }}</span>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.lanesNote') }}</div>
            <div class="grp-h mt-3 mb-1">{{ t('diag.imgTitle') }}</div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.imgHit') }}</span>
              <span class="kv-v tabular-nums">
                {{ t('diag.imgHitV', { hit: num(snap.images.hit), send: num(snap.images.send), merged: num(snap.images.merged) }) }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.imgFail') }}</span>
              <span class="kv-v tabular-nums">{{ t('diag.imgFailV', { fail: num(snap.images.fail), refused: num(snap.images.refused) }) }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.imgStore') }}</span>
              <span class="kv-v tabular-nums">{{ t('diag.imgStoreV', { n: snap.images.entries, bytes: fmtBytes(snap.images.bytes) }) }}</span>
            </div>
          </div>
        </section>

        <!-- ⑦ 本地转发小站 -->
        <section data-sec="proxy" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navProxy') }}</h2>
            <span class="sec-tools">{{ t('diag.whyProxy') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div class="kv">
              <span class="kv-k">{{ t('diag.pxUp') }}</span>
              <span class="kv-v" :class="snap.proxy.up ? 'text-okink' : 'text-ink3'">
                {{ snap.proxy.up ? t('diag.pxUpYes', { port: snap.proxy.port }) : t('diag.pxUpNo') }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.pxOrigins') }}</span>
              <span class="kv-v tabular-nums">{{ snap.proxy.origins }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.pxInflight') }}</span>
              <span class="kv-v tabular-nums">{{ snap.proxy.inflight }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.pxMerged') }}</span>
              <span class="kv-v tabular-nums">{{ t('diag.pxMergedV', { plays: snap.proxy.mergedPlays, segs: snap.proxy.mergedSegs }) }}</span>
            </div>
          </div>
        </section>

        <!-- ⑨ 磁盘与数据库 -->
        <section data-sec="disk" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navDisk') }}</h2>
            <span class="sec-tools">{{ t('diag.whyDisk') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div
              v-if="snap.disk.probeFailed"
              class="rounded-ctl px-3 py-2 mb-2 text-[12px] font-bold bg-live/[0.12] text-liveink"
            >
              {{ t('diag.diskDead') }}
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.diskProbe') }}</span>
              <span class="kv-v" :class="snap.disk.probeFailed ? 'text-liveink' : 'text-okink'">
                {{ snap.disk.probeFailed ? t('diag.diskProbeBad') : t('diag.diskProbeOk') }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.diskFree') }}</span>
              <span class="kv-v tabular-nums">{{ t('diag.diskFreeV', { free: snap.disk.freeGb.toFixed(1), need: snap.disk.thresholdGb }) }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.diskDir') }}</span>
              <span class="kv-v">{{ snap.disk.dir }}</span>
            </div>
            <div class="mt-2 border-t border-line pt-2">
              <div
                v-if="snap.db.recovering"
                class="rounded-ctl px-3 py-2 mb-2 text-[12px] font-bold bg-warn/[0.14] text-warnink"
              >
                {{ t('diag.dbLock') }}
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.dbState') }}</span>
                <span class="kv-v" :class="snap.db.recovering ? 'text-warnink' : 'text-okink'">
                  {{ snap.db.recovering ? t('diag.dbStateBad') : t('diag.dbStateOk') }}
                </span>
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.dbLastWrite') }}</span>
                <span class="kv-v tabular-nums">{{ snap.db.lastWriteAt ? timeOf(snap.db.lastWriteAt) : t('diag.dbNever') }}</span>
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.dbPending') }}</span>
                <span class="kv-v" :class="snap.db.pendingWrite ? 'text-warnink' : 'text-ink2'">
                  {{ snap.db.pendingWrite ? t('diag.dbPendingYes') : t('diag.dbPendingNo') }}
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- ⑪ 录制内部 -->
        <section data-sec="rec" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navRec') }}<span class="sec-n tabular-nums">{{ snap.rec.length }}</span></h2>
            <span class="sec-tools">{{ t('diag.whyRec') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div v-if="!snap.rec.length" class="px-2 py-1 text-[11.5px] text-ink3">{{ t('diag.recEmpty') }}</div>
            <div v-for="r in snap.rec" :key="r.room" class="px-2 py-1.5 rounded-ctl hover:bg-fill">
              <div class="flex items-center gap-2 text-[11.5px]">
                <i class="pdot pdot-sm" :class="roomOf(r.room).plat === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>
                <span class="flex-1 min-w-0 truncate text-ink1 font-medium">{{ roomOf(r.room).id }}</span>
                <span class="text-ink2">{{ recStatus(r.status) }}</span>
                <span v-if="r.retryStreak" class="badge badge-sm bg-warn/[0.14] text-warnink">{{ t('diag.recRetry', { n: r.retryStreak }) }}</span>
              </div>
              <div class="px-2 text-[11px]" :class="r.stalledForMs > 60_000 ? 'text-liveink' : 'text-ink3'">
                {{ t('diag.recProgress', { v: r.lastProgressAt ? ago(nowAt - r.lastProgressAt) : t('diag.recNoProgress') }) }}
              </div>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.recNote') }}</div>
          </div>
        </section>

        <!-- ⑩ 钥匙与账号 -->
        <section data-sec="keys" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navKeys') }}</h2>
            <span class="sec-tools">{{ t('diag.whyKeys') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div v-for="p in PLATS" :key="p" class="border-b border-line pb-2.5 mb-2.5 last:border-0 last:pb-0 last:mb-0">
              <div class="flex items-center gap-2">
                <i class="pdot" :class="p === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>
                <span class="text-[12px] font-bold text-ink1">{{ platformName(p) }}</span>
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.jarCount') }}</span>
                <span class="kv-v tabular-nums">
                  <span v-if="snap.keys[p].cookies < 0" class="text-ink3">{{ t('diag.jarUnread') }}</span>
                  <span v-else>{{ t('diag.jarCountV', { n: snap.keys[p].cookies, keep: snap.keys[p].persistent, temp: snap.keys[p].sessionOnly }) }}</span>
                </span>
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.jarExpire') }}</span>
                <span class="kv-v tabular-nums">
                  <span v-if="snap.keys[p].sessionOnly && !snap.keys[p].earliestExpireAt" class="text-warnink">{{ t('diag.jarSessionOnly') }}</span>
                  <span v-else-if="snap.keys[p].earliestExpireAt">{{ new Date(snap.keys[p].earliestExpireAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US') }}</span>
                  <span v-else class="text-ink3">—</span>
                </span>
              </div>
              <div class="kv">
                <span class="kv-k">{{ t('diag.jarCheck') }}</span>
                <span class="kv-v tabular-nums">
                  {{ snap.keys[p].lastCheckAt ? timeOf(snap.keys[p].lastCheckAt) : t('diag.jarCheckNone') }}
                  <span class="text-ink3">({{ t('diag.jarCache', { v: dur(snap.keys[p].cacheTtlMs) }) }})</span>
                </span>
              </div>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.vault') }}</span>
              <span class="kv-v" :class="snap.vaultAvailable ? 'text-okink' : 'text-warnink'">
                {{ snap.vaultAvailable ? t('diag.vaultOk') : t('diag.vaultBad') }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-k">{{ t('diag.tg') }}</span>
              <span class="kv-v">
                {{ t('diag.tgV', { token: snap.telegram.hasToken ? t('diag.yes') : t('diag.no'), chat: snap.telegram.hasChat ? t('diag.yes') : t('diag.no'), sw: snap.telegram.switchOn ? t('diag.yes') : t('diag.no') }) }}
                <span :class="snap.telegram.hasToken && snap.telegram.hasChat && snap.telegram.switchOn ? 'text-okink' : 'text-warnink'" class="font-bold">
                  → {{ snap.telegram.hasToken && snap.telegram.hasChat && snap.telegram.switchOn ? t('diag.tgWill') : t('diag.tgSilent') }}
                </span>
              </span>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.keysNote') }}</div>
          </div>
        </section>

        <!-- ⑫ 被挡在外面的房 -->
        <section data-sec="gates" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navGates') }}<span class="sec-n tabular-nums">{{ snap.gates.length }}</span></h2>
            <span class="sec-tools">{{ t('diag.whyGates') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div v-if="!snap.gates.length" class="px-2 py-1 text-[11.5px] text-ink3">{{ t('diag.gatesEmpty') }}</div>
            <div v-for="g in snap.gates" :key="g.room" class="flex items-center gap-2 px-2 py-1.5 rounded-ctl hover:bg-fill text-[11.5px]">
              <i class="pdot pdot-sm" :class="roomOf(g.room).plat === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>
              <span class="w-[128px] shrink-0 truncate text-ink1 font-medium">{{ roomOf(g.room).id }}</span>
              <span class="flex-1 min-w-0 truncate text-ink2">{{ gateKind(g.kind) }}</span>
              <span class="text-ink3 tabular-nums">{{ t('diag.gateLeft', { v: dur(g.until - nowAt) }) }}</span>
              <span v-if="g.persisted" class="badge badge-sm bg-fill text-ink2">{{ t('diag.gateDisk') }}</span>
            </div>
            <div class="text-[11px] text-ink3 mt-1">{{ t('diag.gatesNote') }}</div>
          </div>
        </section>

        <!-- 日志 -->
        <section data-sec="log" class="mb-5">
          <div class="sec-bar">
            <h2 class="sec-h">{{ t('diag.navLog') }}<span v-if="logStats.warn + logStats.error" class="sec-n tabular-nums">{{ logStats.warn + logStats.error }}</span></h2>
            <span v-if="logStale" class="badge badge-sm bg-warn/[0.14] text-warnink">{{ t('diag.logStale') }}</span>
            <span class="sec-tools">{{ t('diag.logStats', { kept: num(logStats.kept), total: num(logStats.total), dropped: num(logStats.dropped) }) }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card px-4 py-3">
            <div class="flex items-center gap-2 flex-wrap">
              <button class="chip" :class="lvOn.info ? 'on' : ''" @click="lvOn.info = !lvOn.info">{{ t('diag.lvInfo') }}<span class="n tabular-nums">{{ num(logStats.kept - logStats.warn - logStats.error) }}</span></button>
              <button class="chip" :class="lvOn.warn ? 'on' : ''" @click="lvOn.warn = !lvOn.warn">{{ t('diag.lvWarn') }}<span class="n tabular-nums">{{ logStats.warn }}</span></button>
              <button class="chip" :class="lvOn.error ? 'on' : ''" @click="lvOn.error = !lvOn.error">{{ t('diag.lvError') }}<span class="n tabular-nums">{{ logStats.error }}</span></button>
              <select v-model="scopeSel" class="h-[27px] px-2 rounded-full text-[12px] bg-card border border-line text-ink2 outline-none">
                <option value="">{{ t('diag.scopeAll') }}</option>
                <option v-for="s in scopes" :key="s" :value="s">{{ scopeName(s) }}</option>
              </select>
              <input
                v-model="kw"
                type="text"
                :placeholder="t('diag.scopeKw')"
                class="h-[27px] w-[168px] px-3 rounded-full text-[12px] bg-page text-ink1 placeholder:text-ink3 outline-none border border-line focus:border-brand/60"
              />
              <span class="ml-auto text-[11px] text-ink3">{{ t('diag.logCount', { n: shownLogs.length }) }}</span>
            </div>
            <div class="mt-2 rounded-ctl bg-page px-2 py-1 max-h-[420px] overflow-y-auto font-mono">
              <!-- 两种空不一样: 一行都没递过来 ≠ 递来了但被筛选条件挡住 -->
              <div v-if="!shownLogs.length" class="py-2 text-[11.5px] text-ink3 font-sans">{{ logStale && !lines.length ? t('diag.logNoneStale') : t('diag.logNone') }}</div>
              <div v-for="l in shownLogs" :key="l.seq" class="flex gap-2 py-0.5 text-[11.5px] leading-snug">
                <span class="shrink-0 tabular-nums text-ink3">{{ fmtClock(l.at) }}</span>
                <span class="shrink-0 w-[46px]" :class="l.level === 'error' ? 'text-liveink' : l.level === 'warn' ? 'text-warnink' : 'text-ink3'">
                  {{ l.level === 'error' ? t('diag.lvError') : l.level === 'warn' ? t('diag.lvWarn') : t('diag.lvInfo') }}
                </span>
                <span class="shrink-0 w-[74px] truncate text-ink3">{{ scopeName(l.scope) }}</span>
                <span class="min-w-0 flex-1 break-words" :class="l.level === 'error' ? 'text-liveink' : l.level === 'warn' ? 'text-warnink' : 'text-ink1'">{{ l.text }}</span>
              </div>
            </div>
            <div class="text-[11px] text-ink3 mt-1.5">{{ t('diag.logNote') }}</div>
          </div>
        </section>
      </div>

      <div v-else class="flex-1 min-w-0 flex items-center justify-center text-ink3 text-sm">{{ noAnswer ? t('diag.noSnap') : t('common.loading') }}</div>
    </div>
  </div>
</template>
