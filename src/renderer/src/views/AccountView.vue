<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NButton, NInput, useMessage, NPopconfirm } from 'naive-ui'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import SpinIcon from '@/components/SpinIcon.vue'
import { isPlatform, platformName, type Platform } from '@shared/types'
import { resolveWorkspace } from '@/workspace'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

const store = useAppStore()
const message = useMessage()
const route = useRoute()
const dataDir = ref('')

/** 两套登录态互不影响: 本页一次只讲一方, 由 ?plat= 决定是哪一方。
 *  切方走顶栏分段(它现在会在本页原地换 query), 页内不再自备第二套分段。
 *  地址里没带 plat 时与顶栏同源(当前工作区), 否则会出现"顶栏指 SOOP、页面演 Panda" */
const plat = ref<Platform>(isPlatform(route.query.plat) ? (route.query.plat as Platform) : resolveWorkspace())

// 已经在本页时点顶栏头像/分段只改 query(路由复用组件, 不会重跑 setup): 不跟着切就等于点了没反应
watch(
  () => route.query.plat,
  (v) => {
    if (isPlatform(v)) plat.value = v as Platform
  }
)

onMounted(async () => {
  dataDir.value = await api.appDataDir()
})

const winLoading = ref(false)
const cookieInput = ref('')
const importLoading = ref(false)
const credUser = ref('')
const credPass = ref('')
const credLoading = ref(false)

/** 两条低频兜底默认收起: 全展开时这一屏要滚两屏, 而第一次登录的人只需要顶行那枚按钮 */
const openCookie = ref(false)
const openManaged = ref(false)

/** 兜底方式各填各的 Cookie: 换平台时收起面板并清空粘贴串, 否则"A 平台的 Cookie 按着 B 平台的导入键"只隔一次误点 */
watch(plat, () => {
  openCookie.value = false
  openManaged.value = false
  cookieInput.value = ''
})

const isSoop = computed(() => plat.value === 'soop')
/** 登录窗真正打开的是哪一站: 实测 SOOP 的 play 子域只是跳转页, 与其含糊说"官方登录页", 不如把域名摆出来 */
const loginSite = computed(() => (isSoop.value ? 'www.sooplive.com' : 'www.pandalive.co.kr'))

/** 当前平台的登录态(Panda 看 sessKey + login_info, SOOP 看会话罐 + LOGIN_ID) */
const acc = computed(() => {
  const a = store.accounts
  if (!a) return null
  return isSoop.value
    ? { realLogin: a.soop.realLogin, held: a.soop.hasCookies, netFail: a.soop.netFail, adult: false, idx: null as number | null, id: a.soop.loginId, verifyAt: a.soop.lastVerifyAt }
    : { realLogin: a.pandalive.realLogin, held: a.pandalive.loggedIn, netFail: a.pandalive.netFail, adult: a.pandalive.isAdult, idx: a.pandalive.userIdx, id: '', verifyAt: a.pandalive.lastVerifyAt }
})

const status = computed(() => {
  const a = acc.value
  // 态还没回来只能是「正在校验」: 冷启动不再等官方接口, 把 null 报成未登录会凭空吓人去重登
  if (!a) {
    return {
      mode: 'checking' as const,
      title: t('account.stChecking'),
      dot: 'bg-deco',
      tile: 'bg-fill text-deco',
      desc: t('account.checkingDesc'),
      badge: null
    }
  }
  if (a.realLogin) {
    return {
      mode: 'ok' as const,
      title: t('account.stOk'),
      dot: 'bg-ok animate-breathe',
      tile: 'bg-ok/10 text-okink',
      desc: isSoop.value ? t('account.soopDescOk', { id: a.id }) : a.adult ? t('account.descOkAdult') : t('account.descOkNoAdult'),
      badge: !isSoop.value && a.adult ? t('account.badgeAdult') : null
    }
  }
  if (a.held) {
    return {
      mode: 'warn' as const,
      title: t('account.stWarn'),
      dot: 'bg-warn animate-breathe',
      tile: 'bg-warnbg text-warnink',
      desc: a.netFail ? t('account.netFailTip') : isSoop.value ? t('account.soopDescWarn') : t('account.descWarn'),
      badge: null
    }
  }
  return {
    mode: 'none' as const,
    title: t('account.stNone'),
    dot: 'bg-deco',
    tile: 'bg-fill text-deco',
    desc: isSoop.value ? t('account.soopDescNone') : t('account.descNone'),
    badge: null
  }
})

async function refresh(): Promise<void> {
  store.accounts = await api.authState()
}

/** 「上次校验 MM-DD HH:mm」: 官方最后一次真实答复的时刻, 不是"页面最后刷新时刻" */
const lastVerifyText = computed(() => {
  const ms = acc.value?.verifyAt || 0
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

const recheckLoading = ref(false)

/** 立即向官方重发一次校验(绕过主进程结果缓存), 三态之一如实回显 */
async function recheck() {
  recheckLoading.value = true
  try {
    store.accounts = await api.authRecheck(plat.value)
    // netFail 时既不是"已登录"也不是"会话未认证" —— 请求本身没成, 报状态会把它读成服务端判死
    const outcome = acc.value?.netFail ? t('account.recheckNetFail') : status.value.title
    message.info(t('account.recheckResult', { state: outcome }))
  } catch (e) {
    message.error(String((e as Error).message || e))
  } finally {
    recheckLoading.value = false
  }
}

async function loginByWindow() {
  winLoading.value = true
  try {
    const r = await api.authOpenWindow(plat.value)
    r.ok ? message.success(r.message) : message.info(r.message)
    await refresh()
  } catch (e) {
    message.error(String((e as Error).message || e))
  } finally {
    winLoading.value = false
  }
}

async function importCookies() {
  if (!cookieInput.value.trim()) {
    message.warning(t('account.mCEmpty'))
    return
  }
  importLoading.value = true
  try {
    const r = await api.authImportCookies(cookieInput.value.trim(), plat.value)
    r.ok ? message.success(r.message) : message.error(r.message)
    if (r.ok) cookieInput.value = ''
    await refresh()
  } catch (e) {
    message.error(t('account.failImport') + String((e as Error).message || e))
  } finally {
    importLoading.value = false
  }
}

async function logout() {
  try {
    await api.authLogout(plat.value)
    await refresh()
    message.success(t('account.loggedOut'))
  } catch (e) {
    message.error(String((e as Error).message || e))
  }
}

/** SOOP 专有: 托管账密后, 取流撞 -6 由主进程后台重登一次; 账号传空串 = 解除托管 */
const managedUser = ref('')
const managed = computed(() => !!managedUser.value)
watch(
  () => store.accounts?.soop.credentialUser || '',
  (u) => {
    managedUser.value = u
    if (credUser.value !== u) credUser.value = u
  },
  { immediate: true }
)

async function saveCredentials() {
  if (!credUser.value.trim() || !credPass.value) {
    message.warning(t('account.mDEmpty'))
    return
  }
  credLoading.value = true
  try {
    const r = await api.authSaveSoopCredentials(credUser.value.trim(), credPass.value)
    r.ok ? message.success(r.message) : message.error(r.message)
    if (r.ok) credPass.value = ''
    await refresh()
  } catch (e) {
    message.error(String((e as Error).message || e))
  } finally {
    credLoading.value = false
  }
}

async function clearCredentials() {
  try {
    const r = await api.authSaveSoopCredentials('', '')
    message[r.ok ? 'success' : 'error'](r.message)
    credPass.value = ''
    await refresh()
  } catch (e) {
    message.error(String((e as Error).message || e))
  }
}
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto">
    <div class="max-w-[980px] mx-auto px-7 pt-5 pb-6">
      <!-- 页头: 「账号」+ 这一方是谁。换平台是顶栏分段的职责, 页内再摆一套同功能分段就是上一版杂乱的第一处 -->
      <div class="flex items-center gap-2.5">
        <h1 class="page-h">{{ t('account.title') }}</h1>
        <span class="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-full bg-fill text-[12px] font-semibold text-ink2 shrink-0">
          <i class="pdot" :class="isSoop ? 'pdot-soop' : 'pdot-panda'"></i>{{ platformName(plat) }}
        </span>
      </div>
      <div class="text-[12px] text-ink3 mt-1">{{ t('account.sub') }}</div>

      <!-- 密钥降级: 页顶阻断式告警(设计稿 S9 ④)。原先埋在 SOOP 方式 C 的第三行小字里,
           而那句"凭据经系统安全存储加密"在降级态就是假话, 必须在看到假话之前先看到更正 -->
      <div v-if="store.settings && !store.settings.secretsEncrypted" class="mt-4 rounded-ctl border border-warn/45 bg-warnbg px-[14px] py-3 flex items-start gap-2.5">
        <svg class="w-[17px] h-[17px] text-warnink shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.6 2.9 20h18.2z"/><path stroke-linecap="round" d="M12 10v4.2M12 17.2h.01"/></svg>
        <div class="text-[12px] text-warnink leading-relaxed min-w-0">{{ t('account.vaultDown') }}</div>
      </div>

      <!-- ① 状态: 一行读完(身份/结论/怎么办), 动作与校验时刻收到右列同一竖排 —— 上一版把校验轨单独铺成第二行,
           未登录时那一行又整行消失, 同一张卡在两平台间换了形状 -->
      <div class="mt-4 bg-card rounded-card shadow-card px-[18px] py-4 flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-ctl grid place-items-center shrink-0 transition-colors" :class="status.tile">
          <svg v-if="status.mode === 'warn'" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.6 2.9 20h18.2z"/><path stroke-linecap="round" d="M12 10v4.2M12 17.2h.01"/></svg>
          <svg v-else-if="status.mode !== 'ok'" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M6.5 12h11"/></svg>
          <svg v-else class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12a4.4 4.4 0 100-8.8 4.4 4.4 0 000 8.8zM4.5 20.4c1-4.1 4.2-6.1 7.5-6.1s6.5 2 7.5 6.1a.9.9 0 01-.88 1.1H5.38a.9.9 0 01-.88-1.1z"/>
          </svg>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="w-[7px] h-[7px] rounded-full shrink-0" :class="status.dot"></span>
            <span class="text-[15px] font-bold text-ink1">{{ status.title }}</span>
            <span v-if="status.mode === 'ok' && acc?.idx" class="text-[12px] text-ink3">uid {{ acc.idx }}</span>
            <span v-else-if="status.mode === 'ok' && acc?.id" class="text-[12px] text-ink3">{{ acc.id }}</span>
            <!-- 只有「成人认证」是真的状态徽章; 「加密存储」是恒定宣称不是状态, 已并入页底一句话 -->
            <span v-if="status.badge" class="badge badge-md bg-ok/10 text-okink">{{ status.badge }}</span>
          </div>
          <div class="text-[12px] text-ink3 mt-0.5">{{ status.desc }}</div>
        </div>
        <div class="ml-auto shrink-0 flex flex-col items-end gap-1.5">
          <!-- 复检在校验中也留着: 冷启动卡住时这是唯一的主动出口 -->
          <div v-if="status.mode !== 'none'" class="flex items-center gap-2">
            <n-button size="small" secondary :disabled="recheckLoading" @click="recheck" class="!min-w-[112px]">
              <span class="inline-flex items-center justify-center gap-1"><SpinIcon v-if="recheckLoading" :size="12" />{{ t('account.recheck') }}</span>
            </n-button>
            <!-- 退出只在「确实有会话」时给: 校验中或确实未登录时摆一枚红色退出按钮是空承诺 -->
            <n-popconfirm v-if="status.mode === 'ok' || status.mode === 'warn'" @positive-click="logout">
              <template #trigger>
                <n-button size="small" tertiary type="error">{{ t('account.logout') }}</n-button>
              </template>
              {{ isSoop ? t('account.logoutConfirmSoop') : t('account.logoutConfirm') }}
            </n-popconfirm>
          </div>
          <span v-if="status.mode === 'ok' || status.mode === 'warn'" class="text-[11px] text-ink3">
            {{ lastVerifyText ? t('account.lastVerify', { time: lastVerifyText }) : t('account.neverVerified') }}
          </span>
        </div>
      </div>

      <!-- ② 登录方式: 一屏只留一张动作卡。主方式直接给按钮, 两条低频兜底收成一行, 步骤与输入框展开才出现 -->
      <div class="flex items-baseline gap-2.5 px-1 mt-5 mb-2">
        <h2 class="sec-h">{{ t('account.methods') }}</h2>
        <span class="text-[11px] text-ink3 ml-auto">{{ t('account.methodsHint') }}</span>
      </div>

      <section class="bg-card rounded-card shadow-card px-[18px]">
        <!-- A 网页登录 -->
        <div class="py-4 flex items-center gap-3.5">
          <span class="w-[30px] h-[30px] rounded-ctl grid place-items-center text-ink2 bg-fill shrink-0">
            <svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>
          </span>
          <div class="min-w-0">
            <h3 class="text-[14px] font-bold text-ink1">{{ t('account.mB') }}</h3>
            <p class="text-[12px] text-ink3 mt-0.5">{{ t('account.mBDesc', { site: loginSite }) }}</p>
          </div>
          <!-- 档位锁的是下限不是死宽: 英文「Open login window」在 112px 里被裁成「Open login wind」(实机英文渲染抓到的), 定宽只会裁掉翻译 -->
          <n-button size="small" type="primary" :disabled="winLoading" @click="loginByWindow" class="ml-auto shrink-0 !min-w-[112px]">
            <span class="inline-flex items-center justify-center gap-1"><SpinIcon v-if="winLoading" :size="12" />{{ t('account.mBBtn') }}</span>
          </n-button>
        </div>

        <!-- B Cookie 导入 -->
        <div class="border-t border-line/60 py-4">
          <button type="button" class="w-full flex items-center gap-3.5 text-left" @click="openCookie = !openCookie">
            <span class="w-[30px] h-[30px] rounded-ctl grid place-items-center text-ink2 bg-fill shrink-0">
              <svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="4" width="14" height="17" rx="2.5"/><path stroke-linecap="round" d="M9 4.5V3h6v1.5M9 10h6M9 13.5h6M9 17h4"/></svg>
            </span>
            <span class="min-w-0">
              <span class="block text-[14px] font-bold text-ink1">{{ t('account.mC') }}</span>
              <span class="block text-[12px] text-ink3 mt-0.5">{{ t('account.mCDesc') }}</span>
            </span>
            <svg class="w-4 h-4 text-ink3 shrink-0 ml-auto transition-transform" :class="openCookie ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
          </button>
          <div v-if="openCookie" class="mt-3 grid md:grid-cols-[46%_1fr] gap-4">
            <ol class="space-y-2">
              <li class="flex gap-2.5 items-start">
                <span class="w-[18px] h-[18px] rounded-full grid place-items-center text-[10.5px] font-bold text-brand bg-brand/[0.10] shrink-0 mt-px">1</span>
                <span class="text-[12px] text-ink2 leading-relaxed">{{ t('account.mCS1a') }}<span class="text-brand font-semibold">{{ loginSite }}</span>{{ t('account.mCS1b') }}</span>
              </li>
              <li class="flex gap-2.5 items-start">
                <span class="w-[18px] h-[18px] rounded-full grid place-items-center text-[10.5px] font-bold text-brand bg-brand/[0.10] shrink-0 mt-px">2</span>
                <span class="text-[12px] text-ink2 leading-relaxed">{{ t('account.mCS2a') }}<code class="bg-fill border border-line rounded-md px-1 text-[11px] font-mono text-brand">F12</code>{{ t('account.mCS2b') }}<code class="bg-fill border border-line rounded-md px-1 text-[11px] font-mono text-brand">document.cookie</code>{{ t('account.mCS2c') }}</span>
              </li>
            </ol>
            <div class="flex flex-col">
              <n-input
                v-model:value="cookieInput"
                type="textarea"
                :rows="4"
                :placeholder="isSoop ? t('account.soopCookiePh') : 'sessKey=xxxx; 79b0c6d4…=xxxx; partner=pandatv; ...'"
              />
              <div class="flex items-center gap-2.5 mt-2.5">
                <span class="text-[11px] text-ink3">{{ t('account.mCImportNote') }}</span>
                <n-button size="small" secondary :disabled="!cookieInput.trim() || importLoading" @click="importCookies" class="ml-auto shrink-0 !min-w-[112px]">
                  <span class="inline-flex items-center justify-center gap-1"><SpinIcon v-if="importLoading" :size="12" />{{ t('account.mCBtn') }}</span>
                </n-button>
              </div>
            </div>
          </div>
        </div>

        <!-- C 账密自动重登(SOOP 专有, 与 Panda"只留网页登录/Cookie"的取向刻意不同) -->
        <div v-if="isSoop" class="border-t border-line/60 py-4">
          <button type="button" class="w-full flex items-center gap-3.5 text-left" @click="openManaged = !openManaged">
            <span class="w-[30px] h-[30px] rounded-ctl grid place-items-center text-ink2 bg-fill shrink-0">
              <svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a4 4 0 10-3.9 4H7.5A3.5 3.5 0 004 14.5V17a3 3 0 003 3h9a3 3 0 003-3v-.5"/><path stroke-linecap="round" d="M17 7h.01"/></svg>
            </span>
            <span class="min-w-0">
              <span class="block text-[14px] font-bold text-ink1">{{ t('account.mD') }}</span>
              <span class="block text-[12px] text-ink3 mt-0.5">{{ t('account.mDDesc') }}</span>
            </span>
            <!-- 托管与否是这一行的状态, 折叠时也要看得见: 只写在展开面板里就等于"不点进去不知道自己托管过" -->
            <span v-if="managed" class="text-[11.5px] font-semibold text-okink shrink-0">{{ t('account.mDManaged', { id: managedUser }) }}</span>
            <svg class="w-4 h-4 text-ink3 shrink-0 ml-auto transition-transform" :class="openManaged ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
          </button>
          <div v-if="openManaged" class="mt-3">
            <div class="flex items-center gap-2.5">
              <n-input v-model:value="credUser" size="small" :placeholder="t('account.mDUser')" class="!w-[180px]" />
              <n-input v-model:value="credPass" size="small" type="password" :placeholder="t('account.mDPass')" class="flex-1" />
              <n-button size="small" secondary :disabled="credLoading || !credUser.trim() || !credPass" @click="saveCredentials" class="shrink-0 !min-w-[112px]">
                <span class="inline-flex items-center justify-center gap-1"><SpinIcon v-if="credLoading" :size="12" />{{ t('account.mDBtn') }}</span>
              </n-button>
              <n-popconfirm v-if="managed" @positive-click="clearCredentials">
                <template #trigger>
                  <n-button size="small" tertiary type="error">{{ t('account.mDClear') }}</n-button>
                </template>
                {{ t('account.mDClearConfirm') }}
              </n-popconfirm>
            </div>
            <p class="text-[11px] text-ink3/80 mt-2.5">{{ t('account.mDSecure') }}</p>
          </div>
        </div>
      </section>

      <!-- 全页只在这里说一次「存在哪、怎么加密」: 副标题/徽章/方式 C 脚注各说一遍是同一个承诺复读三遍 -->
      <p class="text-center text-[11px] text-ink3/80 mt-4 break-all">
        {{ t('account.doorNote', { dir: dataDir || '…' }) }}
      </p>
    </div>
  </div>
</template>
