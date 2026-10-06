// ============================================================================
// 验证脚本: 卡片图的本机缓存 —— src/main/services/imgCache.ts + src/shared/imgUrl.ts
//
// 背景(两条独立实测, 结论同): liveimg.sooplive.com 的卡片图一个缓存指示头都没有,
//   stimg.sooplive.com 的头像只给 Cache-Control: max-age=60(连 404 都带这一句),
//   普查那 1400 秒里这两域共 42 个路径各留下 2 发(合计 83 发)—— 那"各 2 发"是下面说的键把 query 抹平的结果, 不是同一件东西被问了两遍。
//   同窗口 Panda 的 CDN 是 27 个 URL 各 1 发 —— Chromium 本来就命中, 这一格不碰它。
//   "每切一次工作区全量重打一遍"这一笔真机探针判得不成立: 普查的计数键把 query 抹掉了(host+pathname, 整份
//   jsonl 里 '?' 出现 0 次) ⇒ 平台每轮换的版本号被合并成"同一条问了两次"; 真机两次切墙读到 hit=0 / merged=0,
//   34 发就是渲染层问出来的不同地址数 —— 省发未实拍, 撤不撤留给下一轮判(读数细节在 imgCache.ts 文件头)。
// 这一层的取舍全部站在读数上, 本脚本就是逐条钉住它们:
//   · 键 = 纯数字 query 抹掉、其余整条地址(T2, ② 改判): 那句「query 是平台给这张图的版本号,
//     抹平它就是卡片停在上一帧」被 /两次实拍推翻 —— liveimg 那枚 ?<数字> 28 间在播共用同一个值(全局计数),
//     同一张图在 3.0 秒内两问字节逐字节相同; 而真正会让卡片换帧的是路径本身 + 到点重取那两件事。
//     ⇒ 只把 `?<纯数字>` 这一种形状按 pathname 认身份, 其余 query 一字不动;
//     稳态每轮那一发照发(轮距 63.6s > TTL 60s), 这一格消灭的只有冷启动同一拍里的第二问;
//   · TTL 60 秒 = 两域各自说话的那个数 ⇒ 到点就问, 问法与今天一字不差: 这一格只消灭"同一件东西被问两遍"(T4);
//   · 到点重取而那一发失败时, 手里那份旧图不许跟着一起没(T5, 判据是"读不到 ≠ 判死");
//   · 404 是答案不是事故: 短账只挡同一瞬的重复, 且照旧如实回 404 让渲染层的兜底顶上(T6);
//   · 失败分两种: 超时/5xx/非图是"我方这一发没成", 手里没旧图时一律不留账 —— 真机第一次取证就是栽在给打嗝留了
//     15 秒账上(冷启动 9 秒停顿 ⇒ 18 发整批掐在 8 秒上限 ⇒ 首面卡片整轮空白), 见 T8-2/T8-4/T12;
//   · plocal://img/ 的载荷是渲染层递进来的字符串 ⇒ 域白名单/https/无账号无端口在解回来那一趟再判一遍(T7);
//   · 取法跟着「设置-代理」: 走 persist:pl 那条 session, 换到主进程不许悄悄绕成直连(T3b)。
// 方法: imgCache 与 shared/imgUrl 挂真源码(sucrase 现编译); electron 的 session.fetch / net.fetch 换成
//   可计数的替身 —— 一发有没有真出去由这张表说, 不由日志猜。
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0
let FAIL = 0
function assert(name, cond, detail = '') {
  if (cond) PASS++
  else FAIL++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 替身网络 ----------
const world = {
  sends: [],
  // url -> {status, type, bytes} 或 'throw'; 没摆的那一条 = 平台照旧给一张真图
  table: {},
  seq: 0,
  delayMs: 0,
  // 哪一条通道取到的: session.fetch(跟着设置-代理) vs net.fetch(默认 session)
  via: []
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function replyFor(url) {
  const t = world.table[url]
  if (t === 'throw') throw new Error('sim: 取图通道断了')
  if (t) return { status: t.status, type: t.type, bytes: t.bytes }
  world.seq++
  return { status: 200, type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, world.seq % 253, world.seq % 251]) }
}

async function fakeFetch(url, init) {
  const u = String(url)
  world.sends.push(u)
  world.via.push(init && init.__via ? init.__via : 'net')
  const headers = init && init.headers ? init.headers : {}
  if (!headers['User-Agent']) throw new Error('sim: 取图没带 UA(与全应用同一枚指纹这一条要守住)')
  if (world.delayMs) await sleep(world.delayMs)
  const r = replyFor(u)
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? r.type : null) },
    arrayBuffer: async () => r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength),
    text: async () => 'body'
  }
}

const seenPartitions = []
const mocks = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session: {
      fromPartition: (p) => {
        seenPartitions.push(p)
        return { fetch: (u, i) => fakeFetch(u, { ...(i || {}), __via: 'session' }), setProxy: async () => {}, setUserAgent() {} }
      }
    },
    // net.fetch 这一支单独标记: 走成它就意味着绕开了「设置-代理」
    net: { fetch: (u, i) => fakeFetch(u, { ...(i || {}), __via: 'net' }) }
  },
  '../util': { UA: 'verify-script', sleep },
  './logger': {
    logger: { info: (t, m) => world.logs.push(['info', t, String(m)]), warn: (t, m) => world.logs.push(['warn', t, String(m)]) }
  },
  // 本脚本不测 pandalive: 只要 SESSION_PARTITION 这一格是真常量, 通道归属就测得动
  './pandalive': { SESSION_PARTITION: 'persist:pl' }
}
world.logs = []

const cache = new Map()
function loadTs(rel) {
  if (cache.has(rel)) return cache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  cache.set(rel, m)
  const localRequire = (id) => {
    if (id in mocks) return mocks[id]
    if (id === '../../shared/imgUrl') return loadTs('src/shared/imgUrl.ts')
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const { imgCache } = loadTs('src/main/services/imgCache.ts')
const { imgSrc, imgCacheable, parseImgSrc, IMG_CACHE_HOSTS } = loadTs('src/shared/imgUrl.ts')

const LI = 'https://liveimg.sooplive.com/m/100000005'
const ST = 'https://stimg.sooplive.com/LOGO/10/10000042/10000042.jpg'
const reset = () => {
  imgCache.store.clear()
  imgCache.inflight.clear()
  imgCache.bytes = 0
  world.sends.length = 0
  world.via.length = 0
  world.logs.length = 0
  world.table = {}
  world.delayMs = 0
  world.seq = 0
  imgCache.stat = { hit: 0, miss: 0, send: 0, merged: 0, fail: 0, refused: 0 }
}
const ask = (u) => imgCache.handle(imgSrc(u))
const age = (u, by) => {
  const e = imgCache.store.get(u)
  if (e) e.exp -= by
  return Boolean(e)
}

// ---------- T1 一发都不许多: 同一地址在 TTL 内只问一次 ----------
console.log('\n■ T1 命中不发, 未命中恰好一发')
{
  reset()
  const r1 = await ask(LI)
  const r2 = await ask(LI)
  assert('T1-1 第一发真出去了一发', world.sends.length === 1, `实发=${world.sends.length}`)
  assert('T1-2 第二次问命中本机, 一发都没再出', world.sends.length === 1 && imgCache.stats().hit === 1, `发数=${world.sends.length} hit=${imgCache.stats().hit}`)
  assert('T1-3 两次都回 200 且带着真的 content-type', r1.status === 200 && r2.status === 200 && r2.headers.get('content-type') === 'image/jpeg', r2.headers.get('content-type'))
  assert('T1-4 回的是字节而不是文本(渲染层那枚 <img> 只吃图)', r2.body !== null)
  assert('T1-5 取图通道 = persist:pl(跟着「设置-代理」, 不许悄悄绕成直连)', world.via.join(',') === 'session' && seenPartitions.includes('persist:pl'), world.via.join(',') + '|' + seenPartitions.join(','))
  const s = imgCache.stats()
  assert('T1-6 账目自证: 问两次 = 一次命中 + 一次未命中, 真发的就是那一发', s.hit + s.miss === 2 && s.send === s.miss, JSON.stringify(s))
}

// ---------- T2 键归一: 纯数字 query 是上游的全局计数, 不是这张图的身份 ----------
console.log('\n■ T2 liveimg 的 ?<纯数字> 按 pathname 认身份; 其它 query 与头像那域一字不动')
{
  reset()
  await ask(LI + '?29851721')
  await ask(LI + '?29851761') // 实测: 同一份 jsonl 里 28 间在播共用同一枚数(逐轮整表 +1), 3.0 秒两问字节相同
  assert('T2-1 同一路径换了一个纯数字 query = 仍是同一张图(冷启动 20 路径各 2 发那一格就在这儿收掉)', world.sends.length === 1, `实发=${world.sends.length}`)
  assert('T2-2 合并的只是键: 真出去的那一发用的仍是带 query 的原地址(取法一字不改)', world.sends[0] === new URL(LI + '?29851721').toString(), world.sends[0])
  assert('T2-3 账上落的是去掉计数那把键', imgCache.store.size === 1 && imgCache.store.has(new URL(LI).toString()), `keys=${[...imgCache.store.keys()].join(',')}`)
  const n = world.sends.length
  await ask(LI) // 无 query 的同一条 = 同一格(证明键不是"前缀相同"而是真同一把)
  assert('T2-4 带计数与不带计数是同一格, 不再补一发', world.sends.length === n && imgCache.stats().miss === 1, `发数=${world.sends.length} miss=${imgCache.stats().miss}`)

  reset()
  await ask(LI + '?a=1')
  await ask(LI + '?a=2')
  assert('T2-5 不合这一种的 query 一律不抹(?a=1 与 ?a=2 是两张图, 抹了就停帧)', world.sends.length === 2 && imgCache.store.size === 2, `发数=${world.sends.length} 键数=${imgCache.store.size}`)
  assert('T2-6 键留着整条地址(含 query)', imgCache.store.has(new URL(LI + '?a=2').toString()), `keys=${[...imgCache.store.keys()].join(',')}`)
  reset()
  await ask(LI + '?29851721&t=1')
  await ask(LI + '?29851721&t=2')
  assert('T2-7 数字打头但后面还有参数的不算计数(那是两种东西, 不合并)', world.sends.length === 2, `实发=${world.sends.length}`)

  reset()
  await ask(ST)
  await ask(ST)
  assert('T2-8 头像那域实测不带 query, 同址两问 = 一发(键归一这一步对它毫无影响)', !ST.includes('?') && world.sends.length === 1, `实发=${world.sends.length}`)
  assert('T2-9 两问用的是同一把键, 不是前缀相同的那两把', imgCache.store.size === 1 && imgCache.store.has(new URL(ST).toString()), `keys=${[...imgCache.store.keys()].join(',')}`)

  reset() // 稳态那一发不许被这一格省掉: 轮距(63.6s) > TTL(60s) ⇒ 到点仍问, 只是问的时候不再带两把键
  await ask(LI + '?29851721')
  age(new URL(LI).toString(), 61_000)
  await ask(LI + '?29851761')
  assert('T2-10 换轮之后(计数 +1 且 TTL 已过)照旧真问一发 —— 这一格省的是重复, 不是该新的那一次', world.sends.length === 2, `实发=${world.sends.length}`)
}

// ---------- T3 同一瞬的并发合并 ----------
console.log('\n■ T3 一整面卡片同时问同一个地址: 一发')
{
  reset()
  world.delayMs = 20
  const rs = await Promise.all([ask(LI), ask(LI), ask(LI), ask(LI)])
  assert('T3-1 四问一发(合并的是问, 不是等)', world.sends.length === 1, `实发=${world.sends.length}`)
  assert('T3-2 四问全部拿到 200', rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','))
  const s = imgCache.stats()
  assert('T3-3 合并数如实记账(send 1 / merged 3)', s.send === 1 && s.merged === 3, JSON.stringify(s))
  assert('T3-4 落定之后在飞表是空的(不许留第二条在飞锁)', imgCache.inflight.size === 0, `size=${imgCache.inflight.size}`)
}

// ---------- T3b 通道归属 ----------
console.log('\n■ T3b 取图走的是本窗口的 session, session 不可用才回落 net.fetch')
{
  reset()
  const ses = mocks.electron.session
  mocks.electron.session = { fromPartition: () => ({ setProxy: async () => {} }) }
  await ask(ST)
  assert('T3b-1 session 没有 fetch 时回落 net.fetch 并且仍取到图', world.sends.length === 1 && world.via.join(',') === 'net', world.via.join(','))
  mocks.electron.session = ses
}

// ---------- T4 TTL: 到点就问, 这一格不替平台少问一次 ----------
console.log('\n■ T4 到点重取(实测两域各说 60 秒 ⇒ 只消灭重复, 不消灭该问的那一遍)')
{
  reset()
  await ask(LI)
  const old = imgCache.store.get(LI).bytes
  const oldRef = imgCache.store.get(LI)
  age(LI, 61_000)
  await ask(LI)
  assert('T4-1 过期之后照旧真问一发', world.sends.length === 2, `实发=${world.sends.length}`)
  assert('T4-2 没过期时问过就完事(TTL 之内零发)', (await ask(LI), world.sends.length === 2), `实发=${world.sends.length}`)
  assert('T4-3 重取回来的新字节替换了旧那一份(卡片跟着换)', imgCache.store.get(LI).bytes !== old && imgCache.store.get(LI) !== oldRef, `旧=${[...old].join(',')} 新=${[...imgCache.store.get(LI).bytes].join(',')}`)
}

// ---------- T5 到点重取失败: 不许把还能看的那份一起带走 ----------
console.log('\n■ T5 重取失败时留着旧图(与 「读不到 ≠ 判死」同规约)')
{
  reset()
  await ask(LI)
  const old = imgCache.store.get(LI).bytes
  age(LI, 61_000)
  world.table[LI] = 'throw'
  const r = await ask(LI)
  assert('T5-1 那一发真出过且失败了', world.sends.length === 2 && imgCache.stats().fail === 1, `发数=${world.sends.length} fail=${imgCache.stats().fail}`)
  assert('T5-2 卡片照旧有图: 回的是手里那一份 200', r.status === 200 && imgCache.store.get(LI).bytes === old, String(r.status))
  const left = imgCache.store.get(LI).exp - Date.now()
  assert('T5-3 失败只推到一个短账之后(≤15 秒), 不是记满 60 秒 TTL', left > 0 && left <= 15_000, `还剩 ${left}ms`)
  const n = world.sends.length
  await ask(LI)
  assert('T5-4 短账之内不再重打(同一件坏消息只问一遍)', world.sends.length === n && imgCache.stats().hit === 1, `新增=${world.sends.length - n}`)
  age(LI, 20_000)
  await ask(LI)
  assert('T5-5 短账到点照旧再问一发(坏消息不许留成永久)', world.sends.length === n + 1, `实发=${world.sends.length}`)
  assert('T5-6 通道断掉这一种在日志里说话(与 404 那种正常答案分开)', world.logs.some((l) => l[0] === 'warn' && l[2].includes('取图失败')), JSON.stringify(world.logs.map((l) => l[2].slice(0, 24))))
}

// ---------- T6 404 是答案 ----------
console.log('\n■ T6 没传过头像的房: 404 如实回 404, 但只短记一笔')
{
  reset()
  world.table[ST] = { status: 404, type: 'text/html', bytes: new Uint8Array([1, 2, 3]) }
  const r1 = await ask(ST)
  const n = world.sends.length
  const r2 = await ask(ST)
  assert('T6-1 一发问、一发不问(实测: 404 也带 max-age=60, 每次都问就是白问)', n === 1 && world.sends.length === 1, `实发=${world.sends.length}`)
  assert('T6-2 两次都回 404 —— 渲染层那句「没有头像」靠的就是这个错误事件', r1.status === 404 && r2.status === 404, `${r1.status}/${r2.status}`)
  // 读法要经得住"账上压根没这一格"这一种形状(它现在是合法答案了): 直读 .bytes 会把套件跑崩而不是报 FAIL
  assert('T6-3 失败那一格不带字节(账上就是一个答案, 不是一张图)', Boolean(imgCache.store.get(ST)) && !imgCache.store.get(ST).bytes, String(imgCache.store.get(ST)))
  assert('T6-4 正常答案不刷屏: 404 只记账, 不在日志里每次留一行', imgCache.stats().fail === 1 && !world.logs.some((l) => l[0] === 'warn'), JSON.stringify(world.logs.map((l) => l[2].slice(0, 20))))
  const m = world.sends.length
  age(ST, 20_000)
  await ask(ST)
  assert('T6-5 短账到点会再问一遍 —— 刚传上来的头像不会永远卡在「没有」', world.sends.length === m + 1, `实发=${world.sends.length}`)
}

// ---------- T7 安全边界: 载荷是渲染层递进来的字符串 ----------
console.log('\n■ T7 plocal://img/ 解回来那一趟的白名单(少判一项就是后门)')
{
  reset()
  // 绕过 imgSrc 直接构造载荷: 这一支的输入是渲染层给的字符串, 不能假设它先过 imgCacheable
  const enc = (s) => 'plocal://img/' + Buffer.from(s, 'utf8').toString('base64url')
  const evil = ['https://evil.invalid/LOGO/a.jpg', 'http://liveimg.sooplive.com/a.jpg', 'https://liveimg.sooplive.com:8443/a.jpg', 'https://user:[email protected]/a.jpg', 'https://liveimg.sooplive.com.evil.invalid/a.jpg']
  const codes = []
  for (const u of evil) codes.push((await imgCache.handle(enc(u))).status)
  assert('T7-1 白名单外的域一律 403 且一发都不出', world.sends.length === 0, `实发=${world.sends.length}`)
  assert('T7-2 http/带端口/带账号/域名字符后缀骗局同样拒(只认 https 无账号无端口且域全等)', codes.every((c) => c === 403), codes.join(','))
  assert('T7-3 拒的一格在账上说话(refused 计数)', imgCache.stats().refused === evil.length, `refused=${imgCache.stats().refused}`)
  assert('T7-4 编码坏了/空载荷/超长载荷同样拒, 不拿去 parse', (await imgCache.handle('plocal://img/@@not-base64@@')).status === 403 && (await imgCache.handle('plocal://img/')).status === 403 && (await imgCache.handle('plocal://img/' + 'A'.repeat(1200))).status === 403)
  assert('T7-5 parseImgSrc 只吃这一支前缀(plocal://file/… 不许误进这一层)', parseImgSrc('plocal://file/abc') === '' && parseImgSrc('') === '')
  assert('T7-6 域名清单就是实测那两域, 一条不多一条不少', IMG_CACHE_HOSTS.join(',') === 'liveimg.sooplive.com,stimg.sooplive.com', IMG_CACHE_HOSTS.join(','))
  assert('T7-7 拒收也在日志里留痕(取证时看得见谁往协议里塞过东西)', world.logs.filter((l) => l[0] === 'warn' && l[2].includes('拒绝取图')).length >= evil.length, `条数=${world.logs.length}`)
}

// ---------- T8 只收图 ----------
console.log('\n■ T8 200 但不是图: 不当图收(反代劫持页/HTML 错误页)')
{
  reset()
  world.table[LI] = { status: 200, type: 'text/html', bytes: new Uint8Array([60, 104, 116, 109, 108]) }
  const r = await ask(LI)
  assert('T8-1 回 502 而不是把那页当图喂给 <img>', r.status === 502, String(r.status))
  assert('T8-2 非图不留账: 它是"我方这一发没成", 不是官方给的答(见 T12)', imgCache.store.get(LI) === undefined, String(imgCache.store.get(LI)))
  assert('T8-3 失败计数说了话', imgCache.stats().fail === 1, `fail=${imgCache.stats().fail}`)
  await ask(LI)
  assert('T8-4 不留账的代价就是下一次重渲染再问一发(该问的照问)', world.sends.length === 2, `实发=${world.sends.length}`)
}

// ---------- T9 预算 ----------
console.log('\n■ T9 预算: 张数与字节都有顶, 淘汰按插入顺序')
{
  reset()
  for (let i = 0; i < 320; i++) await ask(`https://liveimg.sooplive.com/m/${1000 + i}`)
  const s = imgCache.stats()
  assert('T9-1 条目数不越过上限', s.entries <= 300, `entries=${s.entries}`)
  assert('T9-2 最老那一批已被剪掉, 最后问的那一张还在', !imgCache.store.has('https://liveimg.sooplive.com/m/1000') && imgCache.store.has('https://liveimg.sooplive.com/m/1319'))
  // 大图: 一枚 9MB 的头像连着来三枚, 预算按字节剪而不是按张数
  reset()
  const big = new Uint8Array(9 * 1024 * 1024)
  for (let i = 0; i < 3; i++) world.table[`https://stimg.sooplive.com/LOGO/a${i}/a${i}.jpg`] = { status: 200, type: 'image/jpeg', bytes: big }
  for (let i = 0; i < 3; i++) await ask(`https://stimg.sooplive.com/LOGO/a${i}/a${i}.jpg`)
  const s2 = imgCache.stats()
  assert('T9-3 字节预算真在剪(24MB 上限内)', s2.bytes <= 24 * 1024 * 1024 && s2.entries === 2, `bytes=${s2.bytes} entries=${s2.entries}`)
  assert('T9-4 剪的是最老的, 留的是刚问过的', !imgCache.store.has('https://stimg.sooplive.com/LOGO/a0/a0.jpg') && imgCache.store.has('https://stimg.sooplive.com/LOGO/a2/a2.jpg'))
}

// ---------- T10 命中也要把这一格挪到队尾 ----------
console.log('\n■ T10 刚被要过的图不许先被剪(LRU 而不是 FIFO)')
{
  reset()
  const a = 'https://liveimg.sooplive.com/m/2000'
  const big = new Uint8Array(9 * 1024 * 1024)
  for (let i = 0; i < 3; i++) world.table[`https://stimg.sooplive.com/LOGO/b${i}/b${i}.jpg`] = { status: 200, type: 'image/jpeg', bytes: big }
  await ask(a) // 写入顺序: a 最先
  await ask('https://stimg.sooplive.com/LOGO/b0/b0.jpg')
  await ask('https://stimg.sooplive.com/LOGO/b1/b1.jpg')
  await ask(a) // 命中一次: 把 a 挪到队尾
  await ask('https://stimg.sooplive.com/LOGO/b2/b2.jpg') // 27MB > 24MB ⇒ 必须剪掉一格
  assert('T10-1 剪的是「再没被要过」的 b0, 而不是写入更早但刚被命中的 a', !imgCache.store.has('https://stimg.sooplive.com/LOGO/b0/b0.jpg') && imgCache.store.has(a), `留下=${[...imgCache.store.keys()].map((k) => k.slice(-6)).join(',')}`)
  assert('T10-2 预算仍在上限内', imgCache.stats().bytes <= 24 * 1024 * 1024, `bytes=${imgCache.stats().bytes}`)
  assert('T10-3 剪完剩下 b1/b2/a 三格, 该留的一张没少', imgCache.store.size === 3, `entries=${imgCache.store.size}`)
}

// ---------- T11 地址翻译(渲染层那一侧的纯函数) ----------
console.log('\n■ T11 地址翻译: 该翻的翻, 别的一字不动')
{
  assert('T11-1 两域翻成 plocal://img/', imgSrc(LI).startsWith('plocal://img/') && imgSrc(ST).startsWith('plocal://img/'))
  assert('T11-2 别的域原样返回(Panda CDN 与 res.sooplive.com 都不关这一格的事)', imgSrc('https://cdn.pandalive.co.kr/a.jpg') === 'https://cdn.pandalive.co.kr/a.jpg' && imgSrc('https://res.sooplive.com/images/webplayer/blind_background.svg') === 'https://res.sooplive.com/images/webplayer/blind_background.svg')
  assert('T11-3 空串与相对地址原样返回(调用方那句 v-if 的判据不变)', imgSrc('') === '' && imgSrc('//liveimg.sooplive.com/m/1') === '//liveimg.sooplive.com/m/1')
  assert('T11-4 翻出去还能解回来, 解出来的是同一条地址', parseImgSrc(imgSrc(LI + '?945')) === new URL(LI + '?945').toString(), parseImgSrc(imgSrc(LI + '?945')))
  assert('T11-5 imgCacheable 与 imgSrc 同一把尺(两处判断不许分叉)', imgCacheable(LI) === true && imgCacheable('https://evil.invalid/a.jpg') === false && imgCacheable('http://liveimg.sooplive.com/a.jpg') === false)
  assert('T11-6 中文/空格这类字符能过编码这一趟', parseImgSrc(imgSrc('https://stimg.sooplive.com/LOGO/10/主播 名/主播 名.jpg')) !== '')
}

// ---------- T12 真机第一次取证改判的那一格: 失败分两种, 只有一种配留账 ----------
console.log('\n■ T12 「我方没成」那一发不留账(实测: 留了就把一次冷启动打嗝画成整轮空白)')
{
  reset()
  world.table[LI] = 'throw'
  const r1 = await ask(LI)
  assert('T12-1 通道断掉那一发如实回 502(不冒充成功)', r1.status === 502, String(r1.status))
  assert('T12-2 手里没图时账上不留这一格', imgCache.store.get(LI) === undefined, JSON.stringify(imgCache.store.get(LI)))
  assert('T12-3 不留账 ≠ 没发生: 失败计数照旧说话', imgCache.stats().fail === 1, `fail=${imgCache.stats().fail}`)
  const n = world.sends.length
  await ask(LI)
  assert('T12-4 下一次重渲染照问那一发: 空白只挂到下一次渲染, 不挂满 15 秒', world.sends.length === n + 1, `新增=${world.sends.length - n}`)

  // 404 那一格仍配留账 —— T6 的答案面不许被这一笔带崩
  reset()
  world.table[ST] = { status: 404, type: 'text/html', bytes: new Uint8Array([1]) }
  await ask(ST)
  const m = world.sends.length
  await ask(ST)
  assert('T12-5 404 照旧只问一遍(官方那句「没有」是答案, 短账留着)', world.sends.length === m && imgCache.store.has(ST) && !imgCache.store.get(ST).bytes, `新增=${world.sends.length - m}`)

  // 手里有旧图那一档不受这一笔影响: 停在上一帧, 短账之内不重打
  reset()
  await ask(LI)
  const old = imgCache.store.get(LI).bytes
  age(LI, 61_000)
  world.table[LI] = 'throw'
  const r2 = await ask(LI)
  assert('T12-6 有旧图: 回的还是那一份 200, 卡片停在上一帧而不是变破图', r2.status === 200 && imgCache.store.get(LI).bytes === old, String(r2.status))
  const k = world.sends.length
  await ask(LI)
  assert('T12-7 有旧图那一档照旧留短账(同一件坏消息只问一遍)', world.sends.length === k, `新增=${world.sends.length - k}`)
}

console.log(`\n通过 ${PASS} / 失败 ${FAIL}`)
if (FAIL) process.exit(1)
