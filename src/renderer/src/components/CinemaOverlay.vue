<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import SpinIcon from '@/components/SpinIcon.vue'
import { baseName as fname, fmtBytes, fmtDur, mergeableTask } from '@/utils/media'
import type { RecHistoryItem } from '@shared/types'

// ============ 影院浮层(视频库点播) ============
// 全屏磨砂玻璃覆盖层: 重模糊背景 + 玻璃面板
//   顶栏: 返回 / 标题 / 文件数 / 关闭(点播面不展示任何状态加工徽标)
//   主体: 左侧播放器(舞台与右栏等高, 画面 object-contain) | 右侧信息 k-v + 分段列表 + 操作行
// 仅播放 MP4(plocal 协议); 合并按钮仅在可合并时出现
// ==========================================

const props = defineProps<{ show: boolean; task: RecHistoryItem | null }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'merge', task: RecHistoryItem): void }>()

const { t } = useI18n()
const message = useMessage()
const store = useAppStore()
const current = ref('')
const playError = ref('')

const files = computed(() => (props.task?.files || []).filter((f) => f.toLowerCase().endsWith('.mp4')))
const canMerge = computed(() => (props.task ? mergeableTask(props.task) : false))

// ---- 分段级删除(回收站): 行内二段确认 ----
const delSegTarget = ref('')
const delSegBusy = ref(false)
async function onDeleteSegment(): Promise<void> {
  const h = props.task
  const f = delSegTarget.value
  if (!h || !f || delSegBusy.value) return
  delSegBusy.value = true
  try {
    const r = await api.recDeleteFile(h.id, f)
    if (r.ok) {
      message.success(t('rec.delSegDone'))
      delSegTarget.value = ''
    } else {
      message.error(t('rec.delFail', { msg: r.error || 'unknown' }))
      delSegTarget.value = ''
    }
    await store.refreshHistory()
  } finally {
    delSegBusy.value = false
  }
}

// ---- 删除(移入回收站): 二段确认, 与磨砂同风格 ----
const confirmDel = ref(false)
const deleting = ref(false)
const mediaFiles = computed(() => (props.task?.files || []).filter((f) => /\.(mp4|ts)$/i.test(f)))
const delHintText = computed(() => {
  const h = props.task
  if (!h) return ''
  return mediaFiles.value.length ? t('rec.delHint', { n: mediaFiles.value.length, size: fmtBytes(h.bytes) }) : t('rec.delNone')
})
async function onDelete(): Promise<void> {
  const h = props.task
  if (!h || deleting.value) return
  deleting.value = true
  try {
    const r = await api.recDelete(h.id)
    if (r.ok) {
      message.success(t('rec.delDone', { n: r.deletedFiles, size: fmtBytes(r.freedBytes) }))
      confirmDel.value = false
      emit('update:show', false)
      await store.refreshHistory()
    } else {
      message.error(t('rec.delFail', { msg: r.error || 'unknown' }))
      confirmDel.value = false
      await store.refreshHistory()
    }
  } finally {
    deleting.value = false
  }
}

watch(
  () => [props.show, props.task?.id],
  () => {
    if (props.show) {
      current.value = files.value[0] || ''
      playError.value = ''
      confirmDel.value = false
      deleting.value = false
      delSegTarget.value = ''
      delSegBusy.value = false
    }
  },
  { immediate: true }
)
watch(current, () => {
  playError.value = ''
})
// 文件集变化(删段/合并/对账): 当前播放段没了 → 自动切到可用段
watch(files, (list) => {
  if (props.show && list.length && !list.includes(current.value)) current.value = list[0]
})

const src = computed(() => (props.show && current.value ? api.localFileUrl(current.value) : ''))

function onVideoError(): void {
  // 某一段失效(外部删除/损坏) → 自动跳下一段; 全灭才报错
  const i = files.value.indexOf(current.value)
  if (i >= 0 && i < files.value.length - 1) {
    current.value = files.value[i + 1]
    return
  }
  playError.value = t('playback.err')
}
// 状态徽标: 播放界面(点播浮层)不展示任何收尾状态加工状态——对"已入库条目"全是噪音
// (库列表卡片上的角标不受影响, 属另一显示面)
const avgMbps = computed(() => {
  const h = props.task
  if (!h || !h.endedAt) return ''
  const sec = Math.max(1, Math.floor((h.endedAt - h.startedAt) / 1000))
  return ((h.bytes * 8) / 1e6 / sec).toFixed(1)
})

/** 信息面板行 */
const infoRows = computed(() => {
  const h = props.task
  if (!h) return []
  const rows: { label: string; value: string; cls?: string }[] = [
    { label: t('library.anchor'), value: h.nick },
    { label: t('library.time'), value: new Date(h.startedAt).toLocaleString() },
    { label: t('rec.durLabel'), value: fmtDur(h.startedAt, h.endedAt) },
    { label: t('rec.sizeLabel'), value: fmtBytes(h.bytes) },
    { label: 'Mbps', value: avgMbps.value },
    { label: t('playback.segsLabel'), value: t('playback.nMp4', { n: files.value.length }) }
  ]
  return rows
})

function openDir(): void {
  if (props.task?.dirPath) void api.recOpenFolder(props.task.dirPath)
}
</script>

<template>
  <teleport to="body">
    <transition name="fade">
      <!-- 磨砂玻璃遮罩: 重模糊 + 轻微饱和提升, 底下界面朦胧透出。
           这里的 bg-black/55|25|80 是刻意的: 影院是一间黑房, 两主题都要黑, 所以它不接 --c-* 令牌板
           (换成 bg-onimg 会让浅色主题下的遮罩变灰, 视频两侧发灰就是脏); 只有"压在图片上的小承载面"才走令牌。 -->
      <div
        v-if="show"
        class="fixed inset-0 z-50 bg-black/55 backdrop-blur-2xl backdrop-saturate-150 flex flex-col text-white/90"
        @click.self="emit('update:show', false)"
      >
        <!-- 顶栏(玻璃条) -->
        <div class="shrink-0 flex items-center gap-3 px-5 h-[56px] bg-black/25 backdrop-blur-md border-b border-white/10">
          <button
            class="flex items-center gap-1.5 h-8 px-2.5 rounded-ctl text-[12.5px] text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            @click="emit('update:show', false)"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M15 6l-6 6 6 6"/></svg>
            {{ t('library.backToLib') }}
          </button>
          <div class="flex-1 min-w-0 flex items-center gap-2.5">
            <div class="text-[15px] font-bold text-white truncate" :title="task?.title">{{ task?.title || '—' }}</div>
            <span class="shrink-0 badge badge-md bg-white/10 border border-white/10 text-white/85">{{ task?.nick }}</span>
          </div>
          <span class="badge badge-md bg-white/5 border border-white/10 text-white/60 tabular-nums">{{ t('playback.nMp4', { n: files.length }) }}</span>
          <button
            class="w-8 h-8 rounded-ctl grid place-items-center bg-white/10 hover:bg-white/20 border border-white/10 text-white/80 transition-colors"
            @click="emit('update:show', false)"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <!-- 主体: 居中大容器, 左舞台右栏 -->
        <div class="flex-1 min-h-0 w-full max-w-[1500px] mx-auto flex gap-5 px-6 py-5">
          <!-- 视频舞台: 容器与右侧信息栏等高(stretch), 画面 object-contain 黑底留边居中 -->
          <div class="flex-1 min-w-0 rounded-card overflow-hidden bg-black/80 border border-white/10 shadow-2xl relative">
            <video v-if="src && !playError" :key="src" :src="src" controls autoplay class="w-full h-full object-contain" @error="onVideoError"></video>
            <div v-else class="w-full h-full grid place-items-center text-[12.5px] text-white/50">
              {{ playError || t('playback.noMp4') }}
            </div>
          </div>

          <!-- 右侧栏: 玻璃面板纵向排列 -->
          <aside class="w-[280px] shrink-0 flex flex-col gap-3 min-h-0">
            <!-- 信息 k-v -->
            <div class="rounded-card bg-white/[0.06] backdrop-blur-md border border-white/10 px-4 py-3.5">
              <div class="text-[12px] font-bold text-white mb-1">{{ t('library.info') }}</div>
              <div v-for="(r, i) in infoRows" :key="i" class="flex justify-between items-baseline gap-3 text-[11.5px] py-[5px]" :class="i ? 'border-t border-white/5' : ''">
                <span class="text-white/45 shrink-0">{{ r.label }}</span>
                <span class="text-white/90 font-medium truncate text-right" :class="[r.cls || '', r.label ? 'tabular-nums' : '']" :title="r.value">{{ r.value }}</span>
              </div>
            </div>

            <!-- 分段列表(>1 时出现, 余量生长) -->
            <div v-if="files.length > 1" class="rounded-card bg-white/[0.06] backdrop-blur-md border border-white/10 px-3 py-3 flex-1 min-h-0 overflow-y-auto">
              <div class="text-[12px] font-bold text-white mb-1.5 px-1">{{ t('playback.segs', { n: files.length }) }}</div>
              <template v-for="(f, i) in files" :key="f">
                <!-- 行内二段确认 -->
                <div
                  v-if="delSegTarget === f"
                  class="w-full flex items-center gap-2 px-2.5 py-[7px] rounded-ctl bg-errdark/12 border border-errdark/30 text-[11.5px] text-errdark"
                >
                  <span class="truncate min-w-0">{{ t('rec.delSegQ') }}</span>
                  <span class="ml-auto flex items-center gap-1 shrink-0">
                    <button
                      class="h-[22px] px-2 rounded-md bg-liveink hover:bg-liveink/90 disabled:opacity-60 text-white text-[10.5px] font-bold inline-flex items-center gap-1 transition-colors"
                      :disabled="delSegBusy"
                      @click="onDeleteSegment"
                    ><SpinIcon v-if="delSegBusy" class="w-2.5 h-2.5" />✓</button>
                    <button
                      class="h-[22px] px-2 rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-60 text-white/80 text-[10.5px] transition-colors"
                      :disabled="delSegBusy"
                      @click="delSegTarget = ''"
                    >✕</button>
                  </span>
                </div>
                <!-- 分段行(hover 露出删除) -->
                <div
                  v-else
                  class="group w-full flex items-center gap-2 px-2.5 py-[7px] rounded-ctl text-[11.5px] transition-colors text-left cursor-pointer"
                  :class="f === current ? 'bg-brand/30 border border-brand/50 text-white font-semibold' : 'text-white/70 hover:bg-white/8 border border-transparent'"
                  :title="fname(f)"
                  @click="current = f"
                >
                  <span class="text-white/40 text-[10.5px] tabular-nums shrink-0">#{{ i + 1 }}</span>
                  <span class="truncate min-w-0">{{ fname(f) }}</span>
                  <span
                    class="ml-auto shrink-0 w-[18px] h-[18px] grid place-items-center rounded-md text-white/35 hover:text-errdark hover:bg-errdark/20 opacity-0 group-hover:opacity-100 transition-all"
                    @click.stop="delSegTarget = f"
                  >
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </span>
                </div>
              </template>
            </div>

            <!-- 操作行(吸底): 合并文案长 → 独占整行防换行; 打开目录/删除并排 -->
            <div v-if="!confirmDel" class="flex flex-col gap-2 shrink-0 mt-auto">
              <button
                v-if="canMerge"
                class="w-full h-[34px] rounded-ctl bg-brand hover:bg-brand-hi text-white text-[12px] font-semibold whitespace-nowrap transition-all active:scale-[0.97]"
                @click="emit('merge', task!)"
              >{{ t('rec.actMerge') }}</button>
              <div class="flex gap-2">
                <button
                  class="flex-1 h-[34px] rounded-ctl bg-white/10 hover:bg-white/20 border border-white/10 text-white/90 text-[12px] font-medium whitespace-nowrap transition-all active:scale-[0.97]"
                  @click="openDir"
                >{{ t('rec.actDir') }}</button>
                <button
                  class="flex-1 h-[34px] rounded-ctl bg-errdark/12 hover:bg-errdark/20 border border-errdark/30 text-errdark text-[12px] font-medium whitespace-nowrap transition-all active:scale-[0.97]"
                  @click="confirmDel = true"
                >{{ t('rec.delAct') }}</button>
              </div>
            </div>
            <!-- 删除二段确认: 与浮层同风格磨砂玻璃, 红描边示意危险 -->
            <div v-else class="shrink-0 mt-auto rounded-card bg-white/[0.06] backdrop-blur-md border border-errdark/30 px-3.5 py-3">
              <div class="flex items-start gap-2.5">
                <svg class="w-4 h-4 text-errdark shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                <div class="flex-1 min-w-0">
                  <div class="text-[12px] font-bold text-errdark">{{ t('rec.delQ') }}</div>
                  <div class="text-[11px] text-white/55 mt-0.5 leading-relaxed">{{ delHintText }}</div>
                </div>
              </div>
              <div class="flex gap-2 mt-3">
                <button
                  class="flex-1 h-[34px] rounded-ctl bg-liveink hover:bg-liveink/90 disabled:opacity-60 text-white text-[12px] font-semibold transition-all inline-flex items-center justify-center gap-1.5 active:scale-[0.97]"
                  :disabled="deleting"
                  @click="onDelete"
                >
                  <SpinIcon v-if="deleting" class="w-3 h-3" />
                  {{ t('rec.delConfirm') }}
                </button>
                <button
                  class="flex-1 h-[34px] rounded-ctl bg-white/10 hover:bg-white/20 border border-white/10 text-white/90 text-[12px] font-medium transition-all active:scale-[0.97]"
                  :disabled="deleting"
                  @click="confirmDel = false"
                >{{ t('rec.delCancel') }}</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </transition>
  </teleport>
</template>
