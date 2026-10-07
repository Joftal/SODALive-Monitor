// ============ 应用元信息(关于页 / 检查更新共用) ============
export const APP_META = {
  name: 'SODALive Monitor',
  author: 'Joftal',
  /** 作者主页(GitHub 头像 = 该地址 + '.png', 关于页两处都从这里取, 不再各写一遍) */
  authorUrl: 'https://github.com/Joftal',
  repo: 'https://github.com/Joftal/SODALive-Monitor',
  releasesPage: 'https://github.com/Joftal/SODALive-Monitor/releases'
} as const

/** 语义化版本比较: a>b → 1; a<b → -1; 相等 → 0(缺位补 0, 忽略前导 v/预发布尾) */
export function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}
