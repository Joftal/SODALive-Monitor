import { DEFAULT_PLATFORM, isPlatform, type Platform, type WorkspacePref } from '@shared/types'

// ============ 工作区归属(D5 / 路由一期) ============
// 冷启动时 router 的 redirect 必须在 store.init() 拿到 settings 之前就能算出落点, 所以偏好走
// localStorage 镜像 —— 与 main.ts 里 pl-theme 防闪白同一套路: settings 到达后由 App.vue 刷镜像,
// 下次冷启动直接读镜像, 不需要"先渲染错的页再跳一次"。
// ================================================

const PREF_KEY = 'pl-workspace-pref'
const LAST_KEY = 'pl-workspace-last'

function read(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function write(key: string, val: string): void {
  try {
    localStorage.setItem(key, val)
  } catch {
    /* ignore */
  }
}

/** settings.defaultWorkspace 落镜像: 'remember' 也照写, 否则改了设置后旧值会复活 */
export function mirrorWorkspacePref(pref: WorkspacePref | undefined): void {
  write(PREF_KEY, pref === 'pandalive' || pref === 'soop' ? pref : 'remember')
}

/** 离开哪个工作区就记住哪个(afterEach 调用); 非平台页(设置/账号)不覆盖 */
export function noteWorkspace(plat: unknown): void {
  if (isPlatform(plat)) write(LAST_KEY, plat)
}

/** 当前应落到哪个平台工作区: 恒定项 > 上次离开 > 默认平台 */
export function resolveWorkspace(): Platform {
  const pref = read(PREF_KEY)
  if (isPlatform(pref)) return pref
  const last = read(LAST_KEY)
  return isPlatform(last) ? last : DEFAULT_PLATFORM
}
