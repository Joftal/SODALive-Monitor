import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// 全平台统一伪装 Windows Chrome UA: 服务端不校验 OS, 统一指纹反而是反风控资产(刻意不换行)
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export function dataRoot(): string {
  // 全部数据与程序同目录(Windows 打包, 统一便携哲学) ——
  //   portable 经 PORTABLE_EXECUTABLE_DIR 指回便携 exe 目录; NSIS 安装版取安装目录。
  //   应用数据(db/cookie/缩略图/日志/录制)与 Chromium 运行时(见 redirectElectronDataDir)同根:
  //   备份/迁移只需带走程序目录; NSIS 升级卸载只删安装清单内文件, data 天然保留。
  // macOS 的 .app 是只读包(可能 translocation 到隔离区)、Linux AppImage 是只读 squashfs:
  // 打包版在 mac/linux 只能落系统用户数据目录; 开发态三平台都用项目根
  if (app.isPackaged) {
    if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
    return app.getPath('userData')
  }
  return app.getAppPath()
}

/** Chromium/Electron 运行时数据(Cache/GPUCache/Partitions(官网登录 session)/Crashpad 等)
 *  重定向到程序目录 electron-data/ —— 与应用数据同根, 全量数据单目录收口。
 *  必须在 app ready 前调用(session partition 存储位置在首次使用时确定); 仅 win 打包生效。 */
export function redirectElectronDataDir(): void {
  if (!app.isPackaged || process.platform !== 'win32') return
  app.setPath('userData', path.join(dataRoot(), 'electron-data'))
}

export function dataDir(): string {
  const dir = path.join(dataRoot(), 'data')
  fs.mkdirSync(dir, { recursive: true })
  migrateLegacyData(dir)
  return dir
}

/** 默认录制根目录: 数据根/recording(未配置 savePath 时使用; 数据根三态见 dataRoot) */
/** 窗口底色(与 styles.css 的 --c-page 同值): 主题切换时要同步改 BrowserWindow,
 *  否则「主题立即生效」只管界面不管启动闪屏 —— createWindow 是一次性读值 */
export function windowBg(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? '#14161a' : '#f4f5f7'
}

export function defaultRecordRoot(): string {
  return path.join(dataRoot(), 'recording')
}

// 远古内测数据认领: %APPDATA%/pandalive-monitor/plm-data(2026-09 前内部版本的散落位置)
// 只补缺口不覆盖现存; per-file 容错(单文件失败不拖垮另一文件)
let migrated = false
function migrateLegacyData(target: string): void {
  // 旧版本仅存在于 Windows, 其他平台无需迁移
  if (process.platform !== 'win32') return
  if (migrated) return
  migrated = true
  try {
    const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
    const legacy = path.join(roaming, 'pandalive-monitor', 'plm-data')
    if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(target)) return
    for (const f of ['db.json', 'vault.dat']) {
      const src = path.join(legacy, f)
      const dst = path.join(target, f)
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue
      try {
        fs.copyFileSync(src, dst)
        console.log(`[migrate] 已迁移旧数据: ${f}`)
      } catch (e) {
        console.warn(`[migrate] 迁移失败 ${f}: ${String((e as Error).message || e)}`)
      }
    }
  } catch (e) {
    console.warn('旧数据迁移失败(忽略)', e)
  }
}

/** 目录级录制产物对账: 按基名前缀收集现存 mp4/ts(排序) + 总字节; 目录不可读返回空 */
export function scanTaskMedia(dirPath: string, base: string): { files: string[]; bytes: number } {
  try {
    const files = fs
      .readdirSync(dirPath)
      .filter((n) => n.startsWith(base) && /\.(mp4|ts)$/i.test(n))
      .sort()
      .map((n) => path.join(dirPath, n))
    const bytes = files.reduce((s, f) => {
      try {
        return s + fs.statSync(f).size
      } catch {
        return s
      }
    }, 0)
    return { files, bytes }
  } catch {
    return { files: [], bytes: 0 }
  }
}

export function tsName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let diskProbeWarned = false
/** 探测有没有坏过: 坏过一次之后上面那个函数就永远回 MAX_SAFE_INTEGER, 磁盘阈值保护实际已关掉。
 * 这件事今天只有日志知道, 而日志会滚出去 —— 诊断台要能一眼说出"保护还在不在" */
export function diskProbeFailed(): boolean {
  return diskProbeWarned
}
export function diskFreeGb(dir: string): number {
  try {
    const root = path.parse(path.resolve(dir)).root
    // 简单跨平台: 用 statfs(node 18.15+)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const st = fs.statfsSync ? fs.statfsSync(root) : null
    if (st) return (st.bavail * st.bsize) / 1024 ** 3
  } catch (e) {
    if (!diskProbeWarned) {
      diskProbeWarned = true
      // 磁盘保护静默失效必须留痕(延迟 require 避免 util->logger->util 环)
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require('./logger')
        logger.warn('app', `磁盘探测失败, 磁盘阈值保护将不生效: ${String((e as Error).message || e)}`)
      } catch {
        /* ignore */
      }
    }
  }
  return Number.MAX_SAFE_INTEGER
}
