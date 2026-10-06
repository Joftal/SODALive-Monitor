import { protocol, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { store } from './store'
import { SESSION_PARTITION } from './pandalive'
import { defaultRecordRoot } from '../util'
import { logger } from './logger'
import { thumbsRoot } from './thumbs'
import { imgCache } from './imgCache'

// ============ 本地媒体协议(plocal://) ============
// 供渲染层 <video> 应用内回看本地录制产物:
//   - dev(http://localhost) 下 file:// 加载受限, 统一走自定义协议
//   - URL: plocal://file/<base64url(绝对路径)>
//   - 白名单: 仅 .mp4, 且必须位于当前录制根 / 默认录制根 / 历史任务目录之下
//   - Range 手动实现: net.fetch(file://) 对 Range 的透传在不同版本不稳定,
//     直接 fs 切片回 206, 保证大文件拖动进度条可用
// 另一支 plocal://img/<base64url(https 地址)> 不走上面这套: 它的载荷不是本机路径,
// 而是一条要被主进程取回并本机缓存的卡片图地址, 边界由 parseImgSrc 那把尺管(见 imgCache.ts)。
// ==============================================

const SCHEME = 'plocal'

/** 必须在 app ready 前调用: 声明流媒体特权。
 *  corsEnabled: false 关键 —— 应用内协议, 否则从 http://localhost / file:// 源 fetch/<video>
 *  会被 CORS 整体拦截(表现为 Failed to fetch / MEDIA_ERR_SRC_NOT_SUPPORTED) */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: false } }
  ])
}

/** 统一响应头(双保险: 即便将来 corsEnabled 语义变动也稳) */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' }

function withCors(res: Response): Response {
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

/** 允许访问的根: 当前录制根 ∪ 默认录制根 ∪ 历史出现过的任务目录(兼容换过保存路径)
 *  拖动进度条会产生连续 Range 请求, 根列表短缓存 3s 避免每请求全量重建 */
let rootsCache: { at: number; roots: string[] } | null = null
function allowedRoots(): string[] {
  if (rootsCache && Date.now() - rootsCache.at < 3000) return rootsCache.roots
  const roots = new Set<string>()
  const cfg = store.getSettings()
  roots.add(path.resolve(cfg.savePath || defaultRecordRoot()))
  roots.add(path.resolve(defaultRecordRoot()))
  for (const h of store.listHistory()) {
    if (h.dirPath) roots.add(path.resolve(h.dirPath))
  }
  rootsCache = { at: Date.now(), roots: [...roots] }
  return rootsCache.roots
}

/** 白名单内判定: mp4 走录制根; jpg 仅限九宫格缩略图目录 */
function isAllowed(abs: string): boolean {
  if (!path.isAbsolute(abs)) return false
  const resolved = path.resolve(abs)
  const lower = resolved.toLowerCase()
  const inside = (root: string): boolean => {
    const rel = path.relative(root, resolved)
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    if (inside(thumbsRoot())) return true
  }
  if (!lower.endsWith('.mp4')) return false
  return allowedRoots().some(inside)
}

function mimeOf(abs: string): string {
  const lower = abs.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'video/mp4'
}

function streamResponse(stream: Readable, init: { status: number; headers: Record<string, string> }): Response {
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: init.status,
    headers: init.headers
  })
}

/** 手动 Range: bytes=start-end / bytes=start- / bytes=-suffix; 非法区间 416 */
function fileResponse(abs: string, rangeHeader: string | null): Response {
  const size = fs.statSync(abs).size
  const baseHeaders = {
    'Content-Type': mimeOf(abs),
    'Accept-Ranges': 'bytes'
  }
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (m && (m[1] || m[2])) {
      let start = m[1] === '' ? NaN : parseInt(m[1], 10)
      let end = m[2] === '' ? NaN : parseInt(m[2], 10)
      if (Number.isNaN(start)) {
        // 后缀区间: 最后 end 个字节
        if (end <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        start = Math.max(0, size - end)
        end = size - 1
      } else if (Number.isNaN(end) || end >= size) {
        end = size - 1
      }
      if (start <= end && start < size) {
        return streamResponse(fs.createReadStream(abs, { start, end }), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1)
          }
        })
      }
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
  }
  return streamResponse(fs.createReadStream(abs), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) }
  })
}

/** app ready 后调用: 安装协议处理器。
 *  关键: 必须挂在应用实际使用的持久化 partition 会话上 —— 顶层 protocol.handle
 *  只作用于 default session, 而主窗口用的是 persist:pl, 挂错会话=请求根本到不了处理器 */
export function installMediaHandler(): void {
  const ses = session.fromPartition(SESSION_PARTITION)
  ses.protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      // 卡片图那一支: 载荷是一条要被主进程取回并本机缓存的 https 地址(白名单在 parseImgSrc 里)
      if (u.host === 'img') return await imgCache.handle(req.url)
      const b64 = u.pathname.replace(/^\//, '')
      const abs = Buffer.from(b64, 'base64url').toString('utf-8')
      if (!isAllowed(abs)) {
        logger.warn('media', `拒绝访问(白名单外或非 mp4): ${abs.slice(0, 200)}`)
        return withCors(new Response('forbidden', { status: 403 }))
      }
      if (!fs.existsSync(abs)) return withCors(new Response('not found', { status: 404 }))
      return withCors(fileResponse(abs, req.headers.get('range')))
    } catch (e) {
      return withCors(new Response(String((e as Error).message || e), { status: 500 }))
    }
  })
}
