import { session } from 'electron'
import { api, nodeHttpRequest, proxyUrl } from './pandalive'
import { store } from './store'
import { UA, sleep } from '../util'
import { logger } from './logger'
import { Toast } from '../../shared/types'
import { buildTgPayload, TgCtx, TgEvent } from './tgFormat'
import { mt } from '../i18n'

// ============ Telegram Bot 推送 ============
// 纯旁路: sendToast 的第三通道, 失败只落日志(带 TG 前缀), 绝不抛错打扰通知主链。
// 凭据: bot token 存 secrets 保险箱(加密), chatId 随 db.json 设置走。
// 网络: 走独立 persist:tg 会话(不碰全局 API 会话的 cookie/代理), 代理经 tgProxy 设置单独指定;
//       ERR_FAILED 回落 Node 直连(与 API 双栈同语义)。
// 限频: Telegram 全局约 30 msg/s, 单 chat 1msg/s —— 本应用事件密度远低于此, 不做本地排队;
//       429 时读 retry_after 静默丢弃当前条(开播风暴期宁可少发不误序重发)。
// 格式: 结构化纯文本卡片(tgFormat 产 HTML: 头部加粗 + 房间/直播源链接), 不发图片;
//       HTML 被拒(转义边角)自动去标签纯文本重发一次, 保证通知必达。
// =================================================

const TG_API = 'https://api.telegram.org'
/** TG 专用会话分区: 与全局 API 会话(persist:pl)隔离, 代理互不影响 */
const TG_PARTITION = 'persist:tg'
/** 单次发送总超时护栏: 无代理直连 Telegram 可能黑洞挂死(测试按钮转圈的根因), 15s 必出结果 */
const TG_TIMEOUT_MS = 15_000
/** 卡片长度上限: sendMessage 官方 4096, 留裕量截断 */
const TEXT_MAX = 4000

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

/** TG 会话统一出口: ses.fetch 主通道, ERR_FAILED 回落 Node+代理隧道 */
async function tgRequest(path: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const url = `${TG_API}/bot${path}`
  const proxy = tgProxyRules()
  const ses = session.fromPartition(TG_PARTITION)
  await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  let status: number
  let resText: string
  try {
    const sesFetch = (ses as unknown as { fetch?: (u: string, i: { method: string; headers: Record<string, string>; body: string }) => Promise<Response> }).fetch
    const init = { method: 'POST', headers, body }
    const res = sesFetch ? await sesFetch.call(ses, url, init) : await (fetch as (u: string, i: unknown) => Promise<Response>)(url, init)
    status = res.status
    resText = await res.text()
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('ERR_FAILED'))) throw e
    // Node 兜底走同一条 TG 代理链路
    const r = await nodeHttpRequest('POST', url, headers, body, proxy)
    status = r.status
    resText = r.text
  }
  return { status, text: resText }
}

function parseOk(resText: string): { ok: boolean; message: string } {
  try {
    const j = JSON.parse(resText) as { ok?: boolean; description?: string }
    if (j.ok) return { ok: true, message: 'ok' }
    return { ok: false, message: j.description || 'telegram ok=false' }
  } catch {
    return { ok: false, message: `bad response (${resText.slice(0, 120)})` }
  }
}

/** 表单编码发送(sendMessage): 值含任意文本, URLSearchParams 天然完成编码 */
function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

/** 去 HTML 标签与实体, 供 HTML 消息被 TG 拒绝时兜底纯文本 */
function stripHtml(s: string): string {
  return s
    .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '$2 $1')
    .replace(/<\/?(b|i|u|s|code|pre|span|tg-emoji)[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/** UTF-16 单元数截断(TG 长度限制按 UTF-16 code unit 计), 避免截断代理对 */
function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end-- // 高代理对尾部, 退一格
  return s.slice(0, end)
}

async function tgSend(t: string, c: string, text: string, parseMode = ''): Promise<{ ok: boolean; message: string }> {
  const body = formBody({ chat_id: c, text, disable_web_page_preview: 'true', ...(parseMode ? { parse_mode: parseMode } : {}) })
  const headers = { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }
  const r = await tgRequest(`${t}/sendMessage`, headers, body)
  if (r.status !== 200) return { ok: false, message: httpsError(r.text, r.status) }
  return parseOk(r.text)
}

export async function tgSendMessage(token: string, chatId: string, text: string): Promise<{ ok: boolean; message: string }> {
  const t = (token || '').trim()
  const c = (chatId || '').trim()
  if (!t || !c) return { ok: false, message: 'token/chatId not set' }
  try {
    return await withTimeout(tgSend(t, c, text)) // 测试按钮通道: 纯文本无 parse_mode
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return { ok: false, message: msg === 'timeout' ? `timeout (${TG_TIMEOUT_MS / 1000}s)` : msg }
  }
}

/** 结构化推送入口: 组卡 → sendMessage(HTML); 开播卡顺源缓存附直链; 全程只回状态不抛错 */
export async function tgPush(token: string, chatId: string, ev: TgEvent, toast: Toast, ctx: TgCtx): Promise<{ ok: boolean; message: string }> {
  const t = (token || '').trim()
  const c = (chatId || '').trim()
  if (!t || !c) return { ok: false, message: 'token/chatId not set' }
  // 开播/粉丝房卡附「直播源」: 用长效变体地址(与程序内播放/录制同一条, variants[0] 最高档);
  // master 令牌一回取即焚, 发出去必 403 —— 只在无变体时回退。getPlayCached 与预取泵/录制
  // 共享在途去重, 零增量请求(watcher 先 invalidatePlay 再弹卡, 命中必为新一场源)
  const full: TgCtx = { ...ctx }
  if ((ev === 'live' || ev === 'fanLive' || ev === 'roomChange') && !full.streamUrl && ctx.anchor) {
    await api
      .getPlayCached(ctx.anchor.userId)
      .then((p) => (full.streamUrl = p.ok ? p.variants?.[0]?.url || p.m3u8 || '' : ''))
      .catch(() => undefined)
  }
  const { text } = buildTgPayload(ev, toast, full)
  const card = cutUnits(text, TEXT_MAX)
  try {
    const r = await withTimeout(tgSend(t, c, card, 'HTML'))
    if (r.ok) return r
    // HTML 被拒兜底: 去标签纯文本重发一次
    const plain = cutUnits(stripHtml(text), TEXT_MAX)
    const r2 = await withTimeout(tgSend(t, c, plain))
    if (!r2.ok) logger.warn('tg', `${mt('tg.fail')}: ${r.message} | ${r2.message}`)
    return r2
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return { ok: false, message: msg === 'timeout' ? `timeout (${TG_TIMEOUT_MS / 1000}s)` : msg }
  }
}
