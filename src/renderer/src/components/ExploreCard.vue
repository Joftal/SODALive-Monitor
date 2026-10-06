<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { useMessage, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { errText } from '@/utils/media'
import LiveCard, { type LiveCardModel } from '@/components/LiveCard.vue'
import type { DiscoveryItem } from '@shared/types'

const { t } = useI18n()

const props = defineProps<{ item: DiscoveryItem }>()
const store = useAppStore()
const message = useMessage()

const following = computed(() => store.isFollowing('pandalive', props.item.userId))

const model = computed<LiveCardModel>(() => {
  const x = props.item
  return {
    platform: 'pandalive', // 大厅只聚合 pandalive
    userId: x.userId,
    nick: x.nick,
    title: x.title || '',
    thumbUrl: x.thumbUrl || '',
    userImg: x.userImg || '',
    isLive: true, // 大厅条目恒在播
    recording: store.isRecording('pandalive', x.userId),
    srcReady: store.isSrcReady('pandalive', x.userId),
    following: following.value,
    isAdult: x.isAdult,
    isPw: x.isPw,
    isRec: x.liveType === 'rec',
    isFan: x.type === 'fan',
    viewers: x.viewers || 0,
    likes: x.likes || 0,
    fans: x.fans || 0,
    startTime: x.startTime
  }
})

async function toggleFollow(): Promise<void> {
  try {
    if (following.value) {
      await store.unfollow('pandalive', props.item.userId)
      message.success(t('card.unfollowed', { nick: props.item.nick }))
    } else {
      await store.follow('pandalive', props.item.userId)
      message.success(t('card.followed', { nick: props.item.nick }))
    }
  } catch (e) {
    message.error(errText(e))
  }
}
</script>

<template>
  <!-- 大厅只聚合 pandalive(数据源写死), 每卡一枚徽标信息量为 0: 平台身份由页头那枚代表 -->
  <LiveCard :model="model" :show-platform="false">
    <template #hoverActions>
      <n-tooltip trigger="hover" :delay="300"><template #trigger>
        <button
          class="w-8 h-8 rounded-ctl bg-card/95 grid place-items-center shadow-md hover:scale-105 transition-transform"
          :class="following ? 'text-live' : 'text-ink2'"
          @click.stop="toggleFollow"
        >
          <svg class="w-[17px] h-[17px]" viewBox="0 0 24 24" :fill="following ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 21s-7-4.6-9.3-9A5.4 5.4 0 0112 6.3 5.4 5.4 0 0121.3 12C19 16.4 12 21 12 21z"/>
          </svg>
        </button>
      </template>{{ following ? t('card.unfollow') : t('card.follow') }}</n-tooltip>
    </template>
  </LiveCard>
</template>
