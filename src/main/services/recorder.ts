import { app, BrowserWindow, shell } from 'electron'
import { spawn, ChildProcessByStdio } from 'child_process'
import { Readable, Writable } from 'stream'
import * as fs from 'fs'
import * as path from 'path'
import { EV, Platform, roomKey, REC_RETRY_MAX, sanitizePathPart, Anchor, RecHistoryItem, RecTask } from '../../shared/types'
import type { DiagRecRow } from '../../shared/types'
import { api, PlayResult } from './pandalive'
import { localizeVodPlaylist } from '../../shared/hlsPlaylist'
import { sourceFor } from './source'
import { store } from './store'
import { thumbs } from './thumbs'
import { tsName, diskFreeGb, scanTaskMedia, UA, sleep, defaultRecordRoot } from '../util'
import { sendToast } from './notify'
import { logger } from './logger'
import { asUser } from './netGate'
import { mt } from '../i18n'

// ============ 录制引擎 ============
// - ffmpeg -c copy 拉流; 直播按 splitSeconds 切 TS 分段, 填 0 则整场一个 TS(与回放同一支单文件直出)
// - 直接使用长效 IVS 变体地址(master 一次性: 源缓存复用)
// - 意外退出过"直播探针": 真下播=done; 仍在播=error(按策略不自动换源, 提示手动)
// - 停滞检测(60s 零字节) + 磁盘监控(30s) + 停止: stdin 写 'q' 优雅退出; 可选 remux
// ==================================

const STALL_MS = 60 * 1000 // 字节数 60s 无增长视为源失效

/** 本机回环源(见 hlsProxy): 这类地址必须由 ffmpeg 直连, 不能交给上游代理 */
const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/i

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('ffmpeg-static') as string
  if (!p) throw new Error(mt('rec.ffmpegMissing'))
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

/** 严格清理路径用名: 非法字符直接去除(不下划线替代), 收拢空白, 去除首尾点空格(NTFS 约束)。
 *  `%` 也在此列: 它会被塞进 ffmpeg 的 `-strftime` 式分段模板(`<base>_%04d.ts`), 留在名字里
 *  等于给模板凭空多一个转换符 —— 产出文件与索引对不上, 分段/合并全乱 */
export function strictName(s: string): string {
  return sanitizePathPart(s) || mt('app.unnamed')
}

/** 录制文件名: 主播名(主播ID)_直播标题(可选,截40)_时间戳; 非法字符直接剔除 */
function buildBaseName(nick: string, userId: string, title: string): string {
  const n = strictName(nick)
  const t = title ? strictName(title.slice(0, 40)).replace(/ /g, '_') : ''
  return t ? `${n}(${userId})_${t}_${tsName()}` : `${n}(${userId})_${tsName()}`
}

/** 分段形态后缀(_0001 / _vod + .mp4|.ts): 只有带它的文件才是"一段", 整文件不带 */
const SEG_RE = /_(\d{4}|vod)\.(mp4|ts)$/i

/** 从在管文件表反推录制基名: 必须挑"分段形态"的那个。合并产物 `<基名>.mp4` 排序天然在 `_0001` 之前,
 *  用它反推会多吞一层扩展名(基名变成 `X.mp4`), 于是基名扫描再也扫不到真分段 ——
 *  mergeTask 把成品喂进自己的 concat 输入表, 对账把在盘分段从库里抹掉 */
function baseOf(list: string[]): string {
  const seg = list.find((f) => SEG_RE.test(f))
  if (seg) return path.basename(seg).replace(SEG_RE, '')
  return path.basename(list[0] || '').replace(/\.(mp4|ts)$/i, '')
}

/** 无损合并多个分段为单个 MP4(concat demuxer, -c copy 不重编码); 临时 list 文件随用随删
 *  产物先落 <out>.part, ffmpeg 退出码 0 才改名就位 —— 半截 MP4 永远不进库 */
function concatSegments(files: string[], outPath: string): Promise<boolean> {
  const listFile = outPath + '.concat.txt'
  const part = `${outPath}.part`
  try {
    // concat demuxer 的词法是"文件名整体在单引号里", 不是 shell: 内部单引号只能写 \' 。
    // 原来套 shell 的 '\'' 惯用法, ffmpeg 会把结尾那串裸单引号当文件名的一部分读, 主播/标题带 ' 时合并必炸
    const esc = (s: string): string => s.replace(/\\/g, '/').replace(/'/g, "\\'")
    fs.writeFileSync(listFile, files.map((f) => `file '${esc(f)}'`).join('\n'), 'utf-8')
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const cleanup = (): void => {
      for (const f of [listFile, part]) {
        try {
          fs.unlinkSync(f)
        } catch {
          /* ignore */
        }
      }
    }
    const done = (ok: boolean): void => {
      if (ok) {
        // Windows: rename 不覆盖已存在目标(重跑/上次产物在), 先去再改名
        try {
          fs.rmSync(outPath, { force: true })
          fs.renameSync(part, outPath)
          try {
            fs.unlinkSync(listFile)
          } catch {
            /* ignore */
          }
          resolve(true)
          return
        } catch (e) {
          logger.warn('rec', `合并产物就位失败(${path.basename(outPath)}): ${String((e as Error).message || e)}`)
        }
      }
      cleanup()
      resolve(false)
    }
    const ff = spawn(
      ffmpegPath(),
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }
    )
    ff.on('exit', (code) => done(code === 0))
    ff.on('error', () => done(false))
  })
}

export interface StartRecOptions {
  platform: Platform
  userId: string
  nick: string
  title: string
  password?: string
  auto?: boolean
}

/** TG 卡片主播上下文: 监控中取完整 Anchor(标签/头像), 已取关退回任务自带字段 */
function tgAnchorOf(t: Task): Anchor {
  const a = store.listAnchors().find((x) => x.platform === t.platform && x.userId === t.userId)
  return { platform: t.platform, userId: t.userId, nick: t.nick, title: t.title, thumbUrl: t.thumbUrl, userImg: a?.userImg || '', tags: a?.tags ?? null } as unknown as Anchor
}

class Task implements RecTask {
  id: string
  platform: Platform
  userId: string
  nick: string
  title: string
  startedAt: number
  endedAt: number | null = null
  status: RecTask['status'] = 'recording'
  dirPath: string
  currentFile = ''
  files: string[] = []
  bytes = 0
  error = ''
  auto: boolean
  vod = false
  vodTotalSec = 0
  vodDoneSec = 0
  /** 交棒给 ffmpeg 的那份本地清单(用完即删, 见 cleanVodPlaylist); 空串=这一路没交棒 */
  private vodPlaylistFile = ''
  thumbUrl = ''
  /** 源站直连要带的请求头(平台各异; SOOP 的流走本地代理, 由代理带头, 此处为空) */
  private dlHeaders: Record<string, string> = {}
  stage: NonNullable<RecTask['stage']> = 'fetch'
  stageCur = 0
  stageTotal = 0

  password: string
  private proc: ChildProcessByStdio<Writable, Readable | null, Readable> | null = null
  private segIndex = 0
  private baseName = ''
  private statTimer: NodeJS.Timeout | null = null
  private stallTimer: NodeJS.Timeout | null = null
  private stopping = false
  /** 收尾守卫: 任何 finalize 入口已进 → exit 回调/外部路径不得二次收尾(H1) */
  private finalized = false
  private lastBytes = 0
  private lastBytesAt = 0
  /** 诊断台: stall 判定用的就是这一格, 把它递出去不等于新记一笔账 */
  get lastProgressAt(): number {
    return this.lastBytesAt
  }
  /** 意外退出那一发现拉到的新签名源: 续录直接复用, 不再打第二条完整取流链 */
  private freshSeed: PlayResult | null = null

  constructor(opt: StartRecOptions, dirPath: string) {
    // id 带平台前缀: 同 userId 跨平台不再可能撞成同一任务。
    // 冒号安全 —— id 只作 Map 键与缩略图 sha1 输入(thumbs.hashId), 不进目录/文件名。
    this.id = `${roomKey(opt.platform, opt.userId)}_${Date.now()}`
    this.platform = opt.platform
    this.userId = opt.userId
    this.nick = opt.nick
    this.title = opt.title
    this.password = opt.password || ''
    this.auto = !!opt.auto
    this.startedAt = Date.now()
    this.dirPath = dirPath
    this.baseName = buildBaseName(opt.nick, opt.userId, opt.title)
  }

  private refreshBaseName(): void {
    // 录制开始前(拿到最新标题后)统一命名: 主播名(主播ID)_直播标题_时间戳
    this.baseName = buildBaseName(this.nick, this.userId, this.title)
  }

  get outputPattern(): string {
    return path.join(this.dirPath, `${this.baseName}_%04d.ts`)
  }

  /** 回放(VOD)下载的单文件产出(无直播分段概念, finalize 统一 remux) */
  get vodOutFile(): string {
    return path.join(this.dirPath, `${this.baseName}_vod.ts`)
  }

  /** 不分段(splitSeconds=0)的直播产出: 整场一个 TS, 名字不带 _004d 后缀 ——
   *  SEG_RE 据此把它认成"整文件"而不是"某一段", 手动合并那侧也就不会把它喂进 concat */
  get liveSingleFile(): string {
    return path.join(this.dirPath, `${this.baseName}.ts`)
  }

  private push(): void {
    recorder.emitUpdate()
  }

  async run(): Promise<void> {
    fs.mkdirSync(this.dirPath, { recursive: true })
    // 用户按下录制的那一发取源算用户级(不等按站车道的后台队); 中途断线后的判活与续录仍是后台级
    // 自动录制不是用户: 机器一开播批量起录时, 那几发若都盖 userMark, 车道对这一站的全部节流
    // (一次一发 + 间隔)就被集体绕开 —— 恰恰在平台刚给出"这人开播了"的时刻叠速。自动那一路走后台车道。
    const play = this.auto
      ? await sourceFor(this.platform).getPlayCached(this.userId, this.password)
      : await asUser(() => sourceFor(this.platform).getPlayCached(this.userId, this.password))
    if (!play.ok || !play.m3u8) {
      const err = new Error(play.error || mt('rec.fetchFail'))
      ;(err as Error & { needPassword?: boolean }).needPassword = play.needPassword
      throw err
    }
    // 启动窗口竞态(H2): 网络往返期间用户可能已停止并收尾 → 不得再生 ffmpeg
    if (this.finalized || this.stopping || this.status !== 'recording') return
    if (play.title) this.title = play.title
    if (play.thumbUrl) this.thumbUrl = play.thumbUrl
    this.dlHeaders = play.dlHeaders || {}
    this.vod = !!play.vod
    this.refreshBaseName() // 拿到最终标题后再定文件名(首次可能任选项带标题)
    this.lastBytesAt = Date.now() // 停滞计时起点: 从未写入也能被检出
    logger.info('rec', `开始${this.vod ? '回放下载' : '录制'}: ${this.nick}(@${this.userId})${this.auto ? ' [自动]' : ''}`)
    // master URL 仅 10 分钟有效: 录制改用具象变体地址(最高档/原画)
    const src = play.variants?.[0]?.url || play.m3u8
    // 交给 ffmpeg 的输入: 默认就是源 URL; 回放那一路能交棒成功才换成本地清单
    let input = src
    if (this.vod) {
      // 一次读两家用: 同一份正文既当进度条分母又交棒给 ffmpeg, 那份清单不再被读第二遍
      // 失败=0 退化为不定进度的老语义不变(交棒不成也只是照旧把真 URL 交给 ffmpeg)
      const pl = await api.fetchVodPlaylist(src)
      if (this.finalized || this.stopping || this.status !== 'recording') return // H2 同上
      if (pl) {
        this.vodTotalSec = pl.sec
        input = this.handVodPlaylist(src, pl.text) || src
      }
    }
    try {
      this.spawnFfmpeg(input)
    } catch (e) {
      // 起跑就炸(ffmpeg 缺失等): 交棒清单不能留在目录里 —— 它写着这条回放的签名地址, 且没人会再去读它
      this.cleanVodPlaylist()
      throw e
    }
    this.statTimer = setInterval(() => this.statFiles(), 2000)
    this.stallTimer = setInterval(() => this.checkStall(), 10000)
    this.stage = 'recording'
    this.push()
  }

  /** 交棒: 把已经读到的清单正文绝对化后落在任务目录里, 回本地路径(失败回空串 = 照旧交真 URL)。
   *  文件名带 `_vod.m3u8` —— statFiles/SEG_RE 只认 .ts|.mp4, 它对产物对账是隐形的; ffmpeg 退出即删 */
  private handVodPlaylist(baseUrl: string, text: string): string {
    const body = localizeVodPlaylist(text, baseUrl)
    if (body === null) return ''
    const f = path.join(this.dirPath, `${this.baseName}_vod.m3u8`)
    try {
      fs.writeFileSync(f, body)
    } catch (e) {
      logger.warn('rec', `回放清单落盘失败, 退回真 URL: ${String(e)}`)
      return ''
    }
    this.vodPlaylistFile = f
    return f
  }

  private cleanVodPlaylist(): void {
    if (!this.vodPlaylistFile) return
    try {
      fs.unlinkSync(this.vodPlaylistFile)
    } catch {
      /* ignore */
    }
    this.vodPlaylistFile = ''
  }

  private spawnFfmpeg(m3u8: string): void {
    const cfg = store.getSettings()
    // 0 是「不分段」这一档, 不能按旧写法 `cfg.splitSeconds || 900` 一并兜成 900;
    // 只有缺键/非数值(老库没这个字段)才回默认 900
    const segSec = Number.isFinite(cfg.splitSeconds) ? cfg.splitSeconds : 900
    const args = [
      '-y',
      '-loglevel', 'error',
      '-hide_banner',
      '-user_agent', UA,
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '15',
      '-rw_timeout', '50000000',
    ]
    // 请求头按平台来(见 PlayResult.dlHeaders): SOOP 的流走 127.0.0.1 本地代理, 头由代理注入, 这里留空
    const hdr = Object.entries(this.dlHeaders)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('')
    if (hdr) args.push('-headers', hdr)
    // 本地 HLS 代理源(SOOP)不能套上游代理: ffmpeg 无 loopback 豁免, 127.0.0.1 也会被丢给代理 → 必然连不上
    if (cfg.proxyUrl && !LOOPBACK_RE.test(m3u8)) args.push('-http_proxy', cfg.proxyUrl)
    if (this.vod) {
      // 回放(VOD)下载: 单 TS 文件直出, 不走直播分段; -progress 管道回报已下载媒体时长
      args.push('-nostats', '-progress', 'pipe:1')
      args.push('-i', m3u8, '-map', '0', '-c', 'copy', this.vodOutFile)
    } else if (segSec === 0) {
      // 不分段: 直播整场一个 TS 直出。仍然不直写 MP4 —— MP4 的 moov 在收尾才落,
      // 中途被强杀(崩溃/断电/杀进程)就是一个开不了的废文件; TS 是追加式封装, 尾巴坏了前面照样能放
      args.push('-i', m3u8, '-map', '0', '-c', 'copy', this.liveSingleFile)
    } else {
      args.push(
        '-i', m3u8,
        '-map', '0',
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', String(Math.max(60, segSec)),
        '-segment_format', 'mpegts',
        '-segment_start_number', String(this.segIndex || 1),
        '-reset_timestamps', '1',
        this.outputPattern
      )
    }
    // 分开写两条 spawn: 保住 stdio 重载推导(vod 需要 stdout 管道回传 -progress)
    const ff = this.vod
      ? spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    this.proc = ff
    let errBuf = ''
    ff.stderr.on('data', (d: Buffer) => {
      errBuf = (errBuf + d.toString()).slice(-4000)
    })
    // VOD: 从 -progress 管道解析 out_time(已下载的媒体时长), 供进度条
    if (this.vod && ff.stdout) {
      let pbuf = ''
      ff.stdout.on('data', (d: Buffer) => {
        pbuf += d.toString()
        let idx: number
        while ((idx = pbuf.indexOf('\n')) >= 0) {
          const line = pbuf.slice(0, idx).trim()
          pbuf = pbuf.slice(idx + 1)
          // out_time_ms 历史命名实为微秒, out_time_us 同理按微秒计
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (m) this.vodDoneSec = Number(m[1]) / 1e6
        }
      })
    }
    ff.on('exit', (code) => {
      const expected = this.stopping
      this.proc = null
      this.cleanVodPlaylist() // 交棒清单只在这一次 ffmpeg 生命周期里有意义
      if (!expected && !this.finalized && this.status === 'recording') {
        // 自然结束/意外退出同样进入"收尾"棒: 棒清单是固定序列, 跳过会让"停止收尾"谎绿
        this.stage = 'stopping'
      }
      this.statFiles()
      if (expected || this.finalized) return // 已收尾/收尾中: 不得二次进入(H1)
      if (this.status !== 'recording') return
      const tail = errBuf.split('\n').filter(Boolean).slice(-3).join(' | ')
      if (this.vod) {
        // 回放下载: 流拉完自然退出(0)=完成; 回放无"是否还在播"语义, 不做探针
        if (code === 0) {
          logger.info('rec', `回放下载完成: ${this.nick}(@${this.userId})`)
          void this.finalize('done')
        } else {
          this.error = mt('rec.vodInterrupted', { reason: tail || `ffmpeg 退出码 ${code}` })
          logger.warn('rec', `${this.nick}(@${this.userId}) ${this.error}`)
          void this.finalize('error', 'vod')
        }
        return
      }
      const reason = code === 0 ? mt('rec.streamEnd') : tail || `ffmpeg 退出码 ${code}`
      void this.handleUnexpectedExit(reason)
    })
  }

  /** 意外退出统一语义: 拉一次现行流判下播/中断 —— 真下播按完成收尾, 还在播才记错误(不自动换源) */
  private async handleUnexpectedExit(reason: string): Promise<void> {
    let stillLive = false
    let play: PlayResult | null = null
    try {
      // 判活这一发仍是现拉(forceFresh=true: 缓存里就是正在死的那一条, 绝不能读它),
      // 但不再买整张菜单: 旧写法直调 fetchPlay, SOOP 那一路要把整条菜单解完(实测 8~10 发),
      // 而录制用的从来只是最高档那一路 —— 改成只解最高档后这一跳降到 3~4 发,
      // 并且按取源契约把结果走纪元门落回缓存(与续录种子同一本账)
      play = await sourceFor(this.platform).getPlayCached(this.userId, this.password, true, false)
      stillLive = !!(play.ok && play.m3u8)
    } catch {
      stillLive = false // 拉不出也按下播论
    }
    if (stillLive) {
      this.error = mt('rec.interrupted', { reason })
      // 这一次现拉就是"新签名源": 存下来交给续录复用(finalize 会作废旧源, 而这一发比它新)
      this.freshSeed = play
      await this.finalize('error', 'interrupted')
    } else {
      await this.finalize('done') // 正常下播: 完成态收尾
    }
  }

  /** 停滞检测(60s 字节无增长=源失效) + 磁盘监控(跨天录制保护) */
  private diskCheckCnt = 0
  private checkStall(): void {
    if (this.status !== 'recording' || this.stopping || !this.proc) return
    if (this.bytes !== this.lastBytes) {
      this.lastBytes = this.bytes
      this.lastBytesAt = Date.now()
    } else if (this.lastBytesAt && Date.now() - this.lastBytesAt > STALL_MS) {
      this.error = this.vod ? mt('rec.stallVod') : mt('rec.stall')
      void this.finalize('error', 'stall')
      return
    }
    // 每 ~30s 检查一次磁盘, 避免跨天录制把磁盘写满
    if (++this.diskCheckCnt >= 3) {
      this.diskCheckCnt = 0
      const limit = store.getSettings().diskLimitGb
      if (diskFreeGb(this.dirPath) < limit) {
        this.error = mt('rec.diskStop', { limit })
        void this.finalize('error', 'disk')
      }
    }
  }

  private killProc(): Promise<void> {
    return new Promise((resolve) => {
      const p = this.proc
      if (!p) return resolve()
      const timer = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch { /* ignore */ }
        resolve()
      }, 8000)
      p.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        p.stdin.write('q')
        p.stdin.end()
      } catch {
        try {
          p.kill()
        } catch { /* ignore */ }
      }
    })
  }

  private statFiles(): void {
    try {
      const list = fs
        .readdirSync(this.dirPath)
        .filter((f) => f.startsWith(this.baseName) && (f.endsWith('.ts') || f.endsWith('.mp4')))
        .sort()
      this.files = list.map((f) => path.join(this.dirPath, f))
      this.bytes = this.files.reduce((sum, f) => {
        try {
          return sum + fs.statSync(f).size
        } catch {
          return sum
        }
      }, 0)
      const writing = list.filter((f) => f.endsWith('.ts')).pop()
      this.currentFile = writing ? path.join(this.dirPath, writing) : this.files[this.files.length - 1] || ''
    } catch {
      /* ignore */
    }
    this.push()
  }

  /** 用户主动停止; remuxing 转码/合并中: 等待自然收尾(大文件合并不可截断, M1) */
  async stop(): Promise<void> {
    if (this.status === 'remuxing') {
      for (let i = 0; i < 600 && recorder.hasTask(this.platform, this.userId); i++) await sleep(500)
      return
    }
    if (this.status !== 'recording') return
    logger.info('rec', `手动停止: ${this.nick}(@${this.userId})`)
    this.stopping = true
    this.stage = 'stopping' // 用户视角: ffmpeg 优雅退出窗口(≤8s+待写盘)
    this.push()
    await this.killProc()
    await this.finalize('stopped')
  }

  /** 收尾: remux / 入库 / 通知; failKind 标记失败类别(续录策略据此收窄: 源失效类才续, 满盘/回放不续) */
  private async finalize(status: RecTask['status'], failKind?: 'stall' | 'interrupted' | 'disk' | 'vod'): Promise<void> {
    // H1: 任何来源(停滞/磁盘/错误/exit 回调/手动)只允许第一个进入者执行收尾
    if (this.finalized) return
    this.finalized = true
    if (this.statTimer) clearInterval(this.statTimer)
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.statTimer = null
    this.stallTimer = null
    await this.killProc()
    this.cleanVodPlaylist() // 兜住"没走到 exit 就收尾"的那几条路(停止/停滞/磁盘), 收尾即弃
    this.statFiles()

    const cfg = store.getSettings()
    if (status !== 'error' && cfg.autoMp4 && this.files.some((f) => f.endsWith('.ts'))) {
      this.status = 'remuxing'
      this.stage = 'remux'
      const tss = this.files.filter((f) => f.endsWith('.ts'))
      this.stageCur = 0
      this.stageTotal = tss.length
      this.push()
      for (const f of [...this.files]) {
        if (!f.endsWith('.ts')) continue
        const ok = await this.remux(f)
        this.stageCur += 1
        this.push()
        if (ok && cfg.deleteTs) {
          try {
            fs.unlinkSync(f)
          } catch { /* ignore */ }
        }
      }
      this.statFiles()
    }

    // 分段合并(可选): 合并为单个 MP4; 失败仅记日志并全部保留原分段(不丢数据)
    if (status !== 'error' && !this.vod && cfg.mergeMp4) {
      const mp4s = this.files.filter((f) => f.toLowerCase().endsWith('.mp4'))
      if (mp4s.length >= 2) {
        const out = path.join(this.dirPath, `${this.baseName}.mp4`)
        this.status = 'remuxing'
        this.stage = 'merge'
        // 合并是一次 concat: 无可推进的件数进度, 不显示计数(stageTotal=0),
        // 芯片点亮+呼吸点即"合并进行中"信号(显示 0/N 反而假卡死)
        this.stageCur = 0
        this.stageTotal = 0
        this.push()
        const ok = await concatSegments(mp4s, out)
        if (ok) {
          logger.info('rec', `分段合并完成: ${this.nick} -> ${path.basename(out)}(${mp4s.length} 段)`)
          if (cfg.mergeDeleteSegments) {
            for (const f of mp4s) {
              try {
                fs.unlinkSync(f)
              } catch {
                /* ignore */
              }
            }
          }
          this.statFiles()
        } else {
          logger.warn('rec', `分段合并失败, 已保留原分段: ${this.nick}(@${this.userId})`)
        }
      }
    }

    this.status = status
    this.endedAt = Date.now()
    logger.info(
      'rec',
      `录制结束: ${this.nick}(@${this.userId}) status=${status} 时长=${Math.round((this.endedAt - this.startedAt) / 1000)}s ` +
        `大小=${(this.bytes / 1024 ** 2).toFixed(1)}MB${this.error ? ` 原因: ${this.error}` : ''}`
    )
    if (status === 'error') {
      // 录制出错(源死/中断): 立即作废该主播的源缓存, 避免下次重录复用尸源
      sourceFor(this.platform).invalidatePlay(this.userId)
    }
    // 零产物不入库: 拉源阶段就停止/失败时磁盘上一个文件都没有, 而这条空骨架会被对账永久放过
    // (reconcileItem 只能对"列在管的文件"做实况比对, 空集无从对账) → 库里留下一条永远打不开的空条目
    if (this.files.length) store.addHistory(Recorder.publicTask(this))
    else logger.info('rec', `零分段结束(${status}), 不写历史: ${this.nick}(@${this.userId})`)
    recorder.removeTask(this.platform, this.userId)
    this.push()
    // 后台生成视频库九宫格缩略图(串行队列, 不阻塞收尾)
    if (this.files.length) thumbs.enqueue(this.id)

    if (status === 'done')
      sendToast(
        {
          type: 'rec',
          platform: this.platform,
          title: mt('rec.toastDone', { nick: this.nick }),
          // 单文件那一档说「1 个分段」是谎话: 只有一个产物时按文件计
          body: this.files.length === 1 ? mt('rec.fileOne') : mt('rec.segs', { n: this.files.length })
        },
        { ev: 'recDone', ctx: { anchor: tgAnchorOf(this), recSec: Math.round(((this.endedAt ?? Date.now()) - this.startedAt) / 1000), recMb: this.bytes / 1024 ** 2, files: this.files } }
      )
    if (status === 'error')
      sendToast(
        { type: 'error', platform: this.platform, title: mt('rec.toastErr', { nick: this.nick }), body: this.error.slice(0, 120) },
        { ev: 'recError', ctx: { anchor: tgAnchorOf(this), recSec: Math.round(((this.endedAt ?? Date.now()) - this.startedAt) / 1000), recMb: this.bytes / 1024 ** 2, files: this.files, detail: this.error || failKind } }
      )

    // 源失效自动续录(设置开启才生效): 仅"源死而主播仍在"类失败(停滞/中断)触发; 正常收尾给连续失败计数清白
    if (status === 'error') {
      recorder.maybeRetry(
        { platform: this.platform, userId: this.userId, nick: this.nick, title: this.title, password: this.password, vod: this.vod, startedAt: this.startedAt },
        failKind,
        this.freshSeed
      )
    } else {
      recorder.clearRetry(this.platform, this.userId)
    }
  }

  /** TS→MP4 无损 remux: 产物先落 <mp4>.part, 退出码 0 才改名就位。
   *  直写目标时 ffmpeg 一旦失败(分段截断/尾部坏包)会留下半截 MP4: 它被 statFiles 收进 files 入库,
   *  还会作为"已有 MP4"喂给后续合并 —— 坏包混进合并池后若合并"成功", 好分段按设置被删, 数据真丢 */
  private async remux(tsFile: string): Promise<boolean> {
    const mp4 = tsFile.replace(/\.ts$/, '.mp4')
    const part = `${mp4}.part`
    const ok = await new Promise<boolean>((resolve) => {
      // -f mp4 不能省: ffmpeg 按输出扩展名选封装器, 而原子产物刻意叫 <mp4>.part —— 不点名格式
      // 它直接 "Unable to choose an output format" 非零退出, 每一次转码都静默失败在起跑线上
      const ff = spawn(ffmpegPath(), ['-y', '-i', tsFile, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true
      })
      ff.on('exit', (code) => resolve(code === 0))
      ff.on('error', () => resolve(false))
    })
    if (ok) {
      try {
        // Windows: rename 不覆盖已存在目标(上次留下的同名 MP4), 先去再改名
        fs.rmSync(mp4, { force: true })
        fs.renameSync(part, mp4)
        return true
      } catch (e) {
        logger.warn('rec', `remux 产物就位失败(${path.basename(mp4)}): ${String((e as Error).message || e)}`)
      }
    } else {
      logger.warn('rec', `remux 失败(ffmpeg 非零退出), 已保留原分段: ${path.basename(tsFile)}`)
    }
    try {
      fs.unlinkSync(part)
    } catch {
      /* ignore */
    }
    return false
  }
}

class Recorder {
  private tasks = new Map<string, Task>()

  static publicTask(t: Task): RecTask {
    // 剥离私有实现字段(进程句柄/房间密码), 只暴露公开数据
    const { id, platform, userId, nick, title, startedAt, endedAt, status, dirPath, currentFile, files, bytes, error, auto, vod, vodTotalSec, vodDoneSec, thumbUrl, stage, stageCur, stageTotal } = t
    return { id, platform, userId, nick, title, startedAt, endedAt, status, dirPath, currentFile, files: [...files], bytes, error, auto, vod, vodTotalSec, vodDoneSec, thumbUrl, stage, stageCur, stageTotal }
  }

  emitUpdate(): void {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send(EV.recordings, [...this.tasks.values()].map((t) => Recorder.publicTask(t)))
  }

  list(): RecTask[] {
    return [...this.tasks.values()].map((t) => Recorder.publicTask(t))
  }

  isRecording(platform: Platform, userId: string): boolean {
    const t = this.tasks.get(roomKey(platform, userId))
    return !!t && t.status === 'recording'
  }

  async start(opt: StartRecOptions): Promise<RecTask> {
    const key = roomKey(opt.platform, opt.userId)
    // 用户手动接管 = 这条房不再欠一次自动续录(否则定时器会在手动任务收尾后又自作主张地开录)
    if (!opt.auto) {
      const pend = this.retryTimers.get(key)
      if (pend) clearTimeout(pend)
      this.retryTimers.delete(key)
    }
    const exist = this.tasks.get(key)
    if (exist && (exist.status === 'recording' || exist.status === 'remuxing')) {
      return Recorder.publicTask(exist)
    }
    const cfg = store.getSettings()
    const root = cfg.savePath || defaultRecordRoot()
    // 目录: <根>/<平台>/<主播名(主播ID)> —— 平台段用内部枚举('pandalive'/'soop'), 纯 ASCII 且不会随昵称/翻译变动
    // 裸 userId 而非 roomKey 作末段: ':' 在 Windows 文件名非法
    const dir = path.join(root, opt.platform, `${strictName(opt.nick)}(${opt.userId})`)
    if (diskFreeGb(dir) < cfg.diskLimitGb) {
      const err = new Error(mt('rec.diskLow', { limit: cfg.diskLimitGb }))
      // 手动路径由 IPC 报错回传视图 message 反馈(单通道统一); 自动路径无人代答, 仍走事件气泡
      if (opt.auto) sendToast({ type: 'error', platform: opt.platform, title: mt('rec.failToast'), body: String(err.message) }, { ev: 'recError', ctx: { detail: String(err.message) } })
      throw err
    }
    const task = new Task(opt, dir)
    // 先占位再初始化, 防双击/并发产生两个 ffmpeg; 立刻推送: 卡片即现"拉取直播源"棒(否则卡片要等 run() 走完拉源+spawn 才首见, 管线首棒名存实亡)
    this.tasks.set(key, task)
    this.emitUpdate()
    try {
      await task.run()
    } catch (e) {
      this.tasks.delete(key)
      this.emitUpdate() // 拉源失败: 撤掉刚才的 fetch 卡片, 不留僵尸
      if ((e as Error & { needPassword?: boolean }).needPassword) {
        const err = e as Error & { needPassword?: boolean }
        err.message = mt('rec.needPw')
        throw err
      }
      logger.warn('rec', `录制启动失败: ${opt.nick}(@${opt.userId})${opt.auto ? ' [自动]' : ''}: ${String((e as Error).message || e)}`)
      if (opt.auto)
        sendToast(
          { type: 'error', platform: opt.platform, title: mt('rec.toastStartFail', { nick: opt.nick }), body: String((e as Error).message || e) },
          { ev: 'recError', ctx: { anchor: { platform: opt.platform, userId: opt.userId, nick: opt.nick, title: opt.title } as unknown as Anchor, detail: String((e as Error).message || e) } }
        )
      throw e
    }
    // 手动开始: 视图已弹"开始录制"message, 不重复; 自动开始(开播自录/续录): 事件气泡通知到位
    if (opt.auto) sendToast({ type: 'rec', platform: opt.platform, title: mt('rec.toastStart', { nick: opt.nick }), body: opt.title || '' }, { ev: 'recStart', ctx: { anchor: store.listAnchors().find((x) => x.platform === opt.platform && x.userId === opt.userId) ?? null } })
    this.emitUpdate()
    return Recorder.publicTask(task)
  }

  async stop(platform: Platform, userId: string): Promise<void> {
    const t = this.tasks.get(roomKey(platform, userId))
    if (t) await t.stop()
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true // 退出流程: 封堵"收尾期间 error 触发自动续录"的竞态
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
    for (const t of [...this.tasks.values()]) {
      await t.stop()
      await sleep(300)
    }
  }

  removeTask(platform: Platform, userId: string): void {
    this.tasks.delete(roomKey(platform, userId))
  }

  // ---- 源失效自动续录(设置 autoRetryRecord 开启才生效) ----
  // 健康判定: 上个任务活满 10 分钟才死 → 视为新一轮失败, 连续计数清白; 快速连续死 → 计满 REC_RETRY_MAX 次停手
  // 上限是共享契约常量(渲染层播放页侧栏要如实显示同一个数), 健康窗口只有主进程用故留在这里
  private static HEALTHY_MS = 10 * 60 * 1000
  private retryStreak = new Map<string, number>()
  private shuttingDown = false
  /** 续录退避: 上一条五步链刚死就立刻再打一条, 等于在源最抖的时刻把扇出打满。
   *  计时器按房挂键: 两个房先后失效不该互相顶掉退避 */
  private static RETRY_BACKOFF_MS = 10_000
  private retryTimers = new Map<string, NodeJS.Timeout>()

  /** 诊断台: 大小/速率/磁盘录制页已经有, 这里只补那两格别处看不到的 ——
   *  重试到第几次、上一次字节动过是什么时候(卡住不动的那一条链今天不出声)。 */
  diag(): { rows: DiagRecRow[]; pendingRetries: number; maxRetry: number } {
    const now = Date.now()
    const rows: DiagRecRow[] = []
    for (const t of this.tasks.values()) {
      const key = roomKey(t.platform, t.userId)
      const at = t.lastProgressAt
      rows.push({ room: key, status: t.status, retryStreak: this.retryStreak.get(key) || 0, lastProgressAt: at, stalledForMs: at ? now - at : 0 })
    }
    return { rows, pendingRetries: this.retryTimers.size, maxRetry: REC_RETRY_MAX }
  }

  clearRetry(platform: Platform, userId: string): void {
    const key = roomKey(platform, userId)
    this.retryStreak.delete(key)
    const pend = this.retryTimers.get(key)
    if (pend) clearTimeout(pend)
    this.retryTimers.delete(key)
  }

  maybeRetry(
    prev: { platform: Platform; userId: string; nick: string; title: string; password: string; vod: boolean; startedAt: number },
    failKind?: string,
    seed?: PlayResult | null
  ): void {
    if (this.shuttingDown) return
    if (prev.vod) return // 回放下载不续(进度无法无损接回)
    if (failKind !== 'stall' && failKind !== 'interrupted') return // 满盘等不可续场景直接放行
    const cfg = store.getSettings()
    if (!cfg.autoRetryRecord) return
    const key = roomKey(prev.platform, prev.userId)
    const healthy = Date.now() - prev.startedAt >= Recorder.HEALTHY_MS
    let streak = healthy ? 0 : this.retryStreak.get(key) || 0
    if (streak >= REC_RETRY_MAX) {
      logger.warn('rec', `${prev.nick}(@${prev.userId}) 自动续录已连续失败 ${streak} 次, 停手(下个健康周期清白)`)
      sendToast({ type: 'error', platform: prev.platform, title: mt('rec.toastErr', { nick: prev.nick }), body: mt('rec.retryGiveUp', { n: streak }) }, { ev: 'recError', ctx: { anchor: store.listAnchors().find((x) => x.platform === prev.platform && x.userId === prev.userId) ?? null, detail: mt('rec.retryGiveUp', { n: streak }) } })
      return
    }
    streak += 1
    this.retryStreak.set(key, streak)
    const delay = Recorder.RETRY_BACKOFF_MS * 2 ** (streak - 1)
    logger.warn('rec', `${prev.nick}(@${prev.userId}) 源失效(${failKind}), ${delay / 1000}s 后自动续录第 ${streak} 次`)
    sendToast({ type: 'info', platform: prev.platform, title: mt('rec.toastStart', { nick: prev.nick }), body: mt('rec.retryResume', { n: streak }) }, { ev: 'recStart', ctx: { anchor: store.listAnchors().find((x) => x.platform === prev.platform && x.userId === prev.userId) ?? null, detail: mt('rec.retryResume', { n: streak }) } })
    // finalize(error) 已 invalidatePlay: 新任务必换新签名源 —— 这正是续录要解决的问题。
    // 中断探针刚现拉到的那一发就是新签名, 种回缓存即省掉第二条完整链
    if (seed?.ok) sourceFor(prev.platform).seedPlay(prev.userId, seed)
    const pend = this.retryTimers.get(key)
    if (pend) clearTimeout(pend)
    this.retryTimers.set(
      key,
      setTimeout(() => {
        this.retryTimers.delete(key)
        if (this.shuttingDown) return
        void this.start({ platform: prev.platform, userId: prev.userId, nick: prev.nick, title: prev.title, password: prev.password, auto: true }).catch(() => {
          // start 失败已弹"启动失败"气泡; streak 保留, 待下个健康周期清白
        })
      }, delay)
    )
  }

  /**
   * 手动合并某个历史任务的分段(MP4 ≥2 优先, 否则 TS ≥2 直接 concat 出 MP4)
   * 幂等: 已存在且"非空 + 不早于任一分段"的整文件才直接返回成功; 坏/过期文件会重做。受「合并后删除分段」设置约束
   */
  async mergeTask(taskId: string): Promise<{ ok: boolean; files?: string[]; error?: string }> {
    const item = store.listHistory().find((h) => h.id === taskId)
    if (!item) return { ok: false, error: mt('rec.mergeNoTask') }
    const dir = item.dirPath
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: mt('rec.mergeNoDir') }

    // 只合并现存文件(外部删段不死在 concat 里), 且只有"分段形态"文件能进 concat 输入表(见 baseOf)
    const existing = (item.files || []).filter((f) => fs.existsSync(f))
    const segFiles = existing.filter((f) => SEG_RE.test(f))
    const mp4s = segFiles.filter((f) => f.toLowerCase().endsWith('.mp4')).sort()
    const tss = segFiles.filter((f) => f.toLowerCase().endsWith('.ts')).sort()
    if (!mp4s.length && !tss.length) return { ok: false, error: existing.length ? mt('rec.mergeFew') : mt('rec.mergeNoFiles') }
    const base = baseOf(existing)
    const out = path.join(dir, `${base}.mp4`)

    const refresh = (): { files: string[]; bytes: number } => scanTaskMedia(dir, base)
    const segs = mp4s.length >= 2 ? mp4s : tss

    if (fs.existsSync(out)) {
      // 幂等命中必须先验这个整文件"非空且不早于任一分段": 零字节 = 上次合并被腰斩,
      // 比最新分段旧 = 合并后又续录过. 直接返回成功等于把坏文件和缺尾的成品一起交出去, 且永不重做
      let wholeSize = 0
      let wholeMtime = 0
      try {
        const st = fs.statSync(out)
        wholeSize = st.size
        wholeMtime = st.mtimeMs
      } catch {
        /* ignore */
      }
      const stale = segs.some((f) => {
        try {
          return fs.statSync(f).mtimeMs > wholeMtime
        } catch {
          return false
        }
      })
      if (wholeSize > 0 && !stale) {
        const r = refresh()
        store.updateHistory(taskId, { files: r.files, bytes: r.bytes })
        thumbs.enqueue(taskId)
        return { ok: true, files: r.files }
      }
      logger.warn('rec', `既有整文件不可用(大小=${wholeSize}B, 分段更新=${stale}), 重新合并: ${item.nick}(@${item.userId})`)
    }
    if (segs.length < 2) return { ok: false, error: mt('rec.mergeFew') }

    logger.info('rec', `手动合并开始: ${item.nick}(@${item.userId}) ${segs.length} 段`)
    const ok = await concatSegments(segs, out)
    if (!ok) {
      logger.warn('rec', `手动合并失败: ${item.nick}(@${item.userId})`)
      return { ok: false, error: mt('rec.mergeFail') }
    }
    if (store.getSettings().mergeDeleteSegments) {
      for (const f of segs) {
        try {
          fs.unlinkSync(f)
        } catch {
          /* ignore */
        }
      }
    }
    const r = refresh()
    store.updateHistory(taskId, { files: r.files, bytes: r.bytes })
    thumbs.enqueue(taskId)
    logger.info('rec', `手动合并完成: ${item.nick} -> ${path.basename(out)}`)
    return { ok: true, files: r.files }
  }

  /**
   * 视频库 ↔ 磁盘实况全量对账 —— recHistory 入口每次先行调用, 渲染层所见即实况:
   *  - 外部删段剔除 / 恢复找回(按"目录+文件基名"扫描, 与 mergeTask.refresh 同规约, 无关流浪文件不进库)
   *  - 全灭条目收窄移除: 目录已删(盘仍在) / 目录内媒体清零 → 移除条目并清缩略图;
   *    目录内剩别的媒体 = 重命名/手动挪动 → 保留(守"重命名不动条目"); 盘消失 → 本条跳过不判
   * 同理上移到单点: recHistory 覆盖启动首拉(store.init)与进库刷新, 无需 fs.watch/轮询
   */
  reconcileHistory(): { changed: number; dropped: number } {
    let changed = 0
    let dropped = 0
    // 迭代副本: 对账过程中可能 removeHistory
    for (const item of [...store.listHistory()]) {
      try {
        const r = this.reconcileItem(item)
        if (r === 'changed') changed++
        if (r === 'dropped') dropped++
      } catch (e) {
        logger.warn('rec', `视频库对账失败(${item.nick}@${item.userId}): ${String((e as Error).message || e)}`)
      }
    }
    if (changed || dropped) logger.info('rec', `视频库对账: 写回 ${changed} 条, 移除 ${dropped} 条`)
    return { changed, dropped }
  }

  private reconcileItem(item: RecHistoryItem): 'same' | 'changed' | 'dropped' {
    const dir = item.dirPath
    if (!dir) return 'same'
    const listed = (item.files || []).filter((f) => /\.(mp4|ts)$/i.test(f))
    if (!listed.length) {
      // 空集条目(修复前留下的历史): 没有在管文件可对账, 但"目录里一个媒体都没有"就是骨架, 清掉。
      // 目录里还有别的会话的媒体时保守保留 —— 空条目无权认领别人的文件
      if (!fs.existsSync(dir)) {
        if (this.diskGone(dir)) return 'same'
        thumbs.remove(item.id)
        store.removeHistory(item.id)
        logger.info('rec', `对账移除(空条目 + 目录已删): ${item.nick}(@${item.userId})`)
        return 'dropped'
      }
      if (fs.readdirSync(dir).some((n) => /\.(mp4|ts)$/i.test(n))) return 'same'
      thumbs.remove(item.id)
      store.removeHistory(item.id)
      logger.info('rec', `对账移除(空条目): ${item.nick}(@${item.userId})`)
      return 'dropped'
    }
    if (!fs.existsSync(dir)) {
      // 目录不存在: 盘拔掉则保守保留; 盘在而目录没了 = 被删 → 移除条目
      if (this.diskGone(dir)) return 'same'
      thumbs.remove(item.id)
      store.removeHistory(item.id)
      logger.info('rec', `对账移除(目录已删): ${item.nick}(@${item.userId})`)
      return 'dropped'
    }
    const base = baseOf(listed)
    const { files: scanned, bytes } = scanTaskMedia(dir, base)
    if (scanned.length) {
      // listed 来自录制期已排序 statFiles, 但历史库里可能有旧/手工数据, 用集合比对稳妥
      const same = scanned.length === listed.length && listed.every((f) => scanned.includes(f))
      if (!same) {
        store.updateHistory(item.id, { files: scanned, bytes })
        logger.info('rec', `对账写回: ${item.nick}(@${item.userId}) ${listed.length} -> ${scanned.length} 现存`)
        return 'changed'
      }
      return 'same'
    }
    // 基名扫描为 0: 目录里还有别的媒体 = 重命名/挪动(保留); 一个媒体都不剩 = 删空(移除)
    const anyMedia = fs.readdirSync(dir).some((n) => /\.(mp4|ts)$/i.test(n))
    if (anyMedia) return 'same'
    thumbs.remove(item.id)
    store.removeHistory(item.id)
    logger.info('rec', `对账移除(文件已删空): ${item.nick}(@${item.userId})`)
    return 'dropped'
  }

  /** 掉盘判定: Windows 看盘符存在与否即可; POSIX(含 mac 的 /Volumes)看最近现存上级距目标是否 ≥2 层(挂载点消失) */
  private diskGone(dirPath: string): boolean {
    const resolved = path.resolve(dirPath)
    if (process.platform === 'win32') {
      return !fs.existsSync(path.parse(resolved).root)
    }
    const depOf = (p: string): number => p.split(path.sep).filter(Boolean).length
    let cur = resolved
    for (let i = 0; i < 12; i++) {
      const parent = path.dirname(cur)
      if (parent === cur) return true // 一路到根都不存在: 视为掉盘
      if (fs.existsSync(parent)) return depOf(resolved) - depOf(parent) >= 2
      cur = parent
    }
    return true
  }

  /** 删除录制任务: 文件移入回收站 → 清缩略图 → 移出历史。任一文件被占用则失败并保留条目 */
  async deleteTask(taskId: string): Promise<{ ok: boolean; error?: string; deletedFiles: number; freedBytes: number; missingFiles: number }> {
    const zero = { deletedFiles: 0, freedBytes: 0, missingFiles: 0 }
    const item = store.listHistory().find((h) => h.id === taskId)
    if (!item) return { ok: false, error: mt('rec.delNoTask'), ...zero }
    const files = (item.files || []).filter((f) => /\.(mp4|ts)$/i.test(f))
    let deleted = 0
    let freed = 0
    let missing = 0
    const failed: string[] = []
    for (const f of files) {
      if (!fs.existsSync(f)) {
        missing++
        continue
      }
      let size = 0
      try {
        size = fs.statSync(f).size
      } catch { /* ignore */ }
      try {
        await shell.trashItem(f)
        deleted++
        freed += size
      } catch (e) {
        failed.push(path.basename(f))
        logger.warn('rec', `删除失败: ${f} — ${String((e as Error).message || e)}`)
      }
    }
    if (failed.length) {
      // 部分删除: 历史条目文件列表对账(移除已成功删除的), 条目保留
      const remain = files.filter((f) => fs.existsSync(f))
      store.updateHistory(taskId, { files: remain, bytes: remain.reduce((s, f) => {
        try {
          return s + fs.statSync(f).size
        } catch {
          return s
        }
      }, 0) })
      return { ok: false, error: mt('rec.delLocked', { name: failed[0], n: failed.length }), deletedFiles: deleted, freedBytes: freed, missingFiles: missing }
    }
    // 全删完: 空目录尝试移除(同目录可能有别的任务文件, 不递归硬删)
    try {
      const d = item.dirPath
      if (d && fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d)
    } catch { /* 目录非空/占用: 留着, 无害 */ }
    thumbs.remove(taskId)
    store.removeHistory(taskId)
    logger.info('rec', `删除录制: ${item.nick}(@${item.userId}) ${deleted} 个文件 释放 ${(freed / 1024 ** 2).toFixed(1)}MB${missing ? ` (${missing} 个文件已不存在)` : ''}`)
    return { ok: true, deletedFiles: deleted, freedBytes: freed, missingFiles: missing }
  }

  /** 删除单个分段: 校验属主 → 回收站 → 对账文件集 → 缩略图重生成; 删空则任务整体移除 */
  async deleteFile(taskId: string, absPath: string): Promise<{ ok: boolean; error?: string; remaining: number; emptied?: boolean }> {
    const item = store.listHistory().find((h) => h.id === taskId)
    if (!item) return { ok: false, error: mt('rec.delNoTask'), remaining: 0 }
    const files = item.files || []
    if (!files.includes(absPath) || !/\.(mp4|ts)$/i.test(absPath)) return { ok: false, error: mt('rec.delFileNotIn'), remaining: files.length }
    if (fs.existsSync(absPath)) {
      try {
        await shell.trashItem(absPath)
      } catch (e) {
        logger.warn('rec', `分段删除失败: ${absPath} — ${String((e as Error).message || e)}`)
        return { ok: false, error: mt('rec.delFileLocked'), remaining: files.length }
      }
    }
    const remain = files.filter((f) => f !== absPath && fs.existsSync(f))
    if (!remain.length) {
      thumbs.remove(taskId)
      store.removeHistory(taskId)
      logger.info('rec', `分段删除后任务已空, 整任务移除: ${item.nick}(@${item.userId})`)
      return { ok: true, remaining: 0, emptied: true }
    }
    const bytes = remain.reduce((s, f) => {
      try {
        return s + fs.statSync(f).size
      } catch {
        return s
      }
    }, 0)
    store.updateHistory(taskId, { files: remain, bytes })
    thumbs.enqueue(taskId) // sig 变化 → 缩略图按剩余分段重生成
    logger.info('rec', `删除分段: ${item.nick}(@${item.userId}) ${path.basename(absPath)} (剩 ${remain.length})`)
    return { ok: true, remaining: remain.length }
  }

  /** 任务是否在管(供 stop 等待 remuxing 收尾, M1) */
  hasTask(platform: Platform, userId: string): boolean {
    return this.tasks.has(roomKey(platform, userId))
  }
}

export const recorder = new Recorder()
