import { app, BrowserWindow, Tray, Menu, nativeImage, session } from 'electron'
import * as path from 'path'
import { registerIpc, pushAccounts } from './ipc'
import { api, SESSION_PARTITION, applyProxy } from './services/pandalive'
import { soopApi } from './services/soop'
import { store } from './services/store'
import { watcher } from './services/watcher'
import { recorder } from './services/recorder'
import { UA, redirectElectronDataDir, windowBg } from './util'
import { mt, setMainLocale } from './i18n'
import { logger } from './services/logger'
import { registerMediaScheme, installMediaHandler } from './services/localMedia'
import { thumbs } from './services/thumbs'

// ============ 应用入口 ============

// 本地录制回看协议(plocal://): 特权声明必须在 app ready 前完成
registerMediaScheme()
// Chromium 运行时数据(session/cache/crashpad)随程序目录: 必须在 app ready 前完成重定向
redirectElectronDataDir()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWin: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/** pandalive 的流(AWS IVS)校验 Origin; 仅对流域注入 Origin/Referer 并补 CORS 响应头 */
function setupHeaderInjection(): void {
  const ses = sessionMain()
  // 注意: 只作用于流域名(live-video.net / cloudfront.net)
  // 绝不可动 api/www.pandalive.co.kr —— 官网带凭证(credentials: include)的请求
  // 遇到 ACAO:* 会被浏览器整体拦截(就是我们之前登录窗 Failed to fetch 的根因)
  const filter = {
    urls: ['https://*.live-video.net/*', 'https://*.cloudfront.net/*']
  }
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders }
    headers['Origin'] = 'https://www.pandalive.co.kr'
    headers['Referer'] = 'https://www.pandalive.co.kr/'
    callback({ requestHeaders: headers })
  })
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...details.responseHeaders } as Record<string, string[]>
    // IVS 自身已回小写键 access-control-allow-origin: * —— 旧写法再加大写键会被 Chromium
    // 视为第二个头, 合并成 '*, *' 双值判 CORS multiple values 必拦(渲染层全灭而 ffmpeg/net.fetch
    // 不吃 CORS, 表现为"能录不能看")。注入前必须删掉所有大小写变体, 保证 ACAO 唯一。
    for (const k of Object.keys(headers)) {
      if (/^access-control-allow-(origin|headers)$/i.test(k)) delete headers[k]
    }
    headers['Access-Control-Allow-Origin'] = ['*']
    headers['Access-Control-Allow-Headers'] = ['*']
    callback({ responseHeaders: headers })
  })
}

function sessionMain(): Electron.Session {
  // 与登录窗共享持久化 partition, 网页登录态直接生效
  return session.fromPartition(SESSION_PARTITION)
}

function createWindow(): void {
  const cfg = store.getSettings()
  mainWin = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 660,
    frame: false,
    show: false,
    // 启动窗口底色跟随主题, 避免加载瞬间主题不符的闪屏(切换时由 settingsSet 同步 setBackgroundColor)
    backgroundColor: windowBg(cfg.theme),
    title: 'SODALive Monitor',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      session: sessionMain(),
      contextIsolation: true,
      nodeIntegration: false,
      // M9: contextIsolation 前提下 preload 仅用 ipcRenderer+Buffer(沙箱 preload 自带 polyfill), 可收紧沙箱
      sandbox: true
    }
  })

  mainWin.once('ready-to-show', () => mainWin?.show())

  mainWin.on('close', (e) => {
    const c = store.getSettings()
    if (c.closeToTray && !quitting && tray) {
      e.preventDefault()
      mainWin?.hide()
    }
  })
  mainWin.on('closed', () => {
    mainWin = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWin.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWin.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  try {
    const resDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources')
    const loadColored = (): Electron.NativeImage => {
      const img = nativeImage.createFromPath(path.join(resDir, 'icon.png'))
      if (img.isEmpty()) logger.warn('app', `托盘图标缺失: ${path.join(resDir, 'icon.png')}`)
      return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 })
    }
    let icon: Electron.NativeImage
    if (process.platform === 'darwin') {
      // mac 菜单栏用专用 template 图(tray-icon-build.mjs 生成, 18pt+@2x): 纯黑剪影+透明底,
      // 系统按菜单栏深浅自动反色。app 图标整面不透明, 挂 template 后 alpha 剪影就是一整个
      // 实心方块 —— 菜单栏"纯白方块"的根因, 故不可复用 icon.png 当 template。
      icon = nativeImage.createFromPath(path.join(resDir, 'trayTemplate.png'))
      if (icon.isEmpty()) icon = loadColored() // template 缺失兜底: 宁要彩色也不要白块/空托盘
      else icon.setTemplateImage(true) // 文件名 Template 后缀本会自动生效, 显式声明双保险
    } else {
      icon = loadColored()
    }
    tray = new Tray(icon)
    tray.setToolTip('SODALive Monitor')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: mt('tray.show'), click: () => (mainWin ? mainWin.show() : createWindow()) },
        {
          label: mt('tray.quit'),
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', () => {
      if (mainWin) {
        mainWin.isVisible() ? mainWin.hide() : mainWin.show()
      } else {
        createWindow()
      }
    })
  } catch (e) {
    console.warn('tray init failed', e)
  }
}

app.whenReady().then(() => {
  // 初始化服务
  logger.cleanup()
  logger.info('app', `SODALive Monitor v${app.getVersion()} 启动 (packaged=${app.isPackaged})`)
  installMediaHandler()
  const cfg = store.getSettings()
  setMainLocale(cfg.locale)
  api.restoreCookies()
  applyProxy(cfg.proxyUrl)
  sessionMain().setUserAgent(UA)
  setupHeaderInjection()
  registerIpc()
  createWindow()
  createTray()
  pushAccounts()

  // 启动登录态自愈(异步, 不挡窗口): vault 快照被服务端判死时, 尝试接管本地浏览器存储里更新的 cookie;
  // 治愈成功再推一次账号状态, UI 徽标随之翻绿
  void (async () => {
    if (api.hasSession() && !(await api.checkLoginInfo()).isLogin && (await api.healFromStore())) {
      pushAccounts()
    }
  })()

  // 启动轮询
  watcher.start()
  // 两平台各一行: 节奏已经分家, 挤成一行等于把"谁在跑多快"重新糊回去
  for (const p of ['pandalive', 'soop'] as const) {
    const m = cfg.monitor[p]
    logger.info(
      'watcher',
      p === 'pandalive'
        ? `Panda 轮询启动(mode=${cfg.watchMode}, 间隔=${m.pollIntervalSec}s, gap=${m.requestGapMs}ms)`
        : `SOOP 轮询启动(间隔=${m.pollIntervalSec}s, gap=${m.requestGapMs}ms)`
    )
  }
  // 源保活泵: 维持已缓存源的会话活性(退出观看后满员房也能凭旧源继续看), 并顺带做 Panda 侧的年龄收手
  api.startKeepalive()
  // SOOP 没有心跳可打, 但同一句记账纪律要有: 缓存里那份签名源过龄就该出队, 徽标才说实话。
  // 这一条只扫内存, 零网络, 也不受 keepaliveStream 影响
  soopApi.startCacheSweep()
  // 上次退出前手上的签名源读回内存账(只读盘, 不发请求), 复活与否等首轮列表那句真值
  soopApi.restorePlayCache()
  // 重启后源缓存(内存态)为空的补洞改由 watcher 在首轮落地后做:
  // 旧实现在这里按库里的 isLive(上一场的快照)逐个 prewarm —— 开机头 90 秒实测 14~36 发整页读
  // + 16~21 发取流, 其中不少房其实已经下播; 首轮先用真值把状态校准, 再只预取仍然在播且无源的房

  app.on('second-instance', () => {
    if (mainWin) {
      mainWin.show()
      mainWin.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let stoppingForQuit = false
app.on('before-quit', (e) => {
  quitting = true
  // 任何退出路径先杀缩略图子进程(不挂录制收尾链; .tmp_ 由启动 sweep 回收)
  try {
    thumbs.terminateAll()
  } catch {
    /* ignore */
  }
  // M1: remuxing(转码/合并中)同样不可直接退出, 否则截断 MP4 收尾产物
  const hasActive = recorder.list().some((t) => t.status === 'recording' || t.status === 'remuxing')
  if (hasActive && !stoppingForQuit) {
    e.preventDefault()
    stoppingForQuit = true
    logger.info('app', `退出: ${recorder.list().filter((t) => t.status === 'recording' || t.status === 'remuxing').length} 个录制任务收尾中`)
    void recorder
      .stopAll()
      .catch(() => undefined) // 收尾异常不得卡死退出
      .finally(() => {
        logger.info('app', '录制收尾完成, 应用退出')
        store.flush()
        soopApi.flushPacks()
        app.quit()
      })
    return
  }
  store.flush()
  soopApi.flushPacks() // 源留存的落盘有 2 秒合并窗口, 退出前把挂起的那一次结掉
})

// OS 关机/注销(Windows WM_ENDSESSION): 走同一优雅退出链 —— 否则录制被硬杀
// (runtime 的 App 事件 'session-end'; electron.d.ts 只把它生成在 AutoUpdater/BluetoothDevice 上,
//  App 侧缺载 —— 经 EventEmitter 显式声明接入, 见 node_modules/electron/electron.d.ts:2216)
;(app as NodeJS.EventEmitter).on('session-end', () => {
  logger.warn('app', 'OS 关机/注销(session-end), 开始优雅退出')
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store.getSettings().closeToTray) {
    app.quit()
  }
})
