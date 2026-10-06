import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  CH, EV, AccountState, AccountStates, Anchor, AppInfo, DEFAULT_PLATFORM, FollowImportResult, isPlatform, isRoomId, parseRoomInput, Platform, PlayInfo, PlayMenu, roomKey, Settings, SoopAccountState, soopAvatarUrl, UpdateCheckResult
} from '../shared/types'
import { APP_META, cmpSemver } from '../shared/appmeta'
import { api, LiveItem, SESSION_PARTITION, applyProxy, cachedSourceIdsAll } from './services/pandalive'
import { sourceFor, applyPlayMeta } from './services/source'
import { maskLoginId, soopApi } from './services/soop'
import { store } from './services/store'
import { sanitizeSettingsPatch } from './services/settingsGuard'
import { vault } from './services/vault'
import { watcher } from './services/watcher'
import { recorder } from './services/recorder'
import { openLoginWindow } from './services/authWin'
import { sendToast } from './services/notify'
import { secrets } from './services/secrets'
import { tgSendMessage } from './services/telegram'
import { dataDir, defaultRecordRoot, diskFreeGb, UA, windowBg } from './util'
import { logger } from './services/logger'
import { asUser } from './services/netGate'
import { thumbs } from './services/thumbs'
import { mt, setMainLocale } from './i18n'
import { logs as diagLogs, snapshot as diagSnapshot } from './services/diag'

async function pandaAccount(): Promise<AccountState> {
  let realLogin = false
  let isAdult = false
  let userIdx: number | null = null
  let netFail = false
  // 这行日志每取一次态就落一行, 而真发只有少数(30 秒结果缓存 + 在途合并):
  // 事后照行数复请求数会把 2 发数成 6 发 —— 把"真发/缓存/未问"写进那一行, 账才自证
  // 再加一档"合并": 在途合流的那几个调用点同样没出门, 但它们既不是缓存里读的也不是自己发的 —— 三档不齐时, 行数照复仍会多算
  let verify: '真发' | '缓存' | '合并' | '未问' = '未问'
  if (api.hasSession()) {
    const info = await api.checkLoginInfo()
    realLogin = info.isLogin
    isAdult = info.isAdult
    userIdx = info.idx
    netFail = info.netFail
    verify = info.fromCache ? '缓存' : info.merged ? '合并' : '真发'
  }
  const state: AccountState = {
    loggedIn: api.hasSession(),
    cookieValid: api.hasSession() && (api.cookieValid || realLogin),
    realLogin,
    isAdult,
    userIdx,
    netFail,
    lastVerifyAt: api.lastLoginCheckAt,
    encrypted: vault.encrypted
  }
  // 登录态核对留痕: 区分「本地没存住(cookie=0)」与「服务端判死(有cookie但未登录)」与「网络/风控误检(netFail)」
  logger.info(
    'auth',
    `Panda 登录态核对: cookie=${api.cookieCount}枚 会话=${api.hasSession() ? '有' : '无'} ` +
      `官方校验[${verify}]=${netFail ? '请求失败(网络/风控)' : realLogin ? `已登录${isAdult ? ' +成人认证' : ' 无成人认证'}` : api.hasSession() ? '未登录(cookie已被服务端作废)' : '未登录'}`
  )
  return state
}

/** SOOP 登录态: 会话罐(persist:soop)就是唯一存储, 判据只认 get_private_info 回的 LOGIN_ID
 *  hasJar 为假时不发请求(匿名态压根没 Cookie), netFail 单列 —— 不许把网络故障报成"未登录" */
async function soopAccount(): Promise<SoopAccountState> {
  let hasCookies = await soopApi.hasJarCookies()
  const cred = soopApi.credentials()
  // 托管着账密却没 Cookie(首装/清过会话/被服务端作废): 这里懒触发一次自动重登。
  // 不做的话"账密自动重登"只在拉流撞 -6 时才生效, 顶栏与账号页会一直显示未登录;
  // 不放启动流程是为了不在启动窗口塞外部请求 —— 取态本身就是按需的(tryAutoLogin 自带 60s 冷却与在途去重)
  if (!hasCookies && cred.username && cred.hasPassword && (await soopApi.tryAutoLogin())) {
    hasCookies = await soopApi.hasJarCookies()
    logger.info('auth', `SOOP 无 Cookie + 有托管账密: 自动重登成功(${maskLoginId(cred.username)})`)
  }
  const v = hasCookies ? await soopApi.verifyLogin() : { isLogin: false, loginId: '', nick: '', netFail: false }
  // 同 Panda 那一行: 2 分钟结果缓存吃掉了大多数取态, 行数 ≠ 发数
  const verify = !hasCookies ? '未问' : v.fromCache ? '缓存' : v.merged ? '合并' : '真发'
  const state: SoopAccountState = {
    hasCookies,
    realLogin: v.isLogin,
    netFail: v.netFail,
    loginId: v.loginId,
    nick: v.nick,
    credentialUser: cred.username,
    lastVerifyAt: soopApi.lastVerifyAt
  }
  logger.info(
    'auth',
    `SOOP 登录态核对: cookie=${hasCookies ? '有' : '无'} ` +
      `官方校验[${verify}]=${v.netFail ? '请求失败(网络/风控)' : v.isLogin ? `已登录 ${maskLoginId(v.loginId)}` : '未登录'} ` +
      `托管账密=${cred.username ? maskLoginId(cred.username) : '无'}`
  )
  return state
}

async function pushAccounts(): Promise<AccountStates> {
  // 两平台并行取态: 各自打一次官方接口, 串行等于把最慢那一方的等待时间叠加一遍
  const [pandalive, soop] = await Promise.all([pandaAccount(), soopAccount()])
  const states: AccountStates = { pandalive, soop }
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send(EV.account, states)
  return states
}

/** SOOP Cookie 导入: 先用 Node 直发做"试验证", 通过才落罐
 *  (实测 Chromium 会忽略手工 Cookie 头, 所以校验不能走会话通道, 否则会拿罐里的旧 Cookie 冒充新 Cookie) */
async function importSoopCookies(cookieStr: string): Promise<{ ok: boolean; message: string }> {
  const info = await soopApi.verifyLogin(String(cookieStr || '').trim())
  if (info.netFail) {
    logger.warn('auth', 'SOOP Cookie 导入被拒: 校验接口请求失败(网络/风控)')
    return { ok: false, message: mt('soop.importNetFail') }
  }
  if (!info.isLogin) {
    logger.warn('auth', 'SOOP Cookie 导入被拒: get_private_info 未返回 LOGIN_ID(过期/无效)')
    return { ok: false, message: mt('soop.importInvalid') }
  }
  const n = await soopApi.storeCookies(cookieStr)
  // storeCookies 里清了源账, 而这些房本轮早已在播(状态不翻转 ⇒ 开播那一入口不会为它们再响):
  // 当场补一次排队, 否则「登录后一律重取」要等到用户点进播放器才兑现
  watcher.resweepPrewarm('soop')
  logger.info('auth', `SOOP Cookie 导入成功: ${maskLoginId(info.loginId)}(${n} 枚)`)
  pushAccounts()
  return { ok: true, message: mt('soop.importOk', { id: info.loginId }) }
}

/** 房间寻址入参的边界校验: 渲染层一旦被注入脚本/XSS, 这些字符串就是它唯一能递进主进程的载荷。
 *  - 平台必须命中枚举: sourceFor 对未知值兜底成 Panda, 静默改写会把请求与 Cookie 落到另一方的账号上
 *  - userId 见 isRoomId(与用户输入解析共用一把尺: 它参与主键, 又被裸拼进落盘目录名)
 *  返回 null=通过, 否则为可直接显示给渲染层的错误串(调用方按各自返回形态消化, 不抛异常打断 UI) */
function roomErr(platform: unknown, userId: unknown): string | null {
  let err: string | null = null
  if (!isPlatform(platform)) err = mt('ipc.badPlatform')
  else if (!isRoomId(userId)) err = mt('ipc.badUserId')
  if (err) logger.warn('ipc', `房间入参被拒(${platform}/${String(userId).slice(0, 40)}): ${err}`)
  return err
}

/** 房间密码的入参收敛: 截 64 位并去控制字符。它会被拼进 SOOP 的 BPWD 查询串、也会进日志,
 *  \r\n 放进去就是日志伪造/请求头注入口。合法密码(可见字符, 十几位)不受影响 */
function safePwd(p: unknown): string {
  return typeof p === 'string' ? p.slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, '') : ''
}

/** (C7) 「手动刷新/重试」那一发的下限, 与 tick 同一条 8 秒纪律。
 *  取流是当时唯一还没有下限的人手放大面: 它同时拿着 force(越过缓存)、fullVariants(全档菜单)、
 *  asUser(越过按站车道)三重特权, 连点 N 下 = N 条完整取源链同时插队(SOOP 单链实测 8~10 发)。
 *  闸只挡"刚强制取成功"的那一发(落账的也只有它): 失败从来不记账, 所以源真死了再点一次永远照发 ——
 *  重复的是读数, 不是失败; 而进房那一发(非强制)也不记账, 免得把手动刷新那一按钮闸成哑的 */
const PLAY_FRESH_MIN_MS = 8_000
const freshTakenAt = new Map<string, number>()

function freshThrottled(key: string): boolean {
  const last = freshTakenAt.get(key) || 0
  return last > 0 && Date.now() - last < PLAY_FRESH_MIN_MS
}

function markFreshTaken(key: string): void {
  // 这张表只装"用户手动强取过源"的房, 正常规模是个位数; 真被长会话堆大了就摘掉已过窗口的(不引入第二套清理)
  if (freshTakenAt.size >= 256) for (const [k, at] of freshTakenAt) if (Date.now() - at >= PLAY_FRESH_MIN_MS) freshTakenAt.delete(k)
  freshTakenAt.set(key, Date.now())
}

/** 站内关注行的共用形状: SOOP 的 favorite 行与 Panda 的 bookmark 行都能结构匹配到这里 */
interface FollowIn {
  userId: string
  userIdx?: number | null
  nick: string
  userImg?: string
  isLive: boolean
  /** 上一次开播时刻(KST 钟面): SOOP 关注列表带 last_broad_start, Panda 的 bookmark 行没有这个字段 */
  lastStartTime?: string
  live: {
    title?: string
    thumbUrl?: string
    userImg?: string
    startTime?: string
    viewers?: number
    likes?: number
    fans?: number
    isAdult?: boolean
    isPw?: boolean
    type?: string
    liveType?: string
  } | null
}

/** 站内关注 → 已关注页的共用落库语义(两平台一处规定):
 *  只增不改不删(已在库的跳过, 不用列表值覆盖用户本地状态)、列表内重复只算一次、
 *  autoRecord 恒为关(批量撞上 autoRecordDefault=true = 一次性给几十个在播房开自录,
 *  磁盘与风控都是瞬时灾难)、整批只 flush 一次。
 *  listComplete=false 时跳过 D3 反向差值: 站内列表被官方截断(북마크 上限 200)时
 *  "本地有、列表没有"完全可能是翻页截断而非真取关, 宁可不标。 */
async function importFollowRows(platform: Platform, rows: FollowIn[], listComplete = true): Promise<FollowImportResult> {
  const cfg = store.getSettings()
  const seen = new Set<string>()
  let added = 0
  for (const r of rows) {
    if (seen.has(r.userId)) continue
    seen.add(r.userId)
    if (store.listAnchors().find((a) => a.platform === platform && a.userId === r.userId)) continue
    const live = r.live
    const anchor: Anchor = {
      platform,
      userId: r.userId,
      userIdx: r.userIdx ?? null,
      nick: r.nick || r.userId,
      userImg: live?.userImg || r.userImg || '',
      isLive: !!live,
      title: live?.title || '',
      // 出生写: 这一支只在"库里还没有这个房间"时走到(上面已跳过在库的), 没有既有真值可覆盖,
      // 所以 !! 把未知压成 false 是安全默认; 后续每轮由列表回写按字段纠正。
      // SOOP 的行不再携带 isAdult(解析层不读 is_adult, 见 soop.ts parseFavoriteRow) —— 这里恒为 false, 卡片自然不画 19+
      tags: live ? { isAdult: !!live.isAdult, isPw: !!live.isPw, type: live.type || '', liveType: live.liveType || 'live' } : null,
      startTime: live?.startTime || '',
      viewerCount: live?.viewers || 0,
      likes: live?.likes || 0,
      fans: live?.fans || 0,
      thumbUrl: live?.thumbUrl || '',
      autoRecord: false,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
      // 在播房的「上次开播」就是本场 startTime; 离线房取列表回包的 last_broad_start(仅 SOOP 有)
      lastLiveAt: live?.startTime || r.lastStartTime || ''
    }
    store.addAnchor(anchor)
    added++
    if (anchor.isLive && cfg.monitor[platform].prefetchStream) watcher.prewarmNow(platform, r.userId) // 限速泵逐发, 不会齐发
  }
  // D3 反向差值: 站内列表里没有、本地仍在墙上挂着的 → 标「站内已取关 · 本地仍保留」。
  // 只写标注, 一个房间都不删(删墙是用户的决定); 重新被站内列表带回时清掉标注。
  let siteGone = 0
  if (listComplete) {
    for (const a of store.listAnchors()) {
      if (a.platform !== platform) continue
      const gone = !seen.has(a.userId)
      if (gone === !!a.siteGone) continue
      store.updateAnchor(platform, a.userId, { siteGone: gone })
      if (gone) siteGone++
    }
  }
  store.flush()
  logger.info(
    platform === 'soop' ? 'soop' : 'api',
    `关注导入: 站内 ${rows.length} 条, 新增 ${added} 条, 已在库跳过 ${rows.length - added} 条` +
      (listComplete ? `, 本次标注站内已取关 ${siteGone} 条` : ', 列表被截断, 跳过已取关标注')
  )
  BrowserWindow.getAllWindows()[0]?.webContents.send(EV.anchors, store.listAnchors())
  return { total: rows.length, added, siteGone }
}

export function registerIpc(): void {
  // ---------- 账号(两套登录态互不影响) ----------
  ipcMain.handle(CH.authState, () => pushAccounts())

  // 账号页「立即重新校验」: 绕过 30s/2min 结果缓存真实打一次官方接口。
  // 只在用户点击时发生, 不进轮询; 无会话时直接取态不发请求(匿名态压根没凭证可验)
  // 这一发打用户级标记 —— 它过车道(车道就把它管住了), 缺的是"用户亲自在等"那一格:
  // 不打标记它就和后台泵排在同一条尾锁之后(最坏 MAX_WAIT_MS 8 秒), 而这一颗按钮的全部意义是"现在就问"。
  // 后台那条登录探针(watcher.ts:512)照旧走慢道, 它不是用户点的
  ipcMain.handle(CH.authRecheck, async (_e, platform: Platform) => {
    const plat = isPlatform(platform) ? platform : DEFAULT_PLATFORM
    if (plat === 'soop') {
      if (await soopApi.hasJarCookies()) await asUser(() => soopApi.verifyLogin(undefined, true))
    } else if (api.hasSession()) {
      await asUser(() => api.checkLoginInfo(undefined, true))
    }
    return pushAccounts()
  })

  ipcMain.handle(CH.authOpenWindow, async (e, platform: Platform) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, message: mt('auth.winMissing') }
    const r = await openLoginWindow(win, isPlatform(platform) ? platform : DEFAULT_PLATFORM)
    const plat = isPlatform(platform) ? platform : DEFAULT_PLATFORM
    if (r.ok) {
      logger.info('auth', `${plat} 网页登录成功`)
      if (plat === 'soop') {
        soopApi.clearPlayCache() // 匿名态签发的源对 19+/限区房无效, 登录后一律重取
        watcher.resweepPrewarm('soop') // 「一律重取」落在这一行: 在播房不会再触发开播翻转, 不补扫就得等用户点进播放器
      }
    } else {
      logger.info('auth', `${plat} 网页登录未完成: ${r.message}`)
    }
    pushAccounts()
    return r
  })

  ipcMain.handle(CH.authImportCookies, async (_e, cookieStr: string, platform: Platform) => {
    const plat = isPlatform(platform) ? platform : DEFAULT_PLATFORM
    if (plat === 'soop') return importSoopCookies(cookieStr)
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
    watcher.resweepPrewarm('pandalive') // importCookies 里清了源账: 当场给在播房重新排队
    logger.info('auth', `Cookie 导入成功(成人认证=${info.isAdult ? '有' : '无'})`)
    pushAccounts()
    return { ok: true, message: info.isAdult ? mt('auth.importOkAdult') : mt('auth.importOkNoAdult') }
  })

  ipcMain.handle(CH.authLogout, async (_e, platform: Platform) => {
    const plat = isPlatform(platform) ? platform : DEFAULT_PLATFORM
    if (plat === 'soop') {
      // logout() 里连同托管账密一起清: 否则下一次 -6 会把用户刚登出的会话又静默登回来
      await soopApi.logout()
      logger.info('auth', '退出 SOOP: 会话 Cookie/站点存储/托管账密已清')
      pushAccounts()
      return true
    }
    api.clearCookies()
    logger.info('auth', '退出登录: Cookie/站点存储已清')
    try {
      await session.fromPartition(SESSION_PARTITION).clearStorageData()
    } catch { /* ignore */ }
    pushAccounts()
    return true
  })

  ipcMain.handle(CH.authSaveSoopCredentials, async (_e, username: string, password: string) => {
    const u = String(username || '').trim()
    if (!u) {
      soopApi.clearCredentials()
      logger.info('auth', '已解除 SOOP 账密托管')
      pushAccounts()
      return { ok: true, message: mt('soop.credCleared') }
    }
    try {
      // 先真登一次再落库: 错凭据存下来只会在下次 -6 时静默失败, 等于埋个哑弹
      const info = await soopApi.loginWithPassword(u, String(password || ''))
      watcher.resweepPrewarm('soop') // 登录成功那次 storeCookies 清了源账
      soopApi.saveCredentials(u, String(password || ''))
      logger.info('auth', `SOOP 账密托管成功: ${maskLoginId(info.loginId)}`)
      pushAccounts()
      return { ok: true, message: mt('soop.credSaved', { id: info.loginId }) }
    } catch (e) {
      const msg = String((e as Error).message || e)
      logger.warn('auth', `SOOP 账密托管失败: ${msg}`)
      return { ok: false, message: msg }
    }
  })

  // ---------- 主播 ----------
  ipcMain.handle(CH.anchorsList, () => store.listAnchors())

  ipcMain.handle(CH.anchorsAdd, async (_e, input: string, platform?: Platform) => {
    // 支持粘贴 URL: https://www.pandalive.co.kr/play/xxx | https://play.sooplive.com/频道名/场次号; 裸 ID 归所选/默认平台
    const parsed = parseRoomInput(input || '', isPlatform(platform) ? platform : DEFAULT_PLATFORM)
    if (!parsed) throw new Error(mt('anchors.invalid'))
    const { platform: plat, userId } = parsed
    if (store.listAnchors().find((a) => a.platform === plat && a.userId === userId)) throw new Error(mt('anchors.exists'))

    let nick = userId
    let userIdx: number | null = null
    let userImg = ''
    let title = ''
    let isLive = false
    /** 大厅之外(目前只有 SOOP)从播放页顺手拿到的截图 */
    let pageThumb = ''
    /** member/bj 那一发顺带回来的在播读数(标题/标签/观众数), 与 applyBj 同一判据 */
    let bjLive: LiveItem | null = null

    // 优化: 大厅(discovery)里已有该主播数据时直接复用, 省一次 fetchBj 请求且即时点亮
    // 大厅与 fetchBj 都是 pandalive 专有能力, 其它平台先按裸 ID 落库, 由各自轮询补全
    const disc = plat === 'pandalive' ? watcher.getDiscovery().find((d) => d.userId === userId) : undefined
    if (disc) {
      nick = disc.nick
      userIdx = disc.userIdx
      userImg = disc.userImg
    } else if (plat === 'pandalive') {
      try {
        const info = await api.fetchBj(userId)
        nick = info.nick || userId
        userIdx = info.userIdx
        userImg = info.userImg
        // 这一发的响应里本来就带着"此刻在不在播"和整卡读数, 旧写法只取上面三格、把 media 整包丢掉,
        // 于是新房按离线落库 → 下面走 trackIdle → 间隙泵 1.2 秒后对同一 userId 再发一次同端点。
        // 同一件事打两遍，而第一发买回来的真值白扔 —— 判据与 applyBj 一致(只看 media.isLive)
        if (info.media?.isLive) bjLive = info.media
      } catch {
        /* 主播信息拉取失败也允许添加, 等轮询补全 */
      }
    } else {
      // SOOP 无大厅: 播放页一发就有主播名/标题/在播态, 关注当场点亮卡片
      userImg = soopAvatarUrl(userId) // 列表与页面都不回头像字段, 地址由频道 ID 派生
      try {
        const m = await soopApi.fetchPageMeta(userId, false, false, '添加')
        nick = m.hostName || userId
        title = m.roomName
        isLive = m.living
        pageThumb = m.thumbUrl
      } catch {
        /* 页面拉不到也允许添加(网络/限区), 由轮询兜底 */
      }
    }

    const cfg = store.getSettings()
    const anchor: Anchor = {
      platform: plat,
      userId,
      userIdx,
      nick,
      userImg,
      isLive: isLive || !!disc || !!bjLive,
      title: disc?.title || bjLive?.title || title,
      tags: disc
        ? { isAdult: disc.isAdult, isPw: disc.isPw, type: disc.type, liveType: disc.liveType }
        : bjLive
          ? { isAdult: !!bjLive.isAdult, isPw: !!bjLive.isPw, type: bjLive.type || '', liveType: bjLive.liveType || '' }
          : null,
      startTime: disc?.startTime || bjLive?.startTime || '',
      viewerCount: disc?.viewers || bjLive?.user || 0,
      likes: disc?.likes || bjLive?.likeCnt || 0,
      fans: disc?.fans || bjLive?.fanCnt || 0,
      thumbUrl: disc?.thumbUrl || bjLive?.thumbUrl || pageThumb,
      autoRecord: cfg.autoRecordDefault[plat],
      addedAt: Date.now(),
      lastSeenAt: disc || bjLive ? Date.now() : 0,
      lastLiveAt: disc?.startTime || bjLive?.startTime || ''
    }
    store.addAnchor(anchor)
    watcher.unmarkGone(plat, userId) // 也可能是已修正的新 ID: 允许重新探活
    // 关注"已在播"主播: 后台预取一次直播源(进房零等待)。列表模式下 onLiveStart 只认
    // 离线→在线翻转, 对关注时已在播的主播永不再触发 —— 这里补洞, 与逐个模式语义对齐。
    // 不作废旧缓存: 先进房再关注 = 命中刚拉取的新鲜源, 预取泵自然 no-op, 不重发请求;
    // 密码房已验证源得以保留(playCache 免密复用契约), 不会二次进房重问密码。
    if (anchor.isLive && cfg.monitor[anchor.platform].prefetchStream) {
      watcher.prewarmNow(anchor.platform, anchor.userId)
    } else {
      // 未开播: 当场排进间隙泵队首, 下一发空档就复查它一次, 不用等整轮轮到(检测与否不看 prefetchStream)
      watcher.trackIdle(plat, userId)
    }
    // 不再触发 tick: 大厅数据已即时点亮; 列表不可见的由间隙泵与轮换兜底在后续轮次发现
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.anchors, store.listAnchors())
    return anchor
  })

  /** 「导入站内 SOOP 关注」: 一发关注列表全量落库(含离线房) */
  ipcMain.handle(CH.anchorsImportSoop, async (): Promise<FollowImportResult> => {
    const rows = await soopApi.fetchFavorites()
    if (!rows) throw new Error(mt('soop.importFail'))
    return importFollowRows('soop', rows)
  })

  /** 「导入站内 Panda 关注」: 북마크 列表(官方上限 200)全量落库, 与 SOOP 导入同语义。
   *  取满 200 = 用户关注数触到官方上限, 列表可能不完整, 因此这一趟不做「站内已取关」差值 */
  ipcMain.handle(CH.anchorsImportPanda, async (): Promise<FollowImportResult> => {
    const rows = await api.fetchBookmarks()
    if (!rows) throw new Error(mt('panda.importFail'))
    return importFollowRows('pandalive', rows, rows.length < 200)
  })

  ipcMain.handle(CH.anchorsRemove, async (_e, platform: Platform, userId: string) => {
    if (roomErr(platform, userId)) return false
    // 先取关再停录: removeAnchor 先于 await 落库, watcher 的 stillMonitored 守卫立即生效 ——
    // 否则 stop 的慢窗口(remuxing 收尾最长达分钟级)内开播翻转会穿过守卫启动孤儿录制
    store.removeAnchor(platform, userId)
    watcher.unmarkGone(platform, userId) // 查无此人标记一并解除(将来重加/账号恢复可重新探活)
    await recorder.stop(platform, userId)
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.anchors, store.listAnchors())
    return true
  })

  ipcMain.handle(CH.anchorsSetAuto, (_e, platform: Platform, userId: string, auto: boolean) => {
    if (roomErr(platform, userId)) return false
    store.updateAnchor(platform, userId, { autoRecord: auto })
    return true
  })

  ipcMain.handle(CH.anchorsRefresh, (_e, platform: Platform) => {
    // 工作区的「立即刷新」站在某一平台页上: 只惊动那一条时间轴, 不为另一个平台多发一轮请求。
    // 平台不认识(旧调用/坏入参)才退回首轮语义: 两平台各一轮
    watcher.tick(isPlatform(platform) ? platform : undefined)
    return true
  })

  // ---------- 播放 ----------
  ipcMain.handle(CH.livePlay, async (_e, platform: Platform, userId: string, password?: string, fresh?: boolean): Promise<PlayInfo> => {
    const bad = roomErr(platform, userId)
    if (bad) return { ok: false, error: bad }
    // 刚成功强取过源的那 8 秒里不再重打整链, 退回复用手里那份 —— 用户要的是"能播", 不是"再打一次"
    const roomKeyStr = roomKey(platform, userId)
    const freshNow = !!fresh && !freshThrottled(roomKeyStr)
    if (fresh && !freshNow) logger.info('ipc', `取流强制刷新节流: 距上一次强制取源不到 ${PLAY_FRESH_MIN_MS / 1000}s, 复用刚取到的那份 @${userId}`)
    let r
    try {
      // 走秒开快道: 手里那份能播就先出画(哪怕清晰度菜单只解了最高档), 缺的档由它在后台补齐;
      // 菜单齐与没齐两条路合流到同一条链上 —— 旧写法把整条取流链压在"等第一帧"这条路上,
      // 而它等的那几档用户多半一档都不点(省发取舍原封不动, 改的只是谁该等)
      r = await asUser(() => sourceFor(platform).getPlayFast(userId, safePwd(password), freshNow))
    } catch (e) {
      // 网络异常/风控(403/429 等)——必须回落为 ok:false, 否则前端永远停在"获取直播流…"
      return { ok: false, error: mt('ipc.playFail', { msg: (e as Error).message || String(e) }) }
    }
    if (!r.ok) {
      // needLogin 必须透传: 前端据此弹"去登录"引导, 丢了就只剩一句无法行动的报错文案
      return { ok: false, needPassword: r.needPassword, needLogin: r.needLogin, error: r.error }
    }
    if (freshNow) markFreshTaken(roomKeyStr) // 只有真强制取到源才落账: 失败与"复用缓存"都不许把下一次重试也闸掉
    // SOOP: 点开播就把开播时刻/密码房标记补回关注卡(零额外请求), 并拿回"与库里同一份"的房态给渲染层
    const merged = applyPlayMeta(platform, userId, r)
    return {
      ok: true,
      vod: !!r.vod,
      m3u8: r.m3u8,
      variants: r.variants,
      // 这一份的菜单残缺 ⇒ 前端追一发 liveMenu 补齐(那一发与后台那条链合流, 不多打请求)
      partial: !!r.partial,
      hlsBackups: r.hlsBackups,
      fetchedAt: r.fetchedAt,
      title: r.title || '',
      nick: r.nick || '',
      thumbUrl: r.thumbUrl || '',
      userImg: r.userImg || '',
      // Panda 走不到 merged(applyPlayMeta 对它直接返回 null —— 它的房态每轮由列表原值维护), 仍按回包整包给
      tags: merged ?? (r.media
        ? {
            isAdult: !!r.media.isAdult,
            isPw: !!r.media.isPw,
            type: String(r.media.type || ''),
            liveType: String(r.media.liveType || '')
          }
        : undefined)
    }
  })

  // 清晰度菜单补齐: livePlay 回了 partial 之后前端追这一发。
  // 它不是一条新链路 —— getPlayCached(fullVariants=true) 与快道顺手起的那条后台整链在 playInflight 上同号合流:
  // 在途就等它落地, 已落地就直接命中缓存, 两条路都不问平台。这一发失败也不报错(菜单保持残缺, 用户照常在看)
  ipcMain.handle(CH.liveMenu, async (_e, platform: Platform, userId: string, password?: string): Promise<PlayMenu> => {
    if (roomErr(platform, userId)) return { ok: false }
    try {
      const r = await asUser(() => sourceFor(platform).getPlayCached(String(userId), safePwd(password), false, true))
      if (!r.ok) return { ok: false }
      return { ok: true, variants: r.variants, hlsBackups: r.hlsBackups, partial: !!r.partial }
    } catch {
      return { ok: false }
    }
  })

  // 播放器亲证那一条清单 404/403 ⇒ 主进程当场摘掉缓存里那一份(只摘源包, 门槛账那些防重复的账不动)。
  // 为什么必须是渲染层来报: Panda 的播放地址不经本地代理, 那一次 404 主进程一行都没读到(实测 2026-10-03
  // 23:33:38 播放器喊 404, 同一份源包直到 23:38:52 才被保活的双测追认 —— 5min14s 里卡片一直挂着「秒开」)。
  // 摘完之后前端紧接着那一次强制重取才是真打; 不摘则它仍会命中那份死源、原样再 404 一次。
  // deadUrl 是渲染层递进来的字符串: 截长 + 去控制字符(它不进日志, 但闸门统一按 safePwd 那把尺)
  ipcMain.handle(CH.liveSrcDead, (_e, platform: Platform, userId: string, deadUrl?: string) => {
    if (roomErr(platform, userId)) return false
    const dead = typeof deadUrl === 'string' ? deadUrl.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, '') : ''
    const dropped = sourceFor(platform).dropCachedPlay(String(userId), dead || undefined)
    logger.warn('ipc', `播放器亲证直播源已死: @${String(userId)}(${dropped ? '缓存那份已当场作废' : '缓存里没有那一份(源已被换过或本就没有)'})`)
    return dropped
  })

  ipcMain.handle(CH.liveSrcCache, () => cachedSourceIdsAll())

  ipcMain.handle(CH.liveKeepaliveStatus, (_e, platform: Platform, userId: string) => {
    // 非法寻址不查保活表(api.keepaliveStatus 会按裸 userId 建条目), 回一个"没缓存"的中性投影
    if (roomErr(platform, userId)) return { enabled: false, cached: false, lastAt: 0, lastOk: false, variants: 0 }
    return api.keepaliveStatus(platform, String(userId))
  })

  // ---------- 大厅 ----------
  ipcMain.handle(CH.discoveryList, () => watcher.getDiscovery())
  // 按需刷新: 轮询改用站内关注列表后, 全站榜那几页只在用户打开「发现」时拉;
  // 主进程内 60 秒复用 + 在飞合并, 所以来回切视图不会攒出一串分页请求
  ipcMain.handle(CH.discoveryRefresh, (_e, force?: boolean) => watcher.refreshDiscovery(force === true))

  // ---------- 录制 ----------
  ipcMain.handle(CH.recList, () => recorder.list())
  // 每次取历史先对账外部删改(启动首拉/进库刷新同走此口), 渲染层所见即磁盘实况
  ipcMain.handle(CH.recHistory, () => {
    recorder.reconcileHistory()
    return store.listHistory()
  })

  ipcMain.handle(CH.recStart, async (_e, platform: Platform, userId: string, password?: string) => {
    // 这是唯一会建目录、spawn ffmpeg 的入口: 裸 userId 直接进落盘路径, 校验必须发生在拼路径之前
    const bad = roomErr(platform, userId)
    if (bad) return { ok: false, error: bad }
    // 允许录制未监控的主播(大厅/播放页直接录制)
    const anchor = store.listAnchors().find((a) => a.platform === platform && a.userId === userId)
    let nick = anchor?.nick || userId
    let title = anchor?.title || ''
    if (!anchor && platform === 'pandalive') {
      try {
        const info = await api.fetchBj(userId)
        nick = info.nick || userId
        title = info.media?.title || ''
      } catch {
        /* 拿不到信息也允许尝试录制 */
      }
    } else if (!anchor && platform === 'soop') {
      // SOOP 同样要在建目录前拿到真名: 落盘路径是 <根>/soop/<主播名(主播ID)>, 用频道号占位会得到不可读目录
      try {
        const m = await soopApi.fetchPageMeta(userId, true, false, '录制取名')
        nick = m.hostName || userId
        title = m.roomName || ''
      } catch {
        /* 拿不到信息也允许尝试录制 */
      }
    }
    try {
      return await recorder.start({
        platform,
        userId,
        nick,
        title,
        password: safePwd(password),
        auto: false
      })
    } catch (e) {
      const err = e as Error & { needPassword?: boolean }
      return { ok: false, needPassword: !!err.needPassword, error: err.message }
    }
  })

  ipcMain.handle(CH.recStop, (_e, platform: Platform, userId: string) => {
    if (roomErr(platform, userId)) return
    return recorder.stop(platform, userId)
  })

  ipcMain.handle(CH.recOpenFolder, async (_e, dir: string) => {
    // M10: 只允许打开录制/应用数据相关目录(任意路径探测封堵; 对照 openExternal 已有白名单)
    // 空串 = 「打开保存目录」但用户没改过路径: 落在默认录制根(它本来就在白名单里), 而不是 process.cwd()
    const resolved = path.resolve(String(dir || '').trim() || defaultRecordRoot())
    const roots = new Set<string>([
      path.resolve(store.getSettings().savePath || defaultRecordRoot()),
      path.resolve(defaultRecordRoot()),
      // 设置页「打开目录」按钮传的是应用数据目录(data/), 与录制根平级 —— 不放行则恒被拒
      path.resolve(dataDir())
    ])
    for (const h of store.listHistory()) if (h.dirPath) roots.add(path.resolve(h.dirPath))
    const allowed = [...roots].some((root) => {
      const rel = path.relative(root, resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!allowed) {
      logger.warn('ipc', `打开目录被白名单拒绝: ${resolved}`)
      return false
    }
    // 白名单过关不等于目录存在: 默认录制根只在第一次开录时才建, 用户也可能手动删过。
    // shell.openPath 对不存在的路径只回一个错误串、界面毫无动静, 于是「点了没反应」= 原缺陷。
    try {
      await fs.promises.mkdir(resolved, { recursive: true })
    } catch (e) {
      logger.warn('ipc', `创建录制目录失败: ${resolved} ${(e as Error).message}`)
      return false
    }
    const openErr = await shell.openPath(resolved)
    if (openErr) logger.warn('ipc', `打开目录失败: ${resolved} ${openErr}`)
    return !openErr
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
  // secretsEncrypted 同为投影: 系统密钥不可用时保险箱是可逆编码明文, UI 必须据此改口而不是继续宣称"加密"
  const projectTg = (): Settings => ({
    ...store.getSettings(),
    tgTokenSet: Boolean(secrets.get('tgToken')),
    secretsEncrypted: !secrets.degraded
  })

  ipcMain.handle(CH.settingsGet, () => projectTg())

  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => {
    // 入站先过闸(类型/区间/枚举/绝对路径), 不合格键不收 —— 闸门必须在写盘之前:
    // 收了坏值就是「盘已写脏、后续每次保存都在 applyProxy 里抛」的分叉态, 只能重启才解
    const { patch: clean, dropped } = sanitizeSettingsPatch(patch)
    if (dropped.length) logger.warn('app', `设置补丁拒收: ${dropped.join(', ')}`)
    const before = store.getSettings()
    const cfg = store.setSettings(clean)
    // 变更留痕(排查"参数什么时候被改过"类问题; 代理地址可能内嵌凭据, 一律掩码)
    // 值比对走 JSON: 通知矩阵/自录默认是嵌套对象, 浅比较恒不等 → 每次保存都把整块原值写进日志
    const showVal = (v: unknown): string => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))
    const diffs = (Object.keys(clean) as (keyof Settings)[])
      .filter((k) => clean[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(cfg[k]))
      .map((k) =>
        k === 'proxyUrl' || k === 'tgProxy'
          ? (cfg[k] ? `${k}=已设置` : `${k}=已清空`)
          : `${k}=${showVal(before[k])}→${showVal(cfg[k])}`
      )
    if (diffs.length) logger.info('app', `设置变更: ${diffs.join(', ')}`)
    if (before.theme !== cfg.theme) {
      // 「主题立即生效」不能只管界面: 窗口底色是 createWindow 的一次性读值, 不同步就慢一拍
      BrowserWindow.fromWebContents(_e.sender)?.setBackgroundColor(windowBg(cfg.theme))
    }
    // 生效动作失败只留痕, 不回拒 IPC: 盘已经写对, 抛错会让前端以为没存上而反复重试
    try {
      applyProxy(cfg.proxyUrl)
      setMainLocale(cfg.locale) // 语言变更即时注入主进程 i18n(单向数据流)
      // 只有轮询相关设置的【值真的变了】才即时拉一轮(不能按 key 存在判断)。
      // 节奏分家后按平台惊动: 只调 SOOP 那一格就不该为 Panda 多发一轮请求。
      // watchMode/proxy 仍是全局键 —— 它们动一次, 两条时间轴一起重排。
      const nudge = new Set<Platform>()
      if (before.watchMode !== cfg.watchMode || before.proxyUrl !== cfg.proxyUrl) {
        nudge.add('pandalive')
        nudge.add('soop')
      }
      for (const p of ['pandalive', 'soop'] as const) {
        if (JSON.stringify(before.monitor[p]) !== JSON.stringify(cfg.monitor[p])) nudge.add(p)
      }
      for (const p of nudge) watcher.tick(p)
    } catch (e) {
      logger.warn('app', `设置已保存但生效动作失败: ${String((e as Error).message || e)}`)
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

  // ---------- 诊断台: 只读投影, 这两个入口本身不发请求、不写盘 ----------
  ipcMain.handle(CH.diagSnapshot, () => diagSnapshot())
  // 渲染层给来的两个数都当不可信输入过一遍: 这一条口子递出去的是日志原文, 上限就是它的形状
  ipcMain.handle(CH.diagLogs, (_e, sinceSeq: unknown, limit?: unknown) =>
    diagLogs(Number(sinceSeq), Math.min(Math.max(Number(limit) || 400, 1), 800))
  )

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
    authorUrl: APP_META.authorUrl,
    repo: APP_META.repo,
    releasesPage: APP_META.releasesPage,
    logsDir: logger.dir()
  }))

  ipcMain.handle(CH.appCheckUpdate, async (): Promise<UpdateCheckResult> => {
    const current = app.getVersion()
    try {
      // 走 releases/latest 网页 302 跳转而非 REST API(匿名 API 有每 IP 60 次/时限流, 共享出口 IP 易爆)
      // 借会话分区发请求而不是 net.fetch: net.fetch 走 defaultSession, 而 applyProxy 只覆盖
      // 登记过的分区 —— 于是"设了死代理、全网不通, 唯独检查更新报成功"。GitHub 域下没有本站
      // Cookie, 借用分区只是拿它的代理配置, 不外带凭据
      const res = await session
        .fromPartition(SESSION_PARTITION)
        .fetch(APP_META.releasesPage + '/latest', { headers: { 'User-Agent': UA } })
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

export { pushAccounts }
