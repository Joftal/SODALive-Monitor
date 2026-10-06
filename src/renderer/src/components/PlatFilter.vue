<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { platformName, type Platform } from '@shared/types'

// 全应用唯一的"页内选平台"控件: 监控墙筛选 / 库 共用同一形态(设计稿第②屏 P4: 一个控件一个长相)。
// 账号页从前也挂一枚, 与顶栏分段同屏并存 → 已收归顶栏; 关注弹窗那枚(带「自动识别」)也已撤 —— 平台由所在工作区决定
type Opt = 'all' | Platform

const props = withDefaults(
  defineProps<{
    modelValue: string
    values?: Opt[]
    /** 传了就渲染计数, 与选项同位 */
    counts?: Record<string, number>
  }>(),
  { values: () => ['all', 'pandalive', 'soop'] }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: Opt): void }>()
const { t } = useI18n()

function label(v: Opt): string {
  if (v === 'all') return t('monitor.platAll')
  return platformName(v)
}

/** 色点承担平台身份, 与 PlatTag 同源: 尺寸与描边环走全局 .pdot(见 styles.css),
 *  浅色底那层环是 SOOP 黄压白卡 1.43:1 的唯一补救, 不在本组件重画一遍 */
function platDotCls(v: Opt): string {
  return v === 'soop' ? 'pdot-soop' : 'pdot-panda'
}
</script>

<template>
  <div class="flex items-center gap-2">
    <button
      v-for="v in values"
      :key="v"
      class="pf"
      :class="modelValue === v ? 'is-on' : ''"
      @click="emit('update:modelValue', v)"
    >
      <i v-if="v === 'pandalive' || v === 'soop'" class="pdot" :class="platDotCls(v)"></i>
      <span>{{ label(v) }}</span>
      <span v-if="counts" class="pf__n">{{ counts[v] ?? 0 }}</span>
    </button>
  </div>
</template>

<style scoped>
.pf {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 11px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid rgb(var(--c-line));
  background: rgb(var(--c-card));
  color: rgb(var(--c-ink2));
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.pf:hover {
  border-color: rgb(var(--c-ink3));
  color: rgb(var(--c-ink1));
}
/* 选中态只加粗+中性底, 不改成 Panda 粉: 选中 "SOOP" 时用 Panda 的身份色表达"当前项",
   等于用 A 平台的颜色代表 B 平台(设计稿第②屏的判定)。平台身份只由色点承担。 */
.pf.is-on {
  background: rgb(var(--c-fillh));
  border-color: rgb(var(--c-ink3));
  color: rgb(var(--c-ink1));
  font-weight: 700;
}
.pf__n {
  font-size: 11px;
  opacity: 0.65;
}
</style>
