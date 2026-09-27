<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NInputNumber, NSwitch, NRadioGroup, NRadioButton, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { api } from '@/api'
import type { AppInfo, Settings, UpdateCheckResult } from '@shared/types'
import SpinIcon from '@/components/SpinIcon.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const store = useAppStore()
const message = useMessage()
const form = ref<Settings | null>(null)
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

const defaultRecPath = computed(() => {
  if (!dataDir.value) return '…'
  return dataDir.value.replace(/[/\\]data$/, '/recording')
})

watch(
  () => store.settings,
  (s) => {
    if (s && !form.value) form.value = { ...s }
  },
  { immediate: true }
)

// 未保存脏标记(form 与已持久化 settings 值不一致)
const dirty = computed(() => {
  if (!form.value || !store.settings) return false
  return JSON.stringify(form.value) !== JSON.stringify(store.settings)
})

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
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
    // 清洗: NInputNumber 清空为 null / 非法值时回退默认, 并夹紧到安全区间
    const clean: Settings = {
      ...form.value,
      proxyUrl: (form.value.proxyUrl || '').trim(),
      tgChatId: (form.value.tgChatId || '').trim(),
      tgProxy: (form.value.tgProxy || '').trim(),
      pollIntervalSec: clampNum(form.value.pollIntervalSec, 5, 600, 30),
      requestGapMs: clampNum(form.value.requestGapMs, 300, 10000, 1200),
      splitSeconds: clampNum(form.value.splitSeconds, 60, 7200, 900),
      diskLimitGb: clampNum(form.value.diskLimitGb, 0.5, 100, 1)
    }
    // 全量提交前剔除主进程投影字段(真值在 secrets, 不经设置通道往返)
    delete (clean as Partial<Settings>).tgTokenSet
    await store.patchSettings(clean)
    // Token 单独通道: 非空草稿才落保险箱(空草稿=未改动, 清除走「清除」按钮)
    if (tgTokenDraft.value.trim()) {
      await tgSaveToken(tgTokenDraft.value.trim())
      tgTokenDraft.value = ''
    }
    // 脏标记按 JSON 键序比对, 手工重组 form 键序必翻车 —— 一律从持久化投影回拷
    if (store.settings) form.value = { ...store.settings }
    message.success(t('settings.saved'))
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
  if (form.value && store.settings) form.value.tgTokenSet = store.settings.tgTokenSet
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

function resetForm() {
  if (store.settings) form.value = { ...store.settings }
}

/** 主题特殊通道: 点按即切换并立即持久化(不走"保存设置"批处理), 与页内文案"立即生效"一致 */
async function applyTheme(v: 'light' | 'dark') {
  if (!form.value || form.value.theme === v) return
  form.value.theme = v
  await store.patchSettings({ theme: v })
  message.success(v === 'dark' ? t('settings.switchedDark') : t('settings.switchedLight'))
}

/** 语言特殊通道: 同主题, 立即生效并持久化 */
async function applyLocale(v: string | number | boolean) {
  const l = String(v) as Settings['locale']
  if (!form.value || form.value.locale === l) return
  form.value.locale = l
  await store.patchSettings({ locale: l })
  message.success(t('settings.switchedLang'))
}

/** 头像加载失败(离线等)时静默隐藏, 保留纯渐变横幅 */
function hideBrokenImg(e: Event): void {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

// ---- 左侧锚点导航(手动 scrollspy) ----
type NavKey = 'appearance' | 'monitor' | 'record' | 'network' | 'notify' | 'storage' | 'about'
const navs = computed<{ key: NavKey; label: string }[]>(() => [
  { key: 'appearance', label: t('settings.navAppearance') },
  { key: 'monitor', label: t('settings.navMonitor') },
  { key: 'record', label: t('settings.navRecord') },
  { key: 'network', label: t('settings.navNetwork') },
  { key: 'notify', label: t('settings.navNotify') },
  { key: 'storage', label: t('settings.navStorage') },
  { key: 'about', label: t('settings.navAbout') }
])

const scrollRef = ref<HTMLElement | null>(null)
const activeNav = ref<NavKey>('appearance')

function scrollToSec(key: NavKey): void {
  activeNav.value = key
  scrollRef.value
    ?.querySelector(`[data-sec="${key}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

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
const tileCls =
  'flex items-center gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer transition-colors bg-fill hover:bg-fillh'
</script>

<template>
  <div class="h-full flex flex-col" v-if="form">
    <!-- 页头 -->
    <div class="px-7 pt-5 pb-4 shrink-0 flex items-center gap-3">
      <div>
        <h1 class="text-[20px] font-extrabold text-ink1 tracking-tight">{{ t('settings.title') }}</h1>
        <div class="text-[12px] text-ink3 mt-0.5">{{ t('settings.sub') }}</div>
      </div>
      <span
        v-if="dirty"
        class="ml-auto shrink-0 h-[22px] inline-flex items-center px-[9px] rounded-[7px] text-[11px] font-semibold bg-[#f0a020]/[0.14] text-[#d98a08] animate-pop"
      >{{ t('settings.dirtyChip') }}</span>
    </div>

    <!-- 主体: 左导航 + 右滚动区 -->
    <div class="flex-1 min-h-0 flex px-7 gap-[22px] pb-4">
      <nav class="w-[200px] shrink-0 pt-0.5">
        <button
          v-for="n in navs"
          :key="n.key"
          class="flex items-center gap-2.5 w-full px-3 py-2 rounded-[9px] text-[13px] transition-colors text-left"
          :class="activeNav === n.key
            ? 'bg-card text-ink1 font-semibold shadow-card'
            : 'text-ink2 hover:text-ink1 hover:bg-fillh'"
          @click="scrollToSec(n.key)"
        >
          <svg v-if="n.key === 'monitor'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="2.2"/><path stroke-linecap="round" d="M12 6.5a5.5 5.5 0 015.5 5.5M12 2.8a9.2 9.2 0 019.2 9.2"/></svg>
          <svg v-else-if="n.key === 'record'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>
          <svg v-else-if="n.key === 'network'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>
          <svg v-else-if="n.key === 'notify'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1"/></svg>
          <svg v-else-if="n.key === 'storage'" class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="8" ry="3"/><path stroke-linecap="round" d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
          <svg v-else class="w-4 h-4 shrink-0" :class="activeNav === n.key ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 16v-5m0-3.5h.01"/></svg>
          {{ n.label }}
        </button>
        <div class="mt-3.5 px-3 text-[11px] text-ink3 tabular-nums">PandaLive Monitor v{{ info?.version || '…' }}</div>
      </nav>

      <!-- 内容滚动区 -->
      <div ref="scrollRef" class="flex-1 min-w-0 overflow-y-auto pb-1" @scroll="onScroll">
        <!-- 外观 -->
        <section data-sec="appearance" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.appearance') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.appearanceDesc') }}</span>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3">
              <div
                class="flex items-center gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer transition-colors"
                :class="form.theme === 'light' ? 'bg-fill' : 'hover:bg-fill'"
                @click="applyTheme('light')"
              >
                <svg class="w-4 h-4 shrink-0" :class="form.theme === 'light' ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.lightTheme') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.lightDesc') }}</div>
                </div>
                <span
                  class="w-[18px] h-[18px] rounded-full grid place-items-center shrink-0"
                  :class="form.theme === 'light' ? 'bg-live' : 'border border-line/60'"
                >
                  <svg v-if="form.theme === 'light'" class="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                </span>
              </div>
              <div
                class="flex items-center gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer transition-colors"
                :class="form.theme === 'dark' ? 'bg-fill' : 'hover:bg-fill'"
                @click="applyTheme('dark')"
              >
                <svg class="w-4 h-4 shrink-0" :class="form.theme === 'dark' ? 'text-live' : 'text-ink3'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.darkTheme') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.darkDesc') }}</div>
                </div>
                <span
                  class="w-[18px] h-[18px] rounded-full grid place-items-center shrink-0"
                  :class="form.theme === 'dark' ? 'bg-live' : 'border border-line/60'"
                >
                  <svg v-if="form.theme === 'dark'" class="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                </span>
              </div>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 pb-3 border-t border-line/40 pt-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.language') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.langDesc') }}</div>
              </div>
              <n-radio-group :value="form.locale" size="small" @update:value="applyLocale">
                <n-radio-button value="zh-CN">{{ t('settings.langZh') }}</n-radio-button>
                <n-radio-button value="en-US">{{ t('settings.langEn') }}</n-radio-button>
              </n-radio-group>
            </div>
          </div>
        </section>

        <!-- 监控 -->
        <section data-sec="monitor" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.monitor') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.monitorDesc') }}</span>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.watchMode') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.watchModeDesc') }}</div>
              </div>
              <n-radio-group v-model:value="form.watchMode" size="small">
                <n-radio-button value="list">{{ t('settings.modeList') }}</n-radio-button>
                <n-radio-button value="per-anchor">{{ t('settings.modePer') }}</n-radio-button>
              </n-radio-group>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.pollSec') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.pollSecDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.pollIntervalSec" :min="5" :max="600" size="small" class="!w-28" />
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.gapMs') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.gapMsDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.requestGapMs" :min="300" :max="10000" :step="100" size="small" class="!w-28" />
            </div>
          </div>
        </section>

        <!-- 录制 -->
        <section data-sec="record" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.record') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.recordDesc') }}</span>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.saveDir') }}</div>
                <div class="text-[11px] text-ink3 mt-0.5 truncate font-mono">{{ form.savePath || defaultRecPath }}</div>
              </div>
              <n-button size="small" secondary @click="pickDir">{{ t('settings.pickDir') }}</n-button>
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.splitSec') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.splitSecDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.splitSeconds" :min="60" :max="7200" :step="60" size="small" class="!w-28" />
            </div>
            <div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-line/40">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.diskLimit') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.diskLimitDesc') }}</div>
              </div>
              <n-input-number v-model:value="form.diskLimitGb" :min="0.5" :max="100" :step="0.5" size="small" class="!w-28" />
            </div>

            <div class="px-4 pt-3.5 pb-1 text-[11px] font-bold text-ink3 tracking-wide border-t border-line/40">{{ t('settings.outProc') }}</div>
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3">
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.autoMp4') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.autoMp4D') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.autoMp4" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.deleteTs') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.deleteTsD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.deleteTs" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.mergeMp4') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.mergeMp4D') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.mergeMp4" />
              </div>
              <div :class="tileCls" v-if="form.autoMp4 && form.mergeMp4">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.mergeDel') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.mergeDelD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.mergeDeleteSegments" />
              </div>
            </div>

            <div class="px-4 pt-3.5 pb-1 text-[11px] font-bold text-ink3 tracking-wide border-t border-line/40">{{ t('settings.automation') }}</div>
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3">
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.prefetch') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.prefetchD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.prefetchStream" />
              </div>
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.keepalive') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.keepaliveD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.keepaliveStream" />
              </div>
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.autoRec') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.autoRecD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.autoRecordDefault" />
              </div>
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.autoRetry') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.autoRetryD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.autoRetryRecord" />
              </div>
            </div>
          </div>
        </section>

        <!-- 网络 -->
        <section data-sec="network" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.network') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.networkDesc') }}</span>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <div class="text-[13px] font-medium text-ink1">{{ t('settings.proxy') }}</div>
                <div class="text-[11.5px] text-ink3 mt-0.5">{{ t('settings.proxyDesc') }}</div>
              </div>
              <n-input v-model:value="form.proxyUrl" size="small" placeholder="http://127.0.0.1:7890" class="!w-56" clearable />
            </div>
          </div>
        </section>

        <!-- 通知与行为 -->
        <section data-sec="notify" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.notify') }}</h2>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="grid grid-cols-3 gap-2.5 px-4 py-3">
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.notifySys') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.notifySysD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.notifySystem" />
              </div>
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.notifySound') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.notifySoundD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.notifySound" />
              </div>
              <div :class="tileCls">
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px] font-semibold text-ink1 leading-snug">{{ t('settings.closeToTray') }}</div>
                  <div class="text-[10.5px] text-ink3">{{ t('settings.closeToTrayD') }}</div>
                </div>
                <n-switch size="small" v-model:value="form.closeToTray" />
              </div>
            </div>

            <!-- Telegram 推送 -->
            <div class="px-4 pb-3.5">
              <div class="rounded-xl bg-fill px-3.5 py-3">
                <div class="text-[12.5px] font-semibold text-ink1 mb-2">{{ t('settings.tgTitle') }}</div>
                <div class="grid grid-cols-2 gap-2.5">
                  <div class="min-w-0">
                    <div class="text-[11px] text-ink3 mb-1">{{ t('settings.tgToken') }}<span v-if="form.tgTokenSet" class="text-live"> · {{ t('settings.tgTokenSaved') }}</span></div>
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
                    <n-input v-model:value="form.tgProxy" size="small" placeholder="http://127.0.0.1:7890" clearable />
                  </div>
                </div>
                <div class="flex items-center gap-3 mt-3 flex-wrap">
                  <span class="text-[11px] text-ink3">{{ t('settings.tgEvents') }}</span>
                  <div class="flex items-center gap-1.5 text-[11.5px] text-ink1"><n-switch size="small" v-model:value="form.tgLive" />{{ t('settings.tgEvLive') }}</div>
                  <div class="flex items-center gap-1.5 text-[11.5px] text-ink1"><n-switch size="small" v-model:value="form.tgOffline" />{{ t('settings.tgEvOffline') }}</div>
                  <div class="flex items-center gap-1.5 text-[11.5px] text-ink1"><n-switch size="small" v-model:value="form.tgRecord" />{{ t('settings.tgEvRecord') }}</div>
                  <div class="flex items-center gap-1.5 text-[11.5px] text-ink1"><n-switch size="small" v-model:value="form.tgError" />{{ t('settings.tgEvError') }}</div>
                  <div class="ml-auto flex items-center gap-2">
                    <n-button v-if="form.tgTokenSet" size="tiny" tertiary @click="tgClearToken">{{ t('settings.tgClear') }}</n-button>
                    <n-button size="tiny" secondary @click="tgTest">{{ t('settings.tgTest') }}</n-button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 数据与日志 -->
        <section data-sec="storage" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.storage') }}</h2>
            <span class="text-[11px] text-ink3 ml-auto">{{ t('settings.storageDesc') }}</span>
          </div>
          <div class="bg-card rounded-[14px] shadow-card overflow-hidden">
            <div class="grid grid-cols-2 gap-2.5 px-4 py-3.5">
              <div class="rounded-xl bg-fill px-3.5 py-3 min-w-0">
                <div class="text-[12.5px] font-semibold text-ink1">{{ t('settings.dataDir') }}</div>
                <div class="text-[11px] text-ink3 mt-1 truncate font-mono" :title="dataDir">{{ dataDir || '…' }}</div>
                <div class="text-[10.5px] text-ink3 mt-0.5">{{ t('settings.dataDirMeta') }}</div>
                <n-button size="tiny" secondary class="mt-2.5" @click="openDataDir">{{ t('settings.openDir') }}</n-button>
              </div>
              <div class="rounded-xl bg-fill px-3.5 py-3 min-w-0">
                <div class="text-[12.5px] font-semibold text-ink1">{{ t('settings.logs') }}</div>
                <div class="text-[11px] text-ink3 mt-1 truncate font-mono">…\data\logs\app-YYYYMMDD.log</div>
                <div class="text-[10.5px] text-ink3 mt-0.5">{{ t('settings.logsMeta') }}</div>
                <n-button size="tiny" secondary class="mt-2.5" @click="openLogsDir">{{ t('settings.openLogs') }}</n-button>
              </div>
            </div>
          </div>
        </section>

        <!-- 关于 -->
        <section data-sec="about" class="mb-5">
          <div class="flex items-baseline gap-2.5 px-1 pb-2">
            <h2 class="text-[13.5px] font-bold text-ink1 tracking-wide">{{ t('settings.about') }}</h2>
          </div>
          <div class="rounded-[14px] shadow-card overflow-hidden bg-card">
            <!-- 品牌横幅(头像灰度背景) -->
            <div class="relative overflow-hidden text-white" style="background: linear-gradient(115deg, #f0567f 0%, #fb7299 55%, #ffa4bc 100%)">
              <img
                src="https://github.com/Joftal.png"
                alt=""
                class="absolute -right-4 -top-7 w-[152px] h-[152px] rounded-full opacity-20 grayscale -rotate-6 pointer-events-none select-none"
                @error="hideBrokenImg"
              />
              <div class="relative z-10 px-5 py-[18px]">
                <div class="flex items-center gap-2">
                  <span class="text-[16px] font-extrabold tracking-wide">PandaLive Monitor</span>
                  <span class="h-[22px] inline-flex items-center px-[9px] rounded-[7px] text-[11px] font-semibold bg-white/20 text-white tabular-nums">v{{ info?.version || '…' }}</span>
                </div>
                <div class="text-[11.5px] text-white/85 mt-1">{{ t('settings.aboutSub') }}</div>
              </div>
            </div>
            <!-- 元信息 -->
            <div class="grid grid-cols-2">
              <div class="px-4 py-3">
                <div class="text-[10.5px] text-ink3">{{ t('settings.metaAuthor') }}</div>
                <div class="text-[12.5px] font-semibold text-ink1 mt-0.5">{{ info?.author || 'Joftal' }}</div>
              </div>
              <div class="px-4 py-3">
                <div class="text-[10.5px] text-ink3">{{ t('settings.metaRepo') }}</div>
                <div class="text-[12.5px] font-medium text-ink1 mt-0.5 font-mono truncate">Joftal/pd-monitor</div>
              </div>
            </div>
            <!-- 操作 -->
            <div class="flex items-center gap-2 px-4 py-3 flex-wrap">
              <button
                class="inline-flex items-center gap-1.5 px-4 py-[7px] rounded-lg bg-[#24292f] hover:bg-[#0d1117] text-white text-[12.5px] font-semibold transition-all active:scale-[0.97]"
                @click="openRepo"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.14c-3.2.69-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 015.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.55A11.51 11.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
                {{ t('settings.ghHome') }}
              </button>
              <n-button size="small" type="primary" :disabled="checking" @click="doCheckUpdate">
                <span class="inline-flex items-center justify-center gap-1.5"><SpinIcon v-if="checking" :size="12" />{{ t('settings.checkUpdate') }}</span>
              </n-button>
              <template v-if="upd">
                <span v-if="!upd.ok" class="text-[11.5px] text-red-500">{{ upd.error || t('settings.checkFail') }}</span>
                <template v-else-if="upd.hasUpdate">
                  <span class="h-[22px] inline-flex items-center px-[9px] rounded-[7px] text-[11px] font-semibold bg-[#f0a020]/[0.14] text-[#d98a08] tabular-nums">{{ t('settings.hasUpdate', { v: upd.latest }) }}</span>
                  <n-button size="tiny" type="primary" @click="openRelease">{{ t('settings.goDownload') }}</n-button>
                </template>
                <span v-else class="h-[22px] inline-flex items-center px-[9px] rounded-[7px] text-[11px] font-semibold bg-[#2fad5f]/[0.12] text-emerald-600">{{ t('settings.newest') }}</span>
              </template>
            </div>
            <p class="px-4 pb-3.5 text-[10.5px] text-ink3/80 leading-relaxed">
              {{ t('settings.disclaimer') }}
            </p>
          </div>
        </section>

        <!-- 悬浮吸底操作条(sticky 于内容滚动区底部) -->
        <div class="sticky bottom-0 pt-2" style="background: linear-gradient(rgb(var(--c-page) / 0), rgb(var(--c-page) / 0.96) 35%)">
          <div class="flex items-center gap-2.5 bg-card/90 rounded-xl px-3.5 py-[9px] shadow-[0_4px_16px_rgba(0,0,0,.06)] backdrop-blur">
            <span class="text-[11.5px]" :class="dirty ? 'text-[#d98a08]' : 'text-ink3'">{{ dirty ? t('settings.dirtyText') : t('settings.cleanText') }}</span>
            <div class="flex-1"></div>
            <n-button secondary :disabled="!dirty" @click="resetForm">{{ t('settings.discard') }}</n-button>
            <n-button type="primary" :disabled="!dirty || saving" @click="save" class="!w-[128px]">
              <span class="inline-flex items-center justify-center gap-1.5"><SpinIcon v-if="saving" />{{ t('settings.saveBtn') }}</span>
            </n-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
