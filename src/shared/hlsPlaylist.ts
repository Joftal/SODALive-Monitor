// ============ 清单正文的本地化改写 ============
// 现场读数(2026-10-03 请求普查, `vod:true` 那一条): 回放下载把**同一份媒体清单读了两遍** ——
// 先 fetchPlaylistDurationSec 只求 EXTINF 和(正文用完就丢), 再把同一个 URL 交给 ffmpeg 自己读第二遍。
// 两读之间不重叠(串行), 所以 hlsProxy 的在途合流拦不住, 每次回放白多一发 CDN 请求。
//
// 合并这一发的做法只有一个前提要成立: 我们手上那份正文必须能直接喂给 ffmpeg。
// 而远端清单里的段地址是**相对** URL, 基准是那条 https 地址; 一旦正文落成本地文件,
// 基准就变成录制目录 —— 不改写就是去磁盘上找一个叫 seg-0.ts 的文件, ffmpeg 立刻 "not found"。
// 这里只干这一件事: 把相对 URI 按原基准绝对化。纯文本、零请求, 与 soopAvatarUrl/imgSrc 同族放共享层
// (主进程与验证脚本共用一把尺, 不许两套口径)。

/** 带 URI 属性的清单行: 键(AES-128)/fMP4 初始化段(EXT-X-MAP)/rendition 都从这里走。
 *  不做标签白名单 —— 漏认一个新标签的后果是那条 URI 悄悄留在原地(相对), 下载半路才炸;
 *  「凡是 URI=" 都绝对化」没有这种死角。 */
const URI_ATTR_RE = /\bURI="([^"]*)"/g

/** 把远端媒体清单正文改写成可直接落盘的本地清单; 任一条 URI 解析不出 → 整体回 null
 *
 *  为什么整体作废而不是丢掉那一条: 半绝对化的清单会**静默丢段** —— 用户拿到一部短了几分钟的片子,
 *  而录制进度、日志、产物对账一路全绿。交棒失败的退路是"照旧把真 URL 交给 ffmpeg"(顶多多发那一发),
 *  不能拿产物换。 */
export function localizeVodPlaylist(text: string, baseUrl: string): string | null {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null // 连基准都不是地址: 这份正文没资格落盘
  }
  if (/URI='/.test(text)) return null // 单引号写法的 URI 不在处理范围: 宁可退回真 URL, 不猜
  const abs = (u: string): string | null => {
    try {
      // 已绝对的地址原样回来(new URL 的既有语义), 相对段则按清单自己的基准解析
      return new URL(u, base).href
    } catch {
      return null
    }
  }
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue // 空行在 HLS 里本就是分隔符, 不承载信息
    if (line.startsWith('#')) {
      if (!line.includes('URI="')) {
        out.push(line)
        continue
      }
      let bad = false
      const mapped = line.replace(URI_ATTR_RE, (m0: string, u: string) => {
        const a = abs(u)
        if (a === null) {
          bad = true
          return m0
        }
        return `URI="${a}"`
      })
      if (bad) return null
      out.push(mapped)
      continue
    }
    // 既非注释也非空行 = 段 URI 行
    const a = abs(line)
    if (a === null) return null
    out.push(a)
  }
  return out.join('\n') + '\n'
}
