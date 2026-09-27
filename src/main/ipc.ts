import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron'
import * as path from 'path'
import {
  CH, EV, AccountState, Anchor, AppInfo, PlayInfo, Settings, UpdateCheckResult
} from '../shared/types'
import { APP_META, cmpSemver } from '../shared/appmeta'
import { api, SESSION_PARTITION, applyProxy } from './services/pandalive'
import { store } from './services/store'
import { vault } from './services/vault'
import { watcher } from './services/watcher'
import { recorder } from './services/recorder'
import { openLoginWindow } from './services/authWin'
import { sendToast } from './services/notify'
import { secrets } from './services/secrets'
import { tgSendMessage } from './services/telegram'
import { dataDir, defaultRecordRoot, diskFreeGb, UA } from './util'
import { logger } from './services/logger'
import { thumbs } from './services/thumbs'
import { mt, setMainLocale } from './i18n'

async function pushAccount(): Promise<AccountState> {
  let realLogin = false
  let isAdult = false
  let userIdx: number | null = null
  if (api.hasSession()) {
    const info = await api.checkLoginInfo()
    realLogin = info.isLogin
    isAdult = info.isAdult
    userIdx = info.idx
  }
  const state: AccountState = {
    loggedIn: api.hasSession(),
    cookieValid: api.hasSession() && (api.cookieValid || realLogin),
    realLogin,
    isAdult,
    userIdx,
    encrypted: vault.encrypted
  }
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send(EV.account, state)
  return state
}

export function registerIpc(): void {
  // ---------- 账号 ----------
  ipcMain.handle(CH.authState, () => pushAccount())

  ipcMain.handle(CH.authOpenWindow, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, message: mt('auth.winMissing') }
    const r = await openLoginWindow(win)
    if (r.ok) logger.info('auth', '网页登录成功')
    else logger.info('auth', `网页登录未完成: ${r.message}`)
    pushAccount()
    return r
  })

  ipcMain.handle(CH.authImportCookies, async (_e, cookieStr: string) => {
    // 解析 "k=v; k=v" 形式的 cookie 字符串
    const jar: Record<string, string> = {}
    for (const part of String(cookieStr || '').split(/;\s*/)) {
      const i = part.indexOf('=')
      if (i > 0) {
        const k = part.slice(0, i).trim()
        const v = part.slice(i + 1).trim()
        if (k) jar[k] = v
      }
    }
    if (!jar['sessKey']) {
      logger.warn('auth', 'Cookie 导入被拒: 缺 sessKey')
      return { ok: false, message: mt('auth.importNoSess') }
    }
    // M2: 先试验证再落盘 —— 过期 Cookie 不得连带注销现有有效会话;
    //     且 infoPre 直传消重, 不再让 importCookies 内部重复发 login_info
    const info = await api.checkLoginInfo(jar)
    if (!info.isLogin) {
      logger.warn('auth', 'Cookie 导入被拒: login_info 校验未通过(过期/无效)')
      return { ok: false, message: mt('auth.importInvalid') }
    }
    await api.importCookies(jar, info)
    logger.info('auth', `Cookie 导入成功(成人认证=${info.isAdult ? '有' : '无'})`)
    pushAccount()
    return { ok: true, message: info.isAdult ? mt('auth.importOkAdult') : mt('auth.importOkNoAdult') }
  })

  ipcMain.handle(CH.authLogout, async () => {
    api.clearCookies()
    logger.info('auth', '退出登录: Cookie/站点存储已清')
    try {
      await session.fromPartition(SESSION_PARTITION).clearStorageData()
    } catch { /* ignore */ }
    pushAccount()
    return true
  })

  // ---------- 主播 ----------
  ipcMain.handle(CH.anchorsList, () => store.listAnchors())

  ipcMain.handle(CH.anchorsAdd, async (_e, input: string) => {
    let userId = (input || '').trim()
    // 支持粘贴 URL: https://www.pandalive.co.kr/play/xxx 或 lbj 形式
    const m = userId.match(/pandalive\.co\.kr\/(?:play\/)?([\w-]+)/)
    if (m) userId = m[1]
    userId = userId.replace(/[^\w-]/g, '')
    if (!userId) throw new Error(mt('anchors.invalid'))
    if (store.listAnchors().find((a) => a.userId === userId)) throw new Error(mt('anchors.exists'))

    let nick = userId
    let userIdx: number | null = null
    let userImg = ''

    // 优化: 大厅(discovery)里已有该主播数据时直接复用, 省一次 fetchBj 请求且即时点亮
    const disc = watcher.getDiscovery().find((d) => d.userId === userId)
    if (!disc) {
      try {
        const info = await api.fetchBj(userId)
        nick = info.nick || userId
        userIdx = info.userIdx
        userImg = info.userImg
      } catch {
        /* 主播信息拉取失败也允许添加, 等轮询补全 */
      }
    } else {
      nick = disc.nick
      userIdx = disc.userIdx
      userImg = disc.userImg
    }

    const cfg = store.getSettings()
    const anchor: Anchor = {
      userId,
      userIdx,
      nick,
      userImg,
      isLive: !!disc,
      title: disc?.title || '',
      tags: disc
        ? { isAdult: disc.isAdult, isPw: disc.isPw, type: disc.type, liveType: disc.liveType }
        : null,
      startTime: disc?.startTime || '',
      viewerCount: disc?.viewers || 0,
      likes: disc?.likes || 0,
      fans: disc?.fans || 0,
      thumbUrl: disc?.thumbUrl || '',
      autoRecord: cfg.autoRecordDefault,
      addedAt: Date.now(),
      lastSeenAt: disc ? Date.now() : 0
    }
    store.addAnchor(anchor)
    watcher.unmarkGone(userId) // 也可能是已修正的新 ID: 允许重新探活
    // 关注"已在播"主播: 后台预取一次直播源(进房零等待)。列表模式下 onLiveStart 只认
    // 离线→在线翻转, 对关注时已在播的主播永不再触发 —— 这里补洞, 与逐个模式语义对齐。
    // 不作废旧缓存: 先进房再关注 = 命中刚拉取的新鲜源, 预取泵自然 no-op, 不重发请求;
    // 密码房已验证源得以保留(playCache 免密复用契约), 不会二次进房重问密码。
    if (anchor.isLive && cfg.prefetchStream) {
      watcher.prewarmNow(anchor.userId)
    }
    // 不再触发 tick: 大厅数据已即时点亮; 列表不可见的由轮询规范的轮换兜底在后续轮次发现
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.anchors, store.listAnchors())
    return anchor
  })

  ipcMain.handle(CH.anchorsRemove, async (_e, userId: string) => {
    // 先取关再停录: removeAnchor 先于 await 落库, watcher 的 stillMonitored 守卫立即生效 ——
    // 否则 stop 的慢窗口(remuxing 收尾最长达分钟级)内开播翻转会穿过守卫启动孤儿录制
    store.removeAnchor(userId)
    watcher.unmarkGone(userId) // 查无此人标记一并解除(将来重加/账号恢复可重新探活)
    await recorder.stop(userId)
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.anchors, store.listAnchors())
    return true
  })

  ipcMain.handle(CH.anchorsSetAuto, (_e, userId: string, auto: boolean) => {
    store.updateAnchor(userId, { autoRecord: auto })
    return true
  })

  ipcMain.handle(CH.anchorsRefresh, () => {
    watcher.tick()
    return true
  })

  // ---------- 播放 ----------
  ipcMain.handle(CH.livePlay, async (_e, userId: string, password?: string, fresh?: boolean): Promise<PlayInfo> => {
    let r
    try {
      r = await api.getPlayCached(userId, password || '', !!fresh)
    } catch (e) {
      // 网络异常/风控(403/429 等)——必须回落为 ok:false, 否则前端永远停在"获取直播流…"
      return { ok: false, error: mt('ipc.playFail', { msg: (e as Error).message || String(e) }) }
    }
    if (!r.ok) {
      return { ok: false, needPassword: r.needPassword, error: r.error }
    }
    return {
      ok: true,
      vod: !!r.vod,
      m3u8: r.m3u8,
      variants: r.variants,
      hlsBackups: r.hlsBackups,
      fetchedAt: r.fetchedAt,
      title: r.title || '',
      nick: r.nick || '',
      thumbUrl: r.thumbUrl || '',
      userImg: r.userImg || '',
      tags: r.media
        ? {
            isAdult: !!r.media.isAdult,
            isPw: !!r.media.isPw,
            type: String(r.media.type || ''),
            liveType: String(r.media.liveType || '')
          }
        : undefined
    }
  })

  ipcMain.handle(CH.liveSrcCache, () => api.cachedSourceIds())
  ipcMain.handle(CH.liveKeepaliveStatus, (_e, userId: string) => api.keepaliveStatus(String(userId)))

  // ---------- 大厅 ----------
  ipcMain.handle(CH.discoveryList, () => watcher.getDiscovery())

  // ---------- 录制 ----------
  ipcMain.handle(CH.recList, () => recorder.list())
  // 每次取历史先对账外部删改(启动首拉/进库刷新同走此口), 渲染层所见即磁盘实况
  ipcMain.handle(CH.recHistory, () => {
    recorder.reconcileHistory()
    return store.listHistory()
  })

  ipcMain.handle(CH.recStart, async (_e, userId: string, password?: string) => {
    // 允许录制未监控的主播(大厅/播放页直接录制)
    const anchor = store.listAnchors().find((a) => a.userId === userId)
    let nick = anchor?.nick || userId
    let title = anchor?.title || ''
    if (!anchor) {
      try {
        const info = await api.fetchBj(userId)
        nick = info.nick || userId
        title = info.media?.title || ''
      } catch {
        /* 拿不到信息也允许尝试录制 */
      }
    }
    try {
      return await recorder.start({
        userId,
        nick,
        title,
        password: password || '',
        auto: false
      })
    } catch (e) {
      const err = e as Error & { needPassword?: boolean }
      return { ok: false, needPassword: !!err.needPassword, error: err.message }
    }
  })

  ipcMain.handle(CH.recStop, (_e, userId: string) => recorder.stop(userId))

  ipcMain.handle(CH.recOpenFolder, async (_e, dir: string) => {
    // M10: 只允许打开录制/应用数据相关目录(任意路径探测封堵; 对照 openExternal 已有白名单)
    const resolved = path.resolve(String(dir || ''))
    const roots = new Set<string>([
      path.resolve(store.getSettings().savePath || defaultRecordRoot()),
      path.resolve(defaultRecordRoot()),
      // 设置页「打开目录」按钮传的是应用数据目录(data/), 与录制根平级 —— 不放行则恒被拒
      path.resolve(dataDir())
    ])
    for (const h of store.listHistory()) if (h.dirPath) roots.add(path.resolve(h.dirPath))
    const ok = [...roots].some((root) => {
      const rel = path.relative(root, resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (ok) {
      await shell.openPath(resolved)
    } else {
      logger.warn('ipc', `打开目录被白名单拒绝: ${resolved}`)
    }
    return ok
  })

  ipcMain.handle(CH.recThumb, (_e, taskId: string) => ({ ok: true, url: thumbs.ensure(String(taskId)).url }))

  ipcMain.handle(CH.recDelete, (_e, taskId: string) => recorder.deleteTask(String(taskId)))

  ipcMain.handle(CH.recDeleteFile, (_e, taskId: string, absPath: string) => recorder.deleteFile(String(taskId), String(absPath)))

  ipcMain.handle(CH.recDiskFree, () => {
    const cfg = store.getSettings()
    return diskFreeGb(cfg.savePath || defaultRecordRoot())
  })

  ipcMain.handle(CH.recMerge, (_e, taskId: string) => recorder.mergeTask(String(taskId)))

  // ---------- 设置 ----------
  // tgTokenSet 只作投影下发(UI 显隐用), 真值永不出 secrets 保险箱 ——
  // 不把活引用直接递给渲染层, 防投影写回 db.json
  const projectTg = (): Settings => ({ ...store.getSettings(), tgTokenSet: Boolean(secrets.get('tgToken')) })

  ipcMain.handle(CH.settingsGet, () => projectTg())

  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => {
    // tgTokenSet 是主进程投影字段, 渲染层误提交一律忽略(防真值开关被当设置落盘)
    const p = { ...patch }
    delete p.tgTokenSet
    const before = store.getSettings()
    const cfg = store.setSettings(p)
    // 变更留痕(排查"参数什么时候被改过"类问题; 代理地址可能内嵌凭据, 一律掩码)
    const diffs = (Object.keys(p) as (keyof Settings)[])
      .filter((k) => p[k] !== undefined && before[k] !== cfg[k])
      .map((k) =>
        k === 'proxyUrl' || k === 'tgProxy'
          ? (cfg[k] ? `${k}=已设置` : `${k}=已清空`)
          : `${k}=${String(before[k])}→${String(cfg[k])}`
      )
    if (diffs.length) logger.info('app', `设置变更: ${diffs.join(', ')}`)
    applyProxy(cfg.proxyUrl)
    setMainLocale(cfg.locale) // 语言变更即时注入主进程 i18n(单向数据流)
    // 只有轮询相关设置的【值真的变了】才即时拉一轮(前端提交的是全量对象, 不能按 key 存在判断)
    const WATCH_KEYS: (keyof Settings)[] = ['watchMode', 'pollIntervalSec', 'requestGapMs', 'proxyUrl']
    if (WATCH_KEYS.some((k) => before[k] !== cfg[k])) {
      watcher.tick()
    }
    return projectTg()
  })

  ipcMain.handle(CH.telegramSetToken, (_e, token: string) => {
    const t = String(token || '').trim()
    secrets.set('tgToken', t)
    logger.info('app', t ? 'Telegram bot token 已保存到保险箱' : 'Telegram bot token 已清除')
    return projectTg()
  })

  ipcMain.handle(CH.telegramTest, async (_e, token: string, chatId: string) => {
    const t = String(token || '').trim() || secrets.get('tgToken')
    const r = await tgSendMessage(t, String(chatId || ''), mt('tg.testBody'))
    return r.ok ? { ok: true, message: mt('tg.testOk') } : { ok: false, message: r.message }
  })

  ipcMain.handle(CH.settingsSelectDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.getSettings().savePath || app.getPath('videos')
    })
    return r.canceled ? '' : r.filePaths[0]
  })

  // ---------- 轮询 ----------
  ipcMain.handle(CH.watcherStatus, () => watcher.status)

  // ---------- 窗口控制 / 外部链接 ----------
  ipcMain.handle(CH.winControl, (e, action: 'min' | 'max' | 'close') => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (action === 'min') win.minimize()
    else if (action === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize())
    else if (action === 'close') win.close()
  })

  ipcMain.handle(CH.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle(CH.appDataDir, () => dataDir())

  // 渲染层诊断日志入档(hls.js 报错等主进程不可见事件); 限流 30 条/分防刷屏
  let rlogCount = 0
  let rlogWindow = Date.now()
  ipcMain.on(CH.appLog, (_e, level: unknown, msg: unknown) => {
    if (typeof msg !== 'string' || !msg) return
    const now = Date.now()
    if (now - rlogWindow > 60_000) {
      rlogWindow = now
      rlogCount = 0
    }
    if (++rlogCount > 30) return
    logger[level === 'warn' ? 'warn' : 'info']('renderer', String(msg).slice(0, 1500))
  })

  ipcMain.handle(CH.appOpenLogs, async () => {
    const dir = logger.dir()
    await shell.openPath(dir)
    return dir
  })

  // ---------- 关于 / 检查更新 ----------
  ipcMain.handle(CH.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    author: APP_META.author,
    repo: APP_META.repo,
    releasesPage: APP_META.releasesPage
  }))

  ipcMain.handle(CH.appCheckUpdate, async (): Promise<UpdateCheckResult> => {
    const current = app.getVersion()
    try {
      // 走 releases/latest 网页 302 跳转而非 REST API(匿名 API 有每 IP 60 次/时限流, 共享出口 IP 易爆)
      const res = await net.fetch(APP_META.releasesPage + '/latest', { headers: { 'User-Agent': UA } })
      if (res.status === 404) {
        // 仓库尚无 Release: 视为已是最新
        return { ok: true, current, latest: '', hasUpdate: false, url: APP_META.releasesPage }
      }
      if (res.status !== 200) throw new Error(`GitHub 响应 HTTP ${res.status}`)
      // 有 Release 时最终 URL 形如 .../releases/tag/vX.Y.Z
      const m = /\/releases\/tag\/(v?[\w.-]+)/.exec(res.url || '')
      if (!m) return { ok: true, current, latest: '', hasUpdate: false, url: APP_META.releasesPage }
      return {
        ok: true,
        current,
        latest: m[1].replace(/^v/i, ''),
        hasUpdate: cmpSemver(m[1], current) > 0,
        url: res.url || APP_META.releasesPage
      }
    } catch (e) {
      logger.warn('app', `检查更新失败: ${String((e as Error).message || e)}`)
      return { ok: false, current, error: mt('app.updFail', { msg: String((e as Error).message || e) }) }
    }
  })

  // 启动即清扫孤儿缩略图(历史已删/外部移除), 与历史表对账
  try {
    thumbs.sweep(store.listHistory().map((h) => h.id))
  } catch { /* 清扫失败不影响启动 */ }
}

export { pushAccount }
