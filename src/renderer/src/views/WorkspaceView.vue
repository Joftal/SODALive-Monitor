<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore, type SortKey, type ViewFilter, type WSView } from '@/stores/app'
import { api } from '@/api'
import AnchorCard from '@/components/AnchorCard.vue'
import AvatarImg from '@/components/AvatarImg.vue'
import AddFollowDialog from '@/components/AddFollowDialog.vue'
import ExploreCard from '@/components/ExploreCard.vue'
import SpinIcon from '@/components/SpinIcon.vue'
import { useI18n } from 'vue-i18n'
import { isPlatform, platformName, roomKey, DEFAULT_PLATFORM, type Anchor, type Platform } from '@shared/types'
import { NButton, NEmpty, NPagination, NPopconfirm, NPopselect, NSwitch, useMessage } from 'naive-ui'

// ============ 工作区「直播」页(设计稿方案 A: 视图分段) ============
// 一个平台一套内容, 三视图横切而不是纵向堆叠: 在播关注 / 站内发现 / 离线关注。
// 一次只看一视图 → 内容量最大的两块各自拿到整屏与各自的分页;
// 「关注在播」由分段第一档的计数与顶栏徽标带着, 不再在别视图里复制一条头像坞。
// 视图号写在地址里(?view=), 可收藏可分享; 排序/筛选/页码/滚动位在各视图内记忆(见 store.views)。
// ==================================================================================

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const message = useMessage()
const { t, locale } = useI18n()

const plat = computed<Platform>(() => (isPlatform(route.params.plat) ? route.params.plat : DEFAULT_PLATFORM))
const isSoop = computed(() => plat.value === 'soop')
const otherPlat = computed<Platform>(() => (plat.value === 'soop' ? 'pandalive' : 'soop'))

const view = computed<WSView>(() => {
  const v = route.query.view
  return v === 'discover' || v === 'offline' ? v : 'live'
})
const f = computed(() => store.views[view.value])

const VIEW_LABELS: Record<WSView, () => string> = {
  live: () => t('ws.viewLive'),
  discover: () => t('ws.viewDiscover'),
  offline: () => t('ws.viewOffline')
}

function setView(v: WSView): void {
  if (v === view.value) return
  router.replace({ name: 'live', params: { plat: plat.value }, query: { ...route.query, view: v } })
}

// ---- 列表源: 先按当前平台切一刀(一级轴已是平台, 页面内不再混排两平台) ----
const kw = computed(() => store.searchKeyword.trim().toLowerCase())
function hit(a: { nick: string; userId: string; title?: string }): boolean {
  if (!kw.value) return true
  return a.nick.toLowerCase().includes(kw.value) || a.userId.toLowerCase().includes(kw.value) || (a.title || '').toLowerCase().includes(kw.value)
}
const platAnchors = computed(() => store.anchors.filter((a) => a.platform === plat.value))

// ---- 视图 1 · 在播关注 ----
// 档位顺序与「站内发现」那排同序(人气最高在前, 2026-10-01 用户指令交换两格位置)。
// 默认档与第一格同为「人气最高」(同日改口): 人气为 0 的房间(采集降级时拿得到)自然垫底,
// 刚开播的房在时间那一档仍读得到 —— 首位与默认从此是同一件事, 不再各说各话。
// 点赞/粉丝只有 Panda 列表接口给, 所以 SOOP 只留两档。
const liveSorters = computed<{ key: SortKey; label: string }[]>(() => {
  const base: { key: SortKey; label: string }[] = [
    { key: 'viewers', label: t('ws.sortViewers') },
    { key: 'recent', label: t('ws.sortRecent') }
  ]
  return isSoop.value ? base : [...base, { key: 'likes', label: t('ws.sortLikes') }, { key: 'fans', label: t('ws.sortFans') }]
})
const liveList = computed(() => {
  const items = platAnchors.value.filter((a) => a.isLive && hit(a))
  const s = store.views.live.sortBy
  if (s === 'viewers') return items.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0))
  if (s === 'likes') return items.sort((a, b) => (b.likes || 0) - (a.likes || 0))
  if (s === 'fans') return items.sort((a, b) => (b.fans || 0) - (a.fans || 0))
  return items.sort(
    (a, b) =>
      Number(!a.startTime) - Number(!b.startTime) ||
      String(b.startTime || '').localeCompare(String(a.startTime || '')) ||
      (b.viewerCount || 0) - (a.viewerCount || 0)
  )
})
const liveFiltered = computed(() => (store.views.live.onlyAutoRec ? liveList.value.filter((a) => a.autoRecord) : liveList.value))

// ---- 视图 2 · 站内发现(只有 Panda 给得出整站在播列表; SOOP 一期是引导卡) ----
const discSorters = computed<{ key: SortKey; label: string }[]>(() => {
  const base: { key: SortKey; label: string }[] = [
    { key: 'viewers', label: t('ws.sortViewers') },
    { key: 'recent', label: t('ws.sortRecent') }
  ]
  return [...base, { key: 'likes', label: t('ws.sortLikes') }, { key: 'fans', label: t('ws.sortFans') }]
})
const discList = computed(() => {
  const gf = store.views.discover
  let items = [...store.discovery]
  if (gf.onlyFollowed) items = items.filter((x) => store.isFollowing('pandalive', x.userId))
  if (gf.onlyAdult) items = items.filter((x) => x.isAdult)
  if (gf.onlyFan) items = items.filter((x) => x.type === 'fan')
  if (kw.value) items = items.filter((x) => hit(x))
  const val = (x: { viewers: number; likes: number; fans: number; startTime: string }): number | string =>
    gf.sortBy === 'likes' ? x.likes : gf.sortBy === 'fans' ? x.fans : gf.sortBy === 'recent' ? x.startTime : x.viewers
  return items.sort((a, b) => {
    const av = val(a)
    const bv = val(b)
    return typeof av === 'string' ? String(bv).localeCompare(String(av)) : Number(bv) - Number(av)
  })
})

// ---- 视图 3 · 离线关注(管理视图: 紧凑行 + 未播天数 + 每页 40) ----
/** 距离上次开播的天数; 无开播记录返回 null(排序沉底, 也不被「隐藏 90 天」误伤)。
 *  lastLiveAt 是 KST 钟面串(与 startTime 同格式), 裸解析会按本地时区落点, 必须补 +09:00 */
function daysGone(a: Anchor): number | null {
  if (!a.lastLiveAt) return null
  const t0 = new Date(a.lastLiveAt.replace(' ', 'T') + '+09:00').getTime()
  return Number.isNaN(t0) ? null : Math.max(0, Math.floor((Date.now() - t0) / 86_400_000))
}
const offBase = computed(() => platAnchors.value.filter((a) => !a.isLive && hit(a)))
const offList = computed(() => {
  const gf = store.views.offline
  let items = gf.hideStale ? offBase.value.filter((a) => (daysGone(a) ?? 0) <= 90) : [...offBase.value]
  if (gf.goneOnly) items = items.filter((a) => !!a.siteGone)
  return gf.sortBy === 'stale'
    ? items.sort((a, b) => Number(!b.lastLiveAt) - Number(!a.lastLiveAt) || (daysGone(b) ?? -1) - (daysGone(a) ?? -1))
    : items.sort((a, b) => String(b.lastLiveAt || '').localeCompare(String(a.lastLiveAt || '')) || (b.lastSeenAt || b.addedAt) - (a.lastSeenAt || a.addedAt))
})
/** 被「隐藏 90 天未播」挡掉的条数: 数字摆在 chip 上, 否则用户不知道自己筛掉了多少 */
const staleCount = computed(() => offBase.value.filter((a) => (daysGone(a) ?? 0) > 90).length)
/** 「站内已取关」条数(D3): 只在同步过之后才可能非 0 —— siteGone 未定义的老数据是"未知", 不是"已取关" */
const goneCount = computed(() => offBase.value.filter((a) => a.siteGone).length)

/** 分段标签上的计数: 搜索态即命中数, 所以不会出现「离线显示 6 但其实只匹配 1 个」 */
const viewCounts = computed<Record<WSView, number>>(() => ({
  live: liveFiltered.value.length,
  discover: discList.value.length,
  offline: offList.value.length
}))

// ---- 分页(每视图各一份页码与每页条数) ----
const activeList = computed(() => (view.value === 'live' ? liveFiltered.value : view.value === 'discover' ? discList.value : offList.value))
const pageCount = computed(() => Math.max(1, Math.ceil(activeList.value.length / f.value.pageSize)))
const sliceStart = computed(() => (f.value.page - 1) * f.value.pageSize)
const livePaged = computed(() => (view.value === 'live' ? liveFiltered.value.slice(sliceStart.value, sliceStart.value + f.value.pageSize) : []))
const discPaged = computed(() => (view.value === 'discover' ? discList.value.slice(sliceStart.value, sliceStart.value + f.value.pageSize) : []))
const offPaged = computed(() => (view.value === 'offline' ? offList.value.slice(sliceStart.value, sliceStart.value + f.value.pageSize) : []))

const scrollRef = ref<HTMLElement | null>(null)

watch(
  pageCount,
  (n) => {
    if (f.value.page > n) f.value.page = n
  },
  // 夹紧既服务"离开期间列表收缩"(下播/取关), 也服务切视图后带过来的旧页码
  { immediate: true }
)
// 换搜索词时三视图的页码一起归 1: 命中数变了, 留在第 3 页大概率是空墙
watch(kw, () => {
  for (const v of ['live', 'discover', 'offline'] as WSView[]) store.views[v].page = 1
})

/** 排序/筛选/每页条数改动都落在当前视图那一份状态上, 且立刻回第 1 页 */
function setSort(key: ViewFilter['sortBy']): void {
  f.value.sortBy = key
  f.value.page = 1
}
type BoolKey = 'onlyFollowed' | 'onlyAdult' | 'onlyFan' | 'onlyAutoRec' | 'hideStale' | 'goneOnly'
function toggleFilter(key: BoolKey): void {
  f.value[key] = !f.value[key]
  f.value.page = 1
}
/** 当前视图开着的那些筛子: 空态要按它归因, 更要靠它给出取消出口(见 filterBarVisible)。
 *  标签用不带计数的短形 —— 数字已经摆在 chip 上, 句子里重复一遍只会把句子撑断。 */
const activeFilters = computed<{ key: BoolKey; label: string }[]>(() => {
  const g = f.value
  const on: { key: BoolKey; label: string }[] = []
  if (g.onlyFollowed) on.push({ key: 'onlyFollowed', label: t('ws.onlyFollowed') })
  if (g.onlyAdult) on.push({ key: 'onlyAdult', label: t('ws.onlyAdult') })
  if (g.onlyFan) on.push({ key: 'onlyFan', label: t('ws.onlyFan') })
  if (g.onlyAutoRec) on.push({ key: 'onlyAutoRec', label: t('ws.onlyAutoRec') })
  if (g.hideStale) on.push({ key: 'hideStale', label: t('ws.hideStaleShort') })
  if (g.goneOnly) on.push({ key: 'goneOnly', label: t('ws.goneShort') })
  return on
})
/** 各视图「没筛之前」的条数: 0 条是真的没东西, 大于 0 而筛完是 0 才是筛子的锅。
 *  口径统一为「搜索词已生效、chip 未生效」(liveList / offBase 本来就带 hit): 三视图若各用一套基数,
 *  发现段会把「本来就 0 条」错报成「芯片筛空的」, 用户按了取消筛选仍旧是空墙。 */
const baseCount = computed(() => {
  if (view.value === 'live') return liveList.value.length
  if (view.value === 'discover') return store.discovery.filter((x) => hit(x)).length
  return offBase.value.length
})
/** 筛选条的显示条件不能是筛完的条数: 把列表筛空的那枚 chip 会连同自己一起消失, 用户被锁在空墙里没有出口
 *  (实机: 「只看已关注」把 395 条站内发现筛成 0, chip 从 DOM 里没了, 墙却写「站内暂时没有可展示的在播房间」)。
 *  口径与录制页的库一致(D14e 看的是基数 totalCount, 不是结果)。 */
const filterBarVisible = computed(() => baseCount.value > 0 || activeFilters.value.length > 0)
function clearFilters(): void {
  for (const x of activeFilters.value) f.value[x.key] = false
}
function setPageSize(n: number): void {
  f.value.pageSize = n
  f.value.page = 1
}

function toPage(p: number): void {
  f.value.page = p
  scrollRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}
function onListScroll(e: Event): void {
  f.value.scrollTop = (e.target as HTMLElement).scrollTop
}
// 切视图(含键盘 1/2/3 与前进后退): 存回旧视图的滚动位, 再恢复新视图自己的
// —— 分段方案唯一的成本就是"切回去要回到原位", 这条把它抹平
watch(view, (v, old) => {
  if (old) store.views[old].scrollTop = scrollRef.value?.scrollTop ?? store.views[old].scrollTop
  nextTick(() => {
    if (scrollRef.value) scrollRef.value.scrollTop = store.views[v].scrollTop
  })
})
onMounted(() => {
  nextTick(() => {
    if (scrollRef.value) scrollRef.value.scrollTop = f.value.scrollTop
  })
})

// ---- 键盘: 1/2/3 切视图, / 聚焦搜索(把"逛一圈再切回来"的成本压到接近零) ----
function onKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if (e.key === '1') setView('live')
  else if (e.key === '2') setView('discover')
  else if (e.key === '3') setView('offline')
  else if (e.key === '/') {
    e.preventDefault()
    document.getElementById('global-search')?.focus()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// ---- 页头 ----
const seg = computed(() => {
  const parts = [t('ws.segFollowed', { n: platAnchors.value.length }), t('ws.segLive', { n: platAnchors.value.filter((a) => a.isLive).length })]
  parts.push(isSoop.value ? t('ws.segOffline', { n: platAnchors.value.filter((a) => !a.isLive).length }) : t('ws.segDiscovery', { n: store.discovery.length }))
  // 大厅那一格挂它自己的钟: 全站榜不再搭轮询的车以后, 在这屏说"上轮拉取"是把轮次的计时器借给大厅,
  // 而它可能三分钟没动过 —— 没拉过就不编时间, 反正这一屏的刷新正在飞
  if (view.value === 'discover' && !isSoop.value) {
    if (store.watcher?.discoveryAt) parts.push(t('ws.segHallAt', { time: fmtClock(store.watcher.discoveryAt) }))
    return parts.join(' · ')
  }
  const w = store.watcher?.byPlatform?.[plat.value]
  if (w?.lastRoundAt) parts.push(t('ws.segRoundAt', { time: fmtClock(w.lastRoundAt) }))
  else parts.push(t('ws.segInterval', { sec: store.settings?.monitor?.[plat.value]?.pollIntervalSec ?? '?' }))
  return parts.join(' · ')
})

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 上次开播(KST 钟面串)→ 主播那边的日期 + 本地时区折算后的相对天数; 无记录说「无开播记录」而不是 1970 */
function fmtLastLive(a: Anchor): string {
  if (!a.lastLiveAt) return t('ws.noLiveRecord')
  const [ymd] = a.lastLiveAt.split(' ')
  const parts = ymd.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return t('ws.noLiveRecord')
  const [, mo, d] = parts
  // 用 UTC 构造再取月日: 若按本地时区解析这个 KST 钟面, 跨日界线地区会显示成"前一天"
  const date = locale.value === 'zh-CN' ? `${mo} 月 ${d} 日` : new Date(Date.UTC(2000, mo - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const g = daysGone(a)
  const rel = g == null ? '' : g <= 0 ? t('ws.today') : g === 1 ? t('ws.yesterday') : t('ws.daysAgo', { n: g })
  return rel ? `${t('ws.lastLiveAt', { date })} · ${rel}` : t('ws.lastLiveAt', { date })
}

const refreshing = ref(false)
async function refreshNow(): Promise<void> {
  refreshing.value = true
  try {
    // 按钮刷的是眼前这一屏的数据源: 发现那一屏来自全站榜, 它已不再搭轮询的车,
    // 在这里 nudge 监控轮只会得到一份没变的列表
    if (view.value === 'discover' && !isSoop.value) await api.discoveryRefresh(true)
    else await api.anchorsRefresh(plat.value)
    setTimeout(() => (refreshing.value = false), 2500)
  } catch (e) {
    refreshing.value = false
    message.error(String((e as Error).message || e))
  }
}

// ---- 同步站内关注(只增不删; 反向差值只标注「站内已取关」, 见 D3) ----
const importLoading = ref(false)
const loggedIn = computed(() => (isSoop.value ? !!store.accounts?.soop.realLogin : !!store.accounts?.pandalive.realLogin))
async function syncFollows(): Promise<void> {
  importLoading.value = true
  try {
    const r = isSoop.value ? await api.anchorsImportSoop() : await api.anchorsImportPanda()
    // 差值回执三个数(设计稿 7.2「导入完成」): 只报「已导入 N」用户无法判断有没有漏
    // 取关数是"本次新标注"的增量: 重复同步不会把同一批房间数两遍
    const skipped = Math.max(0, r.total - r.added)
    message.success(r.siteGone
      ? t('monitor.importedGone', { added: r.added, skipped, total: r.total, gone: r.siteGone })
      : t('monitor.imported', { added: r.added, skipped, total: r.total }))
    await store.reloadAnchors()
  } catch (e) {
    message.error((e as Error).message || t('monitor.importFail'))
  } finally {
    importLoading.value = false
  }
}

// ---- 关注主播 / 添加房间: 输入解析与提交都在 AddFollowDialog 里(一个平台一套, 无自动识别档) ----
// 粘错平台的出口要换平台 → 换平台(:plat 是路径参数, 在视图身份里)会整体重挂, 所以原文经 store.addDraft 过境,
// 新实例挂载时看到草稿非空就把对话框撑开(用户不必重粘一遍)。
const showAdd = ref(store.addDraft !== '')
function openAdd(): void {
  showAdd.value = true
}
function gotoOtherPlat(text: string): void {
  store.addDraft = text
  router.replace({ name: 'live', params: { plat: otherPlat.value }, query: { ...route.query } })
}
async function removeAnchor(platform: Platform, userId: string): Promise<void> {
  await api.anchorsRemove(platform, userId)
  await store.reloadAnchors()
  message.success(t('monitor.removed'))
}
async function setAuto(a: Anchor, v: boolean): Promise<void> {
  await api.anchorsSetAuto(a.platform, a.userId, v)
  await store.reloadAnchors()
}

// ---- 空态归因(设计稿 7.2: 每条都要说清为什么空、下一步做什么) ----
/** 发现段为什么空: 未登录 / 匿名受限 / 全站榜还没拉到, 三种空的下一步动作完全不同, 不能共用一句「暂无」 */
const discoverEmpty = computed(() => {
  if (kw.value) return t('ws.emptyKw', { kw: store.searchKeyword.trim() })
  if (isSoop.value) return loggedIn.value ? t('ws.emptyDiscovery') : t('ws.emptyDiscoverAnon')
  if (!loggedIn.value) return t('ws.emptyDiscoverLogin')
  return t('ws.emptyDiscovery')
})
/** 空态的下一步动作: 必须与 listEmpty 同一顺序、同一判据 —— 墙上一句「没有匹配 X」而手里没有清除搜索,
 *  等于让用户自己去顶栏找回那个词(顶栏搜索框没有 ✕)。文案与出口分两处判断就会漂移, 所以合为一处。 */
type EmptyAction = 'clearFilters' | 'clearKw' | 'gotoLogin' | 'firstUse' | null
const emptyAction = computed<EmptyAction>(() => {
  if (activeFilters.value.length && baseCount.value) return 'clearFilters'
  if (view.value === 'discover') {
    if (kw.value) return 'clearKw'
    if (!loggedIn.value) return 'gotoLogin'
    return null
  }
  if (!platAnchors.value.length) return 'firstUse'
  if (kw.value) return 'clearKw'
  return null
})
const listEmpty = computed(() => {
  // 「是筛空的」必须排在其它归因前面: 否则它会顶掉下一步(实机抓到的正是顶替后的那句「站内暂时没有可展示的在播房间」)
  if (activeFilters.value.length && baseCount.value)
    return t('ws.emptyFiltered', { label: activeFilters.value.map((x) => x.label).join(' + '), n: baseCount.value })
  if (view.value === 'discover') return discoverEmpty.value
  if (!platAnchors.value.length) return t('ws.emptyNoFollow')
  if (kw.value) return t('ws.emptyKw', { kw: store.searchKeyword.trim() })
  if (view.value === 'live') return t('ws.emptyLive')
  return t('ws.emptyAllLive')
})

/** 跨平台同名匹配: 顶栏搜索只搜当前工作区, 空出来的那一屏补一行「SOOP 另有 3 个匹配」一键带词跳过去 */
const otherHits = computed(() => (kw.value ? store.anchors.filter((a) => a.platform === otherPlat.value && hit(a)).length : 0))

// 站在在播视图 = 用户已经看到全墙: 新开播标记就地消费掉, 不让竖条长亮
watch(
  [view, plat],
  () => {
    if (view.value === 'live') store.seenLive(plat.value)
    // 全站榜不再搭轮询的车: 只有真的站在「发现」这一屏才发那几页请求, 主进程 60 秒内复用,
    // 所以来回切 tab / 翻页 / 搜索都是零请求
    if (view.value === 'discover' && !isSoop.value) void api.discoveryRefresh().catch(() => undefined)
  },
  { immediate: true }
)
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 页头 -->
    <div class="px-7 pt-5 pb-2.5 shrink-0">
      <div class="flex items-center gap-3">
        <h1 class="page-h">{{ isSoop ? 'SOOPLive' : 'PandaLive' }}</h1>
        <span class="text-[13px] text-ink3 mt-0.5 truncate">{{ seg }}</span>
        <div class="flex-1"></div>
        <n-popconfirm v-if="loggedIn" @positive-click="syncFollows">
          <template #trigger>
            <n-button size="small" quaternary :loading="importLoading">{{ t('ws.syncFollows') }}</n-button>
          </template>
          {{ isSoop ? t('monitor.importConfirmSoop') : t('monitor.importConfirmPanda') }}
        </n-popconfirm>
        <n-button size="small" quaternary :disabled="refreshing" @click="refreshNow">
          <span class="inline-flex items-center justify-center gap-1"><SpinIcon v-if="refreshing" :size="12" />{{ isSoop ? t('ws.detectOnce') : t('ws.pullOnce') }}</span>
        </n-button>
        <n-button size="small" type="primary" @click="openAdd">{{ isSoop ? t('ws.addRoom') : t('monitor.addBtn') }}</n-button>
      </div>

      <!-- 本平台轮询异常正文: 顶栏胶囊只有一枚圆点, 这里给可读归因与下一步 -->
      <div
        v-if="store.watcher?.byPlatform?.[plat]?.message"
        class="mt-2.5 flex items-center gap-1.5 text-[12px]"
        :class="store.watcher.byPlatform[plat].circuitOpen ? 'text-liveink' : 'text-warnink'"
      >
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
        <span class="truncate">{{ store.watcher.byPlatform[plat].message }}</span>
        <!-- 「去登录」跟的是"这一轮需要你去修会话"的两种形状 —— 熔断(整轮被平台拒)与降级(预言机读不通、正逐房兜底)。
             降级轮举的是新旗而不是熔断旗, 只跟 circuitOpen 时用户看得到那句归因, 看不到那条出路 -->
        <button v-if="store.watcher.byPlatform[plat].circuitOpen || store.watcher.byPlatform[plat].degraded" class="text-brand font-medium shrink-0" @click="router.push({ name: 'account' })">{{ t('ws.gotoLogin') }}</button>
      </div>
    </div>

    <!-- 视图分段 -->
    <div class="px-7 pt-3 pb-2 shrink-0 flex items-center gap-1 border-b border-line">
      <button
        v-for="v in (['live', 'discover', 'offline'] as WSView[])"
        :key="v"
        class="h-9 px-3.5 rounded-ctl text-[13px] font-medium transition-colors flex items-center gap-1.5"
        :class="view === v ? 'bg-brand/10 text-brand font-semibold' : 'text-ink2 hover:text-ink1 hover:bg-fill'"
        @click="setView(v)"
      >
        <span v-if="v === 'live'" class="w-[7px] h-[7px] rounded-full" :class="viewCounts.live ? 'bg-live animate-breathe' : 'bg-deco'"></span>
        {{ VIEW_LABELS[v]() }}
        <span v-if="v === 'discover' && isSoop" class="badge badge-sm bg-fill text-ink3">{{ t('ws.soon') }}</span>
        <span v-else class="sec-n">{{ viewCounts[v] }}</span>
      </button>
    </div>

    <!-- 本视图的排序 / 筛选条: 条件看基数与"有没有筛子开着", 不看筛完的条数(见 filterBarVisible 的注释) -->
    <div v-if="filterBarVisible" class="px-7 pt-3 shrink-0 flex items-center gap-x-4 gap-y-2 flex-wrap">
      <template v-if="view === 'live'">
        <button
          v-for="c in liveSorters"
          :key="c.key"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.sortBy === c.key ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="setSort(c.key)"
        >{{ c.label }}</button>
        <button
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.onlyAutoRec ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="toggleFilter('onlyAutoRec')"
        >{{ t('ws.onlyAutoRec') }}</button>
      </template>
      <template v-else-if="view === 'discover' && !isSoop">
        <button
          v-for="c in discSorters"
          :key="c.key"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.sortBy === c.key ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="setSort(c.key)"
        >{{ c.label }}</button>
        <button
          v-for="fl in ([['onlyFollowed', t('ws.onlyFollowed')], ['onlyAdult', t('ws.onlyAdult')], ['onlyFan', t('ws.onlyFan')]] as [BoolKey, string][])"
          :key="fl[0]"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f[fl[0]] ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="toggleFilter(fl[0])"
        >{{ fl[1] }}</button>
      </template>
      <template v-else-if="view === 'offline'">
        <button
          v-for="c in ([['recent', t('ws.sortLastLive')], ['stale', t('ws.sortStale')]] as [ViewFilter['sortBy'], string][])"
          :key="c[0]"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.sortBy === c[0] ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="setSort(c[0])"
        >{{ c[1] }}</button>
        <button
          v-if="staleCount"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.hideStale ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="toggleFilter('hideStale')"
        >{{ t('ws.hideStale', { n: staleCount }) }}</button>
        <button
          v-if="goneCount"
          class="text-[13px] pb-0.5 border-b-2 transition-all shrink-0"
          :class="f.goneOnly ? 'text-brand font-semibold border-brand' : 'text-ink2 border-transparent hover:text-ink1'"
          @click="toggleFilter('goneOnly')"
        >{{ t('ws.goneChip', { n: goneCount }) }}</button>
      </template>
      <!-- 右端只在真有搜索词时出声: 「排序与页码在本视图内记忆」那句常驻说明已撤(2026-10-01),
           没有可推的东西就别摆 flex-1 -->
      <template v-if="kw">
        <div class="flex-1"></div>
        <span class="text-[12px] text-ink3 shrink-0">{{ t('ws.searchResult', { kw: store.searchKeyword.trim() }) }}</span>
      </template>
    </div>

    <!-- 正文区(只换这一块: 顶栏 / 分段完全不动) -->
    <div ref="scrollRef" class="flex-1 min-h-0 overflow-y-auto px-7 py-4" @scroll.passive="onListScroll">
      <!-- SOOP 的发现段: 有段头、有引导, 不留空墙(设计稿 D2 方案 1) -->
      <div v-if="view === 'discover' && isSoop" class="max-w-[560px] mx-auto mt-8 rounded-card border border-line bg-card shadow-card p-6">
        <div class="text-[15px] font-bold text-ink1">{{ t('ws.soonTitle') }}</div>
        <p class="mt-2 text-[12.5px] text-ink2 leading-relaxed">{{ t('ws.soonBody') }}</p>
        <div class="mt-4 flex gap-2">
          <n-button size="small" secondary @click="setView('live')">{{ t('ws.gotoLiveView') }}</n-button>
          <n-button size="small" secondary @click="openAdd">{{ t('ws.addRoom') }}</n-button>
          <n-button size="small" secondary @click="router.push({ name: 'live', params: { plat: otherPlat }, query: { view: 'discover' } })">
            {{ t('ws.gotoOtherDiscover') }}
          </n-button>
        </div>
      </div>

      <!-- 在播关注 -->
      <div v-else-if="view === 'live' && livePaged.length" class="card-grid pb-3">
        <AnchorCard v-for="a in livePaged" :key="roomKey(a.platform, a.userId)" :anchor="a" :show-platform="false" @remove="removeAnchor" />
      </div>

      <!-- 站内发现 -->
      <div v-else-if="view === 'discover' && discPaged.length" class="card-grid pb-3">
        <ExploreCard v-for="x in discPaged" :key="x.userId" :item="x" />
      </div>

      <!-- 离线关注: 紧凑行(信息密度必须高于卡片墙, 否则 42 个关注要滚四屏) -->
      <div v-else-if="view === 'offline' && offPaged.length" class="flex flex-col gap-1.5 pb-3">
        <div
          v-for="a in offPaged"
          :key="roomKey(a.platform, a.userId)"
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-ctl bg-card border border-line hover:shadow-card transition-shadow"
        >
          <AvatarImg :src="a.userImg" lazy class="w-8 h-8 rounded-full object-cover grayscale-[0.4] shrink-0">
            <div class="w-8 h-8 rounded-full bg-fill grid place-items-center text-[12px] font-bold text-deco shrink-0">{{ a.nick.slice(0, 1) }}</div>
          </AvatarImg>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold text-ink1 truncate">{{ a.nick }}</div>
            <div class="text-[11.5px] text-ink3 truncate">
              {{ isSoop ? a.userId : '@' + a.userId }} · {{ fmtLastLive(a) }}
              <span v-if="(daysGone(a) ?? 0) > 90" class="text-warnink">· {{ t('ws.staleTag') }}</span>
              <span v-if="a.siteGone" class="text-warnink">· {{ t('ws.goneTag') }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0" :title="t('monitor.autoRecTitle')">
            <span class="text-[11px] text-ink3">{{ t('ws.autoRecShort') }}</span>
            <n-switch size="small" :value="a.autoRecord" @update:value="(v: boolean) => setAuto(a, v)" />
          </div>
          <button class="w-7 h-7 rounded-ctl grid place-items-center text-ink3 hover:text-liveink hover:bg-live/10 transition-colors shrink-0" :title="t('card.unfollow')" @click="removeAnchor(a.platform, a.userId)">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>

      <!-- 空态: 有界虚线卡(与「库」「进行中」同一规格)。原来是 h-full 整屏垂直居中 —— 一屏只剩中间一行小字,
           看起来像界面坏了, 而不是「这一栏暂时没东西」 -->
      <div v-else class="rounded-card border border-dashed border-line bg-card/40 py-16 grid place-items-center">
        <n-empty :description="listEmpty" class="text-ink3">
          <template #extra>
            <!-- 出口由 emptyAction 单独决定(与墙上那句同一判据): 筛空的墙只有一条下一步「取消筛选」,
                 此时不再并列「去登录 / 加房间」—— 它们不是这个现场缺的东西; 反之有词无命中必给「清除搜索」 -->
            <div v-if="emptyAction" class="flex gap-2 justify-center mt-2">
              <template v-if="emptyAction === 'clearFilters'">
                <n-button size="small" type="primary" @click="clearFilters">{{ t('ws.clearFilters') }}</n-button>
              </template>
              <template v-else-if="emptyAction === 'clearKw'">
                <n-button size="small" secondary @click="store.searchKeyword = ''">{{ t('ws.clearKw') }}</n-button>
              </template>
              <template v-else-if="emptyAction === 'gotoLogin'">
                <n-button size="small" type="primary" @click="router.push({ name: 'account', query: { plat } })">{{ t('ws.gotoLogin') }}</n-button>
              </template>
              <template v-else>
                <n-button size="small" type="primary" @click="openAdd">{{ isSoop ? t('ws.addRoom') : t('monitor.addBtn') }}</n-button>
                <n-button v-if="!isSoop" size="small" secondary @click="setView('discover')">{{ t('ws.gotoDiscoverView') }}</n-button>
              </template>
            </div>
          </template>
        </n-empty>
      </div>

      <!-- 跨平台匹配行: 有词就常驻结果区末尾(设计稿 7.2「跨平台搜索」) —— 只在空态才出现等于一半时候不告诉用户对面还有 -->
      <button v-if="kw && otherHits" class="shrink-0 px-7 pb-3 -mt-1 text-left text-[12px] text-brand hover:underline" @click="router.push({ name: 'live', params: { plat: otherPlat }, query: { view } })">
        {{ t('ws.otherHits', { plat: platformName(otherPlat), n: otherHits }) }}
      </button>
    </div>

    <!-- 分页栏(有数据即常驻) -->
    <div v-if="activeList.length" class="shrink-0 px-7 py-3 flex items-center gap-3 bg-card border-t border-line">
      <span class="text-[12px] text-ink3">{{ t('ws.pageInfo', { label: VIEW_LABELS[view](), n: activeList.length, size: f.pageSize }) }}</span>
      <n-popselect
        v-if="view === 'offline'"
        :value="f.pageSize"
        :options="[
          { label: '20', value: 20 },
          { label: '40', value: 40 },
          { label: '60', value: 60 }
        ]"
        @update:value="setPageSize"
      >
        <button class="text-[12px] text-ink2 hover:text-brand transition-colors">{{ t('ws.perPage', { n: f.pageSize }) }} ▾</button>
      </n-popselect>
      <div class="flex-1"></div>
      <n-pagination :page="f.page" :page-count="pageCount" size="small" @update:page="toPage" />
    </div>

    <!-- 关注主播 / 添加房间: 平台由所在工作区决定, 对话框内不再摆平台分段 -->
    <AddFollowDialog v-model:show="showAdd" :platform="plat" @added="store.reloadAnchors()" @goto-other="gotoOtherPlat" />
  </div>
</template>
