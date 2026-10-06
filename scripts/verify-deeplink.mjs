// ============================================================================
// 验证脚本: 一期路由(平台为一级 /:plat/live|recordings + 全部旧深链重定向 + D5 默认工作区)
//
// 方法: 读真实 src/renderer/src/router.ts 源码, 只做三处手术式替换后在 Node 里实例化真 vue-router:
//       createWebHashHistory() → createMemoryHistory()(无 window)、组件懒加载换成桩对象、
//       ./workspace 与 @shared/types 走 sucrase 现编译(与 verify-follows 同一套路)。
//       替的是渲染依赖, 不是路由表本身 —— 表一改, 断言就跟着变, 抄一份表就验不到东西了。
// 场景:
//   A 新路由表: 六个具名页齐备(含不分平台的诊断台),:plat 段带正则约束
//   B  旧深链一期全兼容: #/explore · #/monitor · #/recordings · #/library · #/player/<id>
//      (库已并入录制页: #/library 与 #/:plat/library 都必须落到录制页, 而不是 404)
//   C  D5 默认工作区: 恒平台 > 上次离开 > 默认平台(冷启动第一次导航就要算出落点)
//   D  离开哪个工作区记哪个(afterEach), 非平台页不参与(设置页与诊断台都不写)
//   E  非法平台段与未知地址: 一律归位到有效页, 不停在空白页(改路由最大的一条风险)
//   F  深链查询串透传: view/kw/sec 不丢
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
const fails = []
function assert(cond, name, detail = '') {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    fails.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------- TS 模块现编译(与 verify-follows 同一套路) ----------
// rel 一律用 posix 相对 ROOT 的路径; id 解析要认 tsconfig 的两个别名, 否则 workspace.ts 的
// '@shared/types' 会被当成 npm 包去 require 而炸在加载期。
function resolveTsId(id, fromRel) {
  if (id.startsWith('@shared/')) return 'src/shared/' + id.slice('@shared/'.length) + '.ts'
  if (id.startsWith('@/')) return 'src/renderer/src/' + id.slice(2) + '.ts'
  if (id.startsWith('.')) return path.posix.join(path.posix.dirname(fromRel), id) + '.ts'
  return null
}

function loadTs(rel) {
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf-8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    m.exports,
    (id) => {
      const next = resolveTsId(id, rel)
      return next ? loadTs(next) : require(id)
    },
    m,
    file,
    path.dirname(file)
  )
  return m.exports
}

const types = loadTs('src/shared/types.ts')
const typesDefault = types.default ?? types

// ---------- localStorage 替身(workspace.ts 读它) ----------
const jar = new Map()
globalThis.localStorage = {
  getItem: (k) => (jar.has(k) ? jar.get(k) : null),
  setItem: (k, v) => jar.set(k, String(v)),
  removeItem: (k) => jar.delete(k),
  clear: () => jar.clear()
}
const PREF = 'pl-workspace-pref'
const LAST = 'pl-workspace-last'
function reset(pref, last) {
  jar.clear()
  if (pref) jar.set(PREF, pref)
  if (last) jar.set(LAST, last)
}

// ---------- 真路由表(只替渲染依赖) ----------
function makeRouter() {
  const srcFile = path.join(ROOT, 'src/renderer/src/router.ts')
  const ws = loadTs('src/renderer/src/workspace.ts')
  const vr = require('vue-router')
  const stub = { name: 'StubView', render: () => null }

  // 先脱 TS 类型标注(new Function 只吃 JS), 再摘掉 import 语句由参数注入, 组件懒加载换桩, hash 历史换 memory 历史
  let src = transform(fs.readFileSync(srcFile, 'utf-8'), { transforms: ['typescript'], filePath: srcFile }).code
  src = src
    .replace(/import\s*\{[^}]*\}\s*from\s*'[^']*'/g, '')
    .replace(/component:\s*\(\)\s*=>\s*import\([^)]*\)/g, 'component: STUB')
    .replace(/createWebHashHistory\(\)/g, 'createMemoryHistory()')
    .replace(/export const router =/, 'const router =')

  const fn = new Function(
    'createRouter',
    'createMemoryHistory',
    'DEFAULT_PLATFORM',
    'noteWorkspace',
    'resolveWorkspace',
    'STUB',
    src + '\nreturn router'
  )
  return { router: fn(vr.createRouter, vr.createMemoryHistory, typesDefault.DEFAULT_PLATFORM, ws.noteWorkspace, ws.resolveWorkspace, stub) }
}

const { router } = makeRouter()

async function resolve(from) {
  await router.replace(from).catch(() => {})
  const r = router.currentRoute.value
  return { name: r.name, plat: r.params.plat, userId: r.params.userId, view: r.query.view, kw: r.query.kw, sec: r.query.sec, path: r.path }
}

// ============ A 新路由表 ============
console.log('A 新路由表: 平台为一级')
{
  const names = router.getRoutes().map((r) => r.name).filter(Boolean)
  assert(
    ['live', 'recordings', 'player', 'account', 'settings', 'diag'].every((n) => names.includes(n)),
    '六个具名页齐备(库不是页, 是录制页里的一段)',
    names.join(',')
  )
  assert(!names.includes('library'), '路由表里没有 library 具名页', names.join(','))
  // 诊断台: 第三个 tab, 但它不是平台页
  assert(names.includes('diag'), '诊断台在路由表里(顶栏第三条 tab 有落点)', names.join(','))
  const diag = router.getRoutes().find((r) => r.name === 'diag')
  assert(/^\/diag$/.test(diag.path), '诊断台的路径就是 /diag, 不带 :plat 段(它同时看两边)', diag.path)
  const live = router.getRoutes().find((r) => r.name === 'live')
  assert(live.path.includes(':plat(pandalive|soop)'), ':plat 段带正则约束(非法值不会渲染半个 Panda 页)', live.path)
  const player = router.getRoutes().find((r) => r.name === 'player')
  assert(/^\/player\/:plat\(pandalive\|soop\)\/:userId$/.test(player.path), '播放页平台段在前、房间号在后', player.path)
  reset(null, null)
  const a = await resolve('/pandalive/live')
  const b = await resolve('/soop/recordings')
  assert(a.name === 'live' && a.plat === 'pandalive', '#/pandalive/live 落 Panda 直播')
  assert(b.name === 'recordings' && b.plat === 'soop', '#/soop/recordings 落 SOOP 录制页(库随 :plat 段筛)')
}

// ============ B 旧深链兼容 ============
console.log('B 旧深链: 一期必须全部落到有效页')
{
  reset(null, null)
  const e = await resolve('/explore')
  assert(e.name === 'live' && e.view === 'discover', '#/explore → 直播页 · 发现视图', `${e.path}?view=${e.view}`)
  const m = await resolve('/monitor')
  assert(m.name === 'live' && m.view === 'live', '#/monitor → 直播页 · 在播视图', `${m.path}?view=${m.view}`)
  const r = await resolve('/recordings')
  assert(r.name === 'recordings' && r.plat === 'pandalive', '#/recordings → 默认工作区的录制页', r.path)
  const l = await resolve('/library')
  assert(l.name === 'recordings' && l.plat === 'pandalive', '#/library → 默认工作区的录制页(库已并入)', l.path)
  const lb = await resolve('/soop/library')
  assert(lb.name === 'recordings' && lb.plat === 'soop', '#/soop/library → SOOP 录制页, 平台段不丢', lb.path)
  const p = await resolve('/player/lck_kr')
  assert(p.name === 'player' && p.plat === 'pandalive' && p.userId === 'lck_kr', '#/player/<id> 补默认平台段', p.path)
}

// ============ C D5 默认工作区 ============
console.log('C 启动默认工作区: 恒平台 > 上次离开 > 默认平台')
{
  reset('soop', 'pandalive')
  assert(await resolve('/').then((x) => x.plat === 'soop' && x.name === 'live'), '恒定项压过上次离开(恒 SOOP 仍落 SOOP)')
  reset('remember', 'soop')
  assert((await resolve('/')).plat === 'soop', 'remember + 上次在 SOOP → 落 SOOP')
  reset('remember', null)
  assert((await resolve('/')).plat === 'pandalive', '什么都没有 → 回落默认平台')
  reset('soop', null)
  assert((await resolve('/explore')).plat === 'soop', '旧深链也走同一套落点规则, 不硬编码 Panda')
}

// ============ D 记住最后所在工作区 ============
console.log('D afterEach 记忆: 只有平台页参与')
{
  reset(null, null)
  await resolve('/soop/recordings')
  assert(jar.get(LAST) === 'soop', '进 SOOP 录制页 → 记住 SOOP')
  await resolve('/pandalive/library')
  assert(jar.get(LAST) === 'pandalive', '旧库深链落到 Panda 录制页 → 同样记住 Panda', jar.get(LAST))
  await resolve('/settings')
  assert(jar.get(LAST) === 'pandalive', '设置页(无平台段)不覆盖记忆')
  // 诊断台是第二个"同时看两边"的页 —— 它也不许写记忆, 否则从诊断台回冷启动会莫名其妙换平台
  await resolve('/diag')
  assert(jar.get(LAST) === 'pandalive', '诊断台(无平台段)不覆盖记忆', String(jar.get(LAST)))
  assert((await resolve('/')).plat === 'pandalive', '下一次冷启动落在记住的工作区')
}

// ============ E 非法地址归位 ============
console.log('E 非法平台段 / 未知地址: 不得停在空白页')
{
  reset('soop', null)
  const bad = await resolve('/www/live')
  assert(bad.name === 'live' && bad.plat === 'soop', '#/www/live 落默认工作区直播页', `${bad.path} (${bad.name})`)
  const unknown = await resolve('/totally/unknown/path')
  assert(unknown.name === 'live', '未知地址由 catch-all 兜住', `${unknown.path} (${unknown.name})`)
  const two = await resolve('/player/pandalive')
  assert(two.name === 'player' && two.userId === 'pandalive', '只有一段时按旧链接解释成 userId, 不落空白页', `${two.path} (${two.name})`)
}

// ============ F 查询串透传 ============
console.log('F 深链参数不丢')
{
  reset(null, null)
  const q = await resolve('/monitor?kw=zenith')
  assert(q.view === 'live' && q.kw === 'zenith', '#/monitor?kw=zenith → view=live 且 kw 保留', JSON.stringify(q))
  const d = await resolve('/explore?kw=lck')
  assert(d.view === 'discover' && d.kw === 'lck', '#/explore?kw=lck → view=discover 且 kw 保留', JSON.stringify(d))
  const g = await resolve('/diag?sec=log')
  assert(g.name === 'diag' && g.sec === 'log', '#/diag?sec=log → 诊断台且 sec 保留(页内锚点靠它落位)', JSON.stringify(g))
}

console.log(`\n通过 ${PASS} / 失败 ${FAIL}`)
if (FAIL) {
  console.error('失败项:\n' + fails.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
