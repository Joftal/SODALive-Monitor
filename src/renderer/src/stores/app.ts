import { defineStore } from 'pinia'
import type { AccountStates, Anchor, DiscoveryItem, Platform, RecHistoryItem, RecTask, Settings, WatcherStatus } from '@shared/types'
import { roomKey } from '@shared/types'
import { api } from '@/api'

// ============ 提示音(WebAudio, 免资源文件) ============
let audioCtx: AudioContext | null = null
export function playDing(): void {
  try {
    audioCtx = audioCtx || new AudioContext()
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.frequency.setValueAtTime(880, t)
    osc.frequency.setValueAtTime(1174.66, t + 0.12)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(t)
    osc.stop(t + 0.55)
  } catch {
    /* ignore */
  }
}

/** 排序档位: 组件里把档位摆成数组时靠它保持字面量类型, 不用调用方各处 as */
export type SortKey = 'recent' | 'viewers' | 'likes' | 'fans' | 'stale'

/** 一个视图内的交互态。三视图各存一份(store.views), 切视图只换渲染不换状态 ——
 *  沿用旧大厅 exploreFilter 的托管思路, 但从"一份全局"扩成"每视图一份", 否则在播页的页码会污染发现页。
 *  内存态: 重启回默认, 但跨"进房间再返回""切平台"存活, 这正是用户投诉过的丢位场景。 */
export interface ViewFilter {
  /** 三视图共用一种结构、各自一份实例: recent=最新开播, viewers=人气, likes=点赞, fans=粉丝团,
   *  stale=未播天数久→新(离线视图的管理视角)。各视图只暴露自己数据面支持的档位。 */
  sortBy: SortKey
  /** 发现视图: 只看已关注 / 仅看 19+ / 仅看粉丝房 */
  onlyFollowed: boolean
  onlyAdult: boolean
  onlyFan: boolean
  /** 在播视图: 只看已开自动录制 */
  onlyAutoRec: boolean
  /** 离线视图: 隐藏 90 天未播 */
  hideStale: boolean
  /** 离线视图: 只看「站内已取关」(D3 反向差值的落点; 只筛不删) */
  goneOnly: boolean
  page: number
  pageSize: number
  /** 列表滚动位置(px) */
  scrollTop: number
}

function newFilter(sortBy: SortKey, pageSize: number): ViewFilter {
  return { sortBy, onlyFollowed: false, onlyAdult: false, onlyFan: false, onlyAutoRec: false, hideStale: false, goneOnly: false, page: 1, pageSize, scrollTop: 0 }
}

/** 工作区视图标识(与地址里的 ?view= 同一套字面量) */
export type WSView = 'live' | 'discover' | 'offline'

interface State {
  anchors: Anchor[]
  discovery: DiscoveryItem[]
  recordings: RecTask[]
  history: RecHistoryItem[]
  settings: Settings | null
  watcher: WatcherStatus | null
  /** 两套登录态一次给全: 顶栏双头像与账号页共用同一份事实源 */
  accounts: AccountStates | null
  searchKeyword: string
  /** 粘错平台时寄存的原文: 换平台会重挂工作区(:key=页名+路径参数, plat 在参数里), 靠它把对话框带着原句撑开 */
  addDraft: string
  /** 三视图各自的排序/筛选/分页/滚动状态 */
  views: Record<WSView, ViewFilter>
  /** 本次运行期间「新开播」的房间主键: 取代旧关注页的"开播就自动跳 tab"——
   *  跳 tab 会打断正在浏览的人, 这里只把它做成顶栏分段徽标的红点, 由用户自己决定看不看。 */
  newLive: string[]
  /** 首包 anchors 只做基线不标新: 冷启动把全墙都点亮等于没点亮 */
  anchorsSeeded: boolean
  /** 该房间是否已持有有效直播源(主进程播放源缓存的快照推送; 卡片「秒开」徽标依据) */
  srcCache: string[]
}

export const useAppStore = defineStore('app', {
  state: (): State => ({
    anchors: [],
    discovery: [],
    recordings: [],
    history: [],
    settings: null,
    watcher: null,
    accounts: null,
    searchKeyword: '',
    addDraft: '',
    // 在播/发现两视图的默认档 = 各自筛子栏的第一格(2026-10-01 用户指令把在播默认也换成「人气最高」):
    // 冷启动第一眼的排序和左手第一格是同一件事, 不让人对不上号。离线那视图刻意例外(默认「未播最久」是管理视角)。
    views: { live: newFilter('viewers', 20), discover: newFilter('viewers', 20), offline: newFilter('stale', 40) },
    newLive: [],
    anchorsSeeded: false,
    srcCache: []
  }),
  getters: {
    activeRecs: (s) => s.recordings.filter((r) => r.status === 'recording' || r.status === 'remuxing'),
    isRecording: (s) => (platform: Platform, userId: string) =>
      s.recordings.some((r) => r.platform === platform && r.userId === userId && (r.status === 'recording' || r.status === 'remuxing')),
    isFollowing: (s) => (platform: Platform, userId: string) =>
      s.anchors.some((a) => a.platform === platform && a.userId === userId),
    /** 该房间是否已持有有效直播源(点了就能播/录, 无需再拉); srcCache 为主进程推送的房间主键 */
    isSrcReady: (s) => (platform: Platform, userId: string) => s.srcCache.includes(roomKey(platform, userId)),
    /** 某平台本次运行内新开播的房间数: 顶栏分段徽标据此由品牌色转红 */
    newLiveCount: (s) => (platform: Platform) =>
      s.newLive.filter((k) => k.startsWith(`${platform}:`)).length
  },
  actions: {
    async init() {
      // 账号态不在这里等: authState 会真的打两次官方校验接口(Panda login_info + SOOP get_private_info),
      // 网络被黑洞/风控挂住时它能把整个应用按在「加载中…」空屏十几秒 —— 界面看起来就是坏了。
      // 其余七项全是主进程内存/本地库读取。账号态由下面的事件补挂(顶栏在此之前显示「校验中」)。
      const [anchors, recordings, settings, watcherStatus, history, discovery, srcCache] = await Promise.all([
        api.anchorsList(),
        api.recList(),
        api.settingsGet(),
        api.watcherStatus(),
        api.recHistory(),
        api.discoveryList(),
        api.liveSrcCache()
      ])
      this.setAnchors(anchors)
      this.recordings = recordings
      this.settings = settings
      this.watcher = watcherStatus
      this.history = history
      this.discovery = discovery
      this.srcCache = srcCache

      api.onAnchors((list) => this.setAnchors(list))
      api.onDiscovery((list) => (this.discovery = list))
      api.onSrcCache((ids) => (this.srcCache = ids))
      // M6: 任务集/状态变化才全量重拉历史 —— 录制推送每 2s/任务, 盲目 refresh 会拖累整库
      let lastRecSig = ''
      api.onRecordings((list) => {
        this.recordings = list
        const sig = list.map((task) => task.id + ':' + task.status).join('|')
        if (sig !== lastRecSig) {
          lastRecSig = sig
          void this.refreshHistory()
        }
      })
      api.onWatcher((w) => (this.watcher = w))
      api.onAccount((a) => (this.accounts = a))
      // 首帧账号校验照发, 只是不进 init 的 await: 结果会经 EV.account 自己回到 store
      void api.authState().catch(() => {})
    },
    /** anchors 的唯一写入口: 顺带算出「本次运行内新开播」的房间。
     *  它取代旧关注页的「开播就自动切 tab」—— 自动切换会打断正在浏览的用户(设计稿 L.2「默认视图」),
     *  改为顶栏分段徽标转红 + 「在播关注」那一档的计数, 用户回来时看得见, 但不被劫持当前阅读。 */
    setAnchors(list: Anchor[]) {
      const wasLive = new Set(this.anchors.filter((a) => a.isLive).map((a) => roomKey(a.platform, a.userId)))
      this.anchors = list
      const nowLive = new Set(list.filter((a) => a.isLive).map((a) => roomKey(a.platform, a.userId)))
      if (!this.anchorsSeeded) {
        // 首包只是基线: 冷启动那一刻已经在播的人不是「新开播」, 否则一进来满屏红
        this.anchorsSeeded = true
        this.newLive = []
        return
      }
      const marks = new Set([...this.newLive.filter((k) => nowLive.has(k)), ...[...nowLive].filter((k) => !wasLive.has(k))])
      this.newLive = [...marks]
    },
    /** 用户已经站在这个平台的在播视图前: 新开播标记使命完成, 清掉(否则竖条永不被消费) */
    seenLive(platform: Platform) {
      this.newLive = this.newLive.filter((k) => !k.startsWith(`${platform}:`))
    },
    /** 关注/取关/改自动录制之后的重拉一律走这里: 绕过 setAnchors 就丢掉了新开播差分 */
    async reloadAnchors() {
      this.setAnchors(await api.anchorsList())
    },
    async refreshHistory() {
      this.history = await api.recHistory()
    },
    async patchSettings(patch: Partial<Settings>) {
      this.settings = await api.settingsSet(patch)
    },
    async follow(platform: Platform, userId: string) {
      await api.anchorsAdd(userId, platform)
    },
    async unfollow(platform: Platform, userId: string) {
      await api.anchorsRemove(platform, userId)
    }
  }
})
