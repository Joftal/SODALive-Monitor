import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { spawn, ChildProcess } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { store } from './store'
import { logger } from './logger'
import { dataRoot } from '../util'
import { EV } from '../../shared/types'
import type { RecHistoryItem } from '../../shared/types'

// ============ 视频库九宫格缩略图(data/thumbs/) ============
// 从录制产物采样 9 帧(总时长 5%..95% 均分)拼 3x3 JPEG, 用于视频库海报:
//   - 单文件/已合并/VOD/多分段/纯 TS 同一条管线(分段按真实时长累计定位)
//   - 文件名即状态: sha1(taskId)[0:12]_sig(8).jpg; sig=文件集(路径+大小+mtime)哈希,
//     外部删文件/重录/合并 → sig 失配 → 自动重生成; 旧 sig 文件同步清掉
//   - 抽帧失败写 .bad 负缓存, sig 没变前不重复重试(防坏文件刷屏)
//   - sweep(): 任务从历史移除(清空/删除) → 孤儿缩略图一并清除
// 串行队列单线程跑 ffmpeg; 完成后向渲染层推 EV.recThumb 点亮卡片
// =======================================================

const GRID = 9
const CW = 320
const CH = 180

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('ffmpeg-static') as string
  if (!p) throw new Error('ffmpeg-static 缺失')
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

export function thumbsRoot(): string {
  return path.join(dataRoot(), 'data', 'thumbs')
}

function hashId(id: string): string {
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 12)
}

/** 当前文件集签名: 任一文件变动(删/换/新增) → sig 变化 → 缩略图失效 */
function signature(files: string[]): string {
  const parts = files
    .map((f) => {
      try {
        const st = fs.statSync(f)
        return `${f.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`
      } catch {
        return ''
      }
    })
    .filter(Boolean)
    .sort()
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8)
}

function toUrl(abs: string, sig: string): string {
  return 'plocal://file/' + Buffer.from(abs, 'utf-8').toString('base64url') + `?v=${sig}`
}

function eligibleFiles(item: RecHistoryItem): string[] {
  return (item.files || []).filter((f) => /\.(mp4|ts)$/i.test(f) && fs.existsSync(f))
}

function removeTaskFiles(id: string, keepName = ''): void {
  const h = hashId(id)
  const dir = thumbsRoot()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (n === keepName) continue
    if (n.startsWith(h + '_') && /\.(jpg|bad)$/.test(n)) {
      try {
        fs.unlinkSync(path.join(dir, n))
      } catch { /* ignore */ }
    }
  }
}

/** 在跑 ffmpeg 注册表(退出钩子统一杀, 保证零子进程残留) */
const runningProcs = new Set<ChildProcess>()
/** 关停没收口: 退出中不再接新活 + 被杀的作业不写 .bad 负缓存(否则重启后缩略图永久不重生) */
let terminating = false

function runFf(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, stderr: string): void => {
      if (!done) {
        done = true
        if (p) runningProcs.delete(p)
        resolve({ ok, stderr })
      }
    }
    let p: ChildProcess | undefined
    try {
      p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (e) {
      finish(false, String(e))
      return
    }
    runningProcs.add(p)
    let stderr = ''
    p.stderr?.on('data', (b) => {
      if (stderr.length < 64 * 1024) stderr += String(b)
    })
    p.on('error', (e) => finish(false, String(e)))
    p.on('close', (code) => finish(code === 0, stderr))
    setTimeout(() => {
      try {
        p.kill('SIGKILL')
      } catch { /* ignore */ }
      finish(false, 'timeout')
    }, timeoutMs).unref()
  })
}

async function probeDurSec(file: string): Promise<number> {
  const r = await runFf(['-hide_banner', '-i', file], 15000)
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr)
  if (!m) return 0
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(sec) && sec > 0 ? sec : 0
}

interface Job {
  id: string
  files: string[]
  sig: string
}

const queue: Job[] = []
const inflight = new Set<string>() // `${id}:${sig}` — 同签名只排一次; 文件集变了(sig 变)允许重排
let working = false

/** 清孤儿: 历史里已不存在的任务的缩略图/负缓存/临时目录全部移除(清空历史/条目删除后调用) */
function sweep(keepIds: string[]): void {
  const keep = new Set(keepIds.map(hashId))
  const dir = thumbsRoot()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const m = /^([0-9a-f]{12})_[0-9a-f]{8}\.(jpg|bad)$/.exec(n)
    const isTmp = n.startsWith('.tmp_')
    if ((m && !keep.has(m[1])) || isTmp) {
      try {
        fs.rmSync(path.join(dir, n), { recursive: true, force: true })
        logger.info('thumb', `清理孤儿缩略图: ${n}`)
      } catch { /* ignore */ }
    }
  }
}

async function workJob(job: Job): Promise<string> {
  const dir = thumbsRoot()
  fs.mkdirSync(dir, { recursive: true })
  const finalName = `${hashId(job.id)}_${job.sig}.jpg`
  const finalPath = path.join(dir, finalName)
  const badPath = path.join(dir, `${hashId(job.id)}_${job.sig}.bad`)
  const tmpDir = path.join(dir, `.tmp_${hashId(job.id)}_${job.sig}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    // 1) 探测每段时长, 得到整条录制的采样时间轴
    const durs: number[] = []
    for (const f of job.files) durs.push(await probeDurSec(f))
    const total = durs.reduce((s, d) => s + d, 0)
    if (!(total > 0)) throw new Error('时长探测失败')

    // 2) 9 个采样点 → 落到具体 segment 的偏移
    const frames: string[] = []
    for (let i = 0; i < GRID; i++) {
      const at = (total * (i + 0.5)) / GRID
      let acc = 0
      let seg = job.files[0]
      let off = 0
      for (let k = 0; k < job.files.length; k++) {
        if (at < acc + durs[k] || k === job.files.length - 1) {
          seg = job.files[k]
          off = Math.min(Math.max(0.2, at - acc), Math.max(0.2, durs[k] - 0.2))
          break
        }
        acc += durs[k]
      }
          const out = path.join(tmpDir, `f${i + 1}.jpg`)
          const vf = `scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH}`
          // mpegts 关键帧稀疏时, -ss 输入级 seek 可能落在唯一关键帧之后 → "Output file is empty"(退出码仍为 0!)
          // 因此失败/空文件必须退化到无 seek 直接抽首帧, 保证 TS 产物也能出图
          let r = await runFf(['-y', '-ss', off.toFixed(2), '-i', seg, '-frames:v', '1', '-vf', vf, '-q:v', '3', out], 20000)
          if (!(r.ok && fs.existsSync(out) && fs.statSync(out).size > 0)) {
            r = await runFf(['-y', '-i', seg, '-frames:v', '1', '-vf', vf, '-q:v', '3', out], 20000)
          }
          if (r.ok && fs.existsSync(out) && fs.statSync(out).size > 0) {
        frames.push(out)
      } else if (!frames.length && i === GRID - 1) {
        // 全程失败才记详细 stderr 摘要(防刷屏, 只记最后一次)
        logger.warn('thumb', `抽帧失败样例(${path.basename(seg)} @${off.toFixed(2)}s): ${r.stderr.slice(-300) || '无输出'}`)
      }
    }
    if (!frames.length) throw new Error('全部采样点抽帧失败')
    // 不足 9 帧时复制尾帧补齐, 保证九宫格完整
    while (frames.length < GRID) {
      const dup = path.join(tmpDir, `f${frames.length + 1}.jpg`)
      fs.copyFileSync(frames[frames.length - 1], dup)
      frames.push(dup)
    }

    // 3) 拼 3x3
    const tmpOut = path.join(tmpDir, 'grid.jpg')
    const r = await runFf(['-y', '-framerate', '1', '-start_number', '1', '-i', path.join(tmpDir, 'f%d.jpg'), '-frames:v', '1', '-vf', 'tile=3x3', '-q:v', '3', tmpOut], 20000)
    if (!r.ok || !fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) throw new Error('拼图失败')

    fs.renameSync(tmpOut, finalPath)
    removeTaskFiles(job.id, finalName)
    try {
      fs.rmSync(badPath, { force: true })
    } catch { /* ignore */ }
    logger.info('thumb', `缩略图生成: ${finalName}(${job.files.length} 段, 总时长 ${Math.round(total)}s)`)
    return finalPath
  } catch (e) {
    if (!terminating) {
      // 关停期被杀不写负缓存: 让重启后能自然重试
      try {
        fs.writeFileSync(badPath, job.sig, 'utf-8')
      } catch { /* ignore */ }
      logger.warn('thumb', `缩略图生成失败(${job.id}): ${(e as Error).message || e}`)
    }
    return ''
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

async function pump(): Promise<void> {
  if (working) return
  working = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      try {
        const finalPath = await workJob(job)
        // 任务在生成期间被删除: 立即回收产物, 不留孤儿缩略图(bad 标记同样清)
        if (!store.listHistory().some((h) => h.id === job.id)) {
          removeTaskFiles(job.id)
          continue
        }
        if (finalPath) {
          const win = BrowserWindow.getAllWindows()[0]
          win?.webContents.send(EV.recThumb, { id: job.id, url: toUrl(finalPath, job.sig) })
        }
      } catch (e) {
        // workJob 自身已捕获执行期异常; 此处兜底磁盘级错误(目录创建失败等)防止 unhandled rejection
        logger.warn('thumb', `缩略图任务异常(${job.id}): ${(e as Error).message || e}`)
      } finally {
        inflight.delete(`${job.id}:${job.sig}`)
      }
    }
  } finally {
    working = false
  }
}

export const thumbs = {
  /** 诊断台: 九宫格图那条串行作业队今天完全不出声 —— 队堵了多少、有没有在干活、
   *  是不是正处在关停期(关停期不接新活)。只读, 不碰队列本身。 */
  diag(): { queued: number; working: boolean; inflight: number; terminating: boolean } {
    return { queued: queue.length, working, inflight: inflight.size, terminating }
  },
  /**
   * 确保任务缩略图存在: 命中直接返回 URL; 未命中入队后台生成(完成后走 EV.recThumb 推送)。
   * 文件集对账(外部删段剔除/恢复找回/全灭条目移除)已上移至 recorder.reconcileHistory —
   * 它在 recHistory 入口先行跑, 本函数只按"现存文件"算 sig, 文件集变动自然触发重生成。
   */
  ensure(taskId: string): { url: string } {
    if (terminating) return { url: '' } // 关停期不接新活(防 stopAll 尾巴上 enqueue 再生孤儿)
    const item = store.listHistory().find((h) => h.id === taskId)
    if (!item) return { url: '' }
    const files = eligibleFiles(item)
    const h = hashId(taskId)
    if (!files.length) {
      // 全灭(外部删空): 清残留缩略图并返回空串(条目自身的移除由 reconcileHistory 判定)
      if (!fs.existsSync(thumbsRoot())) return { url: '' }
      removeTaskFiles(taskId)
      return { url: '' }
    }
    const sig = signature(files)
    const finalName = `${h}_${sig}.jpg`
    const finalPath = path.join(thumbsRoot(), finalName)
    if (fs.existsSync(finalPath)) return { url: toUrl(finalPath, sig) }
    if (fs.existsSync(path.join(thumbsRoot(), `${h}_${sig}.bad`))) return { url: '' }
    const key = `${taskId}:${sig}`
    if (!inflight.has(key)) {
      inflight.add(key)
      queue.push({ id: taskId, files, sig })
      void pump()
    }
    return { url: '' }
  },
  enqueue(taskId: string): void {
    this.ensure(taskId)
  },
  /** 任务被删除: 清产物 + 清队列里未开始的作业(pump 内再对账一次在途作业) */
  remove(taskId: string): void {
    removeTaskFiles(taskId)
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === taskId) queue.splice(i, 1)
  },
  /** 退出钩子: 杀掉在跑缩略图 ffmpeg + 清空队列 + 关闸(.tmp_ 目录由启动 sweep 回收; 被杀作业不写负缓存) */
  terminateAll(): void {
    terminating = true
    queue.length = 0
    for (const p of runningProcs) {
      try {
        p.kill('SIGKILL')
      } catch { /* ignore */ }
    }
  },
  sweep
}
