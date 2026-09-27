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

function destroy(): void {
  hls?.destroy()
  hls = null
}

function load(src: string): void {
  destroy()
  const video = videoEl.value
  if (!video || !src) return
  if (Hls.isSupported()) {
    hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 4
    })
    hls.loadSource(src)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
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
        // 403/404 = 播放令牌失效, 上抛让上层换源; 其余网络错误本层重试
        const code = data.response?.code
        if (code === 403 || code === 404 || data.details === 'manifestLoadError') {
          emit('url-dead')
        } else {
          hls?.startLoad()
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
