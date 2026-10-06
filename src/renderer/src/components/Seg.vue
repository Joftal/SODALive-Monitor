<script setup lang="ts" generic="T extends string | number | boolean">
/** 分段选择(设置页五处「多选一」的统一承载面)。
 *  naive 的 radio-button 是描边方盒 + 主色描边选中, 与全站「填充容器 + 瓷片选中」是两套语言
 *  (左导航选中、视图分段都是 bg-card/shadow-card 或 brand 淡底), 故自绘一档, 选中态与左导航同档。
 *  T 泛型是为了让 v-model 直接吃窄联合(form.watchMode 之类): 收成 string 会逼调用方在模板里写断言。 */
const props = defineProps<{
  modelValue: T
  options: { value: T; label: string }[]
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: T): void }>()
</script>

<template>
  <div class="inline-flex items-center gap-0.5 p-0.5 rounded-ctl bg-fill" role="radiogroup">
    <button
      v-for="o in props.options"
      :key="String(o.value)"
      type="button"
      role="radio"
      :aria-checked="props.modelValue === o.value"
      class="h-7 px-2.5 rounded-md text-[12.5px] font-medium transition-colors active:scale-[0.98]"
      :class="
        props.modelValue === o.value
          ? 'bg-card text-ink1 font-semibold shadow-card'
          : 'text-ink2 hover:text-ink1 hover:bg-fillh'
      "
      @click="emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>
