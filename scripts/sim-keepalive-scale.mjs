// ============================================================================
// 规模仿真: 源保活泵在 N 个直播间下的真实运行数据(真实源码 + 可控延迟假 CDN)
//
// 量测指标: 每轮耗时 / 有效心跳间隔(每源) / 请求速率 / 日流量估算
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const VARIANTS = 5 // IVS 典型档数
const MASTER_TEXT =
  '#EXTM3U\n' +
  ['1080', '720', '480', '360', '160'].map((r) => `#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv${r}.m3u8`).join('\n') +
  '\n'

let latencyMs = 0 // 假 CDN 单请求延迟(播种快, 量测真)
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url)
  if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs))
  if (u.hostname === 'api.pandalive.co.kr' && u.pathname === '/v1/live/play') {
    const userId = new URLSearchParams(init.body || '').get('userId')
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          result: true,
          PlayList: { hls: [{ url: `https://x.live-video.net/${userId}/master.m3u8` }] },
          media: { title: 't', userNick: 'n', liveType: 'live', thumbUrl: '', userImg: '' }
        }),
      headers: { getSetCookie: () => [] }
    }
  }
  if (u.pathname.endsWith('/master.m3u8')) return { status: 200, text: async () => MASTER_TEXT, headers: { getSetCookie: () => [] } }
  return { status: 200, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\ns1.ts\n', headers: { getSetCookie: () => [] } }
}

// prefetchStream 已进 monitor: 顶层那一格现在是未注册键, 引擎读不到 ⇒ 重铸路径会被静默跳过(假快)
const db = { anchors: [], settings: { keepaliveStream: true, monitor: { pandalive: { pollIntervalSec: 30, requestGapMs: 300, prefetchStream: true }, soop: { pollIntervalSec: 30, requestGapMs: 300, prefetchStream: true } } } }
const store = {
  listAnchors: () => db.anchors,
  getSettings: () => db.settings,
  flush() {},
  listHistory: () => [],
  updateAnchor() {}, addAnchor() {}, removeAnchor() {}, setSettings(p) { db.settings = { ...db.settings, ...p } }, addHistory() {}
}
const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: () => ({ fetch: fakeFetch, setProxy: async () => {}, setUserAgent() {} }) },
    net: { fetch: fakeFetch }
  },
  '../util': { UA: 'sim', sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  './vault': { vault: { encrypted: false, load: () => null, save() {}, clear() {} } },
  './logger': { logger: { info() {}, warn() {} } },
  '../i18n': { mt: (k) => k, setMainLocale() {} },
  './store': { store }
}
const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const localRequire = (id) => {
    if (id in mocks) return mocks[id]
    if (id === './pandalive') return loadTs('src/main/services/pandalive.ts')
    if (id === './netGate') return loadTs('src/main/services/netGate.ts') // 车道挂真实现
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}
const { api } = loadTs('src/main/services/pandalive.ts')

console.log('保活泵规模仿真 (心跳周期间隔常量 60s, CDN 单请求延迟 80ms)\n')
console.log('  N(房间) | 每轮耗时 | 有效心跳间隔/源 | 请求速率 | 日流量估算')
console.log('---------|---------|----------------|---------|----------')

for (const N of [10, 25, 50, 100, 200]) {
  api.clearPlayCache()
  db.anchors.length = 0
  latencyMs = 0 // 播种零延迟
  for (let i = 0; i < N; i++) {
    db.anchors.push({ platform: 'pandalive', userId: `u${i}`, isLive: true })
    await api.getPlayCached(`u${i}`)
  }
  latencyMs = 80 // 量测真延迟
  const t0 = Date.now()
  await api.keepaliveTick()
  const ms = Date.now() - t0
  const beats = N * 1 // 扇出收口: 每源一轮只读主档一发(旧写法 N × VARIANTS, 副档不靠心跳续命)
  const adaptiveWait = Math.min(900_000, Math.max(300_000, N * 2000)) // 与 startKeepalive 自适应一致(基准 60s→5min, 0.4s/源→2s/源, 封顶 120s→900s)
  const effMs = Math.max(ms, adaptiveWait)
  const mbPerBeatKb = beats * 2.5 // 2.5KB/清单
  const mbPerDay = ((mbPerBeatKb * 24 * 3600 * 1000) / effMs / 1024).toFixed(0)
  console.log(
    `  ${String(N).padStart(7)} | ${(ms / 1000).toFixed(1).padStart(7)}s | ${(effMs / 1000).toFixed(1).padStart(14)}s | ${(beats / (ms / 1000)).toFixed(1).padStart(7)}/s | ${mbPerDay} MB`
  )
}
console.log('\n注: 有效心跳间隔 = max(每轮实际耗时, 自适应间隔 min(900s, max(300s, N×2s))) — 4 泳道并发 + 规模自适应')
