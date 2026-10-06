<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { api } from '@/api'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isPlatform, platformName, type Platform } from '@shared/types'
import { resolveWorkspace } from '@/workspace'
import { fmtRoundCost } from '@/utils/media'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const store = useAppStore()

/** 当前工作区归属一律以地址里的 :plat 段为准(地址可分享/可收藏)。
 *  账号页没有平台段, 退到 ?plat= —— 分段高亮、头像状态与页面内容必须指向同一方, 否则顶栏说 Panda、页面演 SOOP */
const plat = computed<Platform>(() => {
  if (isPlatform(route.params.plat)) return route.params.plat
  if (isPlatform(route.query.plat)) return route.query.plat as Platform
  return resolveWorkspace()
})

const PLATS: { key: Platform; label: string }[] = (['pandalive', 'soop'] as Platform[]).map((key) => ({ key, label: platformName(key) }))

/** 分段徽标 = 该平台「关注在播」数(与「直播」页默认视图同一口径), 0 位不占位。
 *  有新开播未读时换成实心呼吸徽标: 取代旧的"开播自动跳 tab"——提示要有, 但不抢走用户正在看的页面 */
function liveCount(p: Platform): number {
  return store.anchors.reduce((n, a) => n + (a.platform === p && a.isLive ? 1 : 0), 0)
}

/** 切平台 = 换平台、留页面: 在录制页切到 SOOP 仍留在录制页, 不把用户甩回直播页。
 *  账号页同规则(它按 ?plat 展示某一方): 从前它不在名单里, 于是「在账号页换平台」会把人踢回直播页,
 *  页面只好自备第二套分段 —— 同屏两套分段就是这次收编的起因 */
function switchPlat(target: Platform): void {
  if (target === plat.value) return
  const page = String(route.name)
  if (page === 'account') {
    router.push({ name: 'account', query: { ...route.query, plat: target } })
    return
  }
  if (['live', 'recordings'].includes(page)) {
    router.push({ name: page, params: { ...route.params, plat: target }, query: route.query })
    return
  }
  router.push({ name: 'live', params: { plat: target } })
}

const tabs = computed(() => [
  { name: 'live', label: t('nav.live') },
  { name: 'recordings', label: t('nav.recordings') },
  // 诊断台不分平台(它同时看两边), 所以跳它的时候不能带 :plat 段 —— 带上也无处安放
  { name: 'diag', label: t('nav.diag') }
])

/** tab 落点: 平台页带 :plat, 诊断台不带 */
function openTab(name: string): void {
  if (name === 'diag') {
    router.push({ name: 'diag' })
    return
  }
  router.push({ name, params: { plat: plat.value } })
}

function tabActive(name: string): boolean {
  if (route.name === name) return true
  // 播放页属于「直播」: 从在播墙点进去再返回, 顶栏不该出现两处高亮搬家
  if (name === 'live' && route.name === 'player') return true
  return false
}

function tabBadge(name: string): number {
  if (name === 'recordings') return store.activeRecs.filter((r) => r.platform === plat.value).length
  return 0
}

/** 监控态胶囊: 每平台各说各话 —— Panda 熔断不遮掉 SOOP 的正常心跳, 反之亦然(状态结构见设计稿 8.2 B) */
const watcherState = computed(() => {
  const w = store.watcher?.byPlatform?.[plat.value]
  if (!w) return { tone: 'idle', text: '—', tip: t('nav.wUnknown') }
  const interval = store.settings?.monitor?.[plat.value]?.pollIntervalSec ?? '?'
  // 首轮还没落地: lastRoundAt 为 null 而 roundMs 还是初值 0 —— 把 0 报成「上次拉取耗时」是读数撒谎,
  // 这一档只报间隔(设计稿; 判据同 「没数的那一格不摆行」)
  const first = w.lastRoundAt === null
  // 耗时恒按秒报(设计稿): 按数量级换单位会让同屏两枚胶囊各说各话(一个「666 毫秒」一个「8.6 秒」),
  // 读的人第一眼比的是单位而不是快慢; 一位小数保住亚秒档的分辨率
  const cost = fmtRoundCost(w.roundMs)
  const heartbeat = first ? t('nav.wTipFirst', { sec: interval }) : t('nav.wTip', { sec: interval, cost })
  if (w.circuitOpen) return { tone: 'bad', text: t('nav.wCooling'), tip: `${w.message} · ${heartbeat}` }
  if (!w.running) return { tone: 'idle', text: t('nav.wStopped'), tip: t('nav.wStoppedTip') }
  if (!w.monitored) return { tone: 'idle', text: t('nav.wIdle'), tip: t('nav.wIdleTip') }
  // 降级轮: 整表那一发读不到, 本轮改逐房问 —— 数还在读, 所以既不是绿点(那一发的便宜没了),
  // 也不是「本轮失败」(那是读不到的口径); 完整那一句在 tooltip 与工作区横幅里
  if (w.degraded) return { tone: 'warn', text: t('nav.wDegraded'), tip: `${w.message} · ${heartbeat}` }
  // message 非空但没熔断 = 这一站在跑但整轮看不见(拉取连续失败): 绿点继续呼吸就是骗人。
  // 胶囊只写「本轮失败」四字: 完整错误码既读不完也会把顶栏撑破最小窗宽
  if (w.message) return { tone: 'warn', text: t('nav.wFailed'), tip: `${w.message} · ${heartbeat}` }
  return {
    tone: 'ok',
    text: first ? t('nav.wHeartFirst', { sec: interval }) : t('nav.wHeart', { sec: interval, cost }),
    tip: heartbeat
  }
})

const keyword = computed({
  get: () => store.searchKeyword,
  set: (v: string) => {
    store.searchKeyword = v
    // 搜索只在「直播」页有落点: 打字时把人带到当前平台的直播页, 但不换平台(跨平台同名房间会混进结果)
    if (v && route.name !== 'live') router.push({ name: 'live', params: { plat: plat.value } })
  }
})

/** 回车/放大镜与打字同一条落点规则: 已在直播页就别再把人甩走 */
function runSearch(): void {
  if (route.name !== 'live') router.push({ name: 'live', params: { plat: plat.value } })
}

/** 头像只代表当前平台(平台身份已由分段给出)。状态文字直接摆在旁边(B4):
 *  tooltip 在截图与触屏里不存在, 而合并口径的"已登录"会让人以为两边都稳 */
const account = computed(() => {
  const a = store.accounts
  if (plat.value === 'soop') {
    const s = a?.soop
    return {
      short: 'S',
      live: !!s?.realLogin,
      held: !!s?.hasCookies,
      stateText: !s ? t('nav.checking') : s.realLogin ? t('nav.loggedIn') : s.hasCookies ? t('nav.unverified') : t('nav.notLoggedIn'),
      tip: !s
        ? t('nav.wUnknown')
        : s.realLogin
          ? t('account.soopDescOk', { id: s.loginId })
          : s.netFail
            ? t('account.netFailTip')
            : s.hasCookies
              ? t('account.soopDescWarn')
              : t('account.soopDescNone')
    }
  }
  const p = a?.pandalive
  return {
    short: 'P',
    live: !!p?.realLogin,
    held: !!p?.loggedIn,
    stateText: !p ? t('nav.checking') : p.realLogin ? t('nav.loggedIn') : p.loggedIn ? t('nav.unverified') : t('nav.notLoggedIn'),
    tip: !p
      ? t('nav.wUnknown')
      : p.realLogin
        ? p.isAdult
          ? t('account.descOkAdult')
          : t('account.descOkNoAdult')
        : p.netFail
          ? t('account.netFailTip')
          : p.loggedIn
            ? t('account.descWarn')
            : t('account.descNone')
  }
})
</script>

<template>
  <header class="drag-region h-[64px] shrink-0 flex items-center bg-card border-b border-line relative z-40 select-none px-4 xl:px-5">
    <!-- logo(纯文字标) -->
    <div class="flex items-center gap-2.5 shrink-0 cursor-pointer" @click="router.push({ name: 'live', params: { plat } })">
      <div class="leading-tight">
        <div class="text-[16px] font-bold text-ink1 tracking-wide">SODALive</div>
        <div class="text-[10px] text-ink3 tracking-[0.2em] -mt-0.5 font-medium">MONITOR</div>
      </div>
    </div>

    <div class="w-px h-6 bg-line mx-4 shrink-0"></div>

    <!-- 平台分段(一级导航): 一个平台一套工作区, 徽标是该平台关注在播数 -->
    <div class="no-drag platseg shrink-0">
      <button
        v-for="p in PLATS"
        :key="p.key"
        class="platbtn"
        :class="[plat === p.key ? 'is-on' : '', p.key === 'soop' ? 'is-soop' : 'is-panda']"
        :title="store.newLiveCount(p.key) ? t('nav.newLiveTip', { n: store.newLiveCount(p.key), plat: p.label }) : t('nav.platTip', { plat: p.label })"
        @click="switchPlat(p.key)"
      >
        <i class="pdot" :class="p.key === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>
        <span>{{ p.label }}</span>
        <span v-if="liveCount(p.key)" class="platn tabular-nums" :class="store.newLiveCount(p.key) ? 'is-new' : ''">{{ liveCount(p.key) }}</span>
      </button>
    </div>

    <!-- 三条页面: 直播工作区 + 录制(库在录制页里, 不另立 tab) + 诊断台 -->
    <nav class="no-drag flex items-stretch self-stretch ml-6 gap-1">
      <button
        v-for="tab in tabs"
        :key="tab.name"
        class="nav-tab px-4 text-[14px] font-medium transition-colors flex items-center"
        :class="tabActive(tab.name) ? 'active text-ink1 font-semibold' : 'text-ink2 hover:text-ink1'"
        @click="openTab(tab.name)"
      >
        {{ tab.label }}
        <span v-if="tabBadge(tab.name)" class="platn ml-1.5 tabular-nums">{{ tabBadge(tab.name) }}</span>
      </button>
    </nav>

    <!-- 居中搜索: min-w 不是装饰 —— 右侧是 shrink-0 的固定段(状态胶囊/账号/窗口控制),
         没有下限的话最小窗宽下被压扁的是搜索框, 溢出的是整条 header -->
    <div class="no-drag flex-1 min-w-[96px] flex justify-center px-3 xl:px-6">
      <div class="relative w-full max-w-[420px]">
        <input
          id="global-search"
          v-model="keyword"
          type="text"
          :placeholder="t('nav.searchPhPlat', { plat: platformName(plat) })"
          class="w-full h-10 pl-4 pr-11 rounded-full bg-page text-[13px] text-ink1 placeholder:text-ink3 outline-none border-2 border-transparent focus:border-brand/60 focus:bg-card transition-all"
          @keyup.enter="runSearch"
        />
        <button
          class="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full grid place-items-center text-ink3 hover:text-brand hover:bg-brand/10 transition-colors"
          @click="runSearch"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 监控态 / 账号 / 设置 / 窗口控制 -->
    <div class="no-drag flex items-center gap-1.5 shrink-0">
      <n-tooltip trigger="hover" placement="bottom">
        <template #trigger>
          <div
            class="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold cursor-default max-w-[150px]"
            :class="
              watcherState.tone === 'bad'
                ? 'bg-live/[0.12] text-liveink'
                : watcherState.tone === 'warn'
                  ? 'bg-warn/[0.14] text-warnink'
                  : watcherState.tone === 'ok'
                    ? 'bg-brand/[0.10] text-brand'
                    : 'bg-fill text-ink3'
            "
          >
            <span
              class="w-[7px] h-[7px] rounded-full shrink-0"
              :class="watcherState.tone === 'bad' ? 'bg-live' : watcherState.tone === 'warn' ? 'bg-warn' : watcherState.tone === 'ok' ? 'bg-brand animate-breathe' : 'bg-ink3'"
            ></span>
            <span class="truncate">{{ watcherState.text }}</span>
          </div>
        </template>
        {{ watcherState.tip }}
      </n-tooltip>

      <!-- 当前平台登录态: 点头像进账号页并定位到这一方 -->
      <button
        class="h-9 pl-1 pr-2.5 rounded-full flex items-center gap-2 hover:bg-page transition-colors"
        :title="t('account.title')"
        @click="router.push({ name: 'account', query: { plat } })"
      >
        <span class="relative w-8 h-8 shrink-0 cursor-pointer">
          <n-tooltip trigger="hover" placement="bottom">
            <template #trigger>
              <span class="ava" :class="account.live ? (plat === 'soop' ? 'ava-soop' : 'ava-panda') : account.held ? 'ava-held' : 'ava-none'">{{
                account.short
                }}</span>
            </template>
            {{ account.tip }}
          </n-tooltip>
          <!-- 状态点: 已登录绿 / 有 Cookie 但未过官方校验琥珀 -->
          <span
            v-if="account.live || account.held"
            class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-card"
            :class="account.live ? 'bg-okink' : 'bg-warn'"
          ></span>
        </span>
        <span class="text-[11.5px] shrink-0" :class="account.live ? 'text-ink1 font-medium' : account.held ? 'text-warnink' : 'text-ink3'">{{ account.stateText }}</span>
      </button>

      <button
        class="w-9 h-9 rounded-full grid place-items-center text-ink2 hover:bg-page hover:text-ink1 transition-colors"
        @click="router.push({ name: 'settings' })"
        :title="t('nav.settings')"
      >
        <svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      <div class="w-px h-5 bg-line mx-1.5"></div>

      <div class="flex items-center">
        <button class="w-10 h-8 grid place-items-center text-ink3 hover:bg-page rounded-md transition-colors" @click="api.winControl('min')">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" /></svg>
        </button>
        <button class="w-10 h-8 grid place-items-center text-ink3 hover:bg-page rounded-md transition-colors" @click="api.winControl('max')">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
        </button>
        <button class="w-10 h-8 grid place-items-center text-ink3 hover:bg-liveink hover:text-white rounded-md transition-colors" @click="api.winControl('close')">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* 平台分段: 整条是胶囊轨道, 选中项抬卡面底 + 一级阴影。
   选中态的文字用平台身份深色(--plat-*-ink), 不是"当前项"高亮色:
   选 SOOP 时显示 Panda 粉等于用 A 平台的颜色代表 B 平台(设计稿 0.2 判定)。 */
.platseg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: rgb(var(--c-fill));
}
.platbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 13px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: rgb(var(--c-ink2));
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}
.platbtn:hover {
  color: rgb(var(--c-ink1));
}
.platbtn.is-on {
  background: rgb(var(--c-card));
  box-shadow: 0 1px 2px var(--shadow-card);
}
.platbtn.is-on.is-panda {
  color: var(--plat-panda-ink);
}
.platbtn.is-on.is-soop {
  color: var(--plat-soop-ink);
}
.platn {
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgb(var(--c-live) / 0.14);
  color: rgb(var(--c-live-ink));
  font-size: 10.5px;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* 新开播未读: 淡底徽标撑不起"该看点什么"的分量, 这里改实心 + 呼吸(与卡片「直播中」同一语言)。
   实心底取 live-ink 而非 live: 白字压 #e5484d 只有 3.91:1, 10.5px 数字不达标; 压 #b02a31/#c4333a = 6.5/5.4:1 */
.platn.is-new {
  background: rgb(var(--c-live-ink));
  color: #fff;
  animation: breathe 1.6s ease-in-out infinite;
}
/* 头像底是平台身份色且两主题不换值, 所以字形墨色恒定(白字压 #fb7299 只有约 2.75:1) */
.ava {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 800;
  user-select: none;
  box-shadow: 0 0 0 2px rgb(var(--c-card)), 0 0 0 3px rgb(var(--c-line));
}
.ava-panda {
  background: var(--plat-panda);
  color: #171a1f;
}
.ava-soop {
  background: var(--plat-soop);
  color: var(--plat-soop-accent);
}
.ava-held {
  background: rgb(var(--c-warn));
  color: #171a1f;
}
.ava-none {
  background: rgb(var(--c-fill));
  color: rgb(var(--c-ink3));
}
</style>
