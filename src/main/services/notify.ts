import { BrowserWindow, Notification } from 'electron'
import { EV, Toast } from '../../shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { tgSendMessage } from './telegram'
import { logger } from './logger'
import { mt } from '../i18n'

/** Toast 类型 -> Telegram 事件开关的设置键(fanLive 并入开播, info 归入录制域) */
const TG_GATE: Record<Toast['type'], 'tgLive' | 'tgOffline' | 'tgRecord' | 'tgError'> = {
  live: 'tgLive',
  fanLive: 'tgLive',
  offline: 'tgOffline',
  rec: 'tgRecord',
  info: 'tgRecord',
  error: 'tgError'
}

export function sendToast(t: Toast): void {
  // 1) 渲染层气泡
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send(EV.toast, t)
  const cfg = store.getSettings()
  // 2) 系统通知
  try {
    if (cfg.notifySystem && Notification.isSupported()) {
      const n = new Notification({ title: t.title, body: t.body, silent: !cfg.notifySound })
      n.on('click', () => {
        win?.show()
        win?.focus()
      })
      n.show()
    }
  } catch {
    /* ignore */
  }
  // 3) Telegram 推送(旁路: 任何失败只落日志, 不影响上两路)
  if (cfg.tgChatId && cfg[TG_GATE[t.type]]) {
    const token = secrets.get('tgToken')
    if (token) {
      void tgSendMessage(token, cfg.tgChatId, `🐼 ${t.title}\n${t.body}`).then((r) => {
        if (!r.ok) logger.warn('tg', `${mt('tg.fail')}: ${r.message}`)
      })
    }
  }
}
