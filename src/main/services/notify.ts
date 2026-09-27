import { BrowserWindow, Notification } from 'electron'
import { EV, Toast } from '../../shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { tgPush } from './telegram'
import { TgCtx, TgEvent } from './tgFormat'
import { logger } from './logger'
import { mt } from '../i18n'

/** Toast 类型 -> Telegram 事件开关的设置键(fanLive 并入开播, info 归入录制域) */
const TG_GATE: Record<Toast['type'], 'tgLive' | 'tgOffline' | 'tgRecord' | 'tgError'> = {
  live: 'tgLive',
  fanLive: 'tgLive',
  roomChange: 'tgLive',
  offline: 'tgOffline',
  rec: 'tgRecord',
  info: 'tgRecord',
  error: 'tgError'
}

/** toast.type -> TG 卡片头兜底映射(调用方传显式 ev 优先: 同为 'error' 的熔断/录错语义不同) */
const TG_EV_BY_TYPE: Record<Toast['type'], TgEvent> = {
  live: 'live',
  fanLive: 'fanLive',
  roomChange: 'roomChange',
  offline: 'offline',
  rec: 'recDone',
  info: 'generic',
  error: 'recError'
}

/** 可选第三参: 该事件的 TG 语义卡(显式事件名 + 主播/统计上下文) */
export function sendToast(t: Toast, tg?: { ev: TgEvent; ctx: TgCtx }): void {
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
      void tgPush(token, cfg.tgChatId, tg?.ev ?? TG_EV_BY_TYPE[t.type], t, tg?.ctx ?? {}).then((r) => {
        if (!r.ok) logger.warn('tg', `${mt('tg.fail')}: ${r.message}`)
      })
    }
  }
}
