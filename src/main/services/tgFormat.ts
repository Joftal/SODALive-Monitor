import { Toast, Anchor } from '../../shared/types'

// ============ Telegram 消息结构化 ============
// sendToast 的 title/body 面向应用内气泡(信息量小), TG 需要自成一体的可读卡片:
// 头部事件行 + 主播名(带房间链接) + 直播标题 + 标签行(19+/粉丝房/密码房/回放) + 数据行。
// 纯文本卡片(不发图): 头像/封面 CDN 巨图压缩后仍显笨重, 且机器人拉图徒增风控面;
// 开播卡在 ctx.streamUrl(调用方取源缓存)可用时附「直播源」直链。
// ==========================================

/** 事件语义键: 由调用方(唯一知道"发生了什么"的地方)显式声明, 不靠 toast 文案反推 */
export type TgEvent = 'live' | 'fanLive' | 'roomChange' | 'offline' | 'recStart' | 'recDone' | 'recError' | 'circuit' | 'generic'

export interface TgPayload {
  /** 纯文本卡片内容(无需转义通道, 仅 <b> 头部与 <a> 链接) */
  text: string
}

const ROOM = (id: string): string => `https://www.pandalive.co.kr/play/${id}`

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function link(text: string, href: string): string {
  return `<a href="${href}">${esc(text)}</a>`
}

const HEAD: Record<TgEvent, string> = {
  live: '<b>开播</b>',
  fanLive: '<b>粉丝房开播</b>',
  roomChange: '<b>房态变更</b>',
  offline: '<b>下播</b>',
  recStart: '<b>开始录制</b>',
  recDone: '<b>录制完成</b>',
  recError: '<b>录制异常</b>',
  circuit: '<b>监控熔断</b>',
  generic: '<b>通知</b>'
}

/** 标签行: 只出现成立的那些, 空则不占行 */
function tagLine(a: Anchor): string {
  const t: string[] = []
  if (a.tags?.isAdult) t.push('[19+]')
  if (a.tags?.type === 'fan') t.push('[粉丝房]')
  if (a.tags?.isPw) t.push('[密码房]')
  if (a.tags?.liveType === 'rec') t.push('[回放]')
  return t.join(' ')
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分钟`
}

function fmtMb(bytes: number): string {
  const mb = bytes / 1024 ** 2
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(1)}MB`
}

export interface TgCtx {
  anchor?: Anchor | null
  /** 开播/在场时长(秒), 用于开播与下播卡 */
  liveSec?: number
  /** 录制产物统计 */
  recSec?: number
  recMb?: number
  files?: string[]
  /** 错误正文(录制失败原因等) */
  detail?: string
  /** 直播源直链(开播卡: 调用方从源缓存取, 无则不占行) */
  streamUrl?: string
}

export function buildTgPayload(ev: TgEvent, t: Toast, ctx: TgCtx): TgPayload {
  const a = ctx.anchor
  const lines: string[] = [HEAD[ev]]
  // 无主播上下文的系统卡(熔断/启动失败): 头部即行, 正文走末行说明 —— 不重复 toast.title
  if (a) {
    lines.push(link(a.nick || a.userId, ROOM(a.userId)))
  }
  // 标题行: 标签作前缀(如 "[19+] [粉丝房] 标题"), 无标题有标签时标签独占一行; 录制卡标题走末行说明
  const tags = a ? tagLine(a) : ''
  const title = a?.title && ev !== 'recStart' && ev !== 'recError' ? esc(a.title) : ''
  if (a && (title || tags)) lines.push([tags, title].filter(Boolean).join(' '))
  // 数据行: 能凑出多少凑多少, 全空不占行
  const facts: string[] = []
  if (a && a.viewerCount > 0) facts.push(`观众 ${a.viewerCount}`)
  if ((ev === 'live' || ev === 'roomChange') && ctx.liveSec) facts.push(`已播 ${fmtDur(ctx.liveSec)}`)
  if (ev === 'offline' && ctx.liveSec) facts.push(`本场 ${fmtDur(ctx.liveSec)}`)
  if (a && a.autoRecord && (ev === 'live' || ev === 'fanLive' || ev === 'roomChange')) facts.push('自动录制: 开')
  if (facts.length) lines.push(facts.join('  '))
  if ((ev === 'recDone' || ev === 'recError') && (ctx.recSec || ctx.recMb)) {
    lines.push(`文件 ${fmtMb((ctx.recMb || 0) * 1024 ** 2)} / ${fmtDur(ctx.recSec || 0)}${ctx.files?.length ? ` / ${ctx.files.length} 段` : ''}`)
  }
  if ((ev === 'live' || ev === 'fanLive' || ev === 'roomChange') && ctx.streamUrl) lines.push(link('直播源', ctx.streamUrl))
  // 末行说明: ctx.detail 优先, 退回 toast.body(系统卡正文); 已含则不重复
  const tail = ctx.detail || t.body || ''
  if (tail) lines.push(esc(tail).slice(0, 200))
  return { text: lines.join('\n') }
}
