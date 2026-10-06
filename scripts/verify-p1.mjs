// ============================================================================
// 验证脚本: P1 批次(录制产物原子性 / 空历史 / 入参边界 / 机密降级可见 / HLS 代理访问面)
//
// 方法: electron/child_process(伪 ffmpeg)/store/notify/thumbs/logger 替换为可计数替身;
//       recorder.ts / hlsProxy.ts / secrets.ts / shared/types.ts / shared/hlsPlaylist.ts 用真实源码(sucrase 现编译).
//       伪 ffmpeg 会"失败也留下半截产物", 专门用来验我方代码有没有把坏文件收拾干净.
// 场景:
//   A1  remux 失败: 半截 .part 被清掉, 既不落 .mp4 也不入库(修复前坏包进库且喂给后续合并)
//   A2  remux 成功: .part 改名就位成 .mp4, deleteTs 只删已确认转换成功的那份
//   B1  分段合并: 昵称带单引号 → concat list 用 ffmpeg 词法 \' 转义(不是 shell 的 '\'')
//   B2  合并失败: 不出整文件、不留 .part/.concat.txt, 分段一个不删(数据丢失链封堵)
//   C1  拉源阶段停止: 零分段不写历史, 也不 spawn ffmpeg(修复前留一条永远打不开的空条目)
//   D1  对账清骨架: 空条目/目录已删/文件删空 → 移除; 目录里还有别人的媒体 → 保留
//   E1  mergeTask 幂等: 0 字节整文件重做 / 过期整文件重做 / 健康整文件直接返回且不重 spawn
//   E2  mergeTask 不把成品喂给自己(concat 输入表里绝无整文件) / 单段拒合并
//   F1  房间入参一把尺: isRoomId 与 parseRoomInput 同口径拒绝路径穿越/超长/控制字符
//   G1  HLS 代理三道闸: 缺令牌/令牌错 → 403, 未签发 origin → 403, 非法 url → 400
//   G2  代理正常链路: 清单重写带令牌 + 预载段过滤 + 上游请求头注入 + 跨实例令牌互不通用
//   G3 签发 origin 表有上限并按活跃度淘汰(长跑不涨面) / G5 上游在途合流: 同目标并发只发一发, 落定即撒锁、不设 TTL
//   H1  机密降级: 无系统密钥 → plain 封装 + degraded=true + 日志留痕; 恢复后重写转 enc
//   J1  意外退出的判活那一发: 一跳、现拉、只解最高档, 拉到的新签名源随失败收尾种回续录; 真下播不留种子
//   K1 回放清单交棒: 一份正文两处用(分母+ffmpeg 输入), 段地址绝对化后落盘、退出即删、对账隐形
//   K2  交棒不成(正文不可用/URI 解析不出)退回真 URL, 且目录里不留半个清单
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EventEmitter } from 'events'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0
let FAIL = 0
const fails = []
function assert(cond, name, detail = '') {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    fails.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`)
  }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const waitUntil = async (fn, ms = 3000) => {
  for (let i = 0; i < Math.ceil(ms / 20); i++) {
    if (fn()) return true
    await settle(20)
  }
  return fn()
}

// ---------- 临时世界 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-p1-'))
const REC = path.join(TMP, 'rec')
fs.mkdirSync(REC, { recursive: true })

const world = {
  // 取流替身
  play: { ok: true, m3u8: 'http://127.0.0.1:1/playlist.m3u8', variants: [{ url: 'http://127.0.0.1:1/720.m3u8' }], dlHeaders: {}, title: '', thumbUrl: '' },
  playDelayMs: 0,
  playCalls: [],
  seeded: [],
  invalidated: [],
  // A5 回放清单替身: 读了几发、这一发给出什么正文(交棒成功与否由这里决定)
  vodReads: [],
  vodPlaylist: null,
  // 伪 ffmpeg
  ffCalls: [],
  ffChildren: [],
  concatLists: [],
  segments: 2,
  segBytes: 700,
  remuxFail: false,
  concatFail: false,
  // 数据层替身
  settings: {},
  anchors: [],
  history: [],
  addHistoryCalls: 0,
  thumbQ: [],
  thumbRm: [],
  toasts: [],
  logInfo: [],
  logWarn: [],
  // 机密替身
  secretDir: '',
  encAvailable: true,
  encThrow: false,
  // 代理替身
  upstream: [],
  upstreamBody: {},
  upstreamStatus: {},
  upstreamDelayMs: 0, // 在途合流的量测用延迟(0=不发慢, G5 用来让两问撞进同一次上游读)
  hdrFor: () => ({ Cookie: 'sess=1', Origin: 'https://play.sooplive.com' })
}

// ---------- 伪 ffmpeg(spawn) ----------
class FakeChild extends EventEmitter {
  constructor(args) {
    super()
    this.args = args
    this.out = args[args.length - 1]
    this.stderr = new EventEmitter()
    this.stdout = new EventEmitter()
    // 直播录制的 ffmpeg 是"常驻"进程: 只有 stdin 收到 q / 被 kill 才退出
    this.stdin = {
      write: () => true,
      end: () => {
        if (!this.ended) {
          this.ended = true
          setTimeout(() => this.emit('exit', 0), 3)
        }
      }
    }
  }
  kill() {
    if (!this.ended) {
      this.ended = true
      setTimeout(() => this.emit('exit', 1), 3)
    }
  }
}

// 输出侧是否显式声明了 mp4 封装器(-f 必须出现在 -i 之后, 前面的 -f concat 是输入侧)
function declaresMp4(args) {
  if (!args) return false
  const a = args.slice(args.indexOf('-i') + 1)
  const i = a.indexOf('-f')
  return i >= 0 && a[i + 1] === 'mp4'
}

function fakeSpawn(bin, args) {
  // 抓流那一支必带 -protocol_whitelist; 回放直出还多带 -progress(要回报下载时长),
  // 靠这两把尺把"常驻的录制进程"与"跑完就退的 remux/concat"分开 —— 伪 ffmpeg 不能替录制提前退出
  const capture = args.includes('-protocol_whitelist')
  const kind = args.includes('concat') ? 'concat' : args.includes('segment') ? 'seg' : capture ? (args.includes('-progress') ? 'vod' : 'capture') : 'remux'
  const child = new FakeChild(args)
  world.ffCalls.push({ kind, args, out: child.out })
  if (kind === 'seg') {
    for (let i = 1; i <= world.segments; i++) fs.writeFileSync(child.out.replace('%04d', String(i).padStart(4, '0')), Buffer.alloc(world.segBytes, 0x54))
    return child
  }
  if (kind === 'capture') {
    // 常驻进程交回给场景: 有的测试要模拟"不是我们 kill 的那一次退出"(意外中断)
    world.ffChildren.push(child)
    // 不分段(splitSeconds=0): 整场一个 TS 从头写到尾, 进程同样常驻, 收 'q' 才退
    fs.writeFileSync(child.out, Buffer.alloc(world.segBytes, 0x54))
    return child
  }
  if (kind === 'vod') {
    // 回放下载同样是常驻进程(拉完才自己退), 而且必须活着让场景看见"交棒清单此刻还在盘上"
    world.ffChildren.push(child)
    fs.writeFileSync(child.out, Buffer.alloc(world.segBytes, 0x54))
    // 喂一行 -progress: out_time_ms 历史命名实为微秒, 这条同时验解析器接得住
    setImmediate(() => child.stdout.emit('data', Buffer.from('out_time_ms=12000000\nprogress=end\n')))
    return child
  }
  // 真 ffmpeg 按输出扩展名推断封装器。原子产物叫 <x>.mp4.part, 不点名 -f 就直接
  // "Unable to choose an output format" 非零退出、一个字节都不写 —— 伪 ffmpeg 必须同样挑名字,
  // 否则"整条 remux 全灭"也能测出 PASS(这条是实机录了一段真直播才抓到的)
  const afterIn = args.slice(args.indexOf('-i') + 1)
  const fi = afterIn.indexOf('-f')
  if (fi < 0 && !/\.(mp4|ts|mkv)$/i.test(child.out)) {
    setImmediate(() => child.emit('exit', 1))
    return child
  }
  setImmediate(() => {
    const fail = kind === 'concat' ? world.concatFail : world.remuxFail
    if (kind === 'concat') {
      const listFile = args[args.indexOf('-i') + 1]
      try {
        world.concatLists.push(fs.readFileSync(listFile, 'utf-8'))
      } catch {
        world.concatLists.push('')
      }
    }
    // 对抗性: 真 ffmpeg 失败也常留下半截文件, 我方必须自己收走
    try {
      fs.writeFileSync(child.out, Buffer.alloc(fail ? 9 : world.segBytes, fail ? 0x48 : 0x4d))
    } catch {
      /* ignore */
    }
    child.emit('exit', fail ? 1 : 0)
  })
  return child
}

// ---------- 模块替身 ----------
const baseStore = {
  getSettings: () => world.settings,
  listAnchors: () => world.anchors,
  addHistory: (t) => {
    world.addHistoryCalls++
    world.history.push({ id: t.id, platform: t.platform, userId: t.userId, nick: t.nick, dirPath: t.dirPath, files: [...t.files], bytes: t.bytes, endedAt: t.endedAt })
  },
  listHistory: () => world.history,
  updateHistory: (id, patch) => {
    const it = world.history.find((h) => h.id === id)
    if (it) Object.assign(it, patch)
  },
  removeHistory: (id) => {
    world.history = world.history.filter((h) => h.id !== id)
  }
}

const fakeUpstreamFetch = async (url, init = {}) => {
  world.upstream.push({ url, headers: init.headers || {} })
  if (world.upstreamDelayMs) await new Promise((r) => setTimeout(r, world.upstreamDelayMs))
  const status = world.upstreamStatus[url] ?? 200
  const body = world.upstreamBody[url] ?? '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n#EXTINF:6.0,\nseg2-preloading.ts\n#EXT-X-ENDLIST\n'
  return new Response(body, { status, headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
}

const mocks = {
  electron: {
    app: { isPackaged: false, getAppPath: () => ROOT, getPath: () => TMP, setPath() {}, on() {}, whenReady: () => Promise.resolve() },
    BrowserWindow: { getAllWindows: () => [] },
    shell: { trashItem: async () => {}, openPath: async () => ({ error: '' }), showItemInFolder() {}, openExternal: async () => {} },
    ipcMain: { handle() {} },
    safeStorage: {
      isEncryptionAvailable: () => world.encAvailable,
      encryptString: (s) => {
        if (world.encThrow) throw new Error('DPAPI 调用失败(sim)')
        return Buffer.from(`enc(${s})`, 'utf-8')
      },
      decryptString: (buf) => {
        const t = buf.toString('utf-8')
        if (!t.startsWith('enc(')) throw new Error('密文格式非法')
        return t.slice(4, -1)
      }
    },
    session: { defaultSession: { fetch: fakeUpstreamFetch }, fromPartition: () => ({ fetch: fakeUpstreamFetch }) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) }
  },
  child_process: { spawn: fakeSpawn },
  'ffmpeg-static': path.join(TMP, 'fake-ffmpeg.exe'),
  '../util': {}, // 下面用真实 util 覆盖 dataDir
  // 回放清单替身改成可注入正文 + 计数: 旧替身是 { api: { 只求和就丢正文 } } 的死壳,
  // "一份正文两处用"和"交棒失败退回真 URL"就永远只能靠读代码相信(这正是本脚本开头点名踩过的坑)
  './pandalive': {
    api: {
      fetchVodPlaylist: async (url) => {
        world.vodReads.push(url)
        return world.vodPlaylist
      }
    }
  },
  './source': {
    sourceFor: () => ({
      // 判活那一发带 forceFresh/fullVariants 两个入参, 替身必须照记, 否则"只解最高档"永远测不出来
      getPlayCached: async (userId, password, forceFresh, fullVariants) => {
        world.playCalls.push({ userId, password, forceFresh, fullVariants })
        if (world.playDelayMs) await settle(world.playDelayMs)
        return world.play
      },
      fetchPlay: async (userId) => {
        world.playCalls.push({ userId, probe: true })
        return world.play
      },
      seedPlay: (userId, pack) => world.seeded.push({ userId, ok: !!pack?.ok }),
      invalidatePlay: (userId) => world.invalidated.push(userId)
    })
  },
  './store': { store: baseStore },
  './thumbs': { thumbs: { enqueue: (id) => world.thumbQ.push(id), remove: (id) => world.thumbRm.push(id) } },
  './notify': { sendToast: (t, c) => world.toasts.push({ t, c }) },
  './logger': {
    logger: {
      info: (tag, msg) => world.logInfo.push(String(msg)),
      warn: (tag, msg) => world.logWarn.push(String(msg)),
      error: (tag, msg) => world.logWarn.push(String(msg)),
      debug() {},
      flush() {}
    }
  },
  '../i18n': { mt: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), setMainLocale() {} }
}

// ---------- TS 即时编译加载 ----------
const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id]
    if (id === '../../shared/types') return loadTs('src/shared/types.ts')
    // A5 清单本地化挂真实现: 交棒正文是不是真把相对段地址改成了绝对地址, 只有真函数说了算
    if (id === '../../shared/hlsPlaylist') return loadTs('src/shared/hlsPlaylist.ts')
    // 车道挂真实现(不另写替身): 替身绿而真车道从未被跑过, 正是这套脚本此前踩过的坑
    if (id === './netGate') return loadTs('src/main/services/netGate.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const realUtil = loadTs('src/main/util.ts')
mocks['../util'] = { ...realUtil, dataDir: () => world.secretDir }
const types = loadTs('src/shared/types.ts')
const { recorder, strictName } = loadTs('src/main/services/recorder.ts')

// ---------- 场景辅助 ----------
const listTask = (uid, platform = 'pandalive') => recorder.list().find((t) => t.userId === uid && t.platform === platform)
const hist = () => world.history
const media = (dir) => fs.readdirSync(dir).filter((n) => /\.(mp4|ts)$/i.test(n)).sort()
// 与主进程同一条"分段形态"判据: `<基名>_0001.ts` 是分段, `<基名>.mp4` 是合并成品
const SEG_RE = /_(\d{4}|vod)\.(mp4|ts)$/i
const segsIn = (dir) => media(dir).filter((n) => SEG_RE.test(n))
const wholeIn = (dir) => media(dir).filter((n) => !SEG_RE.test(n))
const anyOf = (dir, suffix) => fs.readdirSync(dir).some((n) => n.endsWith(suffix))
const defaults = (over = {}) => ({ ...types.DEFAULT_SETTINGS, savePath: REC, diskLimitGb: 0, autoMp4: true, deleteTs: false, mergeMp4: false, mergeDeleteSegments: false, proxyUrl: '', ...over })

async function reset(over = {}) {
  await recorder.stopAll()
  world.play = { ok: true, m3u8: 'http://127.0.0.1:1/playlist.m3u8', variants: [{ url: 'http://127.0.0.1:1/720.m3u8' }], dlHeaders: {}, title: '', thumbUrl: '' }
  world.playDelayMs = 0
  world.playCalls.length = 0
  world.vodReads.length = 0
  world.vodPlaylist = null
  world.seeded.length = 0
  world.invalidated.length = 0
  world.ffCalls.length = 0
  world.ffChildren.length = 0
  world.concatLists.length = 0
  world.segments = 2
  world.segBytes = 700
  world.remuxFail = false
  world.concatFail = false
  world.history = []
  world.addHistoryCalls = 0
  world.thumbQ.length = 0
  world.thumbRm.length = 0
  world.toasts.length = 0
  world.logInfo.length = 0
  world.logWarn.length = 0
  world.anchors = []
  world.secretDir = fs.mkdtempSync(path.join(TMP, 'secret-'))
  world.encAvailable = true
  world.encThrow = false
  world.upstream.length = 0
  world.upstreamBody = {}
  world.upstreamStatus = {}
  world.upstreamDelayMs = 0
  world.settings = defaults(over)
}

/** 走完"开始录制 → 停止"一次, 返回该任务的历史条目(未入库则为 null)。
 *  flags 在 reset 之后执行(reset 会复位伪 ffmpeg 的失败开关, 先设后被冲掉就等于没设) */
async function recordOnce(uid, nick, over = {}, flags = () => {}) {
  await reset(over)
  flags()
  await recorder.start({ platform: 'pandalive', userId: uid, nick, title: '', auto: false })
  const dir = listTask(uid).dirPath
  await recorder.stop('pandalive', uid)
  await waitUntil(() => recorder.list().length === 0)
  return { dir, item: hist().find((h) => h.userId === uid) || null }
}

// ============================================================================
console.log('\n--- A1 remux 失败不得留下可入库的半截 MP4 ---')
{
  const { dir, item } = await recordOnce('a1', 'Anchor One', { autoMp4: true, deleteTs: true }, () => {
    world.remuxFail = true
  })
  assert(media(dir).length === 2 && media(dir).every((n) => n.endsWith('.ts')) && segsIn(dir).length === 2, 'A1-1 目录里只剩 2 段 TS 分段', media(dir).join(','))
  assert(!anyOf(dir, '.mp4'), 'A1-2 没有半截 .mp4 落盘')
  assert(!anyOf(dir, '.part'), 'A1-3 失败产物 .part 被清走')
  assert(!!item && item.files.length === 2, 'A1-4 入库文件表 = 2 段 TS(坏包不进库)', item && JSON.stringify(item.files))
  assert(item.bytes === 1400, 'A1-5 字节数只算现存分段', String(item && item.bytes))
}

console.log('\n--- A2 remux 成功: .part 改名就位, deleteTs 只删已转换的那份 ---')
{
  const { dir, item } = await recordOnce('a2', 'Anchor Two', { autoMp4: true, deleteTs: true })
  assert(media(dir).length === 2 && media(dir).every((n) => n.endsWith('.mp4')), 'A2-1 产出 2 个 MP4 且 TS 已删', media(dir).join(','))
  assert(!anyOf(dir, '.part'), 'A2-2 不留 .part 中间产物')
  assert(!!item && item.files.every((f) => f.endsWith('.mp4')), 'A2-3 库里指向 MP4')
  const remuxCall = world.ffCalls.find((c) => c.kind === 'remux')
  assert(remuxCall && remuxCall.out.endsWith('.mp4.part'), 'A2-4 ffmpeg 目标就是 .part(不是终名直写)', remuxCall && remuxCall.out)
  assert(declaresMp4(remuxCall?.args), 'A2-6 .part 输出必须点名 -f mp4: 真 ffmpeg 按扩展名推断封装器, 猜不出就非零退出且不写一个字节(整条转码静默全灭)', remuxCall && remuxCall.args.join(' '))
  assert(world.thumbQ.length === 1, 'A2-5 有产物才排缩略图')
}

console.log('\n--- B1 分段合并: 昵称带单引号的 concat 转义 ---')
{
  const { dir, item } = await recordOnce('b1', "O'Neil", { autoMp4: true, deleteTs: true, mergeMp4: true, mergeDeleteSegments: false })
  const list = world.concatLists[0] || ''
  assert(list.includes("O\\'Neil"), "B1-1 concat list 用 ffmpeg 词法转义单引号", list.split('\n')[0])
  assert(!list.includes("'\\''"), 'B1-2 不再使用 shell 的引号转义惯用法')
  const mergeCall = world.ffCalls.find((c) => c.kind === 'concat')
  assert(mergeCall && mergeCall.out.endsWith('.mp4.part'), 'B1-3 合并产物先落 .part', mergeCall && mergeCall.out)
  assert(declaresMp4(mergeCall?.args), 'B1-3b 合并侧同样要点名输出封装器: 输入侧的 -f concat 管不到 .part 输出', mergeCall && mergeCall.args.join(' '))
  assert(wholeIn(dir).length === 1 && wholeIn(dir)[0].endsWith('.mp4'), 'B1-4 合并整文件就位(非分段形态的那一个)', media(dir).join(','))
  assert(segsIn(dir).length === 2, 'B1-5 未开删除时分段全留', media(dir).join(','))
  assert(!!item && item.files.length === 3, 'B1-6 库里同时索引整文件与分段', item && JSON.stringify(item.files.map((f) => path.basename(f))))
}

console.log('\n--- B2 合并失败: 不留半成品, 分段一个都不能少 ---')
{
  const { dir } = await recordOnce(
    'b2',
    "O'Neil",
    { autoMp4: true, deleteTs: true, mergeMp4: true, mergeDeleteSegments: true },
    () => {
      world.concatFail = true
    }
  )
  assert(wholeIn(dir).length === 0, 'B2-1 失败的合并不产出整文件', media(dir).join(','))
  assert(!anyOf(dir, '.part') && !anyOf(dir, '.concat.txt'), 'B2-2 .part/.concat.txt 都被清理', fs.readdirSync(dir).join(','))
  assert(segsIn(dir).length === 2, 'B2-3 分段未被"合并后删除分段"误删(数据丢失链封堵)', media(dir).join(','))
  assert(world.logWarn.some((l) => l.includes('分段合并失败')), 'B2-4 失败有日志留痕')
}

console.log('\n--- C1 拉源阶段停止: 零分段不写历史 ---')
{
  await reset()
  world.playDelayMs = 120
  const started = recorder.start({ platform: 'pandalive', userId: 'c1', nick: 'Slow Fetch', title: '', auto: false })
  await settle(20) // 此刻仍在 fetch 第一棒
  await recorder.stop('pandalive', 'c1')
  await started
  await settle(160) // 让在飞的取流回包落完(不得再 spawn)
  assert(world.history.length === 0 && world.addHistoryCalls === 0, 'C1-1 磁盘零文件 → 库里零条目')
  assert(world.ffCalls.length === 0, 'C1-2 停止后迟到的取流不回启 ffmpeg')
  assert(world.logInfo.some((l) => l.includes('零分段结束')), 'C1-3 零分段结束有日志说明')
  assert(recorder.list().length === 0, 'C1-4 无僵尸任务')
  assert(world.thumbQ.length === 0, 'C1-5 空条目不排缩略图')
}

console.log('\n--- D1 对账: 空骨架条目清掉, 别人的文件不许认领 ---')
{
  await reset()
  const mkDir = (n) => {
    const d = path.join(TMP, 'rec', 'd', n)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const empty = mkDir('empty')
  const other = mkDir('other')
  fs.writeFileSync(path.join(other, '别人的会话_0001.ts'), 'x')
  const wiped = mkDir('wiped')
  const gone = path.join(TMP, 'rec', 'd', 'gone')
  world.history = [
    { id: 'd-empty', platform: 'pandalive', userId: 'd1', nick: '空条目', dirPath: empty, files: [], bytes: 0 },
    { id: 'd-other', platform: 'pandalive', userId: 'd2', nick: '他人媒体', dirPath: other, files: [], bytes: 0 },
    { id: 'd-wiped', platform: 'pandalive', userId: 'd3', nick: '文件删空', dirPath: wiped, files: [path.join(wiped, 'x_0001.ts')], bytes: 5 },
    { id: 'd-gone', platform: 'pandalive', userId: 'd4', nick: '目录已删', dirPath: gone, files: [], bytes: 0 }
  ]
  const r = recorder.reconcileHistory()
  assert(r.dropped === 3, 'D1-1 三条骨架/删空条目被移除', JSON.stringify(r))
  assert(hist().length === 1 && hist()[0].id === 'd-other', 'D1-2 目录内还有其它媒体时保守保留', JSON.stringify(hist()))
  assert(world.thumbRm.length === 3, 'D1-3 移除条目同步清缩略图')

  // D2 合并成品的索引稳定性: files 表里整文件排序在分段前, 对账不得因此认不出分段
  await reset()
  const dm = path.join(TMP, 'rec', 'd', 'merged')
  fs.mkdirSync(dm, { recursive: true })
  const names = ["合并者(m1)_20260101_120000.mp4", '合并者(m1)_20260101_120000_0001.mp4', '合并者(m1)_20260101_120000_0002.mp4']
  for (const n of names) fs.writeFileSync(path.join(dm, n), 'z'.repeat(100))
  const mf = names.map((n) => path.join(dm, n))
  world.history = [{ id: 'd-merged', platform: 'pandalive', userId: 'm1', nick: '合并者', dirPath: dm, files: mf, bytes: 300 }]
  const r2 = recorder.reconcileHistory()
  assert(r2.changed === 0 && r2.dropped === 0, 'D2-1 成品+分段的索引对账幂等(不改写、不移除)', JSON.stringify(r2))
  assert(hist()[0].files.length === 3, 'D2-2 在盘分段不会被基名误判而从库里抹掉', JSON.stringify(hist()[0].files.map((f) => path.basename(f))))
}

console.log('\n--- E1/E2 mergeTask 幂等与自喂防护 ---')
{
  await reset()
  const d = path.join(TMP, 'rec', 'e', 'E(a9)')
  fs.mkdirSync(d, { recursive: true })
  const s1 = path.join(d, 'E(a9)_0001.mp4')
  const s2 = path.join(d, 'E(a9)_0002.mp4')
  const out = path.join(d, 'E(a9).mp4')
  const writeSegs = () => {
    fs.writeFileSync(s1, 'A'.repeat(300))
    fs.writeFileSync(s2, 'B'.repeat(300))
    for (const f of [s1, s2]) fs.utimesSync(f, new Date(), new Date())
  }
  const item = { id: 'e-1', platform: 'pandalive', userId: 'a9', nick: 'E', dirPath: d, files: [s1, s2], bytes: 600 }

  // E1-a: 0 字节整文件 = 上次被腰斩, 必须重做
  writeSegs()
  fs.writeFileSync(out, '')
  world.history = [{ ...item, files: [s1, s2, out] }]
  world.ffCalls.length = 0
  let r = await recorder.mergeTask('e-1')
  assert(r.ok && fs.statSync(out).size > 0, 'E1-a 零字节整文件被重新合并覆盖(不再谎报成功)')
  assert(world.ffCalls.some((c) => c.kind === 'concat'), 'E1-b 确实重跑了一次 concat')
  assert(!fs.existsSync(out + '.part'), 'E1-c 就位后不留 .part')

  // E2: 整文件绝不进自己的输入表
  writeSegs()
  fs.writeFileSync(out, '')
  world.concatLists.length = 0
  world.history = [{ ...item, files: [out, s1, s2] }]
  r = await recorder.mergeTask('e-1')
  const list = world.concatLists[world.concatLists.length - 1] || ''
  const listPaths = list.split('\n').filter(Boolean).map((l) => l.replace(/^file '/, '').replace(/'$/, ''))
  assert(r.ok && !listPaths.some((p) => path.basename(p) === 'E(a9).mp4'), 'E2-a concat 输入表里没有整文件(成品不再套一遍)', list)
  assert(listPaths.length === 2, 'E2-b 两段分段都在输入表且仅此两段', JSON.stringify(listPaths))

  // E1-d: 过期整文件(合并后又续录过) → 重做
  writeSegs()
  fs.writeFileSync(out, 'W'.repeat(500))
  fs.utimesSync(out, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  world.ffCalls.length = 0
  world.history = [{ ...item, files: [s1, s2, out] }]
  r = await recorder.mergeTask('e-1')
  assert(r.ok && world.ffCalls.some((c) => c.kind === 'concat'), 'E1-d 早于分段的整文件判为过期并重做')
  assert(world.logWarn.some((l) => l.includes('既有整文件不可用')), 'E1-e 重做原因有日志')

  // E1-f: 健康整文件 → 直接成功, 零 ffmpeg
  fs.writeFileSync(out, 'W'.repeat(500))
  world.ffCalls.length = 0
  world.history = [{ ...item, files: [s1, s2, out] }]
  r = await recorder.mergeTask('e-1')
  assert(r.ok && world.ffCalls.length === 0, 'E1-f 健康的整文件幂等命中, 不重复合并')

  // E2-c: 只有一段 → 明确拒合并
  fs.rmSync(out, { force: true })
  fs.rmSync(s2, { force: true })
  world.history = [{ ...item, files: [s1] }]
  r = await recorder.mergeTask('e-1')
  assert(!r.ok && r.error === 'rec.mergeFew', 'E2-c 单段拒合并并给出原因', JSON.stringify(r))
}

console.log('\n--- F1 房间入参: isRoomId 与 parseRoomInput 同一把尺 ---')
{
  const { isRoomId, parseRoomInput } = types
  const bad = ['', 'a/b', 'a\\b', '..\\..\\windows', '../../etc/passwd', 'a..b', 'a.', 'a b', 'x'.repeat(81), 'a\u0000b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', '%04d', null, undefined, 42]
  const badKept = bad.filter((v) => isRoomId(v))
  assert(badKept.length === 0, 'F1-1 路径穿越/保留字符/控制字符/超长一律拒', JSON.stringify(badKept))
  const good = ['abcdefgh', 'soop_channel_1', 'a.b-c', 'x'.repeat(80)]
  assert(good.every((v) => isRoomId(v)), 'F1-2 正常登录名/频道名不误杀')
  assert(parseRoomInput('https://www.pandalive.co.kr/play/abc123')?.userId === 'abc123', 'F1-3 Panda 链接解析正常')
  assert(parseRoomInput('https://play.sooplive.com/ch_x')?.userId === 'ch_x', 'F1-4 SOOP 链接解析正常')
  assert(parseRoomInput('x'.repeat(81)) === null, 'F1-5 超长 ID 不入库(与主进程同口径)')
  assert(parseRoomInput('../../etc/passwd', 'pandalive') === null, 'F1-6 穿越形态输入解析不出房间')
  const sn = strictName("a\\/:*?\"<>|%b  c..")
  assert(sn === 'ab c', 'F1-7 落盘名剔除非法字符与尾部点', JSON.stringify(sn))
  assert(strictName('%') === 'app.unnamed', 'F1-8 全非法名退化为未命名(mt 替身返回键名)')
}

console.log('\n--- G1/G2/G3 本地 HLS 代理访问面 ---')
{
  const { HlsProxy } = loadTs('src/main/services/hlsProxy.ts')
  const proxies = []
  const mk = async () => {
    const p = new HlsProxy({ headers: world.hdrFor, sessionPartition: 'persist:soop', onDeadUpstream: () => {} })
    await p.listen()
    proxies.push(p)
    return p
  }
  const get = async (url) => {
    const res = await fetch(url)
    return { status: res.status, text: await res.text() }
  }
  const p = await mk()
  const up = 'https://live.sooplive.com/abc/720.m3u8'
  const signed = p.playlistUrl(up)
  const token = new URL(signed).searchParams.get('t')
  assert(/^[0-9a-f]{32}$/.test(token || ''), 'G1-0 播放清单地址带 32 位令牌', token)

  const noToken = await get(`http://127.0.0.1:${new URL(signed).port}/playlist.m3u8?url=${encodeURIComponent(up)}`)
  assert(noToken.status === 403 && noToken.text === 'bad token', 'G1-1 缺令牌的请求 403(本机其它进程扫端口无用)', JSON.stringify(noToken))
  const wrongToken = await get(`http://127.0.0.1:${new URL(signed).port}/playlist.m3u8?t=deadbeef&url=${encodeURIComponent(up)}`)
  assert(wrongToken.status === 403, 'G1-2 令牌错误 403')
  const notSigned = await get(`http://127.0.0.1:${new URL(signed).port}/playlist.m3u8?t=${token}&url=${encodeURIComponent('https://evil.example.com/x.m3u8')}`)
  assert(notSigned.status === 403 && notSigned.text === 'target not allowed', 'G1-3 未签发 origin 403(不是开放代理)', JSON.stringify(notSigned))
  const badUrl = await get(`http://127.0.0.1:${new URL(signed).port}/media?t=${token}&url=file:///c:/windows/win.ini`)
  assert(badUrl.status === 400, 'G1-4 非 http(s) 目标 400')

  const okRes = await get(signed)
  assert(okRes.status === 200 && okRes.text.includes('#EXTM3U'), 'G2-1 已签发地址正常出清单')
  assert(!okRes.text.includes('preloading'), 'G2-2 预载分段被过滤')
  const mediaLine = okRes.text.split('\n').find((l) => l.includes('/media'))
  assert(mediaLine && mediaLine.includes(`t=${token}`), 'G2-3 重写后的分段地址继承本实例令牌', mediaLine)
  assert(world.upstream.some((u) => u.headers.Cookie === 'sess=1'), 'G2-4 上游请求带注入的 Cookie 头')
  const p2 = await mk()
  const cross = await get(`http://127.0.0.1:${new URL(p2.playlistUrl(up)).port}/playlist.m3u8?t=${token}&url=${encodeURIComponent(up)}`)
  assert(cross.status === 403, 'G2-5 跨实例令牌互不通用(每实例独立随机)')

  // G3: 签发表有上限且按活跃度淘汰
  const p3 = await mk()
  const t3 = new URL(p3.playlistUrl('https://cdn0.example.com/a.m3u8')).searchParams.get('t')
  const port3 = new URL(p3.playlistUrl(up)).port
  for (let i = 0; i < 40; i++) p3.playlistUrl(`https://cdn${i}.example.com/a.m3u8`)
  assert(p3.allowedOrigins.size <= 32, 'G3-1 签发 origin 表不超上限(长跑不涨面)', String(p3.allowedOrigins.size))
  const evicted = await get(`http://127.0.0.1:${port3}/playlist.m3u8?t=${t3}&url=${encodeURIComponent('https://cdn0.example.com/a.m3u8')}`)
  assert(evicted.status === 403, 'G3-2 最久未用的 origin 被淘汰后取不到')
  const kept = await get(`http://127.0.0.1:${port3}/playlist.m3u8?t=${t3}&url=${encodeURIComponent('https://cdn39.example.com/a.m3u8')}`)
  assert(kept.status === 200, 'G3-3 活跃 origin 保留')
  // 重复签发刷新时效: 反复签 cdn0 不该被淘汰
  const p4 = await mk()
  const t4 = new URL(p4.playlistUrl(up)).searchParams.get('t')
  const port4 = new URL(p4.playlistUrl(up)).port
  for (let i = 0; i < 60; i++) p4.playlistUrl(i % 2 ? `https://x${i}.example.com/a.m3u8` : 'https://keep.example.com/a.m3u8')
  const keepRes = await get(`http://127.0.0.1:${port4}/playlist.m3u8?t=${t4}&url=${encodeURIComponent('https://keep.example.com/a.m3u8')}`)
  assert(keepRes.status === 200, 'G4-1 反复签发的活跃 CDN 不被淘汰(否则录制自断)')
  // G5 上游在途合流: 同一个目标并发几问只打上游一发(清单重载与分片重试正是这一形状)
  {
    const port = new URL(signed).port
    const segUrl = new URL(mediaLine || 'media', `http://127.0.0.1:${port}`).href
    world.upstreamDelayMs = 150
    const before = world.upstream.length
    const [ra, rb, rc] = await Promise.all([get(signed), get(signed), get(signed)])
    assert(
      world.upstream.length - before === 1 && ra.status === 200 && rb.text === ra.text && rc.text === ra.text,
      'G5-1 并发三问同一清单只发一发上游, 三份都拿到改写后的正文(合流不吞任何一问)',
      `上游=${world.upstream.length - before}`
    )
    const beforeSeg = world.upstream.length
    world.upstreamDelayMs = 150
    const [sa, sb] = await Promise.all([get(segUrl), get(segUrl)])
    assert(
      world.upstream.length - beforeSeg === 1 && sa.status === 200 && sb.status === 200,
      'G5-2 同一分片并发重问(ffmpeg 重试)同样合流, 分片走 Buffer 不改写',
      `上游=${world.upstream.length - beforeSeg}`
    )
    world.upstreamDelayMs = 0
    const afterLive = world.upstream.length
    const r2 = await get(signed)
    assert(world.upstream.length - afterLive === 1 && r2.status === 200, 'G5-3 只在途合流、不设 TTL: 上一次落定之后再问要重新读(直播清单每一秒都是新数)')
    world.upstreamDelayMs = 150
    const beforeTwo = world.upstream.length
    const ua = p.playlistUrl('https://cdnA.example.com/a.m3u8')
    const ub = p.playlistUrl('https://cdnB.example.com/b.m3u8')
    await Promise.all([get(ua), get(ub)])
    assert(world.upstream.length - beforeTwo === 2, 'G5-4 不同目标各发一发(合流按目标键, 不跨房串正文)', `上游=${world.upstream.length - beforeTwo}`)
    world.upstreamDelayMs = 0
    // 失败那一发不许把坏正文供成"永久": 锁按身份撒, 下一问重新读上游
    world.upstreamStatus['https://live.sooplive.com/abc/720.m3u8'] = 503
    const beforeFail = world.upstream.length
    const f1 = await get(signed)
    const f2 = await get(signed)
    assert(
      f1.status === 503 && f2.status === 503 && world.upstream.length - beforeFail === 2,
      'G5-5 上游 503 在两问之间落定时各发一发: 锁用完即撒, 坏读数不缓存',
      `码=${f1.status}/${f2.status} 上游=${world.upstream.length - beforeFail}`
    )
    delete world.upstreamStatus['https://live.sooplive.com/abc/720.m3u8']
    assert(p.inflightReads.size === 0, 'G5-6 合流表在每问落定后清空(长跑不留Promise 引用)')
    // 合流是"替上游省下一发", 省了多少过去没人知道: 计数分账 + 60 秒一句摘要
    assert(p.mergedPlays + p.mergedSegs === 2 && p.mergedPlays === 1 && p.mergedSegs === 1, 'G5-7 合流计数分账累计(清单/分片各记各的, 首句之后的落进窗口)', JSON.stringify({ pl: p.mergedPlays, sg: p.mergedSegs }))
    assert(world.logInfo.some((m) => /上游在途合流/.test(m)), 'G5-8 合流出声一句(过去这一省是静默的)', world.logInfo.join(' | '))
  }
  for (const pr of proxies) {
    pr.server.closeAllConnections?.()
    await new Promise((res) => pr.server.close(res))
  }
}

console.log('\n--- H1 无系统密钥时的机密降级必须说实话 ---')
{
  const loadFresh = () => {
    moduleCache.delete('src/main/services/secrets.ts')
    return loadTs('src/main/services/secrets.ts').secrets
  }
  // H1: 密钥可用 → enc: 落盘, degraded=false
  await reset()
  let s = loadFresh()
  s.set('tgToken', '123:ABC')
  const raw = fs.readFileSync(path.join(world.secretDir, 'secrets.dat'), 'utf-8')
  assert(raw.startsWith('enc:'), 'H1-1 密钥可用时以 enc: 封装落盘')
  assert(s.degraded === false, 'H1-2 正常态不谎报降级')
  assert(s.get('tgToken') === '123:ABC', 'H1-3 取回原值')
  // H2: 密钥不可用 → plain: 落盘 + degraded + 日志
  await reset()
  world.encAvailable = false
  s = loadFresh()
  s.set('tgToken', '123:ABC')
  const raw2 = fs.readFileSync(path.join(world.secretDir, 'secrets.dat'), 'utf-8')
  assert(raw2.startsWith('plain:'), 'H2-1 无系统密钥时降级 plain 封装')
  assert(s.degraded === true, 'H2-2 degraded 如实上报(UI 据此提示)')
  assert(world.logWarn.some((l) => l.includes('系统密钥不可用')), 'H2-3 降级有日志留痕(不再静默)')
  assert(Buffer.from(raw2.slice(6), 'base64').toString('utf-8').includes('123:ABC'), 'H2-4 plain 确为可逆编码(风险描述属实)')
  // H3: 磁盘仍是 plain, 系统密钥恢复 → 仍报降级, 直到下次写入才转 enc
  moduleCache.delete('src/main/services/secrets.ts')
  world.encAvailable = true
  s = loadFresh()
  assert(s.degraded === true, 'H3-1 磁盘那份还是明文时不谎称已加密')
  s.set('tgToken', '123:ABC')
  const raw3 = fs.readFileSync(path.join(world.secretDir, 'secrets.dat'), 'utf-8')
  assert(raw3.startsWith('enc:') && s.degraded === false, 'H3-2 下次写入即迁回 enc, 状态同步澄清')
  // H4: 加密路径本身抛错(如 DPAPI 抖动) → 降级但不静默
  await reset()
  world.encThrow = true
  s = loadFresh()
  s.set('tgToken', '123:ABC')
  assert(fs.readFileSync(path.join(world.secretDir, 'secrets.dat'), 'utf-8').startsWith('plain:'), 'H4-1 加密写入异常时回落明文')
  assert(world.logWarn.some((l) => l.includes('加密写入失败')), 'H4-2 异常路径同样留痕')
  assert(s.get('tgToken') === '123:ABC', 'H4-3 功能不因降级中断(值仍可用)')
}

console.log('\n--- I1 不分段(splitSeconds=0): 整场一个 TS, 不进 segment 也不该进 concat ---')
{
  await reset({ splitSeconds: 0, autoMp4: true, deleteTs: false, mergeMp4: true, mergeDeleteSegments: true })
  await recorder.start({ platform: 'pandalive', userId: 'i1', nick: 'Solo One', title: '', auto: false })
  const t0 = listTask('i1')
  const dir = t0.dirPath
  await waitUntil(() => media(dir).length >= 1)
  const cap = world.ffCalls.find((c) => c.kind === 'capture')
  const segSpawn = world.ffCalls.find((c) => c.kind === 'seg')
  assert(!!cap, 'I1-1 录制走单文件直出那一支(伪 ffmpeg 认成常驻抓流进程, 不是跑完即退的 remux)')
  assert(!segSpawn && cap && !cap.args.includes('segment') && !cap.out.includes('%04d'), 'I1-2 命令行里没有 -f segment / 没有 %04d 模板', cap && cap.args.join(' '))
  assert(media(dir).length === 1 && !SEG_RE.test(media(dir)[0]) && media(dir)[0].endsWith('.ts'), 'I1-3 盘上就一个 TS, 名字不带段号(SEG_RE 不认它是"一段")', media(dir).join(','))
  // 文件是 spawn 时同步落盘的, 统计却是 2s 一跳 —— 不等下一拍就会读到空 currentFile/0 字节(那是时序, 不是缺陷)
  await waitUntil(() => (listTask('i1')?.bytes ?? 0) > 0, 5000)
  const t1 = listTask('i1')
  assert(t1.bytes === world.segBytes && path.basename(t1.currentFile) === media(dir)[0], 'I1-4 下一轮 2s 统计把这个单文件读成"当前文件"(停滞检测读的正是它)', `${t1.bytes}/${t1.currentFile}`)
  await recorder.stop('pandalive', 'i1')
  await waitUntil(() => recorder.list().length === 0)
  const item = hist().find((h) => h.userId === 'i1')
  assert(world.ffCalls.filter((c) => c.kind === 'concat').length === 0, 'I1-5 mergeMp4 开着也不 spawn concat: 没有第二段可合, 收尾不该承诺合并')
  const m = media(dir)
  assert(m.length === 2 && m.some((n) => n.endsWith('.mp4')) && m.some((n) => n.endsWith('.ts')), 'I1-6 remux 出同名 MP4, deleteTs=false 时 TS 保留', m.join(','))
  assert(!anyOf(dir, '.part') && !anyOf(dir, '.concat.txt'), 'I1-7 不留 .part / .concat.txt 中间产物', fs.readdirSync(dir).join(','))
  assert(!!item && item.files.length === 2 && item.files.every((f) => !SEG_RE.test(path.basename(f))), 'I1-8 库里两个文件全是"整文件形态"(对账与合并那侧不会把它们当分段)', item && JSON.stringify(item.files.map((f) => path.basename(f))))
  assert(!!item && item.bytes === world.segBytes * 2, 'I1-9 字节聚合 = TS + 同名 MP4 实长', String(item && item.bytes))

  // I2: deleteTs=true ⇒ 收尾只剩一个 <基名>.mp4 —— 与手动合并的产物同形, 库里的"整文件"判据必须命中
  await reset({ splitSeconds: 0, autoMp4: true, deleteTs: true, mergeMp4: true, mergeDeleteSegments: true })
  await recorder.start({ platform: 'pandalive', userId: 'i2', nick: 'Solo Two', title: '', auto: false })
  await recorder.stop('pandalive', 'i2')
  await waitUntil(() => recorder.list().length === 0)
  const item2 = hist().find((h) => h.userId === 'i2')
  const m2 = media(item2.dirPath)
  assert(m2.length === 1 && m2[0].endsWith('.mp4') && !SEG_RE.test(m2[0]), 'I2-1 整场录完 + 转 MP4 + 删 TS ⇒ 盘上一个文件', m2.join(','))
  // 与 src/renderer/src/utils/media.ts 的 isWholeTask 同一把尺(那个模块在渲染层, 这里按同一条正则复算)
  const whole = item2.files.length === 1 && item2.files[0].toLowerCase().endsWith('.mp4') && !/_(\d{4}|vod)\.mp4$/i.test(path.basename(item2.files[0]))
  assert(whole, 'I2-2 与合并产物同形 → 库的「整文件」判据命中(不另开一档区分来源)', JSON.stringify(item2.files.map((f) => path.basename(f))))

  // I3: 手动合并对单文件条目如实拒收, 而不是给一个"合并成功"的假动作
  world.ffCalls.length = 0
  const r = await recorder.mergeTask(item2.id)
  assert(!r.ok && r.error === 'rec.mergeFew', 'I3-1 单文件条目拒合并并给出原因', JSON.stringify(r))
  assert(world.ffCalls.length === 0, 'I3-2 拒合并不再 spawn ffmpeg')
}

console.log('\n--- J1 意外退出的判活那一发: 现拉 + 只解最高档, 且这一发就是续录的种子 ---')
{
  // autoRetryRecord 开着才走得到"种回 + 退避"那一段(默认档是关的)
  await reset({ splitSeconds: 0, autoRetryRecord: true })
  // reset 的锤子是 stopAll(), 它顺带把"退出流程"旗立起来且永不复位(生产里 stopAll 只在退程序时调);
  // 续录那一段第一件事就是问这面旗, 所以这里按生产语义把它放下 —— 否则测的是退出态
  recorder.shuttingDown = false
  await recorder.start({ platform: 'pandalive', userId: 'j1', nick: 'J1 Drop', title: '', auto: true })
  await waitUntil(() => world.ffChildren.length >= 1)
  world.playCalls.length = 0
  world.ffChildren[0].emit('exit', 137) // 不是我们 kill 的那一次退出: 全程没有 stopping=true
  await waitUntil(() => world.playCalls.length >= 1)
  const jc = world.playCalls[0]
  assert(world.playCalls.length === 1 && !jc?.probe, 'J1-1 判活只发一跳, 且走的是取源契约(不是 fetchPlay 那条没有缓存语义的裸链)')
  assert(jc?.forceFresh === true, 'J1-2 判活绝不读缓存: 缓存里装着的就是正在死的那一条')
  assert(jc?.fullVariants === false, 'J1-3 判活只解最高档: 录制用的从来只是那一路, 买整张菜单是白付 SOOP 4~8 发')
  await waitUntil(() => recorder.list().length === 0)
  const j1 = hist().find((h) => h.userId === 'j1')
  assert(world.logInfo.some((l) => l.includes('(@j1) status=error')), 'J1-4 还在播=中断, 按错误态收尾(不谎报完成)', world.logInfo.join(' | '))
  assert(!!j1, 'J1-4b 中断那一场的产物照样入库')
  assert(world.invalidated.includes('j1'), 'J1-5 错误收尾即作废旧源')
  assert(world.seeded.some((s) => s.userId === 'j1' && s.ok === true), 'J1-6 判活现拉到的新签名源随失败收尾种回续录: 新任务命中缓存即不再打第二条完整链')
  assert(world.logWarn.some((l) => l.includes('10s 后自动续录第 1 次')), 'J1-7 首次续录按退避延后, 不当场重打一条链', world.logWarn.join(' | '))
  assert(recorder.retryTimers.size === 1, 'J1-8 退避计时器按房挂键在飞')
  await recorder.stopAll()
  assert(recorder.retryTimers.size === 0, 'J1-9 退出流程清空在等退避的计时器(撤不掉的退避就是幽灵起录)')

  // J2: 真下播那一支(判活答"拉不出") —— 完成态收尾, 且那颗死源绝不许当种子
  await reset({ splitSeconds: 0, autoRetryRecord: true })
  recorder.shuttingDown = false
  await recorder.start({ platform: 'pandalive', userId: 'j2', nick: 'J2 Ended', title: '', auto: true })
  await waitUntil(() => world.ffChildren.length >= 1)
  world.play = { ok: false, m3u8: '', variants: [], dlHeaders: {}, title: '', thumbUrl: '', error: 'sim: 已下播' }
  world.playCalls.length = 0
  world.ffChildren[0].emit('exit', 0)
  await waitUntil(() => world.playCalls.length >= 1)
  await waitUntil(() => recorder.list().length === 0)
  assert(world.playCalls.length === 1 && world.playCalls[0].forceFresh === true && world.playCalls[0].fullVariants === false, 'J2-1 下播判定同样只一跳(现拉、只解最高档)')
  assert(world.seeded.length === 0, 'J2-2 真下播不留种子: 留给缓存的东西就是一个死源', JSON.stringify(world.seeded))
  assert(world.logInfo.some((l) => l.includes('(@j2) status=done')), 'J2-3 拉不出按下播论, 完成态收尾', world.logInfo.join(' | '))
  assert(recorder.retryTimers.size === 0, 'J2-4 完成态不欠一次自动续录')
  await recorder.stopAll()
}

// ============================================================================
console.log('\n■ K1 回放清单交棒: 一份正文两处用, 那份清单不再被读第二遍')
{
  await reset({ autoMp4: false })
  world.play = {
    ok: true,
    vod: true,
    m3u8: 'https://vod-cdn.invalid/master.m3u8',
    variants: [{ url: 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc' }],
    dlHeaders: {},
    title: '回放标题',
    thumbUrl: ''
  }
  world.vodPlaylist = { sec: 18, text: '#EXTM3U\n#EXT-X-TARGETDURATION:9\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:9.0,\nseg/a.ts\n#EXTINF:9.0,\nb.ts\n#EXT-X-ENDLIST\n' }
  await recorder.start({ platform: 'pandalive', userId: 'k1', nick: 'K1', title: '', auto: false })
  await waitUntil(() => world.ffChildren.length === 1)
  const t = listTask('k1')
  const dir = t.dirPath
  const vodCall = world.ffCalls.find((c) => c.kind === 'vod')
  const iArg = vodCall ? vodCall.args[vodCall.args.indexOf('-i') + 1] : ''
  assert(world.vodReads.length === 1, 'K1-1 整条开录只读了一发清单(旧写法这里是两发: 我方求和一遍 + ffmpeg 再读一遍)', `实读 ${world.vodReads.length} 发`)
  assert(world.vodReads[0] === world.play.variants[0].url, 'K1-2 那一发读的就是要交给 ffmpeg 的最高档地址, 不是 master')
  assert(t.vodTotalSec === 18, 'K1-3 进度分母取自同一份正文', `vodTotalSec=${t.vodTotalSec}`)
  const m3u8s = fs.readdirSync(dir).filter((n) => n.endsWith('.m3u8'))
  assert(m3u8s.length === 1, 'K1-4 交棒清单就落在任务目录里, 且只此一份')
  // `m3u8s.length === 1 &&` 是这一句自己的护栏: 交棒没落地的那一刀(A5-1)到这里就没有 [0] 了,
  // 直读 path.join(dir, undefined) 会把套件崩掉 —— 而下面那句注释要的正是"各报一条 FAIL, 不是崩在最后一步"
  assert(m3u8s.length === 1 && iArg === path.join(dir, m3u8s[0]), 'K1-5 交给 ffmpeg 的 -i 就是这个本地文件, 不再是那条会过期的签名 URL', `${iArg} vs ${m3u8s[0]}`)
  // 不存在时读成空串而不是抛: 交棒断了要让 K1-5/K1-7 各报一条 FAIL, 不是整个套件崩在最后一步(变异取证靠的就是这些 FAIL)
  const body = iArg && fs.existsSync(iArg) ? fs.readFileSync(iArg, 'utf-8') : ''
  assert(body.includes('https://vod-cdn.invalid/hls/seg/a.ts'), 'K1-7 段地址按清单自己的基准绝对化了(落在本地文件里它才会被解析到录制目录)')
  assert(body.includes('URI="https://vod-cdn.invalid/hls/k.bin"'), 'K1-8 密钥 URI 同样绝对化(漏了它是 ffmpeg 打开就 404, 不是"画面糊")')
  assert(body.includes('#EXTINF:9.0,') && body.includes('#EXT-X-ENDLIST'), 'K1-9 时长行与收尾标签照抄: 交棒只改地址基准, 不改媒体语义')
  assert(!/URI="k\.bin"/.test(body) && !/^seg\/a\.ts$/m.test(body), 'K1-10 相对写法在正文里一处不剩(半绝对化的清单会静默丢段)')
  assert(vodCall.args[vodCall.args.indexOf('-progress') + 1] === 'pipe:1' && vodCall.args.includes('-nostats'), 'K1-11 -nostats/-progress pipe:1 仍在原位(交棒没把时长回报换掉)')
  await waitUntil(() => (listTask('k1') || { vodDoneSec: 0 }).vodDoneSec === 12)
  assert(listTask('k1').vodDoneSec === 12, 'K1-12 伪 ffmpeg 喂的那行 out_time_ms=12000000 真被读成 12 秒(微秒口径)', `vodDoneSec=${listTask('k1').vodDoneSec}`)
  world.ffChildren[0].emit('exit', 0)
  await waitUntil(() => recorder.list().length === 0)
  assert(fs.readdirSync(dir).filter((n) => n.endsWith('.m3u8')).length === 0, 'K1-13 ffmpeg 一退出交棒清单就被删走(签名地址不留盘)')
  const item = hist().find((h) => h.userId === 'k1')
  assert(!!item && item.files.every((f) => !f.toLowerCase().endsWith('.m3u8')), 'K1-14 历史条目里没有交棒清单: 产物由 app 自己统计(statFiles 只认 .ts|.mp4), 对账不被污染')
  assert(!!item && item.files.some((f) => f.endsWith('_vod.ts')), 'K1-15 该认的产物照认: 交棒清单隐形不能把 _vod.ts 一起隐形掉(否则就是丢数据)')
  await recorder.stopAll()
}

console.log('\n■ K2 交棒不成(这一发没给出可用正文)→ 退回真 URL, 与改动前逐字同构')
{
  await reset({ autoMp4: false })
  world.play = { ok: true, vod: true, m3u8: 'https://vod-cdn.invalid/master.m3u8', variants: [{ url: 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc' }], dlHeaders: {}, title: '', thumbUrl: '' }
  world.vodPlaylist = null // 拉不到 / 风控 HTML / master 清单: fetchVodPlaylist 一律回 null
  await recorder.start({ platform: 'pandalive', userId: 'k2', nick: 'K2', title: '', auto: false })
  await waitUntil(() => world.ffChildren.length === 1)
  const vodCall = world.ffCalls.find((c) => c.kind === 'vod')
  const iArg = vodCall.args[vodCall.args.indexOf('-i') + 1]
  const dir = listTask('k2').dirPath
  assert(iArg === world.play.variants[0].url, 'K2-1 -i 退回真 URL(交棒失败的退路是今天的行为, 不是"少读一遍就完了")')
  assert(listTask('k2').vodTotalSec === 0, 'K2-2 分母保持 0 → 界面退文字而不是画 0% 空条(既有语义不动)')
  assert(fs.readdirSync(dir).every((n) => !n.endsWith('.m3u8')), 'K2-3 交棒失败不在盘上留残件')
  assert(world.vodReads.length === 1, 'K2-4 交棒失败也不多花: 仍然只有我方这一发, 第二遍照旧是 ffmpeg 自己去读')
  await recorder.stop('pandalive', 'k2')
  await waitUntil(() => recorder.list().length === 0)
}

console.log('\n■ K3 正文数得出分母、却没资格交棒(URI 写法不在处理范围)→ 分母照给, 输入退回真 URL')
{
  await reset({ autoMp4: false })
  world.play = { ok: true, vod: true, m3u8: 'https://vod-cdn.invalid/master.m3u8', variants: [{ url: 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc' }], dlHeaders: {}, title: '', thumbUrl: '' }
  world.vodPlaylist = { sec: 5, text: "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI='k.bin'\n#EXTINF:5.0,\nseg/a.ts\n#EXT-X-ENDLIST\n" }
  await recorder.start({ platform: 'pandalive', userId: 'k3', nick: 'K3', title: '', auto: false })
  await waitUntil(() => world.ffChildren.length === 1)
  const vodCall = world.ffCalls.find((c) => c.kind === 'vod')
  const dir = listTask('k3').dirPath
  assert(vodCall.args[vodCall.args.indexOf('-i') + 1] === world.play.variants[0].url, 'K3-1 单引号 URI 不猜, 整体作废交棒')
  assert(listTask('k3').vodTotalSec === 5, 'K3-2 分母与交棒是两件事: 数得出就照给 5', `vodTotalSec=${listTask('k3').vodTotalSec}`)
  assert(fs.readdirSync(dir).every((n) => !n.endsWith('.m3u8')), 'K3-3 半绝对化的清单一张都不落盘')
  await recorder.stop('pandalive', 'k3')
  await waitUntil(() => recorder.list().length === 0)
}

console.log('\n■ K4 代理那一格不被交棒带跑: 输入换成本地文件, 段却仍在 CDN 上')
{
  await reset({ autoMp4: false, proxyUrl: 'http://10.0.0.9:7899' })
  world.play = { ok: true, vod: true, m3u8: 'https://vod-cdn.invalid/master.m3u8', variants: [{ url: 'https://vod-cdn.invalid/hls/720.m3u8?sign=abc' }], dlHeaders: {}, title: '', thumbUrl: '' }
  world.vodPlaylist = { sec: 9, text: '#EXTM3U\n#EXTINF:9.0,\nseg/a.ts\n#EXT-X-ENDLIST\n' }
  await recorder.start({ platform: 'pandalive', userId: 'k4', nick: 'K4', title: '', auto: false })
  await waitUntil(() => world.ffChildren.length === 1)
  const vodCall = world.ffCalls.find((c) => c.kind === 'vod')
  const iArg = vodCall.args[vodCall.args.indexOf('-i') + 1]
  const pIdx = vodCall.args.indexOf('-http_proxy')
  assert(path.isAbsolute(iArg) && !/^https?:/.test(iArg), 'K4-1 交棒成功: -i 是本地绝对路径', iArg)
  assert(pIdx >= 0 && vodCall.args[pIdx + 1] === 'http://10.0.0.9:7899', 'K4-2 -http_proxy 照旧带着: 交棒只换清单的读法, 段还是从 CDN 取, 上游代理不能跟着丢')
  assert(vodCall.args.includes('file') || /file,http,https/.test(vodCall.args.join(' ')), 'K4-3 protocol_whitelist 里本来就有 file(否则本地清单第一步就开不了)')
  await recorder.stop('pandalive', 'k4')
  await waitUntil(() => recorder.list().length === 0)
}

console.log(`\n==== 结果: ${PASS} 通过 / ${FAIL} 失败 ====`)
if (FAIL) {
  console.log('失败项:\n - ' + fails.join('\n - '))
  process.exit(1)
}
console.log(`解读: A1/A2 PASS ⇒ remux 只以 .part 直写, 成功才改名就位; 失败的半截产物既不入库也不留盘;
      B1 PASS ⇒ concat 用 ffmpeg 词法 \\' 转义(旧 shell 惯用法让含 ' 的昵称必炸);
      B2 PASS ⇒ 合并失败不产整文件且分段零误删(原"坏包混进合并池→合并成功→删好段"数据丢失链封堵);
      C1 PASS ⇒ 拉源期停止不再留下永远打不开的空历史; D1 PASS ⇒ 对账能把历史骨架清掉且不认领他人文件;
      E1/E2 PASS ⇒ mergeTask 只认同样"非空 + 不早于任一分段"的整文件, 且成品永不进自己的输入表;
      F1 PASS ⇒ 房间寻址与落盘名只接受可寻址字符(渲染层被注入也无法拼出穿越路径);
      G1~G4 PASS ⇒ 本地代理只服务本实例签发过且带令牌的地址, 签发表有上限;
      H1 PASS ⇒ 无系统密钥的明文降级由 degraded 说出来并落日志, 不再只躺在 console.warn 里;
      K1 PASS ⇒ 回放那份清单只读一遍: 同一份正文既出错长分母又交棒给 ffmpeg(段与密钥地址按原基准绝对化), 退出即删;
      K2/K3 PASS ⇒ 交棒失败(没有正文 / URI 不认)退回真 URL 且不落残件 —— 省这一发的代价不能由产物来付.`)
console.log(`临时目录: ${TMP}`)
process.exit(0)
