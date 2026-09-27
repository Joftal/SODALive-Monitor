import { session } from 'electron'
import { nodeHttpRequest, proxyUrl } from './pandalive'
import { store } from './store'
import { UA, sleep } from '../util'
import { logger } from './logger'

// ============ Telegram Bot 推送 ============
// 纯旁路: sendToast 的第三通道, 失败只落日志(带 TG 前缀), 绝不抛错打扰通知主链。
// 凭据: bot token 存 secrets 保险箱(加密), chatId 随 db.json 设置走。
// 网络: 走独立 persist:tg 会话(不碰全局 API 会话的 cookie/代理), 代理经 tgProxy 设置单独指定;
//       ERR_FAILED 回落 Node 直连(与 API 双栈同语义)。
// 限频: Telegram 全局约 30 msg/s, 单 chat 1msg/s —— 本应用事件密度远低于此, 不做本地排队;
//       429 时读 retry_after 静默丢弃当前条(开播风暴期宁可少发不误序重发)。
// =================================================

const TG_API = 'https://api.telegram.org'
/** TG 专用会话分区: 与全局 API 会话(persist:pl)隔离, 代理互不影响 */
const TG_PARTITION = 'persist:tg'
/** 单次发送总超时护栏: 无代理直连 Telegram 可能黑洞挂死(测试按钮转圈的根因), 15s 必出结果 */
const TG_TIMEOUT_MS = 15_000

/** TG 有效代理: 专用 tgProxy > 全局代理 > 直连 */
function tgProxyRules(): string {
  return (store.getSettings().tgProxy || '').trim() || proxyUrl()
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, sleep(TG_TIMEOUT_MS).then(() => Promise.reject(new Error('timeout')))])
}

function httpsError(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as { description?: string }
    if (j.description) return j.description
  } catch {
    /* 非 JSON 错误体 */
  }
  return `HTTP ${status}`
}

export async function tgSendMessage(token: string, chatId: string, text: string): Promise<{ ok: boolean; message: string }> {
  const t = (token || '').trim()
  const c = (chatId || '').trim()
  if (!t || !c) return { ok: false, message: 'token/chatId not set' }
  try {
    return await withTimeout(tgSend(t, c, text))
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return { ok: false, message: msg === 'timeout' ? `timeout (${TG_TIMEOUT_MS / 1000}s)` : msg }
  }
}

async function tgSend(t: string, c: string, text: string): Promise<{ ok: boolean; message: string }> {
  const url = `${TG_API}/bot${t}/sendMessage`
  const body = new URLSearchParams({ chat_id: c, text, disable_web_page_preview: 'true' }).toString()
  const headers = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
  const proxy = tgProxyRules()
  const ses = session.fromPartition(TG_PARTITION)
  await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  let status: number
  let resText: string
  try {
    const sesFetch = (ses as unknown as { fetch?: typeof globalThis.fetch }).fetch
    const res = sesFetch
      ? await sesFetch.call(ses, url, { method: 'POST', headers, body })
      : await fetch(url, { method: 'POST', headers, body })
    status = res.status
    resText = await res.text()
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('ERR_FAILED'))) throw e
    // Node 兜底走同一条 TG 代理链路
    const r = await nodeHttpRequest('POST', url, headers, body, proxy)
    status = r.status
    resText = r.text
  }
  if (status !== 200) {
    return { ok: false, message: httpsError(resText, status) }
  }
  try {
    const j = JSON.parse(resText) as { ok?: boolean; description?: string }
    if (j.ok) return { ok: true, message: 'ok' }
    return { ok: false, message: j.description || 'telegram ok=false' }
  } catch {
    return { ok: false, message: `bad response (${resText.slice(0, 120)})` }
  }
}
