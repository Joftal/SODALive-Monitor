import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { DEFAULT_PLATFORM } from '@shared/types'
import { noteWorkspace, resolveWorkspace } from './workspace'

// ============ 路由: 平台为一级(设计稿方案 A) ============
// 一个平台一套工作区: /:plat/live · /:plat/recordings。库不是第三页, 它是录制页里的一个分段。
// :plat 段带正则约束, 非法平台值不会渲染出"半个 Panda 页", 而是落到 catch-all 归位。
// 旧地址(#/explore · #/monitor · #/recordings · #/library · #/player/<id>)一期全部保留:
// 它们活在用户的历史 Telegram 卡片、浏览器收藏与本仓库脚本里, 改路由不能把这些人留在空白页。
// ==========================================

const PLAT = ':plat(pandalive|soop)'
const home = (): string => `/${resolveWorkspace()}/live`

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: home },
    { path: `/${PLAT}/live`, name: 'live', component: () => import('@/views/WorkspaceView.vue') },
    { path: `/${PLAT}/recordings`, name: 'recordings', component: () => import('@/views/RecordingsView.vue'), props: true },
    { path: `/player/${PLAT}/:userId`, name: 'player', component: () => import('@/views/PlayerView.vue') },
    { path: '/account', name: 'account', component: () => import('@/views/AccountView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    // 诊断台: 同时看两边, 所以不带 :plat 段 —— 它因此也不参与下面的"下次打开回到哪"的记忆
    { path: '/diag', name: 'diag', component: () => import('@/views/DiagnosticsView.vue') },

    // ---- 旧深链兼容 ----
    // 大厅/已关注合并为一页三视图, 旧地址用 view 参数精确落位(替代"滚动到某段"这种不可控行为)
    { path: '/explore', redirect: (to) => ({ path: home(), query: { ...to.query, view: 'discover' } }) },
    { path: '/monitor', redirect: (to) => ({ path: home(), query: { ...to.query, view: 'live' } }) },
    { path: '/recordings', redirect: () => `/${resolveWorkspace()}/recordings` },
    { path: '/library', redirect: () => `/${resolveWorkspace()}/recordings` },
    // 库并入录制页: 带平台的旧库深链落到录制页, :plat 段即库的初始筛选
    { path: `/${PLAT}/library`, redirect: (to) => `/${to.params.plat}/recordings` },
    // 单平台时代的播放深链不带平台段: 补默认平台
    { path: '/player/:userId', redirect: (to) => `/player/${DEFAULT_PLATFORM}/${to.params.userId}` },

    { path: '/:pathMatch(.*)*', redirect: home }
  ]
})

// 记住最后所在的工作区(D5 的 remember): 只有平台页参与, 设置/账号页不改变落点
router.afterEach((to) => {
  if (to.name === 'live' || to.name === 'recordings') noteWorkspace(to.params.plat)
})
