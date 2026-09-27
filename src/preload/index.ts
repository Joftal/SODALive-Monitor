import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { CH, EV } from '../shared/types'
import type { ApiBridge } from '../shared/types'
import type {
  AccountState, Anchor, AppInfo, DiscoveryItem, KeepaliveStatus, PlayInfo, RecDeleteFileResult, RecDeleteResult, RecHistoryItem, RecTask, RecThumbReady, Settings, Toast, UpdateCheckResult, WatcherStatus
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// 单一事实源: ApiBridge(shared/types.ts); 环境无关的 env.d.ts 直接引用同一接口
const apiBridge: ApiBridge = {
  // 账号
  authState: (): Promise<AccountState> => ipcRenderer.invoke(CH.authState),
  authLoginPassword: (id: string, pw: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(CH.authLoginPassword, id, pw),
  authOpenWindow: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(CH.authOpenWindow),
  authImportCookies: (cookieStr: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(CH.authImportCookies, cookieStr),
  authLogout: (): Promise<boolean> => ipcRenderer.invoke(CH.authLogout),

  // 主播
  anchorsList: (): Promise<Anchor[]> => ipcRenderer.invoke(CH.anchorsList),
  anchorsAdd: (input: string): Promise<Anchor> => ipcRenderer.invoke(CH.anchorsAdd, input),
  anchorsRemove: (userId: string): Promise<boolean> => ipcRenderer.invoke(CH.anchorsRemove, userId),
  anchorsSetAuto: (userId: string, auto: boolean): Promise<boolean> =>
    ipcRenderer.invoke(CH.anchorsSetAuto, userId, auto),
  anchorsRefresh: (): Promise<boolean> => ipcRenderer.invoke(CH.anchorsRefresh),

  // 播放
  livePlay: (userId: string, password?: string, fresh?: boolean): Promise<PlayInfo> =>
    ipcRenderer.invoke(CH.livePlay, userId, password, fresh),
  liveSrcCache: (): Promise<string[]> => ipcRenderer.invoke(CH.liveSrcCache),
  keepaliveStatus: (userId: string): Promise<KeepaliveStatus> => ipcRenderer.invoke(CH.liveKeepaliveStatus, userId),

  // 大厅
  discoveryList: (): Promise<DiscoveryItem[]> => ipcRenderer.invoke(CH.discoveryList),

  // 录制
  recList: (): Promise<RecTask[]> => ipcRenderer.invoke(CH.recList),
  recHistory: (): Promise<RecHistoryItem[]> => ipcRenderer.invoke(CH.recHistory),
  recStart: (userId: string, password?: string): Promise<RecTask | { ok: false; needPassword?: boolean; error?: string }> =>
    ipcRenderer.invoke(CH.recStart, userId, password),
  recStop: (userId: string): Promise<void> => ipcRenderer.invoke(CH.recStop, userId),
  recOpenFolder: (dir: string): Promise<boolean> => ipcRenderer.invoke(CH.recOpenFolder, dir),
  recDiskFree: (): Promise<number> => ipcRenderer.invoke(CH.recDiskFree),
  recMerge: (taskId: string): Promise<{ ok: boolean; files?: string[]; error?: string }> =>
    ipcRenderer.invoke(CH.recMerge, taskId),
  /** 九宫格缩略图: 命中直接给 URL; 未命中后台生成, 完成后 onRecThumb 推送 */
  recThumb: (taskId: string): Promise<{ ok: boolean; url: string }> => ipcRenderer.invoke(CH.recThumb, taskId),
  /** 删除录制: 文件移入回收站 + 清缩略图 + 移出历史 */
  recDelete: (taskId: string): Promise<RecDeleteResult> => ipcRenderer.invoke(CH.recDelete, taskId),
  /** 删除单个分段: 回收站 + 文件集对账 + 缩略图重生成; 删空则任务移除 */
  recDeleteFile: (taskId: string, absPath: string): Promise<RecDeleteFileResult> =>
    ipcRenderer.invoke(CH.recDeleteFile, taskId, absPath),

  // 设置
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke(CH.settingsGet),
  settingsSet: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(CH.settingsSet, patch),
  settingsSelectDir: (): Promise<string> => ipcRenderer.invoke(CH.settingsSelectDir),
  telegramSetToken: (token: string): Promise<Settings> => ipcRenderer.invoke(CH.telegramSetToken, token),
  telegramTest: (token: string, chatId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(CH.telegramTest, token, chatId),

  // 轮询
  watcherStatus: (): Promise<WatcherStatus> => ipcRenderer.invoke(CH.watcherStatus),

  // 窗口
  winControl: (action: 'min' | 'max' | 'close'): Promise<void> => ipcRenderer.invoke(CH.winControl, action),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.openExternal, url),
  appDataDir: (): Promise<string> => ipcRenderer.invoke(CH.appDataDir),
  openLogs: (): Promise<string> => ipcRenderer.invoke(CH.appOpenLogs),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(CH.appCheckUpdate),
  /** 本地录制文件转 plocal:// 可播放 URL(纯拼接, 权限校验在主进程协议处理器) */
  localFileUrl: (absPath: string): string => {
    // 沙箱 preload 的 Buffer polyfill 不支持 base64url 编码 —— 纯 JS 实现(TextEncoder→btoa→±/替换)
    const bytes = new TextEncoder().encode(absPath)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return 'plocal://file/' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },

  // 事件订阅
  onAnchors: (cb: (list: Anchor[]) => void) => on<Anchor[]>(EV.anchors, cb),
  onRecordings: (cb: (list: RecTask[]) => void) => on<RecTask[]>(EV.recordings, cb),
  onWatcher: (cb: (s: WatcherStatus) => void) => on<WatcherStatus>(EV.watcher, cb),
  onAccount: (cb: (s: AccountState) => void) => on<AccountState>(EV.account, cb),
  onToast: (cb: (t: Toast) => void) => on<Toast>(EV.toast, cb),
  onDiscovery: (cb: (list: DiscoveryItem[]) => void) => on<DiscoveryItem[]>(EV.discovery, cb),
  onRecThumb: (cb: (p: RecThumbReady) => void) => on<RecThumbReady>(EV.recThumb, cb),
  onSrcCache: (cb: (ids: string[]) => void) => on<string[]>(EV.srcCache, cb)
}

contextBridge.exposeInMainWorld('api', apiBridge)
