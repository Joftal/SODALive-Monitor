<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NTooltip, useMessage } from 'naive-ui'
import { api } from '@/api'
import { useI18n } from 'vue-i18n'
import { type Platform } from '@shared/types'
import { imgSrc } from '@shared/imgUrl'
import { fmtLiveDuration, fmtNum } from '@/utils/media'
import PlatTag from '@/components/PlatTag.vue'
import AvatarImg from '@/components/AvatarImg.vue'

// ============ 统一直播间卡片(大厅/已关注共用) ============
// AnchorCard 与 ExploreCard 历史两套近乎逐行重复的模板收敛至此:
//   - 通过归一化 model(props) 驱动; 差异操作走 slots
//   - slot=hoverActions: 缩略图右下悬浮操作(如关注心形)
//   - slot=meta:        第二行右侧扩展(如关注卡的 ⋯ 菜单)
// ======================================================

export interface LiveCardModel {
  platform: Platform
  userId: string
  nick: string
  title: string
  thumbUrl: string
  userImg: string
  isLive: boolean
  recording: boolean
  /** 已获取有效直播源(播放源缓存命中): 卡片绿色「秒开」徽标 */
  srcReady?: boolean
  following?: boolean
  isAdult?: boolean
  isPw?: boolean
  isRec?: boolean
  isFan?: boolean
  viewers: number
  likes: number
  fans: number
  startTime?: string
}

const props = withDefaults(defineProps<{ model: LiveCardModel; /** 整屏只有一个平台时(大厅/已关注筛选到单平台)徽标是重复信息, 由调用方关掉 */ showPlatform?: boolean }>(), { showPlatform: true })
const router = useRouter()
const message = useMessage()
const { t, locale } = useI18n()

const m = computed(() => props.model)
const isZh = computed(() => locale.value === 'zh-CN')
const liveDuration = computed(() => (m.value.isLive ? fmtLiveDuration(m.value.startTime, t) : ''))
/** 点赞/粉丝只有 Panda 列表接口给(官方无对应字段), SOOP 整格省略而不是补 0;
 *  观众数两平台都有(SOOP 走关注列表的 user 字段), 取不到时按设计稿 3.2 显示「—」, 禁止用 0 冒充"没人看" */
const hasSocial = computed(() => m.value.platform !== 'soop')
/** 卡片缩略图走主进程那一层: liveimg 一个缓存头都没有, 直接绑原始地址就是每切一次工作区全量重打 */
const cardThumb = computed(() => imgSrc(m.value.thumbUrl || ''))

function watchLive(): void {
  if (m.value.isLive)
    router.push({ name: 'player', params: { plat: m.value.platform, userId: m.value.userId } })
}

async function toggleRecord(): Promise<void> {
  if (m.value.recording) {
    await api.recStop(m.value.platform, m.value.userId)
    message.success(t('card.recStopped'))
  } else {
    const r = await api.recStart(m.value.platform, m.value.userId)
    if ('userId' in r) {
      message.success(t('card.recStartedNick', { nick: m.value.nick }))
    } else if (r.needPassword) {
      // 卡片上没有密码输入位, 而 Electron 渲染层根本不支持 window.prompt(调用被静默拒绝, 恒返回 null)
      // —— 原写法是一条永远走不通的死路. 交回播放页: 那里密码面板与播放共用同一发密码
      message.warning(t('card.pwNeedPlayer'))
      router.push({ name: 'player', params: { plat: m.value.platform, userId: m.value.userId } })
    } else {
      message.error(r.error || t('card.recFail'))
    }
  }
}
</script>

<template>
  <div
    class="group cursor-pointer bg-card rounded-card overflow-hidden shadow-card border transition-shadow duration-150 hover:shadow-card-hover"
    :class="m.isLive ? 'border-live/30' : 'border-line'"
    @click="watchLive"
  >
    <!-- 缩略图: 左上状态 / 右上 19+ / 右下悬浮操作 -->
    <div class="relative aspect-video bg-fill overflow-hidden">
      <img
        v-if="m.isLive && cardThumb"
        :src="cardThumb"
        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <div v-else class="w-full h-full grid place-items-center bg-gradient-to-br from-fill to-fillh">
        <AvatarImg :src="m.userImg" lazy class="w-16 h-16 rounded-full object-cover opacity-70">
          <div class="w-16 h-16 rounded-full bg-card grid place-items-center text-2xl text-ink3 shadow-sm">{{ m.nick.slice(0, 1) }}</div>
        </AvatarImg>
      </div>

      <!-- 左上: 状态徽标恒 ≤2 枚(设计稿 3.1 ②, 优先级 录制中 > 直播中 > 已缓存 > 离线)。
           「直播中 + REC」是同义重复(能录就说明在播), 录制中直接顶掉直播中那枚, 三枚叠一片的情况因此不存在 -->
      <div class="absolute top-2 left-2 flex gap-1.5">
        <span v-if="m.recording" class="badge badge-sm bg-onimg text-white">
          <span class="w-1.5 h-1.5 rounded-full bg-live animate-breathe"></span>REC
        </span>
        <span v-else-if="m.isLive" class="badge badge-sm bg-liveink text-white shadow-sm">
          <span class="w-1.5 h-1.5 rounded-full bg-white animate-breathe"></span>{{ t('card.live') }}
        </span>
        <span v-else class="badge badge-sm bg-onimg text-white/90">{{ t('card.offlineBadge') }}</span>
        <!-- 源就绪徽标: 已获取有效直播源(播放源缓存命中), 进房/开录零等待。白字压 #2fad5f 只有 2.89:1, 必须压深阶 okink(5.05:1) -->
        <span
          v-if="m.isLive && m.srcReady"
          class="badge badge-sm bg-okink text-white shadow-sm"
          :title="t('card.srcReadyTip')"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 11-13h-8l1-7z"/></svg>{{ t('card.srcReady') }}
        </span>
      </div>

      <!-- 左下: 平台徽标 —— 统一墙里区分两平台的唯一常驻标记(离线卡也要显示, 否则只剩 ID 猜平台)。
           不能摆左上: 那一行挂状态徽标(录制中/直播中/已缓存), 叠第四枚必被 overflow 裁掉;
           右下留给 hover 操作, 左下在离线卡上本就空闲。尺寸恒 sm(设计稿 R2: 同一视野只允许一档, 卡片墙=sm) -->
      <PlatTag v-if="showPlatform" :platform="m.platform" size="sm" surface="onimg" class="absolute bottom-2 left-2" />

      <!-- 右上: 19+ 是内容分级, 不是状态 —— 用 liveink 会和左上「直播中」撞成两枚同色红徽, 读成两条告警。
           改走图上中性承载面(与离线枚同一底), 尺寸仍 sm(R2 同视野一档) -->
      <span v-if="m.isAdult" class="absolute top-2 right-2 badge badge-sm bg-onimg text-white shadow-sm">19+</span>

      <!-- hover: 扩展操作 + 录制 -->
      <div v-if="m.isLive" class="absolute bottom-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-200">
        <slot name="hoverActions" />
        <n-tooltip trigger="hover" :delay="300"><template #trigger>
          <button
            class="w-8 h-8 rounded-ctl grid place-items-center shadow-md hover:scale-105 transition-transform"
            :class="m.recording ? 'bg-live text-white' : 'bg-card/95 text-liveink'"
            @click.stop="toggleRecord"
          >
            <svg v-if="!m.recording" class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>
            <svg v-else class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
          </button>
        </template>{{ m.recording ? t('card.stopRec') : t('card.record') }}</n-tooltip>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="px-3 pt-2.5 pb-3">
      <!-- 第一行: 标题 -->
      <h3 class="text-[13.5px] font-semibold text-ink1 leading-snug truncate group-hover:text-brand transition-colors" :title="m.isLive ? m.title : m.nick">
        <!-- 内容属性前缀不做颜色编码(令牌板没有青/琥珀/紫三档, 且红只留给在播/错误): 识别由文字本身承担(设计稿 R3) -->
        <span v-if="m.isPw" class="text-ink3 font-normal">[{{ t('card.pw') }}] </span><span v-if="m.isRec" class="text-ink3 font-normal">[{{ t('card.rec') }}] </span><span v-if="m.isFan" class="text-ink3 font-normal">[{{ t('card.fan') }}] </span>{{ m.isLive ? (m.title || t('card.roomOf', { nick: m.nick })) : m.nick }}
      </h3>

      <!-- 第二行: 头像 + 昵称 + ID + 扩展区 -->
      <div class="flex items-center gap-1.5 mt-2">
        <AvatarImg :src="m.userImg" lazy class="w-[20px] h-[20px] rounded-full object-cover shrink-0">
          <svg class="w-[20px] h-[20px] shrink-0" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/></svg>
        </AvatarImg>
        <span v-if="m.isLive" class="text-[12px] text-ink1 font-medium truncate">{{ m.nick }}</span>
        <svg v-if="m.following" class="w-3.5 h-3.5 text-live shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 21s-7-4.6-9.3-9A5.4 5.4 0 0112 6.3 5.4 5.4 0 0121.3 12C19 16.4 12 21 12 21z"/>
        </svg>
        <!-- ⑧ ID 槽: 两平台语义不同但宽度守恒 —— Panda 认 @用户名, SOOP 认频道名(登录 ID 不是用户能输入的地址);
             SOOP 侧不加「房间」前缀: 这一格就在头像与昵称旁边, 那两个字是给自说明的东西写说明书 -->
        <span class="text-[11.5px] text-ink3 truncate shrink-0 ml-auto">{{ m.platform === 'soop' ? m.userId : '@' + m.userId }}</span>
        <slot name="meta" />
      </div>

      <!-- 第三行: 数据行(观众两平台都有; 点赞/粉丝只有 Panda 给, SOOP 整格省略; 时长恒显示) -->
      <div v-if="m.isLive" class="flex items-center gap-3 mt-2 pt-2 border-t border-line/70 text-[11.5px] text-ink3">
        <span class="flex items-center gap-1" :title="t('card.viewers')">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
          {{ m.viewers > 0 ? fmtNum(m.viewers, isZh) : '—' }}
        </span>
        <span v-if="hasSocial" class="flex items-center gap-1" :title="t('card.likes')">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.9-9.7-9.2A5.6 5.6 0 0112 5.9a5.6 5.6 0 019.7 5.4c-2.2 4.3-9.7 9.2-9.7 9.2z"/></svg>
          {{ fmtNum(m.likes, isZh) }}
        </span>
        <span v-if="hasSocial" class="flex items-center gap-1" :title="t('card.fans')">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>
          {{ fmtNum(m.fans, isZh) }}
        </span>
        <span class="ml-auto tabular-nums" :title="t('card.duration')">{{ liveDuration || '—' }}</span>
      </div>
    </div>
  </div>
</template>
