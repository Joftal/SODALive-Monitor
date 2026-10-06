<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import Hls from 'hls.js'
import { api } from '@/api'

const props = defineProps<{ src: string; autoplay?: boolean }>()
const emit = defineEmits<{
  (e: 'fatal'): void
  (e: 'url-dead'): void
}>()

const videoEl = ref<HTMLVideoElement | null>(null)
let hls: Hls | null = null
/** 网络类致命错误的重试上限: 上限存在的意义是让循环有终点, 见 load 里那段计数 */
const NET_RETRY_MAX = 3

function destroy(): void {
  hls?.destroy()
  hls = null
}

function load(src: string): void {
  destroy()
  const video = videoEl.value
  if (!video || !src) return
  if (Hls.isSupported()) {
    // 重试预算不在这里配: hls.js 1.x 里那三枚 *LoadingMaxRetry 旧字段已是死的(只留在默认值表里,
    // 实际预算来自 loadPolicy: 清单 2 发 / 分片 4~6 发), 写在此处只会骗到下一个人。
    // 本层要管的只有 NET_RETRY_MAX —— 它封顶的是"致命错误之后我们再武装一次 startLoad"的那个外层循环。
    hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      liveSyncDurationCount: 3
    })
    hls.loadSource(src)
    hls.attachMedia(video)
    // 网络重试有上限: startLoad 每次调用都把 hls.js 自己的重试计数重新武装一遍,
    // 于是"致命网络错误 → startLoad → 又致命"是一条没有终点的循环 —— 源已经死了(断流/令牌过期但没回 403/404)
    // 时, 它会每几发片段时长一次地无限重连。上限 3 次后转交 url-dead: 上层把源清空、显示手动重试,
    // 循环因此有终点(时效代价为零: 那三次本来就什么都没播出来)。清单解析成功即重新给满预算。
    let netRetry = 0
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      netRetry = 0
      // 档位/编码入档: 播放异常时的第一手现场(Codec 不支持/清单空档皆可从此看出)
      api.rendererLog(
        'info',
        `hls 清单解析: levels=${data.levels.length} codecs=[${data.levels.map((l) => l.attrs?.CODECS || '?').join(',')}]`
      )
      video.play().catch(() => undefined)
    })
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return
      // 诊断入主日志(源 URL 的 token 在 query 里, 只记 pathname; text 可能含服务端判决)
      const u = String((data as { url?: unknown }).url || '')
      api.rendererLog(
        'warn',
        `hls 致命错误: ${data.type}/${data.details} http=${data.response?.code ?? '-'} url=${u.split('?')[0].slice(-60)} text=${String(data.response?.text ?? '').slice(0, 200)}`
      )
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // 403/404 = 播放令牌失效, 上抛让上层换源; 其余网络错误本层重试, 但只重试这么多次
        const code = data.response?.code
        if (code === 403 || code === 404 || data.details === 'manifestLoadError') {
          emit('url-dead')
        } else if (netRetry < NET_RETRY_MAX) {
          netRetry++
          hls?.startLoad()
        } else {
          api.rendererLog('warn', `hls 网络重试满 ${NET_RETRY_MAX} 次: 上抛换源, 不再无限重连已死的源`)
          emit('url-dead')
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls?.recoverMediaError()
      } else {
        emit('url-dead')
      }
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src
    video.play().catch(() => undefined)
  } else {
    emit('fatal')
  }
}

watch(
  () => props.src,
  (v) => {
    if (v) load(v)
  }
)

onMounted(() => {
  if (props.src) load(props.src)
})

onUnmounted(destroy)
</script>

<template>
  <video ref="videoEl" class="w-full h-full bg-black" :autoplay="autoplay" controls playsinline></video>
</template>
