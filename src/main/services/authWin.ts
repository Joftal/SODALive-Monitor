import { BrowserWindow, Session, session } from 'electron'
import { api, SESSION_PARTITION } from './pandalive'
import { soopApi, SOOP_SESSION_PARTITION } from './soop'
import { UA } from '../util'
import { CookieJar } from './vault'
import { store } from './store'
import { mt } from '../i18n'
import { Platform } from '../../shared/types'

// ============ 网页登录窗(事件驱动版, 两平台共用一套机制) ============
// 打开官网让用户自行登录(验证码/二次验证都能过)
// 登录成功探测零轮询压力:
//   - 主触发: session cookie 变化事件(防抖 1.2s) + 页面导航完成事件
//   - 兜底: 每 15s 一次慢速校验(防事件丢失)
//   - 校验通过才关窗落地; 验证中不往磁盘写任何东西
// 两平台差异全收在 LoginWindowSpec 里: Panda 要把 cookie 摘进 vault, SOOP 的会话罐本身就是存储
// ==================================================================

interface LoginWindowSpec {
  partition: string
  startUrl: string
  title: string
  /** 站点自己的 cookie 域(Panda .pandalive.co.kr / SOOP .sooplive.com) */
  cookieDomain: string
  /** 落地需要的最低凭证(Panda 缺 sessKey 直接不验; SOOP 匿名也回一堆站点 cookie, 不能拿它们当登录凭证) */
  hasCredential: (jar: CookieJar) => boolean
  /** 一次登录态探测: 返回 login=true 时窗口即刻关闭 */
  probe: (ses: Session) => Promise<{ login: boolean; message: string }>
}

function pandaliveSpec(): LoginWindowSpec {
  return {
    partition: SESSION_PARTITION,
    startUrl: 'https://www.pandalive.co.kr/',
    title: mt('auth.winTitle'),
    cookieDomain: '.pandalive.co.kr',
    hasCredential: (jar) => !!jar['sessKey'],
    probe: async (ses) => {
      const cookies = await ses.cookies.get({ domain: '.pandalive.co.kr' })
      const jar: CookieJar = {}
      for (const c of cookies) jar[c.name] = c.value
      // 试验证: 不落盘、不污染主请求通道的 cookie
      // M4: 校验带 12s 看门狗 —— 服务端挂起不许让 verifying 锁存永久关闭探测;
      //     infoPre 直传消重, importCookies 不再重复发 login_info
      const info = await Promise.race([
        api.checkLoginInfo(jar),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('verify timeout')), 12000))
      ])
      if (!info.isLogin) return { login: false, message: '' }
      await api.importCookies(jar, info)
      return { login: true, message: info.isAdult ? mt('auth.loginOkAdult') : mt('auth.loginOkNoAdult') }
    }
  }
}

function soopSpec(): LoginWindowSpec {
  return {
    partition: SOOP_SESSION_PARTITION,
    // 实测官网首页右上角「登录」才是不二入口: play 子域只是跳板, /station/login 直连导航会被 SPA 当频道名渲染成"频道不存在"页
    startUrl: 'https://www.sooplive.com/',
    title: mt('soop.winTitle'),
    cookieDomain: '.sooplive.com',
    // 匿名访问官网就会落一堆 .sooplive.com 站点 Cookie(实测: AbroadChk/_au/FCCDCF 等), 它们不是登录凭证
    // 所以这里只当"有 Cookie 可比"放行, 真伪一律交给 probe 里的 LOGIN_ID 判据
    hasCredential: (jar) => Object.keys(jar).length > 0,
    probe: async () => {
      // 会话罐刚被官网改写, 10s 的 cookie 短缓存必须绕过, 否则探到的还是登录前的旧罐
      soopApi.invalidateCookieCache()
      const info = await soopApi.verifyLogin(undefined, true)
      if (!info.isLogin) return { login: false, message: '' }
      // 官网只发无期限的会话 Cookie: 不转持久就是"重启即登出"
      await soopApi.persistSessionCookies()
      return { login: true, message: mt('soop.loginOk', { id: info.loginId }) }
    }
  }
}

function specFor(platform: Platform): LoginWindowSpec {
  return platform === 'soop' ? soopSpec() : pandaliveSpec()
}

export function openLoginWindow(parent: BrowserWindow, platform: Platform): Promise<{ ok: boolean; message: string }> {
  const spec = specFor(platform)
  return new Promise((resolve) => {
    const ses = session.fromPartition(spec.partition)
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: platform === 'soop' ? 980 : 560,
      height: platform === 'soop' ? 820 : 860,
      resizable: true,
      minimizable: false,
      maximizable: false,
      title: spec.title,
      autoHideMenuBar: true,
      // 窗口底色随应用主题(页面本体为官网, 内容区颜色由站点决定)
      backgroundColor: store.getSettings().theme === 'dark' ? '#181818' : '#ffffff',
      webPreferences: { session: ses }
    })

    let done = false
    let verifying = false
    let lastProbeSig = ''
    let debounceTimer: NodeJS.Timeout | null = null

    const cleanup = () => {
      clearInterval(slowTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      try {
        ses.cookies.removeAllListeners('changed')
      } catch {
        /* ignore */
      }
    }

    const finish = (ok: boolean, message: string) => {
      if (done) return
      done = true
      cleanup()
      try {
        win.close()
      } catch {
        /* ignore */
      }
      resolve({ ok, message })
    }

    const verifyNow = async () => {
      if (verifying || done) return
      verifying = true
      try {
        const cookies = await ses.cookies.get({ domain: spec.cookieDomain })
        const jar: CookieJar = {}
        for (const c of cookies) jar[c.name] = c.value
        if (!spec.hasCredential(jar)) return
        // 同一份凭证只验一次: 官网常态回吐同值 Set-Cookie, 每次都重验只是白增风控面
        const sig = Object.entries(jar).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(';')
        if (sig === lastProbeSig) return
        lastProbeSig = sig
        const r = await spec.probe(ses)
        if (r.login) finish(true, r.message)
      } catch {
        /* 网络抖动不致命: 让下一个触发重新验(清掉指纹, 否则同值 Cookie 再也不会复检) */
        lastProbeSig = ''
      } finally {
        verifying = false
      }
    }

    const debouncedVerify = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void verifyNow(), 1200)
    }

    // 主触发: cookie 写入/变化(登录成功瞬间必有 Set-Cookie)
    ses.cookies.on('changed', debouncedVerify)
    // 副触发: 登录成功后站点通常发生导航
    win.webContents.on('did-navigate', debouncedVerify)
    win.webContents.on('did-navigate-in-page', debouncedVerify)
    // 兜底: 15s 慢速校验
    const slowTimer = setInterval(() => void verifyNow(), 15000)

    win.on('closed', () => finish(false, mt('auth.cancelled')))
    win.webContents.setUserAgent(UA)
    void win.loadURL(spec.startUrl)
  })
}
