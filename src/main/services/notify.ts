import { BrowserWindow, Notification } from 'electron'
import { EV, NotifyEvent, platformName, Toast } from '../../shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { tgPush } from './telegram'
import { TgCtx, TgEvent } from './tgFormat'
import { logger } from './logger'
import { mt } from '../i18n'

/** toast.type -> 通知矩阵的行(D4): 列轴取自 toast.platform */
const EVENT_BY_TYPE: Record<Toast['type'], NotifyEvent> = {
  live: 'live',
  fanLive: 'live',
  roomChange: 'live',
  offline: 'offline',
  rec: 'record',
  info: 'record',
  error: 'alert',
  session: 'alert'
}

/** TG 语义卡 -> 行: 同为 type='error' 的「录制出错」属录制域、「熔断」属异常域, 靠类型推不出来 */
const EVENT_BY_TG: Record<TgEvent, NotifyEvent> = {
  live: 'live',
  fanLive: 'live',
  roomChange: 'live',
  offline: 'offline',
  recStart: 'record',
  recDone: 'record',
  recError: 'record',
  circuit: 'alert',
  generic: 'alert'
}

/** toast.type -> TG 卡片头兜底映射(调用方传显式 ev 优先: 同为 'error' 的熔断/录错语义不同) */
const TG_EV_BY_TYPE: Record<Toast['type'], TgEvent> = {
  live: 'live',
  fanLive: 'fanLive',
  roomChange: 'roomChange',
  offline: 'offline',
  rec: 'recDone',
  info: 'generic',
  error: 'recError',
  session: 'generic'
}

/** 可选第二参: 该事件的 TG 语义卡(显式事件名 + 主播/统计上下文)
 *  它同时决定归到哪一行 —— ev='recError' 的报错走录制开关, 不走异常开关 */
export function sendToast(t: Toast, tg?: { ev: TgEvent; ctx: TgCtx }): void {
  // 平台前缀: 两平台可能同名主播/同 ID 房间, 气泡与系统通知必须一眼分清归属(与 TG 卡片头同一诉求)。
  // 标题自带平台词的(SOOP 监控已失效)不再重复挂前缀。
  const pname = platformName(t.platform)
  const labeled: Toast = t.title.startsWith(pname) ? t : { ...t, title: `${pname} · ${t.title}` }
  // 1) 渲染层气泡: 应用内的即时反馈, 不受通知矩阵管制(关掉系统通知不该把眼前的气泡一起吞掉)
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send(EV.toast, labeled)
  const cfg = store.getSettings()
  const ev = tg ? EVENT_BY_TG[tg.ev] : EVENT_BY_TYPE[t.type]
  const row = cfg.notify[t.platform][ev]
  // 2) 系统通知(提示音只在开播行存在: S6 判据 —— 其余行给了开关也没人听)
  try {
    if (row.system && Notification.isSupported()) {
      const n = new Notification({ title: labeled.title, body: labeled.body, silent: !('sound' in row && row.sound) })
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
  if (cfg.tgChatId && row.telegram) {
    const token = secrets.get('tgToken')
    if (token) {
      void tgPush(token, cfg.tgChatId, tg?.ev ?? TG_EV_BY_TYPE[t.type], t, tg?.ctx ?? {}).then((r) => {
        if (!r.ok) logger.warn('tg', `${mt('tg.fail')}: ${r.message}`)
      })
    }
  }
}
