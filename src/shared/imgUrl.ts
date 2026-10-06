// ============ 卡片图的「走主进程」地址 ============
// 现场读数(2026-10-03 请求普查 + 2026-10-04 本机复测, 两条独立样本同结论):
//   · liveimg.sooplive.com 的卡片图 **一个缓存指示头都没有**(cache-control/etag/last-modified 全 null),
//     同一时刻带 ?随机、带 ?1、不带 query 三次取回的是同一份字节(sha256 6bd7e8650c3f / c57cf1529c6e),
//     而同一路径隔 45 秒再取内容就换了(146f8e1505ff → 8b20579c08f3 → 4dada6831308)
//     ⇒ query 只是平台自己用来打穿缓存的版本号, 内容跟着路径走、随时间换。
//   · stimg.sooplive.com 的头像是 Cache-Control: max-age=60(404 也带这一句), last-modified 是 2024/2026 的老值。
//   · 同窗口 Panda 的 cdn.pandalive.co.kr 是 27 个不同 URL 各 1 发 —— Chromium 那边本来就命中, 不关这一格的事。
// 原始那笔"每切一次工作区全量重打一遍"的读数被自己的真机探针改判了: 普查的计数键是 host+pathname,
//   query 没进键('?') ⇒ 平台每轮换的版本号被合并成"同一条问了两次"; 真机两次切墙读到的是卡片图每轮必问(版本号在换)、
//   头像 Chromium 根本没再问, 主进程这本账全程 hit=0 / merged=0 —— 读数细节在 imgCache.ts 文件头。
//
// 这一格给的是「地址翻译」而不是缓存本体: 缓存住在主进程(imgCache.ts), 这里只负责把
// 可缓存的 https 地址换成 plocal://img/<编码>, 并负责把那个编码解回来 —— 解回来这一趟是安全边界:
// 编码是渲染层递进来的字符串, 主机白名单、https、无账号无端口都在这儿判, 少判一项就是开后门。
// 纯函数、零请求, 与 soopAvatarUrl 同族放共享层(渲染层与主进程共用一把尺, 不许两套口径)。

/** 只有这两个域走本机缓存(实测无缓存头/短缓存头的那两域)。别的域(含 Panda CDN)一律原样返回 */
export const IMG_CACHE_HOSTS: readonly string[] = ['liveimg.sooplive.com', 'stimg.sooplive.com']

const PREFIX = 'plocal://img/'
/** 编码后的地址长度上限: 原 URL 512 字符量级绰绰有余, 再长就是有人在往协议里塞别的东西 */
const MAX_ENCODED = 900

function b64urlEncode(s: string): string {
  // 只用 Web API: 渲染层是 sandbox + nodeIntegration: false(没有 Buffer), 主进程与 preload 也各自
  // 有 polyfill 差异 —— 与 preload/index.ts 的 localFileUrl 同一把尺, 一处实现两边走
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** 这个 https 地址该不该改走主进程缓存 */
export function imgCacheable(u: string): boolean {
  if (!u.startsWith('https://')) return false
  try {
    return IMG_CACHE_HOSTS.includes(new URL(u).hostname)
  } catch {
    return false
  }
}

/** 卡片图统一入口: 可缓存的域翻成 plocal://img/…, 其余(含空串)原样返回。
 *  返回原样不等于"没缓存这回事" —— 而是"这一域的缓存不归我们管", 渲染层的 onerror 兜底照旧。 */
export function imgSrc(u: string): string {
  if (!imgCacheable(u)) return u
  try {
    return PREFIX + b64urlEncode(new URL(u).toString())
  } catch {
    return u
  }
}

/** plocal://img/<编码> → 真要取的那个 https 地址; 任何一项不合格回空串(调用方 403) */
export function parseImgSrc(raw: string): string {
  if (!raw.startsWith(PREFIX)) return ''
  const code = raw.slice(PREFIX.length)
  if (!code || code.length > MAX_ENCODED) return ''
  let url: URL
  try {
    url = new URL(b64urlDecode(code))
  } catch {
    return ''
  }
  if (url.protocol !== 'https:') return ''
  if (url.username || url.password || url.port) return ''
  if (!IMG_CACHE_HOSTS.includes(url.hostname)) return ''
  if (!url.pathname.startsWith('/') || url.pathname.length > 512) return ''
  return url.toString()
}
