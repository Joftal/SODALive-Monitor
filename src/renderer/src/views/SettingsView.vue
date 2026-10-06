<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { api } from '@/api'
import type { AppInfo, MonitorRules, NotifyEvent, NotifyRow, Platform, Settings, UpdateCheckResult } from '@shared/types'
import { platformName, REC_RETRY_MAX } from '@shared/types'
import SpinIcon from '@/components/SpinIcon.vue'
import Seg from '@/components/Seg.vue'
import { fmtRoundCost } from '@/utils/media'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

/** 代理示例: 网络节与 TG 专用代理两处占位符必须同值, 写两遍就会各改各的 */
const PROXY_PH = 'http://127.0.0.1:7890'

const store = useAppStore()
const router = useRouter()
const route = useRoute()
const message = useMessage()
const form = ref<Settings | null>(null)
/** 进页快照。脏判定跟这份比, 不跟 store.settings 比 —— 后者会被别的写入方(账号页、
 *  保存回来的投影)刷新, 拿它当基线等于把「别人刚改的」读成「你没保存的」,
 *  一按保存就把对方的新值回滚成进页时的旧值。
 *  必须声明在首个 setForm 调用(immediate watch)之前: setup 里 TDZ 抛错 = 整页白屏。 */
const baseline = ref<Settings | null>(null)
const saving = ref(false)
const dataDir = ref('')

// ---- 关于 / 检查更新 ----
const info = ref<AppInfo | null>(null)
const checking = ref(false)
const upd = ref<UpdateCheckResult | null>(null)

onMounted(async () => {
  dataDir.value = await api.appDataDir()
  info.value = await api.appInfo()
})

async function doCheckUpdate() {
  if (checking.value) return
  checking.value = true
  upd.value = null
  try {
    upd.value = await api.checkUpdate()
  } finally {
    checking.value = false
  }
}
function openRepo() {
  if (info.value) void api.openExternal(info.value.repo)
}
function openRelease() {
  if (upd.value?.url) void api.openExternal(upd.value.url)
}

/** 关于节的身份数据一律来自 appInfo(IPC) —— 此前作者名/仓库 slug/日志路径都写死在模板里,
 *  换作者、换仓库名、mac 下跑一份都会显示错的值 */
const avatarUrl = computed(() => (info.value ? `${info.value.authorUrl}.png` : ''))
const repoSlug = computed(() => (info.value?.repo || '').replace(/^https?:\/\/[^/]+\//, ''))

/** 上轮时刻按应用语言显示: 裸 toLocaleTimeString() 跟的是宿主系统区域, 与界面语言可以不一致 */
function roundTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const defaultRecPath = computed(() => {
  if (!dataDir.value) return '…'
  return dataDir.value.replace(/[/\\]data$/, '/recording')
})

watch(
  () => store.settings,
  (s) => {
    if (s && !form.value) setForm(s)
  },
  { immediate: true }
)

/** form 与基线各拿一份独立深拷贝: 共用一份的话改一格就等于改了基线, 保存按钮永远点不动 */
function setForm(src: Settings): void {
  form.value = clone(src)
  baseline.value = clone(src)
}

// 主进程投影字段: 真值在 secrets 保险箱, 不参与脏比对, 也不进保存补丁
// (tgTokenSet 会被 tgSaveToken 外科式同步, 但 secretsEncrypted 没有同步点 —— 若计入,
//  密钥环恢复加密后这一格永远脏, 用户看不出哪里没保存)
const PROJECTED_KEYS: (keyof Settings)[] = ['tgTokenSet', 'secretsEncrypted']

/** 逐键脏清单: 保存只提交这些键, 导航点也只按这些键亮 */
const dirtyKeys = computed<Set<string>>(() => {
  const out = new Set<string>()
  const f = form.value
  const cur = baseline.value
  if (!f || !cur) return out
  for (const k of Object.keys(f) as (keyof Settings)[]) {
    if (PROJECTED_KEYS.includes(k)) continue
    if (JSON.stringify(f[k]) !== JSON.stringify(cur[k])) out.add(k)
  }
  return out
})

// 未保存脏标记。
// Token 草稿必须计入: 它走独立通道(不进 form/settings 投影), 只看 form 比对会让
// "只填了 token"这一种最常见的保存动作永远点不动 —— 用户只能靠"测试"按钮顺手持久化
const dirty = computed(() => dirtyKeys.value.size > 0 || tgTokenDraft.value.trim() !== '')

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}

/** 分段时长的 0 是「不分段」这一档, 不是越界值: 夹取只作用于非 0(清空/NaN 回默认 900, 小数抬到 60) */
function clampSplit(v: unknown): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? v : 900
  return n === 0 ? 0 : Math.min(7200, Math.max(60, n))
}

/** 一格监控节奏: 上下界与入站闸门的 MONITOR_RANGE、控件的 min/max 同口径。
 *  分家前这两个夹取写在顶层键上, 平台各一格后逐格过一遍, 不然清空的那格会把 null 提交上去 */
function clampMonitor(m: MonitorRules): MonitorRules {
  return {
    pollIntervalSec: clampNum(m.pollIntervalSec, 5, 600, 30),
    requestGapMs: clampNum(m.requestGapMs, 300, 10000, 1200),
    prefetchStream: m.prefetchStream
  }
}

async function pickDir() {
  const d = await api.settingsSelectDir()
  if (d && form.value) form.value.savePath = d
}

async function openDataDir() {
  await api.recOpenFolder(dataDir.value)
}

async function openLogsDir() {
  await api.openLogs()
}

async function save() {
  if (!form.value) return
  saving.value = true
  try {
    // 先深拷贝脱 Proxy: IPC 载荷走 structured clone, 而浅展开({...form})会让 notify 矩阵与
    // autoRecordDefault 仍是 Pinia 响应式代理 —— 整个补丁被主进程拒收, 结果是
    // 「除主题/语言外全都存不下去」(那两个键走单键即时通道, 所以从未暴露)。
    // 清洗: NInputNumber 清空为 null / 非法值时回退默认, 并夹紧到安全区间
    const f = clone(form.value)
    const clean: Settings = {
      ...f,
      proxyUrl: (f.proxyUrl || '').trim(),
      tgChatId: (f.tgChatId || '').trim(),
      tgProxy: (f.tgProxy || '').trim(),
      monitor: { pandalive: clampMonitor(f.monitor.pandalive), soop: clampMonitor(f.monitor.soop) },
      splitSeconds: clampSplit(f.splitSeconds),
      diskLimitGb: clampNum(f.diskLimitGb, 0.5, 100, 1)
    }
    // 只提交真改过的键(带投影键已由 dirtyKeys 排除): 全量提交等于拿这份快照
    // 覆盖另一个写入方(轮询/账号页)在编辑期间刚落的新值
    const patch: Record<string, unknown> = {}
    for (const k of dirtyKeys.value) patch[k] = clean[k as keyof Settings]
    if (Object.keys(patch).length) await store.patchSettings(patch as Partial<Settings>)
    // Token 单独通道: 非空草稿才落保险箱(空草稿=未改动, 清除走「清除」按钮)
    if (tgTokenDraft.value.trim()) {
      await tgSaveToken(tgTokenDraft.value.trim())
      tgTokenDraft.value = ''
    }
    // 脏标记按 JSON 键序比对, 手工重组 form 键序必翻车 —— 一律从持久化投影回拷
    if (store.settings) setForm(store.settings)
    message.success(t('settings.saved'))
  } catch (e) {
    // 拒绝必须出声: 此前只有 try/finally, 保存失败被吞成「点了没反应」, 脏标记也永远不清
    message.error(t('settings.saveFail', { msg: String((e as Error).message || e) }))
  } finally {
    saving.value = false
  }
}

// ---- Telegram ----
const tgTokenDraft = ref('')

/** token 专用通道: 主进程回传含最新 tgTokenSet 的设置投影, 直接刷 store;
 *  form 只外科式同步这一个键(整体回拷会吞掉用户其他未保存编辑) */
async function tgSaveToken(token: string): Promise<void> {
  store.settings = await api.telegramSetToken(token)
  if (!form.value || !store.settings) return
  // 两枚投影键一起回拷: 界面按它们显示"已保存/降级明文"。secretsEncrypted 此前没有同步点,
  // 密钥环恢复加密后那一格永远停在旧值(它已从脏比对里排除, 不会因此变脏)
  form.value.tgTokenSet = store.settings.tgTokenSet
  form.value.secretsEncrypted = store.settings.secretsEncrypted
}

// 一次性动作: 不设按钮 loading 态(结果经 message 气泡回报; 主进程侧有 15s 超时护栏兜底)
function tgTest() {
  if (!form.value) return
  const token = tgTokenDraft.value.trim()
  const chatId = (form.value.tgChatId || '').trim()
  if (!token && !form.value.tgTokenSet) {
    message.warning(t('settings.tgNeedToken'))
    return
  }
  if (!chatId) {
    message.warning(t('settings.tgNeedChatId'))
    return
  }
  void api
    .telegramTest(token, chatId)
    .then(async (r) => {
      if (r.ok) {
        message.success(r.message)
        // 测试时输入的新 token 顺手持久化, 免得"测通了但没保存"
        if (token) {
          await tgSaveToken(token)
          tgTokenDraft.value = ''
        }
      } else {
        message.error(r.message)
      }
    })
    .catch(() => message.error(t('settings.tgFail')))
}

async function tgClearToken() {
  await tgSaveToken('')
  tgTokenDraft.value = ''
}

function resetForm(): void {
  if (store.settings) setForm(store.settings)
}

/** 主题特殊通道: 点按即切换并立即持久化(不走"保存设置"批处理), 与页内文案"立即生效"一致 */
async function applyTheme(v: 'light' | 'dark') {
  if (!form.value || form.value.theme === v) return
  form.value.theme = v
  await store.patchSettings({ theme: v })
  // 已经单独落盘的键必须同步基线: 不然它明明存下去了, 吸底条却永远挂着「1 项未保存」
  if (baseline.value) baseline.value.theme = v
  message.success(v === 'dark' ? t('settings.switchedDark') : t('settings.switchedLight'))
}

/** 语言特殊通道: 同主题, 立即生效并持久化 */
async function applyLocale(v: string | number | boolean) {
  const l = String(v) as Settings['locale']
  if (!form.value || form.value.locale === l) return
  form.value.locale = l
  await store.patchSettings({ locale: l })
  if (baseline.value) baseline.value.locale = l
  message.success(t('settings.switchedLang'))
}

/** 头像加载失败(离线等)时静默隐藏, 保留纯渐变横幅 */
function hideBrokenImg(e: Event): void {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

// ---- 左侧锚点导航(手动 scrollspy) ----
// 三域: 全局 / 平台(Panda、SOOP) / 关于。平台专属键(检测模式、源保活、自录默认、通知行、
// 监控节奏)只出现在平台节里 —— 混在全局节里时, 改一个 SOOP 的开关要在一屏全局项里找平台徽标
// (「监控」节随三格分家撤销, 全局节里没有节奏可配了, 启动落点并入外观)
type NavKey =
  | 'appearance'
  | 'record'
  | 'network'
  | 'push'
  | 'storage'
  | 'panda'
  | 'soop'
  | 'about'
const navGroups = computed<{ label: string; items: { key: NavKey; label: string }[] }[]>(() => [
  {
    label: t('settings.navGroupGlobal'),
    items: [
      { key: 'appearance', label: t('settings.navAppearance') },
      { key: 'record', label: t('settings.navRecord') },
      { key: 'network', label: t('settings.navNetwork') },
      { key: 'push', label: t('settings.navNotify') },
      { key: 'storage', label: t('settings.navStorage') }
    ]
  },
  {
    label: t('settings.navGroupPlat'),
    items: [
      { key: 'panda', label: platformName('pandalive') },
      { key: 'soop', label: platformName('soop') }
    ]
  },
  { label: '', items: [{ key: 'about', label: t('settings.navAbout') }] }
])
const navs = computed(() => navGroups.value.flatMap((g) => g.items))

const scrollRef = ref<HTMLElement | null>(null)
const activeNav = ref<NavKey>('appearance')

/** 设置键 → 所在节: 脏标记只写在吸底条上等于让人逐屏找, 亮的应该是「哪一屏有没保存的项」。
 *  跨平台的三个键(autoRecordDefault / notify / monitor)不在这张表里: 它们一节一半,
 *  只改 SOOP 那一半时亮 Panda 的点就是谎报 —— 见 dirtySecs 的逐平台比对 */
const SEC_OF_KEY: Partial<Record<keyof Settings, NavKey>> = {
  theme: 'appearance',
  locale: 'appearance',
  defaultWorkspace: 'appearance',
  savePath: 'record',
  splitSeconds: 'record',
  diskLimitGb: 'record',
  autoMp4: 'record',
  deleteTs: 'record',
  mergeMp4: 'record',
  mergeDeleteSegments: 'record',
  autoRetryRecord: 'record',
  proxyUrl: 'network',
  closeToTray: 'push',
  tgChatId: 'push',
  tgProxy: 'push',
  watchMode: 'panda',
  keepaliveStream: 'panda'
}

const dirtySecs = computed<Set<NavKey>>(() => {
  const out = new Set<NavKey>()
  const f = form.value
  const b = baseline.value
  for (const k of dirtyKeys.value) {
    if (k === 'autoRecordDefault' || k === 'notify' || k === 'monitor') {
      if (!f || !b) continue
      for (const p of PLATS) {
        if (JSON.stringify(f[k][p]) !== JSON.stringify(b[k][p])) out.add(p === 'pandalive' ? 'panda' : 'soop')
      }
      continue
    }
    const sec = SEC_OF_KEY[k as keyof Settings]
    if (sec) out.add(sec)
  }
  // Token 草稿属推送节
  if (tgTokenDraft.value.trim()) out.add('push')
  return out
})

function scrollToSec(key: NavKey): void {
  activeNav.value = key
  scrollRef.value
    ?.querySelector(`[data-sec="${key}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 深链落位(?sec=record): 录制页那枚按钮写着「录制设置」, 把人放到设置页第一屏(外观)就是没兑现。
 *  挂载即滚不可靠 —— 整页在 v-if="form" 里, settings 未到则容器还不存在, 所以挂在 scrollRef 上。
 * 复核补: 视图身份去掉 query 后, 已在设置页时再换 ?sec= 不会重挂(实测滚位不动),
 *  所以这个 watch 必须同时盯 route.query.sec —— 两个源任一动一下就重新落位 */
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
  let cur: NavKey = 'appearance'
  for (const n of navs.value) {
    const el = box.querySelector(`[data-sec="${n.key}"]`)
    if (el && el.getBoundingClientRect().top - boxTop <= 96) cur = n.key
  }
  activeNav.value = cur
}

// 开关磁贴公共样式(label+desc 左, NSwitch 右; 无边框, 浅填充)
// 磁贴刻意保持 div 而不是 button: 里面已经嵌了一个 n-switch, button 套可交互控件会让
// Tab 停在壳上进不去开关。所以可操作身份由 role=switch + tabindex + Space/Enter 三件补齐
const tileCls =
  'flex items-center gap-2.5 w-full text-left rounded-ctl px-3 py-2.5 cursor-pointer transition-colors bg-fill hover:bg-fillh'

/** 磁贴里能被翻的顶层布尔项。全部是 Settings 顶层 boolean, 所以一次成型而不是一堆专用 handler
 * (开播预取不在这张表里: 之后它住在 monitor[平台] 那一格, 见 monTileClick) */
type BoolKey =
  | 'keepaliveStream'
  | 'autoMp4'
  | 'deleteTs'
  | 'mergeMp4'
  | 'mergeDeleteSegments'
  | 'autoRetryRecord'
  | 'closeToTray'

/** 整块磁贴即命中区(设计稿 3.4: 40px 的开关不该是唯一能点中的地方)。
 *  点开关本身会冒泡到这里 —— 不排除就是"开关翻一次 + 这里再翻一次", 表现为点了没反应 */
function tileClick(e: MouseEvent, key: BoolKey): void {
  if ((e.target as HTMLElement | null)?.closest('.n-switch')) return
  const f = form.value
  if (f) f[key] = !f[key]
}

/** 键盘侧的命中区: 整块磁贴是 div, 鼠标能点不等于键盘能翻 —— role=switch + tabindex 还得配 Space/Enter */
function tileKey(key: BoolKey): void {
  const f = form.value
  if (f) f[key] = !f[key]
}

/** 开播预取按平台各一格: 顶层那张 BoolKey 表够不到嵌套格, 命中规则照抄一遍 */
function monTileClick(e: MouseEvent, p: Platform): void {
  if ((e.target as HTMLElement | null)?.closest('.n-switch')) return
  const f = form.value
  if (f) f.monitor[p].prefetchStream = !f.monitor[p].prefetchStream
}
function monTileKey(p: Platform): void {
  const f = form.value
  if (f) f.monitor[p].prefetchStream = !f.monitor[p].prefetchStream
}

// ---- 嵌套设置的深拷贝 ----
// form 必须是深拷贝: 浅拷贝({...s})会让 notify 矩阵与 store 里那份持久化对象共用引用,
// 于是"改一格"直接改到了已保存态上 —— 脏标记比对相等, 保存按钮永远点不动。
// toRaw 不是保险丝而是必需: store.settings 是 Pinia 的响应式代理, structuredClone 吃代理会
// 抛 DataCloneError, 而它发生在 setup 的 immediate watch 里 —— 整个设置页直接白屏。
function clone(s: Settings): Settings {
  return structuredClone(toRaw(s))
}

// ---- 通知矩阵(D4): 平台 × 事件 × 通道 ----
const PLATS: Platform[] = ['pandalive', 'soop']
const notifyEvents = computed<{ key: NotifyEvent; label: string; desc: string }[]>(() => [
  { key: 'live', label: t('settings.nmLive'), desc: t('settings.nmLiveD') },
  { key: 'offline', label: t('settings.nmOffline'), desc: t('settings.nmOfflineD') },
  { key: 'record', label: t('settings.nmRecord'), desc: t('settings.nmRecordD') },
  { key: 'alert', label: t('settings.nmAlert'), desc: t('settings.nmAlertD') }
])

/** 「已单独覆盖 N 位」: 自录默认值只管新关注, 存量主播以观感为准给个数量提示 */
function autoRecOverrides(p: Platform): number {
  const f = form.value
  if (!f) return 0
  return store.anchors.filter((a) => a.platform === p && a.autoRecord !== f.autoRecordDefault[p]).length
}

/** 矩阵单元格写入。模板内联 `form.notify[p][e.key].x = v` 会丢掉 form 的窄化,
 *  且 live 行是 NotifyLiveRow(多一个 sound)与其余 NotifyRow 的联合 —— 收敛到这里一次成型 */
function setNotify(p: Platform, e: NotifyEvent, ch: 'system' | 'telegram', v: boolean): void {
  const row = form.value?.notify[p][e]
  if (row) (row as NotifyRow)[ch] = v
}

/** 单平台整块开/关(声音列不动: 它只在开播行存在, 且「全部关闭」的诉求就是不响)。
 *  矩阵按平台拆到各自节后, 整块按钮也跟着按平台走 —— 静音 SOOP 不该连 Panda 一起哑 */
function setNotifyAll(p: Platform, v: boolean): void {
  const f = form.value
  if (!f) return
  for (const e of ['live', 'offline', 'record', 'alert'] as NotifyEvent[]) {
    const row = f.notify[p][e] as NotifyRow
    row.system = v
    row.telegram = v
  }
}

// SOOP 采集节是"读状态不给开关"(设计稿 S6 判据): 这里只取本平台轮询态与登录态
const soopStatus = computed(() => store.watcher?.byPlatform?.soop ?? null)
const soopAccount = computed(() => store.accounts?.soop ?? null)
</script>

<template>
  <div class="h-full flex flex-col" v-if="form">
    <!-- 页头 -->
    <div class="px-7 pt-5 pb-4 shrink-0 flex items-center gap-3">
      <div>
        <h1 class="page-h">{{ t('settings.title') }}</h1>
        <div class="text-[12px] text-ink3 mt-0.5">{{ t('settings.sub') }}</div>
      </div>
      <span
        v-if="dirty"
        class="ml-auto shrink-0 badge badge-md bg-warn/[0.14] text-warnink"
      >{{ t('settings.dirtyChip') }}</span>
    </div>

    <!-- 主体: 左导航 + 右滚动区 -->
    <div class="flex-1 min-h-0 flex px-7 gap-5 pb-4">
      <nav class="w-[200px] shrink-0 pt-0.5">
        <template v-for="(g, gi) in navGroups" :key="gi">
          <div v-if="g.label" class="px-3 text-[10.5px] text-ink3 tracking-wide" :class="gi === 0 ? 'pb-1' : 'mt-3.5 pb-1'">{{ g.label }}</div>
          <button
            v-for="n in g.items"
            :key="n.key"
            class="flex items-center gap-2.5 w-full px-3 py-2 rounded-ctl text-[13px] transition-colors text-left"
            :class="activeNav === n.key
              ? 'bg-card text-ink1 font-semibold shadow-card'
              : 'text-ink2 hover:text-ink1 hover:bg-fillh'"
            @click="scrollToSec(n.key)"
          >
          <svg v-if="n.key === 'record'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>
          <svg v-else-if="n.key === 'network'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>
          <svg v-else-if="n.key === 'push'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1"/></svg>
          <svg v-else-if="n.key === 'panda' || n.key === 'soop'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7 4v5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V7l7-4z"/></svg>
          <svg v-else-if="n.key === 'storage'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="8" ry="3"/><path stroke-linecap="round" d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
          <svg v-else class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 16v-5m0-3.5h.01"/></svg>
          <span class="flex-1 min-w-0 truncate">{{ n.label }}</span>
          <!-- 脏点位在导航上: 吸底条说"有 3 项没保存"却不说在哪一屏, 人就得逐屏找 -->
          <i
            v-if="dirtySecs.has(n.key)"
            class="w-1.5 h-1.5 rounded-full bg-warnink shrink-0"
            :title="t('settings.dirtyHere')"
          ></i>
          </button>
        </template>
        <div class="mt-3.5 px-3 text-[11px] text-ink3 tabular-nums">SODALive Monitor v{{ info?.version || '…' }}</div>
      </nav>

      <!-- 内容滚动区 -->
      <div ref="scrollRef" class="flex-1 min-w-0 overflow-y-auto pb-1" @scroll="onScroll">
        <!-- 外观 -->
        <section data-sec="appearance" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.appearance') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.appearanceDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3">
              <button
                type="button"
                class="flex items-center gap-2.5 rounded-ctl px-3 py-2.5 cursor-pointer transition-colors text-left"
                :class="form.theme === 'light' ? 'bg-fill' : 'hover:bg-fill'"
                @click="applyTheme('light')"
              >
                <svg class="w-4 h-4 shrink-0" :class="form.theme === 'light' ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.lightTheme') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.lightDesc') }}</div>
                </div>
                <!-- 选中态归 brand(订正①: 红色退出「选中」语义)。实心红底白勾在浅色下只有 3.91:1,
                     而深色主题 brand 提亮到 #7fa6e0 后实心底白字更不行 —— 淡底 + brand 勾是两主题都达标的写法 -->
                <span
                  class="w-[18px] h-[18px] rounded-full grid place-items-center shrink-0"
                  :class="form.theme === 'light' ? 'bg-brand/[0.14] ring-1 ring-inset ring-brand/45' : 'border border-line/60'"
                >
                  <svg v-if="form.theme === 'light'" class="w-2.5 h-2.5 text-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                </span>
              </button>
              <button
                type="button"
                class="flex items-center gap-2.5 rounded-ctl px-3 py-2.5 cursor-pointer transition-colors text-left"
                :class="form.theme === 'dark' ? 'bg-fill' : 'hover:bg-fill'"
                @click="applyTheme('dark')"
              >
                <svg class="w-4 h-4 shrink-0" :class="form.theme === 'dark' ? 'text-brand' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.darkTheme') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.darkDesc') }}</div>
                </div>
                <span
                  class="w-[18px] h-[18px] rounded-full grid place-items-center shrink-0"
                  :class="form.theme === 'dark' ? 'bg-brand/[0.14] ring-1 ring-inset ring-brand/45' : 'border border-line/60'"
                >
                  <svg v-if="form.theme === 'dark'" class="w-2.5 h-2.5 text-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                </span>
              </button>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 pb-3 border-t border-line/40 pt-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.language') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.langDesc') }}</div>
              </div>
              <Seg
                :model-value="form.locale"
                :options="[
                  { value: 'zh-CN', label: t('settings.langZh') },
                  { value: 'en-US', label: t('settings.langEn') }
                ]"
                @update:model-value="applyLocale"
              />
            </div>
            <!-- 「监控」节撤了(三格分家进各自平台节), 只剩这一格讲"开哪页"—— 它是启动落点, 归外观 -->
            <div class="flex items-center justify-between gap-4 px-4 pb-3 border-t border-line/40 pt-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.defaultWs') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.defaultWsD') }}</div>
              </div>
              <!-- 平台称呼走 platformName()(与 PlatTag 同一出口), 不在模板里手打裸字:
                   手打的 "Panda"/"SOOP" 与组件文案漂移时没人会发现(全站身份词只允许一处定义) -->
              <Seg
                v-model="form.defaultWorkspace"
                :options="[
                  { value: 'remember', label: t('settings.wsRemember') },
                  { value: 'pandalive', label: platformName('pandalive') },
                  { value: 'soop', label: platformName('soop') }
                ]"
              />
            </div>
          </div>
        </section>

        <!-- 录制 -->
        <section data-sec="record" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.record') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.recordDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.saveDir') }}</div>
                <div class="text-[11px] text-ink3 mt-0.5 truncate font-mono">{{ form.savePath || defaultRecPath }}</div>
                <div class="text-[10.5px] text-ink3/75 mt-0.5">{{ t('settings.saveDirLayout') }}</div>
              </div>
              <n-button size="small" secondary @click="pickDir">{{ t('settings.pickDir') }}</n-button>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.splitSec') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.splitSecDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.splitSeconds" :min="0" :max="7200" :step="60" size="small" class="!w-28" />
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.diskLimit') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.diskLimitDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.diskLimitGb" :min="0.5" :max="100" :step="0.5" size="small" class="!w-28" />
            </div>

            <div class="px-4 pt-3.5 pb-1 grp-h border-t border-line/40">{{ t('settings.outProc') }}</div>
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3">
              <div :class="tileCls" role="switch" :aria-checked="form.autoMp4" tabindex="0" @click="tileClick($event, 'autoMp4')" @keydown.space.prevent="tileKey('autoMp4')" @keydown.enter="tileKey('autoMp4')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.autoMp4') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.autoMp4D') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.autoMp4" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4" role="switch" :aria-checked="form.deleteTs" tabindex="0" @click="tileClick($event, 'deleteTs')" @keydown.space.prevent="tileKey('deleteTs')" @keydown.enter="tileKey('deleteTs')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.deleteTs') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.deleteTsD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.deleteTs" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4 && form.splitSeconds !== 0" role="switch" :aria-checked="form.mergeMp4" tabindex="0" @click="tileClick($event, 'mergeMp4')" @keydown.space.prevent="tileKey('mergeMp4')" @keydown.enter="tileKey('mergeMp4')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.mergeMp4') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.mergeMp4D') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.mergeMp4" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4 && form.mergeMp4 && form.splitSeconds !== 0" role="switch" :aria-checked="form.mergeDeleteSegments" tabindex="0" @click="tileClick($event, 'mergeDeleteSegments')" @keydown.space.prevent="tileKey('mergeDeleteSegments')" @keydown.enter="tileKey('mergeDeleteSegments')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.mergeDel') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.mergeDelD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.mergeDeleteSegments" />
              </div>
            </div>

            <!-- 自动化: 开播自录默认值是按平台分的, 已移到各平台节 -->
            <div class="px-4 pt-3.5 pb-1 grp-h border-t border-line/40">{{ t('settings.automation') }}</div>
            <div class="grid grid-cols-1 gap-2.5 px-4 py-3">
              <div :class="tileCls" role="switch" :aria-checked="form.autoRetryRecord" tabindex="0" @click="tileClick($event, 'autoRetryRecord')" @keydown.space.prevent="tileKey('autoRetryRecord')" @keydown.enter="tileKey('autoRetryRecord')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.autoRetry') }}</div>
                  <!-- 次数由 REC_RETRY_MAX 注入: 文案里镜像常量就是下一个会过期的假话(设计决策) -->
                  <div class="text-[10.5px] text-ink3">{{ t('settings.autoRetryD', { max: REC_RETRY_MAX }) }}</div>
                </div>
                <n-switch size="small" v-model:value="form.autoRetryRecord" />
              </div>
            </div>
          </div>
        </section>

        <!-- 网络 -->
        <section data-sec="network" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.network') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.networkDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.proxy') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.proxyDesc') }}</div>
              </div>
              <n-input v-model:value="form.proxyUrl" size="small" :placeholder="PROXY_PH" class="!w-56" clearable />
            </div>
          </div>
        </section>

        <!-- 推送与行为: 通道(Telegram)与窗口行为是两平台共用的; 各平台的通知格在平台节里 -->
        <section data-sec="push" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.notify') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.notifyDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="grid grid-cols-1 gap-2.5 px-4 py-3">
              <div :class="tileCls" role="switch" :aria-checked="form.closeToTray" tabindex="0" @click="tileClick($event, 'closeToTray')" @keydown.space.prevent="tileKey('closeToTray')" @keydown.enter="tileKey('closeToTray')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.closeToTray') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.closeToTrayD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.closeToTray" />
              </div>
            </div>

            <!-- Telegram 推送 -->
            <div class="px-4 pb-3.5 pt-3 border-t border-line/40">
              <div class="rounded-ctl bg-fill px-3.5 py-3">
                <div class="text-[12.5px] font-semibold text-ink1 mb-2">{{ t('settings.tgTitle') }}</div>
                <div class="grid grid-cols-2 gap-2.5">
                  <div class="min-w-0">
                    <div class="text-[11px] text-ink3 mb-1">{{ t('settings.tgToken') }}<span v-if="form.tgTokenSet && form.secretsEncrypted" class="text-okink"> · {{ t('settings.tgTokenSaved') }}</span><span v-else-if="form.tgTokenSet" class="text-warnink"> · {{ t('settings.tgTokenPlain') }}</span></div>
                    <n-input
                      v-model:value="tgTokenDraft"
                      type="password"
                      show-password-toggle
                      size="small"
                      :placeholder="t('settings.tgTokenD')"
                    />
                  </div>
                  <div class="min-w-0">
                    <div class="text-[11px] text-ink3 mb-1">{{ t('settings.tgChatId') }}</div>
                    <n-input v-model:value="form.tgChatId" size="small" />
                  </div>
                  <div class="min-w-0">
                    <div class="text-[11px] text-ink3 mb-1">{{ t('settings.tgProxy') }}<span class="text-ink3"> · {{ t('settings.tgProxyD') }}</span></div>
                    <n-input v-model:value="form.tgProxy" size="small" :placeholder="PROXY_PH" clearable />
                  </div>
                </div>
                <div class="flex items-center gap-3 mt-3 flex-wrap">
                  <span class="text-[11px] text-ink3">{{ t('settings.tgEventsHint') }}</span>
                  <div class="ml-auto flex items-center gap-2">
                    <n-button v-if="form.tgTokenSet" size="tiny" tertiary @click="tgClearToken">{{ t('settings.tgClear') }}</n-button>
                    <n-button size="tiny" secondary @click="tgTest">{{ t('settings.tgTest') }}</n-button>
                  </div>
                </div>
                <!-- 保险箱降级必须由界面说, 不能只躺在日志里: 这里存的是 bot token 与 SOOP 托管密码 -->
                <p v-if="!form.secretsEncrypted" class="text-[11px] text-warnink leading-relaxed mt-2.5">
                  {{ t('settings.vaultPlainWarn') }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- 数据与日志 -->
        <section data-sec="storage" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.storage') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.storageDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3.5">
              <div class="rounded-ctl bg-fill px-3.5 py-3 min-w-0">
                <div class="text-[12.5px] font-semibold text-ink1">{{ t('settings.dataDir') }}</div>
                <div class="text-[11px] text-ink3 mt-1 truncate font-mono" :title="dataDir">{{ dataDir || '…' }}</div>
                <div class="text-[10.5px] text-ink3 mt-0.5">{{ t('settings.dataDirMeta') }}</div>
                <n-button size="tiny" secondary class="mt-2.5" @click="openDataDir">{{ t('settings.openDir') }}</n-button>
              </div>
              <div class="rounded-ctl bg-fill px-3.5 py-3 min-w-0">
                <div class="text-[12.5px] font-semibold text-ink1">{{ t('settings.logs') }}</div>
                <div class="text-[11px] text-ink3 mt-1 truncate font-mono" :title="info?.logsDir">{{ info?.logsDir || '…' }}</div>
                <div class="text-[10.5px] text-ink3 mt-0.5">{{ t('settings.logsMeta') }}</div>
                <n-button size="tiny" secondary class="mt-2.5" @click="openLogsDir">{{ t('settings.openLogs') }}</n-button>
              </div>
            </div>
          </div>
        </section>

        <!-- Panda: 平台专属项自成一节 —— 检测模式、源保活、开播自录默认、通知矩阵 -->
        <section data-sec="panda" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ platformName('pandalive') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.pandaDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="px-4 pt-3.5 pb-1 grp-h">{{ t('settings.grpCollect') }}</div>
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.watchMode') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.watchModeDesc') }}</div>
              </div>
              <Seg
                v-model="form.watchMode"
                :options="[
                  { value: 'list', label: t('settings.modeList') },
                  { value: 'per-anchor', label: t('settings.modePer') }
                ]"
              />
            </div>
            <!-- 节奏两格: Panda 每轮是翻页的全站列表 = N 个请求, 提速直接换作风控面,
                 所以这一格只归 Panda 自己; SOOP 那一格在下面的 SOOP 节里 -->
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.pollSec') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.pollSecDescPanda') }}</div>
              </div>
              <n-input-number v-model:value="form.monitor.pandalive.pollIntervalSec" :min="5" :max="600" size="small" class="!w-28" />
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.gapMs') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.gapMsDescPanda') }}</div>
              </div>
              <n-input-number v-model:value="form.monitor.pandalive.requestGapMs" :min="300" :max="10000" :step="100" size="small" class="!w-28" />
            </div>
            <div class="grid grid-cols-1 gap-2.5 px-4 py-3 border-t border-line/40">
              <div :class="tileCls" role="switch" :aria-checked="form.monitor.pandalive.prefetchStream" tabindex="0" @click="monTileClick($event, 'pandalive')" @keydown.space.prevent="monTileKey('pandalive')" @keydown.enter="monTileKey('pandalive')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.prefetch') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.prefetchD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.monitor.pandalive.prefetchStream" />
              </div>
              <div :class="tileCls" role="switch" :aria-checked="form.keepaliveStream" tabindex="0" @click="tileClick($event, 'keepaliveStream')" @keydown.space.prevent="tileKey('keepaliveStream')" @keydown.enter="tileKey('keepaliveStream')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.keepalive') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.keepaliveD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.keepaliveStream" />
              </div>
            </div>

            <div class="px-4 pt-3.5 pb-1 grp-h border-t border-line/40">{{ t('settings.grpAutoRec') }}</div>
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.autoRecDef') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.autoRecDefD') }}</div>
              </div>
              <div class="flex items-center gap-2.5 shrink-0">
                <span class="text-[11px] text-ink3">{{ t('settings.autoRecOver', { n: autoRecOverrides('pandalive') }) }}</span>
                <Seg
                  v-model="form.autoRecordDefault.pandalive"
                  :options="[
                    { value: false, label: t('settings.autoRecOff') },
                    { value: true, label: t('settings.autoRecOn') }
                  ]"
                />
              </div>
            </div>

            <!-- 通知矩阵(D4)按平台拆节: 行 = 事件, 列 = 系统通知 / Telegram / 声音。
                 承载面是 bg-fill 圆角面板而不是裸 table —— 卡片里直接摆表格会长出通栏细线与悬空表头,
                 全站没有第二处这么写(瓷片/面板才是「一组同类控件」的既有语言)。
                 声音列只在开播行给开关 —— 其余行挂了也没人听, 与其摆个假开关不如标「—」 -->
            <div class="flex items-center gap-2 px-4 pt-3.5 pb-2 border-t border-line/40">
              <span class="grp-h">{{ t('settings.nmTitle') }}</span>
              <!-- 整块开/关按平台走: 静音一个平台不该把另一个也哑掉 -->
              <div class="ml-auto flex items-center gap-1.5">
                <n-button size="tiny" tertiary @click="setNotifyAll('pandalive', true)">{{ t('settings.nmAllOn') }}</n-button>
                <n-button size="tiny" tertiary @click="setNotifyAll('pandalive', false)">{{ t('settings.nmAllOff') }}</n-button>
              </div>
            </div>
            <div class="px-4 pb-3.5">
              <div data-nm="pandalive" class="rounded-ctl bg-fill overflow-hidden">
                <div class="grid grid-cols-[minmax(0,1fr)_repeat(3,68px)] items-center px-3 pt-2 pb-1.5">
                  <span class="text-[10.5px] text-ink3">{{ t('settings.nmEvent') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmSystem') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmTg') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmSound') }}</span>
                </div>
                <div
                  v-for="e in notifyEvents"
                  :key="e.key"
                  data-nm-row
                  class="grid grid-cols-[minmax(0,1fr)_repeat(3,68px)] items-center px-3 py-2 border-t border-line/40 transition-colors hover:bg-fillh"
                >
                  <div class="min-w-0 pr-2">
                    <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ e.label }}</div>
                    <div class="text-[10.5px] text-ink3 mt-0.5">{{ e.desc }}</div>
                  </div>
                  <div class="grid place-items-center">
                    <n-switch size="small" :value="form.notify.pandalive[e.key].system" @update:value="(v: boolean) => setNotify('pandalive', e.key, 'system', v)" />
                  </div>
                  <div class="grid place-items-center">
                    <n-switch size="small" :value="form.notify.pandalive[e.key].telegram" @update:value="(v: boolean) => setNotify('pandalive', e.key, 'telegram', v)" />
                  </div>
                  <div class="grid place-items-center">
                    <n-switch v-if="e.key === 'live'" size="small" v-model:value="form.notify.pandalive.live.sound" />
                    <span v-else class="text-deco text-[12px]">—</span>
                  </div>
                </div>
              </div>
              <div class="pt-2 text-[10.5px] text-ink3 leading-relaxed">{{ t('settings.nmDesc') }}</div>
            </div>
          </div>
        </section>

        <!-- SOOP: 采集链是只读事实(设计稿 S6 读状态不给假开关), 可写的是自己的节奏三格、自录默认与通知矩阵 -->
        <section data-sec="soop" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ platformName('soop') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.soopDesc') }}</span>
          </div>
          <div class="bg-card rounded-card shadow-card overflow-hidden">
            <div class="px-4 pt-3.5 pb-1 grp-h">{{ t('settings.grpCollect') }}</div>
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.soopChain') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.soopChainD') }}</div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-[12px] font-semibold text-ink1">{{ t('settings.soopChainFixed') }}</div>
                <div v-if="soopStatus" class="text-[11px] text-ink3 mt-0.5 tabular-nums">
                  {{ t('settings.soopRound', { cost: fmtRoundCost(soopStatus.roundMs), n: soopStatus.monitored, at: soopStatus.lastRoundAt ? roundTime(soopStatus.lastRoundAt) : '—' }) }}
                </div>
              </div>
            </div>
            <!-- 节奏两格: SOOP 每轮只发一发关注列表, 与 Panda 的翻页列表不同量级 ——
                 共用一格时"想早点发现 SOOP 开播"只能把 Panda 一起提速, 那是拿一个平台的风险换另一个平台的读数 -->
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.pollSec') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.pollSecDescSoop') }}</div>
              </div>
              <n-input-number v-model:value="form.monitor.soop.pollIntervalSec" :min="5" :max="600" size="small" class="!w-28" />
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.gapMs') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.gapMsDescSoop') }}</div>
              </div>
              <n-input-number v-model:value="form.monitor.soop.requestGapMs" :min="300" :max="10000" :step="100" size="small" class="!w-28" />
            </div>
            <div class="grid grid-cols-1 gap-2.5 px-4 py-3 border-t border-line/40">
              <div :class="tileCls" role="switch" :aria-checked="form.monitor.soop.prefetchStream" tabindex="0" @click="monTileClick($event, 'soop')" @keydown.space.prevent="monTileKey('soop')" @keydown.enter="monTileKey('soop')">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.prefetch') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.prefetchD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.monitor.soop.prefetchStream" />
              </div>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.soopLogin') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.soopLoginD') }}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[12px]" :class="soopAccount?.realLogin ? 'text-okink' : 'text-warnink'">
                  {{ soopAccount?.realLogin ? t('settings.soopLoginOn', { id: soopAccount.loginId || soopAccount.nick || '—' }) : t('settings.soopLoginOff') }}
                </span>
                <n-button size="tiny" secondary @click="router.push({ name: 'account', query: { plat: 'soop' } })">{{ t('settings.goAccount') }}</n-button>
              </div>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.soopNa') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.soopNaD') }}</div>
              </div>
              <span class="text-[12px] text-deco shrink-0">{{ t('settings.na') }}</span>
            </div>

            <div class="px-4 pt-3.5 pb-1 grp-h border-t border-line/40">{{ t('settings.grpAutoRec') }}</div>
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.autoRecDef') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.soopAutoRecD') }}</div>
              </div>
              <div class="flex items-center gap-2.5 shrink-0">
                <span class="text-[11px] text-ink3">{{ t('settings.autoRecOver', { n: autoRecOverrides('soop') }) }}</span>
                <Seg
                  v-model="form.autoRecordDefault.soop"
                  :options="[
                    { value: false, label: t('settings.autoRecOff') },
                    { value: true, label: t('settings.autoRecOn') }
                  ]"
                />
              </div>
            </div>

            <div class="flex items-center gap-2 px-4 pt-3.5 pb-2 border-t border-line/40">
              <span class="grp-h">{{ t('settings.nmTitle') }}</span>
              <div class="ml-auto flex items-center gap-1.5">
                <n-button size="tiny" tertiary @click="setNotifyAll('soop', true)">{{ t('settings.nmAllOn') }}</n-button>
                <n-button size="tiny" tertiary @click="setNotifyAll('soop', false)">{{ t('settings.nmAllOff') }}</n-button>
              </div>
            </div>
            <div class="px-4 pb-3.5">
              <div data-nm="soop" class="rounded-ctl bg-fill overflow-hidden">
                <div class="grid grid-cols-[minmax(0,1fr)_repeat(3,68px)] items-center px-3 pt-2 pb-1.5">
                  <span class="text-[10.5px] text-ink3">{{ t('settings.nmEvent') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmSystem') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmTg') }}</span>
                  <span class="text-[10.5px] text-ink3 text-center">{{ t('settings.nmSound') }}</span>
                </div>
                <div
                  v-for="e in notifyEvents"
                  :key="e.key"
                  data-nm-row
                  class="grid grid-cols-[minmax(0,1fr)_repeat(3,68px)] items-center px-3 py-2 border-t border-line/40 transition-colors hover:bg-fillh"
                >
                  <div class="min-w-0 pr-2">
                    <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ e.label }}</div>
                    <div class="text-[10.5px] text-ink3 mt-0.5">{{ e.desc }}</div>
                  </div>
                  <div class="grid place-items-center">
                    <n-switch size="small" :value="form.notify.soop[e.key].system" @update:value="(v: boolean) => setNotify('soop', e.key, 'system', v)" />
                  </div>
                  <div class="grid place-items-center">
                    <n-switch size="small" :value="form.notify.soop[e.key].telegram" @update:value="(v: boolean) => setNotify('soop', e.key, 'telegram', v)" />
                  </div>
                  <div class="grid place-items-center">
                    <n-switch v-if="e.key === 'live'" size="small" v-model:value="form.notify.soop.live.sound" />
                    <span v-else class="text-deco text-[12px]">—</span>
                  </div>
                </div>
              </div>
              <div class="pt-2 text-[10.5px] text-ink3 leading-relaxed">{{ t('settings.nmDesc') }}</div>
            </div>
          </div>
        </section>

        <!-- 关于 -->
        <section data-sec="about" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="sec-h">{{ t('settings.about') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.aboutDesc') }}</span>
          </div>
          <div class="rounded-card shadow-card overflow-hidden bg-card">
            <!-- 品牌横幅(头像灰度背景)。底色用应用主色阶而非 Panda 粉:
                 原则 0.2「平台色只表身份」—— 这块横幅表的是「本应用」, 用平台色会把 SODALive 读成 Panda -->
            <div class="relative overflow-hidden text-white" style="background: linear-gradient(115deg, #243a5e 0%, #2f4b7c 55%, #3a5c96 100%)">
              <img
                v-if="avatarUrl"
                :src="avatarUrl"
                alt=""
                class="absolute -right-4 -top-7 w-[152px] h-[152px] rounded-full opacity-20 grayscale -rotate-6 pointer-events-none select-none"
                @error="hideBrokenImg"
              />
              <div class="relative z-10 px-5 py-[18px]">
                <div class="flex items-center gap-2">
                  <span class="text-[16px] font-extrabold tracking-wide">SODALive Monitor</span>
                  <span class="badge badge-md bg-white/20 text-white tabular-nums">v{{ info?.version || '…' }}</span>
                </div>
                <div class="text-[11.5px] text-white/85 mt-1">{{ t('settings.aboutSub') }}</div>
              </div>
            </div>
            <!-- 元信息 -->
            <div class="grid grid-cols-2">
              <div class="px-4 py-3">
                <div class="text-[10.5px] text-ink3">{{ t('settings.metaAuthor') }}</div>
                <div class="text-[12.5px] font-semibold text-ink1 mt-0.5">{{ info?.author || '…' }}</div>
              </div>
              <div class="px-4 py-3">
                <div class="text-[10.5px] text-ink3">{{ t('settings.metaRepo') }}</div>
                <div class="text-[12.5px] font-medium text-ink1 mt-0.5 font-mono truncate">{{ repoSlug || '…' }}</div>
              </div>
            </div>
            <!-- 操作 -->
            <div class="flex items-center gap-2 px-4 py-3 flex-wrap">
              <!-- GitHub 主页: 识别交给 GitHub 徽标本身, 承载面走令牌板(此前写死 #24292f/#0d1117 两枚
                   十六进制, 深色主题下比卡面还亮、浅色主题下又和主按钮抢焦点, 且 D3「零原生色」查不到它)。
                   高度锁 h-7 与同行 naive small「检查更新」同档(实测 34.35 vs 28 一眼看出不齐)。 -->
              <button
                class="inline-flex items-center gap-1.5 h-7 px-3 rounded-ctl bg-fill hover:bg-fillh border border-line text-ink1 text-[13px] font-semibold transition-all active:scale-[0.97]"
                @click="openRepo"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.14c-3.2.69-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 015.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.55A11.51 11.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
                {{ t('settings.ghHome') }}
              </button>
              <n-button size="small" type="primary" :disabled="checking" @click="doCheckUpdate">
                <span class="inline-flex items-center justify-center gap-1.5"><SpinIcon v-if="checking" :size="12" />{{ t('settings.checkUpdate') }}</span>
              </n-button>
              <template v-if="upd">
                <span v-if="!upd.ok" class="text-[11.5px] text-liveink">{{ upd.error || t('settings.checkFail') }}</span>
                <template v-else-if="upd.hasUpdate">
                  <span class="badge badge-md bg-warn/[0.14] text-warnink tabular-nums">{{ t('settings.hasUpdate', { v: upd.latest }) }}</span>
                  <n-button size="small" type="primary" @click="openRelease">{{ t('settings.goDownload') }}</n-button>
                </template>
                <span v-else class="badge badge-md bg-ok/10 text-okink">{{ t('settings.newest') }}</span>
              </template>
            </div>
            <p class="px-4 pb-3.5 text-[10.5px] text-ink3/80 leading-relaxed">
              {{ t('settings.disclaimer') }}
            </p>
          </div>
        </section>

        <!-- 悬浮吸底操作条(sticky 于内容滚动区底部) -->
        <div class="sticky bottom-0 pt-2" style="background: linear-gradient(rgb(var(--c-page) / 0), rgb(var(--c-page) / 0.96) 35%)">
          <div class="flex items-center gap-2.5 bg-card/90 rounded-ctl px-3.5 py-[9px] shadow-[0_4px_16px_rgba(0,0,0,.06)] backdrop-blur">
            <span class="text-[11.5px]" :class="dirty ? 'text-warnink' : 'text-ink3'">{{ dirty ? t('settings.dirtyTextN', { n: dirtyKeys.size }) : t('settings.cleanText') }}</span>
            <div class="flex-1"></div>
            <n-button secondary :disabled="!dirty" @click="resetForm" class="!min-w-[128px]">{{ t('settings.discard') }}</n-button>
            <n-button type="primary" :disabled="!dirty || saving" @click="save" class="!min-w-[128px]">
              <span class="inline-flex items-center justify-center gap-1.5"><SpinIcon v-if="saving" />{{ t('settings.saveBtn') }}</span>
            </n-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
