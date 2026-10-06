<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { imgSrc } from '@shared/imgUrl'

// 头像的唯一画法: 有地址且取到了才占槽位, 否则由调用方的兜底(首字母/剪影)顶上。
// 加载失败是预期内的一档 —— SOOP 的 logo 地址是频道 ID 的函数(官方播放页自己也带 onerror),
// 没传过头像的房就是 404; 把浏览器的破图画在圆位上, 比这个位置空着更难看。
// 地址一律过 imgSrc: stimg 官方只给 max-age=60, 比用户切一次工作区的节奏还短,
// 于是这枚 1.5MB 的 logo 每切一次就要重下一遍; 翻成 plocal://img/… 之后由主进程在本机答。
// 翻不了的空串与别的域原样交回, 404 兜底那一路一字未改(主进程那边把 404 如实回成 404)。
defineOptions({ inheritAttrs: false })

const props = defineProps<{ src: string; lazy?: boolean }>()
const failed = ref(false)
watch(
  () => props.src,
  () => (failed.value = false)
)
const shown = computed(() => imgSrc(props.src || ''))
const show = computed(() => !!shown.value && !failed.value)
</script>

<template>
  <img v-if="show" v-bind="$attrs" :src="shown" :loading="lazy ? 'lazy' : 'eager'" referrerpolicy="no-referrer" decoding="async" @error="failed = true" />
  <slot v-else />
</template>
