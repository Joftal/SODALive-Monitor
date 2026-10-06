// ============================================================================
// 验证脚本: 两平台「站内关注」列表与导入(SOOP myapi/favorite + Panda /v1/live/bookmark + roundSoop 列表模式 + 会话 Cookie 转持久)
//
// 方法: electron(session/cookies)与 store/notify/recorder/logger 换成可计数替身, pandalive.ts 只替掉网络出口;
//       soop.ts / watcher.ts / ipc.ts / pandalive.ts / shared/types.ts 用真实源码(sucrase 现编译, 单例共用)。
//       列表响应体用 2026-09-29 实测抓到的真实形状(SOOP 718 关注 / Panda 158 关注, 含分组嵌套、脏字段、缺场次)。
// 场景:
//   A1  fetchFavorites 请求面: Origin=www(play 域被服务端 CORS 拒 403), Referer 停在 www 源根(跨源整路径被 Chromium 取消)
//   A2  真实形状解析: 一维 data / 分组嵌套 data / last_broad_start 分钟精度补齐 / 截图协议补全
//   A3  降级即 null(绝不解析成"全都下播"): 515 未登录 / 非 JSON / 缺 data / 全条脏数据
//   A4  单条不可寻址的 user_id 只丢那一条, 其余照常
//   A5  "is_live=true 却没给 broad_no" 判为状态未知(live=null), 交调用方回落探针
//   B1  roundSoop 列表模式: 命中行零探针落状态(nick/标题/截图/人数/开播时刻/标签) + 开播通知一次
//   B2  列表覆盖不到的房才发探针; 整表拿不到时全部回落探针(旧行为)
//   B3  下播要连续两轮才翻转: 单轮"列表说离线"只记 streak, 不动状态也不发通知; 翻离线时只清这一场的属性(密码房/回放), 房间属性留(SOOP 侧由 offPatch 直调证形状, Panda 侧的 19+/粉丝团同一规定)
//   B4  在播房不重复发开播通知; 离线房昵称照常跟进
//   B5  失明计数只看"全部关注都读不到": 列表覆盖到的房不计失败, 兜底房全灭不累计成平台失明
//   B6  SOOP 不带房间级 19+(is_adult 一律不读, 行里写着 true 也不落卡、并把旧残留清掉); 密码房旗仍是三态: 键缺席沿用上一轮, 明确 false 才翻转
//   C1  storeCookies 落罐必带 expirationDate(不带期限=会话 Cookie, 重启即登出)
//   C2  persistSessionCookies 只转 sooplive.com 的无期限条目, 已带期限与外域一律不动
//   C3  网页登录成功链路确实接上了转持久(authWin probe)
//   D1  「导入 SOOP 关注」: 只增不改 + 列表内重复去重 + 离线房同样入墙 + 自录恒关 + 未登录报错不落库
//   D3  反向差值(决策 D3): 站内缺房只标注「站内已取关」, 一条不删; 同名跨平台不串; 回榜即清标注
//   D2  preload / ApiBridge / 已关注页入口 / 双语文案四处接线齐全
//   E1  fetchBookmarks 请求面: POST /v1/live/bookmark + offset/limit + 会话 Cookie + www 源根
//   E2  分页按 page.total 收满即停(不多发页)
//   E3  降级即 null: result=false / HTML 验证页 / HTTP 403 风控 / 缺 list
//   E4  media 只在开播时下发: 在播行取全字段, 离线行 live=null
//   E5  单条不可寻址只丢那一条, 整表皆脏报"改版"而不是"0 个关注"
//   E6  「导入 Panda 关注」与 SOOP 导入共用同一条落库码路
//   E7  两平台导入的 preload / ApiBridge / 两枚按钮 / 双语文案接线齐全
//   E8  북마크 取满 200 上限时跳过反向差值(列表不完整 ≠ 站内已取关)
//   F1 列表播种的场次号让取流跳过整页 HTML(拉源成功那一档 0 页; 标题/昵称仍由主信息给)
//   F2  页面实读的号同样进缓存: 第二次取流不再读页; 号过期(>90s)才回落到读整页
//   F4  复用的号没成功 → 只回读一页定性, 代价有上界(离线定性 / 同号原样回报 / 换场用新号重走一次)
//   F5  播放页微缓存: TTL 内复用 + 并发合流, fresh=true 必穿透(探针那一发要的是新读数)
//   G1 作废纪元: invalidatePlay 之后在飞的那条链不复活缓存(带密那一格同摘), 换号清表同规则
//   G4 seedPlay: 续录复用中断探针那一发 = 下一次取流零请求; 坏源不种, 种子清判死计数
//   K1 关注列表的在飞合流: 同一瞬时的两问共享一发整表, 落定后再问照发(不设 TTL)
//   K2 SOOP 源缓存的年龄收手: 回访客 10 分钟 / 下播 30 分钟出队, 在播长场次不掐, 全程零网络
//   K3 兜底重发出声: 会话层失败 → Node 那一发不再静默, 但 60 秒只报一次(带累计次数)
//   H1~H5 取源链的档位扇出: 后台只买最高档(1+1 发)、残缺包不外交、满档由进房那一次买、手动拉源不省发
//   H6~H7 差档复用: 满档 caller 只买没买过的那几档(已买的从复用账递出), 作废/换场/菜单错位三格各自摘账
//   I1~I4 接口风控信号记账: 整页 HTML 与 515 不算风控, 403/429/5xx/接口回 HTML 各武装一次且只按时点解除
//   J1~J3 静默期只收手后台泵: 探针整批收手而列表一发照发, 失明判据不被绕过, 用户进房取流不受牵连
//   L1~L2 (C7) livePlay 手动刷新的 8 秒下限: 只闸强制位不闸档级, 失败/非强制/别房/对面平台都不立闸
//   M1~M3 三笔: 添加那一发的真值当场用掉 · 复查吃十秒微缓存 · SOOP 门槛回执 15 分钟不再重打整链
//   N1~N4 dropCachedPlay 的形状: 亲证地址对得上才摘 · 停在别的档位也算亲证 · 只撤"这条链出发之前"那一份 · needPassword 不作废
//   O1~O4 SOOP 那一行的四档: 同一瞬两问 = 真发+合并而发数只有一发 · 落定后才缓存 · 匿名是未问 · 失败链两格各说各的
//   P1~P5 Panda 那一行的同一把尺(真 ipc.ts + 真 pandalive.ts + 可计数 login_info): 四档与 SOOP 同形, P5 钉的是"强制那一发不出行"这一处已知残项
//   Q1~Q4 报案那一路: 亲证地址原样交到主进程手里 · 非法寻址在摘源之前就早退 · 截 500 且去控制字符 · 摘与没摘说两句不同的话
//   R1~R5 秒开快道: 手里没包照买满档 · 残缺包直接给而后台只排一条链 · liveMenu 与那条链合流 · 带密那一发不起无密链 · force 仍穿透
//   S1~S12 源留存: 盘上只有上游地址+场次号 · 同号复活零新增请求 · 复活那一档递回复用账(S2H, 老文件无 name 那一格也照旧复活, 带密码买回的那一档不递) · 换场/离线/过龄/读不出四判据 · 亲证死与作废同批摘 · 换号立即抹平 · 无号与签不出去一律不留 · 坏文件逐条丢 · 上限挤最旧
//   C2-1: 本套跑完零落盘(data/ + recording/ + 根目录), 三根指路针改指 mkdtemp —— 见文件头那段实测
// ============================================================================
import { createRequire } from 'module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ============================================================================
// 落盘守卫: 这一套加载的真源码面最广(ipc / watcher / 两站客户端 / 取流链), 所以由它当场自证
//   「跑一遍验证不动用户的库」。
// 实测(2026-10-04, 探针跑完整条 12 套链, 范围 = 工作区 data/ + recording/ + 根目录 + 真 app 的 %APPDATA%/pandalive-monitor):
//   12/12 套跑完, 那 1609 个可写文件字节未变 —— 所以"verify 会写你的真 db.json"这一条不成立。
// 但形状上确实开着一道门: 本套原先把 dataDir / defaultRecordRoot / app.getPath 三根指路针都指在 ROOT(仓库根),
// 今天没人往里写只因为 store 是替身、没人真去拉卡片图 —— 哪天把替身换成真 store(或新增一个写盘口),
// 第一发就落在用户的库上。这一笔把那三根针改指临时目录, 并把"没落盘"从一次探针改成每套都跑的常驻断言。
// ============================================================================
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-follows-'))
const GUARD_WATCH = ['data', 'recording'] // 库/日志/缩略图/录像全在这两棵树下
const GUARD_ROOT_FILES = ['db.json', 'vault.dat', 'secrets.dat'] // 根目录散落件: 出现即说明有写口指回了仓库
const sha16 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12)
function guardSnap() {
  const out = {}
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, r)
      else {
        const st = fs.statSync(p)
        out[r] = st.size > 8 * 1024 * 1024 ? `size:${st.size}` : sha16(fs.readFileSync(p)) // 录像这类大块只按尺寸看, 不为它花哈希
      }
    }
  }
  for (const d of GUARD_WATCH) walk(path.join(ROOT, d), d)
  for (const f of GUARD_ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) out[f] = sha16(fs.readFileSync(path.join(ROOT, f)))
  return out
}
const GUARD_BEFORE = guardSnap()

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

// ---------- 替身世界 ----------
const world = {
  /** myapi/favorite 的应答(状态码 + 文本), 由场景逐次改写 */
  favStatus: 200,
  favBody: '',
  /** 关注列表那一发的应答延迟(K1: 在飞合流要有窗口让两问撞进同一次请求) */
  favDelayMs: 0,
  /** 播放页探针应答: live=有场次号 / offline=页面明确 null / broken=两者都没有(风控页或改版) */
  pageMode: 'live',
  pageFail: false,
  /** 播放页里的 nBroadNo(换场/号失效的场景自己改这一个数) */
  pageBno: null,
  /** player_live_api.php 应答里 CHANNEL 段的覆盖项(未设=在播且各档齐, 让整链走到成功) */
  apiChannel: null,
  /** broad_stream_assign.html 应答: 非空=给地址, null=不给(调度失败) */
  assign: 'https://livecast.sooplive.com/12345678-common-hd-1000.ts?limit=0&sid=x',
  /** api.pandalive.co.kr/v1/live/bookmark 的逐页应答数组(按 offset/200 取); bmStatus 覆盖 HTTP 码 */
  bmPages: [],
  bmStatus: 200,
  /** api.pandalive.co.kr/v1/member/bj 的应答体(null=服务端不给这一格 → 走 Node 兜底那条路) */
  bjBody: null,
  /** get_private_info 的应答(状态码 + CHANNEL 段)与人为延迟: 登录态那两行日志要说清「真发/缓存/合并/未问」, 合流要有窗口 */
  loginStatus: 200,
  loginChannel: { LOGIN_ID: 'soopuser11', LOGIN_NICK: '主播甲' },
  loginDelayMs: 0,
  /** Panda 那一侧的同款三格: login_info 的应答、人为延迟、以及"会话罐里有没有 Cookie"。
   *  pandaSession 默认 false ⇒ 既有各段读到的仍是「未问」那一路, P 段自己开这一格 */
  pandaLi: { userInfo: { isLogin: true, isAdult: true, idx: 1001 } },
  pandaLoginDelayMs: 0,
  pandaLiThrow: false,
  pandaSession: false,
  /** 观测点 */
  fetches: [],
  /** Panda 登录态那一发的计数(走真 pandalive.ts 的 session.fetch, 与 SOOP 的 get_private_info 各数各的) */
  liCalls: [],
  /** CH.liveSrcDead 处理器交到 sourceFor.dropCachedPlay 的那两个入参: 亲证地址若在处理器里被抹掉, 这里就看不见 */
  deadCalls: [],
  deadDrops: true,
  cookieWrites: [],
  jar: [],
  toasts: [],
  recStarts: [],
  invalidate: [],
  logInfo: [],
  logWarn: [],
  anchors: [],
  /** L 段: 取流处理器的调用现场(强制位/档级/成没成) + 替身的令牌序号与失败次数 */
  playCalls: [],
  playSeq: 0,
  playFails: 0,
  /** 代理实例的"世代": 真代理每实例随机口(listen(0)) + 每实例重随机令牌, 重启即全换。
   *  留存的测试要靠这一格验的正是"存下来的不能是代理地址", 所以替身必须把这个性质保留下来 */
  proxyGen: 1,
  /** ipcMain.handle 注册到的处理器 */
  ipc: {}
}

// Chromium 的域匹配近似: 域 Cookie(.sooplive.com)对任意子域可见, 主机 Cookie 只对本主机可见
function cookieVisibleTo(c, url) {
  try {
    const host = new URL(url).hostname
    const d = (c.domain || '').replace(/^\./, '')
    return host === d || host.endsWith('.' + d)
  } catch {
    return false
  }
}

const fakeSession = {
  fetch: async (url, init = {}) => {
    world.fetches.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? String(init.body) : '' })
    if (String(url).includes('myapi.sooplive.com/api/favorite')) {
      if (world.favDelayMs) await new Promise((r) => setTimeout(r, world.favDelayMs))
      return { status: world.favStatus, url, text: async () => world.favBody }
    }
    // Panda 站内关注(북마크): POST body 里的 offset 决定第几页(分页不发第三页由场景自己断言)
    if (String(url).includes('api.pandalive.co.kr/v1/live/bookmark')) {
      const offset = Number(/(?:^|&)offset=(\d+)/.exec(String(init.body || ''))?.[1] || 0)
      const page = world.bmPages[offset / 200]
      const text = page === undefined ? '{"result":false,"message":"no page seeded"}' : typeof page === 'string' ? page : JSON.stringify(page)
      return { status: world.bmStatus, url, text: async () => text, headers: { getSetCookie: () => [] } }
    }
    // 逐房 member/bj: 手工添加那一发与降级复查都走这里, 应答体由场景自己摆
    if (String(url).includes('api.pandalive.co.kr/v1/member/bj')) {
      const text = JSON.stringify(world.bjBody ?? { result: false, message: 'no bj seeded' })
      return { status: 200, url, text: async () => text, headers: { getSetCookie: () => [] } }
    }
    // 登录态校验那一发(get_private_info): 判据就是回包里的 LOGIN_ID, 延迟用来开合流的窗口
    if (String(url).includes('get_private_info')) {
      if (world.loginDelayMs) await new Promise((r) => setTimeout(r, world.loginDelayMs))
      return { status: world.loginStatus, url, finalUrl: url, text: async () => JSON.stringify({ CHANNEL: world.loginChannel }) }
    }
    // Panda 那一问(/v1/member/login_info)同款: 这一支的合流与缓存在真 pandalive.ts 里, 替身只给答案和窗口
    if (String(url).includes('/v1/member/login_info')) {
      world.liCalls.push(String(url))
      // 延迟排在失败之前: 失败链也要有一段真在飞的窗口, 否则第二问到达时在飞表早就空了(那不是被测形状, 那是各问各的)
      if (world.pandaLoginDelayMs) await new Promise((r) => setTimeout(r, world.pandaLoginDelayMs))
      if (world.pandaLiThrow) throw new Error('boom(sim)') // 请求失败 = netFail: 与"服务端说没登录"是两格
      const text = JSON.stringify({ result: true, loginInfo: world.pandaLi })
      return { status: 200, url, finalUrl: url, text: async () => text, headers: { getSetCookie: () => [] } }
    }
    // 播放页探针: soop.ts 的 fetchPageMeta 走同一 req 通道
    if (world.pageFail) throw new Error('ERR_FAILED(sim)')
    // 取流整链的两步(第 2 步主信息 + 第 3 步凭证)与第 4 步调度: 让 F 段能跑到"拉源成功"这一档
    if (String(url).includes('player_live_api.php')) {
      const type = /(?:^|&)type=([^&]*)/.exec(String(init.body || ''))?.[1] || ''
      const ch = type === 'aid' ? { RESULT: 1, AID: 'aid-x' } : { RESULT: 1, BNO: '12345678', RMD: 'https://livecast.sooplive.com', CDN: 'gs_cdn', BJNICK: '甲', TITLE: '在播标题', BTIME: 60, VIEWPRESET: [{ label: 'HD', name: 'hd', label_resolution: 720, bps: 3000 }] }
      const text = JSON.stringify({ CHANNEL: { ...ch, ...(world.apiChannel || {}) } })
      return { status: 200, url, finalUrl: url, text: async () => text }
    }
    if (String(url).includes('broad_stream_assign')) {
      const text = world.assign ? JSON.stringify({ view_url: world.assign }) : '{}'
      return { status: 200, url, finalUrl: url, text: async () => text }
    }
    const body =
      world.pageMode === 'live'
        ? `<script>window.nBroadNo=${world.pageBno ?? 12345678};window.szBjNick='探针昵称';window.szBroadTitle='探针标题';window.szBroadThumPath='//liveimg.sooplive.com/h/12345678.jpg';</script>`
        : world.pageMode === 'offline'
          ? `<script>window.nBroadNo=null;window.szBjNick='探针昵称';</script>`
          : `<html>check your connection</html>`
    return { status: 200, url, finalUrl: url, text: async () => body }
  },
  cookies: {
    set: async (c) => {
      world.cookieWrites.push(c)
      if (!c.url && !c.domain) throw new Error('Cookie set 需要 url 或 domain')
      const domain = c.domain || new URL(c.url).hostname
      world.jar = world.jar.filter((x) => !(x.name === c.name && x.domain === domain && (x.path || '/') === (c.path || '/')))
      world.jar.push({ name: c.name, value: c.value, domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'no_restriction', expirationDate: c.expirationDate })
    },
    get: async (filter = {}) => {
      if (filter.url) return world.jar.filter((c) => cookieVisibleTo(c, filter.url))
      if (filter.domain) return world.jar.filter((c) => (c.domain || '') === filter.domain)
      return [...world.jar]
    }
  }
}

// 门槛账落盘要能数"写了几笔、写的是什么" —— 替身只 Object.assign 的话, "根本没落盘"与"落错了"读不出差别
const anchorWrites = []

const baseStore = {
  // 节奏三格已进 monitor: 顶层那几格现在是未注册键(引擎读不到), 预取关不掉就会在同步关注时多发拉源请求
  getSettings: () => {
    const s = { ...types.DEFAULT_SETTINGS }
    s.monitor = {
      pandalive: { ...s.monitor.pandalive, prefetchStream: false, requestGapMs: 0, pollIntervalSec: 120 },
      soop: { ...s.monitor.soop, prefetchStream: false, requestGapMs: 0, pollIntervalSec: 120 }
    }
    return s
  },
  listAnchors: () => world.anchors,
  addAnchor: (a) => {
    if (!world.anchors.find((x) => x.platform === a.platform && x.userId === a.userId)) world.anchors.push(a)
  },
  updateAnchor: (platform, userId, patch) => {
    anchorWrites.push({ platform, userId, patch: { ...patch } })
    const a = world.anchors.find((x) => x.platform === platform && x.userId === userId)
    if (a) Object.assign(a, patch)
  },
  flush() {}
}

class RiskError extends Error {}
class BjNotFoundError extends Error {}

// E 段用: pandalive.ts 的真实单例(解析/分页/降级全走真源码), 在模块加载完成后接上
let realPandaApi = null

const mocks = {
  electron: {
    app: { isPackaged: false, getAppPath: () => ROOT, getPath: () => SANDBOX, setPath() {}, on() {}, whenReady: () => Promise.resolve(), quit() {}, name: 'test' },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: {
      handle: (ch, fn) => {
        world.ipc[ch] = fn
      },
      on() {},
      removeHandler() {}
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openExternal: async () => {}, showItemInFolder() {}, trashItem: async () => {}, openPath: async () => ({ error: '' }) },
    net: { request: () => ({ on() {}, end() {}, write() {} }) },
    session: { fromPartition: () => fakeSession, defaultSession: fakeSession }
  },
  'src/main/services/pandalive.ts': {
    api: {
      setGap() {},
      hasSession: () => world.pandaSession, // P 段要演"罐里有 Cookie"那一档, 默认关着 ⇒ 既有各段读到的还是「未问」
      cookieValid: false,
      // 取态那一发转发到真客户端: P 段断言的是 Panda 那一行日志的字样, 而字样只有真合并/真缓存给得准
      checkLoginInfo: async (jarOverride, force) => realPandaApi.checkLoginInfo(jarOverride, force),
      get lastLoginCheckAt() {
        return realPandaApi.lastLoginCheckAt
      },
      get cookieCount() {
        return realPandaApi.cookieCount
      },
      fetchLivePage: async () => ({ list: [], loginInfo: null }),
      // 替身必须同契约: 间隙泵/轮次现在都读这一面钟, 缺格会让 pumpIdle 一碰就 TypeError
      // (本套一律回"没在冷却", 需要演冷却的场景自己改这一格)
      riskCooling: () => false,
      // 这本账分成两格之后, 轮次扇出与间隙泵读的是"整表那一发被拒"那一格: 缺格同样是一碰就 TypeError
      oracleRiskCooling: () => false,
      // Panda 关注列表走真源码解析(realPandaApi), 替身只做转发, 让 IPC 处理器与客户端在同一条链上
      fetchBookmarks: async () => realPandaApi.fetchBookmarks(),
      // 手工添加那一条链也要能跑真客户端: 加房的 IPC 处理器与逐房那一发必须在同一条链上,
      // 否则"同一房 1.2 秒内两发 member/bj"这一种形状在本套里根本测不出来(替身吞掉参数照样绿 —— 那一课)
      fetchBj: async (userId) => realPandaApi.fetchBj(userId)
    },
    RiskError,
    BjNotFoundError,
    nodeHttpRequest: async (method, url, headers, body) => {
      world.fetches.push({ url, headers: headers || {}, node: true })
      if (String(url).includes('myapi.sooplive.com/api/favorite')) {
        if (world.favDelayMs) await new Promise((r) => setTimeout(r, world.favDelayMs))
        return { status: world.favStatus, text: world.favBody, headers: {} }
      }
      return { status: 599, text: '', headers: {} }
    },
    proxyUrl: () => '',
    applyProxy() {},
    cachedSourceIdsAll: () => [],
    registerProxyPartition() {},
    registerSrcCacheProvider() {},
    broadcastSrcCache() {},
    SESSION_PARTITION: 'persist:pl'
  },
  'src/main/services/source.ts': {
    sourceFor: () => ({
      invalidatePlay: (uid) => world.invalidate.push(uid),
      // L 段要看得见处理器"传下来了什么": 强制位与档级是这个文件的唯一真值处, 替身若把参数丢了,
      // 断言就退化成"确实调用过" —— 那是恒真。每次调用记一条, 返回值给一份带自增令牌的包(两次的 m3u8 必然不同)
      getPlayCached: async (uid, pwd, force, fullV) => {
        const fail = world.playFails > 0
        if (fail) world.playFails--
        else world.playSeq++
        world.playCalls.push({ uid, force: !!force, fullVariants: !!fullV, fail })
        return fail
          ? { ok: false, error: 'playFail(sim)', needLogin: true }
          : { ok: true, m3u8: `https://mock/x${world.playSeq}.m3u8`, variants: [{ url: `https://mock/x${world.playSeq}.m3u8`, bandwidth: 0 }], fetchedAt: Date.now() }
      },
      // 秒开快道是播放器那一条的入口。替身同样把收到的参数原样记账(force 位是 L 段的真值处),
      // 并标上 fast: 处理器若改回直连 getPlayCached, L1b 会看见 fast=false 而红 —— 参数账不许被合并成一条
      getPlayFast: async (uid, pwd, force) => {
        const fail = world.playFails > 0
        if (fail) world.playFails--
        else world.playSeq++
        world.playCalls.push({ uid, force: !!force, fast: true, fail })
        return fail
          ? { ok: false, error: 'playFail(sim)', needLogin: true }
          : { ok: true, m3u8: `https://mock/x${world.playSeq}.m3u8`, variants: [{ url: `https://mock/x${world.playSeq}.m3u8`, bandwidth: 0 }], fetchedAt: Date.now() }
      },
      fetchPlay: async () => ({ ok: true }),
      // 处理器交下来的两个入参一律记账: 亲证地址(deadUrl)是"对一遍才摘"的那一格,
      // 替身若把它吞掉, 处理器里少传一位就没人看得见(与上面 getPlayCached 那两格同一条规矩)
      dropCachedPlay: (uid, dead) => {
        world.deadCalls.push({ uid, dead })
        return world.deadDrops
      }
    }),
    applyPlayMeta() {}
  },
  'src/main/services/store.ts': { store: baseStore },
  'src/main/services/authWin.ts': { openLoginWindow: async () => ({ ok: false, message: '' }) },
  'src/main/services/vault.ts': { vault: { get: () => null, set() {}, remove() {}, load: () => null, save() {}, clear() {} }, CookieJar: class {} },
  'src/main/services/telegram.ts': { tgSendMessage: async () => ({ ok: true }) },
  'src/main/services/thumbs.ts': { thumbs: { enqueue() {}, remove() {}, stopChildren() {} } },
  'src/main/services/recorder.ts': {
    recorder: {
      start: async (t) => {
        world.recStarts.push(t)
      },
      stop: async () => {},
      stopAll: async () => {},
      list: () => []
    }
  },
  'src/main/services/notify.ts': { sendToast: (t, c) => world.toasts.push({ t, c }) },
  'src/main/services/logger.ts': {
    logger: {
      info: (tag, msg) => world.logInfo.push(String(msg)),
      warn: (tag, msg) => world.logWarn.push(String(msg)),
      error: (tag, msg) => world.logWarn.push(String(msg)),
      debug() {},
      flush() {}
    }
  },
  'src/main/services/secrets.ts': {
    secrets: {
      map: new Map(),
      get(k) {
        return this.map.get(k) || ''
      },
      set(k, v) {
        this.map.set(k, v)
      }
    }
  },
  // F 段要让取流链跑到"拉源成功"才有东西可断言: 代理在这里只做地址换算, 不起真端口。
  // 补: 地址里的端口/令牌跟着 world.proxyGen 走 —— 真代理每实例一套(随机口 + 重随机令牌),
  // 替身若固定成一串, "留存必须存上游而不是存代理地址"那一条就测不出差别(恒真的绿)
  'src/main/services/hlsProxy.ts': {
    HlsProxy: class {
      constructor() {
        this.gen = world.proxyGen
      }
      async listen() {}
      playlistUrl(upstream) {
        return `http://127.0.0.1:${9100 + this.gen}/x?t=g${this.gen}&url=` + encodeURIComponent(upstream)
      }
      close() {}
      // soopApi.diag 最后要问代理这一格, 替身没有这一句就是"整页诊断投影在本套里根本调不动" ——
      // 形状照抄 hlsProxy.ts:137 那一份, 数值全给"没起过的实例"(本替身确实没起过端口)
      diag() {
        return { up: false, port: 0, origins: 0, maxOrigins: 0, inflight: 0, mergedPlays: 0, mergedSegs: 0 }
      }
    }
  },
  'src/main/util.ts': {
    UA: 'TEST-UA',
    // C2: 这三根针原本都指在 ROOT(仓库根), 现指本套独有的临时目录 —— 替身哪天换成真 store,
    // 落盘也落在 mkdtemp 里, 不会写到用户的 data/db.json。getAppPath 仍指 ROOT: 那是找源码/资源的路, 不是写口
    dataDir: () => SANDBOX,
    defaultRecordRoot: () => SANDBOX,
    diskFreeGb: () => 999,
    redirectElectronDataDir() {},
    scanTaskMedia: () => [],
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1)))
  },
  'src/main/i18n.ts': { mt: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), setMainLocale() {} }
}

// ---------- TS 即时编译加载 ----------
// 替身按"仓库内模块路径"命中(../util 与 ./util 都归一到 src/main/util.ts),
// 未替身的源码间互引照常加载真实文件 —— watcher/soop/ipc 必须共用同一个 soopApi/watcher 单例
const moduleCache = new Map()
function loadTs(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel).exports
  const file = path.join(ROOT, rel)
  const js = transform(fs.readFileSync(file, 'utf8'), { transforms: ['typescript', 'imports'], filePath: file }).code
  const m = { exports: {} }
  moduleCache.set(rel, m)
  const from = path.posix.dirname(rel.replace(/\\/g, '/'))
  const localRequire = (id) => {
    if (!id.startsWith('.')) return Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : require(id)
    const target = path.posix.normalize(`${from}/${id}`).replace(/^\.\//, '')
    const withTs = target.endsWith('.ts') ? target : `${target}.ts`
    if (Object.prototype.hasOwnProperty.call(mocks, withTs)) return mocks[withTs]
    if (fs.existsSync(path.join(ROOT, withTs))) return loadTs(withTs)
    return require(id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, localRequire, m, file, path.dirname(file))
  return m.exports
}

const types = loadTs('src/shared/types.ts')
const { soopApi } = loadTs('src/main/services/soop.ts')
const { watcher } = loadTs('src/main/services/watcher.ts')
const { CH } = types
// Panda 关注列表要验真实客户端(请求面/分页/降级/字段解析), 限速设到地板值以免脚本变慢
realPandaApi = loadTs('src/main/services/pandalive.ts').api
realPandaApi.setGap(300)

// ---------- 真实抓包样本(2026-09-29, 字段名与形状原样保留, 值做脱敏) ----------
const LIVE_ROW = {
  favorite_no: 1,
  user_id: 'aaa111',
  user_nick: '主播甲',
  is_live: true,
  is_pin: false,
  total_cnt: 2,
  last_broad_start: '2026-09-28 20:11',
  broad_info: [
    {
      broad_no: '12345678',
      broad_title: '在播标题',
      broad_start: '2026-09-29 22:01',
      broad_img: '//liveimg.sooplive.com/h/12345678.jpg',
      url: 'play.sooplive.com/aaa111/12345678',
      is_adult: true, // 平台写着 true —— 解析层也不读它(见 B6), 留着这一格正是为了证明"读了也不取"
      is_password: false,
      pc_view_cnt: 30,
      mobile_view_cnt: 45,
      total_view_cnt: 75
    }
  ]
}
const OFF_ROW = { favorite_no: 2, user_id: 'bbb222', user_nick: '主播乙', is_live: false, last_broad_start: '2026-09-27 10:00:00', broad_info: [] }
const bodyOf = (rows, extra = {}) => JSON.stringify({ data: rows, pool_check: null, total_cnt: rows.length, ...extra })

function reset() {
  world.favStatus = 200
  world.favBody = ''
  world.favDelayMs = 0
  world.pageMode = 'live'
  world.pageFail = false
  world.pageBno = null
  world.apiChannel = null
  world.assign = 'https://livecast.sooplive.com/12345678-common-hd-1000.ts?limit=0&sid=x'
  world.bmPages = []
  world.bmStatus = 200
  world.bjBody = null // member/bj 那一格的应答同样一场一份
  // 校验证的应答与延迟同样一场一份; 登录态的结果缓存/在飞表也一并清 ——
  // 留着上一场那一份, 下一场的第一问就会读成「缓存」或「合并」, 而那正是本节要断言的字样
  world.loginChannel = { LOGIN_ID: 'soopuser11', LOGIN_NICK: '主播甲' }
  world.loginStatus = 200
  world.loginDelayMs = 0
  // Panda 那三格同样一场一份; 真客户端的结果缓存/在飞表跨场景不清就会让下一场的第一行读成「缓存」或「合并」
  world.pandaLi = { userInfo: { isLogin: true, isAdult: true, idx: 1001 } }
  world.pandaLoginDelayMs = 0
  world.pandaLiThrow = false
  world.pandaSession = false
  realPandaApi.loginInfoCache = null
  realPandaApi.loginInfoInflight = null
  soopApi.loginCache.clear()
  soopApi.loginInflight.clear()
  world.fetches.length = 0
  world.liCalls.length = 0
  world.deadCalls.length = 0
  world.deadDrops = true
  world.cookieWrites.length = 0
  world.jar.length = 0
  world.toasts.length = 0
  world.recStarts.length = 0
  world.invalidate.length = 0
  world.logInfo.length = 0
  world.logWarn.length = 0
  world.anchors = []
  anchorWrites.length = 0 // 门槛账的落盘写次跨场景不清 = 下一场数到的上一场的写
  world.playCalls.length = 0
  world.playSeq = 0
  world.playFails = 0
  world.proxyGen = 1
  watcher.soopFailStreak = 0
  // 「待第二轮确认」那一格原来是一本进程内存表(必须在这里显式清), 现在落在锚点行上 ——
  // 上面那句 world.anchors = [] 就是清账: 每个场景重新造行, 行上没有那一格
  soopApi.invalidateCookieCache()
  // 托管账密那两格也是跨场景状态: 留着上一场那双账号, 下一场"没托管所以记门槛账"那一格就测不出来
  mocks['src/main/services/secrets.ts'].secrets.map.clear()
  // 兜底重发的出声窗口也是跨场景状态: 不清会让下一场的"第一句"永远出不来
  soopApi.fallbackCnt = 0
  soopApi.fallbackLogUntil = 0
  // 两处微缓存也是跨场景状态: 不清就会让下一场"读到"上一场的场次号/旧页, 断言变成继承
  soopApi.bnoCache.clear()
  soopApi.pageCache.clear()
  soopApi.pageInflight.clear()
  // 源缓存/在飞链/判死计数同样是跨场景状态(清缓存即纪元整体前移, 顺带挡住上一场的在飞链)
  soopApi.clearPlayCache()
}

const anchor = (over = {}) => ({
  platform: 'soop',
  userId: 'aaa111',
  userIdx: null,
  nick: '',
  userImg: '',
  isLive: false,
  title: '',
  tags: null,
  startTime: '',
  viewerCount: 0,
  likes: 0,
  fans: 0,
  thumbUrl: '',
  autoRecord: false,
  addedAt: 1,
  lastSeenAt: 0,
  ...over
})
const findAnchor = (uid) => world.anchors.find((a) => a.userId === uid)
/** 本轮发过的"播放页探针"次数(按 URL 里的频道名计) */
const pageProbes = () => world.fetches.filter((f) => !String(f.url).includes('myapi')).length
/** 某个频道的整页 HTML 发数: bno 复用与页面微缓存的唯一读数就是"还要不要为拿号读一页" */
const pageHits = (ch) => world.fetches.filter((f) => String(f.url) === `https://play.sooplive.com/${ch}`).length
/** player_live_api.php 的发数(可按 type 分: live=主信息, aid=清晰度凭证) */
const apiHits = (type) => world.fetches.filter((f) => String(f.url).includes('player_live_api.php') && (!type || String(f.body).includes('type=' + type))).length
/** 第 n 发主信息带的场次号(证明复用的就是列表那一个, 不是重新读出来的) */
const apiBno = (i = 0) => {
  const posts = world.fetches.filter((f) => String(f.url).includes('player_live_api.php') && String(f.body).includes('type=live'))
  const m = /(?:^|&)bno=([^&]*)/.exec(String(posts[i]?.body || ''))
  return m ? decodeURIComponent(m[1]) : ''
}

// ============ A: 关注列表客户端 ============
console.log('A1 fetchFavorites 的请求面(Origin 必为 www)')
reset()
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
let rows = await soopApi.fetchFavorites()
const favReq = world.fetches.find((f) => String(f.url).includes('myapi'))
assert(favReq && favReq.url === 'https://myapi.sooplive.com/api/favorite', '命中 myapi/favorite 端点')
assert(favReq.headers.Origin === 'https://www.sooplive.com', 'Origin 报 www(play 域会被服务端 CORS 拒)', `实际=${favReq.headers.Origin}`)
assert(favReq.headers.Referer === 'https://www.sooplive.com/', 'Referer 停在 www 源根(跨源带完整路径会被 Chromium 取消请求)', `实际=${favReq.headers.Referer}`)
assert(rows && rows.length === 2, '两条关注解析成两行')

console.log('A2 真实形状解析')
reset()
world.favBody = bodyOf([[LIVE_ROW], [OFF_ROW]]) // 建了分组时 data 是嵌套数组
rows = await soopApi.fetchFavorites()
assert(rows && rows.length === 2, '分组嵌套 data 摊平后仍是两条')
const live = rows && rows.find((r) => r.userId === 'aaa111')
assert(live && live.isLive && live.live && live.live.broadNo === '12345678', '在播行带场次号')
assert(live.live.startTime === '2026-09-29 22:01:00', '分钟精度开播时刻补齐到秒', `实际=${live.live.startTime}`)
assert(live.live.thumbUrl === 'https://liveimg.sooplive.com/h/12345678.jpg', '截图补 https: 协议')
assert(live.live.viewers === 75, '人数=pc+mobile', `实际=${live.live.viewers}`)
assert(live.live.isAdult === undefined && live.live.isPw === false, '行里写着 is_adult=true 也不进内部行(SOOP 不取房间级 19+), 密码房旗按原值')
const off = rows && rows.find((r) => r.userId === 'bbb222')
assert(off && !off.isLive && off.live === null && off.lastStartTime === '2026-09-27 10:00:00', '离线行不编造场次, 保留上次开播')

console.log('A3 列表不可用一律降级为 null(绝不回"全都下播")')
for (const [name, cfg] of [
  ['515 未登录', () => ((world.favStatus = 515), (world.favBody = '{"code":-10000}'))],
  ['403 Origin 被拒', () => ((world.favStatus = 403), (world.favBody = 'Not allowed in CORS policy.'))],
  ['200 非 JSON(风控页)', () => ((world.favStatus = 200), (world.favBody = '<html>captcha</html>'))],
  ['200 缺 data 数组', () => ((world.favStatus = 200), (world.favBody = '{"result":"ok"}'))],
  ['200 全条缺 user_id', () => ((world.favStatus = 200), (world.favBody = bodyOf([{ is_live: false }, { is_live: true }])))]
]) {
  reset()
  cfg()
  const r = await soopApi.fetchFavorites()
  assert(r === null, `${name} → null`)
}
reset()
world.favStatus = 200
world.favBody = bodyOf([{ user_id: '../../evil', is_live: false }, OFF_ROW])
rows = await soopApi.fetchFavorites()
assert(rows && rows.length === 1 && rows[0].userId === 'bbb222', '路径穿越 ID 只丢那一条, 其余照常')
reset()
world.favStatus = 200
world.favBody = bodyOf([{ user_id: 'a'.repeat(90), is_live: false }, OFF_ROW])
rows = await soopApi.fetchFavorites()
assert(rows && rows.length === 1, '超长 ID 同样被 isRoomId 拦下')

console.log('A5 "说在播却没给场次" = 状态未知, 交调用方回落')
reset()
world.favBody = bodyOf([{ ...LIVE_ROW, broad_info: [] }])
rows = await soopApi.fetchFavorites()
assert(rows && rows[0].isLive === true && rows[0].live === null, 'is_live=true + broad_info 空 → live=null')

// ============ B: roundSoop 列表模式 ============
const runRound = () => watcher.roundSoop(world.anchors.slice(), 0)

console.log('B1 命中列表: 零探针落状态 + 开播通知一次')
reset()
world.anchors = [anchor()]
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
let found = await runRound()
assert(found === 1, '在播数=1')
assert(pageProbes() === 0, '列表命中后一发播放页都不发', `实际=${pageProbes()}`)
const a = findAnchor('aaa111')
assert(a.isLive && a.nick === '主播甲' && a.title === '在播标题', '昵称/标题来自列表')
assert(a.startTime === '2026-09-29 22:01:00', '开播时刻取列表原值(播放页根本没有这个字段)')
assert(a.viewerCount === 75 && a.thumbUrl.startsWith('https://liveimg'), '人数/截图一并落卡')
assert(a.tags && a.tags.isAdult === false && a.tags.liveType === 'live', '标签落卡: 场次属性按原值, 而房间级 19+ 恒不取(行里写着 true 也不落)')
assert(a.userImg === 'https://stimg.sooplive.com/LOGO/aa/aaa111/aaa111.jpg', '空头像由这一轮补齐: SOOP 的列表行没有任何图片字段, 地址就是频道 ID 的函数(零请求)')
assert(world.toasts.filter((t) => t.t.type === 'live').length === 1, '离线→在播发一次开播通知')
assert(world.invalidate.length === 1, '开播即作废旧源')

console.log('B1b 头像补齐只认空槽, 已有的一概不覆写')
reset()
world.anchors = [anchor({ userId: 'bbb222', nick: '乙', userImg: 'https://stimg.sooplive.com/LOGO/bb/bbb222/old.jpg' })]
world.favBody = bodyOf([OFF_ROW])
await runRound()
assert(findAnchor('bbb222').userImg === 'https://stimg.sooplive.com/LOGO/bb/bbb222/old.jpg', '已有头像保持原值(每轮无谓覆写=每轮一次整库落盘)')

console.log('B2 兜底范围: 只探列表覆盖不到的房')
reset()
world.anchors = [anchor(), anchor({ userId: 'off-list', nick: '站外关注' })]
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
await runRound()
assert(world.fetches.filter((f) => !String(f.url).includes('myapi')).length === 1, '仅"不在列表里"的那 1 个房发探针')
assert(world.fetches.some((f) => String(f.url).includes('off-list')), '探针打的是那个房')
reset()
world.anchors = [anchor(), anchor({ userId: 'off-list' })]
world.favStatus = 515
world.favBody = '{"code":-10000}'
found = await runRound()
assert(pageProbes() === 2, '整表拿不到 → 全部回落逐房探针(旧行为)', `实际=${pageProbes()}`)
assert(found === 2, '探针模式照常统计在播')

console.log('B3 下播要连续两轮确认; 房间属性与场次属性分家')
reset()
// lastSeenAt=0 是"证明不了陈旧"那一支(旧库/没写过): 两轮防抖照旧 —— 陈旧基线第一轮翻的那一支见 B3b
world.anchors = [anchor({ isLive: true, title: '在播标题', startTime: '2026-09-29 22:01:00', tags: { isAdult: false, isPw: true, type: '', liveType: 'live' } })]
world.favBody = bodyOf([{ ...LIVE_ROW, is_live: false, broad_info: [] }])
await runRound()
assert(findAnchor('aaa111').isLive === true, '第一轮说离线: 状态不动')
assert(world.toasts.filter((t) => t.t.type === 'offline').length === 0, '第一轮不发下播通知')
await runRound()
assert(findAnchor('aaa111').isLive === false, '第二轮才判下播')
assert(world.toasts.filter((t) => t.t.type === 'offline').length === 1, '第二轮发一次下播通知')
const offCard = findAnchor("aaa111")
assert(offCard.title === '' && offCard.viewerCount === 0 && offCard.thumbUrl === '' && offCard.startTime === '', '下播后场次字段清空')
assert(offCard.tags !== null && offCard.tags?.isPw === false && offCard.tags?.liveType === '', 'SOOP 的离线卡: 这一场的属性(密码房/回放)清掉, 而对象不写成 null —— 清的是场次, 不是房间')
// offPatch 两平台共用, "房间属性留、场次属性清"真正为 Panda 服务(SOOP 不带房间级 19+/粉丝团), 故按 Panda 那一档形状直调一次
const pandaOff = watcher.offPatch({ tags: { isAdult: true, isPw: true, type: 'fan', liveType: 'live' } })
assert(pandaOff.tags?.isAdult === true && pandaOff.tags?.type === 'fan', 'Panda 形状: 房间属性(19+/粉丝团)下播后保留, 它是房间的属性不是这一场的')
assert(pandaOff.tags?.isPw === false && pandaOff.tags?.liveType === '', 'Panda 形状: 场次属性(密码房/回放)随场次结束清掉')

console.log('B3b 陈旧基线(冷启动/长停)第一轮就翻状态, 但不发那场"下播"')
reset()
// 现场形状: 应用停摆几小时后醒来, 卡上还挂着上一场的 isLive=true, 而 lastSeenAt 是两个轮距之前(阈值 2×120s)
world.anchors = [anchor({ isLive: true, nick: '主播甲', title: '在播标题', startTime: '2026-09-29 22:01:00', lastSeenAt: Date.now() - 30 * 60_000 })]
world.favBody = bodyOf([{ ...LIVE_ROW, is_live: false, broad_info: [] }])
await runRound()
assert(findAnchor('aaa111').isLive === false, 'B3b1 陈旧基线遇到第一轮离线读数即翻状态(旧写法要再等一个轮距才落地, 而平台那句读数本来就报的是离线)')
assert(world.toasts.filter((t) => t.t.type === 'offline').length === 0, 'B3b2 不发下播通知: 那场散于应用停摆期间, 我们根本没在场, 报"刚刚下播"是把旧账当现值')
assert(findAnchor('aaa111').offlinePendingAt === 0, 'B3b3 那一格当场收账(它现在落在行上, 留着=预取泵白挡一间+下一场少排一轮)')
assert(pageProbes() === 0, 'B3b4 判这一件事用的还是那一发整表: 零增量请求')
reset()
// 新基线(刚刚才被读过)同一句读数仍走两轮 —— 豁免只给"证明得了陈旧"的那一支
world.anchors = [anchor({ isLive: true, title: '在播标题', startTime: '2026-09-29 22:01:00', lastSeenAt: Date.now() })]
world.favBody = bodyOf([{ ...LIVE_ROW, is_live: false, broad_info: [] }])
await runRound()
assert(findAnchor('aaa111').isLive === true && findAnchor('aaa111').offlinePendingAt > 0, 'B3b5 新基线照旧两轮防抖(瞬回离线的抖动仍拦得住, 时效一点没让)')
await runRound()
assert(findAnchor('aaa111').isLive === false && world.toasts.filter((t) => t.t.type === 'offline').length === 1, 'B3b6 第二轮才翻, 且那一次通知照发(它真是我们看着散的那场)')
assert(findAnchor('aaa111').offlinePendingAt === 0, 'B3b7 确认轮把那一格销掉(行上的账不销就会活到下一场)')

console.log('B3c 逐房探针那一发撞上旧账: 同样第一轮翻状态、不发那场下播')
reset()
world.anchors = [anchor({ userId: 'off-list', isLive: true, lastSeenAt: Date.now() - 30 * 60_000 })]
world.favStatus = 515
world.favBody = '{"code":-10000}' // 整表不接待 ⇒ 这一间走逐房播放页探针(另一条读数面)
world.pageMode = 'offline'
await runRound()
assert(findAnchor('off-list').isLive === false, 'B3c1 探针报"明确未播" + 陈旧基线 = 第一轮就翻(与列表那一条同判据, 不看读数从哪条链来)')
assert(world.toasts.filter((t) => t.t.type === 'offline').length === 0, 'B3c2 同样不发下播通知')
assert(pageProbes() === 1, 'B3c3 用的还是那一发探针: 零增量请求', `实发=${pageProbes()}`)

console.log('B3d 读回在播就把那一格收回: 整表面与探针面各一个写点(旧形状是 map.delete, 落库以后必须写 0)')
reset()
world.anchors = [anchor({ isLive: true, title: '在播标题', startTime: '2026-09-29 22:01:00', lastSeenAt: Date.now(), offlinePendingAt: Date.now() - 60_000 })]
world.favBody = bodyOf([LIVE_ROW])
await runRound()
assert(findAnchor('aaa111').isLive === true && findAnchor('aaa111').offlinePendingAt === 0, 'B3d1 整表读回在播: 那句"平台说这一场散了"被下一发推翻, 账当场收回(不收回=预取泵白挡一间+下一场的第一轮离线被当第二轮直接宣判)')
reset()
world.anchors = [anchor({ userId: 'off-list', isLive: true, lastSeenAt: Date.now(), offlinePendingAt: Date.now() - 60_000 })]
world.favStatus = 515
world.favBody = '{"code":-10000}' // 整表不接待 ⇒ 这一间走逐房播放页探针(另一条读数面)
world.pageMode = 'live'
await runRound()
assert(findAnchor('off-list').isLive === true && findAnchor('off-list').offlinePendingAt === 0, 'B3d2 探针读回在播: 同一句收回写在同一个位置, 两条链不许各留一本账')

console.log('B4 已在播不重复通知; 离线房昵称跟进; 状态未知的房回落探针')
reset()
world.anchors = [anchor({ isLive: true, nick: '主播甲', startTime: '2026-09-29 22:01:00' }), anchor({ userId: 'bbb222', nick: '' })]
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
await runRound()
assert(world.toasts.length === 0, '持续在播/持续离线都不发通知')
assert(findAnchor('bbb222').nick === '主播乙', '离线房昵称由列表跟进')
reset()
world.anchors = [anchor()]
world.favBody = bodyOf([{ ...LIVE_ROW, is_live: true, broad_info: [] }])
await runRound()
assert(pageProbes() === 1 && findAnchor('aaa111').isLive === true, '"说在播却没给场次" 的那一个回落探针并落在播')
reset()
world.anchors = [anchor({ isLive: true })]
world.favStatus = 515
world.favBody = '{}'
world.pageMode = 'broken'
await runRound()
assert(findAnchor('aaa111').isLive === true && world.toasts.length === 0, '探针既没给场次也没说下播(风控页)时保持上次已知状态, 不发通知')

console.log('B5 失明计数只看"全部关注都读不到"')
reset()
world.anchors = [anchor({ userId: 'off-list' })]
world.favStatus = 515
world.favBody = '{}'
world.pageFail = true
await runRound()
assert(watcher.soopFailStreak === 1, '未登录且探针全灭: 第一轮计 1')
await runRound()
assert(watcher.soopFailStreak === 2, '连续两轮跨阈值')
assert(world.toasts.filter((t) => t.t.type === 'error').length === 1, '跨阈值只出声一次')
reset()
world.anchors = [anchor(), anchor({ userId: 'off-list' })]
world.favBody = bodyOf([LIVE_ROW])
world.pageFail = true
await runRound()
await runRound()
assert(watcher.soopFailStreak === 0, '列表覆盖到一部分关注时, 兜底房全灭不累计成"平台失明"')

console.log('B6 SOOP 全链路不取房间级 19+; 密码房旗仍是三态')
const NO_PW = { ...LIVE_ROW, broad_info: [{ ...LIVE_ROW.broad_info[0], is_password: undefined }] } // JSON 里就是"没这个键"
reset()
world.anchors = [anchor({ isLive: true, tags: { isAdult: true, isPw: false, type: '', liveType: 'live' }, startTime: '2026-09-29 22:01:00' })]
world.favBody = bodyOf([LIVE_ROW]) // 行里 is_adult: true / is_password: false
await runRound()
assert(findAnchor('aaa111').tags.isAdult === false, '列表写着 is_adult=true 也不落卡: 这一路根本不读这一格')
assert(findAnchor('aaa111').tags.isAdult === false && findAnchor('aaa111').tags.isPw === false, '旧轮次残留的 19+ 被这一轮清掉: 卡片、页头与 TG 自此不画 19+')
assert(!('soopBlindAdult' in watcher), '盲读诊断随这一格一起绝迹(它当年就是为了分清"平台没带"与"我们读错键", 现已无对象可诊断)')
reset()
world.anchors = [anchor({ isLive: true, tags: { isAdult: false, isPw: true, type: '', liveType: 'live' }, startTime: '2026-09-29 22:01:00' })]
world.favBody = bodyOf([NO_PW])
await runRound()
assert(findAnchor('aaa111').isLive === true && findAnchor('aaa111').tags.isPw === true, '单轮没带 is_password: 密码房沿用上一轮而不是塌成 false')
reset()
world.anchors = [anchor({ isLive: true, tags: { isAdult: false, isPw: true, type: '', liveType: 'live' }, startTime: '2026-09-29 22:01:00' })]
world.favBody = bodyOf([{ ...LIVE_ROW, broad_info: [{ ...LIVE_ROW.broad_info[0], is_password: false }] }])
await runRound()
assert(findAnchor('aaa111').tags.isPw === false, '平台明确回 false: 当轮就改口(三态不是"只进不退")')

// ============ C: 登录态持久化 ============
console.log('C1 storeCookies 必带期限')
reset()
const n = await soopApi.storeCookies('UserTicket=abc; AuthTicket=def; PREFIX=grp')
assert(n === 3, '三枚 Cookie 落罐')
assert(world.cookieWrites.every((c) => Number.isFinite(c.expirationDate) && c.expirationDate > Date.now() / 1000), '每枚都带 expirationDate(会话 Cookie 重启即丢)', JSON.stringify(world.cookieWrites[0]))

console.log('C2/C3 persistSessionCookies 的取舍')
reset()
await soopApi.storeCookies('UserTicket=abc')
world.cookieWrites.length = 0
world.jar.push(
  { name: 'SessOnly', value: 'v', domain: '.sooplive.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: undefined },
  { name: 'HostSess', value: 'v', domain: 'www.sooplive.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: undefined },
  { name: 'Already', value: 'v', domain: '.sooplive.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 9999 },
  { name: 'Foreign', value: 'v', domain: '.other-site.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: undefined }
)
const converted = await soopApi.persistSessionCookies()
assert(converted === 2, '只转无期限的 sooplive.com 条目(全域 + 主机各一枚)', `实际=${converted}`)
assert(!world.cookieWrites.some((c) => c.name === 'UserTicket'), 'storeCookies 已带期限的凭证不重写')
assert(!world.cookieWrites.some((c) => c.name === 'Already'), '已带期限的不重写')
assert(!world.cookieWrites.some((c) => c.name === 'Foreign'), '外域 Cookie 不碰')
const written = world.cookieWrites.find((c) => c.name === 'SessOnly')
assert(written && Number.isFinite(written.expirationDate) && written.domain === '.sooplive.com', '转持久写回同一域/同名')
assert(world.jar.find((c) => c.name === 'SessOnly' && c.expirationDate), '罐内该条已带期限')

console.log('C3 网页登录链路把转持久接上了')
const authWinSrc = fs.readFileSync(path.join(ROOT, 'src/main/services/authWin.ts'), 'utf-8')
assert(/persistSessionCookies\s*\(\s*\)/.test(authWinSrc), 'authWin 的 SOOP probe 登录成功后调用 persistSessionCookies')

// ============ D: 导入 IPC ============
console.log('D1 anchorsImportSoop 的落库语义')
const { registerIpc } = loadTs('src/main/ipc.ts')
registerIpc()
const importHandler = world.ipc[CH.anchorsImportSoop]
assert(typeof importHandler === 'function', 'IPC 通道已注册')
reset()
world.favBody = bodyOf([LIVE_ROW, OFF_ROW, { ...OFF_ROW, user_id: 'ccc333' }, { ...OFF_ROW, user_id: 'ccc333' }])
world.anchors = [anchor({ userId: 'bbb222', nick: '已在库' })]
const res = await importHandler()
assert(res.total === 4 && res.added === 2, `只增不改: 已在库的 bbb222 跳过, 列表内重复的 ccc333 只算一次, added=${res.added}`)
assert(world.anchors.filter((x) => x.userId === 'ccc333').length === 1, '列表内重复项在库内只有一条')
assert(findAnchor('bbb222').nick === '已在库' && findAnchor('bbb222').isLive === false, '已在库的记录不被列表值覆盖(只增不改)')
const na = findAnchor('aaa111')
assert(na && na.isLive && na.nick === '主播甲' && na.title === '在播标题', '在播行按列表原值建卡')
assert(na.viewerCount === 75 && na.startTime === '2026-09-29 22:01:00' && na.tags.isAdult === false && na.tags.liveType === 'live', '人数/开播时刻一次到位; 导入的出生行也不带房间级 19+(SOOP 全链路不取)')
assert(na.userImg === 'https://stimg.sooplive.com/LOGO/aa/aaa111/aaa111.jpg' && findAnchor('ccc333').userImg === 'https://stimg.sooplive.com/LOGO/cc/ccc333/ccc333.jpg', '导入的卡在落库那刻就带头像(在播与离线一样, 不必等一轮轮询)')
assert(na.autoRecord === false, '批量导入不开自录(几十路并发录制=磁盘与风控灾难)')
assert(world.anchors.filter((x) => x.platform === 'soop').length === 3, '离线房同样入墙(全量导入)')
reset()
world.favStatus = 515
world.favBody = '{"code":-10000}'
world.anchors = []
let thrown = null
try {
  await importHandler()
} catch (e) {
  thrown = e
}
assert(thrown && /importFail/.test(thrown.message), '未登录时报错, 不静默"导入 0 条"', thrown && thrown.message)
assert(world.anchors.length === 0, '失败路径一条都不落库')

console.log('D3 反向差值: 只标注「站内已取关」, 一条都不删(决策 D3)')
reset()
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
world.anchors = [
  anchor({ userId: 'bbb222', nick: '仍在站内' }),
  anchor({ userId: 'gone1', nick: '站内取关', siteGone: false }),
  anchor({ userId: 'fresh', nick: '从未同步' }),
  anchor({ platform: 'pandalive', userId: 'aaa111', nick: '对面平台同名房' })
]
const rGone = await importHandler()
const soopOf = (uid) => world.anchors.find((a) => a.platform === 'soop' && a.userId === uid)
assert(rGone.siteGone === 2, `站内没有的本地关注被标注, siteGone=${rGone.siteGone}`)
assert(findAnchor('gone1').siteGone === true && findAnchor('fresh').siteGone === true, '取关标注落在缺房的记录上')
assert(world.anchors.length === 5, '墙上少一个房间都没有发生(只标注不删墙)', `实际=${world.anchors.length}`)
assert(soopOf('bbb222').siteGone !== true, '站内列表里还在的不打标')
assert(soopOf('aaa111').siteGone !== true, '本次由列表新建的在播房不带标注')
assert(
  world.anchors.find((a) => a.platform === 'pandalive' && a.userId === 'aaa111').siteGone === undefined,
  '对面平台的同名房间不受本轮差值影响(主键是平台+ID, 不是裸 ID)'
)
world.favBody = bodyOf([LIVE_ROW, OFF_ROW, { ...OFF_ROW, user_id: 'gone1' }])
const rBack = await importHandler()
assert(rBack.siteGone === 0 && findAnchor('gone1').siteGone === false, '重新被站内列表带回 → 标注清掉, 增量计数归零')
assert(findAnchor('fresh').siteGone === true, '上一轮已标注的这轮不重复计数')

console.log('D2 桥接与界面接线')
assert(/anchorsImportSoop/.test(fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf-8')), 'preload 暴露 anchorsImportSoop')
assert(/anchorsImportSoop\(\): Promise<FollowImportResult>/.test(fs.readFileSync(path.join(ROOT, 'src/shared/types.ts'), 'utf-8')), 'ApiBridge 声明 anchorsImportSoop')
// 一期把「已关注」并进了工作区直播页: 导入入口现在是当前平台的那一颗「同步站内关注」
const wsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/views/WorkspaceView.vue'), 'utf-8')
assert(/api\.anchorsImportSoop\(\)/.test(wsSrc) && /api\.anchorsImportPanda\(\)/.test(wsSrc), '直播页按平台接上了两边导入')
assert(/loggedIn/.test(wsSrc) && /anchorsImportSoop\(\) : await api\.anchorsImportPanda/.test(wsSrc), '未登录时不给导入入口(避免"导入 0 条"的假成功)')
for (const loc of ['zh-CN', 'en-US']) {
  const src = fs.readFileSync(path.join(ROOT, `src/renderer/src/i18n/locales/${loc}.ts`), 'utf-8')
  assert(/syncFollows:/.test(src) && /imported:/.test(src) && /importConfirm/.test(src), `${loc} 有导入文案`)
}

// ============ E: Panda 站内关注(북마크)列表 ============
// 真实抓包样本(2026-09-29 www.pandalive.co.kr/pick/bookmark: 158 关注, 其中 13 条带 media)
const BM_LIVE = {
  channelTitle: '19ㅂ) 자연쮸',
  userNick: 'ෆ점핑ෆ',
  userIdx: 25780534,
  userId: 'mayonz',
  thumbUrl: 'https://cdn.pandalive.co.kr/upload/live/25780534.jpg',
  thumbUrlOrigin: 'https://cdn.pandalive.co.kr/upload/live/25780534_o.jpg',
  dateTime: '2025-12-12 23:12:29',
  userImg: 'https://cdn.pandalive.co.kr/upload/user/25780534.jpg',
  isBookmark: true,
  media: {
    code: '25780534_202609290972d8dece3aaa52',
    title: '19ㅂ) 자연쮸',
    titleJa: '天然おっぱい',
    userId: 'mayonz',
    userIdx: 25780534,
    userNick: 'ෆ점핑ෆ',
    category: 'ind',
    isAdult: true,
    isPw: false,
    type: 'free',
    user: 28,
    userLimit: 1000,
    startTime: '2026-09-29 18:52:55',
    endTime: '0000-00-00 00:00:00',
    isLive: true,
    onAirType: 'live',
    liveType: 'live',
    playCnt: 1234,
    likeCnt: 88,
    fanCnt: 9,
    bookmarkCnt: 158,
    thumbUrl: 'https://cdn.pandalive.co.kr/upload/live/25780534.jpg',
    userImg: 'https://cdn.pandalive.co.kr/upload/user/25780534.jpg'
  }
}
const BM_OFF = {
  channelTitle: '.',
  userNick: 'tt258',
  userIdx: 1007,
  userId: 'icubi69',
  thumbUrl: 'https://cdn.pandalive.co.kr/upload/noimg/user/noimg_F1.jpg',
  dateTime: '2024-12-08 15:34:26',
  userImg: '',
  isBookmark: true
}
const bmPage = (list, total = list.length) => ({ list, page: { offset: 0, limit: 200, total, page: 1, lastPage: 1 }, result: true, message: null, userIp: '1.2.3.4' })

console.log('E1 Panda 关注列表的请求面(POST /v1/live/bookmark + 会话 Cookie)')
reset()
realPandaApi.jar = { sessKey: 'test-sess', siteLang: 'ko' }
world.bmPages = [bmPage([BM_LIVE, BM_OFF])]
const bmRows = await realPandaApi.fetchBookmarks()
const bmReq = world.fetches.find((f) => String(f.url).includes('v1/live/bookmark'))
assert(bmReq && bmReq.url === 'https://api.pandalive.co.kr/v1/live/bookmark', '命中 /v1/live/bookmark 端点')
assert(bmReq.method === 'POST', '方法是 POST(与官网前端一致)')
assert(/(?:^|&)offset=0(?:&|$)/.test(bmReq.body) && /(?:^|&)limit=200(?:&|$)/.test(bmReq.body), '首页带 offset=0&limit=200(官方上限一发收满)', bmReq.body)
assert(bmReq.headers.Origin === 'https://www.pandalive.co.kr' && bmReq.headers.Referer === 'https://www.pandalive.co.kr/', 'Origin/Referer 停在 www 源根(跨源整路径会被 Chromium 取消)')
assert(bmReq.headers.Cookie === 'sessKey=test-sess; siteLang=ko', '有会话罐就带 Cookie(未登录时服务端回 result=false)', bmReq.headers.Cookie)
assert(Array.isArray(bmRows) && bmRows.length === 2, '两条关注解析成两行')
// 这一发是轮询的新真值源: 请求面必须与关注数无关(实测 158 关注 = 1 发 / 90KB / page.lastPage=1),
// 短页(list<limit)即判到底 —— 再发一页就是拿轮询去撞风控
assert(world.fetches.filter((f) => String(f.url).includes('bookmark')).length === 1, '短页即停: 一轮只发一发(轮询的风控面下限)')

console.log('E2 分页保险: 上限被抬高时按 page.total 收满即停')
reset()
world.bmPages = [
  bmPage(Array.from({ length: 200 }, (_, i) => ({ ...BM_OFF, userId: `u${i}` })), 260),
  bmPage(Array.from({ length: 60 }, (_, i) => ({ ...BM_OFF, userId: `v${i}` })), 260)
]
const rows2 = await realPandaApi.fetchBookmarks()
assert(rows2 && rows2.length === 260, '两页合起来 260 条')
assert(world.fetches.filter((f) => String(f.url).includes('bookmark')).length === 2, '收满 total 就停, 不发第三页')

console.log('E3 降级即 null(绝不解析成"一个关注都没有")')
reset()
world.bmPages = [{ list: [], page: { total: 0 }, result: false, message: 'need login' }]
assert((await realPandaApi.fetchBookmarks()) === null, 'result=false(未登录) → null')
reset()
world.bmPages = ['<html>captcha</html>']
assert((await realPandaApi.fetchBookmarks()) === null, '返回 HTML 验证页(风控) → null 且不抛')
reset()
world.bmPages = [bmPage([BM_LIVE])]
world.bmStatus = 403
assert((await realPandaApi.fetchBookmarks()) === null, 'HTTP 403 疑似风控 → null 且不抛(RiskError 不外溢)')
reset()
world.bmPages = [{ page: { total: 1 }, result: true }]
assert((await realPandaApi.fetchBookmarks()) === null, '缺 list 数组(改版) → null')

console.log('E4 在播/离线的字段解析(media 只在开播时下发)')
reset()
world.bmPages = [bmPage([BM_LIVE, BM_OFF])]
const r4 = await realPandaApi.fetchBookmarks()
const bLive = r4.find((x) => x.userId === 'mayonz')
const bOff = r4.find((x) => x.userId === 'icubi69')
assert(bLive.isLive && bLive.live, '在播行: 带 media 才判在线')
assert(bLive.live.title === '19ㅂ) 자연쮸' && bLive.live.startTime === '2026-09-29 18:52:55' && bLive.live.viewers === 28, '标题/开播时刻/当前人数取自 media')
assert(bLive.live.isAdult === true && bLive.live.isPw === false && bLive.live.type === 'free' && bLive.live.liveType === 'live', '19+/密码/房间类型/直播-回放取自 media')
assert(bLive.live.likes === 88 && bLive.live.fans === 9, '点赞/粉丝数取自 media(与全站列表同字段名)')
assert(bLive.live.thumbUrl.includes('/upload/live/') && bLive.live.userImg.includes('/upload/user/'), '截图与头像取自 media')
assert(bLive.userIdx === 25780534 && bLive.nick === 'ෆ점핑ෆ', 'userIdx/昵称随行给出')
assert(bOff.isLive === false && bOff.live === null && bOff.nick === 'tt258', '离线行: 没给 media 就是不在线, 昵称照样拿得到')

console.log('E5 单条脏数据只丢那一条, 整表皆脏报改版')
reset()
world.bmPages = [bmPage([{ ...BM_OFF, userId: 'bad id/x' }, { ...BM_OFF, userId: 'okuser1' }])]
const r5 = await realPandaApi.fetchBookmarks()
assert(r5 && r5.length === 1 && r5[0].userId === 'okuser1', '不可寻址的 userId 只丢那一条')
reset()
world.bmPages = [bmPage([{ userId: 'bad id' }, { userNick: '无 id' }])]
assert((await realPandaApi.fetchBookmarks()) === null, '整表都不可解析 = 字段改版, 报 null 而不是"导入 0 条"')

console.log('E6 anchorsImportPanda 的落库语义(与 SOOP 导入同一条码路)')
const pandaHandler = world.ipc[CH.anchorsImportPanda]
assert(typeof pandaHandler === 'function', 'IPC 通道已注册')
reset()
world.bmPages = [bmPage([BM_LIVE, BM_OFF, { ...BM_OFF, userId: 'dup1' }, { ...BM_OFF, userId: 'dup1' }])]
world.anchors = [anchor({ platform: 'pandalive', userId: 'icubi69', nick: '已在库' })]
const r6 = await pandaHandler()
assert(r6.total === 4 && r6.added === 2, `只增不改: 已在库的跳过, 列表内重复只算一次, added=${r6.added}`)
assert(world.anchors.filter((x) => x.userId === 'dup1').length === 1, '列表内重复项在库内只有一条')
const pa = world.anchors.find((x) => x.userId === 'mayonz')
assert(pa.platform === 'pandalive' && pa.isLive && pa.nick === 'ෆ점핑ෆ' && pa.title === '19ㅂ) 자연쮸', '在播行按列表原值建卡')
assert(pa.viewerCount === 28 && pa.startTime === '2026-09-29 18:52:55' && pa.tags.isAdult === true && pa.tags.type === 'free' && pa.tags.liveType === 'live', '人数/开播时刻/标签一次到位(比 SOOP 多出 type/liveType)')
assert(pa.userIdx === 25780534 && pa.userImg.includes('/upload/user/'), 'Panda 行自带的 userIdx/头像一并落卡')
assert(pa.autoRecord === false, '批量导入不开自录')
assert(world.anchors.filter((x) => x.platform === 'pandalive').length === 3, '离线房同样入墙(全量导入)')
assert(findAnchor('icubi69').nick === '已在库' && findAnchor('icubi69').isLive === false, '已在库的记录不被列表值覆盖(只增不改)')
reset()
world.bmPages = [{ list: [], page: { total: 0 }, result: false, message: 'need login' }]
let thrown6 = null
try {
  await pandaHandler()
} catch (e) {
  thrown6 = e
}
assert(thrown6 && /panda\.importFail/.test(thrown6.message), '未登录时报错, 不静默"导入 0 条"', thrown6 && thrown6.message)
assert(world.anchors.length === 0, '失败路径一条都不落库')

console.log('E8 列表取满官方 200 上限 = 可能不完整, 这一趟不做反向差值')
reset()
world.bmPages = [bmPage(Array.from({ length: 200 }, (_, i) => ({ ...BM_OFF, userId: `w${i}` })))]
world.anchors = [anchor({ platform: 'pandalive', userId: 'offwall', nick: '也许只是没翻到' })]
const rTrunc = await pandaHandler()
assert(rTrunc.total === 200 && rTrunc.siteGone === 0, `截断风险下增量计数归零, siteGone=${rTrunc.siteGone}`)
assert(world.anchors.find((a) => a.userId === 'offwall').siteGone === undefined, '不把"列表被上限截断"报成"站内已取关"')

console.log('E7 双平台导入的接线齐全')
const preloadSrc2 = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf-8')
const typesSrc2 = fs.readFileSync(path.join(ROOT, 'src/shared/types.ts'), 'utf-8')
assert(/anchorsImportPanda/.test(preloadSrc2), 'preload 暴露 anchorsImportPanda')
assert(/anchorsImportPanda\(\): Promise<FollowImportResult>/.test(typesSrc2), 'ApiBridge 声明 anchorsImportPanda')
assert(!/SoopImportResult/.test(typesSrc2), '导入回执类型已去 SOOP 化(两平台共用 FollowImportResult)')
assert(/api\.anchorsImportPanda\(\)/.test(wsSrc) && /api\.anchorsImportSoop\(\)/.test(wsSrc), '直播页两平台各有导入调用')
// 一期把两枚按钮合并成一枚「同步站内关注」: 平台由当前工作区决定, 而不是让用户自己挑按钮
assert(/isSoop\.value \? await api\.anchorsImportSoop\(\) : await api\.anchorsImportPanda\(\)/.test(wsSrc), '导入按当前工作区平台绑定')
for (const loc of ['zh-CN', 'en-US']) {
  const src = fs.readFileSync(path.join(ROOT, `src/renderer/src/i18n/locales/${loc}.ts`), 'utf-8')
  assert(
    /importConfirmPanda/.test(src) && /importConfirmSoop/.test(src) && !/importBtnPanda/.test(src),
    `${loc} 有双平台导入确认文案(旧的按平台两枚按钮文案已清理)`
  )
}

// ============ F: SOOP 取流的场次号复用 + 播放页微缓存 ============
// 实测基线(2026-10-02): 24 个在播关注的 broad_no 列表那一发已经全给了, 旧链路却仍为"拿一个号"
// 在每次点开/录制/预取前 GET 一整页播放页 HTML。F 段用真 soop.ts 数整页发数。
console.log('F1 列表播种场次号: 取流成功那一档整页 HTML 一发不发')
reset()
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
{
  const fRows = await soopApi.fetchFavorites()
  assert(fRows.length === 2 && soopApi.bnoCache.get('aaa111')?.bno === '12345678', '在播行的 broad_no 存进场次号缓存')
  assert(!soopApi.bnoCache.has('bbb222'), '离线行没有号可复用')
  world.fetches.length = 0
  const fPlay = await soopApi.fetchPlay('aaa111')
  assert(fPlay.ok === true, '整链跑通(拉源成功)', fPlay.error)
  assert(pageHits('aaa111') === 0, 'F1a 复用列表场次号: 一页 HTML 都不发', `页=${pageHits('aaa111')}`)
  assert(apiBno(0) === '12345678', '第 2 步带的就是列表那一个号', `bno=${apiBno(0)}`)
  assert(world.logInfo.some((m) => m.includes('拉源成功')) && !world.logInfo.some((m) => m.includes('页面元信息 @aaa111')), '日志形状与实机取证同一条: 有拉源成功, 没有页面元信息')
  assert(fPlay.title === '在播标题' && fPlay.nick === '甲', '标题/昵称仍由主信息给(为省一页而合成的空 meta 不得把读数写空)', `${fPlay.nick}/${fPlay.title}`)
}

console.log('F1b 列表改口说离线: 上一场的号当场作废(留着只会让下一次取流白撞)')
reset()
world.favBody = bodyOf([LIVE_ROW])
await soopApi.fetchFavorites()
assert(soopApi.bnoCache.has('aaa111'), '先有一颗号')
world.favBody = bodyOf([{ ...LIVE_ROW, is_live: false, broad_info: [] }])
await soopApi.fetchFavorites()
assert(!soopApi.bnoCache.has('aaa111'), '离线行清掉该房的号(号是这一场的钥匙, 不是这个房的门牌)')

console.log('F2 页面实读到的号同样进缓存: 第二次取流不再读页')
reset()
{
  const fCold = await soopApi.fetchPlay('ccc333')
  assert(fCold.ok === true && pageHits('ccc333') === 1, '冷房第一次: 一页 + 整链', `页=${pageHits('ccc333')}`)
  world.fetches.length = 0
  // 只让页面微缓存过期(10 秒), 场次号缓存(90 秒)仍新鲜: 这一发省掉整页必须靠的是号缓存, 而不是同一份旧页
  const pageHit = soopApi.pageCache.get('ccc333')
  if (pageHit) pageHit.at = Date.now() - 11_000
  const fWarm = await soopApi.fetchPlay('ccc333')
  assert(fWarm.ok === true && pageHits('ccc333') === 0, '第二次直接进第 2 步(号就是刚读到的那个)', `页=${pageHits('ccc333')}`)
  assert(apiBno(0) === '12345678', '第二次带的仍是页面那个号', `bno=${apiBno(0)}`)
}

console.log('F3 场次号过期(>90 秒)= 当没读到过, 回落到读整页那条既有链路')
reset()
{
  soopApi.bnoCache.set('ddd444', { bno: '99999', at: Date.now() - 91_000 })
  const fStale = await soopApi.fetchPlay('ddd444')
  assert(pageHits('ddd444') === 1, '过期号不带上: 回读整页拿当前号', `页=${pageHits('ddd444')}`)
  assert(apiBno(0) === '12345678' && fStale.ok === true, '带上的是页面此刻的真号, 链路仍走通(过期只是回落, 不是失败)', `bno=${apiBno(0)}`)
}

console.log('F4 复用的号没成功: 只回读一页定性, 代价有上界')
reset()
world.favBody = bodyOf([LIVE_ROW])
await soopApi.fetchFavorites()
world.apiChannel = { RESULT: -3 }
world.pageMode = 'offline'
world.fetches.length = 0
{
  const fGone = await soopApi.fetchPlay('aaa111')
  assert(fGone.ok === false && String(fGone.error).startsWith('soop.offline'), '页面说这一场已断 → 报"已下播", 不是笼统接口失败', fGone.error)
  assert(pageHits('aaa111') === 1 && apiHits('live') === 1, '上界: 1 页 + 1 发主信息(旧号不试第二次)', `页=${pageHits('aaa111')} api=${apiHits('live')}`)
}
reset()
world.favBody = bodyOf([LIVE_ROW])
await soopApi.fetchFavorites()
world.apiChannel = { RESULT: -3 }
world.fetches.length = 0
{
  const fSame = await soopApi.fetchPlay('aaa111')
  assert(fSame.ok === false && String(fSame.error).startsWith('soop.playResult'), '页面对得上同一个号 → 失败与号无关, 原样回报那句', fSame.error)
  assert(pageHits('aaa111') === 1 && apiHits('live') === 1, '不重打整链(同号再试一次只会再撞同一条错误)', `api=${apiHits('live')}`)
}
reset()
world.favBody = bodyOf([LIVE_ROW])
await soopApi.fetchFavorites()
world.apiChannel = { RESULT: -3 }
world.pageBno = 87654321
world.fetches.length = 0
{
  await soopApi.fetchPlay('aaa111')
  assert(apiBno(0) === '12345678' && apiBno(1) === '87654321', '页面给了新号 = 换场, 用新号重走', `${apiBno(0)}→${apiBno(1)}`)
  assert(apiHits('live') === 2 && pageHits('aaa111') === 1, '重走只有一次(不多打整链)', `api=${apiHits('live')} 页=${pageHits('aaa111')}`)
}

console.log('F5 播放页微缓存: 连击型调用复用, 要新读数的自己绕过')
reset()
{
  await soopApi.fetchPageMeta('eee555')
  const fMeta2 = await soopApi.fetchPageMeta('eee555')
  assert(pageHits('eee555') === 1 && fMeta2.broadNo === '12345678', 'TTL 内的第二次复用同一份页(录制启动前先取真名 → 紧接着拉整链)', `页=${pageHits('eee555')}`)
  await soopApi.fetchPageMeta('eee555', false, true)
  assert(pageHits('eee555') === 2, 'fresh=true 必须穿透 —— 探针是来要新读数的, 最短一档 5 秒比 TTL 还小')
  soopApi.pageCache.set('fff666', { at: Date.now() - 11_000, meta: { channel: 'fff666', broadNo: '1', living: true, explicitOffline: false, hostName: '', roomName: '', thumbUrl: '' } })
  await soopApi.fetchPageMeta('fff666')
  assert(pageHits('fff666') === 1, '过期即当没读到过(回既有链路, 不把旧页供成永久)')
}
reset()
{
  const [fA, fB] = await Promise.all([soopApi.fetchPageMeta('hhh888'), soopApi.fetchPageMeta('hhh888')])
  assert(pageHits('hhh888') === 1 && fA.broadNo === fB.broadNo, '并发两问合一次请求(整页是唯一昂贵的一步)', `页=${pageHits('hhh888')}`)
}

// ============ G: ② SOOP 的作废纪元与源种子(与 Panda 同策, 这里走真 soop.ts) ============
// 审计形状(R4): invalidatePlay/clearPlayCache 只删了 playCache, 而一条先于它发出的链回来照旧 set ——
// 用户那边就是"下播的房还能秒开 / 换号后仍在用旧账号签发的源"。G 段把这三个口都数出来。
console.log('G1 在飞的取流链遇到 invalidatePlay: 结果照还给调用方, 但不落缓存')
reset()
{
  const gP = soopApi.getPlayCached('ggg1', '', true) // 链已出发(请求在飞)
  assert(soopApi.playInflight.has('ggg1#top'), 'G1a 出发时在飞表里有它(否则下一句没有对照)')
  soopApi.invalidatePlay('ggg1') // 出发之后才被作废
  assert(!soopApi.playInflight.has('ggg1#top'), 'G1b 作废顺手把在飞那条摘掉: 新 caller 不许合进一条注定作废的链')
  const gR = await gP
  assert(gR.ok === true, 'G1c 调用方仍拿到源(这一发不白跑)')
  assert(!soopApi.cachedSourceIds().includes('soop:ggg1'), 'G1d 但缓存没有被复活(纪元不合)', soopApi.cachedSourceIds().join(','))
  world.fetches.length = 0
  await soopApi.getPlayCached('ggg1')
  assert(apiHits('live') === 1, 'G1e 下一次取流重走整链(缓存里确实是空的)', `api=${apiHits('live')}`)
}

console.log('G2 带密码那一条同样在作废时被摘掉(在飞键有四个形状: 密码槽 × 档位扇出)')
reset()
{
  const gP = soopApi.getPlayCached('hh1', 'pw123', true)
  assert(soopApi.playInflight.has('hh1#pw#top'), 'G2a 在飞键 = 频道 + 密码槽 + 档位扇出(预取那一发默认只解最高档)')
  soopApi.invalidatePlay('hh1')
  assert(
    ['hh1', 'hh1#pw', 'hh1#top', 'hh1#pw#top'].every((k) => !soopApi.playInflight.has(k)),
    'G2b 作废把四种形状一起摘(留一半=复活走了后门)',
    [...soopApi.playInflight.keys()].join(',')
  )
  await gP
  assert(soopApi.playCache.size === 0, 'G2c 结果不落缓存')
}

console.log('G3 换号/登出(clearPlayCache): 所有在飞链一律不许把旧会话签发的源写回来')
reset()
{
  const gA = soopApi.getPlayCached('ii1', '', true)
  const gB = soopApi.getPlayCached('ii2', '', true)
  soopApi.clearPlayCache()
  const [rA, rB] = await Promise.all([gA, gB])
  assert(rA.ok === true && rB.ok === true, 'G3a 两发的结果照还(不吞调用方那一发)')
  assert(soopApi.cachedSourceIds().length === 0, 'G3b 两枚都不落缓存: 整表纪元前移, 不靠逐房补刀', soopApi.cachedSourceIds().join(','))
}

console.log('G4 seedPlay: 续录复用中断探针那一发(省掉第二条完整链), 坏源不种')
reset()
{
  const pack = await soopApi.getPlayCached('jj1', '', true)
  assert(pack.ok === true && soopApi.cachedSourceIds().includes('soop:jj1'), 'G4a 先正常拉一枚进缓存')
  soopApi.deadStreak.set('jj1', 1) // 上一源被数过一次"上游已死"
  soopApi.invalidatePlay('jj1')
  soopApi.seedPlay('jj1', pack)
  world.fetches.length = 0
  const hit = await soopApi.getPlayCached('jj1')
  assert(world.fetches.length === 0 && hit.m3u8 === pack.m3u8 && hit.fetchedAt > 0, 'G4b 种子命中: 下一次取流零请求(整链不再重打), 且带打戳', `req=${world.fetches.length}`)
  soopApi.deadStreak.set('kk1', 1) // 这一房的上游刚被数过一次"已死"
  soopApi.seedPlay('kk1', pack)
  assert(soopApi.cachedSourceIds().includes('soop:kk1') && !soopApi.deadStreak.has('kk1'), 'G4c 种子带打戳并清掉判死计数(新源在手, 旧账作废)')
  soopApi.seedPlay('jj2', { ...pack, ok: false })
  assert(!soopApi.cachedSourceIds().includes('soop:jj2'), 'G4d 坏源不许种(种子只认真拿到手的源)')
}

// ============ H: SOOP 取源链的档位扇出(后台只买最高档, 满档由真的进房那一次买) ============
// 实测形状: 每一档 = 1 发 AID + 1 发调度(broad_stream_assign), 主信息那发与档数无关。
// 4 档房在预取泵上就是 1+8 发背靠背, 而"用户会不会切清晰度"是一个都没发生过的假设。
const PRESETS2 = [
  { label: 'HD', name: 'hd', label_resolution: 720, bps: 3000 },
  { label: 'SD', name: 'sd', label_resolution: 480, bps: 1000 }
]
const assignHits = () => world.fetches.filter((f) => String(f.url).includes('broad_stream_assign')).length

console.log('H1 只解最高档的那一发: 1 发主信息 + 1 发 AID + 1 发调度, 菜单标"残缺"')
reset()
world.apiChannel = { VIEWPRESET: PRESETS2 }
{
  const top = await soopApi.getPlayCached('q1')
  assert(top.ok === true && top.variants.length === 1 && top.partial === true, 'H1a 一份菜单只有一档, 且 partial=true(卡片算有源, 菜单等进房补齐)', `档=${top.variants?.length}`)
  assert(apiHits('aid') === 1 && assignHits() === 1, 'H1b AID 与调度各恰好一发(满档才是 2+2)', `aid=${apiHits('aid')} assign=${assignHits()}`)
  assert(world.logInfo.some((m) => /档位=1\(只解最高档\)/.test(m)), 'H1c 日志把这一档说清楚(真机据此认形状)')
  const full0 = top.variants[0]
  assert(full0.resolution === '720p', 'H1d 省发留下的必须是最高档(秒开要的就是它)', `res=${full0.resolution}`)

  console.log('H2 已有最高档(哪怕是残缺那一份)的房: 再要最高档零请求')
  world.fetches.length = 0
  const again = await soopApi.getPlayCached('q1')
  assert(world.fetches.length === 0 && again.m3u8 === top.m3u8, 'H2a 命中同一条包 —— 最高档就在里面, 重打整链是纯浪费', `req=${world.fetches.length}`)

  console.log('H3 用户真的进房(要满档菜单): 残缺包不许交出去, 差的那几档现买 —— 已买的最高档不再重买')
  world.fetches.length = 0
  world.logInfo.length = 0
  const full = await soopApi.getPlayCached('q1', '', false, true)
  assert(full.variants.length === 2 && full.partial === false, 'H3a 满档请求换回两档菜单且不再标残缺(接上复用账之后"其余档一档没买到"不再是满档, 旧判据会把它写成缺档)', `档=${full.variants.length} partial=${full.partial}`)
  assert(full.variants[0].url === top.variants[0].url, 'H3b 复用那一份是从头接起的: 最高档那格与预取买到的同一发(秒开的那一条地址没被换掉)', `${full.variants[0]?.url} vs ${top.variants[0]?.url}`)
  // 旧写法: 满档 caller 认定"残缺包不能给", 于是整条链重打 —— 连最高档那 1+1 发也原样再买一遍(现场实拍 @ahfotlrp0675)
  assert(apiHits('aid') === 1 && assignHits() === 1, 'H3c 补齐 = 只买差的那一档(每档两发), 已经买到的这一档从复用账里递出来', `aid=${apiHits('aid')} assign=${assignHits()}`)
  assert(world.logInfo.some((m) => /复用已买档=1\(省 2 发\)/.test(m)), 'H3d 省下的发数写进成功日志: 事后数包的人要能一眼看出这一条链少打了 2 发')
  assert(!world.logInfo.some((m) => /只解最高档/.test(m)), 'H3e 满档那一发的日志不带"只解最高档"(两种形状在读数面上仍分得开)')

  console.log('H4 切画质再切回: 满档包之后两种请求都不许再打链')
  world.fetches.length = 0
  const backTop = await soopApi.getPlayCached('q1')
  const backFull = await soopApi.getPlayCached('q1', '', false, true)
  assert(
    world.fetches.length === 0 && backTop.variants.length === 2 && backFull.variants.length === 2,
    'H4a 满档包含最高档 ⇒ 两方都命中(切走再切回不会失效也不会重新取源)',
    `req=${world.fetches.length}`
  )

  console.log('H5 用户手动拉源那一条(fetchPlay)默认满档: 省发只发生在后台那一路')
  world.fetches.length = 0
  const raw = await soopApi.fetchPlay('q2')
  assert(raw.ok === true && raw.variants.length === 2 && raw.partial === false, 'H5 fetchPlay 不省发(播放页手动刷新要的本来就是完整菜单)')

  console.log('H6 事件一落地, 旧那一场买过的档就不再是"同一场"的档')
  {
    await soopApi.getPlayCached('q3', '', false, false) // 后台先买最高档, 留一格复用账
    soopApi.invalidatePlay('q3') // 下播/收尸/手动强刷都会走到这里
    world.fetches.length = 0
    const after = await soopApi.getPlayCached('q3', '', false, true)
    assert(after.variants.length === 2 && apiHits('aid') === 2, 'H6a 作废之后满档 caller 重打两档: 那一场的凭证跟着源一起废了, 复用账必须一起摘', `实买=${apiHits('aid')}`)
    world.fetches.length = 0
    await soopApi.getPlayCached('q3', '', false, true)
    assert(world.fetches.length === 0, 'H6b 满档链落地即摘账(一本只增不减的账早晚会骗人): 缓存此时已不缺档, 不该再有"复用"这回事')

    console.log('H6c 换号/登出那一条(clearPlayCache)同样摘账: 上一号买过的档对这一个账号不成立')
    await soopApi.getPlayCached('q6', '', false, false) // 后台先买最高档并记账
    assert(soopApi.partialBuy.has('q6'), 'H6c0 记账这一格先自证: 没记上账的话, 下面那条"重打两档"就永远是绿的(变异取证的教训写在)')
    soopApi.clearPlayCache()
    world.fetches.length = 0
    const sw = await soopApi.getPlayCached('q6', '', false, true)
    assert(sw.variants.length === 2 && apiHits('aid') === 2, 'H6c 摘账后满档 caller 重打两档(账号不同 ⇒ 能买的档与 aid 都不同, 旧那一份凭证不该递出来)', `实买=${apiHits('aid')}`)
  }

  console.log('H7 换场与换菜单: 两格判据各自把关')
  {
    await soopApi.getPlayCached('q4', '', false, false) // 同一场: 先买最高档并记账(bno=12345678)
    assert(soopApi.partialBuy.get('q4')?.bno === '12345678', 'H7a0 账里躺着的就是"上一场那一份": 下面那两发重买才归得出是号对不上, 而不是根本没账可复用')
    world.apiChannel = { VIEWPRESET: PRESETS2, BNO: '88888888' } // 平台说这是新一场了
    world.fetches.length = 0
    const nb = await soopApi.getPlayCached('q4', '', false, true)
    assert(apiHits('aid') === 2 && nb.variants.length === 2, 'H7a 复用判据是场次而不是时间: 号一变, 上一场买的那几档立刻不成立(整档重买, 不给旧凭证)', `实买=${apiHits('aid')}`)
    world.apiChannel = { VIEWPRESET: PRESETS2 }
    await soopApi.getPlayCached('q5', '', false, false) // 先按"hd 是最高档"那份菜单买一档并记账
    assert(soopApi.partialBuy.get('q5')?.bought.map((b) => b.name).join(',') === 'hd', 'H7b0 记的那一档确实叫 hd(位置 0): 于是下面那两发重买是"位置对不上"造成的, 不是没账')
    world.apiChannel = { VIEWPRESET: [{ label: 'SD', name: 'sd', label_resolution: 1080, bps: 9000 }, { label: 'HD', name: 'hd', label_resolution: 720, bps: 3000 }] }
    world.fetches.length = 0 // 同一场、同一号, 只是菜单改了高低: 买过的那一档从第一格掉到了第二格
    const pf = await soopApi.getPlayCached('q5', '', false, true)
    assert(pf.variants[0].resolution === '1080p', 'H7b1 菜单换了高低(同名不同档)之后, 满档包的第一格必须是新的最高档 —— 从错位那一格接起就是交一份对不上菜单的源', `res=${pf.variants[0]?.resolution}`)
    assert(apiHits('aid') === 2 && pf.variants.length === 2, 'H7b2 只对"前缀对得上"的那一段负责: 名字还在而位置不对 ⇒ 那一档当没买过、照买 —— 宁可多买也不交出错位的菜单', `实买=${apiHits('aid')}`)
  }
}

// ============ I: SOOP 接口风控信号记账(只记账不发火) ============
console.log('I1 播放页回 HTML 不是风控信号(探针读的就是整页)')
reset()
world.pageMode = 'broken'
await soopApi.fetchPageMeta('p1')
assert(soopApi.riskCooling() === false, 'I1a 整页 HTML 是这一路的常态, 旧形状会把每一次页读都冷却', `cooling=${soopApi.riskCooling()}`)

console.log('I2 515 = 网关的"没登录"回执, 按登录态处理而不是被 ban')
reset()
world.favStatus = 515
world.favBody = '{"code":-10000}'
{
  const rows = await soopApi.fetchFavorites()
  assert(rows === null, 'I2a 列表不可用照旧降级成 null(绝不把"没拿到"当成"全都下播")')
  assert(soopApi.riskCooling() === false, 'I2b 515 不武装静默期(把它记成风控=把登出当被 ban)')
}

console.log('I3 403 / 429 / 非 515 的 5xx / 接口回 HTML: 四种形状各武装一次, 且全程不抛新异常')
for (const [name, setup] of [
  ['403', () => { world.favStatus = 403; world.favBody = '{"code":-1}' }],
  ['429', () => { world.favStatus = 429; world.favBody = 'too fast' }],
  ['500', () => { world.favStatus = 500; world.favBody = 'boom' }],
  ['接口回HTML', () => { world.favStatus = 200; world.favBody = '<html>captcha</html>' }]
]) {
  reset()
  setup()
  const rows = await soopApi.fetchFavorites()
  assert(rows === null && soopApi.riskCooling() === true, `I3-${name} 记进风控账且降级为 null(调用方契约一字不变)`)
  assert(world.logWarn.some((m) => /疑似风控/.test(m)), `I3-${name}b 出声一次(日志是唯一可见面)`)
}

console.log('I4 静默期只由时间到点解除: 一次幸运的 200 不提前解锁, 换号/登出才立即解锁')
reset()
world.favStatus = 403
await soopApi.fetchFavorites()
world.favStatus = 200
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
await soopApi.fetchFavorites()
assert(soopApi.riskCooling() === true, 'I4a 冷却期内即使这一发真的 200 了也不解锁(解锁条件只有"时间到点")')
soopApi.clearPlayCache()
assert(soopApi.riskCooling() === false, 'I4b 换号/登出清表连带解除静默期(旧账号的账不钉新账号的泵)')

// ============ J: 静默期只收手后台泵, 不牵连接用户那一条 ============
console.log('J1 冷却轮: 降级探针整批收手, 关注列表那一发照旧(1 发/轮不是风控忌讳的形状)')
reset()
world.pageMode = 'offline' // 站外那个房本就在官网查无(离线页), 让"沿用上一轮"这一条有对照
world.anchors = [anchor(), anchor({ userId: 'off-list' })]
world.favBody = bodyOf([LIVE_ROW]) // 站外的房只有一个 → 常态就是这一发
await runRound()
const probesBefore = pageProbes()
assert(probesBefore === 1, 'J1a 改造前的基线: 列表覆盖不到的那 1 个房发 1 发探针', `页=${probesBefore}`)
world.favStatus = 403
await soopApi.fetchFavorites() // 撞一次风控
world.fetches.length = 0
world.favStatus = 200
await runRound()
assert(pageProbes() === 0, 'J1b 冷却期内探针整批收手(零整页读)', `页=${pageProbes()}`)
assert(world.fetches.some((f) => String(f.url).includes('myapi')), 'J1c 关注列表那一发照发(停它 = 直接丢开播时效)')
assert(watcher.status.byPlatform.soop.roundFailed === 1, 'J1d 收手的那 1 个房计一次"本轮未读到"(既算失败又算被挡下=同一批房数两遍)', `未读=${watcher.status.byPlatform.soop.roundFailed}`)
{
  const card = findAnchor('off-list')
  assert(card.isLive === false && card.title === '', 'J1f 三态必分: 收手绝不把"没读到"写成"已下播"(这里本就是离线房, 不许被翻新)')
}
reset()
world.anchors = [anchor({ isLive: true })]
world.favStatus = 403
await soopApi.fetchFavorites()
world.favBody = '{"code":-10000}' // 列表也拿不到: 全部房进 probe
await runRound()
assert(watcher.soopFailStreak === 1, 'J2 冷却收手不许把失明判据绕过去(覆盖 0 且有房待读 = 全灭)')

console.log('J3 用户进房那一条不受静默期牵连: 拉源链照打(后台泵收手 ≠ 前台点不动)')
reset()
world.favStatus = 403
await soopApi.fetchFavorites()
{
  const r = await soopApi.getPlayCached('u1', '', true)
  assert(r.ok === true && apiHits('live') === 1, 'J3 冷却期内的手动取流照常成功(riskCooling 不在用户意图路径上)', `ok=${r.ok}`)
}

// ============ K: 关注列表的在飞合流 + 源缓存的年龄收手 ============
const favHits = () => world.fetches.filter((f) => String(f.url).includes('myapi')).length

console.log('K1 同一瞬时的两问只发一发整表(轮询与「立即刷新」会撞在一起)')
reset()
world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
world.favDelayMs = 40
{
  const [k1a, k1b] = await Promise.all([soopApi.fetchFavorites(), soopApi.fetchFavorites()])
  world.favDelayMs = 0
  assert(favHits() === 1, 'K1a 在飞合流: 两问共享一发请求(整表 718 条那一发不便宜)', `发=${favHits()}`)
  assert(k1a.length === 2 && k1b === k1a, 'K1b 合并的是同一次读数, 不是各解一遍')
  await soopApi.fetchFavorites()
  assert(favHits() === 2, 'K1c 落定之后再问照发新的一发: 这一发是"谁在播"的真值源, 给它加 TTL 是拿时效换请求数')
}

console.log('K2 源缓存的年龄收手: 回访客过宽限、下播房过时限出队; 在播源不限年龄; 这一趟零网络')
reset()
world.anchors = [anchor({ userId: 'sw1', isLive: true }), anchor({ userId: 'sw2', isLive: true }), anchor({ userId: 'sw5', isLive: true })]
await soopApi.getPlayCached('sw1')
await soopApi.getPlayCached('sw2')
await soopApi.getPlayCached('sw5')
await soopApi.getPlayCached('sw3') // 不在关注表的回访客
await soopApi.getPlayCached('sw4')
assert(soopApi.cachedSourceIds().length === 5, 'K2a 五间房各持一份源(对照起点)', soopApi.cachedSourceIds().join(','))
soopApi.playCache.get('sw1').fetchedAt -= 90 * 60_000 // 在播 90 分钟的长场次
soopApi.playCache.get('sw2').fetchedAt -= 31 * 60_000 // 下播(SOOP 列表那一路已把卡翻离线)
soopApi.playCache.get('sw3').fetchedAt -= 11 * 60_000 // 回访客过 10 分钟宽限
world.anchors.find((a) => a.userId === 'sw2').isLive = false
world.anchors.find((a) => a.userId === 'sw5').isLive = false // 下播才 0 分钟
world.fetches.length = 0
{
  const dropped = soopApi.sweepPlayCache()
  assert(dropped === 2 && !soopApi.playCache.has('sw2') && !soopApi.playCache.has('sw3'), 'K2b 过时限的两枚出队(「已缓存」徽标随之熄灭)', `出队=${dropped}`)
  assert(soopApi.playCache.has('sw1'), 'K2c 在播且仍在关注表的源不许被时限掐: 长场次的秒开不是牺牲品')
  assert(soopApi.playCache.has('sw4') && soopApi.playCache.has('sw5'), 'K2d 没到时限的一律不动(回访客 10 分钟内、下播房 30 分钟内)')
  assert(world.fetches.length === 0, 'K2e 收手这一趟零请求: 它只扫内存, 关掉保活与否都照跑')
  const idsBefore = world.fetches.length
  await soopApi.getPlayCached('sw2', '', false, true) // 出队之后再要 = 重新走整链(旧源不许复活)
  assert(world.fetches.length > idsBefore, 'K2f 出队即纪元前移: 下一次取流必然重新打链(尸源不再外供)', `req=${world.fetches.length - idsBefore}`)
}

console.log('K3 兜底重发必须出声: 会话层失败 → Node 再打一遍, 这一跳过去是静默的')
reset()
world.pageFail = true
{
  await soopApi.fetchPageMeta('fb1').catch(() => {})
  assert(world.fetches.length === 2, 'K3a 一次页面读在会话层失败后由 Node 重发(请求数翻倍是事实, 过去没痕迹)', `发=${world.fetches.length}`)
  assert(world.logWarn.filter((m) => /Node 兜底重发 ×1/.test(m)).length === 1, 'K3b 重发出声一句: 带次数、原因与目标', world.logWarn.join(' | '))
  world.fetches.length = 0
  world.logWarn.length = 0
  await soopApi.fetchPageMeta('fb2').catch(() => {})
  await soopApi.fetchPageMeta('fb3').catch(() => {})
  assert(world.logWarn.filter((m) => /Node 兜底重发/.test(m)).length === 0, 'K3c 60 秒窗口内不逐条刷屏(DNS 黑洞期那是每请求一次的形态)')
  assert(soopApi.fallbackCnt === 2, 'K3d 窗口内的次数在累计, 等下一句一起报', `cnt=${soopApi.fallbackCnt}`)
}

// ============ L: 播放器那一条取流 IPC 的手动刷新下限 ============
// 这一节验的是处理器"把强制位传下去了没有": source.ts 在本套里是替身(真取流链由 F/G/H 段直接驱动 soopApi),
// 所以断言落在 playCalls 那本参数账上 —— 验参数而不是验"调用过", 否则替身吞掉参数照样绿(那一课的形态)
console.log('L1 强制刷新的 8 秒下限: 刚成功过的那一发之内不再传 force')
{
  const playH = world.ipc[CH.livePlay]
  assert(typeof playH === 'function', 'L1a livePlay 通道已注册')
  reset()
  world.anchors = [anchor({ userId: 'thr001', isLive: true })]
  const first = await playH({}, 'soop', 'thr001', '', true)
  // 改判: 播放器的入口从 getPlayCached(…, true) 换成 getPlayFast(…, force)。
  // 下限这一格要验的从来是"强制位有没有被处理器如实传下去", 档级那一头改由 liveMenu 那条腿验(见 L1f)
  assert(first.ok && world.playCalls.length === 1 && world.playCalls[0].force === true && world.playCalls[0].fast === true, 'L1b 第一发强制刷新照旧要 force, 且走的是秒开快道(下限不改变"该打的那一发"; 入口若退回直连 getPlayCached, fast 这一格就是 undefined 而非 true)', JSON.stringify(world.playCalls))
  const second = await playH({}, 'soop', 'thr001', '', true)
  assert(second.ok && world.playCalls.length === 2 && world.playCalls[1].force === false, 'L1c 8 秒内的第二发降级为"复用手里那份"(force=false → 命中 playCache, 整链一发都不重打; SOOP 单链实测 8~10 发, 连点 N 下过去就是 N 条链同时插队)', JSON.stringify(world.playCalls))
  assert(world.playCalls[1].fast === true, 'L1d 被闸掉的只有强制位: 两发都走同一条快道入口, 降级的那一发不许悄悄换成别的取源路径')
  assert(world.logInfo.filter((m) => /取流强制刷新节流/.test(m)).length === 1, 'L1e 降级要出声: 静默复用会让人以为「手动刷新」这个按钮坏了', world.logInfo.join(' | '))
  // L1f 菜单那条腿: 补齐那一发必须显式要全档 —— 快道给了残缺包之后, 这是"清晰度菜单最终要齐"的唯一保证
  const menuH = world.ipc[CH.liveMenu]
  assert(typeof menuH === 'function', 'L1f0 liveMenu 通道已注册(渲染层 fillMenu 走的就是它)')
  world.playCalls.length = 0
  const menu = await menuH({}, 'soop', 'thr001', '')
  assert(menu.ok && world.playCalls.length === 1 && world.playCalls[0].fullVariants === true && !world.playCalls[0].fast && world.playCalls[0].force === false, 'L1f 补齐菜单那一发显式 fullVariants=true 且不带 force(不问平台第二次强制, 也不掉回省档), 且不回写关注卡', JSON.stringify(world.playCalls))
  assert(!world.playCalls[0].uid.includes('#'), 'L1f2 liveMenu 的入参照旧过 roomKey 那把尺(裸 userId 进, 裸 userId 出)')
}

console.log('L2 只有真强制取到源才落账: 失败、非强制、别的房都不立闸')
{
  const playH = world.ipc[CH.livePlay]
  const forces = () => world.playCalls.map((c) => c.force).join(',')
  reset()
  world.anchors = [anchor({ userId: 'thr002', isLive: true })]
  world.playFails = 1
  const dead = await playH({}, 'soop', 'thr002', '', true)
  assert(dead.ok === false && dead.needLogin === true, 'L2a 失败原样回报(needLogin 一并透传): 节流不许把失败刷成成功')
  const retry = await playH({}, 'soop', 'thr002', '', true)
  assert(retry.ok && forces() === 'true,true', 'L2b 紧接着的重试照拿 force: 失败从来不落账, "源真死了再点一次"永远有反应', forces())
  // 进房那一发(非强制)同样不落账 —— 否则刚开播就点手动刷新会被自己几秒前的缓存闸成哑的
  reset()
  world.anchors = [anchor({ userId: 'thr003', isLive: true })]
  await playH({}, 'soop', 'thr003', '', false)
  const manual = await playH({}, 'soop', 'thr003', '', true)
  assert(manual.ok && forces() === 'false,true', 'L2c 非强制那一发不立闸: 进房后立刻点手动刷新仍然要 force(它是读数, 不是重复的读数)', forces())
  await playH({}, 'soop', 'thr003', '', true)
  assert(forces() === 'false,true,false', 'L2d 而强制成功之后紧接着的那一发要落闸: 同一秒内两条完整链同时插队是这一节消灭的东西', forces())
  // 账本按 平台+房 记: 同号的两平台、不同号的同一平台互不牵连
  await playH({}, 'pandalive', 'thr003', '', true)
  assert(forces().endsWith(',true') && world.playCalls.at(-1).force === true, 'L2e 对面平台的同号不共享这一格账(roomKey 复合键): 裸 userId 建表会让 SOOP 的节流把 Panda 那一发也闸掉', forces())
  await playH({}, 'soop', 'thr004', '', true)
  assert(world.playCalls.at(-1).force === true, 'L2f 同平台的别的房同理(闸是逐房的, 不是全站一刀)', forces())
}

// ============ M: 的三笔(加房那一发的真值 / 复查那一页 / 门槛回执的账) ============
// 这一节的三条都落在"同一件事被打了两遍"上, 而两遍之间隔着的往往是几秒: 只有让 IPC 处理器与真客户端、
// 真取流链在同一条链上才数得出来(替身把第二遍吞掉, 断言就会绿得毫无意义)。
const bjHits = () => world.fetches.filter((f) => String(f.url).includes('/v1/member/bj')).length
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等一个异步副作用落地(本套原来全是同步驱动, M 段要数的是"泵在添加链返回之后发出的那一发") */
const until = async (fn, ms = 4000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (fn()) return true
    await sleepMs(50)
  }
  return fn()
}

console.log('M1 手工添加 Panda 房: member/bj 买回来的在播真值当场用掉')
{
  const addH = world.ipc[CH.anchorsAdd]
  assert(typeof addH === 'function', 'M1a anchorsAdd 已注册')
  reset()
  world.bjBody = { result: true, bjInfo: { id: 'mayonz', nick: '점핑', img: '' }, media: BM_LIVE.media }
  const idle0 = watcher.idleQueue.length
  const card = await addH({}, 'https://www.pandalive.co.kr/play/mayonz', 'pandalive')
  assert(bjHits() === 1, 'M1b 添加这一条链上 member/bj 恰好一发(旧写法这一发只取昵称/头像, media 整包丢掉 ⇒ 卡片按离线落库, 间隙泵 1.2 秒后为同一件事再发一次)', `实发=${bjHits()}`)
  assert(card.isLive === true && card.title === BM_LIVE.media.title && card.viewerCount === 28 && card.likes === 88 && card.fans === 9 && card.startTime === BM_LIVE.media.startTime,
    'M1c 卡片按第一发买回的真值落库(在播/标题/观众/点赞/粉丝/开播时刻), 不等第二轮', JSON.stringify({ l: card.isLive, t: card.title, v: card.viewerCount }))
  assert(card.tags && card.tags.isAdult === true && card.tags.isPw === false && card.tags.type === 'free' && card.tags.liveType === 'live', 'M1d 房态标签同样落地(19+ 与密码房旗不必等大也不会被写成 false)')
  assert(card.lastSeenAt > 0 && card.lastLiveAt === BM_LIVE.media.startTime, 'M1e 已知道在播的房不留 lastSeenAt=0(离线口径不该套在它身上)')
  assert(watcher.idleQueue.length === idle0, 'M1f 在播房没有进间隙泵: trackIdle 那条守卫拦得住, 拦不住的是旧写法把卡片写成了离线')
  watcher.running = true
  await watcher.pumpIdle() // 真点一次泵: M1b 那一发数要有这一句才不是空断言 —— 旧写法在这一步发出第二发
  assert(bjHits() === 1, 'M1f2 间隙泵跑一趟也仍是 0 第二发(旧写法: 卡片离线落库 → 排进泵 → 1.2 秒后同一 userId 第二次打到 /v1/member/bj)', `实发=${bjHits()}`)
  reset()
  world.bjBody = { result: true, bjInfo: { id: 'off1', nick: '오프', img: '' }, media: null }
  watcher.idleQueue.length = 0
  const off = await addH({}, 'off1', 'pandalive')
  assert(off.isLive === false && off.tags === null, 'M1g media 真没有 = 仍按离线落库(新读法不替平台编造在播)')
  // trackIdle 那句 void pumpIdle() 是立刻开扫的, 所以"补扫那一发"要等它落地才数得到(不在添加链的同步段里)
  const pumped = await until(() => bjHits() >= 2, 5000)
  assert(pumped, 'M1h 真无数据才走 (C4) 那条补洞: 添加那一发之外, 间隙泵照旧为"它到底在不在播"补发一发 —— 2 发 = 已知答案的那一问没重复, 未知的那一问一发不少', `bj=${bjHits()} 队列=${watcher.idleQueue.length}`)
  assert(watcher.idleQueue.length === 0, 'M1h2 补扫是队列被消费掉(不是添加链自己叠发)', `队列=${watcher.idleQueue.length}`)
  reset()
  watcher.discovery = [{ userId: 'mayonz', nick: '大厅昵称', userIdx: 1, userImg: '', title: '大厅标题', isAdult: false, isPw: false, type: 'free', liveType: 'live', startTime: '', viewers: 1, likes: 0, fans: 0, thumbUrl: '' }]
  const fromDisc = await addH({}, 'mayonz', 'pandalive')
  assert(fromDisc.isLive === true && bjHits() === 0, 'M1i 大厅快照命中仍零 bj: 那条既有省发路径没被新读法顶掉(两条路各归各, 不叠发)')
  assert(fromDisc.nick === '大厅昵称' && fromDisc.title === '大厅标题', 'M1j 大厅优先于 bj 的取值顺序不变(近一分钟的全站读数比一次单房问答更该采信)')
}

console.log('M2 取流复查吃微缓存: 十秒内刚读过的那一页不再重买')
{
  reset()
  await soopApi.fetchPageMeta('aaa111', true, true, '探针') // 探针要新读数: 这一页是真买回来的
  assert(pageHits('aaa111') === 1, 'M2a 先让探针付一页(它在微缓存里, 且号也入了账)', `页=${pageHits('aaa111')}`)
  soopApi.bnoCache.set('aaa111', { bno: '12345678', at: Date.now() })
  world.apiChannel = { RESULT: -3 }
  world.fetches.length = 0
  const r = await soopApi.fetchPlay('aaa111')
  assert(r.ok === false && String(r.error).startsWith('soop.playResult'), 'M2b 号对得上而链失败 → 原样回报那一句(与 F4 同判据)', r.error)
  assert(pageHits('aaa111') === 0, 'M2c 复查复用探针那一页: 0 新页(旧写法 fresh=true 把微缓存与在途合并一并绕过, 几秒前刚买过的那一页在这里原样重买)', `页=${pageHits('aaa111')}`)
  assert(apiHits('live') === 1, 'M2d 省掉的是页不是判据: 主信息仍一发', `api=${apiHits('live')}`)
  const hit = soopApi.pageCache.get('aaa111')
  if (hit) hit.at = Date.now() - 11_000
  soopApi.bnoCache.set('aaa111', { bno: '12345678', at: Date.now() })
  world.fetches.length = 0
  await soopApi.fetchPlay('aaa111')
  assert(pageHits('aaa111') === 1, 'M2e 过了十秒窗口照样真读一页: 复查要的"这一页怎么说"不由旧页供成永久(F4 那条既有语义没被顶掉)')
}

console.log('M3 SOOP 门槛回执账: 只记两类不会自己好的回答')
{
  reset()
  world.apiChannel = { RESULT: -6 } // 会话缺失/过期
  const a = await soopApi.getPlayCached('gate1')
  assert(a.ok === false && a.needLogin === true, 'M3a 第一次问照实回报"要登录"(账不改写答案, 只改写第二次要不要去问)')
  const n0 = world.fetches.length
  const b = await soopApi.getPlayCached('gate1')
  assert(b.needLogin === true && world.fetches.length === n0, 'M3b 15 分钟内不再为同一间重打整链(旧写法只缓存 r.ok ⇒ 被拒那一句从没落进任何账, 每点一次重打 9~10 发)', `新增=${world.fetches.length - n0}`)
  assert(b !== a, 'M3c 短路还给的是副本: 调用方就地改这一个对象不许污染账里那一份(否则"要密码"能被改成"要登录")')
  world.fetches.length = 0
  const c = await soopApi.getPlayCached('gate1', 'pw999')
  assert(world.fetches.length > 0 && c.needLogin === true, 'M3d 带密码那一发不看账: 密码本身就是新信息')
  world.fetches.length = 0
  const d = await soopApi.getPlayCached('gate1', '', true)
  assert(world.fetches.length > 0 && d.needLogin === true, 'M3e 手动强刷绕账: 用户明确要一次新答案时不该拿旧账挡(冷却只归后台的泵消费 —— D74h 同一条纪律)')
  soopApi.invalidatePlay('gate1')
  world.fetches.length = 0
  await soopApi.getPlayCached('gate1')
  assert(world.fetches.length > 0, 'M3f 事件解除: 作废(下播收尸/换号/重开播)之后重新问一次平台, 门槛账只许活到下一个事件')
  // 要密码的那一类: 预取那一路永远没有密码 ⇒ 记账
  reset()
  world.apiChannel = { BPWD: 'Y' }
  const p1 = await soopApi.getPlayCached('gate2')
  assert(p1.ok === false && p1.needPassword === true, 'M3g 密码房 + 没密码 → 报"要密码"')
  const n1 = world.fetches.length
  const p2 = await soopApi.getPlayCached('gate2')
  assert(p2.needPassword === true && world.fetches.length === n1, 'M3h 同一间第二次不再重打整链(这一类的代价实测 9~10 发, 而预取泵永远不给密码 ⇒ 每次预取都白付)', `新增=${world.fetches.length - n1}`)
  // 密码不对的那一类不记账: 下一次可能改对
  reset()
  world.apiChannel = { BPWD: 'Y', RESULT: 0 }
  const w1 = await soopApi.getPlayCached('gate3', 'wrong')
  assert(w1.ok === false && w1.needPassword === true && String(w1.error).startsWith('soop.pwWrong'), 'M3i 交了密码而平台仍不给源 = 密码不对, 报"可重填"那句', w1.error)
  const n2 = world.fetches.length
  const w2 = await soopApi.getPlayCached('gate3', 'wrong')
  assert(world.fetches.length > n2, 'M3j 密码不对不记账: 再问一次是"用户改了密码"这条路的必经一步, 把它锁 15 分钟就是把纠错锁死', `新增=${world.fetches.length - n2}`)
  // 带密码那一发本来就不看账(M3d), 所以"记没记账"只能由没有密码的那条路读出 —— 预取泵正是这一形状
  const n2b = world.fetches.length
  const w3 = await soopApi.getPlayCached('gate3')
  assert(world.fetches.length > n2b, 'M3j2 密码不对后无密码那一问照样打平台: 账本里若混进 pwWrong, 预取泵会拿着"密码不对"去问一间它从没交过密码的房', `新增=${world.fetches.length - n2b}`)
  assert(String(w3.error).startsWith('soop.pwRequired'), 'M3j3 报的是"这房要密码"而不是"密码不对": 这一路没交过密码, 无从知道对不对', w3.error)
  // 托管了账密时"要登录"不是终局: 后台 60 秒就能自愈 ⇒ 不记账
  reset()
  mocks['src/main/services/secrets.ts'].secrets.map.set('soop.user', 'me')
  mocks['src/main/services/secrets.ts'].secrets.map.set('soop.pass', 'pw')
  world.apiChannel = { RESULT: -6 }
  const q1 = await soopApi.getPlayCached('gate4')
  assert(q1.ok === false && q1.needLogin === true, 'M3k 托管账密在场时照样报"要登录"(重登没成功就是没成功, 账不许把失败刷成成功)')
  const n3 = world.fetches.length
  const q2 = await soopApi.getPlayCached('gate4')
  assert(world.fetches.length > n3, 'M3l 有托管账密就不记门槛账: 会话过期这一类能在后台自愈, 记账等于把它锁死在墙上(60 秒重登节流才是它该有的节奏)', `新增=${world.fetches.length - n3}`)
  assert(soopApi.gates.size === 0, 'M3m 这一场账本里一格都没有(四类判定各归各: 只有"要登录且没托管"与"要密码且没密码"进账)', `size=${soopApi.gates.size}`)
}

console.log('M4 门槛账落盘(用户定「两平台对称」): 冷启动不再替明知过不去的房间重打 9~10 发整链')
{
  reset()
  const A = (uid) => world.anchors.find((x) => x.userId === uid)
  const gw = () => anchorWrites.filter((w) => 'gateCode' in w.patch)
  const cold = () => {
    soopApi.gates.clear()
    soopApi.playCache.clear()
    soopApi.gatesHydrated = false
  }
  world.anchors = [anchor({ userId: 'gp1', isLive: true }), anchor({ userId: 'gp2', isLive: true }), anchor({ userId: 'gp3', isLive: true })]
  world.apiChannel = { RESULT: -6 }
  const g1 = await soopApi.getPlayCached('gp1')
  assert(g1.needLogin === true && A('gp1').gateCode === 'login', 'M4a 盘上那一格带的是映射后的码, 不是给用户看的那句话(与 Panda 的 T34c-1 同规约: 话由码现生成, 换语言不把旧话钉在旧语言上)', `盘=${A('gp1').gateCode}`)
  assert(A('gp1').gateUntil > Date.now() + 14 * 60_000 && A('gp1').gateUntil < Date.now() + 16 * 60_000, 'M4b 落盘的就是那把扁平 15 分钟的尺(没有阶梯, 也不是一天)', `剩=${((A('gp1').gateUntil - Date.now()) / 60_000).toFixed(1)}分`)
  assert(Math.abs(soopApi.gates.get('gp1').until - A('gp1').gateUntil) < 2000, 'M4c 内存与盘写的是同一个到期时刻(从前两本各写各的 ⇒ 屏上"多久过期"与"重启后还挡着"说的不是同一件事)', `内存=${soopApi.gates.get('gp1').until} 盘=${A('gp1').gateUntil}`)
  assert(gw().length === 1 && gw()[0].userId === 'gp1', 'M4d 整条取流链只为这一格多写一笔锚点(落盘不是"每次取源都顺手覆写一遍库")', `写次=${gw().length}`)
  world.apiChannel = { BPWD: 'Y' }
  await soopApi.getPlayCached('gp2')
  assert(A('gp2').gateCode === 'pw', 'M4e 密码房也落盘: 密码是主播设的房间属性, 重启不会让它自己消失(那一整链的其余 8~9 发每一台冷启动都白付)', `盘=${A('gp2').gateCode}`)
  // 重启的诚实形状: 进程内存(Map)清空, 盘上那两格跟着 db.json 活下来
  cold()
  world.apiChannel = { RESULT: -6 }
  world.fetches.length = 0
  const r2 = await soopApi.getPlayCached('gp1')
  assert(r2.needLogin === true && world.fetches.length === 0, 'M4f 冷启动后同一间零发: 读回来的仍是平台那句话(这就是这一格买到的全部: 每次冷启动每间省下整链 9~10 发)', `实发=${world.fetches.length}`)
  cold()
  world.fetches.length = 0
  await soopApi.getPlayCached('gp2')
  assert(world.fetches.length === 0, 'M4g 密码房同样跨重启短路(预取泵永远没有密码 ⇒ 这一类不读回来就是每场重打一遍)', `实发=${world.fetches.length}`)
  // 到期: 当没读到, 并顺手从盘上抹掉, 下一次照旧真问
  cold()
  A('gp1').gateUntil = Date.now() - 1000
  world.fetches.length = 0
  await soopApi.getPlayCached('gp1')
  assert(world.fetches.length > 0, 'M4h 到期即自愈: 冷却到点就是该再问一次(过期账不许留成永久挡)', `实发=${world.fetches.length}`)
  assert(gw().some((w) => w.userId === 'gp1' && w.patch.gateCode === '' && w.patch.gateUntil === 0), 'M4i 抹的是盘上那一格, 不只是内存(只清内存 = 下一次重启它又活 15 分钟, 而这 15 分钟早就过去了)')
  // 上一版(阶梯 / 一天)留在盘上的长到期日不许把新尺子押到明天
  cold()
  A('gp1').gateUntil = Date.now() + 20 * 3600_000
  world.fetches.length = 0
  await soopApi.getPlayCached('gp1')
  assert(soopApi.gates.get('gp1').until - Date.now() < 16 * 60_000 && world.fetches.length === 0, 'M4j 读回钳位: 盘上写着 20 小时后放行, 内存最多认从现在起 15 分钟 —— 钳位是"读成 15 分钟", 不是"重问一次"', `内存剩=${((soopApi.gates.get('gp1').until - Date.now()) / 60_000).toFixed(1)}分 实发=${world.fetches.length}`)
  // 平台改口: 两本一起撤
  cold()
  world.apiChannel = null // 一切照常 ⇒ 整链拿到源
  const ok1 = await soopApi.getPlayCached('gp1', '', true)
  assert(ok1.ok === true && !soopApi.gates.has('gp1') && A('gp1').gateCode === '' && A('gp1').gateUntil === 0, 'M4k 拿到源当场把两本账一起撤(内存 + 盘): 没有这一笔, 落了盘那一格就成了单向棘轮 —— 用户补好登录、主播撤了密码, 短路口仍替他挡掉整条链', `盘=${JSON.stringify([A('gp1').gateCode, A('gp1').gateUntil])}`)
  const w1 = gw().length
  cold()
  await soopApi.getPlayCached('gp1')
  assert(gw().length === w1, 'M4l 手上已有源时不再重打链, 也不为"没账"写盘(无账不写: 每次正常取源都覆写一遍库就是纯粹的写放大)', `新增写=${gw().length - w1}`)
  // 密码不对那一类: 内存与盘都不许留格(下一次可能就把密码改对了)
  reset()
  world.anchors = [anchor({ userId: 'gp3', isLive: true })]
  world.apiChannel = { BPWD: 'Y', RESULT: 0 }
  const w3 = await soopApi.getPlayCached('gp3', 'wrong')
  assert(w3.needPassword === true && !soopApi.gates.has('gp3') && !A('gp3').gateCode, 'M4m 密码不对既不进内存账也不落盘: 这是"用户下一次可能改对"那一类, 钉在盘上就是把纠错钉死 15 分钟 × 每次重启', `盘=${A('gp3').gateCode}`)
  // 读回那一趟的门: 别的平台的行不算
  reset()
  world.anchors = [anchor({ userId: 'gp1', isLive: true, platform: 'pandalive', gateCode: 'login', gateUntil: Date.now() + 600_000 })]
  world.apiChannel = null // 一切照常 ⇒ 真问必然拿到源; 读回来了就必然是 needLogin + 零发
  world.fetches.length = 0
  const r4 = await soopApi.getPlayCached('gp1')
  assert(r4.ok === true && world.fetches.length > 0 && !soopApi.gates.has('gp1'), 'M4n 盘上那本是分平台的: Panda 行上的门槛账不许被 SOOP 读回(两平台同一个 userId 完全可能, 读串了就是拿一站的"过不去"去挡另一站的整条链)', `话=${r4.error} 实发=${world.fetches.length}`)
  // 换号: 内存整本 + 盘上逐行, 且"读回一次"那面旗归位
  reset()
  world.anchors = [anchor({ userId: 'gp1', isLive: true }), anchor({ userId: 'gp2', isLive: true })]
  world.apiChannel = { RESULT: -6 }
  await soopApi.getPlayCached('gp1')
  world.apiChannel = { BPWD: 'Y' }
  await soopApi.getPlayCached('gp2')
  soopApi.clearPlayCache()
  assert(!soopApi.gates.has('gp1') && !A('gp1').gateCode && !A('gp2').gateCode && A('gp1').gateUntil === 0 && A('gp2').gateUntil === 0, 'M4o 换号连盘一起清: 上一号的"要登录/要密码"对新号一格都不许留(新号过不过得去是另一回事)', `盘=${JSON.stringify([A('gp1').gateCode, A('gp2').gateCode])}`)
  world.apiChannel = { RESULT: -6 }
  world.fetches.length = 0
  await soopApi.getPlayCached('gp1')
  assert(world.fetches.length > 0, 'M4p 清完读回也是空: 新账号第一次照问平台(不继承上一号的"过不去" —— 读回那面旗没归位就是这一格要抓的)', `实发=${world.fetches.length}`)
  // ⑫ 读数: 落盘之后 persisted 不能再恒 false
  const d = soopApi.diag().gates.find((x) => x.room === 'gp1')
  assert(d && d.kind === 'login' && d.persisted === true, 'M4q 诊断台 ⑫: SOOP 那一格现在带平台侧的码 + 「重启后还挡着」(从前 persisted 对 SOOP 恒写 false = 落盘之后就成了假读数)', JSON.stringify(d))
}

// ============ N: 播放器亲证死源: 作废只摘那一份源包, 不动任何防重复的账 ============
// 现场(2026-10-03 23:33:38 @kurzzang123, Panda): 播放器已经拿到 manifestLoadError http=404, 而主进程缓存里
// 那一份直到 23:38:52 才被保活的双测追认 —— 中间 5min14s 卡片一直挂着「秒开」。这一节数的是"作废那一句的宽度":
// 旧写法走 invalidatePlay, 顺手把门槛账/本场已买档/纪元一起撤(H6a 证的正是那一条), 于是下一次问价重打整链 ——
// 拿一次作废换来的是加请求, 与用户定的口径相反。窄作废(dropCachedPlay)只删 playCache 那一格。
console.log('N1 dropCachedPlay 的形状: 亲证地址对得上才摘, 摘完零请求, 防重复的那几本账一条不动')
reset()
{
  const pack = await soopApi.getPlayCached('nd1', '', true)
  assert(pack.ok === true && soopApi.cachedSourceIds().includes('soop:nd1'), 'N1a 先正常拉一枚进缓存(下面才有"那一份死源"可摘)', pack.error)
  soopApi.gates.set('nd1', { until: Date.now() + 600_000, pack: { ok: false, needLogin: true, error: 'gate(sim)' }, code: 'login' }) // 这一格连码一起摆(码只从 gateKind 来, 现场手摆的替身也要带上)
  soopApi.partialBuy.set('nd1', { bno: '12345678', bought: [{ name: 'hd', variant: { url: 'v', bandwidth: 1, resolution: '720p' } }] })
  const epoch0 = soopApi.epochOf('nd1')
  world.fetches.length = 0
  assert(soopApi.dropCachedPlay('nd1', 'http://127.0.0.1:0/x?url=%E4%B8%8D%E6%98%AF%E8%BF%99%E4%B8%AA') === false, 'N1b 报的地址不是手里这一份 ⇒ 不摘(源早被换过, 播放器踩死的是旧的那一串)')
  assert(soopApi.cachedSourceIds().includes('soop:nd1'), 'N1c 对不上时缓存原样留着(这时徽标说的还是实话)')
  assert(soopApi.dropCachedPlay('nd1', pack.m3u8) === true, 'N1d 对得上的那一句才真摘')
  assert(!soopApi.cachedSourceIds().includes('soop:nd1'), 'N1e 摘完「已缓存」清单里没它了(卡片徽标当场改口)')
  assert(world.fetches.length === 0, 'N1f 作废本身零请求', `req=${world.fetches.length}`)
  assert(soopApi.gates.has('nd1') && soopApi.partialBuy.has('nd1'), 'N1g 门槛账与本场已买档都在(旧写法把两本一起撤 ⇒ 下一次问价重打整链, 见 H6a)')
  assert(soopApi.epochOf('nd1') === epoch0, 'N1h 纪元没动: 在飞的链是此刻向平台问的新价, 它落回来正是要的那一份')
  world.fetches.length = 0
  const g = await soopApi.getPlayCached('nd1')
  assert(world.fetches.length === 0 && g.needLogin === true, 'N1i 摘过之后非强制取流吃的仍是门槛账短路 = 一发不发(这就是"作废不加请求"的落地读数)', `req=${world.fetches.length}`)
}

console.log('N2 播放器停在别的档位上: variants 里对得上一样算亲证(切过清晰度后死的是那一条)')
reset()
world.apiChannel = { VIEWPRESET: PRESETS2 }
{
  const full = await soopApi.getPlayCached('nd2', '', true, true)
  assert(full.ok === true && full.variants?.length === 2, 'N2a 满档菜单两档(播放器可能停在任何一档上)', `档=${full.variants?.length}`)
  world.fetches.length = 0
  assert(soopApi.dropCachedPlay('nd2', full.variants[1].url) === true, 'N2b 第二档那条也是"手里这一份"里的地址 ⇒ 摘')
  assert(!soopApi.cachedSourceIds().includes('soop:nd2') && world.fetches.length === 0, 'N2c 摘干净且仍是零请求', `req=${world.fetches.length}`)
}

console.log('N3 强制重取没拿到源: 作废的是"这条链出发之前"那一份, 出发之后写进来的那份不许顺手摘')
reset()
{
  const old = await soopApi.getPlayCached('nd3', '', true)
  assert(old.ok === true, 'N3a 先有一枚在缓存里(它就是重取失败时该被摘的那一份)', old.error)
  world.apiChannel = { RESULT: -6 } // 会话被服务端作废: 这一发真打出去了, 没拿到源
  world.logWarn.length = 0
  const flying = soopApi.getPlayCached('nd3', '', true) // 链已出发
  assert(soopApi.playInflight.has('nd3#top'), 'N3a2 在飞表里还有它 ⇒ 下面那次 set 发生在这一条链落地之前(没有这一句, 整组只是碰巧的时序)')
  // 在飞窗口里另一条链(带密/只最高档的键不同)把更新的源写了进来 —— 那份没说谎, 摘它就是白删一次秒开
  soopApi.playCache.set('nd3', { ...old, m3u8: 'http://127.0.0.1:0/x?url=newer', fetchedAt: Date.now() })
  const r3 = await flying
  assert(r3.ok === false && r3.needLogin === true, 'N3b 失败照实回报给调用方(作废不改写答案)', JSON.stringify(r3))
  assert(soopApi.playCache.get('nd3')?.m3u8 === 'http://127.0.0.1:0/x?url=newer', 'N3c 出发之后写进来的那份活着(旧写法一律 invalidatePlay = 把刚买到的好源也一起撤, 下一次再打整链)')
  assert(!world.logWarn.some((m) => /当场作废手里那份/.test(m)), 'N3d 没摘就不许留那句痕(留痕是职责, 假痕是骗人)')
  // 正常形状: 手里那份早于这条链
  soopApi.gates.delete('nd3') // 上一发把"要登录"记进了门槛账; 强制重取本来就不看它, 摘掉只为让下面那句读数干净
  const held3 = soopApi.playCache.get('nd3')
  if (held3) held3.fetchedAt -= 5000 // 让手里这份确实老于下一条链的出发时刻(同一毫秒会让 < 不成立: 那是夹具的抖动, 不是被测的语义)
  world.apiChannel = { RESULT: -6 }
  world.logWarn.length = 0
  world.fetches.length = 0
  const r4 = await soopApi.getPlayCached('nd3', '', true)
  assert(r4.ok === false && !soopApi.playCache.has('nd3'), 'N3e 手里那份是这条链出发之前的 ⇒ 当场作废(挂着的「秒开」就是骗人的那一个)')
  assert(world.logWarn.some((m) => /强制重取没拿到源, 当场作废手里那份: @nd3/.test(m)), 'N3f 作废在日志里出声(事后数包的人要能看出这一间被撤过一次)')
  assert(apiHits('live') === 1, 'N3g 这一趟只有重取那一条链: 作废本身不搭任何一发(旧写法跟着撤的门槛账/买档账会让下一次问价再打一条)', `主信息=${apiHits('live')}`)
}

console.log('N4 那一句"这次没带密码"不是源死了的证据: needPassword 不作废')
reset()
{
  const pwPack = await soopApi.getPlayCached('nd5', '', true)
  assert(pwPack.ok === true, 'N4a 先有一枚不带密码拿到的源', pwPack.error)
  // 让手里这份老于下一条链的出发时刻: 不然该摘的那一格会被时戳判据先挡掉(毫秒级的巧合会把变异藏起来)
  const held5 = soopApi.playCache.get('nd5')
  if (held5) held5.fetchedAt -= 5000
  world.apiChannel = { BPWD: 'Y', RESULT: 0 } // 平台改口说这房要密码: 强制重取这一发回 needPassword
  world.logWarn.length = 0
  const pwR = await soopApi.getPlayCached('nd5', '', true)
  assert(pwR.ok === false && pwR.needPassword === true, 'N4b 回报的是"要密码"', JSON.stringify(pwR))
  assert(soopApi.playCache.has('nd5'), 'N4c 手里那份留着: 那句说的是"这次没带密码", 不是"源死了"(带过密码的那份照旧能用)')
  assert(!world.logWarn.some((m) => /当场作废手里那份/.test(m)), 'N4d 这一格不出声')
}

// ============ O: 登录态那行日志的第四档「合并」(真 ipc.ts + 真 soop.ts + 可计数请求) ============
// 现场: 启动期 authState、自愈核对、登录窗口关掉之后的 pushAccounts 会在同一瞬连着取态,
//   而结果缓存(2 分钟)要等那一发落地才写得上 ⇒ 吃掉那几发的是在途合并, 不是缓存。
// 三档年代那一行读作「真发」, 于是"按日志行数复请求数"这件事在合流的那几行上又是错的(那一格要治的正是它)。
// 这一节的判据不是"有没有旗", 而是那一行日志到底说了什么 —— 走的是真处理器, 不是直接调 api。
const authH = () => world.ipc[CH.authState]()
const soopLines = () => world.logInfo.filter((m) => String(m).startsWith('SOOP 登录态核对'))
const verifyOf = (line) => /官方校验\[([^\]]+)\]/.exec(String(line))?.[1] || ''
const loginHits = () => world.fetches.filter((f) => String(f.url).includes('get_private_info')).length

console.log('O1 同一瞬的两问: 一行「真发」一行「合并」, 而发数只有一发')
reset()
await soopApi.storeCookies('UserTicket=abc') // 会话罐里有一枚 Cookie: 这一问是有凭证的
world.loginDelayMs = 40 // 合流要有真窗口: 两问若在同一批微任务里跑完就等于没测到这一支
{
  const q1 = authH()
  await new Promise((r) => setTimeout(r, 10)) // 第一条链已在飞表里登记好(没有这一句, 第二问只是碰巧的时序)
  const q2 = authH()
  const [s1, s2] = await Promise.all([q1, q2])
  const L = soopLines()
  world.loginDelayMs = 0
  assert(L.length === 2, 'O1a 两问各落一行(每取一次态就落一行, 这一格没变)', `行数=${L.length}`)
  assert(loginHits() === 1, 'O1b 两问只发一发(合并原本就在, 这一节补的是它那句自证)', `实发=${loginHits()}`)
  assert(verifyOf(L[0]) === '真发' && verifyOf(L[1]) === '合并', 'O1c 那两行的字样: 出门那一行「真发」, 接别人那一发的那一行「合并」', L.map(verifyOf).join(','))
  assert(s1.soop.realLogin === true && s2.soop.realLogin === true, 'O1d 两问读到的是同一条真答案(合并只多一面旗, 界面那格一字未改)', JSON.stringify([s1.soop, s2.soop]))
  assert(s1.soop.lastVerifyAt === s2.soop.lastVerifyAt && s1.soop.lastVerifyAt > 0, 'O1e 「上次校验」那格只认真发出门的时刻, 合流那一问不许把它往前推', `${s1.soop.lastVerifyAt}/${s2.soop.lastVerifyAt}`)
}

console.log('O2 那一发落定之后再问才是「缓存」: 四档字样互斥, 同一次取态只可能是一种')
{
  const before = loginHits()
  const s3 = await authH()
  const L = soopLines()
  assert(before === 1 && loginHits() === 1, 'O2a 三问一发(缓存吃掉了第三问)', `实发=${loginHits()}`)
  assert(verifyOf(L[L.length - 1]) === '缓存' && s3.soop.realLogin === true, 'O2b 第三行读「缓存」而不是「合并」(两档混了就分不清"缓存里读的"和"接别人那一发")', verifyOf(L[L.length - 1]))
  assert(L.filter((x) => verifyOf(x) === '合并').length === 1, 'O2c 三行里恰好一行「合并」(旗不会跟着缓存一起复述)', L.map(verifyOf).join(','))
}

console.log('O3 匿名态压根不发那一发: 「未问」与「合并」是两件事')
reset()
{
  const s = await authH()
  const L = soopLines()
  assert(loginHits() === 0 && verifyOf(L[0]) === '未问', 'O3a 无 Cookie ⇒ 零发且读作「未问」(它不是「合并」: 合并说的是"有人替我问了", 未问说的是"没人有凭证可问")', `${verifyOf(L[0])}/发=${loginHits()}`)
  assert(s.soop.hasCookies === false && s.soop.realLogin === false, 'O3b 投影照旧(标记只给日志读, 界面那一格不变)', JSON.stringify(s.soop))
}

console.log('O4 那一发出门就失败(netFail)时: 「合并」说的是"我没出门", 不是"我失败了" —— 两格各说各的')
reset()
await soopApi.storeCookies('UserTicket=abc')
{
  world.loginStatus = 500 // 校验接口整个不接待: 那一发回的是"读不到", 不是"没登录"
  world.loginDelayMs = 40
  const q1 = authH()
  await new Promise((r) => setTimeout(r, 10))
  const q2 = authH()
  await Promise.all([q1, q2])
  world.loginDelayMs = 0
  const L = soopLines()
  assert(loginHits() === 1 && L.length === 2, 'O4a 两问一发(失败链照样被合流, 不会因为"没答案"就多打一遍)', `实发=${loginHits()} 行=${L.length}`)
  assert(L.every((x) => /官方校验\[[^\]]+\]=请求失败\(网络\/风控\)/.test(String(x))), 'O4b 两行都报"请求失败", 但各带自己那一档字样(合并冒充不了真发, 也改不了结论)', L.map(verifyOf).join(','))
  assert(verifyOf(L[0]) === '真发' && verifyOf(L[1]) === '合并', 'O4c 第一行真发、第二行合并', L.map(verifyOf).join(','))
  // netFail 不进结果缓存(与"明确没登录"相反, 见): 下一问照旧真发, 而且那一问是自己出门的
  const n = loginHits()
  world.loginStatus = 200
  const s3 = await authH()
  assert(loginHits() === n + 1 && verifyOf(soopLines().pop()) === '真发' && s3.soop.realLogin === true, 'O4d 失败答案不被缓存吃掉: 第三问自己出门并读出「真发」', `新增发=${loginHits() - n}`)
}

// ============ P: Panda 那一行的四档(真 ipc.ts + 真 pandalive.ts + 可计数 login_info) ============
// O 段测的是 SOOP 那一行, 这一节是它在 Panda 侧的孪生: 判档在 pandaAccount/soopAccount 里各写一遍, 只测一边就是半边验收。
// 为什么走真 pandalive.ts: 「合并」那一档长在它的在飞表里(pandalive.ts:651~655), 替身给不出这个形状, 只能给出"调用过"。
const pandaLines = () => world.logInfo.filter((m) => String(m).startsWith('Panda 登录态核对'))
const liHits = () => world.liCalls.length

console.log('P1 Panda 那一行同一瞬的两问: 一行「真发」一行「合并」, 而发数只有一发')
reset()
world.pandaSession = true
world.pandaLoginDelayMs = 40
{
  const q1 = authH()
  await new Promise((r) => setTimeout(r, 10)) // 第一条链登记好之后第二问才是"接别人那一发", 没有这一句就是碰巧的时序
  const q2 = authH()
  const [s1, s2] = await Promise.all([q1, q2])
  world.pandaLoginDelayMs = 0
  const L = pandaLines()
  assert(L.length === 2, 'P1a 两问各落一行(每取一次态一行, 这一格与 SOOP 同形)', `行数=${L.length}`)
  assert(liHits() === 1, 'P1b 两问只发一发(30 秒结果缓存要等那一发落地才写得上, 吃掉这两发的是在途合并)', `实发=${liHits()}`)
  assert(verifyOf(L[0]) === '真发' && verifyOf(L[1]) === '合并', 'P1c Panda 那两行的字样与 SOOP 那一组同一把尺(判序换了就是同一行在两个平台上说不同的话)', L.map(verifyOf).join(','))
  assert(s1.pandalive.realLogin === true && s2.pandalive.realLogin === true, 'P1d 合流那一问读到的是同一条真答案(旗之外不差任何一格)', JSON.stringify([s1.pandalive, s2.pandalive]))
  assert(s1.pandalive.isAdult === true && s2.pandalive.isAdult === true, 'P1e 「+成人认证」那半句也跟着原样走(合流不是降级读数)')
}

console.log('P2 那一发落定之后再问才是「缓存」: 四档在 Panda 这一行同样互斥')
{
  const before = liHits()
  const s3 = await authH()
  const L = pandaLines()
  assert(before === 1 && liHits() === 1, 'P2a 三问一发(缓存吃掉了第三问)', `实发=${liHits()}`)
  assert(verifyOf(L[L.length - 1]) === '缓存' && s3.pandalive.realLogin === true, 'P2b 第三行读「缓存」而不是「合并」(两档混了就分不清"缓存里读的"和"接别人那一发")', verifyOf(L[L.length - 1]))
  assert(L.filter((x) => verifyOf(x) === '合并').length === 1, 'P2c 三行里恰好一行「合并」(旗不会跟着缓存一起复述)', L.map(verifyOf).join(','))
}

console.log('P3 会话罐里压根没 Cookie: 「未问」与「合并」是两件事')
reset()
{
  const s = await authH()
  const L = pandaLines()
  assert(liHits() === 0 && verifyOf(L[0]) === '未问', 'P3a 无会话 ⇒ 零发且读作「未问」(它不是「合并」: 合并说"有人替我问了", 未问说"没凭证可问")', `${verifyOf(L[0])}/发=${liHits()}`)
  assert(s.pandalive.loggedIn === false && s.pandalive.realLogin === false, 'P3b 投影照旧(标记只给那行日志读, 界面那格不变)', JSON.stringify(s.pandalive))
}

console.log('P4 那一发出门就失败(netFail)时: 「合并」冒充不了真发, 也改不了结论')
reset()
world.pandaSession = true
world.pandaLiThrow = true
world.pandaLoginDelayMs = 40
{
  const q1 = authH()
  await new Promise((r) => setTimeout(r, 10))
  const q2 = authH()
  await Promise.all([q1, q2])
  world.pandaLoginDelayMs = 0
  const L = pandaLines()
  assert(liHits() === 1 && L.length === 2, 'P4a 两问一发(失败链照样被合流, 不会因为"没答案"就多打一遍)', `实发=${liHits()} 行=${L.length}`)
  assert(L.every((x) => /官方校验\[[^\]]+\]=请求失败\(网络\/风控\)/.test(String(x))), 'P4b 两行都报"请求失败", 但各带自己那一档字样', L.map(verifyOf).join(','))
  assert(verifyOf(L[0]) === '真发' && verifyOf(L[1]) === '合并', 'P4c 第一行真发、第二行合并')
  world.pandaLiThrow = false
  const n = liHits()
  const s3 = await authH()
  assert(liHits() === n + 1 && verifyOf(pandaLines().pop()) === '真发' && s3.pandalive.realLogin === true, 'P4d 失败答案不进 30 秒结果缓存(与失败不入缓存那条规约同尺): 第三问自己出门并读出「真发」', `新增发=${liHits() - n}`)
}

console.log('P5 「立即重新校验」那一发: 它自己出门、不冒充任何人, 但它那一行不出 —— 数「真发」行会少算它(已知残项)')
reset()
world.pandaSession = true
{
  const s0 = await authH() // 先让缓存里有一格(第一问自己出门并落一行「真发」)
  const n = liHits()
  const s1 = await world.ipc[CH.authRecheck](null, 'pandalive')
  const L = pandaLines()
  assert(liHits() === n + 1, 'P5a 强制那一问真出门(30 秒缓存与在飞表都挡不住它)', `新增发=${liHits() - n}`)
  assert(L.filter((x) => verifyOf(x) === '合并').length === 0, 'P5b 这一节零面「合并」旗: 校验按钮那一发不许被这面旗冒充(与 T55-7 同一条)')
  assert(verifyOf(L[L.length - 1]) === '缓存', 'P5c 紧随的取态读的是刚被强制刷新过的那一格 ⇒ 它说「缓存」是真话, 但那一发自己没有行 —— 这一格锁的是现状, 谁要改这个口径就得同时改这一句', L.map(verifyOf).join(','))
  assert(s1.pandalive.lastVerifyAt >= s0.pandalive.lastVerifyAt && s1.pandalive.lastVerifyAt > 0, 'P5d 「上次校验」那格由真发出门的那一问往前推', `${s0.pandalive.lastVerifyAt}/${s1.pandalive.lastVerifyAt}`)
}

// ============ Q: 播放器报案那一路: 处理器把"亲证的那一条地址"交到主进程手里 ============
// N1/N2 测的是 dropCachedPlay 自己的形状(对得上才摘); 这一节测它前面那一段: ipc.ts 收了四个参数、过入参闸、
// 再把第三个原样递下去。少递一位, 主进程就只剩"不问一句就摘" —— 那是白删一次好秒开, 而契约上写的是"对一遍"。
const deadH = (plat, uid, dead) => world.ipc[CH.liveSrcDead](null, plat, uid, dead)

console.log('Q1 亲证地址一路走到主进程: 带地址与不带地址是两种形状, 不许混')
reset()
{
  const ok1 = await deadH('pandalive', 'u1', 'https://mock/x1.m3u8')
  assert(world.deadCalls.length === 1 && world.deadCalls[0].dead === 'https://mock/x1.m3u8', 'Q1a 处理器把亲证的那一条原样交下去(少了这一格, "对一遍才摘"就退化成"不问就摘")', JSON.stringify(world.deadCalls[0] || {}))
  assert(world.deadCalls[0].uid === 'u1', 'Q1b 房间号同样原样(两站各自的缓存按它取那一包)', JSON.stringify(world.deadCalls[0] || {}))
  assert(ok1 === true, 'Q1c 摘到了就回报 true(渲染层据此决定手里那份死地址留不留)', String(ok1))
  world.deadCalls.length = 0
  const ok2 = await deadH('soop', 'u2')
  assert(world.deadCalls.length === 1 && world.deadCalls[0].dead === undefined, 'Q1d 没有亲证地址时交下去的是 undefined, 不是空字符串冒充一条地址', JSON.stringify(world.deadCalls[0] || {}))
  assert(ok2 === true, 'Q1e 这一路照旧摘整包(报案没带地址仍是有效报案)')
}

console.log('Q2 非法寻址在摘源之前就挡掉: 一次都不许落到主进程里去')
reset()
{
  const bad = await deadH('pandalive', 'a/../b', 'https://mock/x.m3u8')
  assert(bad === false && world.deadCalls.length === 0, 'Q2a 房间 id 不合法 ⇒ 不查不摘(这一口拿的是渲染层递进来的两个字符串)', `${bad}/${JSON.stringify(world.deadCalls)}`)
  const badPlat = await deadH('nonsense', 'u1', 'https://mock/x.m3u8')
  assert(badPlat === false && world.deadCalls.length === 0, 'Q2b 平台不合法同样早退', `${badPlat}/${JSON.stringify(world.deadCalls)}`)
}

console.log('Q3 那条字符串先过闸再往下走: 截 500 位、控制字符一个不剩')
reset()
{
  await deadH('pandalive', 'u1', 'h'.repeat(600))
  // 三处都写 `?.dead`: 地址整个没交下来的那种刀(变异 A2-2)会一路走到这里, 直读 .length 会把"崩套"当成"红" —— 红要红在断言行上
  assert(world.deadCalls[0]?.dead?.length === 500, 'Q3a 超长截到 500(它是地址不是口令, 尺要按地址的最长形状)', String(world.deadCalls[0]?.dead?.length))
  world.deadCalls.length = 0
  await deadH('pandalive', 'u1', 'https://mock/a.m3u8\r\n伪造一行\n')
  assert(!/[\u0000-\u001f\u007f]/.test(String(world.deadCalls[0]?.dead)), 'Q3b 控制字符(含换行)一个都不往下走 —— 这串东西将来会进日志与账', JSON.stringify(world.deadCalls[0]?.dead))
  assert(world.deadCalls[0]?.dead === 'https://mock/a.m3u8伪造一行', 'Q3c 只去控制字符, 不"顺手"改地址的其余部分(改了就对不上那一条真地址)', JSON.stringify(world.deadCalls[0]?.dead))
}

console.log('Q4 留痕是职责: 摘掉与没摘掉说两句不同的话, 没摘不许假报')
reset()
{
  world.deadDrops = true
  await deadH('pandalive', 'u1', 'https://mock/x.m3u8')
  assert(world.logWarn.some((m) => /缓存那份已当场作废/.test(String(m))), 'Q4a 摘掉了要说"已当场作废"', JSON.stringify(world.logWarn))
  world.logWarn.length = 0
  world.deadDrops = false
  const r = await deadH('pandalive', 'u1', 'https://mock/y.m3u8')
  assert(r === false, 'Q4b 没摘就回报 false(处理器不许把"没摘"报成"摘了")', String(r))
  assert(world.logWarn.some((m) => /缓存里没有那一份/.test(String(m))), 'Q4c 没摘要说"缓存里没有那一份(源已被换过或本就没有)"', JSON.stringify(world.logWarn))
  assert(!world.logWarn.some((m) => /已当场作废/.test(String(m))), 'Q4d 没摘就不许留那句痕(假痕就是骗人, 与 N3d 同一把尺)')
}

// ============ R: 秒开快道 —— 播放器入口先出画, 清晰度菜单在后台补齐 ============
// 被测的不是"有没有第二条链", 而是"补齐那一发有没有压在用户等第一帧的路上":
// 当年"残缺包不许交给满档 caller"判得对(菜单缺档 ≠ 秒开), 但它连带把出画也挡在了整链后面。
// 现在 getPlayFast 把那份只解了最高档的包直接交给播放器, 补齐那一发与渲染层随后 liveMenu 那一发
// 命中的是同一条在飞链 —— 请求数与旧写法一字不差(实测见 R2d/R3b 的发数账)。
console.log('R1 手里没包: 快道不省档, 一次买齐菜单')
reset()
world.apiChannel = { VIEWPRESET: PRESETS2 }
{
  const r = await soopApi.getPlayFast('r1')
  assert(r.ok === true && r.variants.length === 2 && r.partial === false, 'R1a 冷启那一发交出去的是满档包(快道不是"只给一档"的借口)', `档=${r.variants?.length} partial=${r.partial}`)
  assert(apiHits('aid') === 2 && assignHits() === 2, 'R1b 两档各 1+1 发, 没被悄悄降级成省发(降级=清晰度菜单缺档, 正是"不许悄悄省发"那条规矩)', `aid=${apiHits('aid')} assign=${assignHits()}`)

  console.log('R2 预取买过最高档的房: 进房那一发零请求拿包, 补齐只在后台排一条链')
  reset()
  world.apiChannel = { VIEWPRESET: PRESETS2 }
  const pre = await soopApi.getPlayCached('r2', '', false, false) // 后台泵的形状(省发)
  assert(pre.ok && pre.partial === true && pre.variants.length === 1, 'R2a0 先自证手里那份确实是残缺包 —— 不是残缺就测不到快道改了什么的这一格')
  world.fetches.length = 0
  world.logInfo.length = 0
  const fast = await soopApi.getPlayFast('r2')
  assert(fast.partial === true && fast.m3u8 === pre.m3u8, 'R2a 进房那一发直接拿到预取买到的那一份(同一条地址 ⇒ 出画不必等整链)', `${fast.m3u8} vs ${pre.m3u8}`)
  assert(soopApi.playInflight.size === 1, 'R2b 后台补齐只排了一条链: 补齐是"顺手一起"的, 不是进房另打一条', `在飞=${soopApi.playInflight.size}`)
  assert(await until(() => soopApi.playInflight.size === 0), 'R2c 后台那条链会自己落地(不等就是"补齐永远在路上")')
  const back = soopApi.playCache.get('r2')
  assert(back.variants.length === 2 && back.partial === false, 'R2c2 落地后缓存从此不缺档(切清晰度有得切)', `档=${back.variants?.length}`)
  assert(apiHits('aid') === 1 && assignHits() === 1, 'R2d 补齐只买差的那一档(1+1 发) —— 旧写法在这里是整链重买 2+2 发, 且压在用户等第一帧的路上', `aid=${apiHits('aid')} assign=${assignHits()}`)

  console.log('R3 渲染层随后那一发 liveMenu: 与后台那一发合流, 不多打一条链')
  reset()
  world.apiChannel = { VIEWPRESET: PRESETS2 }
  await soopApi.getPlayCached('r3', '', false, false)
  world.fetches.length = 0
  await soopApi.getPlayFast('r3') // 这一发起后台补齐
  const menu = await soopApi.getPlayMenu('r3')
  assert(menu.ok && menu.variants.length === 2, 'R3a liveMenu 交回完整菜单(它就是"菜单最终要齐"的那一条腿)')
  assert(apiHits('aid') === 1 && assignHits() === 1 && soopApi.playInflight.size === 0, 'R3b 两问命中同一条在飞链: 补齐那一发自己不再买第二条(旧写法: 快道 2+2 加菜单 2+2)', `aid=${apiHits('aid')} assign=${assignHits()} 在飞=${soopApi.playInflight.size}`)

  console.log('R4 带密码来的那一发: 不许顺手起一条"注定被拒"的无密整链')
  reset()
  world.apiChannel = { VIEWPRESET: PRESETS2 }
  await soopApi.getPlayCached('r4', '', false, false) // 预取泵形状(永远没有密码)
  world.fetches.length = 0
  const pw = await soopApi.getPlayFast('r4', 'pw123')
  assert(pw.partial === true && soopApi.playInflight.size === 0, 'R4a 残缺包照给, 但不补无密那一条(泵永远没有密码 ⇒ 无密整链在这一间只换回一句"要密码")', `在飞=${soopApi.playInflight.size}`)
  await sleepMs(30)
  assert(soopApi.playInflight.size === 0 && apiHits('aid') === 0, 'R4b 30 毫秒后仍然没有那条链(不是"排了队还没出门")', `aid=${apiHits('aid')}`)
  const menuPw = await soopApi.getPlayMenu('r4', 'pw123') // 渲染层 fillMenu 带的是 lastPwd
  assert(menuPw.ok && menuPw.variants.length === 2 && apiHits('aid') === 2, 'R4c 补齐那一发带着密码出门, 于是它自己买齐两档(带密不接无密的复用账)', `aid=${apiHits('aid')}`)

  console.log('R5 手动强刷那一发仍然真强制: 快道不许把 force 吞成"复用手里那份"')
  reset()
  world.apiChannel = { VIEWPRESET: PRESETS2 }
  const held = await soopApi.getPlayCached('r5', '', false, false)
  world.fetches.length = 0
  const forced = await soopApi.getPlayFast('r5', '', true)
  assert(forced.m3u8 !== held.m3u8 || forced.variants.length === 2, 'R5a 强制位穿透了缓存(命中形状与 R2a 的"复用"分得开)', JSON.stringify({ held: held.m3u8, got: forced.m3u8 }))
  assert(forced.variants.length === 2 && apiHits('aid') === 1, 'R5b 强刷买的是满档, 而已经到手的最高档仍从复用账递出(省发与强制两件事互不牵连)', `档=${forced.variants.length} aid=${apiHits('aid')}`)
}

// ============ S: 源包跨重启留存 —— 判据全在列表那一发已经白送的读数上 ============
// 实测依据(2026-10-04 @soclato): aid 签发的上游地址静置 +1/+3/+10/+20/+40/+70/+110 分钟全部 200 且清单仍在往前走,
// 不带 Cookie 不带 Origin ⇒ 需要的是留存, 不是心跳。而 playCache 原本是纯内存的, 于是"七次开机 = 同一个
// bno 的整链重买七遍"(当天日志亲证)。留存必须存**上游**地址: 代理端口 listen(0) 随机、?t= 令牌每实例重
// 随机(本套的替身同样按 world.proxyGen 换地址), 存代理地址等于存一串重启后签不出去的废串。
const packFile = () => path.join(SANDBOX, 'playcache.json')
const readPackFile = () => JSON.parse(fs.readFileSync(packFile(), 'utf-8'))
/** 当前这一代代理签出去的本地地址(真代理每实例随机口 + 重随机令牌, 替身按 world.proxyGen 换) */
const UP = () => `http://127.0.0.1:${9100 + world.proxyGen}/x?t=g${world.proxyGen}&url=` + encodeURIComponent('https://livecast.sooplive.com/1-2-3.ts?aid=a')
/** 搭"盘上躺着某一场的一份包"这一现场: 走真实的 seedPlay→notePack→flush 码路, 不手写文件
 *  (手写文件的只有 S11, 那一节测的就是读回时对不上形状的条目) */
function seedStored(channel, over = {}) {
  soopApi.seedPlay(channel, { ok: true, bno: '12345678', m3u8: UP(), variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p', label: 'HD' }], partial: false, title: '在播标题', nick: '主播甲', startTime: '', media: { isPw: false }, ...over })
  soopApi.playCache.delete(channel) // 重启现场要的是"内存里没有, 盘上有"
}
/** 演一次"整个进程死过一遍": 代理换新实例(新端口/新令牌)、内存账全空、盘上那一份还在 */
function simulateRestart() {
  world.proxyGen++
  soopApi.proxy = null
  soopApi.proxyStarting = null
  soopApi.playCache.clear()
  soopApi.playInflight.clear()
  soopApi.bnoCache.clear()
  soopApi.partialBuy.clear()
  soopApi.gates.clear()
  soopApi.storedPacks.clear()
  soopApi.restorePlayCache()
}

console.log('S1 落盘的内容: 上游地址 + 场次号, 一个字节都不许是自家代理地址')
reset()
world.apiChannel = { VIEWPRESET: PRESETS2 }
{
  fs.rmSync(packFile(), { force: true })
  const full = await soopApi.getPlayCached('aaa111', '', false, true)
  assert(full.ok === true && full.bno === '12345678', 'S1a 取流包带上"这一包是为哪一场买的"(复活时唯一的零请求判据)', `bno=${full.bno}`)
  assert(!fs.existsSync(packFile()), 'S1b 写盘走合并窗口(2 秒), 关键路径上不多一次同步写')
  soopApi.flushPacks()
  assert(soopApi.persistTimer === null, 'S1b2 退出前 flush 要把挂起的那一次结掉(留着定时器就是退出时再写一遍旧账)')
  const sp = readPackFile().packs.aaa111
  assert(sp && sp.bno === '12345678' && sp.tiers.length === 2, 'S1c 按房记档: 号 + 两档地址', JSON.stringify(sp && { bno: sp.bno, n: sp.tiers?.length }))
  assert(
    sp.tiers.every((t) => /^https:\/\/livecast\.sooplive\.com\//.test(String(t.up)) && /aid=/.test(String(t.up))),
    'S1d 存的是 aid 签发后的上游地址(那才是播放器/ffmpeg 最终要打的串)',
    JSON.stringify(sp.tiers.map((t) => t.up))
  )
  const raw = JSON.stringify(sp)
  assert(!raw.includes('127.0.0.1') && !raw.includes('t=g'), 'S1e 盘上不许有代理地址或代理令牌(端口/令牌每实例重随机, 原样存回 = 重启后签不出去的废串)', raw.slice(0, 120))
  assert(sp.fetchedAt > 0 && sp.partial === false, 'S1f 取到它的时刻与档齐不齐同样落盘(过龄判据与"复活后菜单缺不缺"都要吃它)')

  console.log('S2 重启后同号: 列表那一发把两档地址原样接回缓存, 整趟零新增请求')
  {
    simulateRestart()
    world.fetches.length = 0
    world.logInfo.length = 0
    world.favBody = bodyOf([LIVE_ROW, OFF_ROW])
    const rows = await soopApi.fetchFavorites()
    assert(rows && rows.length === 2, 'S2a 列表那一发照旧返回两行(复活是这一发的顺带事, 不改变它的读数)')
    assert(world.fetches.length === 1 && String(world.fetches[0].url).includes('myapi'), 'S2b 整趟只有一发, 就是列表本身(复活不新增任何请求)', JSON.stringify(world.fetches.map((f) => f.url)))
    const back = soopApi.playCache.get('aaa111')
    assert(!!back && back.ok && back.variants.length === 2 && back.partial === false, 'S2c 两档地址回到缓存且菜单不缺档', `档=${back?.variants?.length}`)
    assert(String(back?.m3u8).includes(`t=g${world.proxyGen}`) && !String(back?.m3u8).includes(`t=g${world.proxyGen - 1}`), 'S2d 复活的是"重新签发"的那一条: 令牌跟着新实例走, 不是把旧代理地址塞回去', String(back?.m3u8))
    assert(back?.bno === '12345678' && back.title === '在播标题' && back.media?.isPw === false, 'S2e 场次号/标题/密码旗一并接回(卡片与播放器读的就是这几格)', JSON.stringify({ bno: back?.bno, title: back?.title, isPw: back?.media?.isPw }))
    assert(world.logInfo.some((m) => /源留存复活 1 间/.test(m)), 'S2f 复活要出声(真机据此确认这一格生效了)', world.logInfo.join(' | '))
    world.fetches.length = 0
    const fast = await soopApi.getPlayFast('aaa111')
    assert(world.fetches.length === 0 && fast.variants.length === 2, 'S2g 重启后进房: 整链一发不发 —— 这一格就是"七次开机 = 重买七遍"的终点', `req=${world.fetches.length}`)
  }

  console.log('S2H ①补: 复活的那一档同样递回已买档位那本复用账 —— 后台补齐只买差的那一档(真机 14:50:29 拍到的是"复活 1 档还买 4 档")')
  {
    fs.rmSync(packFile(), { force: true })
    seedStored('aaa111', { partial: true, variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p', label: 'HD', name: 'hd' }] })
    soopApi.flushPacks()
    simulateRestart()
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    const e = soopApi.partialBuy.get('aaa111')
    assert(!!e && e.bno === '12345678' && e.bought.length === 1 && e.bought[0].name === 'hd', 'S2H0 复活那一档带场次号进了复用账(与实例内买到的同一格式)', JSON.stringify(e && { bno: e.bno, n: e.bought.length, name: e.bought[0].name }))
    assert(String(soopApi.playCache.get('aaa111')?.variants?.[0]?.url).includes(`t=g${world.proxyGen}`), 'S2H0b 递进账的那一条是本次实例重新签发的地址(不是上一场的旧代理口)', String(soopApi.playCache.get('aaa111')?.variants?.[0]?.url))
    world.apiChannel = { VIEWPRESET: PRESETS2 }
    world.fetches.length = 0
    world.logInfo.length = 0
    const m = await soopApi.getPlayMenu('aaa111')
    assert(m.ok && m.variants.length === 2, 'S2H1 菜单齐了(两档都在, 切清晰度有得切)', `档=${m?.variants?.length}`)
    assert(apiHits('aid') === 1 && assignHits() === 1, 'S2H2 补齐只买差的那一档: 复活那一档的 aid+调度那两发不再重打(不接账就是旧形状 2+2)', `aid=${apiHits('aid')} assign=${assignHits()}`)
    assert(
      world.logInfo.some((l) => /复用已买档=1\(省 2 发\)/.test(l)),
      'S2H3 日志要说这一档是复用的(真机就读这一句)',
      world.logInfo.join(' | ')
    )
    // 老文件(升级前落的那一本, 没有 name)不许因此读不回来: 照旧复活, 只是少省两发
    fs.rmSync(packFile(), { force: true })
    fs.writeFileSync(
      packFile(),
      JSON.stringify({ packs: { aaa111: { bno: '12345678', fetchedAt: Date.now(), partial: true, isPw: false, title: 'T', nick: 'N', startTime: '', tiers: [{ up: 'https://livecast.sooplive.com/1.ts?aid=a', bandwidth: 3000000, resolution: '720p' }] } } }),
      'utf-8'
    )
    simulateRestart()
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    assert(soopApi.playCache.has('aaa111') && !soopApi.partialBuy.has('aaa111'), 'S2H4 没有 name 的老形状照旧复活(判不出已付过哪档 ⇒ 不递账, 少省两发而不是丢包)', `有包=${soopApi.playCache.has('aaa111')} 账=${soopApi.partialBuy.has('aaa111')}`)
    // 带密码买回的那一档同样不递账: 这本账只有"无密码满档"那条链会读, 而主播中途关掉口令时读它的就是一个从未出示过密码的 caller
    fs.rmSync(packFile(), { force: true })
    seedStored('aaa111', { partial: true, media: { isPw: true }, variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p', label: 'HD', name: 'hd' }] })
    soopApi.flushPacks()
    simulateRestart()
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    assert(soopApi.playCache.get('aaa111')?.media?.isPw === true && !soopApi.partialBuy.has('aaa111'), 'S2H5 密码包照旧复活(那本来就是这一间自己的地址), 只是不递进复用账(与 1078 的 !password 同规约)', `isPw=${soopApi.playCache.get('aaa111')?.media?.isPw} 账=${soopApi.partialBuy.has('aaa111')}`)
  }

  console.log('S2I 同一格从"真链"那一头走一遍: 省发链写下的档位名 → 落盘 → 复活 → 递账(不靠夹具手写 name)')
  {
    reset()
    fs.rmSync(packFile(), { force: true })
    world.apiChannel = { VIEWPRESET: PRESETS2 }
    world.favBody = bodyOf([LIVE_ROW])
    const lean = await soopApi.getPlayCached('aaa111', '', false, false) // 预取泵那一发: 只解最高档
    assert(lean.ok && lean.variants.length === 1 && lean.variants[0].name === 'hd', 'S2Ia 真链给出的那一条要自带档位名(递账的前缀判据吃的就是它)', JSON.stringify(lean.variants?.[0]))
    soopApi.playCache.delete('aaa111')
    soopApi.partialBuy.clear()
    soopApi.flushPacks()
    assert(readPackFile().packs.aaa111.tiers[0].name === 'hd', 'S2Ib 档位名跟着地址一起落盘(否则重启后"这一档付过"这件事就读不回来)', JSON.stringify(readPackFile().packs.aaa111.tiers[0]))
    simulateRestart()
    await soopApi.fetchFavorites()
    const e = soopApi.partialBuy.get('aaa111')
    assert(!!e && e.bno === '12345678' && e.bought[0]?.name === 'hd', 'S2Ic 复活的那一档由真链留下的名字递进复用账', JSON.stringify(e && { bno: e.bno, names: e.bought.map((b) => b.name) }))
    world.fetches.length = 0
    const menu = await soopApi.getPlayMenu('aaa111')
    assert(menu.variants.length === 2 && apiHits('aid') === 1 && assignHits() === 1, 'S2Id 补齐只买差的那一档: 真链那一发的两发不再重打(整条 ①补 从写到读到, 一发不多)', `档=${menu.variants.length} aid=${apiHits('aid')} assign=${assignHits()}`)
  }

  console.log('S3 号变了 = 新一场: 手里的地址立刻不算数, 当场丢账')
  {
    const LIVE_ROW2 = { ...LIVE_ROW, broad_info: [{ ...LIVE_ROW.broad_info[0], broad_no: '99999999' }] }
    simulateRestart()
    world.fetches.length = 0
    world.logInfo.length = 0
    world.favBody = bodyOf([LIVE_ROW2])
    await soopApi.fetchFavorites()
    assert(!soopApi.playCache.has('aaa111'), 'S3a 不复活(旧那一场买的签名地址给新一场用 = 徽标亮着而流是上一场的)')
    assert(!soopApi.storedPacks.has('aaa111'), 'S3b 丢掉的是这一条本身, 不是"这一轮先不看"(留着每轮都白判一次)')
    assert(world.logInfo.some((m) => /场次号已变\(99999999≠12345678, 新一场\)/.test(m)), 'S3c 作废要说清是号变了(与"过龄""没在播"是三种不同的处置)', world.logInfo.join(' | '))
    world.apiChannel = { VIEWPRESET: PRESETS2, BNO: '99999999' }
    const nb = await soopApi.getPlayFast('aaa111')
    assert(nb.bno === '99999999' && pageHits('aaa111') === 0, 'S3d 随后那一条链用的是列表给的新号(列表号的复用没被这笔留存牵连)', `bno=${nb.bno} 页=${pageHits('aaa111')}`)
    assert(soopApi.storedPacks.get('aaa111')?.bno === '99999999', 'S3e 新一场的包重新入账(丢旧的不等于以后都不留)')
  }

  console.log('S4 列表说这一场没在播: 同样丢账')
  {
    seedStored('aaa111')
    soopApi.flushPacks()
    simulateRestart()
    world.logInfo.length = 0
    world.favBody = bodyOf([OFF_ROW, { ...LIVE_ROW, is_live: false, broad_info: [] }])
    await soopApi.fetchFavorites()
    assert(!soopApi.playCache.has('aaa111') && !soopApi.storedPacks.has('aaa111'), 'S4a 不复活并丢账(下播了还留着一份能播的地址 = 下一轮开播时交旧源)')
    assert(world.logInfo.some((m) => /列表说这一场没在播/.test(m)), 'S4b 判据是列表的读数, 不是"读不出来"(读不出来的那一轮不许判死, 见 S7)', world.logInfo.join(' | '))
  }

  console.log('S5 过留存期限: 挂着太久的地址直接丢, 日志带分钟数')
  {
    const TTL = soopApi.constructor.PACK_TTL
    assert(typeof TTL === 'number' && TTL > 0, 'S5a 先取到实测口径写进的那个上界(取不到就没有"过龄"这一说, 断言会恒真)', String(TTL))
    seedStored('aaa111')
    const aged = Date.now() - TTL - 60_000
    soopApi.storedPacks.get('aaa111').fetchedAt = aged
    soopApi.flushPacks()
    assert(readPackFile().packs.aaa111?.fetchedAt === aged, 'S5b 自证盘上这一条真的挂着越界的那一份(改内存没落到盘, 下面那条断言就是空的)', JSON.stringify(readPackFile().packs.aaa111?.fetchedAt))
    simulateRestart()
    world.logInfo.length = 0
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    assert(!soopApi.playCache.has('aaa111') && !soopApi.storedPacks.has('aaa111'), 'S5c 同号但过龄 ⇒ 丢(实测下界 110 分钟, 上界未测 ⇒ 期限写死在常量里, 不靠猜)')
    assert(/过留存期限/.test(world.logInfo.join(' | ')), 'S5d 作废原因要写"过龄"而不是"没在播"')
  }

  console.log('S6 缓存里已经有这一间: 不覆写更新的, 但也不摘账')
  {
    seedStored('aaa111')
    soopApi.flushPacks()
    simulateRestart()
    const newer = { ok: true, m3u8: UP(), variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p' }], partial: false, fetchedAt: Date.now(), bno: '12345678' }
    soopApi.playCache.set('aaa111', newer) // 演"复活之前另一条链已经把这一间写进缓存、留存那一条还没被 notePack 追平"
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    assert(soopApi.playCache.get('aaa111') === newer, 'S6a 不覆写(复活那一份不比手上这个新, 换掉就是拿旧地址踩死刚买到的新地址)')
    assert(soopApi.storedPacks.has('aaa111'), 'S6b 也不摘账(下一轮的 notePack 会替它写新的一条; 这一格删它等于把留存判死)')
  }

  console.log('S7 列表读不出来那一轮: 留存原样留着(读不出 ≠ 没在播)')
  {
    seedStored('aaa111')
    soopApi.flushPacks()
    simulateRestart()
    world.favBody = '<html>captcha</html>'
    const rows = await soopApi.fetchFavorites()
    assert(rows === null, 'S7a 列表降级照旧回 null(这一笔不改 A3 的那条判据)')
    assert(soopApi.storedPacks.has('aaa111'), 'S7b 失败轮不许判死留存(否则一次网络抖动就把七次开机重买七遍改回去了)')
    world.favBody = bodyOf([LIVE_ROW])
    await soopApi.fetchFavorites()
    assert(soopApi.playCache.has('aaa111'), 'S7c 下一轮列表恢复就复活(账一直在, 等的是一发真值)')
  }

  console.log('S8 亲证死 / 事件作废: 盘上那一条一起摘, 不留哑弹')
  {
    soopApi.seedPlay('aaa111', { ok: true, bno: '12345678', m3u8: UP(), variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p' }], partial: false, media: { isPw: false } })
    soopApi.flushPacks()
    const m3u8 = soopApi.playCache.get('aaa111').m3u8
    assert(soopApi.dropCachedPlay('aaa111', m3u8) === true, 'S8a0 先自证摘得动(亲证地址对得上)')
    assert(!soopApi.storedPacks.has('aaa111'), 'S8a 播放器亲证死 ⇒ 留存同批摘(2 的那一条地址留在盘上就是下次开机的一颗哑弹)')
    soopApi.schedulePersist()
    soopApi.flushPacks()
    assert(!readPackFile().packs.aaa111, 'S8b 摘了要落盘(内存空、盘上满 = 重启照旧复活死源)')
    soopApi.seedPlay('bbb222', { ok: true, bno: '12345678', m3u8: UP(), variants: [{ url: UP(), bandwidth: 3000000, resolution: '720p' }], partial: false, media: { isPw: false } })
    assert(soopApi.storedPacks.has('bbb222'), 'S8c0 bbb222 这一间记上了账(否则下面那条"作废摘账"是空的)')
    soopApi.invalidatePlay('bbb222') // 下播/收尸/手动强刷都走这里
    assert(!soopApi.storedPacks.has('bbb222'), 'S8c 事件作废(invalidatePlay)同样摘账, 与 partialBuy 同判据')
  }

  console.log('S9 换号/登出: 立即抹平, 不等那 2 秒的合并窗口')
  {
    world.apiChannel = { VIEWPRESET: PRESETS2 }
    await soopApi.getPlayCached('ccc333', '', false, true)
    assert(soopApi.storedPacks.has('ccc333'), 'S9a0 先自证新号这一间记上了账')
    soopApi.clearPlayCache()
    assert(soopApi.persistTimer === null, 'S9b 挂起的定时器要撤掉(换号后再写一遍旧账就是把旧号的地址落盘)')
    assert(Object.keys(readPackFile().packs).length === 0, 'S9c 盘上当场清空(上一个账号买到的地址对这一个人不成立; 那 2 秒里进程被杀就留着一份别人能播的串)')
  }

  console.log('S10 不落盘的两格: 没有场次号 / 地址签不出去')
  {
    const up = `http://127.0.0.1:${9100 + world.proxyGen}/x?t=g${world.proxyGen}&url=` + encodeURIComponent('https://livecast.sooplive.com/1-2-3.ts?aid=a')
    soopApi.seedPlay('s10a', { ok: true, m3u8: up, variants: [{ url: up, bandwidth: 3000000, resolution: '720p' }], fetchedAt: Date.now() })
    assert(soopApi.cachedSourceIds().includes('soop:s10a'), 'S10a0 没有 bno 的种子里了缓存(能播, 卡片该亮)')
    assert(!soopApi.storedPacks.has('s10a'), 'S10a 但没有场次号 ⇒ 不留存: 对不上"还是不是那一场"的地址, 留着就是重启后的一颗哑弹')
    soopApi.seedPlay('s10b', { ok: true, bno: '555000', m3u8: 'https://mock/x.m3u8', variants: [{ url: 'https://mock/x.m3u8', bandwidth: 0, resolution: '720p' }], fetchedAt: Date.now() })
    assert(!soopApi.storedPacks.has('s10b'), 'S10b 不是代理签发形状的那一条解不出上游 ⇒ 不留(upstreamOf 那一格: 解不出就是解不出, 不猜)')
    soopApi.seedPlay('s10c', { ok: true, bno: '555001', m3u8: up, variants: [{ url: up, bandwidth: 3000000, resolution: '720p' }], fetchedAt: Date.now() })
    assert(soopApi.storedPacks.get('s10c')?.bno === '555001', 'S10c 有号 + 认得出的地址 ⇒ 留(种子与整链同一条留存码路, 那一发不该是例外)')
    const jsup = `http://127.0.0.1:${9100 + world.proxyGen}/x?t=g${world.proxyGen}&url=` + encodeURIComponent('javascript:alert(1)')
    soopApi.seedPlay('s10d', { ok: true, bno: '555002', m3u8: jsup, variants: [{ url: jsup, bandwidth: 3000000, resolution: '720p' }], fetchedAt: Date.now() })
    assert(!soopApi.storedPacks.has('s10d'), 'S10d 解得出来但不是 http(s) ⇒ 照样不留(isUsableUp 只管这一格: 放开它就是把"存一条签不出去的串"写成合法)', `留=${soopApi.storedPacks.has('s10d')}`)
  }

  console.log('S11 读回: 坏形状逐条丢, 半个文件不许毁掉启动')
  {
    const tier = { up: 'https://livecast.sooplive.com/1.ts?aid=a', bandwidth: 3000000, resolution: '720p' }
    fs.writeFileSync(
      packFile(),
      JSON.stringify({
        packs: {
          good: { bno: '777', fetchedAt: Date.now(), partial: false, isPw: false, title: 't', nick: 'n', startTime: '', tiers: [tier] },
          nobno: { bno: '', fetchedAt: Date.now(), tiers: [tier] },
          notiers: { bno: '777', fetchedAt: Date.now(), tiers: [] },
          badup: { bno: '777', fetchedAt: Date.now(), tiers: [{ ...tier, up: 'javascript:alert(1)' }] },
          broken: null
        }
      }),
      'utf-8'
    )
    soopApi.storedPacks.clear()
    world.logInfo.length = 0
    soopApi.restorePlayCache()
    assert(soopApi.storedPacks.size === 1 && soopApi.storedPacks.has('good'), 'S11a 只认得出形状对的那一条(缺号/空档/非法协议/整条为 null 各丢)', `留=${[...soopApi.storedPacks.keys()]}`)
    assert(world.logInfo.some((m) => /源留存读回 1 间/.test(m)), 'S11b 读回要说数量, 且明写"同号才复活, 对不上直接丢"', world.logInfo.join(' | '))
    fs.rmSync(packFile(), { force: true })
    soopApi.storedPacks.clear()
    soopApi.restorePlayCache()
    assert(soopApi.storedPacks.size === 0, 'S11c 没有这个文件(全新安装)与读不出是同一件事: 不抛、不种任何源')
  }

  console.log('S12 留存上限: 超了逐条挤最旧的, 不许无界长(这文件是要跟着用户走的)')
  {
    const MAX = soopApi.constructor.MAX_STORED
    assert(typeof MAX === 'number' && MAX > 0, 'S12a 先取到常量', String(MAX))
    soopApi.storedPacks.clear()
    const up = `http://127.0.0.1:${9100 + world.proxyGen}/x?t=g${world.proxyGen}&url=` + encodeURIComponent('https://livecast.sooplive.com/1.ts?aid=a')
    for (let i = 0; i < MAX + 5; i++) {
      soopApi.storedPacks.set(`m${i}`, { bno: 'b' + i, fetchedAt: 1000 + i, partial: false, isPw: false, title: '', nick: '', startTime: '', tiers: [{ up, bandwidth: 1, resolution: '720p' }] })
      soopApi.notePack(`m${i}`, { ok: true, bno: 'b' + i, m3u8: up, variants: [{ url: up, bandwidth: 1, resolution: '720p' }], fetchedAt: 1000 + i })
    }
    assert(soopApi.storedPacks.size === MAX, `S12b 挤到上限就停(${MAX} 间)`, `size=${soopApi.storedPacks.size}`)
    assert(!soopApi.storedPacks.has('m0') && soopApi.storedPacks.has(`m${MAX + 4}`), 'S12c 挤掉的是最旧的那一份(新源留着才有用)', [...soopApi.storedPacks.keys()].slice(0, 3).join(','))
    soopApi.storedPacks.clear()
  }
}

// ---------- 落盘守卫收尾: 整套跑完, 工作区里那些"真 app 会写"的地方必须一字未动 ----------
{
  const after = guardSnap()
  const touched = []
  for (const k of new Set([...Object.keys(GUARD_BEFORE), ...Object.keys(after)])) {
    if (GUARD_BEFORE[k] === after[k]) continue
    touched.push(`${k}${GUARD_BEFORE[k] === undefined ? '(新落盘)' : after[k] === undefined ? '(被删)' : '(内容变了)'}`)
  }
  assert(
    touched.length === 0,
    `C2-1 本套(${Object.keys(GUARD_BEFORE).length} 项快照: data/ + recording/ + 根目录散落件)跑完零落盘`,
    touched.slice(0, 8).join(' ')
  )
  console.log(`  [读数] C2 守卫: 快照 ${Object.keys(GUARD_BEFORE).length} 项 → ${Object.keys(after).length} 项, 差异 ${touched.length} 项${touched.length ? ' — ' + touched.join(' ') : ''}`)
  fs.rmSync(SANDBOX, { recursive: true, force: true }) // 本套自己的临时根: 用完就收, 不在系统临时目录里留骸骨
}

// ---------- 汇总 ----------
console.log(`\n通过 ${PASS} / 失败 ${FAIL}`)
if (FAIL) {
  console.log('失败项:\n - ' + fails.join('\n - '))
  process.exit(1)
}
