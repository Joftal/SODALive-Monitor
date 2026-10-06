<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { api } from '@/api'
import { useAppStore, playDing } from '@/stores/app'
import type { Toast } from '@shared/types'

const { t: tt } = useI18n()
const message = useMessage()
const store = useAppStore()
let off: (() => void) | null = null

onMounted(() => {
  off = api.onToast((t: Toast) => {
    // 应用内提示统一走顶部中间 message 单通道(原右下角 notification 已移除, 与视图操作反馈同位)
    const typeMap: Record<Toast['type'], 'success' | 'info' | 'error' | 'warning'> = {
      live: 'success',
      fanLive: 'warning', // 粉丝房开播: 琥珀色与普通开播区分
      roomChange: 'warning', // 房态变更(转 19+/粉丝房): 琥珀色警示
      offline: 'info',
      rec: 'info',
      error: 'error',
      info: 'info',
      session: 'error' // 会话被服务端作废: 红色警示, 与异常同权重
    }
    // 连接符必须由 i18n 给: 这里曾经是硬编码全角逗号, 英文气泡因此写成 "Title，Body" —— 两种语言各用各自的分隔
    message.create(t.body ? tt('common.toastJoin', { title: t.title, body: t.body }) : t.title, {
      type: typeMap[t.type] || 'info',
      duration: 4500,
      keepAliveOnHover: true
    })
    // 提示音与系统通知同源(D4): 开播行按平台各自的 sound 开关, 下播/录制/异常不出声
    if ((t.type === 'live' || t.type === 'fanLive' || t.type === 'roomChange') && store.settings?.notify[t.platform].live.sound) playDing()
  })
})

onUnmounted(() => off?.())
</script>

<template><div class="hidden"></div></template>
