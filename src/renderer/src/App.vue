<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, zhCN, dateZhCN, enUS, dateEnUS } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import ToastBridge from '@/components/ToastBridge.vue'
import TopNav from '@/components/TopNav.vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { setLocale, type AppLocale } from '@/i18n'
import { mirrorWorkspacePref } from '@/workspace'

const store = useAppStore()
const ready = ref(false)

/** naive 的主题面: 与 styles.css 的语义变量逐值对齐, 否则供应商组件(naive-ui)与
 *  自绘界面(tailwind)会在同一屏里出现两套底色/两套主色。
 *  主色不再是 #fb7299 —— 那个值同时是 Panda 平台身份色与"在播"状态色, 三重语义已拆分(设计稿 S0.3)。 */
const LIGHT_OVERRIDES = {
  common: {
    primaryColor: '#2f4b7c',
    primaryColorHover: '#3a5c96',
    primaryColorPressed: '#263d66',
    primaryColorSuppl: '#2f4b7c',
    successColor: '#2fad5f',
    // naive 的 error 色承载文字与边框, 取 liveink(6.52:1) 而不是 live(3.91:1)
    errorColor: '#b02a31',
    warningColor: '#e0a526',
    borderRadius: '10px',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
    bodyColor: '#f4f5f7',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    inputColor: '#f1f3f6',
    borderColor: '#e4e7eb',
    textColorBase: '#171a1f'
  },
  Card: { borderColor: '#e4e7eb' },
  Button: { textColorPrimary: '#fff', textColorHoverPrimary: '#fff' },
  Tag: { borderRadius: '6px' },
  Input: { borderRadius: '10px' },
  Pagination: { itemColorActive: 'rgba(47,75,124,.1)', itemTextColorActive: '#2f4b7c' }
}

const DARK_OVERRIDES = {
  common: {
    primaryColor: '#7fa6e0',
    primaryColorHover: '#93b4ea',
    primaryColorPressed: '#6b93ce',
    primaryColorSuppl: '#7fa6e0',
    successColor: '#6cd391',
    // 深色档的在播红是 .dark --c-live(#eb575c, 压深底更亮); 沿用浅色的 #e5484d 会让同一屏两套红
    errorColor: '#eb575c',
    warningColor: '#f2c46b',
    borderRadius: '10px',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
    bodyColor: '#14161a',
    cardColor: '#1d2024',
    modalColor: '#23272d',
    popoverColor: '#23272d',
    inputColor: '#2a2f36',
    borderColor: '#2c3138',
    textColorBase: '#e6e8eb'
  },
  Card: { borderColor: '#2c3138' },
  Button: { textColorPrimary: '#0f1115', textColorHoverPrimary: '#0f1115' },
  Tag: { borderRadius: '6px' },
  Input: { borderRadius: '10px' },
  Pagination: { itemColorActive: 'rgba(127,166,224,.18)', itemTextColorActive: '#93b4ea' }
}

const isDark = computed(() => store.settings?.theme === 'dark')
const isEn = computed(() => store.settings?.locale === 'en-US')
const themeOverrides = computed(() => (isDark.value ? DARK_OVERRIDES : LIGHT_OVERRIDES))
const naiveLocale = computed(() => (isEn.value ? enUS : zhCN))
const naiveDateLocale = computed(() => (isEn.value ? dateEnUS : dateZhCN))

// 主题落地: <html> 加 .dark 类(tailwind class 策略) + localStorage 镜像(main.ts 启动防闪白读取)
watch(
  isDark,
  (v) => {
    // M7: settings 未载入(null)不得落笔 —— immediate 首跑若以 false 写入 light 会抵消启动防闪白
    if (!store.settings) return
    document.documentElement.classList.toggle('dark', v)
    try {
      localStorage.setItem('pl-theme', v ? 'dark' : 'light')
    } catch {
      /* ignore */
    }
  },
  { immediate: true }
)

// 启动默认工作区(D5)落镜像: 与 pl-theme 同一套路, 让下次冷启动的第一次导航就能算出落点。
// settings 未载入(null)时绝不落笔 —— 否则首帧会把上次存的「恒 SOOP」抹成默认 remember
watch(
  () => store.settings?.defaultWorkspace,
  (v) => {
    if (!store.settings) return
    mirrorWorkspacePref(v)
  },
  { immediate: true }
)

// 语言落地: settings.locale -> vue-i18n(事实源唯一, 主进程 mt() 读同一字段)
watch(
  () => store.settings?.locale,
  (v) => {
    if (v) setLocale(v as AppLocale)
  },
  { immediate: true }
)

/** 视图身份 = 页名 + 路径参数, 不含 query。
 *  params 必须留在身份里: player/A → player/B 要真重挂(杜绝跨房间状态残留), 换平台也要(工作区的
 *  「粘错平台」出口依赖重挂时经 store.addDraft 过境原句)。
 *  query 必须不在身份里: 在播/发现/已下播三格切的是 ?view=, 账号页换方切的是 ?plat=, 两处都已有
 *  computed/watch 原地接住 —— 把它们算进身份等于每次切视图把整片列表连根拔掉重建(实测 347 ms 空白)。 */
function viewKey(r: { name?: unknown; params: Record<string, unknown> }): string {
  return `${String(r.name ?? '')}|${JSON.stringify(r.params)}`
}

onMounted(async () => {
  try {
    await store.init()
  } catch (e) {
    console.error(e)
  } finally {
    ready.value = true
  }
})
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="themeOverrides" :locale="naiveLocale" :date-locale="naiveDateLocale" class="h-full">
    <n-message-provider>
      <n-dialog-provider>
        <ToastBridge />
        <div class="h-full flex flex-col bg-page text-ink1 select-none">
          <TopNav />
          <main class="flex-1 min-h-0 overflow-hidden relative">
            <router-view v-if="ready" v-slot="{ Component, route }">
              <transition name="fade" mode="out-in">
                <component :is="Component" :key="viewKey(route)" />
              </transition>
            </router-view>
            <div v-else class="h-full flex items-center justify-center text-ink3 text-sm">{{ t('common.loading') }}</div>
          </main>
        </div>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
