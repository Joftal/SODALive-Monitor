import { safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../util'
import { logger } from './logger'

// ============ 通用机密保险箱(data/secrets.dat) ============
// 与 vault.dat(cookie)同套加密体系: safeStorage · Win=DPAPI / mac=Keychain / Linux=libsecret,
// 无系统密钥环境降级 base64 封装(可逆, 等同明文) —— 库里存的是 Telegram bot token 与 SOOP 托管密码,
// 降级必须由 `degraded` 说出来并让设置页显示, 不能只躺在日志里。tmp+rename 原子写。
// 用途: Telegram bot token 等第三方凭据 —— 不进 db.json(data 目录会被"打开目录"/导出), 不回显渲染层。
// ==========================================================

const FILE = () => path.join(dataDir(), 'secrets.dat')

let cache: Record<string, string> | null = null
/** 已落盘的那份是不是明文封装(前缀 plain:); 与"系统密钥当前是否可用"合成 degraded */
let plainStored = false

function readDisk(): Record<string, string> {
  if (cache) return cache
  const map: Record<string, string> = {}
  try {
    const text = fs.readFileSync(FILE(), 'utf-8')
    if (text.startsWith('enc:')) {
      Object.assign(map, JSON.parse(safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'))))
      plainStored = false
    } else if (text.startsWith('plain:')) {
      Object.assign(map, JSON.parse(Buffer.from(text.slice(6), 'base64').toString('utf-8')))
      plainStored = true
    }
  } catch (e) {
    if (fs.existsSync(FILE())) logger.warn('secrets', `secrets.dat 读取/解密失败, 视作空库: ${String((e as Error).message || e)}`)
  }
  cache = map
  return map
}

export const secrets = {
  /** 机密当前是否处于"可逆编码明文"降级态: 系统密钥不可用, 或磁盘上那份就是 plain —— 值本身不外泄, 只供 UI 说实话 */
  get degraded(): boolean {
    readDisk()
    return plainStored || !safeStorage.isEncryptionAvailable()
  },

  get(key: string): string {
    return readDisk()[key] || ''
  },

  set(key: string, value: string): void {
    const map = { ...readDisk(), [key]: value }
    if (!value) delete map[key]
    cache = map
    const raw = JSON.stringify(map)
    const atomic = (text: string): void => {
      const tmp = FILE() + '.tmp'
      fs.writeFileSync(tmp, text, 'utf-8')
      fs.renameSync(tmp, FILE())
    }
    try {
      if (safeStorage.isEncryptionAvailable()) {
        atomic('enc:' + safeStorage.encryptString(raw).toString('base64'))
        plainStored = false
        return
      }
      logger.warn('secrets', '系统密钥不可用: bot token / 托管密码将以可逆编码明文写入 secrets.dat(设置页已提示)')
    } catch (e) {
      logger.warn('secrets', `加密写入失败, 降级明文: ${String((e as Error).message || e)}`)
    }
    atomic('plain:' + Buffer.from(raw, 'utf-8').toString('base64'))
    plainStored = true
  }
}
