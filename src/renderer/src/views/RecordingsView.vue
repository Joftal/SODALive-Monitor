<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NEmpty, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import { baseName, fmtBytes, fmtClock, fmtDur, fmtDurHMS, isSingleFileTask } from '@/utils/media'
import LibrarySection from '@/components/LibrarySection.vue'
import PlatTag from '@/components/PlatTag.vue'
import { platformName, roomKey, type Platform, type RecTask } from '@shared/types'
import { imgSrc } from '@shared/imgUrl'
import { resolveWorkspace } from '@/workspace'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const router = useRouter()

const diskFree = ref(0)
const tick = ref(0)
let timer: number | null = null

onMounted(async () => {
  timer = window.setInterval(() => {
    tick.value++
    if (tick.value % 30 === 0) void api.recDiskFree().then((v) => (diskFree.value = v))
  }, 1000)
  diskFree.value = await api.recDiskFree()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// ---- 实时码率/下载速度: 复用 2s 任务推送做字节差分(纯前端, 零请求) ----
const rates = ref<Record<string, number>>({}) // 房间主键 -> bytes/s
let prevSnap: Record<string, { bytes: number; at: number }> = {}
// 差分窗口只能按「字节真的长了」推进: bytes 由主进程每 2s stat 一次, 推送却按状态变更随时发。
// 按推送间隔算, 同一 stat 窗口内的两次推送读出 0 Mbps、跨两个窗口的读出双倍 —— 实测 8.4 Mbps
// 的稳流会在 0.0 / 8.4 / 17.8 / 26.1 之间跳, 读数全是采样噪声
watch(
  () => store.recordings,
  (list) => {
    const now = Date.now()
    const next: typeof prevSnap = {}
    const out: Record<string, number> = {}
    for (const task of list) {
      const k = roomKey(task.platform, task.userId)
      const p = prevSnap[k]
      if (p) {
        if (task.bytes > p.bytes) {
          out[k] = (task.bytes - p.bytes) / ((now - p.at) / 1000)
          next[k] = { bytes: task.bytes, at: now }
        } else {
          // 三个 stat 周期(6s)都没长字节才是真的没在写; 窗口未满则沿用上一读数, 不拿 0 冒充停播
          if (now - p.at >= 6000) out[k] = 0
          else if (k in rates.value) out[k] = rates.value[k]
          next[k] = p
        }
      } else next[k] = { bytes: task.bytes, at: now } // 首帧只记基线, 读数留 '—'
    }
    prevSnap = next
    rates.value = out
  }
)
/** 直播录制 → Mbps; 回放下载 → MB/s */
function fmtRate(task: RecTask): string {
  const v = rates.value[roomKey(task.platform, task.userId)]
  if (v === undefined) return '—'
  return task.vod ? `${(v / 1048576).toFixed(1)}` : `${((v * 8) / 1e6).toFixed(1)}`
}

const fmtDurSec = fmtDurHMS

// ---- 概览 ----
// 这一页没有平台 tab: 录制是跨平台的资源页(磁盘闸门与字节总量都是应用级的), 而且它没有
// 「在播/发现/离线」那种视图, 少一层筛选反而少一种"上面的筛选只管上面"的歧义。
// 平台身份由每张卡的 PlatTag 与下方监控总览的分行承担。
// props.plat 只往下传给「库」分段用: 库有自己的一方筛选, 与本页的在录列表不是同一口径。
const props = defineProps<{ plat?: string }>()
const active = computed(() => store.activeRecs)
const activeBytes = computed(() => store.activeRecs.reduce((s, task) => s + (task.bytes || 0), 0))
const diskLow = computed(() => diskFree.value < (store.settings?.diskLimitGb ?? 1) * 2)
const diskCaption = computed(() => {
  const limit = store.settings?.diskLimitGb ?? 1
  if (diskFree.value < limit) return t('rec.diskDanger')
  return diskLow.value ? t('rec.diskWarn') : t('rec.diskFull')
})
const splitMin = computed(() => Math.round((store.settings?.splitSeconds ?? 900) / 60))
// 分段时长只作用于直播管线(VOD 是单 TS 直出, recorder.ts 的 spawn 分支写死的),
// 全是回放时还挂「分段 N 分钟/段」就是假信息 → 这一栏留空, 由模板收掉分隔线。
// 不分段(splitSeconds=0)时它同样是一句假话, 改口成"整场单文件"。
// 磁盘状态不在这里复读: 概览条第三格已经给了 GB 数, 低于阈值另有页头告警枚
const splitOff = computed(() => (store.settings?.splitSeconds ?? 900) === 0)
const secCaption = computed(() => {
  if (!active.value.some((task) => !task.vod)) return ''
  return splitOff.value ? t('rec.segOff') : t('rec.segInfo', { min: splitMin.value })
})

// ---- VOD 进度 ----
function vodTotalLabel(task: RecTask): string {
  if (!task.vodTotalSec) return ''
  return task.vodTotalSec < 3600 ? `~${Math.round(task.vodTotalSec / 60)} ${t('common.min')}` : `~${fmtDurSec(task.vodTotalSec)}`
}
/** 下载完成度(0-100): 分母是 m3u8 清单算出的估算全长, 不是猜的 —— vodTotalSec 拉取失败为 0,
 *  那种任务画一条永远不动的 0% 空条比不画更骗人, 所以返回 null 让调用方退回文字 */
function vodPct(task: RecTask): number | null {
  if (!task.vodTotalSec) return null
  return Math.min(100, Math.round(((task.vodDoneSec || 0) / task.vodTotalSec) * 100))
}

/** 跳转到任务对应的直播间/回放间(PlayerView 自治拉源; 录制中的源已在缓存, 秒开零请求; 与录制进程互不影响) */
function enterRoom(task: RecTask): void {
  void router.push({ name: 'player', params: { plat: task.platform, userId: task.userId } })
}

// ---- 管线阶段指示: 告诉用户任务在"哪一棒"、还有多少棒要跑(替代裸进度条, 收尾期不再像卡死) ----
interface PipeStage {
  key: NonNullable<RecTask['stage']>
  label: string
}
/** 阶段清单: 随任务类型(vod/直播)与设置(autoMp4/mergeMp4 决定收尾有没有转码/合并棒)动态拼 */
function pipeStages(task: RecTask): PipeStage[] {
  const st = store.settings
  const out: PipeStage[] = [
    { key: 'fetch', label: t(task.vod ? 'rec.pipeFetchVod' : 'rec.pipeFetch') },
    { key: 'recording', label: t(task.vod ? 'rec.pipeDownload' : 'rec.pipeRecord') },
    { key: 'stopping', label: t('rec.pipeStop') }
  ]
  if (st?.autoMp4) out.push({ key: 'remux', label: t('rec.pipeRemux') })
  // 合并棒只在真会跑合并时挂出来: 回放没有分段, 而「不分段」那一档整场就一个文件 ——
  // finalize 的合并分支(multi-segment 门槛)永不进入, 把它画成第四棒 = 承诺一个不会发生的阶段
  if (!task.vod && st?.autoMp4 && st?.mergeMp4 && st?.splitSeconds !== 0) out.push({ key: 'merge', label: t('rec.pipeMerge') })
  return out
}
/** 当前所处阶段下标; stage 缺失(旧推送而在)或清单中找不到(录制中改了设置) → 维持"进行中"位 */
function pipeCur(task: RecTask): number {
  const i = pipeStages(task).findIndex((s) => s.key === (task.stage || 'recording'))
  return i < 0 ? 1 : i
}

async function stop(task: RecTask) {
  await api.recStop(task.platform, task.userId)
  message.success(t('rec.stopped'))
}
async function openFolder(dir: string) {
  // 静默失败等于「按钮坏了」: 主进程只在目录真的打开后才回 true, false 要说出来
  if (!(await api.recOpenFolder(dir))) message.error(t('rec.openDirFail'))
}

// ---- 监控总览(页头三件事之一) ----
// 「为什么没录上」的根因绝大多数在监控侧(没在轮询/登录失效/撞风控), 只报录制数字会让人以为软件坏了。
// 两平台各自一行: 轮询节奏与覆盖面对方完全不同, 合并成一个数字等于不说。
const watchRows = computed(() =>
  (['pandalive', 'soop'] as Platform[]).map((p) => {
    const w = store.watcher?.byPlatform?.[p]
    return {
      plat: p,
      monitored: w?.monitored ?? 0,
      // 在播取关注列表的实况(anchors.isLive)而不是本轮探测数: 后者只在轮询那一刻为真
      live: store.anchors.filter((a) => a.platform === p && a.isLive).length,
      at: w?.lastRoundAt ? fmtClock(w.lastRoundAt) : '—',
      running: !!w?.running,
      cooling: !!w?.circuitOpen,
      // 与顶栏胶囊同一判据: 这一站在跑但整轮看不见(拉取连续失败)。页头继续亮红心跳点+时间戳,
      // 就等于同一屏上顶栏说「本轮失败」、这里说一切正常
      failed: !!w?.message && !w.circuitOpen
    }
  })
)

// ---- 快捷入口: 这一页做不了的事(挑房间开录)与随时要够得到的东西(保存目录/录制参数) ----
const qPlat = computed<Platform>(() => resolveWorkspace())
const savePath = computed(() => store.settings?.savePath || '')
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 min-h-0 overflow-y-auto px-7 pb-6">
      <!-- 撑满视口的列: 无数据时这一页只有「进行中」一只空盒子, 让它长到铺满剩余高度,
           下半屏大片留白看起来才像「这一栏是空的」而不是「页面坏了」 -->
      <div class="min-h-full flex flex-col">
      <!-- ① 页头: 与直播页同一几何 —— 标题在左、概览与入口在右, 监控总览贴在标题下方(同一阅读起点)。
           数字只在概览条出现一次: 副行原来复读「N 路进行中 · 已写入 X」, 与概览条同屏两套同样的人话。 -->
      <div class="flex items-start gap-6 pt-5 pb-1">
        <div class="flex-1 min-w-0">
          <h1 class="page-h">{{ t('rec.title') }}</h1>
          <!-- 刷新口径写在页头: 这一页的数字全是 2s 推送 + 前端差分, 不说清就会被当成秒级实况 -->
          <p class="page-sub">{{ t('rec.pageSub') }}</p>
          <!-- 磁盘不够是「这一页接下来会失败」的前置原因, 必须常驻页头: 这句告警原本只出现在任务行脚注里, 而没有任务在录时那一行根本不存在(设计稿 7.2) -->
          <div v-if="diskLow" class="flex items-center gap-2 mt-2">
            <span class="badge badge-md bg-warn/[0.14] text-warnink">{{ diskCaption }}</span>
          </div>
          <!-- 监控总览: 两平台各一行(轮询节奏与覆盖面对方完全不同, 合成一个数字等于不说) -->
          <div class="mt-2.5 flex flex-col gap-1">
            <div v-for="r in watchRows" :key="r.plat" class="text-[11.5px] text-ink3 flex items-center gap-1.5 tabular-nums">
              <span
                class="w-[7px] h-[7px] rounded-full shrink-0"
                :class="!r.running ? 'bg-deco' : r.cooling || r.failed ? 'bg-warn' : 'bg-live'"
              ></span>
              <span class="text-ink2 font-semibold">{{ platformName(r.plat) }}</span>
              <span>{{ t('rec.monN', { n: r.monitored }) }}</span>
              <span class="text-ink3/50">·</span>
              <span>{{ t('rec.monLiveN', { n: r.live }) }}</span>
              <span class="text-ink3/50">·</span>
              <span :class="r.cooling || r.failed ? 'text-warnink' : ''">
                {{ !r.running ? t('rec.monStopped') : r.cooling ? t('rec.monCooling') : r.at }}
              </span>
              <template v-if="r.failed">
                <span class="text-ink3/50">·</span>
                <span class="text-warnink">{{ t('nav.wFailed') }}</span>
              </template>
            </div>
          </div>
        </div>
        <div class="shrink-0 flex flex-col items-end gap-2">
          <!-- 概览条: 恒为全局口径(已写字节总量与磁盘闸门是应用级的, 不随下面的平台筛选缩小) -->
          <div class="flex items-stretch bg-card rounded-card shadow-card overflow-hidden divide-x divide-line/70">
            <div class="px-5 py-2 min-w-[100px]">
              <div class="text-[11px] text-ink3 flex items-center gap-1.5">
                <span class="w-[7px] h-[7px] rounded-full bg-live" :class="store.activeRecs.length ? 'animate-breathe' : ''"></span>{{ t('rec.ovActive') }}
              </div>
              <div class="text-[19px] font-extrabold leading-tight tabular-nums" :class="store.activeRecs.length ? 'text-liveink' : 'text-ink1'">
                {{ t('rec.ovActiveN', { n: store.activeRecs.length }) }}
              </div>
            </div>
            <div class="px-5 py-2 min-w-[100px]">
              <div class="text-[11px] text-ink3">{{ t('rec.ovBytes') }}</div>
              <div class="text-[19px] font-extrabold leading-tight tabular-nums text-ink1">{{ fmtBytes(activeBytes) }}</div>
            </div>
            <div class="px-5 py-2 min-w-[100px]">
              <div class="text-[11px] text-ink3">{{ t('rec.ovDisk') }}</div>
              <div class="text-[19px] font-extrabold leading-tight tabular-nums" :class="diskLow ? 'text-warnink' : 'text-ink1'">
                {{ diskFree.toFixed(1) }}<span class="text-[11px] font-medium text-ink3 ml-1">GB</span>
              </div>
            </div>
          </div>
          <!-- 快捷入口: 这一页不能挑房间开录, 但必须能一步够到直播页/落盘目录/录制参数 -->
          <div class="flex items-center gap-2">
            <n-button size="small" tertiary @click="router.push({ name: 'live', params: { plat: qPlat } })">{{ t('rec.qLive') }}</n-button>
            <!-- 空 savePath 不等于「没有保存目录」: 录制一律落默认录制根, 这一枚就开那个根
                 (主进程按同一口径解析并补建目录)。原来这里把它当成"没设"跳去设置页, 用户点的是
                 「打开保存目录」却被甩到别处 —— 改目录的入口是旁边那枚「录制设置」 -->
            <n-button size="small" tertiary @click="openFolder(savePath)">{{ t('rec.openSaveDir') }}</n-button>
            <n-button size="small" tertiary @click="router.push({ name: 'settings', query: { sec: 'record' } })">{{ t('rec.qSettings') }}</n-button>
          </div>
        </div>
      </div>

      <!-- ② 进行中 · 大卡片 -->
      <div class="sec-bar">
        <h2 class="sec-h">
          <span class="w-[7px] h-[7px] rounded-full bg-live" :class="active.length ? 'animate-breathe' : ''"></span>{{ t('rec.secActive') }}
          <span class="sec-n">{{ active.length }}</span>
        </h2>
        <span v-if="secCaption" class="w-px h-4 bg-line mx-0.5"></span>
        <span v-if="secCaption" class="sec-tools">{{ secCaption }}</span>
      </div>

      <div v-if="active.length" class="space-y-3.5">
        <div
          v-for="task in active"
          :key="task.id"
          class="relative bg-card rounded-card border border-line shadow-card hover:shadow-card-hover transition-shadow duration-150 px-5 pt-[18px] pb-4 overflow-hidden"
        >
          <div class="flex items-center gap-4">
            <!-- 直播间封面 + 呼吸点(无封面时回退昵称首字) -->
            <div class="relative shrink-0">
              <img
                v-if="task.thumbUrl"
                :src="imgSrc(task.thumbUrl)"
                class="block w-14 h-14 rounded-ctl object-cover"
                referrerpolicy="no-referrer"
              />
              <div
                v-else
                class="w-14 h-14 rounded-ctl grid place-items-center text-[21px] font-bold"
                :class="task.vod ? 'bg-brand/[0.10] text-brand' : 'bg-live/10 text-liveink'"
              >
                {{ Array.from(task.nick)[0] }}
              </div>
              <span
                class="absolute -right-[3px] -bottom-[3px] w-3.5 h-3.5 rounded-full ring-[2.5px] ring-card animate-breathe"
                :class="task.vod ? 'bg-brand' : 'bg-live'"
              ></span>
            </div>
            <!-- 信息列 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-[16px] font-extrabold text-ink1 truncate">{{ task.nick }}</span>
                <span v-if="task.vod" class="badge badge-sm bg-brand/[0.10] text-brand">{{ t('rec.tagVod') }}</span>
                <span v-else class="badge badge-sm bg-live/10 text-liveink">{{ t('rec.tagLive') }}</span>
                <!-- 自动触发不是异常也不是状态机一档: 用中性徽标(设计稿 S4 草图的「自动」格), 不占状态色 -->
                <span v-if="task.auto" class="badge badge-sm bg-fill text-ink2 border border-line">{{ t('rec.tagAuto') }}</span>
                <!-- 平台徽标: 两平台主播可能同名, 卡面只有昵称会录错人(封面仅 56px 方形放不下文字徽标, 留在卡头)。
                     整行统一 sm 档 —— R2「同一视野只允许一档」, 与左侧状态徽标同高 -->
                <PlatTag :platform="task.platform" size="sm" surface="onsurf" />
              </div>
              <div class="text-[12.5px] text-ink2 truncate mt-1" :title="task.title">{{ task.title || '—' }}</div>
              <div class="text-[11px] text-ink3 truncate mt-0.5 font-mono">{{ baseName(task.dirPath) }}/{{ baseName(task.currentFile) || '…' }}</div>
            </div>
            <!-- 指标簇 -->
            <div class="text-right shrink-0 tabular-nums">
              <div class="text-[22px] font-extrabold leading-none" :class="task.vod ? 'text-brand' : 'text-liveink'">
                <!-- tick>=0 恒真仅作秒级刷新依赖(prevent 首秒渲染裸 0) -->
                {{ task.vod && task.vodDoneSec ? fmtDurSec(task.vodDoneSec) : tick >= 0 && fmtDur(task.startedAt, null) }}
              </div>
              <div class="text-[10.5px] text-ink3 mt-1">{{ task.vod ? t('rec.durVod') : t('rec.durLive') }}</div>
            </div>
            <div class="text-right shrink-0 tabular-nums">
              <div class="text-[22px] font-extrabold leading-none text-ink1">{{ fmtBytes(task.bytes) }}</div>
              <div class="text-[10.5px] text-ink3 mt-1">{{ task.vod || isSingleFileTask(task.currentFile) ? t('rec.writtenOne') : t('rec.writtenLive', { n: task.files.length }) }}</div>
            </div>
            <div class="text-right shrink-0 tabular-nums min-w-[76px]">
              <div class="text-[22px] font-extrabold leading-none text-ink1">
                {{ fmtRate(task) }}<span class="text-[11px] font-medium text-ink3 ml-0.5">{{ task.vod ? 'MB/s' : 'Mbps' }}</span>
              </div>
              <div class="text-[10.5px] text-ink3 mt-1">{{ task.vod ? t('rec.rateVod') : t('rec.rateLive') }}</div>
            </div>
            <!-- 操作: 下限放在列上而不是每枚按钮上 —— 竖排按钮等宽才不参差, 又留出译文自己撑开的余量。
                 96 是英文最长档「Open replay」的实测宽: 定在 88 会让在录行 88 / 回放行 96, 同一列两行左边缘错开 8px -->
            <div class="flex flex-col gap-1.5 shrink-0 ml-2 !min-w-[96px]">
              <n-button size="small" tertiary @click="enterRoom(task)">{{ t(task.vod ? 'rec.enterVod' : 'rec.enterRoom') }}</n-button>
              <n-button v-if="task.vod" size="small" type="error" secondary @click="stop(task)">{{ t('rec.stopVod') }}</n-button>
              <n-button v-else size="small" type="error" @click="stop(task)">{{ t('rec.stop') }}</n-button>
              <n-button size="small" tertiary @click="openFolder(task.dirPath)">{{ t('rec.dir') }}</n-button>
            </div>
          </div>
          <!-- 底部: 管线阶段指示(任务跑在哪一棒、还剩几棒; 收尾期不再像卡死) -->
          <div class="flex items-center gap-3 mt-3.5 pl-[72px] flex-wrap">
            <!-- 单行文本链: 已过=淡灰 / 当前=加粗+呼吸点 / 未跑=幽灵灰; 无芯片无箭头, 信息靠字重与透明度分层 -->
            <div class="flex items-center gap-1.5 flex-wrap text-[11.5px] leading-none">
              <template v-for="(s, i) in pipeStages(task)" :key="s.key">
                <span
                  class="whitespace-nowrap"
                  :class="i < pipeCur(task) ? 'text-ink3/70' : i === pipeCur(task) ? 'text-ink1 font-semibold' : 'text-ink3/40'"
                >
                  <span
                    v-if="i === pipeCur(task)"
                    class="inline-block w-1.5 h-1.5 rounded-full align-[1px] mr-1 animate-breathe"
                    :class="task.vod ? 'bg-brand' : 'bg-live'"
                  ></span>{{ s.label }}<span v-if="i === pipeCur(task) && task.stageTotal" class="text-ink3 tabular-nums font-normal"> {{ task.stageCur }}/{{ task.stageTotal }}</span>
                </span>
                <span v-if="i < pipeStages(task).length - 1" class="text-ink3/30 select-none">→</span>
              </template>
            </div>
            <div class="text-[11px] text-ink3 shrink-0 tabular-nums ml-auto flex items-center gap-2.5">
              <!-- 直播任务这一栏不留全局参数(分段/磁盘已经上移到段标题, 每张卡复读一遍是噪声);
                   回放留真实完成度: 估算全长来自 m3u8 清单(vodTotalSec), 不是猜的百分比,
                   清单拉不到全长时才退回纯文字, 免得画一条永远 0% 的假条 -->
              <template v-if="task.vod">
                <span v-if="vodPct(task) !== null" class="w-[88px] meter" :title="`${vodPct(task)}%`"><i :style="{ width: `${vodPct(task)}%` }"></i></span>
                {{ t('rec.vodCap', { done: fmtDurSec(task.vodDoneSec || 0), total: vodTotalLabel(task) }) }}
              </template>
            </div>
          </div>
        </div>
      </div>
      <!-- 撑满视口的空槽: 内容贴顶而不是居中 —— 居中的小字飘在 570px 的框正中, 与当初反对的
           「整屏一行小字」只是隔了一层边框; 贴顶才读作「这一栏在等任务进来」 -->
      <div v-else class="flex-1 min-h-[200px] rounded-card border border-dashed border-line pt-12 grid items-start justify-center bg-card/40">
        <n-empty :description="t('rec.emptyActive')" size="small" class="text-ink3">
          <template #extra>
            <!-- 只给指引, 不再放第二枚「去直播页」: 页头右上角那枚是同屏唯一的同类入口, 两处并存是重复布线 -->
            <span class="text-[11.5px] text-ink3">{{ t('rec.emptyActiveHint') }}</span>
          </template>
        </n-empty>
      </div>

      <!-- ③ 库: 录完的落地结果就是库, 不再另立「历史任务」这个概念 —— 同一批数据两套说法、两套筛选是自我打脸。
           库也不另立页面: 录制页是它的唯一入口, 地址里的平台段作为库的初始筛选往下传。 -->
      <LibrarySection :plat="props.plat" />
      </div>
    </div>
  </div>
</template>
