import { safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../util'
import { logger } from './logger'

// ============ 通用机密保险箱(data/secrets.dat) ============
// 与 vault.dat(cookie)同套加密体系: safeStorage · Win=DPAPI / mac=Keychain / Linux=libsecret,
// 无系统密钥环境降级 base64 明文封装(仅日志警告)。tmp+rename 原子写。
// 用途: Telegram bot token 等第三方凭据 —— 不进 db.json(data 目录会被"打开目录"/导出), 不回显渲染层。
// ==========================================================

const FILE = () => path.join(dataDir(), 'secrets.dat')

let cache: Record<string, string> | null = null

function readDisk(): Record<string, string> {
  if (cache) return cache
  const map: Record<string, string> = {}
  try {
    const text = fs.readFileSync(FILE(), 'utf-8')
    if (text.startsWith('enc:')) {
      Object.assign(map, JSON.parse(safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'))))
    } else if (text.startsWith('plain:')) {
      Object.assign(map, JSON.parse(Buffer.from(text.slice(6), 'base64').toString('utf-8')))
    }
  } catch (e) {
    if (fs.existsSync(FILE())) logger.warn('secrets', `secrets.dat 读取/解密失败, 视作空库: ${String((e as Error).message || e)}`)
  }
  cache = map
  return map
}

export const secrets = {
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
        return
      }
    } catch (e) {
      console.warn('secrets encrypt failed, fallback to plain', e)
    }
    atomic('plain:' + Buffer.from(raw, 'utf-8').toString('base64'))
  }
}
