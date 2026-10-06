<script setup lang="ts">
import { computed } from 'vue'
import { platformName, type Platform } from '@shared/types'

// 全应用唯一的平台身份标记(设计稿 docs/design/sodalive-ia-v1.html 原则 1/2: 平台色只表身份、色彩不做唯一编码)
// 识别由文字承担, 色点只是余光强化: 转灰度/色觉障碍下不失效
const props = withDefaults(
  defineProps<{
    platform: Platform
    /** R2 两档: sm=卡片墙与列表行, md=页头与卡头(同一视野只允许一档) */
    size?: 'sm' | 'md'
    /** onimg=压在封面上, onsurf=贴在卡面/列表上; 两档只差底色, 文字与形状一致 */
    surface?: 'onimg' | 'onsurf'
  }>(),
  { size: 'md', surface: 'onsurf' }
)

const cls = computed(() => [`pt--${props.size}`, `pt--${props.surface}`, props.platform === 'soop' ? 'is-soop' : 'is-panda'])
</script>

<template>
  <span class="plat-tag" :class="cls">
    <i class="pdot pdot-sm" :class="platform === 'soop' ? 'pdot-soop' : 'pdot-panda'"></i>{{ platformName(platform) }}
  </span>
</template>

<style scoped>
.plat-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  font-weight: 800;
  white-space: nowrap;
  letter-spacing: 0.01em;
  flex: none;
}
.pt--md {
  height: 21px;
  padding: 0 7px;
  font-size: 11px;
}
.pt--sm {
  height: 18px;
  padding: 0 6px;
  font-size: 10.5px;
  border-radius: 5px;
  gap: 4px;
}

/* 图片上: 墨底白字(白字压 #fb7299 只有约 2.9:1, 故底色选中性深色而非品牌色) */
.pt--onimg {
  background: var(--tag-onimg);
  color: #fff;
  backdrop-filter: blur(3px);
}
/* 卡面上: 浅底墨字, 深色主题随 --c-fill/--c-ink1 自动换值, 组件不写 dark: 分支 */
.pt--onsurf {
  background: rgb(var(--c-fill));
  border: 1px solid rgb(var(--c-line));
  color: rgb(var(--c-ink1));
}
.pt--onsurf.is-panda {
  color: var(--plat-panda-ink);
}
.pt--onsurf.is-soop {
  color: var(--plat-soop-ink);
}
/* 色点的尺寸/描边环走全局 .pdot .pdot-sm(SOOP 黄压白卡 1.43:1 靠 ink3 实描边勾边),
   本组件只负责承载面与文字墨色 */
</style>
