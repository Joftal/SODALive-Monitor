// ============================================================================
// 验证脚本: 全量数据单目录收口 —— Windows 打包恒程序目录 + Chromium 运行时也随程序
//
// 方法: sucrase 现编译 src/main/util.ts, electron.app 用临时目录 mock;
//       process.platform 经 defineProperty 临时改写覆盖 darwin/linux 分支;
//       APPDATA 全程指向临时 roaming 隔离宿主机.
// 场景:
//   D1  Portable: PORTABLE_EXECUTABLE_DIR 指回便携目录
//   D2  NSIS 安装版: 安装目录(有数据) 恒为数据根
//   D3  NSIS 安装版(无数据) 同样安装目录(无 userData 分支 — 单目录收口)
//   D4  macOS 打包: userData(.app 只读包约束)
//   D5  dev 开发态: 项目根
//   D8  Linux 打包: userData(AppImage 只读约束)
//   D6  远古数据(plm-data)认领: dataDir() 自动复制 db.json/vault.dat
//   D9  migrate 缺口补齐: 目标已有数据绝不覆盖
//   D10 migrate 单文件容错: 一文件失败不拖垮另一文件
//   D11 redirectElectronDataDir: Chromium 运行时重定向到程序目录(win打包), 其它平台 no-op
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-dataroot-'))
const dirs = {
  exeDir: path.join(TMP, 'nsis-install'),          // NSIS 安装目录
  portable: path.join(TMP, 'portable-run'),        // 便携 exe 目录
  userData: path.join(TMP, 'sys-userdata'),        // 系统 userData(mac/linux; win 已不用)
  roaming: path.join(TMP, 'roaming'),              // %APPDATA% 根(隔离)
  proj: path.join(TMP, 'devproj')                  // dev 项目根
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
process.env.APPDATA = dirs.roaming // 全程隔离真实 %APPDATA%(防宿主机 plm-data 串扰断言)

const setPathCalls = []
const appMock = {
  isPackaged: true,
  getPath: (k) =>
    k === 'exe' ? path.join(dirs.exeDir, 'SODALive Monitor.exe')
    : k === 'userData' ? dirs.userData
    : path.join(dirs.portable, 'SODALive Monitor.exe'),
  getAppPath: () => dirs.proj,
  setPath: (k, v) => setPathCalls.push([k, v])
}
const mocks = { electron: { app: appMock } }

// util.ts 有模块级状态(migrated 跑一次) → 每个场景全新加载
function loadUtilFresh() {
  const file = path.join(ROOT, 'src/main/util.ts')
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  const localRequire = (id) => (id in mocks ? mocks[id] : require(id))
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const withPlatform = (v, fn) => {
  const d = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: v, configurable: true })
  try { fn() } finally { Object.defineProperty(process, 'platform', d) }
}
const cleanHouse = () => {
  // 各场景前清场: exeDir 的 data/electron-data、userData/data 全部重置(不动 roaming/plm-data)
  for (const p of [path.join(dirs.exeDir, 'data'), path.join(dirs.exeDir, 'electron-data'), path.join(dirs.userData, 'data')]) {
    fs.rmSync(p, { recursive: true, force: true })
  }
}

console.log('\n■ D1 Portable 运行: 数据随便携 exe 目录(便携哲学特性)')
process.env.PORTABLE_EXECUTABLE_DIR = dirs.portable
withPlatform('win32', () => {
  const u = loadUtilFresh()
  check('D1-1 dataRoot = 便携目录', u.dataRoot() === dirs.portable, u.dataRoot())
})
delete process.env.PORTABLE_EXECUTABLE_DIR

console.log('\n■ D2 NSIS 安装版(已有数据): 数据根 = 安装目录')
cleanHouse()
fs.mkdirSync(path.join(dirs.exeDir, 'data'), { recursive: true })
fs.writeFileSync(path.join(dirs.exeDir, 'data', 'db.json'), JSON.stringify({ anchors: [{ userId: 'old1' }], settings: {}, history: [] }))
withPlatform('win32', () => {
  const u = loadUtilFresh()
  check('D2-1 dataRoot = 安装目录', u.dataRoot() === dirs.exeDir, u.dataRoot())
  const db = JSON.parse(fs.readFileSync(u.dataDir() + '/db.json', 'utf-8'))
  check('D2-2 既有库原地使用(老用户数据可读)', db.anchors?.[0]?.userId === 'old1')
})

console.log('\n■ D3 NSIS 安装版(无任何数据): 同样安装目录 — 无 userData 分支')
cleanHouse()
withPlatform('win32', () => {
  const u = loadUtilFresh()
  check('D3-1 dataRoot = 安装目录(无数据也不去 userData)', u.dataRoot() === dirs.exeDir, u.dataRoot())
  check('D3-2 dataDir = 安装目录/data 自动创建', u.dataDir() === path.join(dirs.exeDir, 'data') && fs.existsSync(path.join(dirs.exeDir, 'data')))
})

console.log('\n■ D4 macOS 打包: 恒 userData(.app 只读包约束)')
withPlatform('darwin', () => {
  const u = loadUtilFresh()
  check('D4-1 dataRoot = userData', u.dataRoot() === dirs.userData, u.dataRoot())
})

console.log('\n■ D5 dev 开发态: 项目根')
appMock.isPackaged = false
withPlatform('win32', () => {
  const u = loadUtilFresh()
  check('D5-1 dataRoot = 项目根', u.dataRoot() === dirs.proj, u.dataRoot())
})
appMock.isPackaged = true

console.log('\n■ D8 Linux 打包: 恒 userData(AppImage 只读约束)')
withPlatform('linux', () => {
  const u = loadUtilFresh()
  check('D8-1 dataRoot = userData', u.dataRoot() === dirs.userData, u.dataRoot())
})

const legacyDir = path.join(dirs.roaming, 'pandalive-monitor', 'plm-data')
fs.rmSync(legacyDir, { recursive: true, force: true })
fs.mkdirSync(legacyDir, { recursive: true })

console.log('\n■ D6 远古数据认领: %APPDATA%/pandalive-monitor/plm-data → 程序目录 dataDir() 自动复制')
cleanHouse()
fs.writeFileSync(path.join(legacyDir, 'db.json'), JSON.stringify({ anchors: [{ userId: 'legacy1' }], settings: { splitSeconds: 600 }, history: [] }))
fs.writeFileSync(path.join(legacyDir, 'vault.dat'), 'plain:eyJzZXNzS2V5Ijoib2xkIn0=')
withPlatform('win32', () => {
  const u = loadUtilFresh()
  const dd = u.dataDir()
  const db = JSON.parse(fs.readFileSync(path.join(dd, 'db.json'), 'utf-8'))
  check('D6-1 db.json 已认领且用户数据在', db.anchors?.[0]?.userId === 'legacy1' && db.settings?.splitSeconds === 600)
  check('D6-2 vault.dat 已认领(登录态继承)', fs.readFileSync(path.join(dd, 'vault.dat'), 'utf-8').startsWith('plain:'))
  check('D6-3 远古目录原数据未动(复制非移动, 保留回退)', fs.existsSync(path.join(legacyDir, 'db.json')))
})

console.log('\n■ D9 migrate 缺口补齐式认领: 目标已有数据绝不覆盖, 只补缺失文件')
cleanHouse()
fs.mkdirSync(path.join(dirs.exeDir, 'data'), { recursive: true })
fs.writeFileSync(path.join(dirs.exeDir, 'data', 'db.json'), '{"current":true}')
fs.writeFileSync(path.join(legacyDir, 'db.json'), '{"legacy":true}')
withPlatform('win32', () => {
  const u = loadUtilFresh()
  const dd = u.dataDir()
  check('D9-1 现存 db.json 不被 legacy 覆盖', fs.readFileSync(path.join(dd, 'db.json'), 'utf-8') === '{"current":true}')
  check('D9-2 缺失的 vault.dat 被补上(若 legacy 有)', !fs.existsSync(path.join(legacyDir, 'vault.dat')) || fs.existsSync(path.join(dd, 'vault.dat')))
})

console.log('\n■ D10 migrate 单文件容错: db.json 复制失败不拖垮 vault.dat 认领')
cleanHouse()
fs.rmSync(path.join(legacyDir, 'db.json'), { force: true, recursive: true })
fs.mkdirSync(path.join(legacyDir, 'db.json')) // src 变成目录 → copyFileSync 必抛(跨平台可靠的失败构造)
fs.writeFileSync(path.join(legacyDir, 'vault.dat'), 'plain:c3J1dml2ZWQ=')
withPlatform('win32', () => {
  const u = loadUtilFresh()
  const dd = u.dataDir()
  const dstDb = path.join(dd, 'db.json')
  check('D10-1 失败的 db.json 未以文件形态进 target', !fs.existsSync(dstDb) || !fs.statSync(dstDb).isFile())
  check('D10-2 vault.dat 未被拖垮照常认领', fs.readFileSync(path.join(dd, 'vault.dat'), 'utf-8') === 'plain:c3J1dml2ZWQ=')
})
fs.rmSync(path.join(legacyDir, 'db.json'), { recursive: true, force: true })

console.log('\n■ D11 redirectElectronDataDir: Chromium 运行时也随程序目录(仅 win 打包生效)')
cleanHouse()
setPathCalls.length = 0
withPlatform('win32', () => {
  const u = loadUtilFresh()
  u.redirectElectronDataDir()
  check('D11-1 userData 被重定向到 安装目录/electron-data',
    setPathCalls.some(([k, v]) => k === 'userData' && v === path.join(dirs.exeDir, 'electron-data')),
    JSON.stringify(setPathCalls))
})
setPathCalls.length = 0
withPlatform('darwin', () => {
  const u = loadUtilFresh()
  u.redirectElectronDataDir()
  check('D11-2 macOS 不重定向(no-op)', setPathCalls.length === 0)
})
setPathCalls.length = 0
appMock.isPackaged = false
withPlatform('win32', () => {
  const u = loadUtilFresh()
  u.redirectElectronDataDir()
  check('D11-3 dev 不重定向(no-op)', setPathCalls.length === 0)
})
appMock.isPackaged = true
setPathCalls.length = 0
process.env.PORTABLE_EXECUTABLE_DIR = dirs.portable
withPlatform('win32', () => {
  const u = loadUtilFresh()
  u.redirectElectronDataDir()
  check('D11-4 portable 下重定向到 便携目录/electron-data(非安装目录)',
    setPathCalls.some(([k, v]) => k === 'userData' && v === path.join(dirs.portable, 'electron-data')),
    JSON.stringify(setPathCalls))
})
delete process.env.PORTABLE_EXECUTABLE_DIR

// 清理临时目录
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('\n' + '─'.repeat(72))
console.log(`结果: ${failures === 0 ? '全部按预期' : failures + ' 条与预期不符'}`)
console.log('解读: D1/D2/D3 PASS ⇒ Windows 打包(便携/安装/有无数据)数据根统一在安装目录 — 单目录收口;')
console.log('      D4/D8 PASS ⇒ macOS/Linux 只读包恒 userData; D11 PASS ⇒ Chromium 运行时也随程序目录;')
console.log('      D6/D9/D10 PASS ⇒ 远古数据认领: 缺口补齐式/绝不覆盖/单文件容错 全闭环;')
console.log('      结论: 备份/迁移/卸载清理只需操作程序目录一处.')
process.exit(failures === 0 ? 0 : 1)
