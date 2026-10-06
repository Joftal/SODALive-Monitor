// ============================================================================
// 验证脚本: 回放下载的那份媒体清单 —— pandalive.fetchVodPlaylist 与它的两个消费端
//
// 背景: vodTotalSec 是回放进度条唯一的分母(recorder.ts 拉源后写入 → 渲染层 vodPct 换算)。
//       它算错 = 进度条说谎; 它算不出(0)时若被当成"0%", 比不画进度条更骗人。
//       本脚本此前不存在, 因为 verify-p1.mjs 把整个 ./pandalive 替成了
//       { api: { fetchPlaylistDurationSec: async () => 0 } } —— 替身绿, 真函数从未被跑过。
// 换名的原因: 旧函数只求和就把正文丢掉, recorder 转头又把同一个 URL 交给 ffmpeg 读第二遍
//       (串行双读, 两发之间不重叠 ⇒ hlsProxy 的在途合流拦不住, 而且 Panda 回放根本不走本地代理)
//       —— 每次回放白多一发 CDN 请求。新函数一次读取给出 { sec, text }: 分母与交棒正文同批字节。
// 方法: sucrase 现编译 src/main/services/pandalive.ts(真实源码, 含真实 EXTINF 解析)
//       + src/shared/hlsPlaylist.ts(交棒正文的绝对化, 同样挂真实现),
//       electron 的 session.fetch 换成可注入文本的替身; 主机名一律 .invalid,
//       未分派的 URL 直接抛 → 任何漏网请求不可能悄悄打到真网络。
// 场景:
//   V1 真实媒体清单求和: 小数段 + 尾逗号 + 干扰行(MAP/PROGRAM-DATE-TIME/TARGETDURATION)不计入
//   V2 行尾 CRLF 与前后空白: 同一份清单跨平台换行不改分和
//   V3 只给 variant 行的 master 清单 → null(分母算不出, 交棒也没意义)
//   V4 脏 EXTINF 行只丢那一行: 缺数字 / 字母 / 负数(preload 段写法) 一律不进和
//   V5 非清单应答(风控 HTML / 空串)→ null(不能当清单交棒, 也不能当"0 秒的片子")
//   V6 HTTP 403 → null, 且全程只发一次请求(状态码错误绝不走 Node 通道重发)
//   V7 长清单的浮点累加误差落进整秒不被读出(进度百分比的分母容差)
//   V8 接线: 那一次读取的两个消费端都真接上了, 交棒失败退回的正是改动前的行为
//   V9 交棒正文的绝对化: 相对段/密钥/MAP 三类 URI 按清单原基准改写, 已绝对的不动
//   V10 交棒正文的作废条件: 单引号写法 / 基准不是地址 / 任一条 URI 解析不出 → 整份回 null
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 替身网络: 只认 .invalid, 其余一律抛(绝不真发) ----------
const world = { body: '', status: 200, calls: [] }
const fakeRes = (status, text) => ({
  status,
  text: async () => text,
  headers: { getSetCookie: () => [] }
})
const fakeFetch = async (url) => {
  const u = new URL(url)
  if (!u.hostname.endsWith('.invalid')) throw new Error('fakeFetch 未分派(不允许真网络): ' + url)
  world.calls.push(url)
  return fakeRes(world.status, world.body)
}

const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: { fromPartition: () => ({ fetch: fakeFetch, setProxy: async () => {}, setUserAgent() {} }) },
    net: { fetch: fakeFetch }
  },
  '../util': { UA: 'verify-script', sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  './vault': { vault: { encrypted: false, load: () => null, save() {}, clear() {} } },
  './logger': { logger: { info() {}, warn() {} } },
  '../i18n': { mt: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), setMainLocale() {} },
  './store': { store: { getSettings: () => ({ proxyUrl: '' }), listAnchors: () => [] } }
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
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    if (id === '../../shared/hlsPlaylist') return loadTs('src/shared/hlsPlaylist.ts')
    if (id === './netGate') return loadTs('src/main/services/netGate.ts') // 车道挂真实现
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const { api } = loadTs('src/main/services/pandalive.ts')
const { localizeVodPlaylist } = loadTs('src/shared/hlsPlaylist.ts')
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const ask = async (body, status = 200) => {
  world.body = body
  world.status = status
  const before = world.calls.length
  const v = await api.fetchVodPlaylist('https://vod-cdn.invalid/master.m3u8')
  return { v, sent: world.calls.length - before }
}

// ============================================================================
console.log('\n■ V1 真实媒体清单: 小数段求和, 干扰行不进和, 正文一字不动交下去')
{
  const B = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:9.676,',
    'seg-0.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"',
    '#EXTINF:9.676,',
    'seg-1.ts',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-29T12:00:00.000Z',
    '#EXTINF:8.141,',
    'seg-2.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')
  const r = await ask(B)
  check('V1-1 三段小数按 27.493 求和', Math.abs(r.v.sec - 27.493) < 1e-9, JSON.stringify(r.v))
  check('V1-2 真的走了一次 fetchText(替身被调用)', r.sent === 1, `发请求 ${r.sent} 次`)
  check('V1-3 交棒正文与求和正文是同一批字节(交棒不是"再读一遍")', r.v.text === B)
}

console.log('\n■ V2 CRLF 与前后空白不改分和(Windows 抓下来的清单与 Linux 同一结果)')
{
  const unix = '#EXTM3U\n#EXTINF:6.0,\na.ts\n#EXTINF:4.5,\nb.ts\n#EXT-X-ENDLIST\n'
  const crlf = unix.replace(/\n/g, '\r\n')
  const padded = '#EXTM3U\n   #EXTINF:6.0,\r\na.ts\n#EXTINF:4.5,\nb.ts\n#EXT-X-ENDLIST\n'
  const a = await ask(unix)
  const b = await ask(crlf)
  const c = await ask(padded)
  check('V2-1 LF 求和 10.5', Math.abs(a.v.sec - 10.5) < 1e-9, String(a.v.sec))
  check('V2-2 CRLF 与 LF 同分', b.v.sec === a.v.sec, String(b.v.sec))
  check('V2-3 行首缩进行尾空白照计', Math.abs(c.v.sec - 10.5) < 1e-9, String(c.v.sec))
}

console.log('\n■ V3 master 清单(只有 variant 行) → null: 分母算不出, 交棒也没意义')
{
  const r = await ask('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080p.m3u8\n')
  check('V3-1 master 返回 null(既不是"0 秒的片子", 也不能把 master 当媒体清单交棒)', r.v === null, JSON.stringify(r.v))
}

console.log('\n■ V4 脏 EXTINF 行只丢那一行, 绝不把 NaN/负数带进和')
{
  const r = await ask(
    [
      '#EXTM3U',
      '#EXTINF:,x.ts', // 空时长
      '#EXTINF:abc,', // 非数字
      '#EXTINF:-0.001,', // 预载段的负时长写法
      '#EXTINF:1.2.3,', // 双小数点: 正则的 [\d.]+ 会收下, Number() 得 NaN(护栏就为这条)
      '#EXTINF:',
      'good.ts',
      '#EXTINF:12.0,',
      'good2.ts'
    ].join('\n')
  )
  check('V4-1 五条脏行全弃, 只计 12', r.v.sec === 12, String(r.v.sec))
  check('V4-2 结果不是 NaN(NaN 会击穿整条进度估算)', !Number.isNaN(r.v.sec), String(r.v.sec))
  check('V4-3 脏行原样交下去(改的是地址基准, 不是媒体语义: 交给 ffmpeg 的仍是这一份)', r.v.text.includes('#EXTINF:1.2.3,'))
}

console.log('\n■ V5 非清单应答(风控 HTML / 空串)→ null')
{
  const html = await ask('<!DOCTYPE html><html><body>Access Denied</body></html>')
  const empty = await ask('')
  const trap = await ask('<!DOCTYPE html><html><body>Access Denied\n#EXTINF:6.0,\nfake.ts\n</body></html>')
  check('V5-1 HTML 页返回 null(绝不能把风控页当清单交棒给 ffmpeg)', html.v === null, JSON.stringify(html.v))
  check('V5-2 空响应体返回 null', empty.v === null, JSON.stringify(empty.v))
  check('V5-3 带 EXTINF 字样的风控页仍是 null(门在 #EXTM3U 上, 不在"有没有时长行"上)', trap.v === null, JSON.stringify(trap.v))
}

console.log('\n■ V6 HTTP 403 → null, 且状态码错误不触发 Node 通道重发')
{
  const r = await ask('#EXTM3U\n#EXTINF:6.0,\na.ts\n', 403)
  check('V6-1 403 退化为 null(不定进度 + 由 ffmpeg 自己去读)', r.v === null, JSON.stringify(r.v))
  check('V6-2 全程只发 1 次请求(同一请求打两遍会放大风控面)', r.sent === 1, `发请求 ${r.sent} 次`)
}

console.log('\n■ V7 长清单浮点累加: 误差必须落在整秒读数之内')
{
  const segs = Array.from({ length: 3600 }, (_, i) => `#EXTINF:2.997,\ns${i}.ts`).join('\n')
  const r = await ask('#EXTM3U\n' + segs + '\n#EXT-X-ENDLIST\n')
  check('V7-1 3600 段 2.997s ≈ 10789.2s(误差 < 0.01)', Math.abs(r.v.sec - 3600 * 2.997) < 1e-2, String(r.v.sec))
  check('V7-2 换算成分钟不抖(整秒容差内)', Math.round(r.v.sec / 60) === 180, String(Math.round(r.v.sec / 60)))
}

console.log('\n■ V8 接线: 那一次读取的两个消费端都真接上了')
{
  const rec = src('src/main/services/recorder.ts')
  const view = src('src/renderer/src/views/RecordingsView.vue')
  const impl = src('src/main/services/pandalive.ts')
  const shared = src('src/shared/hlsPlaylist.ts')
  const p1 = src('scripts/verify-p1.mjs')
  check('V8-0 被测函数是真实现(源码里确有 EXTINF 求和)', /#EXTINF:\(\[\\d\.\]\+\)/.test(impl))
  check(
    'V8-1 开录走的是新函数, 且旧的双读入口既没被谁再调、也没在 pandalive 里留着定义(注释里的追述不算)',
    /api\.fetchVodPlaylist\(src\)/.test(rec) && !/fetchPlaylistDurationSec/.test(rec + p1) && !/async fetchPlaylistDurationSec/.test(impl)
  )
  check('V8-2 分母取自那一发的 sec(不存在第二次读取)', /this\.vodTotalSec = pl\.sec/.test(rec))
  check('V8-3 同一发的 text 交棒给 ffmpeg, 交棒不成才退回 src', /input = this\.handVodPlaylist\(src, pl\.text\) \|\| src/.test(rec))
  check('V8-4 交棒正文由共享层真实现改写(recorder 里没有第二份绝对化逻辑)', /localizeVodPlaylist\(text, baseUrl\)/.test(rec) && !/new URL\(/.test(rec))
  check('V8-5 交棒清单用完即删: 退出/收尾/spawn 起跑失败三条路都指向 cleanVodPlaylist', (rec.match(/this\.cleanVodPlaylist\(\)/g) || []).length >= 3)
  check('V8-6 vodDoneSec 与 vodTotalSec 同源于 -progress 管道', /out_time_ms/.test(rec) && /vodDoneSec = Number/.test(rec))
  check('V8-7 分母为 0 时 vodPct 返回 null(退回文字呈现)', /if \(!task\.vodTotalSec\) return null/.test(view))
  check('V8-8 段头 caption 不把回放当直播(recorder 两条 spawn 分支的既有事实)', /some\(\(task\) => !task\.vod\)/.test(view))
  check('V8-9 输入换成本地文件后, 上游代理与 file 协议白名单照旧(段仍在 CDN 上取)', /LOOPBACK_RE\.test\(m3u8\)/.test(rec) && /'-http_proxy', cfg\.proxyUrl/.test(rec) && /'file,http,https,tcp,tls,crypto'/.test(rec))
  check('V8-10 共享层只做纯文本改写(不引网络、不引 electron)', !/net\.fetch|session\.|require\(/.test(shared))
  check('V8-11 对账口径看不见 .m3u8(statFiles 与 scanTaskMedia 都只认 .ts|.mp4)', /endsWith\('\.ts'\) \|\| f\.endsWith\('\.mp4'\)/.test(rec) && /\.\(mp4\|ts\)\$\/i/.test(src('src/main/util.ts')))
}

console.log('\n■ V9 交棒正文的绝对化: 三类 URI 按清单原基准改写, 已绝对的不动')
{
  const base = 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc'
  const body = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:9',
    '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:9.0,',
    'seg/a.ts',
    '#EXTINF:9.0,',
    'https://other-cdn.invalid/abs/b.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')
  const out = localizeVodPlaylist(body, base)
  check('V9-1 相对段按清单基准落到同目录(查询串不进段地址, 与 ffmpeg 自己的解析同规)', out.includes('https://vod-cdn.invalid/hls/seg/a.ts'))
  check('V9-2 密钥 URI 绝对化且 IV 字照抄', out.includes('URI="https://vod-cdn.invalid/hls/k.bin",IV=0x1'))
  check('V9-3 fMP4 初始化段(EXT-X-MAP)绝对化: 漏了它是整条片子打不开, 不是"画面糊"', out.includes('URI="https://vod-cdn.invalid/hls/init.mp4"'))
  check('V9-4 已绝对的地址原样保留(不重复编码、不换域)', out.includes('https://other-cdn.invalid/abs/b.ts'))
  check('V9-5 时长行/收尾标签一字不改', out.includes('#EXTINF:9.0,') && out.includes('#EXT-X-ENDLIST'))
  check('V9-6 行尾 CR 不进地址(CRLF 清单绝对化后不留 "a.ts\\r" 这种死地址)', localizeVodPlaylist('#EXTM3U\r\n#EXTINF:9.0,\r\na.ts\r\n', base).includes('https://vod-cdn.invalid/hls/a.ts\n'))
  const leftRel = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).filter((l) => !/^https?:\/\//.test(l.trim()))
  check('V9-7 兜底尺: 交棒正文里没有任何一条段行仍是相对地址', leftRel.length === 0, JSON.stringify(leftRel))
}

console.log('\n■ V10 交棒正文的作废条件: 宁可退回真 URL, 绝不交半绝对化的清单')
{
  const base = 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc'
  check('V10-1 基准不是地址 → null', localizeVodPlaylist('#EXTM3U\n#EXTINF:9.0,\na.ts\n', 'not-a-url') === null)
  check('V10-2 单引号 URI(不在处理范围)→ 整体 null, 不是"跳过那一行"', localizeVodPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI='k.bin'\n#EXTINF:9.0,\na.ts\n", base) === null)
  const bad = localizeVodPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:9.0,\nhttp://bad host/x.ts\n#EXTINF:9.0,\nc.ts\n', base)
  check('V10-3 任一段地址解析不出 → 整份作废(留一半就是静默丢段)', bad === null, String(bad))
  const r = await ask('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:9.0,\nhttp://bad host/x.ts\n')
  check('V10-4 一份正文两半各自成立: sec=9 数得出(交棒失败不该把分母也赔进去), text 则交由调用方判废', r.v.sec === 9 && typeof r.v.text === 'string', JSON.stringify(r.v))
  const rec10 = src('src/main/services/recorder.ts')
  check('V10-5 recorder 判废的落点是 `|| src`, 且 localize 回 null 就立刻 return 空串(不是把不存在的路径交给 ffmpeg)', /this\.handVodPlaylist\(src, pl\.text\) \|\| src/.test(rec10) && /if \(body === null\) return ''/.test(rec10))
}

console.log('\n' + '─'.repeat(72))
check('V0 反空转下限: 本脚本真的发过 ≥10 次清单请求(每个场景各一次)', world.calls.length >= 10, `累计 ${world.calls.length} 次`)
console.log('\n' + '─'.repeat(72))
console.log(`结果: ${failures === 0 ? '全部按预期' : failures + ' 条与预期不符'}`)
console.log('解读: V1~V5 PASS ⇒ 分母只在"真的数得出"时给出, 数得出时精确到毫秒, 而那份正文没被丢掉;')
console.log('      V6 PASS ⇒ 拉不到的清单不会顺手打第二遍(风控面不放大);')
console.log('      V7 PASS ⇒ 三小时回放的累加误差不会改变用户看到的分钟数;')
console.log('      V8 PASS ⇒ 那一次读取的两个消费端都真接上了, 交棒失败退回的正是改动前的行为;')
console.log('      V9/V10 PASS ⇒ 交棒出去的文件能直接喂 ffmpeg, 而"喂不了"的判据是整份作废而不是将就.')
process.exit(failures === 0 ? 0 : 1)
