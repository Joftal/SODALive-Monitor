<script setup lang="ts">
import { computed } from 'vue'
import { NPopover, NSwitch } from 'naive-ui'
import type { Anchor, Platform } from '@shared/types'
import { roomUrl } from '@shared/types'
import { useAppStore } from '@/stores/app'
import { api } from '@/api'
import { useI18n } from 'vue-i18n'
import LiveCard, { type LiveCardModel } from '@/components/LiveCard.vue'

const { t } = useI18n()

const props = defineProps<{ anchor: Anchor; showPlatform?: boolean }>()
const emit = defineEmits<{ (e: 'remove', platform: Platform, userId: string): void }>()
const store = useAppStore()

const model = computed<LiveCardModel>(() => {
  const a = props.anchor
  return {
    platform: a.platform,
    userId: a.userId,
    nick: a.nick,
    title: a.title || '',
    thumbUrl: a.thumbUrl || '',
    userImg: a.userImg || '',
    isLive: !!a.isLive,
    recording: store.isRecording(a.platform, a.userId),
    srcReady: store.isSrcReady(a.platform, a.userId),
    isAdult: a.tags?.isAdult,
    isPw: a.tags?.isPw,
    isRec: a.tags?.liveType === 'rec',
    isFan: a.tags?.type === 'fan',
    viewers: a.viewerCount || 0,
    likes: a.likes || 0,
    fans: a.fans || 0,
    startTime: a.startTime
  }
})

async function setAuto(v: boolean): Promise<void> {
  await api.anchorsSetAuto(props.anchor.platform, props.anchor.userId, v)
  await store.reloadAnchors()
}
</script>

<template>
  <LiveCard :model="model" :show-platform="props.showPlatform !== false">
    <template #meta>
      <n-popover trigger="click" placement="bottom-end" :show-arrow="false">
        <template #trigger>
          <button class="w-7 h-7 rounded-ctl grid place-items-center text-ink3 hover:text-ink1 hover:bg-fill/70 transition-colors shrink-0" @click.stop>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
          </button>
        </template>
        <div class="py-1 w-44">
          <div class="px-3 py-2 flex items-center justify-between text-[12.5px] text-ink1">
            <span>{{ t('monitor.autoRecTitle') }}</span>
            <n-switch size="small" :value="props.anchor.autoRecord" @update:value="setAuto" />
          </div>
          <!-- 菜单里的动作一律 button: 用 div+cursor-pointer 装按钮, 键盘 Tab 到不了, 而「取消关注」在离线行上本来是可聚焦的按钮 -->
          <button class="w-full px-3 py-2 text-left text-[12.5px] text-ink2 hover:bg-fillh transition-colors" @click="api.openExternal(roomUrl(model.platform, model.userId))">
            {{ t('monitor.openInBrowser') }}
          </button>
          <button class="w-full px-3 py-2 text-left text-[12.5px] text-liveink hover:bg-live/10 transition-colors" @click="emit('remove', model.platform, model.userId)">
            {{ t('card.unfollow') }}
          </button>
        </div>
      </n-popover>
    </template>
  </LiveCard>
</template>
