<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import SpinIcon from '@/components/SpinIcon.vue'
import { parseRoomInput, platformName, type Platform } from '@shared/types'

// ============ 「关注主播」对话框: 一个平台一套, 不做混合入口 ============
// 平台由所在工作区决定(route.params.plat), 对话框自己不摆平台分段 ——
// 「自动识别」那一档要求用户先理解「你粘的东西我们要猜」, 而这一屏用户本来就知道自己在哪一方。
// 粘错平台不再静默按对面入库: 明说是哪一方的, 并交回父级换平台(原文寄存 store.addDraft, 因为换平台会重挂视图)。
// ==================================================================

const props = defineProps<{ show: boolean; platform: Platform }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'added'): void; (e: 'goto-other', raw: string): void }>()

const { t } = useI18n()
const message = useMessage()
const store = useAppStore()

const isSoop = computed(() => props.platform === 'soop')
const otherPlat = computed<Platform>(() => (props.platform === 'soop' ? 'pandalive' : 'soop'))

const raw = ref('')
const busy = ref(false)
// 打开时接住寄存的原文(跨平台出口), 接完即清 —— 下一次手动打开必须是空框
watch(
  () => props.show,
  (v) => {
    if (!v) return
    raw.value = store.addDraft
    store.addDraft = ''
  },
  { immediate: true }
)

const parsed = computed(() => parseRoomInput(raw.value.trim(), props.platform))
/** 输入态五档: 空 / 本平台可寻址 / 粘的是对面平台 / 纯数字场次号(仅 SOOP) / 看不懂。
 *  纯数字在 SOOP 侧单独一档: 它是每次监控重解析的场次号, 进不了库也不该进 */
const state = computed<'empty' | 'ok' | 'other' | 'seq' | 'bad'>(() => {
  const s = raw.value.trim()
  if (!s) return 'empty'
  if (isSoop.value && /^\d+$/.test(s)) return 'seq'
  const p = parsed.value
  if (!p) return 'bad'
  return p.platform === props.platform ? 'ok' : 'other'
})

async function submit(): Promise<void> {
  if (state.value !== 'ok' || busy.value) return
  busy.value = true
  try {
    const a = await api.anchorsAdd(raw.value.trim(), props.platform)
    message.success(t(isSoop.value ? 'add.doneSoop' : 'add.donePanda', { nick: a.nick }))
    emit('update:show', false)
    emit('added')
  } catch (e) {
    message.error((e as Error).message || t('add.fail'))
  } finally {
    busy.value = false
  }
}

/** 去对面平台添加: 原文交回父级 —— 换平台会重挂本视图, 由它寄存草稿并撑开新平台的对话框 */
function gotoOther(): void {
  emit('goto-other', raw.value.trim())
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="isSoop ? t('add.titleSoop') : t('add.titlePanda')"
    class="!w-[460px]"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="space-y-3">
      <p class="text-[12.5px] text-ink2 leading-relaxed">
        <template v-if="isSoop">
          {{ t('add.exampleSoop') }}<br />
          <code class="font-mono text-brand text-[12px]">https://play.sooplive.com/1004ysus/297384679</code>
          <br /><span class="text-ink3">{{ t('add.soopLoginNote') }}</span>
        </template>
        <template v-else>
          {{ t('add.examplePanda') }}<br />
          <code class="font-mono text-brand text-[12px]">https://www.pandalive.co.kr/play/zenith6666</code> {{ t('common.or') }}
          <code class="font-mono text-brand text-[12px]">zenith6666</code>
        </template>
      </p>
      <n-input v-model:value="raw" :placeholder="isSoop ? t('add.phSoop') : t('add.phPanda')" size="large" autofocus @keyup.enter="submit" />
      <div v-if="state === 'ok'" class="text-[12px] text-ink2">
        {{ isSoop ? t('add.idSoop') : t('add.idPanda') }} <span class="font-mono text-ink1">@{{ parsed?.userId }}</span>
      </div>
      <div v-else-if="state === 'other'" class="text-[12px] text-liveink flex items-center gap-1.5 flex-wrap">
        {{ t('add.otherHere', { plat: platformName(otherPlat) }) }}
        <button class="text-brand font-medium" @click="gotoOther">{{ t('add.gotoOther', { plat: platformName(otherPlat) }) }}</button>
      </div>
      <div v-else-if="state === 'seq'" class="text-[12px] text-liveink">{{ t('add.soopSeqOnly') }}</div>
      <div v-else-if="state === 'bad'" class="text-[12px] text-liveink">{{ t('add.invalid') }}</div>
      <div class="flex justify-end gap-2 pt-1">
        <n-button class="!min-w-[88px]" @click="emit('update:show', false)">{{ t('monitor.cancel') }}</n-button>
        <n-button type="primary" :disabled="state !== 'ok' || busy" class="!min-w-[88px]" @click="submit">
          <span class="inline-flex items-center justify-center gap-1.5">
            <SpinIcon v-if="busy" />{{ isSoop ? t('add.confirmSoop') : t('add.confirmPanda') }}
          </span>
        </n-button>
      </div>
    </div>
  </n-modal>
</template>
