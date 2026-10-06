<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { NEmpty, useMessage } from 'naive-ui'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import CinemaOverlay from '@/components/CinemaOverlay.vue'
import PlatFilter from '@/components/PlatFilter.vue'
import PlatTag from '@/components/PlatTag.vue'
import { useI18n } from 'vue-i18n'
import { fmtBytes, fmtDur, isWholeTask, mergeableTask } from '@/utils/media'
import { isPlatform, platformName, roomKey, type Platform, type RecHistoryItem } from '@shared/types'

// ============ 库(录制页第三段) ============
// 原独立「视频库」页并入录制页: 录完的落地结果与"正在录的"是同一件事的两个时刻,
// 分成两页会得到两份筛选、两套分组、两份对账入口。这里保留库的全部能力
// (分组/索引/搜索/缩略图/影院浮层/合并), 只去掉页头与统计胶囊 —— 那一屏的事实由录制页页头给。
// ==========================================

const { t, locale } = useI18n()
const store = useAppStore()
const message = useMessage()

const props = defineProps<{ plat?: string }>()

onMounted(async () => {
  // 刷新历史即对账: recHistory 入口先跑 reconcileHistory 对齐外部删改再返回, 卡片所见即实况
  await store.refreshHistory()
  spyRoot = scrollRoot()
  spyRoot?.addEventListener('scroll', onIndexScroll, { passive: true })
})
onUnmounted(() => {
  spyRoot?.removeEventListener('scroll', onIndexScroll)
  offRecThumb()
})

// ---- 九宫格缩略图: 主进程生成并持久化(data/thumbs), 命中直返 + 就绪推送点亮 ----
// requested 置模块级: 离开录制页再回来不必整轮重发 IPC(主进程缓存仍会命中, 但省往返)
const requested = new Set<string>()
const thumbMap = reactive<Record<string, string>>({})
async function ensureThumb(id: string): Promise<void> {
  if (requested.has(id) || thumbMap[id]) return
  requested.add(id)
  try {
    const r = await api.recThumb(id)
    if (r.ok && r.url) thumbMap[id] = r.url
  } catch { /* 缩略图失败用占位底, 不打扰使用 */ }
}
const offRecThumb = api.onRecThumb((p) => {
  thumbMap[p.id] = p.url
})

// ---- 统计(恒为全局口径: 这一页的磁盘与总量不该随筛选变小, 与录制页页头同一判定) ----
const totalCount = computed(() => store.history.length)
const totalDurSec = computed(() =>
  store.history.reduce((s, h) => s + Math.max(0, Math.floor(((h.endedAt ?? h.startedAt) - h.startedAt) / 1000)), 0)
)
const totalBytes = computed(() => store.history.reduce((s, h) => s + (h.bytes || 0), 0))
/** 平台分解(设计稿 4.2②): 「总 128」读不出两平台各占多少, 补一行而不是逼用户切页面 */
const platCount = computed(() => {
  const n: Record<Platform, number> = { pandalive: 0, soop: 0 }
  for (const h of store.history) n[h.platform === 'soop' ? 'soop' : 'pandalive']++
  return n
})
const platCounts = computed(() => ({ all: totalCount.value, pandalive: platCount.value.pandalive, soop: platCount.value.soop }))

// ---- 平台口径: 地址带平台段(/:plat/recordings)即默认只看这一方, 「全部平台」仍可切回去 ----
const platFilter = ref<'all' | Platform>(isPlatform(props.plat) ? props.plat : 'all')
watch(
  () => props.plat,
  (v) => {
    platFilter.value = isPlatform(v) ? v : 'all'
  }
)
/** 当前平台口径下的条目(段标题计数用它; 上面那行统计恒为全局) */
const platScoped = computed(() =>
  platFilter.value === 'all' ? store.history : store.history.filter((h) => h.platform === platFilter.value)
)

// ---- 筛选 + 搜索 + 分组 ----
type FilterKey = 'all' | 'live' | 'vod' | 'whole' | 'error'
const filterChip = ref<FilterKey>('all')
const keyword = ref('')
const chips = computed(() => [
  { key: 'all' as const, label: t('rec.fAll') },
  { key: 'live' as const, label: t('rec.fLive') },
  { key: 'vod' as const, label: t('rec.fVod') },
  { key: 'whole' as const, label: t('library.fWhole') },
  { key: 'error' as const, label: t('rec.fErr') }
])

const isWhole = isWholeTask

const filtered = computed(() => {
  let rows = platScoped.value
  const f = filterChip.value
  if (f === 'live') rows = rows.filter((h) => !h.vod)
  else if (f === 'vod') rows = rows.filter((h) => h.vod)
  else if (f === 'error') rows = rows.filter((h) => h.status === 'error')
  else if (f === 'whole') rows = rows.filter(isWhole)
  const k = keyword.value.trim().toLowerCase()
  if (k) rows = rows.filter((h) => h.title.toLowerCase().includes(k) || h.nick.toLowerCase().includes(k) || h.userId.toLowerCase().includes(k))
  return rows
})

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const md = t('rec.dayMd', { m: d.getMonth() + 1, d: d.getDate() })
  const today = new Date()
  if (sameDay(d, today)) return t('rec.dayToday', { md })
  const y = new Date(today)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return t('rec.dayYest', { md })
  // 跨年: 带上年份, 避免不同年份的同名日期(如 2025/9/3 与 2026/9/3)显示成同一标签
  if (d.getFullYear() !== today.getFullYear()) return t('rec.dayYmd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return md
}

type GroupMode = 'date' | 'anchor'
const groupMode = ref<GroupMode>('date')
const groupModes = computed(() => [
  { key: 'date' as const, label: t('library.groupDate') },
  { key: 'anchor' as const, label: t('library.groupAnchor') }
])

const groups = computed(() => {
  // 统一按开始时间倒序; 分组 key 必须唯一(外层 v-for key 不能重复, 复用 key 会导致 DOM 补丁残留幻影卡)
  const sorted = [...filtered.value].sort((a, b) => b.startedAt - a.startedAt)
  const out: { label: string; key: string; short: string; rows: RecHistoryItem[]; plat?: Platform }[] = []
  if (groupMode.value === 'anchor') {
    const map = new Map<string, RecHistoryItem[]>()
    for (const h of sorted) {
      const k = h.userId ? roomKey(h.platform, h.userId) : h.nick
      const arr = map.get(k)
      if (arr) arr.push(h)
      else map.set(k, [h])
    }
    // 索引条短标签用裸 ID(平台前缀是给键用的, 不是给人读的); 平台改在分组标题上出徽标
    for (const [k, rows] of map) out.push({ label: rows[0].nick, key: k, short: rows[0].userId || rows[0].nick, rows, plat: rows[0].platform })
    return out
  }
  for (const h of sorted) {
    const label = dayLabel(h.startedAt)
    const g = out[out.length - 1]
    if (g && g.label === label) g.rows.push(h)
    else out.push({ label, key: h.id, short: shortDay(h.startedAt), rows: [h] })
  }
  return out
})

// 可见分组变化时逐条确保缩略图(命中即回, 未命中主进程后台队列生成后推送)
watch(
  groups,
  () => {
    for (const g of groups.value) for (const h of g.rows) void ensureThumb(h.id)
  },
  { immediate: true }
)

// ---- 左侧索引条(快速跳转) ----
function shortDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  if (locale.value === 'zh-CN') {
    if (sameDay(d, today)) return '今'
    const y = new Date(today)
    y.setDate(y.getDate() - 1)
    if (sameDay(d, y)) return '昨'
  }
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  // 跨年索引短标带两位年份(tooltip 有完整标签), 与当年同月日区分
  return d.getFullYear() !== today.getFullYear() ? `${String(d.getFullYear()).slice(2)}/${md}` : md
}

const rootEl = ref<HTMLElement | null>(null)
/** 跳转与高亮都作用在「真正在滚的那一层」: 库现在是录制页里的一段, 滚动条属于宿主页面。
 *  向上找第一个纵向可滚的祖先, 而不是写死某个 class —— class 会随样式重构改掉 */
function scrollRoot(): HTMLElement | null {
  let el = rootEl.value?.parentElement ?? null
  while (el) {
    const oy = getComputedStyle(el).overflowY
    if (oy === 'auto' || oy === 'scroll') return el
    el = el.parentElement
  }
  return null
}
let spyRoot: HTMLElement | null = null

const activeGKey = ref('')
const displayActiveKey = computed(() => activeGKey.value || groups.value[0]?.key || '')

function jumpTo(key: string): void {
  // scrollIntoView 自己会找到滚动祖先, 不需要 spyRoot
  rootEl.value?.querySelector(`[data-gkey="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeGKey.value = key
}

const scTop = ref(0)
function toTop(): void {
  spyRoot?.scrollTo({ top: 0, behavior: 'smooth' })
  activeGKey.value = groups.value[0]?.key || ''
}

let spyTicking = false
function onIndexScroll(): void {
  if (spyTicking) return
  spyTicking = true
  requestAnimationFrame(() => {
    spyTicking = false
    const root = spyRoot
    if (!root) return
    scTop.value = root.scrollTop
    const top = root.getBoundingClientRect().top
    let cur = ''
    rootEl.value?.querySelectorAll('[data-gkey]').forEach((el) => {
      if (el.getBoundingClientRect().top - top <= 90) cur = el.getAttribute('data-gkey') || ''
    })
    if (cur) activeGKey.value = cur
  })
}

// ---- 状态文字徽章: 类型/文案/底色(不依赖颜色猜测, 直接文字外露) ----
// 底一律取「深阶纯色」: 白字压 #e5484d 只有 3.91:1、压 #e0a526 只有 2.2:1, 双双不达标(设计稿 R1);
// 带 alpha 的深阶压在海报上还会透出背景继续掉对比, 所以这里连 /90 都不留。
const statusBadge: Record<string, { key: string; cls: string }> = {
  recording: { key: 'rec.stRecording', cls: 'bg-liveink' },
  remuxing: { key: 'rec.stRemuxing', cls: 'bg-warnink' },
  done: { key: 'rec.stDone', cls: 'bg-okink' },
  stopped: { key: 'rec.stStopped', cls: 'bg-onimg' },
  error: { key: 'rec.stError', cls: 'bg-liveink' }
}

// ---- 影院浮层 ----
// 任务以 id 引用, 条目变更(删段/合并/对账/删除)即时反映; 条目没了自动关浮层
const cinemaShow = ref(false)
const cinemaTaskId = ref('')
const cinemaTask = computed(() => store.history.find((h) => h.id === cinemaTaskId.value) || null)
const mergingId = ref('')

watch(cinemaTask, (v) => {
  if (cinemaShow.value && !v) cinemaShow.value = false
})

function openCinema(h: RecHistoryItem): void {
  const mp4s = (h.files || []).filter((f) => f.toLowerCase().endsWith('.mp4'))
  if (!mp4s.length) {
    message.warning(t('playback.noMp4'))
    return
  }
  cinemaTaskId.value = h.id
  cinemaShow.value = true
}

async function onMerge(task: RecHistoryItem): Promise<void> {
  if (!mergeableTask(task)) {
    message.info(t('rec.mergeNone'))
    return
  }
  if (mergingId.value) return
  mergingId.value = task.id
  try {
    const r = await api.recMerge(task.id)
    if (r.ok) {
      message.success(t('rec.mergeDone'))
      await store.refreshHistory()
    } else {
      message.warning(r.error || t('rec.mergeFail'))
    }
  } finally {
    mergingId.value = ''
  }
}
</script>

<template>
  <section ref="rootEl" class="min-w-0">
    <!-- 段条: 标题 + 类型筛选 + 平台筛选 | 分组方式 + 搜索
         库里一条都没有时整条不出现: 筛零条记录不是筛选, 是给用户一排按了没反应的按钮 -->
    <div v-if="totalCount" class="sec-bar">
      <h2 class="sec-h">{{ t('library.title') }} <span class="sec-n">{{ platScoped.length }}</span></h2>
      <span class="w-px h-4 bg-line mx-0.5"></span>
      <button v-for="c in chips" :key="c.key" class="chip" :class="filterChip === c.key ? 'on' : ''" @click="filterChip = c.key">
        {{ c.label }}
      </button>
      <span class="w-px h-4 bg-line mx-0.5"></span>
      <PlatFilter :model-value="platFilter" :counts="platCounts" @update:model-value="(v: string) => (platFilter = v as 'all' | Platform)" />
      <div class="sec-tools">
        <!-- 分组方式切换 -->
        <div class="flex items-center bg-card border border-line rounded-full p-[3px]">
          <button
            v-for="m in groupModes"
            :key="m.key"
            class="px-2.5 py-[3px] rounded-full text-[12px] transition-colors"
            :class="groupMode === m.key ? 'bg-brand/[0.10] text-brand font-semibold' : 'text-ink3 hover:text-ink1'"
            @click="groupMode = m.key"
          >{{ m.label }}</button>
        </div>
        <input
          v-model="keyword"
          type="text"
          :placeholder="t('library.searchPh')"
          class="w-[180px] h-[30px] px-3 rounded-ctl bg-card border border-line text-[12px] text-ink1 placeholder:text-ink3 outline-none focus:border-brand transition-colors"
        />
      </div>
    </div>

    <!-- 统计行: 恒为全局口径(独立页的统计胶囊收成一行, 磁盘数字在页头概览条已有, 不重复给第二个源) -->
    <div v-if="totalCount" class="flex items-center gap-1.5 flex-wrap text-[11px] text-ink3 tabular-nums -mt-1 mb-3">
      <span>{{ t('library.summary', { n: totalCount, dur: Math.floor(totalDurSec / 3600) + 'h', size: fmtBytes(totalBytes) }) }}</span>
      <span class="text-ink3/50">·</span>
      <span>{{ t('library.ofWhich') }}</span>
      <span v-for="p in (['pandalive', 'soop'] as Platform[])" :key="p" class="flex items-center gap-1">
        <i class="pdot" :class="p === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>{{ platformName(p) }} {{ platCount[p] }}<span v-if="p === 'pandalive'" class="text-ink3/50">·</span>
      </span>
    </div>

    <!-- 一条都还没有: 页头已经有一块「暂无进行中的录制」大空态, 这里再摆一块 200px 的虚线框,
         整页就只剩两个空盒子。收成一行提示, 等真正有录像可管时再把版面还给墙。 -->
    <div v-if="!totalCount" class="flex items-center gap-2 py-5 text-[12.5px] text-ink3 border-t border-line/60">
      <!-- 只报这一条事实: 去向说明与跳转链接都撤了 —— 页头右上角已经有「打开保存目录」「录制设置」
           「去直播页」三枚, 这一行再挂一枚链接就是同屏第二个入口, 反而要人判断该点哪个 -->
      <span class="text-ink2 font-semibold">{{ t('library.empty') }}</span>
    </div>
    <template v-else>
      <div v-if="groups.length" class="flex gap-4 items-start">
      <aside class="sticky top-1 self-start w-[64px] shrink-0 max-h-[calc(100vh-190px)] -ml-1 flex flex-col">
        <!-- 一键回顶(固定, 不随索引列表滚动) -->
        <button
          class="w-full h-[24px] mb-1 rounded-ctl grid place-items-center shrink-0 transition-colors"
          :class="scTop > 30 ? 'bg-brand/[0.10] text-brand hover:bg-brand/[0.16]' : 'text-ink3/50 hover:text-ink1 hover:bg-fill'"
          :title="t('library.toTop')"
          :aria-label="t('library.toTop')"
          @click="toTop"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M18 15l-6-6-6 6"/></svg>
        </button>
        <div class="h-px bg-line/70 mx-2 mb-1.5 shrink-0"></div>
        <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar py-0.5">
          <button
            v-for="g in groups"
            :key="g.key"
            class="w-full h-[24px] mb-1 rounded-ctl px-1 grid place-items-center text-[11px] truncate transition-colors"
            :class="displayActiveKey === g.key ? 'bg-brand/[0.10] text-brand font-bold' : 'text-ink3 hover:text-ink1 hover:bg-fill'"
            :title="g.label"
            @click="jumpTo(g.key)"
          >{{ g.short }}</button>
        </div>
      </aside>
      <div class="flex-1 min-w-0">
        <template v-for="g in groups" :key="g.key">
          <div class="flex items-baseline gap-2 px-0.5 pt-3.5 pb-2 scroll-mt-2" :data-gkey="g.key">
            <span class="text-[11.5px] font-bold" :class="groupMode === 'anchor' ? 'text-ink1' : 'text-ink3'">{{ g.label }}</span>
            <!-- 按主播/平台分组: 平台由组标题代表 -->
            <PlatTag v-if="g.plat" :platform="g.plat" size="sm" surface="onsurf" />
            <span v-if="groupMode === 'anchor'" class="text-[11px] text-ink3 tabular-nums">{{ t('library.itemsN', { n: g.rows.length }) }}</span>
          </div>
          <div class="card-grid pb-1">
            <div v-for="h in g.rows" :key="h.id" class="group cursor-pointer transition-shadow duration-150 hover:shadow-card-hover" @click="openCinema(h)">
              <!-- 海报 -->
              <div class="relative aspect-video rounded-card overflow-hidden shadow-card transition-shadow duration-150 bg-fill">
                <img v-if="thumbMap[h.id]" :src="thumbMap[h.id]" class="w-full h-full object-cover" loading="lazy" referrerpolicy="no-referrer" />
                <div v-else class="w-full h-full grid place-items-center text-[30px] font-extrabold text-white/85" :class="h.vod ? 'bg-gradient-to-br from-brand/60 to-brand' : 'bg-gradient-to-br from-live/70 to-brand/80'">
                  {{ Array.from(h.nick)[0] }}
                </div>
                <!-- 左上: 来源类型(直播/回放) —— 直播用徽标红、回放用主色蓝(设计稿 S4 草图), 橙色阶整族已退役 -->
                <span
                  class="absolute left-2 top-2 badge badge-sm text-white"
                  :class="h.vod ? 'bg-brand' : 'bg-liveink'"
                >{{ h.vod ? t('account.tagRec') : t('rec.tagLive') }}</span>
                <!-- 右上: 收尾状态文字 -->
                <span
                  class="absolute right-2 top-2 badge badge-sm text-white"
                  :class="statusBadge[h.status]?.cls || 'bg-onimg'"
                >{{ statusBadge[h.status] ? t(statusBadge[h.status].key) : h.status }}</span>
                <span v-if="!h.vod" class="absolute left-2 bottom-2 badge badge-sm bg-onimg text-white tabular-nums">{{ fmtDur(h.startedAt, h.endedAt) }}</span>
                <!-- hover 播放罩 -->
                <!-- hover 播放罩: 用图片承载面令牌而非裸黑 —— 35% 黑压在高亮海报上, 白色 ▶ 会掉到 3:1 以下 -->
                <div class="absolute inset-0 grid place-items-center bg-onimg opacity-0 group-hover:opacity-100 transition-opacity">
                  <div class="w-12 h-12 rounded-full bg-live grid place-items-center text-white text-[17px] scale-90 group-hover:scale-100 transition-transform">▶</div>
                </div>
              </div>
              <div class="mt-2 text-[13px] font-semibold text-ink1 truncate" :title="h.title">{{ h.title || '—' }}</div>
              <div class="flex items-center gap-1.5 mt-0.5 text-[11.5px] text-ink3">
                <span class="truncate">{{ h.nick }}</span>
                <!-- 按日期分组时一场墙里混两平台, 徽标落在卡上; 按主播分组已由组标题代表 -->
                <PlatTag v-if="!g.plat" :platform="h.platform" size="sm" surface="onsurf" />
                <span>·</span><span class="tabular-nums shrink-0">{{ fmtDur(h.startedAt, h.endedAt) }}</span><span>·</span><span class="tabular-nums shrink-0">{{ fmtBytes(h.bytes) }}</span>
                <span v-if="h.status === 'error' && h.error" class="text-liveink truncate">· {{ h.error.slice(0, 30) }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
      <!-- 有记录但当前筛选为空: 这才轮到「没有匹配的视频」出场(以前库里 0 条也显示这句, 把「还没录过」说成了「筛错了」) -->
      <div v-else class="rounded-card border border-dashed border-line py-16 grid place-items-center bg-card/40">
        <n-empty :description="t('library.emptyFilter')" size="small" class="text-ink3" />
      </div>
    </template>

    <!-- 影院浮层(teleport 到 body, 挂在这一段里不会被宿主页的 overflow 裁掉) -->
    <CinemaOverlay v-model:show="cinemaShow" :task="cinemaTask" @merge="onMerge" />
  </section>
</template>
