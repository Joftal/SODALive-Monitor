// ============================================================================
// 验证脚本: 设计契约静态校验(docs/design/sodalive-ia-v1.html 的字面化)
//
// 为什么存在: 设计稿里的硬规则(令牌板、徽标档位、禁原生调色板、红不承载文字、
//   命名表、动效预算、双语键位)靠人肉逐屏看必然漏, 且改一处忘另一处不会报错。
//   这里把可静态判定的规则做成断言, 进 npm run verify 链, CI 上一起跑。
//
// 原则: 白名单是「有理由的例外」而非「暂时没修」。白名单条目一旦不再命中任何行,
//       视为该例外已失效, 直接 FAIL —— 防止白名单越攒越脏变成第二个债务账。
//
// 规则:
//   D1  徽标档位: 任何 badge 必须同带 badge-sm|badge-md(设计稿 3.3 R2, 同一视野只允许一档)
//   D2  档位锁死: badge-lg / pt--lg / size="lg" 不得出现(PlatTag 只有两档)
//   D3  禁原生调色板: 渲染层不得出现 Tailwind 原生色(gray-500/red-400/sky-500 …)
//   D4  禁硬编码色值: class/style 里的 #hex 只允许白名单(GitHub 第三方品牌面 / 品牌横幅)
//   D5  纯色状态底仅限圆点·进度条·仅图标按钮: bg-live|ok|warn 无 alpha 时必须命中白名单
//   D6  状态色不承载文字: text-live|ok|warn(非 ink)仅限图标, 必须命中白名单
//   D7  命名表: 「潘达」不得出现在任何用户可见源(注释除外); 产品名恒为 SODALive
//   D8  令牌层完好: styles.css 保留 focus-visible 焦点环 / not-allowed / err-dark, tailwind 映射齐全
//   D9  双语对齐: 渲染层 zh↔en 键集合相等且占位符一致; 主进程 zh↔en 同理
//   D10 取词存在: 模板里所有字面 t('a.b') 与主进程 mt('a.b') 必须能在字典里取到
//   D11 动效预算: 无入场动画类(animate-pop), transition 时长不得超过 300ms
//   D12 可点必有为: 设置页 switch 瓷片(tileCls)必须挂 @click(tileCls 自带 cursor-pointer+hover)
//   D13 平台维度: PlatFilter counts 三档齐; 库恒为录制页内的一段(顶栏两条 tab, 旧深链仍重定向)
//   D14 白屏与最小窗宽: structuredClone 先 toRaw; 顶栏不换行不塌搜索框; 库 0 条不摆筛选
//   D15 首屏与空态: 不等官方登录校验; 未取到态说「校验中」; 空态有界且下一步可点; 页头按钮同档; 工作区不引头像坞
//   D16 承载矩阵: 关注/取关四个现场各按其形态承载; 进度条全应用一条且只给有真分母的对象; 管线文案与码率差分按任务类型/字节实长走
//   D17 仓库卫生: tailwind 不留死令牌; 历史设计稿必带覆盖横幅; docs/ 不放二进制; README 双平台口径与 verify 链在案
//   D18 圆角档位: 模板只用 rounded-card|ctl|md|full, 禁任意值; CSS 里的 border-radius 只允许 5/6/10/14/999/50%
//   D19 平台色点: 全应用一处 .pdot 规格(7px + ink3 描边), 组件不得再自画第二档
//   D20 计数药丸: 顶栏两枚同用 .platn, 视图分段用 .sec-n, 不得手搓 min-w+rounded-full
//   D21 等宽数字: 只有 tabular-nums 一种拼法(旧 .tnum 同义类已删), 覆盖面 ≥20 处
//   D22 naive 主题对齐: App.vue 的 LIGHT/DARK_OVERRIDES 每枚色值都能在 styles.css 语义变量里找到同名档
//   D23 品牌散文: 用户可见文案里不得出现小写 pandalive(那是枚举/目录名), 品牌形恒为 PandaLive
//   D24 动作行按钮: 自绘按钮必须用 h-* 锁档位, 不得用 py-[Npx] 撑高(与同行 naive 按钮实测差 6px 就是这么来的)
//   D25 设置保存链: 提交载荷先脱代理; 脏判定的基线是进页快照; 拒绝出声; 闸门/代理/窗口底色三处生效动作在案
//   D26 关于页身份: 作者/仓库/日志目录一律由 appInfo 下发, 渲染层不得写死(唯一定义处是 shared/appmeta.ts)
//   D27 段标题一档: 段标题只用 .sec-h, 卡内分组只用 .grp-h; 模板不得手搓 13px bold tracking-wide
//   D28 按钮宽度只锁下限: 按钮禁 !w-[Npx](定宽裁翻译), 下限 !min-w-[Npx]; 例外仅限表单列宽与弹窗宽
//   D29 筛选条不能被自己筛掉: 出现条件看基数(三视图同口径「词已生效 · chip 未生效」), 筛空的墙必带「取消筛选」
//   D30 空态文案与出口同一判据: 墙上的归因由 emptyAction 单点决定, 点到搜索词就必须给出「清除搜索」
//   D31 播放页返回从哪来回哪去: 读历史栈落回 ?view= / 录制页, 栈空或跨平台才兜底本平台直播页, 文案与目的地同源
//   D32 播放页侧栏与动作行: 侧栏自带滚动且卡片 shrink-0(不被压扁裁掉尾行); 动作行按轻重分档(幽灵/描边/实心)且只锁宽度下限; 观众数一屏只报一次
//   D33 播放页读数一处收敛: room 快照 = 关注列表 > 站内发现, 展示值 = 回包 > 快照 > 裸 ID(未关注房不得整屏「—」)
//   D34 工作区视图分段行不常驻快捷键提示: 1/2/3 与 / 的键盘本体保留, 屏上那条 11px 灰字撤掉且双语不留死键
//   D35 工作区筛选条右端只在真有搜索词时出声: 「排序与页码在本视图内记忆」常驻说明撤掉(记忆本体不动), 无词时不留空转 flex-1
//   D36 「关注主播」按平台拆成两个专属入口: 无「自动识别」档, 平台由工作区决定, 粘错平台给出口, SOOP 纯数字场次号单独归因
//   D37 分段时长填 0 = 不分段: 整场一个不带段号的 TS, 合并档/管线第四棒随之收起, 库里与手动合并产物同归「整文件」一类
//   D38 「关注在播」一屏只留一个现场: 头像坞退役, 读数只剩分段第一档 + 顶栏徽标, 组件/样式/文案/store getter 不留残骸
//   D39 SOOP 头像按频道 ID 派生并落卡(404 回落兜底, 不画破图); 面板点赞/粉丝只在有数时摆行, 「不适用」那句连死键一起删
//   D40 SOOP 的 ID 槽只放裸频道名: 「房间」前缀连 ws.roomNo 双语死键一起撤(Panda 的 @ 是可粘贴地址的一部分, 留着); 播放页那一格同判据
//   D41 播放页侧栏「标签」整行撤掉: 同一批房态在页头已有徽标, 普通房只剩「—」占位; 撤行不撤信号(四枚徽标 + isVod 必须在位)
//   D42 取源回写按字段合并: 这一路看不到的 isAdult 不许写 false(19+ 旗不被抹掉), 看得到的 isPw 照写; Panda 不回收
//   D43 播放源卡的两个出口各复制各的: 「复制」给屏上那串(本机正在用的), 「复制真实源」从代理地址的 url= 解出官方清单(零请求), 只在真是代理地址时出现; 提示语只归因不警告
//   D44 SOOP 不带房间级 19+ 标记: is_adult 全链路不读、applySoopRow 不继承它、已离线房的旧 true 在读库时收敛; 密码房旗仍是三态 + ?? 合并; 下播只清场次属性; Panda 的 19+ 三处消费端都还在
//   D45 监控节奏三格按平台分家: 契约只有 Settings.monitor 一份, 老库那三格展开成两格后顶层删净, 闸门逐平台逐格夹, 引擎两条独立定时器(Panda 熔断只压自己那条), 三格住在各自平台节且全局「监控」节连死键一起撤
//   D46 首轮未落地时顶栏胶囊只报间隔: roundMs 的初值 0 不得当成「上次拉取耗时」报出, 耗时那一截连同 tooltip 一起省略
//   D47 模板结构当场编译: 每个 .vue 的 <template> 单独过 vue/compiler-sfc, 断链的 v-else-if 不许等 build 才炸
//   D48 store 的 getter 普查: 零消费者的死 getter 一律撤(「无消费方即删」), 不留"以后可能用"
//   D49 时长单位: 轮次耗时恒按秒且只在一处格式化(胶囊与设置页不许各读各的), 中文格子不混拉丁 s; 节流/分段/熔断/长时长各自的单位是语境, 不许被顺手统一
//   D50 在播关注与站内发现的头两档排序同序(人气最高在前), 且默认档就跟着第一格(两视图默认都是人气最高)
//   D51 Panda 轮询换真值源: 一发站内关注列表判全部关注, 读不到必须回落而不是判全员下播, 下播仍要两轮, 匿名不发注定失败的那一发
//   D52 全站榜改按需: 大厅有独立入口 + 60 秒复用 + 熔断退避期拒发 + 失败保留旧快照 + 并发合流, 桥/预加载/IPC 三处接线齐全
//   D53 大厅与 watchMode 解耦: 逐个模式不再清空快照, 「模式不可用」那句连出口与死键一起撤, 发现页那一格读大厅自己的钟
//   D54 SOOP 降级探针有每轮预算: 环形游标轮换不饿死任何房, 未读数与新失明判据同口径改口
//   D55 SOOP 有自己的退避: 失明轮零请求零心跳、每个失明轮重新武装, 但绝不推 Panda 熔断位也不新增第二句读数
//   D56 SOOP 取流不再为拿场次号读整页: 列表播种的 broad_no 直接进第 2 步, 号过期/失效各有上界定性, 页面微缓存不拦探针
//   D57 作废纪元门: 显式作废/换号之后, 先于它发出的取流链不许把源写回缓存; 在飞两格(带密/不带密)一起摘; seedPlay 只认真源
//   D58 续录一次判活 + 退避: 意外退出只现拉一发(同一发既判活又当种子), 重录按房挂计时器且指数退避, 手动接管即撤销时续录
//   D59 分页单飞·探针节流·刷新下限: 全站榜翻页只有一处实现且并发合流, 判死期不再每轮复读 login_info, 立即刷新有每平台 8 秒下限, 预取补扫挪到首轮之后
//   D60 三条老覆盖: 本机代理地址不给 ffmpeg 挂 -http_proxy, 旧全局键的删除清单逐键锁死, 无消费方即删
//   D61 保活泵改口: 周期 60 秒 + 间隔随规模自适应, 源缓存两道活性时限, 真死只认主档(心跳只读主档)
//   D62 档位扇出只有一个闸口: SOOP 后台预取只解最高档, partial 只在真缺档时成立, Panda 不装这个旋钮
//   D63 在途键表达档级: 满档 caller 绝不接一份只解最高档的包, 在飞链按 key 装摘、按纪元门落缓存
//   D64 SOOP 风控记账: 判据只在接口上算数且排除 515, 只写表不抛、窗口内只出声一次, 冷却只归后台泵消费
//   D65 代理在途合流 + 门槛回执记账: 同一上游 target 并发只打一发且不缓存, 五个"不会自己好"的码记 15 分钟
//   D66 脚本自审: 验证脚本里不许出现恒真正则(裸 || / 匹配空串), 扫描本身要跑到
//   D67 按站后台车道: 一站一条道、间隔取本平台那一格、只在下端各接一处, 媒体/CDN 豁免, 排队有上限, 用户级不排队但照样落笔
//   D68 force 下限与关注列表合流: 手动刷新豁免 60 秒复用却不豁免 8 秒下限(与 tick 同一枚常量), 关注列表那一发有在飞合并且按身份撒
//   D69 预取让路 · 年龄收手: 泵与轮次/停轮让路但不清队, 两条队列随 stop 一起清; SOOP 抄同两档且收手零网络, 闸门只关心跳不关记账
//   D70 三处观测面: 兜底重发与代理合流各 60 秒出声一句(次数一起报), 页面读那一发按来源标签分得清谁在读
//   D71 保活扇出收口: 每源一轮一发主档, 心跳里没有档循环, 投影读数改口报"档在手"
//   D72 间隙泵续扫游标: 快照整批替换必须从上一窗口没扫到的那一间起排, 消费每间只计一次
//   D73 预取出队时重判真值: 排空要几分钟, 散场/取关的房不再为其拉整条链, 且跳过不清队
//   D74 Panda 也有自己的风控账: 五种风控形状全记账, 只让后台两条泵收手, 用户那一条与换号不受牵连
//   D75 播放器网络重试有上限: 致命错误的重连必须有终点, 满次数上抛换源而不是无限重连死源
//   D76 SOOP 降级态只留痕不减发(P1-1 改判): 失明轮数只喂日志, 不留退避死字段, 全灭轮不重复出声
// ============================================================================
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '..')
const R = (...p) => path.join(ROOT, ...p)

let PASS = 0
let FAIL = 0
const fails = []
function assert(cond, name, detail) {
  if (cond) {
    PASS++
    console.log(`  [PASS] ${name}`)
  } else {
    FAIL++
    fails.push(name)
    console.log(`  [FAIL] ${name}${detail ? `\n         ${detail}` : ''}`)
  }
}

// ---------- 文件收集 ----------
function walk(dir, re) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, re))
    else if (re.test(e.name)) out.push(p)
  }
  return out
}
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/')
const RENDERER = walk(R('src', 'renderer', 'src'), /\.(vue|ts|css)$/)
const SRC_ALL = walk(R('src'), /\.(vue|ts)$/)
const linesOf = (abs) => fs.readFileSync(abs, 'utf8').split(/\r?\n/)
/** 方法体收尾: 缩进两格的 `}` 才是类方法的那一刀。
 *  必须按 \r?\n 找 —— 工作树是 CRLF(core.autocrlf), 找字面 '\n  }\n' 会一路 slice 到文件末尾,
 * 于是"这个方法体内不得出现 X"的负向断言全部形同虚设(实测: 两条老契约因此凭空改判) */
const bodyEnd = (src, from) => {
  const m = /\r?\n {2}\}/.exec(src.slice(from))
  return m ? from + m.index : -1
}
/** 逐行回调: (文件, 行号1基, 行内容) */
function eachLine(files, fn) {
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    text.split(/\r?\n/).forEach((l, i) => fn(f, i + 1, l, text))
  }
}
/** 该行是否是纯注释行(含块注释续行 ` * `) —— 注释里允许出现禁用词, 说明规则本身就要提它 */
function isCommentLine(l) {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')
}

const loc = (f, n) => `${rel(f)}:${n}`

// ---------- 白名单机制: 每条必须命中, 否则 FAIL ----------
function checkWithAllowlist(title, files, detector, allowlist) {
  const hits = []
  eachLine(files, (f, n, l) => {
    const bad = detector(l, f)
    if (bad) hits.push({ f, n, line: l.trim(), why: bad })
  })
  const consumed = new Set()
  const unjustified = []
  for (const h of hits) {
    const entry = allowlist.find((a) => rel(h.f) === a.file && a.re.test(h.line))
    if (!entry) unjustified.push(h)
    else consumed.add(a_key(entry))
  }
  const unused = allowlist.filter((a) => !consumed.has(a_key(a)))
  assert(
    unjustified.length === 0,
    title,
    unjustified.slice(0, 12).map((h) => `${loc(h.f, h.n)} [${h.why}] ${h.line.slice(0, 110)}`).join('\n         ')
  )
  assert(
    unused.length === 0,
    `${title} —— 白名单条目全部仍在用(失效例外必须删)`,
    unused.map((a) => `${a.file} :: ${String(a.re)} (${a.why})`).join('\n         ')
  )
}
const a_key = (a) => `${a.file}|${String(a.re)}`

// ============================================================================
// D1 / D2 徽标档位
// ============================================================================
{
  const bad = []
  eachLine(RENDERER.filter((f) => f.endsWith('.vue')), (f, n, l) => {
    // 只认 class 令牌里的 badge: 对象字段 `badge:` 与 `x.badge` 不是徽标类
    const isClassToken = /\bbadge\b(?!-)[^:]/.test(l) && !/\bbadge\s*:/.test(l) && !/[.\w$]badge\b/.test(l)
    if (isClassToken && !/badge-(sm|md)\b/.test(l)) bad.push(`${loc(f, n)} ${l.trim().slice(0, 110)}`)
  })
  assert(bad.length === 0, 'D1 每个 badge 都带档位 badge-sm|badge-md(3.3 R2)', bad.slice(0, 10).join('\n         '))

  const lg = []
  for (const f of RENDERER) {
    const t = fs.readFileSync(f, 'utf8')
    for (const re of [/badge-lg/g, /pt--lg/g, /size="lg"/g, /\|\s*'lg'/g]) {
      t.split(/\r?\n/).forEach((l, i) => {
        if (re.test(l)) lg.push(`${loc(f, i + 1)} ${l.trim().slice(0, 110)}`)
      })
    }
  }
  assert(lg.length === 0, 'D2 徽标只有两档: 无 badge-lg / pt--lg / size="lg"', lg.slice(0, 10).join('\n         '))
}

// ============================================================================
// D3 禁原生 Tailwind 调色板
// ============================================================================
{
  const PAL =
    /\b(?:bg|text|border|ring|from|to|via|divide|fill|stroke|shadow|outline|placeholder|accent|caret)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
  const bad = []
  eachLine(RENDERER, (f, n, l) => {
    const m = l.match(PAL)
    if (m) bad.push(`${loc(f, n)} ${m[0]} :: ${l.trim().slice(0, 100)}`)
  })
  assert(bad.length === 0, 'D3 渲染层零原生 Tailwind 色(一切颜色走令牌板)', bad.slice(0, 12).join('\n         '))
}

// ============================================================================
// D4 硬编码色值白名单
// ============================================================================
checkWithAllowlist(
  'D4 class/style 里的 #hex 仅限白名单例外',
  RENDERER.filter((f) => f.endsWith('.vue')),
  (l) => {
    const inClass = /class="[^"]*#[0-9a-fA-F]{3,8}/.test(l)
    const inStyle = /style="[^"]*#[0-9a-fA-F]{3,8}/.test(l)
    return inClass ? 'class 内硬编码色' : inStyle ? 'style 内硬编码色' : null
  },
  [
    {
      file: 'src/renderer/src/views/SettingsView.vue',
      re: /style="background: linear-gradient\(115deg, #243a5e/,
      why: '品牌横幅渐变: Tailwind 任意值类无法表达三段渐变, 且该面恒为深底白字'
    }
  ]
)

// ============================================================================
// D5 纯色状态底仅限圆点 / 进度条 / 仅图标按钮
// ============================================================================
checkWithAllowlist(
  'D5 纯色 bg-live|bg-ok|bg-warn 仅限色点·进度条·仅图标控件',
  RENDERER.filter((f) => f.endsWith('.vue')),
  (l) => {
    const m = l.match(/\b(?:bg)-(?:live|ok|warn)\b(?![-\w/])/)
    return m ? '纯色状态底(3.91:1 / 2.89:1, 不得承载文字)' : null
  },
  [
    { file: 'src/renderer/src/components/LiveCard.vue', re: /rounded-full bg-live animate-breathe/, why: '在播/录制色点' },
    { file: 'src/renderer/src/components/LiveCard.vue', re: /'bg-live text-white'/, why: '停止录制按钮(仅图标, 白字压 live 是刻意与在播态同色)' },
    { file: 'src/renderer/src/components/TopNav.vue', re: /watcherState\.tone === 'bad' \? 'bg-live'/, why: '监控心跳状态点(文字在点外, 用 ink)' },
    { file: 'src/renderer/src/components/TopNav.vue', re: /account\.live \? 'bg-okink' : 'bg-warn'/, why: '账号登录态点' },
    { file: 'src/renderer/src/views/AccountView.vue', re: /dot: 'bg-(ok|warn)( animate-breathe)?'/, why: '登录态色点字段' },
    { file: 'src/renderer/src/views/PlayerView.vue', re: /rounded-full bg-live animate-breathe/, why: 'REC 色点' },
    { file: 'src/renderer/src/components/LibrarySection.vue', re: /rounded-full bg-live grid place-items-center text-white/, why: '海报卡 hover 播放钮(仅 ▶ 字形, 与 LiveCard 停止录制钮同一档)' },
    { file: 'src/renderer/src/views/RecordingsView.vue', re: /rounded-full bg-live"/, why: '在录统计色点' },
    { file: 'src/renderer/src/views/RecordingsView.vue', re: /'bg-brand' : 'bg-live'/, why: '录制进度条填充(live 允许用于进度条, 设计稿 3.3 R3)' },
    { file: 'src/renderer/src/views/RecordingsView.vue', re: /'bg-warn' : 'bg-live'/, why: '监控总览的轮询色点(状态文字在点外, 用 ink)' },
    { file: 'src/renderer/src/views/WorkspaceView.vue', re: /'bg-live animate-breathe' : 'bg-dec/, why: '在播视图计数色点' }
  ]
)

// ============================================================================
// D6 状态色不承载文字
// ============================================================================
checkWithAllowlist(
  'D6 text-live|ok|warn(非 ink) 仅限图标',
  RENDERER.filter((f) => f.endsWith('.vue')),
  (l) => {
    const m = l.match(/\btext-(?:live|ok|warn)\b(?![-\w/])/)
    return m ? '状态色文字(承载文字必须用 ink 阶, 6.52:1)' : null
  },
  [
    { file: 'src/renderer/src/components/LiveCard.vue', re: /h-3\.5 text-live shrink-0/, why: '关注心形图标' },
    { file: 'src/renderer/src/components/ExploreCard.vue', re: /'text-live' : 'text-ink2'/, why: '关注心形图标' }
  ]
)

// ============================================================================
// D7 命名表
// ============================================================================
{
  const bad = []
  for (const f of SRC_ALL) {
    fs.readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((l, i) => {
        if (l.includes('潘达') && !isCommentLine(l) && !/一律不出现|避免各处|曾经/.test(l))
          bad.push(`${loc(f, i + 1)} ${l.trim().slice(0, 100)}`)
      })
  }
  assert(bad.length === 0, 'D7a 「潘达」不出现在用户可见源(命名表 5.2)', bad.slice(0, 8).join('\n         '))

  const pkg = JSON.parse(fs.readFileSync(R('package.json'), 'utf8'))
  const yml = fs.readFileSync(R('electron-builder.yml'), 'utf8')
  const html = fs.readFileSync(R('src', 'renderer', 'index.html'), 'utf8')
  assert(/productName: SODALive Monitor/.test(yml), 'D7b electron-builder productName = SODALive Monitor')
  assert(/<title>SODALive Monitor<\/title>/.test(html), 'D7c 窗口标题 = SODALive Monitor')
  assert(pkg.description.includes('SODALive'), 'D7d package.json description 用 SODALive')
  const topnav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  assert(/>SODALive<\/div>/.test(topnav), 'D7e 顶栏品牌字标 = SODALive')
  // 平台技术标识不许被顺手改名(枚举/服务/分区/目录)
  assert(/'pandalive'/.test(fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')), 'D7f 平台枚举 pandalive 未被改名(技术标识不动)')
  assert(fs.existsSync(R('src', 'main', 'services', 'pandalive.ts')), 'D7g src/main/services/pandalive.ts 仍在(技术标识不动)')
}

// ============================================================================
// D8 令牌层完好
// ============================================================================
{
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const tw = fs.readFileSync(R('tailwind.config.js'), 'utf8')
  assert(/:focus-visible/.test(css) && /outline/.test(css), 'D8a 全局键盘焦点环存在(9. 可达性)')
  assert(/cursor: not-allowed/.test(css), 'D8b 统一禁用态光标存在')
  assert(/--c-err-dark:/.test(css), 'D8c 暗场专用亮红 --c-err-dark 已定义(黑底错误文字)')
  assert(/--c-live-ink:|--c-ok-ink:|--c-warn-ink:/.test(css), 'D8d ink 阶(承载文字的状态色)已定义')
  for (const k of ['liveink', 'okink', 'warnink', 'onimg', 'errdark', 'brand']) {
    assert(new RegExp(`\\b${k}:`).test(tw) || new RegExp(`\\b${k}: \\{`).test(tw) || new RegExp(`\\b${k}:`).test(tw), `D8e tailwind 映射 ${k}`)
  }
  assert(/\.badge-sm\b/.test(css) && /\.badge-md\b/.test(css) && !/\.badge-lg\b/.test(css), 'D8f 徽标两档样式定义齐全且无第三档')
}

// ============================================================================
// D9 / D10 双语对齐 + 取词存在
// ============================================================================
/** locale 文件是纯字面量模块, 直接求值即可(不引 sucrase, 因为里面没有 TS 语法) */
function evalDefault(file) {
  const src = fs.readFileSync(file, 'utf8')
  if (/^\s*import\s/m.test(src)) throw new Error(`${rel(file)} 含 import, 无法作为纯字面量求值`)
  return new Function(src.replace(/export default/, 'return'))()
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

{
  const zh = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts')))
  const en = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts')))
  const onlyZh = Object.keys(zh).filter((k) => !(k in en))
  const onlyEn = Object.keys(en).filter((k) => !(k in zh))
  assert(onlyZh.length === 0, 'D9a 渲染层: 中文有键英文必有', onlyZh.slice(0, 10).join(', '))
  assert(onlyEn.length === 0, 'D9b 渲染层: 英文有键中文必有', onlyEn.slice(0, 10).join(', '))
  const phDiff = Object.keys(zh).filter((k) => k in en && ph(zh[k]) !== ph(en[k]))
  assert(phDiff.length === 0, 'D9c 渲染层: 同键占位符一致', phDiff.slice(0, 10).map((k) => `${k}: {${ph(zh[k])}} vs {${ph(en[k])}}`).join('\n         '))

  // 主进程字典: const zh: Dict = { 'a.b': '...' } 平铺
  const mainSrc = fs.readFileSync(R('src', 'main', 'i18n.ts'), 'utf8')
  const dictOf = (name) => {
    const m = new RegExp(`const ${name}: Dict = \\{([\\s\\S]*?)\\n\\}`, 'm').exec(mainSrc)
    if (!m) throw new Error(`主进程字典 ${name} 未找到`)
    // 值可能是单引号也可能是双引号(文案内含撇号时作者会换引号), 两种都收
    const out = {}
    for (const x of m[1].matchAll(/^\s*'([^']+)':\s*(['"])((?:\\.|(?!\2)[^])+)\2/gm)) out[x[1]] = x[3]
    return out
  }
  const mzh = dictOf('zh')
  const men = dictOf('en')
  const mOnlyZh = Object.keys(mzh).filter((k) => !(k in men))
  const mOnlyEn = Object.keys(men).filter((k) => !(k in mzh))
  assert(mOnlyZh.length === 0, 'D9d 主进程: 中文有键英文必有', mOnlyZh.slice(0, 10).join(', '))
  assert(mOnlyEn.length === 0, 'D9e 主进程: 英文有键中文必有', mOnlyEn.slice(0, 10).join(', '))
  // 解析器静默漏读会让上面两条「假绿」: 键数下限兜住
  assert(Object.keys(mzh).length > 120 && Object.keys(men).length > 120, 'D9f 主进程字典解析键数合理(两字典各 >120 键)', `zh=${Object.keys(mzh).length} en=${Object.keys(men).length}`)
  const mPhDiff = Object.keys(mzh).filter((k) => k in men && ph(mzh[k]) !== ph(men[k]))
  assert(mPhDiff.length === 0, 'D9g 主进程: 同键占位符一致', mPhDiff.slice(0, 10).map((k) => `${k}: {${ph(mzh[k])}} vs {${ph(men[k])}}`).join('\n         '))

  // D10 字面取词键必须存在(动态拼接 key 不在此列)
  const keyRe = /(?<![A-Za-z0-9_$])t\(\s*'([A-Za-z][\w]*(?:\.[\w]+)+)'/g
  const missR = []
  for (const f of RENDERER) {
    const t = fs.readFileSync(f, 'utf8')
    for (const m of t.matchAll(keyRe)) if (!(m[1] in zh)) missR.push(`${rel(f)} :: t('${m[1]}')`)
  }
  assert(missR.length === 0, 'D10a 渲染层所有字面 t() 键在中文字典存在', [...new Set(missR)].slice(0, 12).join('\n         '))

  const mtRe = /(?<![A-Za-z0-9_$])mt\(\s*'([A-Za-z][\w]*(?:\.[\w]+)+)'/g
  const missM = []
  for (const f of walk(R('src', 'main'), /\.ts$/)) {
    const t = fs.readFileSync(f, 'utf8')
    for (const m of t.matchAll(mtRe)) if (!(m[1] in mzh)) missM.push(`${rel(f)} :: mt('${m[1]}')`)
  }
  assert(missM.length === 0, 'D10b 主进程所有字面 mt() 键在字典存在', [...new Set(missM)].slice(0, 12).join('\n         '))

  // 删除键的连带检查: 字典里没被任何地方字面引用、也没被动态前缀引用的 key 允许存在(动态取词很多),
  // 但反过来 —— 模板里引用了却被删掉的键 —— 已由 D10a 拦住, 这里补一条: 孤儿中文键只做提示不断言
  const unusedZh = Object.keys(zh).filter((k) => {
    const leaf = k.split('.').pop()
    return !SRC_ALL.some((f) => fs.readFileSync(f, 'utf8').includes(`'${k}'`) || new RegExp(`\\.${leaf}\\b`).test(''))
  })
  if (unusedZh.length) console.log(`  [INFO] 渲染层中文键未见字面引用(${unusedZh.length} 个, 动态拼接取词属正常): ${unusedZh.slice(0, 8).join(', ')}`)
}

// ============================================================================
// D11 动效预算(3.4: 只允许颜色/阴影 150ms 与按下 scale; 无入场动画)
// ============================================================================
{
  const bad = []
  eachLine(RENDERER, (f, n, l) => {
    if (/\banimate-pop\b/.test(l)) bad.push(`${loc(f, n)} 入场动画 animate-pop`)
    const m = l.match(/\bduration-\[?(\d+)\]?/)
    if (m && Number(m[1]) > 300) bad.push(`${loc(f, n)} duration-${m[1]} 超过 300ms 预算`)
  })
  assert(bad.length === 0, 'D11 动效预算: 无入场动画、无 >300ms 过渡', bad.slice(0, 10).join('\n         '))
  const tw = fs.readFileSync(R('tailwind.config.js'), 'utf8')
  assert(!/pop:/.test(tw), 'D11b tailwind 里 pop 关键帧已随规则清除(不留死令牌)')
}

// ============================================================================
// D12 可点必有为: 设置页 switch 瓷片
// ============================================================================
{
  const f = R('src', 'renderer', 'src', 'views', 'SettingsView.vue')
  const bad = []
  linesOf(f).forEach((l, i) => {
    if (/:class="tileCls"/.test(l) && !/@click=/.test(l)) bad.push(`${loc(f, i + 1)} ${l.trim().slice(0, 120)}`)
  })
  assert(bad.length === 0, 'D12 设置页每块可点瓷片都挂了点击行为(tileCls 含 cursor-pointer+hover)', bad.slice(0, 10).join('\n         '))
  const src = fs.readFileSync(f, 'utf8')
  assert(/function tileClick\(/.test(src), 'D12b 瓷片点击开关的处理函数存在')
  assert(/function monTileClick\(/.test(src), 'D12b2 按平台分家的预取瓷片有自己的开关(它写的不是顶层布尔)')
  const nTiles = (src.match(/:class="tileCls"/g) || []).length
  // 瓷片开关两种: 全局布尔走 tileClick, monitor.<平台>.prefetchStream 走 monTileClick
  const nClicks = (src.match(/@click="(tileClick|monTileClick)\(/g) || []).length
  assert(nTiles === nClicks && nTiles > 0, 'D12c 瓷片数 == 绑定数', `${nTiles} 瓷片 / ${nClicks} 绑定`)
}

// ============================================================================
// D13 平台维度: PlatFilter counts 三档齐 + 库的归属(录制页内一段, 无独立页)
// ============================================================================
{
  const users = RENDERER.filter((f) => f.endsWith('.vue') && /<PlatFilter[^>]*:counts=/.test(fs.readFileSync(f, 'utf8')))
  assert(users.length >= 1, 'D13a 库分段给 PlatFilter 传 counts(4.2② 平台分解)', users.map(rel).join(', '))
  const missing = users.filter((f) => {
    const t = fs.readFileSync(f, 'utf8')
    return !/all:/.test(t) || !/pandalive:/.test(t) || !/soop:/.test(t)
  })
  assert(missing.length === 0, 'D13b counts 对象三档(all/pandalive/soop)齐', missing.map(rel).join(', '))

  // 库不是第三页: 顶栏是「直播 · 录制 · 诊断」三条, 录制页里没有平台 tab(它没有「在播/发现/离线」那种视图)
  const rec = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const rt = fs.readFileSync(R('src', 'renderer', 'src', 'router.ts'), 'utf8')
  assert(/<LibrarySection/.test(rec), "D13c 录制页内嵌「库」分段(历史任务不另立概念)")
  assert(!/<PlatFilter/.test(rec), "D13d 录制页本身没有平台 tab(它不是工作区页)")
  assert(!/name:\s*'library'/.test(rt), "D13e 路由里没有独立的 library 页(旧 /:plat/library 只能是重定向)")
  assert(/\/library['`][^\n]*redirect/.test(rt), 'D13f 旧库深链仍有重定向(用户历史卡片不能落空白页)')
  const tabNames = [...nav.matchAll(/\{ name: '(\w+)', label: t\('nav\./g)].map((m) => m[1])
  // 第三条是诊断台。它同时看两边, 所以路由不带:plat 段 —— 带上的话 router 会把多余的 params
  // 悄悄丢掉, 而"这一页属于哪个平台"这个假问题就会被下一个读到 URL 的人当真去答。
  assert(tabNames.join(',') === 'live,recordings,diag', 'D13g 顶栏恰好三条页面 tab(直播 · 录制 · 诊断)', tabNames.join(','))
  assert(/name: 'diag', component/.test(rt) && !/\/:plat\/diag/.test(rt), 'D13g2 诊断台的路由不带平台段(/diag), 也不参与「下次打开回到哪」的记忆', rt.match(/path: '\/diag'[^\n]*/)?.[0] || '没有 /diag')
  assert(!/noteWorkspace\(to\.params\.plat\)[\s\S]{0,200}diag/.test(rt) && /to\.name === 'live' \|\| to\.name === 'recordings'/.test(rt), 'D13g3 落点记忆的名单仍是两个平台页(诊断台进名单会让「停在诊断页」被记成工作区偏好)', rt.match(/if \(to\.name ===[^\n]*/)?.[0] || '')
}

// ============================================================================
// D14 白屏与最小窗宽契约(2026-09-30 实机截图审查后补: 三条都是当场看到的真故障)
// ============================================================================
{
  // ① 设置页整屏空白: structuredClone 吃 Pinia 响应式代理会抛 DataCloneError,
  //    抛在 setup 的 immediate watch 里 = 该页 v-if 永远不成立 = 白屏
  const clones = []
  for (const f of RENDERER) {
    linesOf(f).forEach((l, i) => {
      if (/structuredClone\(/.test(l)) clones.push({ at: `${rel(f)}:${i + 1}`, ok: /toRaw\(/.test(l) })
    })
  }
  const rawLess = clones.filter((c) => !c.ok)
  assert(
    clones.length > 0 && rawLess.length === 0,
    'D14a 渲染层 structuredClone 一律先 toRaw(响应式代理不可克隆)',
    rawLess.map((c) => c.at).join(', ') || `${clones.length} 处全部合规`
  )

  // ② 顶栏在最小窗宽(1024)下的溢出: 页面 tab 不许换行, 搜索框不许塌成纯图标
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const navTab = /\.nav-tab\s*\{[^}]*\}/.exec(css)?.[0] || ''
  assert(/white-space:\s*nowrap/.test(navTab), 'D14b .nav-tab 禁换行(否则「直播」竖排两行, 顶栏溢出 57px)')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  assert(/flex-1\s+min-w-\[\d+px\]/.test(nav), 'D14c 顶栏搜索框有 min-width 下限(右侧是 shrink-0 固定段, 无下限就被压扁)')
  const win = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  const minW = Number(/minWidth:\s*(\d+)/.exec(win)?.[1] || 0)
  assert(minW > 0, 'D14d 主窗口有 minWidth(界面审查的响应式下限就是它)', `minWidth=${minW}`)

  // ③ 库空态: 一条记录都没有时不许摆出一排筛选, 也不许把「还没录过」说成「筛错了」
  const lib = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LibrarySection.vue'), 'utf8')
  assert(/v-if="totalCount" class="sec-bar"/.test(lib), 'D14e 库为 0 条时段条(五枚 chip + 平台 + 分组 + 搜索)整条不出现')
  assert(!/emptyFilter[^"]*\?:|:. *t\('library\.emptyFilter'/.test(lib), 'D14f emptyFilter 不再被三元当全局空态用')
  assert(!/emptyNoDir|emptyGoLive/.test(lib), 'D14g 库空态收成一句事实(去向入口在录制页页头, 不再按有没有目录给两种下一步)')
}

// ============================================================================
// D15 冷启动不被网络按住在「加载中」空屏 (2026-09-30 实机: 冷启动前十几秒整屏只有一行小字)
// ============================================================================
{
  const app = fs.readFileSync(R('src', 'renderer', 'src', 'stores', 'app.ts'), 'utf8')
  const init = /async init\(\)\s*\{[\s\S]*?\n    \},/.exec(app)?.[0] || ''
  assert(init.length > 0, 'D15a 找得到 store.init()')
  const gate = /await Promise\.all\(\[([\s\S]*?)\]\)/.exec(init)?.[1] || ''
  assert(gate.length > 0 && !/authState/.test(gate), 'D15b 首屏就绪的门禁里只有本地取数(账号校验要发官方接口, 一进 await 就是全网卡整屏)', gate.replace(/\s+/g, ' ').trim())
  assert(/void api\.authState\(\)/.test(init), 'D15c 账号校验照发, 只是不阻塞: 结果经 EV.account 回挂')

  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const push = /async function pushAccounts[\s\S]*?\n\}/.exec(ipc)?.[0] || ''
  assert(/Promise\.all\(\[pandaAccount\(\), soopAccount\(\)\]\)/.test(push), 'D15d 两平台登录态并行取(串行把最慢一方的等待叠两遍)')

  // 态没回来之前只能说「还没查」: 报成未登录会凭空劝人重登
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  assert((nav.match(/t\('nav\.checking'\)/g) || []).length === 2, 'D15e 顶栏两平台在态未回来时都显示「校验中」')
  const acct = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'AccountView.vue'), 'utf8')
  // 2026-09-30 账号页重设计: 一屏只留一套平台切换(顶栏)、一张动作卡、一句存储说明
  assert(!/<PlatFilter/.test(acct), 'D15f 账号页不自备第二套平台分段(换方归顶栏, 页内只标注当前是哪一方)')
  assert(/page === 'account'[\s\S]{0,220}query: \{ \.\.\.route\.query, plat: target \}/.test(nav), 'D15f2 顶栏分段在账号页原地改 ?plat=(从前把人踢回直播页, 页面才被迫自备分段)')
  assert(!/states\?:|pf__state/.test(fs.readFileSync(R('src', 'renderer', 'src', 'components', 'PlatFilter.vue'), 'utf8')), 'D15f3 PlatFilter 的 states 通道随账号页分段一起退役(没有消费方就删干净)')
  const zhAcct = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  assert(!/badgeEnc:|mARec:|mCStable:|mBT1:|segOk:/.test(zhAcct), 'D15f4 冗余徽章(推荐/最稳定/加密存储)与分段状态字已删: 推荐由按钮档位说, 存储由页底 doorNote 说一次')
  assert(/t\('account\.stChecking'\)/.test(acct) && /mode: 'checking' as const/.test(acct), "D15g 账号页大状态卡有独立一档「正在校验」(不与 none 共用, 否则复检按钮会被一起藏掉)")
  assert(/v-if="status\.mode === 'ok' \|\| status\.mode === 'warn'"/.test(acct), "D15h 退出登录只在确实有会话时给(校验中摆红色退出是空承诺)")

  // 空态要有界: 整屏垂直居中的一行小字看起来像界面坏了
  const ws = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  assert(!/v-else class="h-full flex flex-col items-center justify-center"/.test(ws), 'D15i 工作区空墙收成有界卡(不再整屏居中)')
  assert(/border-dashed[\s\S]{0,120}py-16/.test(ws), 'D15j 空态卡与「库」「进行中」同一份有界规格')

  // 页头动作按钮档位: 两个页面页头曾是 medium 与 tiny 并存(全应用主流是 small)
  assert(!/size="medium"/.test(ws), 'D15k 直播页页头不用 medium')
  const rec = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  assert(!/size="tiny"/.test(rec), 'D15l 录制页页头快捷入口不用 tiny(tiny 只留给设置页行内控件)')

  // ′(2026-10-01 订正) 在播坞整体退役: 视图分段的第一档已经给了「关注在播」的计数与出口,
  //    别视图再挂一条头像带就是同一批房间的第二份呈现(判据见 D38)
  assert(!/LiveDock|livedock/.test(ws), 'D15m 工作区不引不挂头像坞(补回视图不该自带第二条读数带)')
  assert(!/onLiveView/.test(ws), 'D15m2 自我指向开关 onLiveView 随坞一起退役')

  // ′(2026-09-30 订正) 同一屏的同类入口只留一处: 录制页的快捷入口是页头右上角那一排
  //    (去直播页 / 打开保存目录 / 录制设置)。空态里再挂一枚同去向的按钮, 让人先判断该点哪个。
  assert(!/<template #extra>[\s\S]{0,300}<n-button/.test(rec), 'D15n 「进行中」空态不挂按钮, 只留指引句(去直播页由页头给)')
  const libsec = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LibrarySection.vue'), 'utf8')
  assert(!/gotoNextStep/.test(libsec), 'D15n2 库空态行只剩一句事实, 末尾链接撤掉(页头已有录制设置)')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  assert(
    !/emptyGoLive:/.test(zh) && !/emptyNoDir:/.test(zh) && !/emptyActiveHint: '到「直播」页/.test(zh),
    'D15n3 空态的去向说明文案键已删(链接没了, 句子也不必再报地址)'
  )

  // 空槽要长满剩余视口: 数据为零时页面下半截是裸页面底, 与「坏了」只隔一层边框
  assert(/min-h-full flex flex-col/.test(rec), 'D15o 录制页正文列撑满视口(留白归给空槽而不是裸页面底)')
  assert(/flex-1 min-h-\[200px\][\s\S]{0,160}border-dashed/.test(rec), 'D15o2 「进行中」空态是会长高的空槽, 且有 min-h 兜住矮视口')
  assert(!/flex-1 min-h-\[200px\][\s\S]{0,160}place-items-center/.test(rec), 'D15o3 空槽内容贴顶不居中(居中=小字飘在 538px 框正中, 又回到当初反对的样子)')
}

// ============================================================================
// D16 关注/取关承载矩阵 + 进度承载面 (2026-09-30 用真实数据 876 关注 / 24 在播逐点取证)
// ============================================================================
{
  const anchor = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AnchorCard.vue'), 'utf8')
  const explore = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'ExploreCard.vue'), 'utf8')
  const player = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const ws = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')

  // ① 卡片形态的取关在「…」菜单里, 且菜单项是 button 不是 div+cursor-pointer(div 键盘到不了)
  assert(/<button[^>]*text-liveink[^>]*@click="emit\('remove'/.test(anchor), 'D16a 已关注卡片的取关在「…」菜单内, 且是可聚焦的 button')
  assert(!/<[a-z][^>]*cursor-pointer/.test(anchor), 'D16a2 卡片菜单不用 div 装按钮(同一动作在离线行上是 button, 在这里不能是不可 Tab 到的 div)')
  // ② 紧凑行形态的取关在行尾 ✕
  assert(/:title="t\('card\.unfollow'\)" @click="removeAnchor/.test(ws), 'D16b 离线关注行的取关是行尾按钮')
  // ③ 心形只出现在发现卡的 hoverActions(浏览现场), 且整仓只有这一枚
  assert(/#hoverActions[\s\S]*M12 21s/.test(explore), 'D16c 发现卡的心形挂在 hoverActions 里')
  const hearts = RENDERER.filter((f) => /M12 21s/.test(fs.readFileSync(f, 'utf8')))
  assert(hearts.length === 2, 'D16c2 全应用只有两枚心形(发现卡 + 卡片「已关注」标记), 取关不再新增第三种心形入口', hearts.map(rel).join(', '))
  // ④ 播放页是第四种承载: 取关态必须与其余三处同为红, 不能穿中性灰
  assert(/:type="following \? 'error' : 'primary'"/.test(player), 'D16d 播放页取关按钮用 error 档(卡片菜单/离线行/发现卡三处的取关都是红)')
  // ⑤ 在播读数不承载管理动作: 坞退役后「谁在播」只剩顶栏徽标与分段计数两处读数, 二者只管跳
  assert(!/unfollow|anchorsRemove|removeAnchor/.test(nav), 'D16e 顶栏在播徽标无取关承载(管理动作只在卡片菜单/离线行/播放页)')

  // ⑥ 进度承载面: 全应用一条 .meter, 且只给有真实分母的对象(VOD 下载全长来自 m3u8 清单)
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  assert(/^\.meter\s*\{/m.test(css) && /^\.meter i\s*\{/m.test(css), 'D16f .meter 与其填充条在样式层有定义')
  const meters = []
  eachLine(RENDERER, (f, n, l) => { if (/class="[^"]*\bmeter\b/.test(l)) meters.push(`${rel(f)}:${n}`) })
  // 诊断台带来两根: 一根「下一轮倒计时」(分母 = 你设定的轮距), 一根「关机后能捡回来」(分母 = 主进程给的留存上限)。
  // 这一条普查要的不是"3"这个数, 而是每多一根都得当场回答"它的分母谁给的"。
  assert(
    meters.length === 3 && meters.filter((m) => m.includes('DiagnosticsView.vue')).length === 2 && meters.filter((m) => m.includes('RecordingsView.vue')).length === 1,
    'D16g 全应用三根进度条(回放清单全长 / 诊断台轮距 / 诊断台留存上限), 每一根都有真分母',
    meters.join(', ')
  )
  const diagView = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'DiagnosticsView.vue'), 'utf8')
  assert(
    /function nextPct\([\s\S]{0,260}if \(!sec \|\| r\.nextInMs < 0\) return null/.test(diagView) && /v-if="nextPct\(snap\.rounds\[p\], p\) !== null"/.test(diagView),
    'D16g2 轮距那一根: 设定的间隔读不到就整根不画(画一根 0% 的死条等于说"它刚起步"), 判据与 v-if 两处都要在'
  )
  const rec = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  assert(/v-if="task\.vod"[\s\S]{0,400}class="w-\[88px\] meter"/.test(rec) && /vodPct\(task\) !== null/.test(rec), 'D16h .meter 只在回放分支内, 且被「清单给了真实全长」守卫兜住(拉不到全长退回纯文字)')
  assert(!/n-progress/.test(rec), 'D16h2 不引第二套进度控件(n-progress 与 .meter 并存=同一件事两种画法)')
  assert(/\{ key: 'fetch', label: t\(task\.vod \? 'rec\.pipeFetchVod' : 'rec\.pipeFetch'\) \}/.test(rec), 'D16i 管线首棒文案跟着任务类型走: 回放行不许写「拉取直播源」')
  assert(/if \(task\.bytes > p\.bytes\)[\s\S]{0,200}else\s*\{[\s\S]{0,200}next\[k\] = p/.test(rec), 'D16j 码率差分只在字节真长了时推进基线(按推送间隔算会把 8.4 Mbps 稳流读成 0.0↔26.1 跳变)')
  assert(!/Math\.max\(0, \(task\.bytes - p\.bytes\)/.test(rec), 'D16j2 退回旧写法(把无字节增长的推送算成 0 码率)即失败')
}

// ============================================================================
// D17 仓库卫生: 死令牌 / 无横幅的历史设计稿 / docs 里的二进制负重 / README 口径回潮
// ============================================================================
{
  const twCfg = createRequire(import.meta.url)(R('tailwind.config.js'))
  const ext = twCfg?.theme?.extend || {}
  const cls = [
    ...Object.keys(ext.boxShadow || {}).map((k) => `shadow-${k}`),
    ...Object.keys(ext.borderRadius || {}).map((k) => `rounded-${k}`),
    ...Object.keys(ext.animation || {}).map((k) => `animate-${k}`)
  ]
  // 解析器空转会让本条「假绿」(D9f 同款教训): 令牌数下限先兜住
  assert(cls.length >= 4, 'D17a0 tailwind 令牌清单解析合理(至少 4 个自定义类)', cls.join(', '))
  const srcAll = walk(R('src'), /\.(vue|ts|css|html)$/)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
  const dead = cls.filter((c) => !srcAll.includes(c))
  assert(dead.length === 0, 'D17a tailwind 自定义令牌全部有使用处(死令牌就是下一个没人敢删的债, 3.4「不留死令牌」)', dead.join(', '))

  const designHtml = walk(R('docs', 'design'), /\.html$/)
  assert(
    designHtml.some((f) => f.endsWith('sodalive-ia-v1.html')),
    'D17b0 现行设计稿在案(清单为空时下面那条横幅规则就是空转假绿)',
    designHtml.map(rel).join(', ')
  )
  const noBanner = designHtml.filter(
    (f) => !f.endsWith('sodalive-ia-v1.html') && !/superseded-banner/.test(fs.readFileSync(f, 'utf8'))
  )
  assert(noBanner.length === 0, 'D17b 历史设计稿一律带「被谁覆盖」横幅(没横幅=读者拿作废的页面划分去实现)', noBanner.map(rel).join(', '))

  const bin = walk(R('docs'), /\.(png|jpe?g|gif|webp|zip|7z)$/i)
  assert(bin.length === 0, 'D17c docs/ 只放自包含 HTML: 截图导出物一旦没人引用就是纯仓库负重', bin.map(rel).join(', '))

  for (const name of ['README.md', 'README_EN.md']) {
    const t = fs.readFileSync(R(name), 'utf8')
    const tag = t.split(/\r?\n/).find((l) => l.startsWith('> ')) || ''
    assert(/PandaLive/.test(tag) && /SOOP/.test(tag), `D17d ${name} 副标题是双平台口径`, tag)
    assert(/npm run verify/.test(t), `D17e ${name} 记了 verify 回归链(package.json 里有就必须能在文档里找到)`)
    for (const svc of ['soop.ts', 'source.ts', 'hlsProxy.ts']) {
      assert(t.includes(svc), `D17f ${name} 代码结构含 ${svc}(整个 SOOP 半边不能只在源码里存在)`)
    }
  }
}

// ============================================================================
// D18 圆角只有四档: 卡片 14 / 控件 10 / 徽标 6(sm=5) / 胶囊 999(设计稿 0.4 尺度表)
//   档位是抄来的还是拍的? 拍的一档(rounded-lg/xl/2xl/裸 rounded)在同屏里长出 4/8/12/16px 四种
//   圆角, 用户看不出道理, 下一个人也无从判断该用哪个 —— 所以数值本身要能被断言。
// ============================================================================
{
  const LADDER = new Set(['card', 'ctl', 'md', 'full']) // md=6px(徽标档), full=胶囊/圆点
  const off = []
  let seen = 0
  eachLine(RENDERER.filter((f) => f.endsWith('.vue')), (f, n, l) => {
    if (isCommentLine(l)) return
    for (const m of l.matchAll(/\brounded(?:-[a-z0-9[\].%]+)?/g)) {
      seen++
      const raw = m[0].slice('rounded'.length)
      const tier = raw.startsWith('-[') ? '任意值' : raw.replace(/^-/, '')
      if (!LADDER.has(tier)) off.push(`${loc(f, n)} :: ${m[0]}`)
    }
  })
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const CSS_LADDER = new Set(['5px', '6px', '10px', '14px', '999px', '50%'])
  const cssOff = []
  let cssSeen = 0
  for (const src of [css, ...RENDERER.filter((f) => f.endsWith('.vue')).map((f) => fs.readFileSync(f, 'utf8'))]) {
    for (const m of src.matchAll(/border-radius:\s*([^;]+)/g)) {
      cssSeen++
      for (const v of m[1].trim().split(/\s+/)) if (!CSS_LADDER.has(v)) cssOff.push(m[1].trim())
    }
  }
  // 解析器空转 = 假绿(D9f 同款教训): 先兜住命中数下限
  assert(seen >= 60, `D18a0 模板圆角类命中数合理(≥60)`, `${seen} 处`)
  assert(cssSeen >= 12, `D18a1 CSS 圆角声明命中数合理(≥12)`, `${cssSeen} 处`)
  assert(off.length === 0, 'D18a 模板只用 14/10/6/999 四档圆角(设计稿 0.4)', off.slice(0, 10).join('\n         '))
  assert(cssOff.length === 0, 'D18b CSS 里的 border-radius 也全在档位上(含滚动条与进度条端点)', [...new Set(cssOff)].slice(0, 8).join(', '))
}

// ============================================================================
// D19 平台身份色点只有一处定义(全局 .pdot), 各组件不再自画尺寸与描边环
// ============================================================================
{
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  for (const sel of ['.pdot {', '.pdot-sm {', '.pdot-panda {', '.pdot-soop {']) {
    assert(css.includes(sel), `D19a 平台色点定义齐全: ${sel}`)
  }
  assert(/\.pdot\s*\{[^}]*box-shadow: 0 0 0 1px rgb\(var\(--c-ink3\)\)/.test(css), 'D19b .pdot 描边环恒为 ink3(SOOP 黄压白卡 1.43:1, 不勾边就等于看不见)')
  const legacy = ['platdot', 'pf__dot', 'plat-tag__dot', 'dot-panda', 'dot-soop']
  const still = []
  const users = []
  for (const f of RENDERER.filter((x) => x.endsWith('.vue'))) {
    const t = fs.readFileSync(f, 'utf8')
    for (const name of legacy) if (new RegExp(`\\b${name}\\b`).test(t)) still.push(`${rel(f)} :: ${name}`)
    if (/\bpdot\b/.test(t)) users.push(rel(f))
  }
  assert(still.length === 0, 'D19c 组件自画的平台点(旧名)已清零(两处规格=下一轮又要选一次用哪个)', still.join(', '))
  assert(users.length >= 4, 'D19d .pdot 消费面 ≥4 处(解析器空转即假绿)', users.join(', '))
  const handPainted = []
  eachLine(RENDERER.filter((f) => f.endsWith('.vue')), (f, n, l) => {
    if (isCommentLine(l)) return
    if (/background: *'var\(--plat-/.test(l) || /:style="\{\s*background:.*--plat-/.test(l)) handPainted.push(loc(f, n))
  })
  assert(handPainted.length === 0, 'D19e 模板里不再用内联 style 拼平台底色(点走 .pdot, 底面板走 .ava/.pt--*)', handPainted.join(', '))
}

// ============================================================================
// D20 计数药丸一枚定义: 顶栏 .platn / 段标题 .sec-n, 不许再有手搓的第三种
// ============================================================================
{
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  assert(!/min-w-\[\d+px\][^"]*rounded-full/.test(nav), 'D20a 顶栏没有手搓计数药丸')
  const pills = (nav.match(/class="platn/g) || []).length
  assert(pills === 2, 'D20b 顶栏两枚计数药丸同用 .platn(平台分段 + 页面 tab)', `${pills} 处`)
  const ws = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  assert(/class="sec-n"/.test(ws), 'D20c 视图分段计数是 .sec-n 药丸(设计稿 .vt .n), 不是裸字')
}

// ============================================================================
// D21 等宽数字一种写法: Tailwind 的 tabular-nums(曾有同义类 .tnum, 两种拼法混用查不出漏网)
// ============================================================================
{
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  // 去注释后再查: 下面那段注释本身就是「为什么曾有 .tnum」的记录, 提它是规则的本意
  assert(!/\.tnum\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'D21a .tnum 同义类已删(等宽数字只有 tabular-nums 一种拼法)')
  let tn = 0
  eachLine(RENDERER.filter((f) => f.endsWith('.vue')), (f, n, l) => {
    for (const m of l.matchAll(/\btabular-nums\b/g)) tn++
  })
  assert(tn >= 20, 'D21b 等宽数字覆盖面合理(≥20 处计数/时长/码率)', `${tn} 处`)
}

// ============================================================================
// D22 naive 主题面与 styles.css 语义变量逐值对齐(App.vue 的注释承诺, 此前无人核对)
//   供应商组件与自绘界面在同一屏里出现两套底色/两套主色, 就是这套值漂移出来的。
// ============================================================================
{
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const varsOf = (sel) => {
    // 必须锚定到块头(选择器+{): `:root` 与 `.dark` 都先在注释里被提过一次,
    // 裸 indexOf 会把 .dark 解析到 :root 块尾 —— 于是深色一侧整列拿到浅色值, 假红一片
    const i = css.search(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`))
    const body = css.slice(i, css.indexOf('\n}', i))
    const out = {}
    for (const m of body.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)/g)) {
      out[m[1]] = '#' + [m[2], m[3], m[4]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')
    }
    return out
  }
  const L = varsOf(':root')
  const D = varsOf('.dark')
  const appSrc = fs.readFileSync(R('src', 'renderer', 'src', 'App.vue'), 'utf8')
  const overridesOf = (name) => {
    // 同上: 锚定 `const NAME = {`, 否则命中文件下方 computed 里的引用
    const i = appSrc.search(new RegExp(`const ${name} =\\s*\\{`))
    const body = appSrc.slice(i, appSrc.indexOf('\n}', i))
    const out = {}
    for (const m of body.matchAll(/(\w+):\s*'#([0-9a-fA-F]{6})'/g)) out[m[1]] = `#${m[2].toLowerCase()}`
    return out
  }
  const LT = overridesOf('LIGHT_OVERRIDES')
  const DT = overridesOf('DARK_OVERRIDES')
  assert(Object.keys(L).length >= 12 && Object.keys(D).length >= 12, 'D22a 两套 CSS 变量解析合理(各 ≥12 色)', `L=${Object.keys(L).length} D=${Object.keys(D).length}`)
  assert(Object.keys(LT).length >= 10 && Object.keys(DT).length >= 10, 'D22b 两套 naive 覆盖解析合理(各 ≥10 色)', `L=${Object.keys(LT).length} D=${Object.keys(DT).length}`)
  // naive 键 ↔ 语义变量; 深浅两档不同时写 [浅变量, 深变量]
  const PAIRS = [
    ['primaryColor', 'brand', 'brand'],
    ['primaryColorHover', 'brand-hi', 'brand-hi'],
    ['bodyColor', 'page', 'page'],
    ['cardColor', 'card', 'card'],
    ['modalColor', 'card', 'fill'],
    ['popoverColor', 'card', 'fill'],
    ['inputColor', 'fill', 'fillh'],
    ['borderColor', 'line', 'line'],
    ['textColorBase', 'ink1', 'ink1'],
    ['errorColor', 'live-ink', 'live'],
    ['successColor', 'ok', 'ok-ink'],
    ['warningColor', 'warn', 'warn-ink']
  ]
  const drift = []
  for (const [key, lv, dv] of PAIRS) {
    if (LT[key] !== L[lv]) drift.push(`light ${key}: naive ${LT[key]} vs --c-${lv} ${L[lv]}`)
    if (DT[key] !== D[dv]) drift.push(`dark ${key}: naive ${DT[key]} vs --c-${dv} ${D[dv]}`)
  }
  assert(PAIRS.length >= 12, 'D22c 对齐清单条数合理(≥12 组)')
  assert(drift.length === 0, 'D22 naive 主题每一枚色值都能在语义变量里找到同名档(漂移=同一屏两套色)', drift.join('\n         '))
}

// ============================================================================
// D23 品牌散文: 用户可见文案里的小写 pandalive 是代码枚举/磁盘目录名, 不是品牌形
//   (实测: 设置·关于的免责文案写着「与 pandalive 官方无任何关联」, 而同页分组标题写的是 PandaLive —— 同一屏两种称呼)
//   例外只有「落盘结构」两条: 那里说的确实是目录名本身, 改成品牌形反而教人找不到文件夹。
// ============================================================================
{
  const LOCALES = walk(R('src', 'renderer', 'src', 'i18n'), /\.ts$/)
  let scanned = 0
  checkWithAllowlist(
    'D23 文案里的平台品牌形统一(PandaLive, 不是 pandalive)',
    LOCALES,
    (l) => {
      if (!isCommentLine(l) && /['"`][^'"`]*:?\s*[^'"`]*['"`]/.test(l)) scanned++
      return /['"`][^'"`]*\bpandalive\b/.test(l) && !isCommentLine(l) ? '小写 pandalive 出现在用户可见文案' : ''
    },
    [
      { file: 'src/renderer/src/i18n/locales/zh-CN.ts', re: /saveDirLayout/, why: '说的是磁盘目录名本身, 不是品牌称呼' },
      { file: 'src/renderer/src/i18n/locales/en-US.ts', re: /saveDirLayout/, why: '同上(与 zh 对齐)' }
    ]
  )
  assert(scanned >= 200, 'D23a0 文案扫描面合理(≥200 条字符串)', `${scanned} 行`)
}

// ============================================================================
// D24 动作行按钮档位: 自绘按钮的高度必须由 h-* 锁档, 不能靠 py-[Npx] 撑
//   实测漏网: 设置·关于的「GitHub 主页」用 py-[7px] 撑到 34.35px, 同行 naive small「检查更新」是 28px,
//   两枚按钮并排一眼看出不齐 —— 而 D1~D22 没有任何一条查得到它(圆角/颜色都在档上)。
// ============================================================================
{
  const bad = []
  let seen = 0
  for (const f of RENDERER.filter((x) => x.endsWith('.vue'))) {
    const ls = linesOf(f)
    ls.forEach((l, i) => {
      if (!/py-\[\d+(\.\d+)?px\]/.test(l)) return
      seen++
      const cls = (l.match(/class="([^"]*)"/) || [])[1] || ''
      if (!/rounded-(ctl|card|md)\b/.test(cls)) return
      if (/\bh-\[?[\d.]+|\bh-(2|3|4|5|6|7|8|9|10|11|12)\b/.test(cls)) return
      // 判定这一行的宿主标签: 从本行往上找到第一个带开标签的行, 取该行最后一个标签名
      // (class 常与 <button 分行写; 只看「附近有没有 button」会把 4 行外的按钮算成自己)
      let tag = ''
      for (let j = i; j >= Math.max(0, i - 6) && !tag; j--) {
        const ms = [...ls[j].matchAll(/<([a-zA-Z][-\w]*)/g)].map((m) => m[1])
        if (ms.length) tag = ms[ms.length - 1]
      }
      if (tag === 'button' || tag === 'n-button') bad.push(`${loc(f, i + 1)} ${l.trim().slice(0, 110)}`)
    })
  }
  assert(seen >= 5, 'D24a0 py-[Npx] 扫描面合理(≥5 处)', `${seen} 行`)
  assert(bad.length === 0, 'D24 自绘按钮用 h-* 锁档位(py-[Npx] 撑高会与同行 naive 按钮差 6px)', bad.slice(0, 8).join('\n         '))
}

// ============================================================================
// D25 设置保存链契约 (2026-09-30 设置页审查 P0: 「保存设置」在实机上是静默 no-op)
//   机制: 提交 {...form.value} 时 notify/autoRecordDefault 仍是 Pinia 响应式代理,
//   IPC 走 structured clone ⇒ 整包被拒; 而保存只有 try/finally, 失败连气泡都没有 ——
//   于是"点了没反应", 且盘没写、界面却显示已改(数据与界面分叉)。
// ============================================================================
{
  const sv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const main = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  assert(!/\{\s*\.\.\.form\.value/.test(sv), 'D25a 提交载荷不得浅展开 form.value(嵌套对象仍是代理, 不可克隆)')
  assert(/structuredClone\(toRaw\(/.test(sv), 'D25b 提交载荷经 toRaw + structuredClone 脱代理')
  const i = sv.indexOf('const dirtyKeys = computed')
  const dirtyBody = sv.slice(i, sv.indexOf('})', sv.indexOf('return out', i)))
  assert(/baseline\.value/.test(dirtyBody) && !/store\.settings/.test(dirtyBody), 'D25c 脏清单跟「进页快照」比, 不跟实时投影比(后者被别的写入方刷新 ⇒ 一按保存就把对方新值回滚)')
  const adopted = (sv.match(/baseline\.value\.\w+ =/g) || []).length
  assert(adopted >= 2, 'D25d 主题/语言即时通道落盘后同步基线(否则已保存的项永远挂着「未保存」)', `${adopted} 处`)
  assert(/catch \(e\)[\s\S]{0,220}?t\('settings\.saveFail'/.test(sv), 'D25e 保存失败出声(此前 try/finally 把它吞成「点了没反应」)')
  assert(/sanitizeSettingsPatch\(/.test(ipc), 'D25f settings:set 过入站闸门(不合格键不收, 而不是收了再兜底)')
  assert(/logger\.(warn|info)\([^)]*拒收/.test(ipc), 'D25g 被拒的键落日志(不静默吞掉: 前端越界要看得见)')
  assert(!/\bnet\.fetch\(/.test(ipc), 'D25h ipc 里没有绕过代理的 net.fetch(它走默认会话, 用户配的代理形同虚设)')
  assert(/fromPartition\(SESSION_PARTITION\)\s*\.fetch\(/.test(ipc), 'D25i 检查更新走已配代理的分区会话')
  assert(/setBackgroundColor\(windowBg\(/.test(ipc) && /backgroundColor: windowBg\(/.test(main), 'D25j 「主题立即生效」名副其实: 建窗与切主题两处同用 windowBg')
}

// ============================================================================
// D26 关于页身份数据单一来源: 作者/头像/仓库 slug/日志目录都从 appInfo(IPC) 来
//   实测漏网: 模板里写死 `Joftal/pd-monitor`、`https://github.com/Joftal.png`、`…\data\logs\app-YYYYMMDD.log`
//   —— 换作者、换仓库名、mac/linux 下跑一份, 这三行显示的全是错的, 而且没人会去改模板。
// ============================================================================
checkWithAllowlist(
  'D26 渲染层不得写死作者/仓库/日志路径(一律 appInfo 下发)',
  RENDERER.filter((f) => f.endsWith('.vue')),
  (l) => {
    if (isCommentLine(l)) return ''
    if (/github\.com\/[A-Za-z0-9_.-]+/.test(l)) return '写死 GitHub 身份 URL'
    if (/Joftal/.test(l)) return '写死作者名'
    if (/data[/\\]logs/.test(l)) return '写死日志目录样式'
    return ''
  },
  []
)
{
  const sv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  const meta = fs.readFileSync(R('src', 'shared', 'appmeta.ts'), 'utf8')
  const types = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  for (const k of ['author', 'authorUrl', 'repo', 'releasesPage']) {
    assert(new RegExp(`\\b${k}:`).test(meta), `D26b APP_META 定义 ${k}(唯一定义处)`)
    assert(new RegExp(`^\\s{2}${k}: string$`, 'm').test(types.slice(types.indexOf('export interface AppInfo'), types.indexOf('/** 检查结果'))), `D26c AppInfo 下发 ${k}`)
  }
  const iface = types.slice(types.indexOf('export interface AppInfo'), types.indexOf('/** 检查结果'))
  assert(/logsDir: string/.test(iface), 'D26d AppInfo 下发 logsDir(跨平台的真值, 不是 Windows 路径样式)')
  assert(/info\?\.logsDir/.test(sv) && /avatarUrl/.test(sv) && /repoSlug/.test(sv), 'D26e 关于页三处身份数据都用 appInfo 的计算属性')
}

// ============================================================================
// D27 段标题只有两档规格: 段用 .sec-h, 卡内分组用 .grp-h
//   实测漏网: 设置页 7 个段标题手搓 `text-[13.5px] font-bold text-ink1 tracking-wide`,
//   账号页同一角色又写成 13.5px、录制页写成 14.5px extrabold —— 同一屏三种字号字重。
//   16px 的品牌字标(TopNav / 关于横幅)不是段标题, 不在这一档里。
// ============================================================================
{
  const bad = []
  eachLine(RENDERER.filter((f) => f.endsWith('.vue')), (f, n, l) => {
    if (isCommentLine(l)) return
    if (/text-\[1[34](\.\d)?px\][^"]*font-(bold|extrabold)[^"]*tracking-wide/.test(l)) bad.push(`${loc(f, n)} ${l.trim().slice(0, 110)}`)
  })
  assert(bad.length === 0, 'D27 段标题不得在模板里手搓(13~14px bold tracking-wide → 用 .sec-h)', bad.slice(0, 8).join('\n         '))
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const views = RENDERER.filter((f) => f.endsWith('.vue'))
  for (const cls of ['sec-h', 'grp-h']) {
    assert(new RegExp(`\\.${cls}\\s*\\{`).test(css), `D27b .${cls} 在 styles.css 有定义(模板引用的自定义类必须存在)`)
    const used = views.filter((f) => new RegExp(`\\b${cls}\\b`).test(fs.readFileSync(f, 'utf8'))).length
    assert(used >= 1, `D27c .${cls} 至少被一个视图使用(定义了没人用 = 死令牌)`, `${used} 个视图`)
  }
}

// ============================================================================
// D28 按钮宽度只锁下限: !min-w-[Npx] 允许, !w-[Npx] 禁止
//   实测漏网: 账号页「打开登录窗口」定宽 112px 在中文下刚好, 切英文被裁成「Open login wind」——
//   定宽锁的是「这一档视觉」, 却顺手裁掉了翻译。下限保住对齐的最小宽度, 长译文自己撑开。
//   例外必须是「布局盒」而不是「文案盒」: 表单输入框与对话框的宽是列宽, 与翻译无关, 走白名单。
// ============================================================================
{
  const vues = RENDERER.filter((f) => f.endsWith('.vue'))
  const hard = []
  eachLine(vues, (f, n, l) => {
    if (isCommentLine(l)) return
    if (/<(n-button|button)\b/.test(l) && /!w-\[\d+px\]/.test(l)) hard.push(`${loc(f, n)} ${l.trim().slice(0, 110)}`)
  })
  assert(hard.length === 0, 'D28 按钮不用定宽(裁掉的是翻译; 中文永远看不出问题)', hard.slice(0, 8).join('\n         '))

  const LAYOUT_W = [
    { where: 'AccountView.vue', re: /<n-input\b[^>]*!w-\[180px\]/, why: '托管账密的账号输入框是列宽' },
    { where: 'AddFollowDialog.vue', re: /<n-modal\b[^>]*!w-\[460px\]/, why: '关注/添加对话框的弹窗宽(2026-10-01 随对话框从 WorkspaceView 拆出, 例外跟着搬)' }
  ]
  for (const e of LAYOUT_W) {
    const hit = vues.filter((f) => f.endsWith(e.where)).some((f) => e.re.test(fs.readFileSync(f, 'utf8')))
    assert(hit, `D28b 定宽例外仍成立: ${e.where} 的 ${e.why}(例外不再命中任何行=该作废, 按仓库规矩直接 FAIL)`)
  }

  const floors = vues.reduce((a, f) => a + (fs.readFileSync(f, 'utf8').match(/!min-w-\[\d+px\]/g) || []).length, 0)
  assert(floors >= 8, `D28c 下限写法覆盖面 ≥8 处(全应用按钮档位; 计数归零说明这条规则被静默拆除)`, `${floors} 处`)
}

// ============================================================================
// D29 筛选条不能被自己筛掉: 出现与否看基数, 筛空的墙必带取消出口
//   实机(2026-09-30): Panda 站内发现 395 条, 点「只看已关注」(本机关注数 0) 之后整条筛选条
//   从 DOM 消失 —— 锁住人的不是筛子, 是开着的那枚 chip 跟着结果一起没了; 而空墙写的是
//   「站内暂时没有可展示的在播房间」, 一句与筛子无关的通用解释顶掉了真正的归因。
//   订正: 基数三视图必须同一口径(搜索词已生效、chip 未生效)。发现段原先用未过词的
//   store.discovery.length, 于是「词无命中 + chip 开着」会被报成 chip 的锅, 而「取消筛选」
//   按下去仍旧是空墙 —— 与上面那一类无出口现场同形, 只是换了个触发路径。
// ============================================================================
{
  const wsSrc = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  assert(!/v-if="activeList\.length" class="px-7 pt-3/.test(wsSrc), 'D29a 筛选条不得按「筛完还剩几条」决定出现(chip 会连自己一起消失)')
  assert(/v-if="filterBarVisible" class="px-7 pt-3/.test(wsSrc), 'D29b 筛选条的出现条件走 filterBarVisible')
  assert(/const filterBarVisible = computed\(\(\) => baseCount\.value > 0 \|\| activeFilters\.value\.length > 0\)/.test(wsSrc), 'D29c filterBarVisible = 基数有条 或 有筛子开着(后者必须留出口)')
  assert(/const baseCount = computed\(\(\) => \{[\s\S]{0,40}if \(view\.value === 'live'\) return liveList\.value\.length[\s\S]{0,40}if \(view\.value === 'discover'\) return store\.discovery\.filter\(\(x\) => hit\(x\)\)\.length[\s\S]{0,40}return offBase\.value\.length/.test(wsSrc), 'D29d 三视图基数同一口径「搜索词已生效 · chip 未生效」(liveList / discovery 过 hit / offBase)')
  assert(!/view\.value === 'discover' \? store\.discovery\.length/.test(wsSrc), 'D29h 发现段基数不得用未过搜索词的 store.discovery.length(无命中时冤枉 chip, 取消筛选救不回现场)')
  assert(/@click="clearFilters"/.test(wsSrc), 'D29e 筛空的墙必带「取消筛选」出口')
  assert(/if \(activeFilters\.value\.length && baseCount\.value\)/.test(wsSrc), 'D29f 空态归因把「是筛空的」排在其它解释之前(否则被通用文案顶掉)')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  assert(/emptyFiltered: '「\{label\}」筛完是 0 条 · 这一栏本来有 \{n\} 条'/.test(zh), 'D29g 筛空那句话报的是筛子名与基数, 不是「没有房间」')
  // D30 空态的文案与出口是一件事的两半: 分两处判断就会漂(实机: 发现段有词无命中, 墙上写「没有匹配 X」而手里一个按钮都没有,
  //       而顶栏搜索框没有 ✕ —— 用户得自己去顶栏找回那个词)。改为 emptyAction 与 listEmpty 同判据同顺序。
  assert(/const emptyAction = computed<EmptyAction>\(\(\) => \{/.test(wsSrc), 'D30a 空态出口由 emptyAction 单点决定(不再按视图各写一套 v-if)')
  assert(/if \(view\.value === 'discover'\) \{\s*if \(kw\.value\) return 'clearKw'/.test(wsSrc), 'D30b 发现段判据里 kw 排在「缺前提」之前 —— 有词时该清除搜索, 不该跳登录')
  assert(/v-if="emptyAction" class="flex gap-2 justify-center mt-2"/.test(wsSrc) && /emptyAction === 'clearKw'/.test(wsSrc), 'D30c 墙上句子里点到搜索词, 手里就必须有「清除搜索」这枚按钮')
  assert(!/v-else-if="kw" size="small" secondary class="mt-2"/.test(wsSrc), 'D30d 出口不得再退回视图分支里的散写(与文案不同判据即失败)')
}

// ============================================================================
// D31 播放页返回 = 从哪来回哪去, 且不跨平台
//   实机(2026-10-01): 此前 goBack() 写死 router.push({name:'live'}), 于是从站内发现(甚至从录制页)
//   进房后点返回, 一律被甩到「在播关注」—— 用户的话是"不要跨域, 这样体验非常不好"。
//   现读历史栈: 上一站是同平台的直播页/录制页就 router.back()(连 ?view= 与滚动位一起带回),
//   栈空(TG 推送/收藏直链)或来自对面平台才落本平台直播页。按钮写的就是它会去的地方。
// ============================================================================
{
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  assert(/const backTarget = computed<\{ label: string; run: \(\) => void \}>\(\(\) => \{/.test(pv), 'D31a 返回目标由 backTarget 单点决定(目的地与文案同源)')
  assert(/router\.options\.history\.state\.back/.test(pv), 'D31b 返回读历史栈的上一站, 不是写死直播页')
  assert(/prev\.startsWith\(`\/\$\{platform\}\/recordings`\)/.test(pv), 'D31c 录制页是一等返回目的地(从库/录制页进房不该被甩去直播)')
  assert(/new URLSearchParams\(prev\.slice\(prev\.indexOf\('\?'\) \+ 1\)\)\.get\('view'\)/.test(pv), 'D31d 工作区返回按 ?view= 落位, 发现段回来还在发现段')
  assert((pv.match(/backTarget\.label/g) || []).length === 2, `D31e 两处返回按钮都绑 backTarget.label(模板里再写死一句就是假话)`, `${(pv.match(/backTarget\.label/g) || []).length} 处`)
  assert((pv.match(/t\('player\.backToLive'/g) || []).length === 1, `D31f 「返回 直播」只剩兜底那一处(栈空/跨平台), 不得再当默认目的地`, `${(pv.match(/t\('player\.backToLive'/g) || []).length} 处`)
  assert(/run: \(\) => void router\.push\(\{ name: 'live', params: \{ plat: platform \} \}\)/.test(pv), 'D31g 兜底仍旧落本平台直播页(深链直进播放页时 back() 会停在原地)')
}

// ============================================================================
// D32 播放页侧栏读得完 + 动作行按轻重分档 (2026-10-01 实机 1600x900 取证)
//   ① 侧栏: 三张 .panel 直接放在 flex 列里, 默认会被压扁, 而 .panel{overflow:hidden}
//      把尾部就地裁掉 —— aside 因此"没有溢出", 滚动条压根不出现, 被裁的几行永远滚不到。
//      量尺: aside h=763 / scroll=763 / scrollTop=9999→0, 「上次失效」「开播自动录制」消失。
//   ② 动作行: 刷新穿 primary secondary(淡蓝底)看着像禁用, 关注却是全排最响的实心,
//      而本页真正的核心动作(录制)反而是淡底 —— 轻重与频次/后果都不匹配。
// ============================================================================
{
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const aside = (pv.match(/<aside[\s\S]*?<\/aside>/) || [''])[0]
  assert(aside.length > 500, 'D32a0 侧栏解析面合理(aside 段落取到了)', `${aside.length} 字符`)
  assert(/<aside class="[^"]*\boverflow-y-auto\b/.test(aside), 'D32a 侧栏自己是滚动容器(读不完的内容必须滚得到)')
  const panels = aside.match(/<div class="panel(?: [^"]*)?"/g) || []
  assert(panels.length >= 3, `D32b 侧栏卡数合理(≥3 张)`, `${panels.length} 张`)
  assert(panels.every((p) => /\bshrink-0\b/.test(p)), 'D32 侧栏每张卡 shrink-0(flex 列的默认压缩 + .panel{overflow:hidden} = 尾部行被裁且滚不到)', panels.join(' '))
  assert(!/bg-brand\/\[0\.07\]/.test(pv), 'D32c 用法说明不再单占一枚品牌色大卡(它讲的是源失效怎么办, 并到播放源卡脚注)')
  assert((pv.match(/t\('player\.tips'\)/g) || []).length === 1, `D32d 说明文案全页只出现一次`, `${(pv.match(/t\('player\.tips'\)/g) || []).length} 处`)

  const acts = [...pv.matchAll(/<n-button\b(?=[^>]*@click="(manualRefresh|toggleFollow|toggleRecord)")[^>]*>/g)].map((m) => m[0])
  assert(acts.length === 4, `D32e 动作行按钮解析面合理(刷新 1 + 关注 1 + 录制 2 分支)`, `${acts.length} 枚`)
  assert(acts.every((a) => /size="small"/.test(a)), 'D32f 动作行同档 size="small"(实机四枚 h=28 齐高)')
  assert(acts.every((a) => /!min-w-\[\d+px\]/.test(a)), 'D32g 动作行每枚都有宽度下限(定宽或无下限, 裁掉的都是翻译)')
  assert(/quaternary[^>]*@click="manualRefresh"/.test(pv), 'D32h 刷新降为幽灵档(随手可点的辅助不该和核心动作同响)')
  assert(/secondary :type="following \? 'error' : 'primary'"/.test(pv), 'D32i 关注恒描边(可逆收藏, 轻于录制; 取关仍走 error 红, 见 D16d)')
  assert(!/:secondary="!recording"/.test(pv), 'D32j 录制按钮不再按开关态退回淡底(生效后最不明显 = 这一排最要紧的动作点完反而消失)')
  assert(/<n-button v-if="!isVod" size="small" type="error" @click="toggleRecord"/.test(pv), 'D32k 直播录制恒实心 error 档(naive error = liveink 6.52:1, 可承载白字; 开关态由文案自己的 ⏺/■ 承担)')
  // ③ 同一读数一屏只说一次: 观众数此前在画面角标 / 标题元信息行 / 侧栏 kv 各挂一遍
  assert((pv.match(/\{\{ viewers \}\}/g) || []).length === 1, `D32l 观众数全页只渲染一次(三处各列一遍 = 用户先要判断该信哪个)`, `${(pv.match(/\{\{ viewers \}\}/g) || []).length} 处`)
  assert(!/v-if="m3u8[^"]*"[^>]*viewers|v-if="m3u8 && viewers"/.test(pv), 'D32m 那唯一一处不得挂在播放态守卫里(源失效时读数连同自己的上下文一起消失)')
}

// ============================================================================
// D33 播放页读数不得只认「关注列表」 (2026-10-01 实机取证)
//   站内发现进来的房大多没被关注, 那时 store.anchors 里根本没有这条 —— 而播放页的身份字段
//   只从 anchor 播种、点赞/粉丝只读 anchor, 于是快照里明摆着的数据被渲染成裸 ID 与「—」:
//   znvely00 快照 likes 2652 / fans 5681, 侧栏两行「—」; 密码房 umeceo 取不到源, 整屏写成
//   「umeceo的直播间 / 标签 — / 点赞 —」。现一处 room 快照(关注列表 > 站内发现, 两级都随轮询整包推),
//   展示值 = loadPlay 回包 > room > 裸 ID; 两样都没有的深链房仍旧如实显示「—」(那是真不知道)。
// ============================================================================
{
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  assert(/const room = computed\(\(\) => \{[\s\S]{0,60}const a = anchor\.value[\s\S]{0,60}const d = discoveryItem\.value/.test(pv), 'D33a 房间读数一处收敛(room 快照 = 关注列表 > 站内发现)')
  const chained = (pv.match(/\|\| room\.value\./g) || []).length
  assert(chained >= 5, `D33b 展示值都走「回包 > 快照」这条链(≥5 处: title/nick/userImg/thumb/tags)`, `${chained} 处`)
  assert(!/numOrNa/.test(pv) && /v-if="room\.likes"[\s\S]{0,140}\{\{ room\.likes \}\}/.test(pv) && /v-if="room\.fans"[\s\S]{0,140}\{\{ room\.fans \}\}/.test(pv), 'D33c 点赞/粉丝仍从 room 取值, 且只在给得出数时摆这一行(未关注房读快照; 没有数就整行缺席, 不再画「—」或「不适用」)')
  assert(!/const viewers = computed\(\(\) => anchor\.value\?\.viewerCount \|\| discoveryItem/.test(pv), 'D33d 观众数不再自带一套取值链(与 room 同判据, 免得两处口径分叉)')
  const playWrites = ['playTitle.value = r.title', 'playNick.value = r.nick', 'playUserImg.value = r.userImg', 'playThumb.value = r.thumbUrl', 'playTags.value = r.tags']
  const writes = playWrites.filter((w) => pv.includes(w)).length
  assert(!/\b(title|nick|userImg|thumb|tags)\.value = r\./.test(pv) && writes === 5, 'D33e loadPlay 回包只写 play* 引用(直接覆盖展示值就会把快照挤掉, 回包是一次性的)', `回包写入 play* ${writes}/5`)
  assert(/const autoRecHere = computed\(\(\) => !!anchor\.value\?\.autoRecord\)/.test(pv), 'D33f 「开播自动录制」仍只读 anchor: 它是关注关系身上的开关, 没关注就是未开启, 不是缺失')
}

// ============================================================================
// D34 工作区·视图分段行右侧不常驻快捷键提示 (2026-10-01 用户指令)
//   撤下的是屏上那条常驻灰字, 不是快捷键本身: 1/2/3 切视图与 / 聚焦搜索照旧能用。
//   提示一旦上屏就成一排分段右侧的第三条声音(分段本身 + 计数药丸 + 一句说明书),
//   而它讲的动作不需要看见才会发生 —— 键盘是自己会敲的人用的。
//   口径: 提示文案没有消费方就必须连 i18n 键一起删(「无消费方即删」这一条), 死键会让双语 parity 看起来还在但其实没人读。
// ============================================================================
{
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  assert(/function onKey\(e: KeyboardEvent\)/.test(wv) && /e\.key === '1'/.test(wv) && /getElementById\('global-search'\)/.test(wv) && /id="global-search"/.test(nav), 'D34a 快捷键本体仍在且指得到实物(1/2/3 切视图 · / 聚焦顶栏搜索)—— 撤的是提示, 不是功能')
  const segRow = /<!-- 视图分段 -->\n\s*<div[\s\S]*?\n {4}<\/div>/.exec(wv)?.[0] ?? ''
  assert(segRow.includes('sec-n') && segRow.includes('@click="setView(v)"'), 'D34b0 视图分段行解析面合理(分段按钮与计数都取到了)', `${segRow.length} 字节`)
  assert(!/keyHint/.test(wv + zh + en), 'D34c 提示文案三处净空(模板 + 双语键, 无消费方即删不留死键)')
  assert(!/flex-1/.test(segRow), 'D34d 分段行右侧不再挂东西(为一句灰字摆的撑开块一并撤, 不留空转的 flex-1)')
}

// ============================================================================
// D35 工作区筛选条右端「只在真有搜索词时出声」 (2026-10-01 用户指令, 与 D34 同一条口径)
//   撤的是常驻说明书「排序与页码在本视图内记忆」: 记忆是这一屏的默认行为, 不是需要天天提醒的规则。
//   搜索态那句(「{kw}」的搜索结果 + 清除搜索出口)必须留着 —— 它说的是此刻正在发生的事, 不是规则。
// ============================================================================
{
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  const bar = /<!-- 本视图的排序 \/ 筛选条[\s\S]*?\n {4}<\/div>/.exec(wv)?.[0] ?? ''
  assert(bar.includes('setSort(') && bar.includes('toggleFilter(') && bar.includes('ws.searchResult'), 'D35a0 筛选条解析面合理(排序 chip · 筛子 · 搜索态那句都取到了)', `${bar.length} 字节`)
  assert(!/memoryHint/.test(wv + zh + en), 'D35b 「排序与页码在本视图内记忆」三处净空(模板 + 双语键, 无消费方即删不留死键)')
  assert(/<template v-if="kw">[\s\S]{0,200}flex-1[\s\S]{0,200}ws\.searchResult/.test(bar), 'D35c 右端整块(撑开 + 那句)都挂在搜索态里 —— 无词时不留空转的 flex-1')
  const st = fs.readFileSync(R('src', 'renderer', 'src', 'stores', 'app.ts'), 'utf8')
  assert(/views: Record<WSView, ViewFilter>/.test(st) && /views: \{ live:[\s\S]{0,120}discover:[\s\S]{0,120}offline:/.test(st), 'D35d 记忆本体仍在(三视图各存一份 ViewFilter)—— 撤的只是屏上那句话')
}

// ============================================================================
// D36 「关注主播」拆成两平台专属入口 (2026-10-01 用户指令: 不要做在一起, 不需要自动识别, 都分平台做)
//   原状: 一枚对话框里挂「自动识别 / Panda / SOOP」三档分段 + 一个输入框 —— 粘什么都会先替你猜一遍平台,
//   而这一屏的用户本来就知道自己在哪一方(工作区就是按平台切的), 猜错还直接把对面的房间种进了本平台。
//   判据: ① 平台由所在工作区决定, 对话框只收本平台的房间; ② 粘到对面平台的地址不静默入库 —— 明说是
//   哪一方的并给一键过去(原文经 store.addDraft 过境换平台, 新实例把对话框撑开, 不用重打); ③ SOOP 的纯数字是场次号, 单独归因,
//   不许当频道名进库; ④ 提交恒带平台参数, 不再留 undefined 让主进程按默认平台兜底。
// ============================================================================
{
  const dlg = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AddFollowDialog.vue'), 'utf8')
  const wsSrc = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const pf = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'PlatFilter.vue'), 'utf8')
  const i18n = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8') + fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  assert(dlg.includes('add.titlePanda') && dlg.includes('add.titleSoop') && dlg.includes('add.phPanda') && dlg.includes('add.phSoop') && dlg.includes('add.confirmPanda') && dlg.includes('add.confirmSoop'), 'D36a 两平台各自成套的标题/占位符/按钮文案都被消费(不是同一套皮换个名)')
  assert(!/platAuto/.test(i18n) && !/'auto'/.test(pf) && !/PlatFilter/.test(dlg), 'D36b 「自动识别」这一档全站净空(双语键 + 控件选项 + 对话框里的平台分段)')
  assert(/api\.anchorsAdd\(raw\.value\.trim\(\), props\.platform\)/.test(dlg), 'D36c 提交恒带平台参数(不得再传 undefined 让主进程按默认平台兜底)')
  assert(dlg.includes("state === 'other'") && /emit\('goto-other', raw\.value\.trim\(\)\)/.test(dlg) && /@goto-other="gotoOtherPlat"/.test(wsSrc) && /store\.addDraft = text/.test(wsSrc) && /ref\(store\.addDraft !== ''\)/.test(wsSrc), 'D36d 粘错平台: 归因之外必须有出口 —— 原文经 store.addDraft 过境换平台, 新实例自己把对话框撑开')
  assert(dlg.includes('/^\\d+$/.test(s)') && dlg.includes("return 'seq'"), 'D36e SOOP 的纯数字是场次号 —— 单独归因, 不许当频道名入库')
  assert(/<AddFollowDialog v-model:show="showAdd" :platform="plat"/.test(wsSrc) && !/addPlatform|addParsed|addInput/.test(wsSrc), 'D36f 工作区只把当前平台交给对话框, 自己不留第二份解析态')
}

// ============================================================================
// D37 分段时长填 0 = 不分段 (2026-10-01 用户指令: 「现在似乎是必须要分段录制, 我要支持不分段的」)
//   形态是「数字框允许 0」而不是新摆一档开关: 0 在这一格不是越界值, 是「这一档关掉」的显式取值,
//   所以闸门(夹取下界之前)、控件(min)、三处读数面都得各自认这个 0 —— 任何一处按旧惯用法
//   `x || 900` / `Math.max(60, x)` / `f === 'merged'` 处理, 0 就静默变回 900 或整块UI消失。
//   归类: 不分段的成品与手动合并的产物同形(一个不带 _NNNN 后缀的文件), 库里合并为一档「整文件」,
//   不新增字段记"当初怎么录的" —— 那个信息对用户没有下一步动作, 只会多出一个永远对不上的枚举。
// ============================================================================
{
  const rec = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const guard = fs.readFileSync(R('src', 'main', 'services', 'settingsGuard.ts'), 'utf8')
  const sv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const rv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  const lib = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LibrarySection.vue'), 'utf8')
  const media = fs.readFileSync(R('src', 'renderer', 'src', 'utils', 'media.ts'), 'utf8')
  const i18n = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8') + fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  assert(/const segSec = Number\.isFinite\(cfg\.splitSeconds\) \? cfg\.splitSeconds : 900/.test(rec), 'D37a 分段秒数只在"不是有限数"时才兜默认(旧写法 `= cfg.splitSeconds || 900` 会把 0 吞成 900, 注释里留着的那一句不是代码)')
  assert(/else if \(segSec === 0\) \{[\s\S]{0,300}args\.push\('-i', m3u8, '-map', '0', '-c', 'copy', this\.liveSingleFile\)/.test(rec), 'D37b 0 走单文件直出那一支: -c copy 到 liveSingleFile, 不进 -f segment')
  assert(/get liveSingleFile\(\): string \{\r?\n\s*return path\.join\(this\.dirPath, `\$\{this\.baseName\}\.ts`\)/.test(rec), 'D37c 单文件产出名 = 基名.ts, 不带 _NNNN —— SEG_RE 认它是"整文件"而不是"某一段", 合并那侧也就喂不进 concat')
  assert(/'-segment_time', String\(Math\.max\(60, segSec\)\)/.test(rec), 'D37d 分段那一支的 60s 下限照旧(0 已被上面那一支截走, 不该在这里被夹成一个 60 秒的分段档)')
  assert(/ZERO_OK: readonly \(keyof Settings\)\[\] = \['splitSeconds'\]/.test(guard) && /v === 0 && ZERO_OK\.includes\(key\) \? 0/.test(guard), 'D37e 入站闸门认 0 是显式取值(负数与 1~59 仍夹到 60, 只有白名单里的键的 0 原样落盘)')
  assert(/function clampSplit\(v: unknown\): number \{[\s\S]{0,200}return n === 0 \? 0 : Math\.min\(7200, Math\.max\(60, n\)\)/.test(sv) && /:min="0" :max="7200"/.test(sv), 'D37f 设置页这一格收 0: 控件 :min="0" 且本地夹取不把 0 抬成 60(清空/NaN 才回默认 900)')
  assert(/form\.autoMp4 && form\.splitSeconds !== 0[\s\S]{0,40}mergeMp4/.test(sv) && /form\.autoMp4 && form\.mergeMp4 && form\.splitSeconds !== 0/.test(sv), 'D37g 不分段时"合并成片""删分段"两档收起: 没有第二段可合, 摆着就是让人去点一个不会发生的事')
  assert(pv.includes("t('player.outMerge')") && pv.includes("t('player.segOff')") && /s\.splitSeconds !== 0 \?/.test(pv), 'D37h 播放页侧栏: 产出与分段两个读数各说各的 0, 「合并成片」不再挂在产出那行')
  assert(/splitOff\.value \? t\('rec\.segOff'\)/.test(rv) && /st\?\.splitSeconds !== 0\) out\.push\(\{ key: 'merge'/.test(rv), 'D37i 录制页: 顶部那句读数是「不分段 · 整场单文件」, 流水线的第四棒(合并)在 0 时不存在')
  assert(/if \(h\.vod \|\| mp4s\.length !== 1 \|\| \(h\.files \|\| \[\]\)\.length !== 1\) return false/.test(media) && !/isMergedTask/.test(media + lib + rv), 'D37j 库判据改名到位(isMergedTask 全站绝迹): 盘上就一个不带后缀的文件 ⇒ 整文件')
  assert(lib.includes("type FilterKey = 'all' | 'live' | 'vod' | 'whole' | 'error'") && lib.includes("t('library.fWhole')") && !/fMerged|'merged'/.test(lib), 'D37k 筛档只剩一档「整文件」: 不按"当初怎么录的"分叉, 合并来源与不分段来源同形同归')
  const mainI18n = fs.readFileSync(R('src', 'main', 'i18n.ts'), 'utf8')
  assert(/'rec\.fileOne': '1 个文件'/.test(mainI18n) && /'rec\.fileOne': '1 file'/.test(mainI18n) && /this\.files\.length === 1 \? mt\('rec\.fileOne'\)/.test(rec), 'D37l 收尾提示在单文件时说「1 个文件」而不是「共 1 段」(主进程双语齐备)')
  // 实机抓到的(2026-10-01): 录制页进行中的读数写着「已写入 · 1 段」—— 那一档压根没有段
  assert(/isSingleFileTask\(task\.currentFile\) \? t\('rec\.writtenOne'\)/.test(rv) && !/writtenVod/.test(rv + i18n), 'D37m 进行中卡片的写入数在单文件那一档说「单文件」而不是「1 段」(判据读当前文件名的形状, 旧 vod 键随改名绝迹)')
}

// ============================================================================
// D38 「关注在播」一屏只留一个现场 (2026-10-01: 头像坞从站内发现 / 离线关注两视图退役)
//   判据: 一条读数只允许一个现场 —— 分段第一档自带呼吸点与计数, 顶栏徽标给跨页计数,
//         别视图再复制一条头像带就是同一批房间的第二份呈现, 而它连一个管理动作都不承载
// ============================================================================
{
  const ws = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const css = fs.readFileSync(R('src', 'renderer', 'src', 'styles.css'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  assert(!fs.existsSync(R('src', 'renderer', 'src', 'components', 'LiveDock.vue')), 'D38a 在播坞组件是删掉而不是藏起来(留着文件就等着被人再挂回别视图)')
  const leftovers = RENDERER.filter((f) => /LiveDock|livedock|dock\./.test(fs.readFileSync(f, 'utf8')))
  assert(leftovers.length === 0, 'D38b 渲染层再无第二处坞的痕迹(引名、样式类、取词全清)', leftovers.map(rel).join(', '))
  assert(!/dock: \{/.test(zh) && !/dock: \{/.test(en), 'D38c dock.* 四键两语言绝迹(界面撤了, 文案不许留在字典里当孤儿)')
  assert(!/liveAnchors/.test(SRC_ALL.map((f) => fs.readFileSync(f, 'utf8')).join('')), 'D38d 只喂坞的那个 store getter 随唯一消费方下线(没有读者的库存字段不留)')

  // 撤的是重复呈现, 不是「该去看」这条信号: 两个读数面必须各自还在
  assert(/viewCounts\.live \? 'bg-live animate-breathe'/.test(ws) && /class="sec-n">\{\{ viewCounts\[v\] \}\}/.test(ws), 'D38e 「关注在播」的屏上现场只剩分段第一档: 有呼吸点、有计数, 点下去就是整屏卡片墙')
  assert(/liveCount\(p\.key\)/.test(nav) && /store\.newLiveCount\(p\.key\) \? 'is-new'/.test(nav), 'D38f 顶栏徽标照旧报本平台在播数, 新开播仍把徽标转红(旧坞的 2px 竖条由它接回, 不劫持阅读)')

  assert(/看「在播关注」那一档和顶栏的在播计数/.test(zh) && /segment and the top-bar live count/.test(en), 'D38g SOOP 发现段空态的指引句改口指向分段与顶栏, 不再把人引向一条已经不存在的坞')
  assert(!/\.livedock/.test(css), 'D38h 渲染层样式表不留 .livedock 死规则')
}

// ============================================================================
// D39 SOOP 拿得到头像, 拿不到的读数就不许占位 (2026-10-01 用户指令「soop能不能拿到主播的头像? 点赞和粉丝数量拿不到的话, 不要在面板展示出来」)
//   头像: SOOP 关注列表整行没有一个图片字段(实测 718 行的键集), 但 logo 地址就是频道 ID 的函数 ——
//         播放页 <div id="bjThumbnail"> 的 <img src> 正是这一串, 而官方自己给它挂了 onerror:
//         "这一房没传过 logo"是预期内的一档(实测 14 个关注里 1 个 404), 所以 404 必须回落成"没有头像", 不许画破图。
//   占位: 一行永远填不上数的读数不是信息。写「不适用 · SOOP 接口不返回」是把我们的采集边界当成读数交给用户读。
// ============================================================================
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const av = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AvatarImg.vue'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  const sh = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  assert(/export function soopAvatarUrl\(userId: string\): string \{/.test(sh) && /stimg\.sooplive\.com\/LOGO\/\$\{userId\.slice\(0, 2\)\}\/\$\{userId\}\/\$\{userId\}\.jpg/.test(sh), 'D39a 头像地址由频道 ID 派生(与播放页 #bjThumbnail 同一串, 零请求), 与 roomUrl 同族放共享层')
  assert(/userImg: soopAvatarUrl\(userId\)/.test(so) && /userImg: string/.test(so), 'D39b 关注行落库就带头像, 并且注释老实写明这是我们派生的而非接口给的')
  assert(/if \(!a\.userImg\) store\.updateAnchor\(a\.platform, a\.userId, \{ userImg: soopAvatarUrl\(a\.userId\) \}\)/.test(wt), 'D39c 轮询只补空着的那批: 一轮收敛, 之后每轮这里零写入(库里既有的整墙空头像靠这一步补上)')
  assert(/userImg = soopAvatarUrl\(userId\)/.test(ip), 'D39d 手动新增的 SOOP 关注当场有头像, 不等下一轮')

  assert(/@error="failed = true"/.test(av) && /<slot v-else \/>/.test(av) && /watch\(\s*\(\) => props\.src/.test(av), 'D39e 头像只有一种画法: 取不到就把槽位交回调用方的兜底(首字母/剪影), 换房时判据复位')
  const bare = RENDERER.filter((f) => /<img[^>]*v-if="[^"]*userImg/.test(fs.readFileSync(f, 'utf8')))
  assert(bare.length === 0, 'D39f 裸 img 版头像全部换到 AvatarImg(裸写没有 onerror, 404 就画成破图)', bare.map(rel).join(', '))

  assert(!/naSoop/.test(pv) && !/naSoop/.test(zh) && !/naSoop/.test(en), 'D39g「不适用 · SOOP 接口不返回」连同两语言键一起绝迹: 撤掉的是一行占位, 不是给它换一句解释')
  assert(!/isSoop \? 'text-ink3'/.test(pv) && /const isSoop = platform === 'soop'/.test(pv), 'D39h 侧栏不再按平台分色(有数才摆行, 摆出来的行本来就都是真值), isSoop 仍服务于线路/保活那两处真实能力差异')
}

// ============================================================================
// D40 SOOP 的 ID 槽只放 ID: 「房间」那两个字是给自说明的东西写说明书 (2026-10-01 用户指令「这里的房间+ID, 直接显示ID就行」)
//   这一格的位置就是判据: 它在头像与昵称旁边, 前面还有直播状态与标题, 没有人会把它读成别的字段;
//   Panda 侧的 @ 不是文案而是用户名的一部分(粘出去就是 @xxx), SOOP 侧的频道名粘出去就是裸的 tnwl9630 ——
//   所以两平台各自的写法保留, 撤掉的只有我们替它加上去的那个前缀。
// ============================================================================
{
  const lc = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LiveCard.vue'), 'utf8')
  const wsv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  assert(/\? m\.userId : '@' \+ m\.userId/.test(lc) && /\? a\.userId : '@' \+ a\.userId/.test(wsv), 'D40a 卡片与离线行的 SOOP ID 槽都是裸频道名(Panda 仍 @用户名 —— 那是可粘贴地址的一部分, 不是文案)')
  assert(!/roomNo/.test(zh) && !/roomNo/.test(en) && !/房间 \{id\}|Room \{id\}/.test(zh + en), 'D40b「房间 {id}」这个带前缀的写法连两语言键一起绝迹(唯一消费方已改口, 死键不留)')
  const prefixed = RENDERER.filter((f) => /t\(['"][\w.]*roomNo['"]/.test(fs.readFileSync(f, 'utf8')))
  assert(prefixed.length === 0, 'D40c 全仓不再有任何一处给 ID 加「房间」前缀', prefixed.map(rel).join(', '))
  // 同一判据的下一次出现: 播放页侧栏那一格长期无条件替两平台加 @, 而 SOOP 的 @tnwl9630 粘出去不是任何地址
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  assert(/\{\{ isSoop \? userId : '@' \+ userId \}\}/.test(pv), 'D40d 播放页 ID 槽按平台各写各的: SOOP 裸频道名, Panda 留 @')
  assert(!/>@\{\{\s*userId\s*\}\}/.test(pv), 'D40e 播放页不再有无条件的 @ 前缀(那等于替 SOOP 编一个粘不出去的形状)')
}

// ============================================================================
// D41 播放页侧栏的「标签」整行撤掉: 房态在标题下方已有徽标, 普通房那一行只剩「—」 (2026-10-01 用户指令「这显示不了也去掉把, 不要占位」)
//   能提取到 —— SOOP 的关注行带 is_adult / is_password, 但只有 19+ / 密码 / 普通这一档, 粉丝团与回放是 Panda 的字段;
//   同一批 tags 在页头 ③ 标题元信息里已经画成徽标, 侧栏再列一遍是第二次呈现, 而"什么旗都没打"的多数房间只剩「—」占位。
//   撤的是行, 不是信号: 四枚徽标与 isVod(回放判定)必须原样在位。
// ============================================================================
{
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  assert(!/labelList/.test(pv) && !/player\.labels/.test(pv), 'D41a 侧栏「标签」那一行连同它的取值 computed 一起绝迹(留半个死 computed 就是等下次挂回去)')
  assert(!/^    labels: /m.test(zh) && !/^    labels: /m.test(en), 'D41b player.labels 双语死键同删(唯一消费方已撤)')
  const badges = ['account.tagPw', '19+', "tags?.type === 'fan'", 'isVod'].filter((k) => !pv.includes(k))
  assert(badges.length === 0, 'D41c 房态信号仍在页头: 密码 / 19+ / 粉丝团 三枚徽标 + isVod 回放判定一处都不能少', badges.join(', '))
  assert(/const tags = computed\(\(\) => playTags\.value \|\| room\.value\.tags\)/.test(pv), 'D41d tags 仍走「回包 > 快照」那条链: 徽标读的是它, 撤一行不许把取值链也降级')
}

// ============================================================================
// D42 取源回写按字段合并: 这一路观察不到的字段不许写 false (2026-10-01 实机抓到 —— 19+ 房一开播旗就没了)
//   SOOP 的 getPlay 看不到 19+(GRADE 语义未实测), 过去它交一份 isAdult: false, applyPlayMeta 又整包覆写,
//   于是"取一次源 = 擦一次真值", 下一轮列表才写回来 —— 卡与页头之间的闪断就是这么来的(库里那一晚就是 false)。
//   修法在两处: 回包不带看不见的字段; 合并只认回包真给的值。动态面由 verify-playcache 的 T25 覆盖。
//   之后列表那一路也不再取房间级 19+(所以"下一轮列表写回来"已不成立), 但这一路的规定一字未改: 看不见的字段依然不许写成 false。
// ============================================================================
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const sc = fs.readFileSync(R('src', 'main', 'services', 'source.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')

  const mediaLine = (so.match(/media: \{[^}]*isPw[^}]*\}/) || [''])[0]
  assert(mediaLine !== '' && !/isAdult/.test(mediaLine), 'D42a SOOP 取源回包不再携带 isAdult(看不到 = 不给这一格, 给 false 就是替列表下结论)', mediaLine.slice(0, 90))
  assert(/: AnchorTag \| null/.test(sc) && /typeof m\.isAdult === 'boolean' \? m\.isAdult : !!prev\?\.isAdult/.test(sc), 'D42b applyPlayMeta 按字段合并并把合并结果交回去(整包覆写的老写法不得复活)')
  assert(/const merged = applyPlayMeta\(platform, userId, r\)/.test(ip) && /tags: merged \?\?/.test(ip), 'D42c 渲染层拿到的房态 = 库里那一份(SOOP 走合并, Panda 仍走回包整包)')
}

// ============================================================================
// D43 播放源卡的两个出口各复制各的 (2026-10-01 用户指令「搞成能一键复制真地址的吧」)
//   屏上那串是本机才认的代理地址, 官方清单原址就压在它的 url= 参数里 —— 解出来零请求, 不必回主进程再要一个字段。
//   两枚按钮不是重复读数: 一个是"现在正在用的", 一个是"平台那张清单的原样", 各自与自己的标签相符。
//   出口只在地址真是代理地址时才出现(Panda 看到的就是真地址, 给它第二枚等于造一个恒等的假选项)。
// ============================================================================
{
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  assert(
    /const realSource = computed\(\(\) => \{\s*if \(!isProxySource\.value\) return m3u8\.value/.test(pv) &&
      /searchParams\.get\('url'\)/.test(pv),
    'D43a 真实源由本地代理地址的 url= 参数解出(Panda 直接原样返回) —— 这条出口不许变成第二次网络请求或主进程新字段'
  )
  const realBtn = (pv.match(/<button[^>]*@click="copyReal"[^>]*>\s*\{\{\s*t\('player\.copyReal'\)\s*\}\}/) || [''])[0]
  assert(/v-if="isProxySource"/.test(realBtn) && realBtn !== '', 'D43b 「复制真实源」只在源真是本地代理地址时出现, 且标签与动作一致', realBtn.slice(0, 90))
  assert(/@click="copyUrl"/.test(pv) && /return copyText\(m3u8\.value,/.test(pv), 'D43c 「复制」仍复制屏上那串正在用的源 —— 复制的必须等于看到的')
  const fallbacks = (pv.match(/document\.execCommand/g) || []).length
  assert(fallbacks === 1, 'D43d 剪贴板回退只有一份(两枚按钮共用 copyText): 复制第二份就是下次只改漏一半', `命中 ${fallbacks} 处`)
  // 只约束 srcProxyTip 这一个 key 的值: 「无法播放」在别处是正当文案(player.noPlay / 文件失效那句), 整文件否定会拦下正常文案
  const tipOf = (src) => (src.match(/srcProxyTip: '([^']*)'/) || [''])[1]
  const tipZh = tipOf(zh)
  const tipEn = tipOf(en)
  assert(
    tipZh !== '' && tipEn !== '' &&
      /copyReal: |copiedReal: /.test(zh) && /copyReal: |copiedReal: /.test(en) &&
      !/无法播放|will not work/.test(tipZh) && !/无法播放|will not work/.test(tipEn),
    'D43e copyReal / copiedReal 双语齐, 且 srcProxyTip 不再警告"复制出去放不了"(出口已给出, 留着就是自相矛盾的说明书)',
    `zh=${tipZh} / en=${tipEn}`
  )
}

// ============================================================================
// D44 SOOP 的房间级 19+ 标记整条不取 (2026-10-01 真机 7 轮 + 用户定「标记不重要, 可以不展示」)
//   平台自己会在同一场直播里改口(同一 broad_start: true→false×3→true), 所以"保住上一轮真值"救不了闪断;
//   而这一旗的消费面只有展示(卡片徽标 / 页头徽标 / TG 的 [19+]) —— 能不能取到 19+ 的源靠 SOOP 登录态与账号的成人认证。
//   规定落在五处: 解析层不读 is_adult → 列表回写不继承它(顺带清掉旧轮次残留) → 密码房旗照旧三态+?? → 下播仍只清场次属性(Panda 受益) → 读库时把已离线房的旧 true 收敛掉(它没有第二个写点)。
//   动态面由 verify-follows 的 B3/B6 覆盖。
// ============================================================================
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const wa = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const lc = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LiveCard.vue'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const tg = fs.readFileSync(R('src', 'main', 'services', 'tgFormat.ts'), 'utf8')

  const liveIface = (so.match(/export interface SoopFavoriteLive \{[\s\S]*?\n\}/) || [''])[0]
  const parsedLiteral = (so.match(/row\.live = \{[\s\S]*?\n  \}/) || [''])[0]
  assert(
    liveIface !== '' &&
      !/isAdult/.test(liveIface) &&
      parsedLiteral !== '' &&
      !/is_adult|isAdult/.test(parsedLiteral.replace(/\/\/[^\n]*/g, '')),
    'D44a SOOP 关注行不再解析 is_adult: 接口与 row.live 字面量里都不许有这一格(注释里提到它是为了说明为什么没有)',
    parsedLiteral.slice(0, 80)
  )
  const asr = (wa.match(/private applySoopRow[\s\S]*?\n  \}/) || [''])[0]
  assert(
    asr !== '' && /isAdult: false,/.test(asr) && !/live\.isAdult/.test(asr) && !/a\.tags\?\.isAdult/.test(asr),
    'D44b 列表回写不继承房间级 19+(恒 false, 顺带把旧轮次残留的 true 清掉): 上一轮的 isAdult 不得再进这一路',
    asr.slice(0, 60)
  )
  assert(
    /isPw: typeof live\.is_password === 'boolean' \? live\.is_password : undefined/.test(so) &&
      /isPw: live\.isPw \?\? a\.tags\?\.isPw \?\? false/.test(asr),
    'D44c 密码房旗不受这一刀影响: 解析仍留 undefined(不知道), 合并仍保住上一轮真值 —— 它决定弹不弹密码框、录制带不带密码'
  )
  const offPatch = (wa.match(/private offPatch[\s\S]*?\n  \}/) || [''])[0]
  assert(
    /tags: a\.tags \? \{ isAdult: a\.tags\.isAdult, isPw: false, type: a\.tags\.type, liveType: '' \} : null/.test(offPatch),
    'D44d 下播补丁分家照旧(此后只为 Panda 的 19+/粉丝团服务): 场次属性清, 房态属性留 —— 整对象写 null 就是把房间读成普通房',
    offPatch.slice(0, 80)
  )
  const ac = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AnchorCard.vue'), 'utf8')
  const ec = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'ExploreCard.vue'), 'utf8')
  assert(
    !/soopBlindAdult/.test(wa) &&
      /v-if="m\.isAdult"/.test(lc) &&
      /v-if="tags\?\.isAdult"/.test(pv) &&
      /tags\?\.isAdult/.test(tg) &&
      /isAdult: a\.tags\?\.isAdult/.test(ac) &&
      /isAdult: x\.isAdult/.test(ec),
    'D44e 随这一路一起绝迹的只有那个盲读计数; Panda 的 19+ 消费端一处都不许被顺手删掉(补范围: 在播卡 / 播放页页头 / TG [19+] / 关注卡 AnchorCard / 发现卡 ExploreCard —— 后两处读的是同一格, 曾落在断言之外)'
  )
  // f 读库时收敛旧残留(2026-10-01 复验抓到): 在播房每轮被列表回写成 false, 而**已经离线**的房再无写点,
  //   offPatch 保的又是"房间属性"—— 对 SOOP 这一格不再是属性, 于是 papcon0206 下播后页头仍画 19+。
  {
    const st = fs.readFileSync(R('src', 'main', 'services', 'store.ts'), 'utf8')
    const norm = (st.match(/^\s*if \(a\.platform === 'soop'[^\n]*$/m) || [''])[0]
    assert(
      norm !== '' && /a\.tags\?\.isAdult/.test(norm) && /isAdult: false/.test(norm) && /\.map\(migrateAnchor\)/.test(st),
      'D44f 旧库残留的 SOOP 房间级 19+ 在读库时清掉(幂等): 判据精确到 soop 那一行, 且 migrateAnchor 仍在 load 的逐条路径上 —— 离线的 SOOP 房没有第二个写点, 不在这里收敛就永久挂在页头',
      norm.slice(0, 90)
    )
    assert(
      !/platform === 'pandalive'[^\n]*isAdult: false/.test(st) && /isAdult: !!item\.isAdult/.test(wa) && /isAdult: !!x\.isAdult/.test(wa),
      'D44g Panda 的 19+ 仍由它自己的列表维护(watcher 的两处 !! 读值): 读库收敛只认 soop, 不许把 pandalive 的正当真值一并擦掉'
    )
  }
}

// ============================================================================
// D45 监控配置按平台分家 (2026-10-01 用户指令「现在是 2 个平台公用的, 我要改成 2 个平台独立, 自己用自己的」)
//   当轮四条决策: ①只拆节奏三格(pollIntervalSec / requestGapMs / prefetchStream), proxyUrl 与 autoRetryRecord 明确不拆;
//   ②三格搬进各自平台节, 全局「监控」节随之撤销(只剩 defaultWorkspace 一格, 那一节已是空壳, 并入外观);
//   ③引擎两套独立定时器(用户否掉了"一条时间轴 + 到期判定"的省事方案);
//   ④SOOP 节里「源保活 / 备用线路 · 官方无对应机制」先不动, 保持只报不改。
//   规定落在六层: 契约(矩阵取代三标量) → 迁移(老库一格铺成两格、顶层旧键删净) → 闸门(逐平台逐格夹) →
//   引擎(两条 timer + 两条预取队列, Panda 熔断只压自己那条时间轴) → 消费端(ipc/启动/读数一律带平台) → 界面与文案。
//   动态面: verify-playcache T26(预取与间隔互不带走、熔断只压自己) + verify-settings A6h/A7d/A16c~A16i/B5b/B5c + verify-notify A3/A5/A7b/A7c/A9b。
// ============================================================================
{
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const st = fs.readFileSync(R('src', 'main', 'services', 'store.ts'), 'utf8')
  const sg = fs.readFileSync(R('src', 'main', 'services', 'settingsGuard.ts'), 'utf8')
  const wa = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const mi = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  const pl = fs.readFileSync(R('src', 'preload', 'index.ts'), 'utf8')
  const sv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  const tn = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')

  const setIface = (ty.match(/export interface Settings \{[\s\S]*?\n\}/) || [''])[0]
  assert(
    setIface !== '' && /monitor: MonitorMatrix/.test(setIface) && !/^  (pollIntervalSec|requestGapMs|prefetchStream):/m.test(setIface),
    'D45a 契约只有一份真值: Settings 里那一格是矩阵, 顶层三个标量不许复活(留着就有"到底改哪个"的第二份真相)',
    setIface.slice(0, 60)
  )
  const monIface = (ty.match(/export interface MonitorRules \{[\s\S]*?\n\}/) || [''])[0]
  assert(
    monIface !== '' && /pollIntervalSec/.test(monIface) && /requestGapMs/.test(monIface) && /prefetchStream/.test(monIface),
    'D45b MonitorRules 三格齐 —— 拆的就是这一套节奏'
  )
  assert(!/proxyUrl|autoRetryRecord/.test(monIface), 'D45b2 范围守住: proxyUrl / autoRetryRecord 没混进矩阵(决策①明确不拆它们)')
  const defMon = (ty.match(/  monitor: \{\r?\n    pandalive:[\s\S]*?\r?\n    soop:[\s\S]*?\r?\n  \}/) || [''])[0]
  assert(
    /pandalive: \{ pollIntervalSec: 30, requestGapMs: 1200, prefetchStream: true \}/.test(defMon) &&
      /soop: \{ pollIntervalSec: 30, requestGapMs: 1200, prefetchStream: true \}/.test(defMon),
    'D45c 两平台默认同值 = 老库那一格铺开后的样子: 全新安装与升级安装不许行为不同(没改过设置的用户不该被换节奏)'
  )
  const mig = (st.match(/function migrateSettings[\s\S]*?\n\}/) || [''])[0]
  assert(
    mig !== '' && /legacyMon/.test(mig) && /r\.pollIntervalSec/.test(mig) && /r\.requestGapMs/.test(mig) && /r\.prefetchStream/.test(mig) && /toMonitorRules\(mm\.soop,[\s\S]{0,80}legacyMon/.test(mig),
    'D45d 老库那三格各铺进两平台同值(迁移不是重置: 只把"这一格归谁"说清楚)',
    mig.slice(0, 60)
  )
  const delLoop = (mig.match(/for \(const k of \[[\s\S]*?\]\)[\s\S]*?delete [^\n]*/) || [''])[0]
  assert(
    delLoop !== '' && ['pollIntervalSec', 'requestGapMs', 'prefetchStream'].every((k) => delLoop.includes(`'${k}'`)),
    'D45e 顶层旧键与九个死键在同一处删净: setSettings 是浅合并, 死键留在对象上就会永久回写 db.json',
    delLoop.slice(0, 60)
  )
  assert(
    /function mergeMonitor\(base: MonitorMatrix, inc: unknown\)/.test(st) && /monitor: mergeMonitor\(db\.settings\.monitor, patch\.monitor\)/.test(st),
    'D45f 写侧半格提交先与现值逐格兜底: 只交 SOOP 那一格不许把 Panda 整格写掉'
  )
  const numRange = (sg.match(/const NUM_RANGE[^=]*= \{[\s\S]*?\n\}/) || [''])[0]
  assert(
    numRange !== '' && !/pollIntervalSec|requestGapMs|prefetchStream/.test(numRange),
    'D45g 顶层数值表不再认识这三键(留着=给未注册键做夹紧, 还与矩阵那套两套口径)',
    numRange.slice(0, 60)
  )
  const monRange = (sg.match(/const MONITOR_RANGE[^=]*= \{[\s\S]*?\n\}/) || [''])[0]
  assert(/pollIntervalSec: \[5, 600\]/.test(monRange) && /requestGapMs: \[300, 10000\]/.test(monRange), 'D45h 矩阵内的数值区间逐格登记(与设置页控件同口径)')
  assert(/key === 'monitor'/.test(sg) && /function sanitizeMonitor/.test(sg), 'D45i 闸门认识 monitor 这一格: 未注册平台与拼错格名都要出声, 不是静默丢掉')

  assert(/private loop: Record<Platform, Loop> = \{ pandalive: newLoop\(\), soop: newLoop\(\) \}/.test(wa), 'D45j 决策③落地: 每平台自己的定时器/在飞标志/上次发车时刻/轮次计数')
  assert(!/this\.lastSoopRoundAt/.test(wa) && !/private timer: NodeJS/.test(wa), 'D45k 那条共用的时间轴与它给 SOOP 单设的节流闸门一并作废(字段留着就是假装有分家)')
  const ivf = (wa.match(/private intervalFor\(platform: Platform\): number \{[\s\S]*?\n  \}/) || [''])[0]
  assert(
    ivf !== '' && !/circuitOpen/.test(ivf) && /monitor\[platform\]\.pollIntervalSec/.test(ivf) && /Math\.max\(1,/.test(ivf),
    'D45l 轮距只来自各自那一格, 且它不读熔断态 —— 旧形状是"熔断期把 Panda 压到 30s(SOOP 不陪着)", 那一压已被撤(风控期加倍发问与这一格要防的相反, 详见 D104a~c): 留下的是"两站在任何状态下同一格" + 1s 下限只防手改库写出 0'
  )
  assert(/private prewarmQueue: Record<Platform, string\[\]>/.test(wa) && /private prewarmPumping: Record<Platform, boolean>/.test(wa), 'D45m 预取队列与泵各平台一条: 共用版里 Panda 熔断的 length=0 会把排在队里的 SOOP 房一起丢掉')
  assert(/cfg\.monitor\[a\.platform\]\.prefetchStream/.test(wa), 'D45n 开播是否预取源, 看本平台那一格')
  assert(/this\.loop\.pandalive\.inFlight\) break/.test(wa), 'D45o 间隙泵让路看的是 Panda 自己那条时间轴(SOOP 在飞与它无关)')

  assert(
    /if \(!store\.getSettings\(\)\.monitor\[platform\]\.prefetchStream\) return/.test(wa) &&
      /if \(L\.roundCnt === 1\) this\.prewarmSweep\(platform\)/.test(wa) &&
      !/watcher\.prewarmNow\(a\.platform/.test(mi),
    'D45p 预取补扫按本平台那一格, 且只在首轮落地后跑(开机即按库态群发的那段已从 index.ts 撤走)'
  )
  assert(
    /watcher\.tick\(isPlatform\(platform\) \? platform : undefined\)/.test(ip) && /anchorsRefresh, \(_e, platform: Platform\)/.test(ip),
    'D45q 工作区「立即刷新」只惊动所在平台那一条, 不为另一个平台多发一轮(平台不认识才退回首轮语义)'
  )
  assert(/JSON\.stringify\(before\.monitor\[p\]\) !== JSON\.stringify\(cfg\.monitor\[p\]\)\) nudge\.add\(p\)/.test(ip), 'D45r 设置保存后逐平台比对那一条, 只惊动真的改了的那条时间轴')
  assert(/anchorsRefresh: \(platform\?: Platform\)/.test(pl), 'D45s preload 桥带上可选平台参数(不传=两平台各一轮的旧语义)')

  assert(!/key: 'monitor'/.test(sv) && !/data-sec="monitor"/.test(sv) && !/\|\s*'monitor'/.test(sv), 'D45t 决策②: 导航项与全局「监控」节一起撤销(那一节已只剩 defaultWorkspace 一格, 空壳节并入外观)')
  assert(
    ['pandalive', 'soop'].every((p) => new RegExp(`form\\.monitor\\.${p}\\.(pollIntervalSec|requestGapMs|prefetchStream)`).test(sv)) &&
      (sv.match(/form\.monitor\.pandalive\./g) || []).length >= 3 &&
      (sv.match(/form\.monitor\.soop\./g) || []).length >= 3,
    'D45u 三格在两个平台节里各绑各的, 且两平台都是满三格(少一格就是又一处"只改一半")'
  )
  assert(!/form\.(pollIntervalSec|requestGapMs|prefetchStream)\b/.test(sv), 'D45v 界面里不许再出现顶层节奏的读法')
  const secOf = (name) => {
    const i = sv.indexOf(`<section data-sec="${name}"`)
    if (i < 0) return ''
    const j = sv.indexOf('</section>', i)
    return sv.slice(i, j < 0 ? sv.length : j)
  }
  const pandaSec = secOf('panda')
  const soopSec = secOf('soop')
  assert(
    pandaSec !== '' &&
      /form\.monitor\.pandalive\.(pollIntervalSec|requestGapMs|prefetchStream)/.test(pandaSec) &&
      !/form\.monitor\.soop\./.test(pandaSec) &&
      soopSec !== '' &&
      /form\.monitor\.soop\.(pollIntervalSec|requestGapMs|prefetchStream)/.test(soopSec) &&
      !/form\.monitor\.pandalive\./.test(soopSec),
    'D45v2 每块平台节只绑自己那一格: 绑串了=在 SOOP 页上调间隔写进 Panda 那一格, 三格看着各就各位, 值的归属却错了'
  )
  assert(/monitor: \{ pandalive: clampMonitor\(f\.monitor\.pandalive\), soop: clampMonitor\(f\.monitor\.soop\) \}/.test(sv), 'D45w 提交载荷恒带两平台整格(半格=另一平台被浅合并写掉)')
  assert(
    /monitor\?\.\[plat\.value\]\?\.pollIntervalSec/.test(tn) && /monitor\?\.\[plat\.value\]\?\.pollIntervalSec/.test(wv) && /monitor\?\.\[platform\]\?\.pollIntervalSec/.test(pv),
    'D45x 三处轮询读数(顶栏 / 工作区分段 / 播放页)各读自己平台那一格 —— 共用时 SOOP 页报的是 Panda 的节奏'
  )
  assert(!/navMonitor|monitorDesc/.test(zh) && !/navMonitor|monitorDesc/.test(en) && !/^\s{4}monitor:/m.test(zh) && !/^\s{4}monitor:/m.test(en), 'D45y 节撤销后死键跟着死: navMonitor / settings.monitor / monitorDesc 双语都不留(有消费端时 D10 会查取词, 无人取词的键只能靠这一条)')
  assert(!/^\s*(pollSecDesc|gapMsDesc):/m.test(zh) && !/^\s*(pollSecDesc|gapMsDesc):/m.test(en), 'D45z 没有后缀的那两句必须随分家变成两套(留一句"通用说明"就是替另一个平台说话)')
  assert(['pollSecDescPanda', 'pollSecDescSoop', 'gapMsDescPanda', 'gapMsDescSoop'].every((k) => zh.includes(k) && en.includes(k)), 'D45za 四句分平台文案双语齐(D9 只保证键集合相等, 这一条保证真的各写各的事)')
  assert(
    /soopNa:/.test(zh) && /soopNa:/.test(en) && /t\('settings\.soopNa'\)/.test(sv),
    'D45zb 决策④的口径原样保留: SOOP 那一节仍只报不改(官方无对应机制), 分家这一刀没顺手把它做成假开关'
  )
}

// ============================================================================
// D46 首轮未落地时顶栏胶囊只报间隔 (2026-10-01 真机复验查出)
//   SOOP 关注列表 TLS 断连后降级逐房扫 718 位(约 20 分钟一轮), 那 20 分钟里胶囊一直读「60s · 0 毫秒」——
//   roundMs 的初值 0 不是"上一轮花了多久", 它是"还没量过"; 把它报出去等于替一件没发生的事签字。
//   判据同: 结构性没有的那一格不摆行 —— 没量过就只报间隔, tooltip 里那句「上次拉取耗时」一起省略。
// ============================================================================
{
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const lzh = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts')))
  const len = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts')))
  assert(/const first = w\.lastRoundAt === null/.test(nav), 'D46a 胶囊先问"首轮落地没有"再决定报不报耗时(判据是 lastRoundAt, 不是 roundMs 的真假)')
  assert(/first \? t\('nav\.wHeartFirst', \{ sec: interval \}\) : t\('nav\.wHeart', \{ sec: interval, cost \}\)/.test(nav), 'D46b 首轮那一档的胶囊文本只带 {sec}, 耗时那一截整块省略')
  assert(/first \? t\('nav\.wTipFirst', \{ sec: interval \}\) : t\('nav\.wTip', \{ sec: interval, cost \}\)/.test(nav), 'D46c tooltip 走同一道闸门: 冷却与失败两档共用这一个 heartbeat, 首轮都不许说"上次耗时"')
  assert('nav.wHeartFirst' in lzh && 'nav.wHeartFirst' in len && ph(lzh['nav.wHeartFirst']) === 'sec' && ph(len['nav.wHeartFirst']) === 'sec', 'D46d wHeartFirst 双语齐且占位符只有 {sec}(这一格里再没有第二个字段可以撒谎)')
  assert('nav.wTipFirst' in lzh && 'nav.wTipFirst' in len && !/\{cost\}/.test(lzh['nav.wTipFirst'] + len['nav.wTipFirst']), 'D46e wTipFirst 双语齐且不含 {cost}')
  assert(/nav\.wHeart', \{ sec: interval, cost \}/.test(nav) && /nav\.wTip', \{ sec: interval, cost \}/.test(nav), 'D46f 首轮之后的读数没被牵连(带耗时的两句话照旧在位)')
}

// ============================================================================
// D47 模板结构必须当场编译得通过 (2026-10-01 复查)
//   撤「监控」导航档时连带删掉了 svg 分支链的头一枚, v-else-if 失去相邻 v-if —— 十套脚本与两路 tsc 全绿, 直到 npm run build 才炸,
//   而 build 既不在 typecheck 链也不在 verify 链, CI 也只跑那两条。这一条把"模板还编译得过吗"变成日常断言, 不再等打包。
// ============================================================================
{
  const { parse, compileTemplate } = createRequire(import.meta.url)('vue/compiler-sfc')
  const vues = walk(R('src', 'renderer', 'src'), /\.vue$/)
  const broken = []
  for (const f of vues) {
    const src = fs.readFileSync(f, 'utf8')
    const { descriptor, errors } = parse(src, { filename: f })
    if (errors.length) {
      broken.push(`${rel(f)}: 解析失败 ${errors[0].message}`)
      continue
    }
    if (!descriptor.template) continue
    const res = compileTemplate({
      source: descriptor.template.content,
      filename: f,
      id: path.basename(f),
      scoped: descriptor.styles.some((s) => s.scoped)
    })
    if (res.errors.length) broken.push(`${rel(f)}: ${res.errors.map((e) => e.message || String(e)).join(' | ')}`)
  }
  // 探测器本身必须先证明会咬人: 否则"零错误"可能只是"什么都没检查"
  const probe = compileTemplate({ source: '<div><i v-if="a">x</i><b v-else-if="b">y</b></div><i v-else>z</i>', filename: 'probe.vue', id: 'probe' })
  assert(probe.errors.length > 0 && /v-else|v-if/.test(probe.errors.map((e) => e.message).join(' ')), 'D47a 变异自检: 断链的 v-else 必须被这套探测判为错误')
  assert(vues.length >= 20, 'D47b 普查覆盖渲染层每个 .vue', `命中 ${vues.length} 个`)
  assert(broken.length === 0, 'D47c 现存模板零编译错误(结构错误不再只有 build 才炸)', broken.join('\n         '))
}

// ============================================================================
// D48 store 的 getter 普查 (2026-10-01 复核: store.offlineAnchors 全仓零消费者, 按 「无消费方即删」撤除)
//   它与那次撤坞是同一条规则的两种尺寸。getter 是四处残骸里最安静的一种: 没人调用也就不出错, 只在 store 里替一个已经不存在的界面占着名额。
// ============================================================================
{
  const appFile = R('src', 'renderer', 'src', 'stores', 'app.ts')
  const appSrc = fs.readFileSync(appFile, 'utf8')
  const strip = (s) => s.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const gi = appSrc.indexOf('getters: {')
  const body = appSrc.slice(gi, appSrc.indexOf('actions:', gi))
  const names = [...body.matchAll(/^ {4}([A-Za-z_]\w*):/gm)].map((m) => m[1])
  const others = RENDERER.filter((f) => path.resolve(f) !== path.resolve(appFile)).map((f) => strip(fs.readFileSync(f, 'utf8')))
  const dead = []
  for (const n of names) {
    // store 内部自引用也算消费者, 但要先抹掉它自己的定义那一行
    const selfRefs = strip(appSrc).replace(new RegExp(`^ {4}${n}:`, 'm'), '       :')
    const used = others.some((t) => new RegExp(`\\b${n}\\b`).test(t)) || new RegExp(`\\b${n}\\b`).test(selfRefs)
    if (!used) dead.push(n)
  }
  assert(names.length >= 5, 'D48a 普查解析到合理数量的 getter(少于 5 个说明解析器瞎了, 而不是真没有死键)', `names=${names.length}`)
  assert(dead.length === 0, 'D48b 每个 getter 都真有消费者(零消费者的死 getter 一律撤, 不留"以后可能用")', dead.join(', '))
  const remnants = SRC_ALL.filter((f) => /offlineAnchors/.test(fs.readFileSync(f, 'utf8')))
  assert(remnants.length === 0, 'D48c offlineAnchors 整体绝迹(定义与调用一处不留)', remnants.map(rel).join(', '))
}

// ============================================================================
// D49 时长单位: 同一个量只有一套读法 (2026-10-01 复核)
//   两枚胶囊一个报「666 毫秒」一个报「8.6 秒」不是精度差异, 是 TopNav 里按数量级换单位 + 设置页另写一套 ms 的结果:
//   同一屏两枚同族胶囊先比单位再比快慢, 读的人第一眼看错了对象。耗时恒按秒(一位小数), 格式化收在 fmtRoundCost 一处。
//   另一头是语境: 节流 300 毫秒、分段 15 分钟、熔断 3 分钟、开播 2:14:07 —— 换秒只会把数字变长变碎, 那些格子不许被顺手统一。
// ============================================================================
{
  const media = fs.readFileSync(R('src', 'renderer', 'src', 'utils', 'media.ts'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const sv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const zhSrc = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const enSrc = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  const lzh = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts')))
  const len = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts')))
  // ① 格式化只有一个出处
  assert(/export function fmtRoundCost\(ms: number\): string \{\s*return \(Math\.max\(0, ms\) \/ 1000\)\.toFixed\(1\)/.test(media), 'D49a fmtRoundCost 是唯一的"毫秒→秒"出处: 除以 1000 且固定一位小数(亚秒档的分辨率靠小数保住, 不靠换单位)')
  assert(/const cost = fmtRoundCost\(w\.roundMs\)/.test(nav) && /from '@\/utils\/media'/.test(nav), 'D49b 胶囊的耗时取 fmtRoundCost, 不再就地分档')
  assert(!/roundMs\s*<\s*1000/.test(nav) && !/\$\{w\.roundMs\}/.test(nav) && !/ms: soopStatus\.roundMs/.test(sv), 'D49c 两处消费点都没有第二套换算: 曾经分家的写法(按数量级换单位 / 裸 ms 直出)不得回来')
  assert(/t\('settings\.soopRound', \{ cost: fmtRoundCost\(soopStatus\.roundMs\)/.test(sv), 'D49d 设置页那行与胶囊同出处: 同一个 roundMs 在两屏上必须是同一个单位的同一个数')
  // ② 中文那一格不再混拉丁单位
  assert(/wHeart: '\{sec\} 秒 · \{cost\} 秒'/.test(zhSrc) && /wHeartFirst: '\{sec\} 秒'/.test(zhSrc), 'D49e 中文胶囊两处单位都是「秒」: 一枚胶囊里不再 {sec}s 与 毫秒/秒 并存')
  assert(/wHeart: '\{sec\}s · \{cost\}s'/.test(enSrc) && /last round took \{cost\}s/.test(enSrc), 'D49f 英文那一格保持拉丁 s 且耗时自带单位(fmtRoundCost 交的是裸数, 单位词归文案)')
  assert(ph(lzh['nav.wHeart']) === 'cost,sec' && ph(len['nav.wHeart']) === 'cost,sec', 'D49g {cost} 双语都仍在胶囊那句里(单位进文案不能顺手把字段挤掉)')
  assert(/segInterval: '检测间隔 \{sec\} 秒'/.test(zhSrc) && /kaOn: '[^']*心跳 \{s\} 秒前'/.test(zhSrc), 'D49h 同族的两处中文读数一起改口: 工作区「检测间隔」与播放页「心跳 …前」不再各挂一个拉丁 s')
  assert(/t\('ws\.segInterval', \{ sec:/.test(wv) && /t\('player\.kaOn', \{ s,/.test(pv), 'D49i 改的是单位词不是数据源: 两处的占位符与调用方给的值原样不动')
  // ③ 死键跟着死
  assert(!('common.ms' in lzh) && !('common.sec' in lzh) && !('common.ms' in len) && !('common.sec' in len) && !/common\.ms|common\.sec/.test(nav + sv + pv + wv), 'D49j common.ms / common.sec 双语键与调用四处一起绝迹(唯一消费方已改口, 无消费方即删)')
  // ④ 语境例外不许被下一次"统一"顺手抹平
  const exceptions = [
    ['settings.gapMs', '单请求节流(毫秒)'],
    ['settings.splitSec', '分段时长(秒)'],
    ['player.segN', '{n} 分钟'],
    ['rec.segInfo', '分段 {min} 分钟/段'],
    ['player.fetchedAgoMin', '{n} 分前'],
    ['ws.segRoundAt', '上轮拉取 {time}']
  ]
  const stillZh = exceptions.filter(([k, want]) => lzh[k] !== want)
  assert(stillZh.length === 0, 'D49k 该留毫秒/分钟/钟面的格子原样在位: 节流 300 毫秒、分段按分钟、旧读数按钟面 —— 秒不是万能单位', stillZh.map(([k]) => `${k}=${lzh[k]}`).join(', '))
  assert(/export function fmtDurHMS\(sec: number\)/.test(media) && /const s = Math\.max\(0, Math\.round\(\(kaNow\.value - k\.lastAt\) \/ 1000\)\)/.test(pv), 'D49l 长时长仍走 h:mm:ss, 心跳那格本来就是整秒计数(它们不在这一格改动面内)')
}

// ============================================================================
// D50 排序档的排面与默认 (2026-10-01 用户指令「直播界面筛选顺序，最新开播和人气最高这2个位置进行交换」→「修改后默认还是在最新开播筛选态，应该变更为人气最高」)
//   两视图的 base 两档同序(人气最高在前), 而默认档跟着首位走: 冷启动第一眼的排序 = 左手第一格。
//   锁"同序"是因为同一个词在两视图落在不同格子会被读成两个档位; 锁"默认=首位"是因为这两件事一旦分家,
//   用户换了序却发现开箱还是旧档, 只会以为没改。
// ============================================================================
{
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const appSrc = fs.readFileSync(R('src', 'renderer', 'src', 'stores', 'app.ts'), 'utf8')
  const baseOf = (name) => {
    const i = wv.indexOf(`const ${name} = computed`)
    if (i < 0) return null
    // 必须在这一段 computed 内取到 base: 不设边界时前一段找不到会顺手读到后一段的 base, 假绿
    const end = wv.indexOf('\n})', i)
    const m = /const base: \{ key: SortKey; label: string \}\[\] = \[([\s\S]*?)\]/.exec(wv.slice(i, end))
    return m ? [...m[1].matchAll(/key: '(\w+)'/g)].map((x) => x[1]) : null
  }
  const live = baseOf('liveSorters')
  const disc = baseOf('discSorters')
  assert(live && disc, 'D50a 两视图的 base 档位块都解析得到(解析器瞎了不许冒充"顺序一致")', `live=${JSON.stringify(live)} disc=${JSON.stringify(disc)}`)
  assert(!!live && !!disc && live.join(',') === 'viewers,recent' && disc.join(',') === live.join(','), 'D50b 在播关注与站内发现的头两档同序: 人气最高在前、最新开播在后(交换的是排面, 不是各自的排序实现)', `live=${JSON.stringify(live)} disc=${JSON.stringify(disc)}`)
  assert(/views: \{ live: newFilter\('viewers'/.test(appSrc), 'D50c 在播关注的默认已是 人气最高(2026-10-01 用户指令改口: 换序就要连默认一起换, 冷启动第一眼不再读旧档)')
  // 默认档必须解析得到, 且与那一排的第一格同名 —— 首位与默认分家的形状从此站不住
  const defs = [...appSrc.matchAll(/(live|discover|offline): newFilter\('(\w+)'/g)]
  const dflt = Object.fromEntries(defs.map(([, v, k]) => [v, k]))
  assert(
    !!live && !!disc && Object.keys(dflt).length === 3 && dflt.live === live[0] && dflt.discover === disc[0],
    'D50d 在播/发现两视图的默认档就是各自第一格(解析到三份默认才许判), 默认与首位不许各说各话',
    JSON.stringify(dflt)
  )
}

// ============================================================================
// D51~D53 Panda 轮询换真值源 + 大厅改按需 (2026-10-02 分析指令「保证时效性的同时尽可能避免风控触发」→ 实测后开工)
//   实测基线: 158 关注 = 1 发 /v1/live/bookmark / 90KB; 全站榜那条 = 4 页 / 403KB + 每轮扫一遍离线关注。
//   所以 list 模式的真值源换成站内关注列表(请求面与全站热度无关), 全站榜退回它本来的职责(大厅, 用户
//   真的站在发现页才拉)。这三条契约锁的是"换源不换语义": 读不到必须回落而不是判全员下播、下播仍要两轮、
//   匿名不发注定失败的那一发、没证明过的会话先问一句 login_info(冷启动不整轮落回四页)
//   —— 以及大厅不再被 watchMode 牵着走。
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const pl = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const seg = (decl) => {
    const i = wt.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  }
  assert(/const riskHold = api\.oracleRiskCooling\(\)\s*\r?\n\s*const viaBookmark = await this\.roundByBookmark\(anchors, riskHold\)/.test(wt) && /if \(viaBookmark === null && riskHold\) \{[\s\S]{0,340}return\s*\r?\n\s*\}[\s\S]{0,60}if \(viaBookmark === null\) \{[\s\S]{0,200}this\.pandaLiveFound = await this\.roundByList\(anchors\)/.test(wt), 'D51a list 模式先问站内关注列表, 只有"读不到(null)"才回落全站榜 —— 绝不把没读到当成就没人播。 回落那一支多一道风控闸: 这一站正拦着我(冷却账未到)时"读不到"不是"换个更贵的问法"的理由, 旧写法把它当扳机 ⇒ 同一轮改打 5 页全站榜 + 逐房复查 + 间隙泵约 100 发 = 现场量级 ≈110 发/轮。 这道闸读的是"整表那一发自己被拒"那一格, 不是总账')
  const bm = seg('private async roundByBookmark(')
  assert(bm.length > 0 && !/fetchLivePage|roundByList/.test(bm), 'D51b 预言机自己一页全站榜都不发(它只覆盖"我关注的人", 请求面与全站热度无关)', bm.slice(0, 60))
  assert(/if \(!api\.hasSession\(\)\) \{[\s\S]{0,120}return null/.test(bm), 'D51c 匿名(罐里没有会话)不发这一发(实测必回 result:false, 每轮白掷)')
  assert(/if \(!api\.cookieValid\) \{[\s\S]{0,600}await api\.checkLoginInfo\(\)[\s\S]{0,400}api\.cookieValid = true/.test(bm), 'D51g 「罐在但没证明」先问一句 login_info 再决定(30 秒缓存在飞合并): 冷启动第一轮不该因为一个初值 false 就整轮落回全站榜四页 —— 真机实测过这个坑')
  assert(/this\.pandaOracle = 'list'[\s\S]{0,200}return null/.test(bm) && /this\.pandaOracle = 'bookmark'/.test(bm), 'D51d 两条链各归各的账(轮次日志据此判本轮是"1 发问完 158"还是"真的看过全站")')
  // 边界必须收在这一个方法体内: `if (n < 2)` 在 SOOP 那两轮里各出现一次, 不设界会把它们当本条的证据(变异测试实测)
  const mo = seg('private markPandaOffline(')
  assert(mo.length > 0 && /const pending = this\.offlinePending\(a\)/.test(mo) && /if \(!pending\) \{\s*store\.updateAnchor\(a\.platform, a\.userId, \{ offlinePendingAt: now \}\)/.test(mo) && (mo.match(/this\.onLiveEnd\(a\)/g) || []).length === 1 && /offlinePendingAt: 0 \}\)\)\s*this\.onLiveEnd\(a\)/.test(mo), 'D51e 预言机报下播仍要两轮才翻转(单轮读数不发通知、不停播、不作废旧源); 第一轮那一格写在锚点行上 ⇒ 重启后那一轮还在, onLiveEnd 全函数只有一处且只在确认支', `onLiveEnd=${(mo.match(/this\.onLiveEnd\(a\)/g) || []).length}`)
  assert(/async fetchBookmarks\(\)[\s\S]{0,400}const limit = 200/.test(pl), 'D51f 站内关注一发 limit=200 = 官方上限(实测 158 条一发收满, 分页留作上限被抬高的保险)')
}
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const pre = fs.readFileSync(R('src', 'preload', 'index.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const seg = () => {
    const i = wt.indexOf('async refreshDiscovery(')
    return i < 0 ? '' : wt.slice(i, bodyEnd(wt, i))
  }
  const rd = seg()
  assert(rd.length > 0, 'D52a 大厅有独立的按需刷新入口(轮询不再是全站榜的唯一发车人)')
  assert(/const since = Date\.now\(\) - this\.status\.discoveryAt\s*if \(!force && since < 60_000\)/.test(rd), 'D52b 60 秒内的快照直接复用: 来回切视图/翻页/搜索不再各打一遍官网四页(force 只豁免这一条, 8 秒下限见 D67)')
  assert(/circuitOpen \|\| Date\.now\(\) < this\.cooldownUntil/.test(rd), 'D52c 熔断与退避期一发都不发(与间隙泵同语义), 调用方继续看旧快照')
  assert(/if \(liveMap\.size\) this\.publishDiscovery\(liveMap\)/.test(rd), 'D52d 刷新失败保留上一份快照: 一页都没取到 ≠ 全站没人播')
  assert(/if \(this\.discoveryInFlight\) return this\.discoveryInFlight/.test(rd), 'D52e 并发刷新合并在飞的那一次(不把整批页发两遍)')
  assert(!/this\.discovery = \[\]/.test(wt), 'D52f 没有任何一处再把大厅清空(旧实现用"清空"来表达"逐个模式大厅不可用", 此后大厅与 watchMode 无关)')
  assert(/discoveryRefresh\(force\?: boolean\): Promise<DiscoveryItem\[\]>/.test(ty) && /discoveryRefresh: 'discovery:refresh'/.test(ty), 'D52g ApiBridge 与通道名成对声明')
  assert(/discoveryRefresh: \(force\?: boolean\)[\s\S]{0,80}invoke\(CH\.discoveryRefresh, force\)/.test(pre), 'D52h preload 把 force 传到底(手动刷新不许在桥这一层被吞成 false)')
  assert(/CH\.discoveryRefresh[\s\S]{0,120}watcher\.refreshDiscovery\(force === true\)/.test(ipc), 'D52i IPC 侧只认 force === true(渲染层送来任何非布尔的脏值都不算"强制刷新"的通行证)')
  const pb = (() => { const i = wt.indexOf('private publishDiscovery('); return i < 0 ? '' : wt.slice(i, bodyEnd(wt, i)) })()
  assert(/this\.status\.discoveryAt = Date\.now\(\)/.test(pb) && !/this\.discoveryAt\b/.test(wt), 'D52j 大厅时刻只有一个家(status.discoveryAt): 私有一式一份的写法迟早漂移, 而渲染层读的是那份公开的')
  assert(/this\.pushDiscovery\(\)[\s\S]{0,200}this\.push\(\)/.test(pb), 'D52k 快照广播时同步推一次状态: 只有 discovery 那一条落屏、时刻却等下一轮才更新的话, 页头会显示"拉取于 上一轮"')
}
{
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  assert(/view\.value === 'discover' && !isSoop\.value\) await api\.discoveryRefresh\(true\)/.test(wv), 'D53a 发现页的手动刷新走大厅自己的入口(不再"重拉关注"绕一圈)')
  assert(/view\.value === 'discover' && !isSoop\.value\) void api\.discoveryRefresh\(\)\.catch/.test(wv), 'D53b 站到发现页就取一次快照: 全站榜不再搭轮询的车以后, 这一屏自己就是发车人')
  assert(!/gotoDetectList|emptyDiscoverPerAnchor/.test(wv + zh + en), 'D53c 「大厅在逐个模式不可用, 请切回列表模式」那句话与它的出口一起删净了(模式管的是怎么查关注, 不管大厅有没有数据)')
  assert(/站内覆盖=\$\{this\.pandaCovered\}/.test(wt) && /全站=\$\{this\.status\.liveCount\}/.test(wt), 'D53d 轮次摘要日志分家: 预言机报覆盖数, 兜底轮才报全站在播数(否则 全站= 会被读成上一份大厅快照)')
  assert(/一个请求覆盖全部关注/.test(zh) && /one bookmark-list request per round/.test(en), 'D53e 模式说明讲的是"怎么查我的关注", 双语同口径')
  assert(/列表模式每轮只发一发站内关注列表/.test(zh) && !/大厅/.test(zh.match(/pollSecDescPanda: '[\s\S]{0,200}'/)?.[0] || ''), 'D53f 轮询间隔那格的建议值跟着新真值源改口, 且不再顺带承诺大厅的有无')
  const segc = (() => { const i = wv.indexOf('const seg = computed'); return i < 0 ? '' : wv.slice(i, wv.indexOf('\n})\n', i)) })()
  const disc = (() => { const i = segc.indexOf("view.value === 'discover'"); return i < 0 ? '' : segc.slice(i, bodyEnd(segc, i)) })()
  assert(/store\.watcher\?\.discoveryAt/.test(disc) && /ws\.segHallAt/.test(disc), 'D53g 发现页那一格的时间是大厅自己的钟: 全站榜不再搭轮询的车以后, 在这屏说"上轮拉取"是把轮次的计时器借给大厅')
  assert(disc.length > 0 && !/segRoundAt|segInterval/.test(disc), 'D53h 发现页不再回落轮次时间或检测间隔(大厅没拉过就不摆时间, 不借别处的钟凑一句)')
  assert(/segHallAt: '拉取于 \{time\}'/.test(zh) && /segHallAt: 'Pulled \{time\}'/.test(en), 'D53i segHallAt 双语成对(只在发现页出现的一格, 不该留英文界面的孤儿键)')
}

// ============================================================================
// D54~D56 SOOP 降级链的三重收口(2026-10-02)
//   实测基线: 718 个 SOOP 关注, 列表整表不可用时"每房一发"= 718 发/轮 ≈ 5.7 万发/天, 且网络越坏发得越凶;
//   取流五步链的第一发整页 HTML(≈200KB)只为拿一个 nBroadNo, 而列表那一发本来就把 broad_no 全给了。
//   三条契约分别锁: 探针的每轮预算与环形轮换(D54)、SOOP 自己的退避且绝不连坐 Panda(D55)、
//   场次号复用与播放页微缓存(D56)。行为侧的对应用真源码跑请求计数(verify-playcache T24/T28、verify-follows F 段)。
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (decl) => {
    const i = wt.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  }
  const rs = seg('private async roundSoop(')
  assert(/private static SOOP_PROBE_BUDGET = 40/.test(wt) && /const budget = Watcher\.SOOP_PROBE_BUDGET/.test(rs), 'D54a 降级探针有每轮预算, 且预算只有一处定义(要改就只改一处)')
  assert(/if \(probe\.length > budget\) \{[\s\S]{0,600}this\.soopProbeCursor = 0/.test(rs), 'D54b 刀只在真超出时落, 未超即游标归零 —— "少数几个房不在列表里"这一常态与改造前一字不差')
  assert(/const start = this\.soopProbeCursor % probe\.length/.test(rs) && /sent = \[\.\.\.probe\.slice\(start\), \.\.\.probe\.slice\(0, start\)\]\.slice\(0, budget\)/.test(rs), 'D54c 切的是环形窗口而不是头一段: 本轮被挡下的房下一轮排到队首, 不会被永久饿死')
  assert(/this\.soopProbeCursor = \(start \+ budget\) % probe\.length/.test(rs), 'D54d 游标推进取模(轮完一圈回队首), 不留单调递增、迟早越界的游标')
  assert(/for \(const a of sent\)/.test(rs) && !/for \(const a of probe\)/.test(rs), 'D54e 循环只消费 sent: 预算不是日志里的装饰, 真发出去的就是那一刀')
  assert(/roundFailed = fail \+ \(probe\.length - sent\.length\)/.test(rs), 'D54f「未读到状态」的口径随预算一起改口: 发出且失败的 + 本轮被挡下的 = 顶栏/工作区那一句的 N(旧口径只数 fail, 有了预算就少报)')
  assert(/covered === 0/.test(rs) && /fail === sent\.length/.test(rs) && !/fail === anchors\.length/.test(rs), 'D54g 失明判据跟着改口(列表一个房都没覆盖 + 实际发出的全灭): 老的 fail===anchors.length 在预算下永远不成立, 留着等于"永远不会瞎"')
}
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const mi = fs.readFileSync(R('src', 'main', 'i18n.ts'), 'utf8')
  const seg = (decl) => {
    const i = wt.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  }
  const rt = seg('private async roundSoopTop(')
  const rs = seg('private async roundSoop(')
  const st = seg('start(): void {')
  assert(/if \(Date\.now\(\) < this\.soopCooldownUntil\) return/.test(rt), 'D55a SOOP 有自己的退避: 退避期整轮零请求(连列表那一发也不发) —— 失明时"每一轮都重发"的形状正是风控最忌讳的')
  assert(rt.indexOf('soopCooldownUntil) return') < rt.indexOf('this.roundSoop(') && rt.indexOf('soopCooldownUntil) return') < rt.indexOf('const sBegin'), 'D55b 门在发问与计时上游: 冷却轮既不请求也不写 lastRoundAt/roundMs(真发了才记时, 与 Panda 冷却同一把尺), 顶栏「上次拉取耗时」不被空转轮刷成刚刚')
  assert(/if \(this\.soopFailStreak >= 2\) this\.soopCooldownUntil = Date\.now\(\) \+ Watcher\.SOOP_COOLDOWN_MS/.test(rs), 'D55c 每个失明轮都重新武装(不是只有跨阈值那一次), 恢复当轮归零')
  assert(/this\.soopFailStreak = 0[\s\S]{0,80}this\.soopCooldownUntil = 0/.test(st), 'D55d 重启监控即把连败与退避一起作废: 只清一半会让新会话莫名哑五分钟')
  // 读数面只许一处出声: 退避这件事不许新造一句 key(watcher.soopDown 那句「这期间不会有 SOOP 开播通知」本就写着它)
  const soopKeys = [...new Set([...mi.matchAll(/'(watcher\.soop\w+)'/g)].map((m) => m[1]))].sort()
  assert(soopKeys.join(',') === 'watcher.soopDown,watcher.soopDownT,watcher.soopPartial', 'D55e 退避不新增第二句读数: 失明那句已在顶栏 tooltip 与工作区正文, 同一件事不在两处各说一遍', soopKeys.join(','))
  assert(!/circuitOpen/.test(rt) && !/circuitOpen/.test(rs), 'D55f SOOP 的失明只写自己那半截状态: 不推熔断位(分家), 合并 circuitOpen 恒等于 Panda, 顶栏「去登录」那颗按钮因此仍是 Panda 专供')
}
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const fp = seg(so, 'async fetchPlay(')
  const fv = seg(so, 'private async readFavorites(')
  const fb = seg(so, 'private freshBroadNo(')
  const fm = seg(so, 'async fetchPageMeta(')
  const rp = seg(so, 'private async readPageMeta(')
  assert(/const known = this\.freshBroadNo\(channel\)/.test(fp), 'D56a 取流先问一句"这一场的号我是不是已经有了"(列表整表白送 broad_no, 不用等于扔掉)')
  assert(/if \(r\.live\) this\.bnoCache\.set\(r\.userId, \{ bno: r\.live\.broadNo, at: Date\.now\(\) \}\)/.test(fv) && /else this\.bnoCache\.delete\(r\.userId\)/.test(fv), 'D56b 关注列表那一发顺手播种场次号, 而列表改口说离线就当场作废 —— 号是这一场的钥匙, 不是这个房的门牌')
  assert(/Date\.now\(\) - hit\.at >= SoopApi\.BNO_TTL/.test(fb) && /this\.bnoCache\.delete\(channel\)/.test(fb), 'D56c 号过期=当没读到过并删掉(不供成永久, 也不带着旧号白撞整链)')
  assert(/const meta = await this\.fetchPageMeta\(channel\)\s*return this\.runPlayChain\(channel, password, meta(, fullVariants)?\)/.test(fp), 'D56d 手里没号才读整页: 既有那条链路一字不动地留着(降级路径没被换掉, 只是不再是唯一路径; 只多带一个档级参数)')
  assert(/if \(r\.ok \|\| r\.needPassword \|\| r\.needLogin\) return r/.test(fp), 'D56e 成功/要密码/要登录三类答案与场次号无关 → 原样回报, 不为它们多读一页')
  assert(/this\.bnoCache\.delete\(channel\)[\s\S]{0,250}this\.fetchPageMeta\(channel, false, false, '取流复查'\)/.test(fp), 'D56f 只有真失败才回读整页定性: 那一发不再是 fresh —— 它问的是"这一页怎么说", 而十秒内刚读过的那一页(pageCache 由探针/上一条链写入)就是最新读数, 旧写法把微缓存与在途合并一并绕过 ⇒ 同一间房几秒内被买两页整页 HTML')
  assert(/if \(!m\.living \|\| m\.broadNo !== known\) return this\.runPlayChain\(channel, password, m(, fullVariants)?\)\s*return r/.test(fp), 'D56g 页面说没在播或给了新号才重走一次, 号还对得上就原样回报 —— 复用的代价上界恒为 1 页 + 1 次整链, 不会滚成三次五步(重走时档级沿用 caller 要的那一份)')
  assert(/soopApi\.fetchPageMeta\(a\.userId, true, true, '探针'\)/.test(wt), 'D56h 轮询探针以 fresh 取页: 它就是"这房现在怎么样"的裁判, 而最短一档 5 秒比页面 TTL 还小, 缓存会把两轮读成同一份页')
  assert(/if \(!fresh\) \{[\s\S]{0,120}const hit = this\.pageCache\.get\(channel\)/.test(fm) && /if \(!fresh\) this\.pageInflight\.set\(channel, p\)/.test(fm), 'D56i fresh 同时绕过微缓存与在飞合并: 探针既不该拿旧页, 也不该把自己并进别人那一发的结果里')
  assert(/this\.pageCache\.set\(channel, \{ at: Date\.now\(\), meta \}\)/.test(rp) && /this\.pageCache\.size > 64/.test(rp), 'D56j 页面缓存只在真读到以后写, 且带 64 条上限(先清过期再截断, 不随关注数无界增长)')
  assert(/if \(meta\.living && meta\.broadNo\) this\.bnoCache\.set\(channel, \{ bno: meta\.broadNo, at: Date\.now\(\) \}\)/.test(rp), 'D56k 页面实读到的号同样进缓存(连击型取流第二次就不再读页), 但"在场且给得出号"才进 —— 离线/读数不足的一页不播种')
}

// ============================================================================
// D57~D60: 结构性重复与扇出护栏
//   同类病灶都是"同一次意图被两条链各自实现"或"作废与在飞没有先后关系":
//     作废只删了缓存, 没管在飞的链 → 缓存复活(= 已下播/已换号的房还能秒开)
//     意外退出先拉一次判活, 续录再拉一次 → 源最抖的时刻打两条完整链, 且零退避
//     全站榜翻页在轮询兜底与大厅刷新里各写了一遍 → 同时启动即翻两趟四页
//     会话判死期每轮白问一句 login_info(它的 30 秒缓存短于轮询间隔)
//     「立即刷新」没有下限: 人手连点即人手放大整站请求面
//   行为侧由 verify-playcache T29~T33 与 verify-follows G1~G4 用真源码数请求, 这里锁形状与"只有一处"。
// ============================================================================
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pa = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const src = R('src', 'main', 'services', 'source.ts')
  const si = fs.readFileSync(src, 'utf8')
  // 本仓库三个文件是 CRLF: 段尾必须按 \r?\n 找, 否则窗口一路开到文件末尾(锁等于没锁)
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const m = /\r?\n {2}\}\r?\n/.exec(s.slice(i))
    return s.slice(i, m ? i + m.index + m[0].length : undefined)
  }
  const count = (s, re2) => (s.match(re2) || []).length
  const trio = (s, id) =>
    count(s, /private playEpoch = new Map<string, number>\(\)/g) === 1 &&
    count(s, /private playEpochAll = 0/g) === 1 &&
    new RegExp(`private epochOf\\(${id}: string\\): number \\{[\\s\\S]{0,120}this\\.playEpochAll \\+ \\(this\\.playEpoch\\.get\\(${id}\\)`).test(s) &&
    new RegExp(`private bumpEpoch\\(${id}: string\\)`).test(s)
  assert(trio(so, 'channel') && trio(pa, 'userId'), 'D57a 纪元三件套在两平台各只有一套定义(逐房纪元 + 整表纪元): 换号那一档靠整表前移, 不靠逐房补刀')
  assert(
    /if \(r\.ok && this\.epochOf\(channel\) === e0\)/.test(so) && /if \(r\.ok && this\.epochOf\(userId\) === e0\)/.test(pa),
    'D57b 缓存写入受纪元门管: 这条链出发后被作废过, 结果照还给调用方但不许把源写回来'
  )
  for (const [name, s, id] of [['soop', so, 'channel'], ['panda', pa, 'userId']]) {
    const g = seg(s, `async getPlayCached(${id}`)
    assert(g.includes('const e0 = this.epochOf(') && g.includes('const p = (async') && g.indexOf('const e0 = this.epochOf(') < g.indexOf('const p = (async'), `D57c-${name} 纪元在链出发前取快照: 出发之后再取, 等于承认任何作废都晚于自己`)
    assert(/=== e0\)[\s\S]*?\breturn r\b[\s\S]*?\} finally/.test(g), `D57d-${name} 被挡下的那一发仍然 return r(门只管缓存, 不管给调用方答案): return r 必须落在纪元门与 finally 之间 —— 在那两者之间插了「强制重取没拿到源就当场作废」那一支, 判据按块位置而不按字数窗口`)
    // 改判: SOOP 多出第三处写入口 = 源留存复活(promoteStoredPacks)。它写的不是"某条链的结果"
    // 而是"上一次退出前那一包 + 本轮列表同号"这两句真值, 且逐间重判 playCache.has(不许覆写更新的源)。
    // 第三处必须钉在 promoteStoredPacks 里面 —— 别处再冒出一个写入口照样红
    const sets = (s.match(/this\.playCache\.set\(/g) || []).length
    const thirdIsPromote = name !== 'soop' || /private async promoteStoredPacks[\s\S]*?this\.playCache\.set\(channel,/.test(s)
    assert(sets === (name === 'soop' ? 3 : 2) && thirdIsPromote, `D57e-${name} 全文件的 playCache.set 只许是「纪元门 + seedPlay(+ SOOP 的源留存复活)」这几处: 不许有第四个写入口(缓存复活只能走这三道门)`, `实数=${sets} 第三处位置合规=${thirdIsPromote}`)
  }
  const invSo = seg(so, 'invalidatePlay(channel: string): void {')
  const invPa = seg(pa, 'invalidatePlay(userId: string): void {')
  assert(/this\.bumpEpoch\(channel\)/.test(invSo) && /this\.bumpEpoch\(userId\)/.test(invPa), 'D57f 显式作废即纪元 +1(顺序上先抬纪元再删缓存, 免得删与抬之间挤进一条链)')
  assert(
    /for \(const pw of \[('', )?'#pw'[^\]]*\]\)[\s\S]{0,60}for \(const fan of \[[^\]]*'#top'[^\]]*\]\)[\s\S]{0,60}this\.playInflight\.delete\(/.test(invSo) &&
      /this\.playInflight\.delete\(userId\)[\s\S]{0,60}this\.playInflight\.delete\(userId \+ '#pw'\)/.test(invPa),
    'D57g 在飞键的每一种形状(裸房 / 房#密码槽 / 再加档级槽)作废时都必须摘净: 留一半 = 让新 caller 合进一条注定作废的链'
  )
  assert(
    /playEpochAll\+\+[\s\S]{0,120}this\.playCache\.clear\(\)[\s\S]{0,160}this\.playInflight\.clear\(\)/.test(seg(so, 'clearPlayCache(): void {')) &&
      // 门槛账的盘上那一格也在这条清账链上(gates.clear 之后、在飞清之前), 顺序就是"旧账号的一切先落地"
      /playEpochAll\+\+[\s\S]{0,120}this\.playCache\.clear\(\)[\s\S]{0,160}this\.keepaliveInfo\.clear\(\)[\s\S]{0,140}this\.gates\.clear\(\)[\s\S]{0,420}gateCode: '', gateUntil: 0[\s\S]{0,240}this\.playInflight\.clear\(\)/.test(seg(pa, 'clearPlayCache(): void {')),
    'D57h 换号/登出那一条: 整表纪元前移 + 缓存与在飞一起清(Panda 还带保活台账与门槛账的落盘格) —— 旧账号签发的源与旧账号那本"过不去"的账一枚都不许留下'
  )
  assert(
    /seedPlay\(channel: string, pack: PlayResult\): void \{\s*if \(!pack\.ok\) return/.test(so) &&
      /seedPlay\(userId: string, pack: PlayResult\): void \{\s*if \(!pack\.ok\) return/.test(pa) &&
      /seedPlay\(id: string, pack: PlayResult\): void/.test(si),
    'D57i 种子入口在三处对齐(契约 + 两平台实现), 且只认真源: ok=false 的包不许进缓存'
  )
}
{
  const rc = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const seg = (declRe) => {
    const m = declRe.exec(rc)
    if (!m) return ''
    const e = /\r?\n {2}\}\r?\n/.exec(rc.slice(m.index))
    return rc.slice(m.index, e ? m.index + e.index + e[0].length : undefined)
  }
  const hx = seg(/private async handleUnexpectedExit\(/)
  assert(
    !/\.fetchPlay\(/.test(hx) && /sourceFor\(this\.platform\)\.getPlayCached\(this\.userId, this\.password, true, false\)/.test(hx),
    'D58a 改口: 判活仍然现拉(第 3 参 true = 永不读缓存, 缓存里就是正在死的那一条, 原话不变), 但第 4 参 false 只解最高档 —— 旧写法直调 fetchPlay 把整张菜单买完(SOOP 实测 8~10 发), 而录制从来只用最高那一路'
  )
  assert(
    hx.includes('if (stillLive)') && hx.includes('this.freshSeed = play') && hx.indexOf('if (stillLive)') < hx.indexOf('this.freshSeed = play') && (rc.match(/this\.freshSeed = /g) || []).length === 1,
    'D58b 只有"还在播=中断"这一支留种子: 真下播那一支留给缓存的东西就是一个死源'
  )
  assert(/recorder\.maybeRetry\(\s*\{[\s\S]{0,320}?this\.freshSeed\s*\)/.test(rc), 'D58c 种子随失败收尾一起交给续录(finalize 已经作废过旧源, 这一发比它新)')
  const mr = seg(/\r?\n {2}maybeRetry\(/)
  assert(/if \(seed\?\.ok\) sourceFor\(prev\.platform\)\.seedPlay\(prev\.userId, seed\)/.test(mr), 'D58d 续录前先把种子种回: 新任务命中缓存即不再打第二条完整链')
  assert(/private static RETRY_BACKOFF_MS = 10_000/.test(rc) && /const delay = Recorder\.RETRY_BACKOFF_MS \* 2 \*\* \(streak - 1\)/.test(mr), 'D58e 退避按连续失败次数指数增长(上一条链刚死就立刻再打一条, 等于在源最抖的时刻把扇出打满)')
  assert(/setTimeout\(\(\) => \{[\s\S]{0,420}\}, delay\)/.test(mr), 'D58f 退避真作用在重排上(delay 是唯一的延后来源)')
  assert(/private retryTimers = new Map<string, NodeJS\.Timeout>\(\)/.test(rc) && /this\.retryTimers\.set\(\s*key,/.test(mr), 'D58g 计时器按房挂键: 两个房先后失效不得互相顶掉退避')
  assert(!/\.cancel\(\)/.test(rc) && (rc.match(/clearTimeout/g) || []).length >= 4, 'D58h 计时器一律 clearTimeout 撤(本仓库 TS lib 的 NodeJS.Timeout 没有 .cancel), 撤不掉的退避就是幽灵起录')
  assert(/if \(this\.shuttingDown\) return[\s\S]{0,200}void this\.start\(/.test(mr), 'D58i 到点那一下再问一次"还在关机流程里吗"(stopAll 与在飞退避之间有窗口)')
  assert(/if \(!opt\.auto\) \{[\s\S]{0,140}clearTimeout\(pend\)/.test(seg(/async start\(opt: StartRecOptions\)/)), 'D58j 用户手动接管 = 这条房不再欠一次自动续录(否则定时器会在手动任务收尾后再自作主张开录)')
  assert(/for \(const t of this\.retryTimers\.values\(\)\) clearTimeout\(t\)/.test(seg(/async stopAll\(\)/)), 'D58k 退出流程清空所有在等退避的计时器')
}
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const mi = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  const seg = (decl) => {
    const i = wt.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  }
  const hp = seg('private async harvestPages(')
  const rd = seg('async refreshDiscovery(')
  const rl = seg('private async roundByList(')
  assert(
    (wt.match(/api\.fetchLivePage\(/g) || []).length === 1 && hp.indexOf('api.fetchLivePage(') >= 0,
    'D59a 全站榜翻页在 watcher 里只有一处实现: 轮询兜底与大厅刷新各写一遍是同一条链的两次四页'
  )
  assert(/if \(this\.pageHarvest\) return this\.pageHarvest/.test(hp) && /if \(this\.pageHarvest === p\) this\.pageHarvest = null/.test(hp), 'D59b 在飞锁: 先来者翻页, 后来者合流; 撒锁按身份比(不许把下一批也并进上一批的尾巴)')
  assert(/return \{ liveMap, loginInfo, err: e \}/.test(hp) && /if \(err\) throw err/.test(rl), 'D59c 同一发请求两种吃法: 错不抛而是连着已翻到的部分带回, 由调用方决定"沿用旧快照"(大厅)还是"本轮失败"(轮次 —— 部分页不许冒充成功)')
  assert(/if \(err\) logger\.warn\('watcher', `大厅刷新失败, 沿用上一份快照/.test(rd) && /if \(liveMap\.size\) this\.publishDiscovery\(liveMap\)/.test(rd), 'D59d 大厅失败不空表也不改钟(读到多少算多少, 一页都没有就原样留着)')
  assert(/if \(r\.loginInfo\) loginInfo = r\.loginInfo/.test(hp), 'D59e 会话证据取"最后一个非空"的那页(旧写法取最后一页: 末页没带就等于没带)')
  const bm = seg('private async roundByBookmark(')
  assert(/private static LOGIN_PROBE_COOL_MS = 5 \* 60_000/.test(wt) && bm.includes('Date.now() < this.pandaProbeUntil') && bm.includes('await api.checkLoginInfo()') && bm.indexOf('Date.now() < this.pandaProbeUntil') < bm.indexOf('await api.checkLoginInfo()'), 'D59f 判死态下那一问有 5 分钟退避, 且门在发问上游(login_info 自己 30 秒缓存短于轮询间隔 = 每轮白付一发)')
  assert(/if \(!info\.netFail\) this\.pandaProbeUntil = Date\.now\(\) \+ Watcher\.LOGIN_PROBE_COOL_MS/.test(bm), 'D59g 只有服务端明确"没登录"才武装退避: netFail(断网/风控)是读不到, 不是判死, 下一轮照问')
  assert(/this\.pandaProbeUntil = 0/.test(seg('start(): void {')) && (() => { const s = seg('start(): void {'); const i = s.indexOf('this.pandaProbeUntil = 0'); const j = s.indexOf('this.schedule(p, 300)'); return i >= 0 && j > i })(), 'D59h 重启监控即撤退避(冷启动第一轮照旧问一次, 那道门不因 而退) —— 只按先后次序判, 不锁字符距离: 在两者之间写进了 roundCnt 归零那三行, 距离一锁就被注释长短牵着走')
  const tk = seg('tick(platform?: Platform)')
  assert(/private static TICK_MIN_MS = 8_000/.test(wt) && /if \(L\.lastAt && since < Watcher\.TICK_MIN_MS\)/.test(tk), 'D59i 「立即刷新」有每平台 8 秒下限: 正常态一轮=一发整站列表, 连点即人手放大请求面; 刚落地一轮时再点本来也读不到新东西')
  assert(
    /if \(L\.lastAt && since < Watcher\.TICK_MIN_MS\) \{[\s\S]{0,240}?continue\s*\}/.test(tk) && /立即刷新节流/.test(tk),
    'D59j 被挡下的那一下有出声(节流不能长成"按钮坏了"), 且挡下即从节流那一格里 continue, 不再排程'
  )
  const ps = seg('private prewarmSweep(platform: Platform)')
  assert(/const cached = new Set\(sourceFor\(platform\)\.cachedSourceIds\(\)\)/.test(ps) && /!cached\.has\(roomKey\(platform, a\.userId\)\)/.test(ps), 'D59k 补扫跳过手上已有有效源的房(事实源就是卡片徽标那一枚, 不另立一本账)')
  assert(/if \(!store\.getSettings\(\)\.monitor\[platform\]\.prefetchStream\) return/.test(ps) && /a\.platform === platform && a\.isLive && !this\.isGone\(a\)/.test(ps), 'D59l 补扫读的是本平台那一格, 且只认真值: 库里 isLive 而本轮已判离线/查无此人的房一枚不排(开机群发那一段就是这么废掉的)')
  assert(!/prewarmNow\(a\.platform/.test(mi), 'D59m index.ts 里那段"按库态逐个 prewarm"已连循环一起撤(改由首轮后的补扫做), 不留第二处开机预取')
}
{
  const rc = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const st = fs.readFileSync(R('src', 'main', 'services', 'store.ts'), 'utf8')
  assert(
    /const LOOPBACK_RE = \/\^https\?:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]\)\(:\|\\\/\)\/i/.test(rc) &&
      /if \(cfg\.proxyUrl && !LOOPBACK_RE\.test\(m3u8\)\) args\.push\('-http_proxy', cfg\.proxyUrl\)/.test(rc),
    'D60a 录制取的是本机 HLS 代理地址时绝不走用户代理: 回环地址若被 -http_proxy 接走, 分片会绕外网再绕回来(轻则断流重则整段坏包)'
  )
  {
    const i = st.indexOf('for (const k of [')
    const j = st.indexOf('])', i)
    const keys = st.slice(i, j).split(/[\r\n]+/).map((l) => (l.match(/^\s*'(\w+)'/) || [])[1]).filter(Boolean)
    assert(
      keys.join(',') === 'notifySystem,notifySound,tgLive,tgOffline,tgRecord,tgError,pollIntervalSec,requestGapMs,prefetchStream',
      'D60b 旧全局键的删除清单逐键锁死(展开进矩阵后顶层必须删净, 否则 setSettings 浅合并把这些死键永久留在 db.json): 加键要理由, 减键更要',
      keys.join(',')
    )
  }
  assert(
    /settings: migrateSettings\(j\.settings\)/.test(st) && (st.match(/migrateSettings\(/g) || []).length === 2,
    'D60c 旧库形状只在读这一道收敛(load 里逐格迁移 + 删死键, 全库一处调用): 写侧再兜等于同时供着两套形状, 死键也就永远删不净',
    `调用点数=${(st.match(/migrateSettings\(/g) || []).length}`
  )
}

// ============================================================================
// D61~D65: 请求面收口 —— 三个"没人要的请求"与两处"方向反了的复用"
//   这里的真值来自实测, 不是推理: master 令牌 exp=取源+585s, 而 5 条变体地址在**整轮无心跳**
//   的情况下 27.1 分钟仍 5/5 全活 —— 变体不靠心跳续命, 15s 一轮全档齐养(≈11.5 万发/天)是把自己当播放器。
//     保活泵按 15s 无差别养所有缓存源(含已下播/已取关的): 周期与"该不该养"都要改
//     SOOP 每多解一档多 2 发(预取 8~10 发链), 而预取的产出只是徽标亮一下: 后台不该要全档菜单
//     风控信号只在 Panda 有账, SOOP 撞 403/429/HTML 后各泵照每轮重打: 越抖越打
//     门槛类回执(付费/成人/粉丝/道具/本场已断)每次进房都重打整链, 换回同一句话
//     代理端每个播放器请求各自打一次上游, 播放器+保活泵撞同一 target 即双份
//   行为侧由 verify-follows H/I/J、verify-playcache T34/T34b/T35、verify-p1 G5、verify-keepalive S13~S15 数实发请求。
// ============================================================================
{
  const pa = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const segPa = (decl) => {
    const i = pa.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(pa, i)
    return pa.slice(i, j < 0 ? undefined : j)
  }
  assert(/private static KEEPALIVE_MS = 300_000/.test(pa) && !/KEEPALIVE_MS = (15_000|60_000)/.test(pa), 'D61a 泵周期 60s→5 分钟: 心跳在这里不是续命手段而是"尽早发现真死"—— 实测无心跳 27 分钟变体全活 + 现场一天只有 1 次「保活连续真死」, 判死要 2 次连击 ⇒ 最坏 10 分钟收尸仍远在水位线之前')
  assert(/const wait = Math\.min\(900_000, Math\.max\(PandaApi\.KEEPALIVE_MS, this\.playCache\.size \* 2000\)\)/.test(pa) && /setTimeout\(\(\) => void loop\(\), wait\)/.test(pa), 'D61b 间隔随缓存规模自适应(每源 +2s, 封顶 900s)且真作用在重排上 —— 只在首轮用基准值; 300 源以内恒为 5 分钟基准, 更大规模时全场心跳之和不再随源数线性增长')
  assert(/private static KEEPALIVE_OFFLINE_TTL_MS = 30 \* 60_000/.test(pa) && /private static KEEPALIVE_GUEST_TTL_MS = 10 \* 60_000/.test(pa), 'D61c 源缓存有两道活性时限: 已下播 30 分钟 / 不在关注表 10 分钟(缓存不再是"取到就永久算有源")')
  const tk = segPa('private async keepaliveTick(')
  assert(/const anchors = new Map\(store\.listAnchors\(\)\.map\(\(a\) => \[roomKey\(a\.platform, a\.userId\), a\]\)\)/.test(tk), 'D61d 关注表按复合键建(playCache 是裸 userId, 直接拿裸号建表会让同号 SOOP 关注覆盖 Panda 的 isLive)')
  // 离线分支到"在播才入队"那一行之间 = 下播房能做的事的全集: 这一段里出现 queue.push 就是给已知下播的房发心跳
  const off = tk.slice(tk.indexOf('if (!a.isLive) {'), tk.lastIndexOf('queue.push([userId, pack])'))
  assert(off.length > 0 && !/queue\.push/.test(off) && /age > PandaApi\.KEEPALIVE_OFFLINE_TTL_MS/.test(off) && /this\.invalidatePlay\(userId\)/.test(off) && /\r?\n {10}continue/.test(off), 'D61e 已知下播: 一次心跳都不发(老纪律不动), 时限只管收尸让「秒开」徽标说实话 —— 从这一格到在播入队那行之间不许长出 queue.push')
  assert(/if \(age <= PandaApi\.KEEPALIVE_GUEST_TTL_MS\) queue\.push\(\[userId, pack\]\)/.test(tk) && /不在关注表且已过宽限, 源出队/.test(tk), 'D61f 未关注源(临时进房回访)给 10 分钟宽限照常养, 到期收手并出声 —— 不静默蒸发')
  assert((tk.match(/queue\.push/g) || []).length === 2, 'D61f2 整个 tick 只有两个入队点(宽限期内的未关注源 + 在播的关注源): 「只在关注且在播的源入队」是靠结构成立的, 不是靠日志说的', `实数=${(tk.match(/queue\.push/g) || []).length}`)
  assert(!/this\.playCache\.delete\(userId\)/.test(tk) && (tk.match(/this\.invalidatePlay\(userId\)/g) || []).length === 2, 'D61g 收手一律走 invalidatePlay(纪元 +1 + 在飞摘净 + 徽标广播), 不许绕过纪元门直接删缓存条目', `实数=${(tk.match(/this\.invalidatePlay\(userId\)/g) || []).length}`)
  assert(/const age = pack\.fetchedAt \? Date\.now\(\) - pack\.fetchedAt : 0/.test(tk) && /if \(!pack\.ok \|\| pack\.vod\) continue/.test(tk), 'D61h 无 fetchedAt 算 0 岁: 不是经缓存写入路径来的源不收手(宁漏一次清理也不误杀); 回放是静态分片, 无会话活性概念')
  const ks = segPa('private async keepaliveSource(')
  assert(/const primary = pack\.variants\?\.\[0\]\?\.url \|\| ''/.test(ks) && !/pack\.m3u8/.test(ks), 'D61i 心跳只读主档(改口那条"全档齐养"): 两轮实测 —— 变体静置 15/27 分钟全活, 而 master 的 IVS 令牌 exp=取源+600s 到点按令牌语义过期(那一发 403 无自然样本), 副档不靠心跳续命, master 进这一轮等于每 10 分钟误收一次尸')
  assert(/if \(st === 403 \|\| st === 404\) primaryDead = true/.test(ks) && (ks.match(/primaryDead = true/g) || []).length === 1, 'D61j 判死只有一处赋值、只认主档的 403/404: 网络层失败一个都不计, 否则断网恢复瞬间全量误杀+对瘫痪 API 群重铸', `赋值点数=${(ks.match(/primaryDead = true/g) || []).length}`)
  assert(/源保活泵已启动\(基准 \$\{PandaApi\.KEEPALIVE_MS \/ 1000\}s[^\n]*只在关注且在播的源入队\)/.test(pa), 'D61k 启动那一行把新口径念出来(周期 + 自适应 + 入队门), 真机一眼能认出泵是哪一版')
  // 规模仿真里那枚公式是抄来的, 不是import 来的 —— 源改了它不改, 下一次拿它说话的量级就是上一版的(这一格的档正是这张表定的)
  const simKa = fs.readFileSync(R('scripts', 'sim-keepalive-scale.mjs'), 'utf8')
  assert(/Math\.min\(900_000, Math\.max\(300_000, N \* 2000\)\)/.test(simKa), 'D61l 仿真的自适应间隔与 startKeepalive 同一枚公式(300s/2s/900s 三个常数一字不差): 它漂移一天, 依据它写下的结论就作废一天')
}
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pa = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const si = fs.readFileSync(R('src', 'main', 'services', 'source.ts'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  assert(/const want = fullVariants \? allPresets : allPresets\.slice\(0, 1\)\s*\r?\n\s*const presets = want\.filter\(\(p\) => !reuse\.some\(\(b\) => b\.name === p\.name\)\)/.test(so) && (so.match(/allPresets\.slice\(/g) || []).length === 1, 'D62a 档位扇出只有一个闸口(菜单一次读全, 请求按档发): 别处再 slice 一次就是第二条取流链。 闸口后面只减"同一场已经买过的档", 不许再开第二个 slice')
  assert(/partial: allPresets\.length > 1 && variants\.length < allPresets\.length/.test(so), 'D62b partial 只在"真的还有档没解"时成立: 单档房的那份源是完整菜单, 不该被满档 caller 判成残缺而白重打整链。 判据从此看"到手档数 vs 菜单档数"而不是看 caller 要哪一档 —— 接了复用账之后"其余档全买失败"不再会让整包为空, 旧写法会把缺档的包写成满档')
  assert(/档位=\$\{variants\.length\}\$\{fullVariants \? '' : '\(只解最高档\)'\}/.test(so), 'D62c 拉源日志带档位与档级(真机一眼分得清预取那一发与进房那一发)')
  const fp = seg(so, "async fetchPlay(channel: string, password = '', fullVariants = true)")
  assert(fp.includes('this.runPlayChain(channel, password, m, fullVariants)') && fp.includes('this.runPlayChain(channel, password, meta, fullVariants)'), 'D62d fullVariants 沿 fetchPlay 的两条重打分支一路传到底: 在 bno 复用那一跳上把它丢了, 预取就又变成整链')
  assert(/async getPlayCached\(channel: string, password = '', forceFresh = false, fullVariants = false\)/.test(so) && /getPlayCached\(id: string, password\?: string, forceFresh\?: boolean, fullVariants\?: boolean\)/.test(si), 'D62e 契约与实现对齐, 默认值是 false: 后台默认省档, 要全档必须明说(默认给全档 = 这个旋钮白装)')
  assert(!/getPlayCached\(userId: string, password = '', forceFresh = false, fullVariants/.test(pa), 'D62f Panda 不装这个旋钮: 它的取源是一发 play + 一次 master(变体免费), 省档省不下任何请求, 加了只会让人以为两边同形')
  // 改判: 播放器那一发从"显式要全档并等它"改成"走秒开快道 + 菜单另发一发补齐"。
  // 原契约要守的那句话一个字没丢 —— 清晰度菜单缺档仍然不是终态(liveMenu 那一发按 fullVariants=true 问),
  // 变的只是"用户等第一帧的那条路上不许压着整链"。两头发都在才绿: 只留快道 = 菜单永远残缺, 只留补齐 = 又回到等整链
  assert(
    /sourceFor\(platform\)\.getPlayFast\(userId, safePwd\(password\), freshNow\)/.test(ipc) &&
      /sourceFor\(platform\)\.getPlayCached\(String\(userId\), safePwd\(password\), false, true\)/.test(ipc),
    'D62g 播放器两条腿都在: 取源走 getPlayFast(手里那份残缺的也照给), 补齐走 liveMenu 那一发显式 fullVariants=true —— 第三参是收敛过的 freshNow(不是裸 !!fresh), 快道那一发也不许把它丢了'
  )
  assert(/if \(r\.partial\) void fillMenu\(\)/.test(fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')), 'D62g2 渲染层收到 partial 那一发必须追补齐(这一句断了 = 秒开换来的是永远只有一档可选)')
  assert(/await sourceFor\(platform\)\.getPlayCached\(uid\)\.catch/.test(wt) && (wt.match(/getPlayCached\([^)]*,[^)]*,[^)]*,/g) || []).length === 0, 'D62h watcher 里所有预取都走默认档级(只解最高档), 一处都不许自己传全档', `四处参数调用=${(wt.match(/getPlayCached\([^)]*,[^)]*,[^)]*,/g) || []).length}`)
}
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const gp = (() => {
    const i = so.indexOf('async getPlayCached(channel: string, password = ', 0)
    const j = bodyEnd(so, i)
    return so.slice(i, j < 0 ? undefined : j)
  })()
  assert(/const key = `\$\{channel\}\$\{password \? '#pw' : ''\}\$\{fullVariants \? '' : '#top'\}`/.test(gp), 'D63a 在途键同时表达密码槽与档级: 把"要全档"的 caller 合进一条只解最高档的在途链 = 塞给它一份残缺菜单')
  // 注意: 这里匹配的是源码里的逻辑或, 必须写成 \|\| —— 裸 || 在正则里是"空交替", 恒真(= 契约不站岗)
  assert(/if \(c && c\.ok && \(!fullVariants \|\| !c\.partial\)\) return c/.test(gp), 'D63b 命中方向锁死: 只要最高档的那方, 手里这份满不满档都够用; 要满档的那方绝不能接一份只解最高档的包')
  assert(!/if \(c && c\.ok && \(!c\.partial \|\| fullVariants\)\)/.test(gp), 'D63c 反写的命中式不许回来(它同时犯两个错: 满档 caller 拿到残缺包, 预取 caller 白重打整链)')
  assert(/const r = await this\.fetchPlay\(channel, password, fullVariants\)/.test(gp), 'D63d 在途链自己按档级发, 结果按 e0 纪元门落缓存(与 D57 同一条门, 省档不省掉作废语义)')
  assert(/this\.playInflight\.set\(key, p\)/.test(gp) && /this\.playInflight\.delete\(key\)/.test(gp), 'D63e 在飞按 key 装/摘(四种形状各一条), 摘在 finally 里 —— 失败的那一发不许把键留在表上挡后来者')
}
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const rc = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const nr = seg(so, 'private noteRisk(url: string, status: number, text: string): void {')
  assert(/const isPage = url\.startsWith\(`\$\{SOOP_ORIGIN\}\/`\)/.test(nr) && /const htmlOnApi = !isPage && text\.trimStart\(\)\.startsWith\('<'\)/.test(nr), 'D64a "接口回了 HTML"这条只在接口上算数: 播放页本来就是一篇 HTML(第一版拿整页当风控, 读一次页就冷却五分钟 = 自断)')
  assert(/const httpHit = status === 403 \|\| status === 429 \|\| \(status >= 500 && status !== 515\)/.test(nr), 'D64b 5xx 里 515 排除在外(那是 Cloudflare "区域被屏蔽"的固定返回码, 每次必中 = 永久冷却)')
  assert(!/throw/.test(nr) && /this\.riskUntil = Date\.now\(\) \+ SoopApi\.RISK_COOL_MS/.test(nr), 'D64c 记账只写表, 绝不抛(抛=把风控算成用户那一条链的失败); 判据与抬时间戳同函数内完成, 不给"看到了却没记"留缝')
  assert(/if \(!this\.riskCooling\(\)\) logger\.warn/.test(nr), 'D64d 同一个冷却窗口只出声一次(每发都 warn = 日志里全是重复, 反而看不出风控开始的那一刻)')
  assert(/private static RISK_COOL_MS = 5 \* 60_000/.test(so) && /riskCooling\(\): boolean \{\s*return Date\.now\(\) < this\.riskUntil/.test(so), 'D64e 冷却 5 分钟与读取口径(读时间戳, 不自减计数)')
  assert((wt.match(/soopApi\.riskCooling\(\)/g) || []).length === 2, 'D64f watcher 里恰好两处消费(探针整批收手 + 预取泵整条收手): 一处都不许多, 消费点多了就等于把同一个闸门装在不同的路上', `实数=${(wt.match(/soopApi\.riskCooling\(\)/g) || []).length}`)
  assert(!/riskCooling/.test(ipc) && !/riskCooling/.test(rc) && !/riskCooling/.test(seg(so, 'async getPlayCached(')), 'D64g 冷却只归后台的泵消费: 用户点开播/播放器起录/取源本身一律不看它 —— 冷却期把用户意图也挡下是拿时效换安全, 而这道交易没谈过')
  const cool = /if \(soopApi\.riskCooling\(\) && sent\.length\) \{[\s\S]*?\n {4}\}/.exec(wt)
  assert(!!cool && /sent = \[\]/.test(cool[0]) && !/fail\+\+|fail \+=|roundFailed \+=/.test(cool[0]), 'D64h 收手那格只做一件事: 把 sent 清空(这些房留在 probe 里由"被预算挡下"那一格统一计数)。两处都记会把同一批房数两遍')
  assert(/const allFail = anchors\.length > 0 && covered === 0 && \(sent\.length > 0 \? fail === sent\.length : probe\.length > 0\)/.test(wt), 'D64i 失明判据把"冷却收手"当成全灭而非"没瞎": sent 被清空 ≠ 读到 0 失败, 冷却期正好把连坐提醒绕过去是最糟的组合')
  assert(/this\.riskUntil = 0/.test(seg(so, 'clearPlayCache(): void {')), 'D64j 换号即撤冷却: 上一号的风控静默不该闷住新账号的泵(与 Panda 熔断随换号撤退同语义)')
}
{
  const hp = fs.readFileSync(R('src', 'main', 'services', 'hlsProxy.ts'), 'utf8')
  const pa = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  assert(/private inflightReads = new Map<string, Promise<ProxyRead>>\(\)/.test(hp) && (hp.match(/this\.readUpstream\(/g) || []).length === 2, 'D65a 清单与分片共用一条在飞表, 且上游只有 readUpstream 这一个读取入口(两个调用点): 各写一遍 fetchUpstream = 播放器与保活泵撞同一 target 时打两份')
  assert(/const flying = this\.inflightReads\.get\(target\)\s*if \(flying\) \{\s*this\.noteMerge\(kind\)\s*return flying\s*\}/.test(hp), 'D65b 合流按上游 target 认(令牌/签名已在 URL 里), 不按客户端认: 命中在飞只做一笔记账再共用, 不多发一发')
  assert(/if \(this\.inflightReads\.get\(target\) === p\) this\.inflightReads\.delete\(target\)/.test(hp), 'D65c 撒锁按身份比: 后到的 finally 不许把下一批的键摘掉')
  assert(!/inflightReads\.set\([^,]+,[\s\S]{0,40}Date\.now/.test(hp) && /只合流、不加 TTL 缓存/.test(hp), 'D65d 只合流不缓存: 直播清单每一轮都要新的, 把读满进内存的日子留着就是新段读成旧段')
  assert(/private static GATE_CODES = \['needAdult', 'needFan', 'needUnlimitItem', 'needCoinPurchase', 'castEnd'\]/.test(pa) && /private static GATE_TTL_MS = 15 \* 60_000/.test(pa), 'D65e 门槛账只收这五个"不会自己好"的码, 15 分钟: 密码类与登录态类一个都不记账(用户下一次可能就把密码改对了)')
  assert(/private static GATE_PERSIST = \['needAdult', 'needUnlimitItem', 'needCoinPurchase'\]/.test(pa) && !/GATE_LADDER_MS/.test(pa) && !/gateTries/.test(pa), 'D65e2 落盘的那三类才是"账号侧结构性门槛"(重启不改账号也不改房间设置), 期限就是一把 15 分钟的尺、不做递增退避(用户定「退避统一 15 分钟冷却」: 门槛多半是暂时的, 一次挡满一天把"已经好了"押到明天; 阶梯与那一档计数器整个从源码里删掉, 留着就是死字段。needFan(加粉就翻)与 castEnd(说的是那一场)一个字都不落盘')
  assert(/if \(PandaApi\.GATE_CODES\.includes\(code\)\) \{\s*const persist = PandaApi\.GATE_PERSIST\.includes\(code\)/.test(pa) && (pa.match(/GATE_CODES\.includes\(code\)/g) || []).length === 1 && /this\.gates\.set\(userId, \{ until, pack: gate, code \}\)/.test(pa), 'D65f 记账点唯一且在受限码分支内: 门外的失败(网络/满员)混进账里 = 把可重试的当不可重试的挡在门外(那一格连原始码一起存, 见 D112q —— 屏上那两格从前是反推的)')
  // 落盘是那一本内存账的延伸, 门必须一样窄 —— 只有 GATE_PERSIST 那三类写盘, 且写点唯一
  assert((pa.match(/store\.updateAnchor\('pandalive', userId, \{ gateCode: code/g) || []).length === 1 && /if \(persist\) store\.updateAnchor\('pandalive', userId, \{ gateCode: code, gateUntil: until \}\)\s*else this\.dropPersistedGate\(userId\)/.test(pa), 'D65f2 落盘点唯一且紧跟记账: 结构性那三类落的正是内存那一格刚写的同一个 until, needFan/castEnd 走 dropPersistedGate(只清残留, 无账不写) —— 把落盘门开宽就等于把"会自己翻的门槛"钉在盘上')
  // 两本账同一把尺同一时刻; 到期与读回都不许留"第二本账的更长的日子"
  assert(/const until = Date\.now\(\) \+ PandaApi\.GATE_TTL_MS\s*this\.gates\.set\(userId, \{ until, pack: gate, code \}\)/.test(pa), 'D65f3 内存与盘用的是同一个 until(之前那版内存 15 分钟、盘 24 小时各写各的 ⇒ 长跑那一本到点自己问了, 屏上却写着"20 小时后放行"); 这一把尺就是唯一的尺, 两本账不再有第二个到期日')
  assert(/const until = Math\.min\(a\.gateUntil \|\| 0, now \+ PandaApi\.GATE_TTL_MS\)/.test(seg(pa, 'private hydrateGates(): void {')) && /if \(until <= now\) \{\s*this\.dropPersistedGate\(a\.userId\)/.test(seg(pa, 'private hydrateGates(): void {')) && /private dropPersistedGate\(userId: string\): void \{/.test(pa), 'D65f4 读回时把盘上那个时刻钳到"从现在起最多一把尺" —— 上一版(一天 / 退避阶梯)留下的长到期日不许把新尺子押到明天; 到期就当这一格过点了, 内存与盘一起清(不留 keepStep 那种"清一半"的分支), 下一次取源照旧重问一发')
  assert(/if \(g && g\.until > Date\.now\(\) && !password\) return \{ \.\.\.g\.pack \}/.test(pa), 'D65g 短路三条件(有账 + 没过期 + 没带密码)且返回的是拷贝: 复用的那句不许被调用方改一处就污染整本账')
  assert(/this\.forgetGate\(userId\)/.test(seg(pa, 'invalidatePlay(userId: string): void {')) && /this\.gates\.delete\(userId\)\s*this\.dropPersistedGate\(userId\)/.test(seg(pa, 'private forgetGate(userId: string): void {')) && /this\.gates\.clear\(\)/.test(seg(pa, 'clearPlayCache(): void {')) && /if \(a\.platform === 'pandalive' && \(a\.gateCode \|\| a\.gateUntil\)\) store\.updateAnchor\('pandalive', a\.userId, \{ gateCode: '', gateUntil: 0 \}\)/.test(seg(pa, 'clearPlayCache(): void {')), 'D65h 门槛账跟着事件走: 开播/作废清这一房(内存 + 盘一起, 就一个 forgetGate), 换号清整本 —— 内存那本 clear() 之外还要逐行扫盘(变异刀 K6 切掉那一圈, 上一号的结构性账就整本过继给新号, 而新号"过不去"是另一回事)')
  assert(/if \(!forceFresh\) \{\s*this\.hydrateGates\(\)/.test(pa) && (pa.match(/this\.hydrateGates\(\)/g) || []).length === 1 && /private gatesHydrated = false/.test(pa), 'D65h2 盘上那本账只读回一次且读在短路之前(非强制那一路): 每次取源重扫全表就是把落盘的代价换成 CPU, 而这一格买的是"冷启动不再重打整链"')
  assert(/if \(r\.ok\) this\.forgetGate\(userId\)/.test(pa), 'D65h3 平台改口(真拿到源)当场撤账, 且撤在纪元门之前: 盘上那一格没有这一笔就是死期 —— 用户充值/成年验证过了, 短路口还会替他挡掉整条链')
  const ep = seg(wt, 'private enqueuePrewarm(platform: Platform, userId: string): boolean {')
  assert(/if \(a\?\.tags\?\.isPw\) return false/.test(ep) && ep.indexOf('isPw) return false') < ep.indexOf('q.push(userId)'), 'D65i 密码房不进预取队列(门在入队上游): 预取这一路永远没有密码, 这一发注定换回一句"要密码" —— SOOP 那句"要密码"背后是整条取源链')
}

// ============================================================================
// D66 验证脚本自己的体检: 恒真的正则 = 不站岗的契约
//   正则字面量里裸写 || 是"空交替"—— 那个空分支能匹配空串, 于是 .test() 恒真, 正断言永远绿。
//   D63b 那一格刚写下时忘了转义逻辑或 (\(!fullVariants || !c\.partial\)), 把源码改坏它照样报 PASS,
//   而且报得理直气壮。这类失效不会自己出声(它长得就像"通过"), 只能由一条元契约扫全部验证脚本。
//   判据两条: (a) 字面量里有不转义的连续两竖; (b) 字面量匹配空串(长度阈值 14, 放过 /\s*/ 这一类真短的)。
//   2026-10-02 实测: 全部验证脚本按这两条扫 = 0 命中(修掉 D63b 之后), 所以阈值可以直接钉死。
// ============================================================================
{
  const START = /[(!&|?,=:]\s*$/
  const literal = (s, i) => {
    let j = i + 1
    let body = ''
    while (j < s.length) {
      const ch = s[j]
      if (ch === '\\') {
        body += ch + (s[j + 1] || '')
        j += 2
        continue
      }
      if (ch === '[') {
        let k = j
        while (k < s.length && s[k] !== ']') {
          if (s[k] === '\\') k++
          k++
        }
        body += s.slice(j, k + 1)
        j = k + 1
        continue
      }
      if (ch === '/') return body.length ? { body, end: j } : null
      if (ch === '\n') return null
      body += ch
      j++
    }
    return null
  }
  const bad = []
  const files = fs.readdirSync(R('scripts')).filter((n) => /^verify-.+\.mjs$/.test(n))
  for (const f of files) {
    const s = fs.readFileSync(R('scripts', f), 'utf8')
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '/') continue
      if (!START.test(s.slice(Math.max(0, i - 14), i))) continue
      const lit = literal(s, i)
      if (!lit) continue
      i = lit.end
      let inCls = false
      for (let k = 0; k < lit.body.length - 1; k++) {
        const c = lit.body[k]
        if (c === '\\') {
          k++
          continue
        }
        if (c === '[') inCls = true
        else if (c === ']') inCls = false
        else if (c === '|' && !inCls && lit.body[k + 1] === '|') {
          bad.push(`${f}: 裸逻辑或 /${lit.body}/`)
          break
        }
      }
      let re = null
      try {
        re = new RegExp(lit.body)
      } catch {
        re = null
      }
      if (re && lit.body.length >= 14 && re.test('')) bad.push(`${f}: 匹配空串 /${lit.body}/`)
    }
  }
  assert(files.length >= 11 && bad.length === 0, 'D66a 十一条验证脚本里没有一个恒真的正则字面量(扫描本身也要跑到: 文件数不足同样判失败)', `脚本数=${files.length} 命中=${bad.slice(0, 8).join(' | ')}`)
}

{
  // 按站车道(P1-2): 审出来的形状不是"某条循环发得太快" —— 每条后台循环自己都有节流,
  // 漏的是"跨条": 探针 ‖ 预取 ‖ 保活重铸 ‖ 登录探针在同一站上各发各的, 瞬时速率是它们的和。
  const ng = fs.readFileSync(R('src', 'main', 'services', 'netGate.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const hp = fs.readFileSync(R('src', 'main', 'services', 'hlsProxy.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const rc = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const ipcf = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const pkg = fs.readFileSync(R('package.json'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  assert(
    /const prev = lane\.tail/.test(ng) && /lane\.tail = new Promise<void>/.test(ng) && /if \(prev !== IDLE\) \{/.test(ng) && /finally \{\s*release\(\)/.test(ng),
    'D67a 一站一条道, 串行靠链不靠计数: 后来者排在上一发的落定之后, 异常路径也不会把计数留在"还在飞"'
  )
  assert(
    /return laneRun\(hostOf\(url\), store\.getSettings\(\)\.monitor\.soop\.requestGapMs, \(\) => this\.sendReq\(url, init, timeoutMs, rescueOnTimeout\)\)/.test(so) &&
      /return laneRun\(hostOf\(API\), store\.getSettings\(\)\.monitor\.pandalive\.requestGapMs/.test(pd),
    'D67b 间隔取自本平台那一格 requestGapMs(两平台各读各的, 与轮询分家同口径), 车道不另发明第二个节流数'
  )
  assert((so.match(/laneRun\(/g) || []).length === 1 && (pd.match(/laneRun\(/g) || []).length === 1, 'D67c 每个服务只有最下端那一处进车道: 中间层再包一遍 = 同一次请求被罚两遍(间隔翻倍 = 时效掉), 各层各包 = 谁也数不清一共等多久', `SOOP=${(so.match(/laneRun\(/g) || []).length} Panda=${(pd.match(/laneRun\(/g) || []).length}`)
  assert(!/laneRun/.test(seg(pd, 'private async fetchText(')) && !/netGate/.test(hp) && /只管 API 站, 不管媒体\/CDN/.test(ng), 'D67d 媒体/CDN 面豁免且豁免理由在案: 播放在看的分片不能被排队, 保活泵一轮也要跑完全部在播源, 串成一条会把源饿死 —— 那正是要避免的重铸风暴')
  assert(/const MAX_WAIT_MS = 8_000/.test(ng) && /Math\.min\(Math\.max\(want, 0\), MAX_WAIT_MS\)/.test(ng), 'D67e 排队有 8 秒上限且是 clamp(不是丢弃): 时效性是这一层的第一目标, 挤不过去也要发出去 —— 让预取队列整体滞后是最坏结果')
  assert(/\* \(0\.9 \+ Math\.random\(\) \* 0\.2\)/.test(ng) && !/Math\.random\(\)/.test(ng.replace(/\* \(0\.9 \+ Math\.random\(\) \* 0\.2\)/, '')), 'D67f 抖动 ±10% 一处且只这一处: 固定间隔本身就是可识别的机器形状, 两处抖动会叠成猜不出的总时长')
  // 数的是真调用点 `asUser(() => ...)` 而不是 `asUser(` —— 后者会被注释里那句"asUser(越过车道)"骗到(实测)
  const uIpc = (ipcf.match(/asUser\(\(\) =>/g) || []).length
  const uRec = (rc.match(/asUser\(\(\) =>/g) || []).length
  assert(/return userMark\.getStore\(\) === true/.test(ng) && uIpc === 4 && uRec === 1 && !/asUser/.test(wt), 'D67g 默认后台、用户显式: 忘了标记的后果是"照旧各发各的"(安全默认), 而不是把后台请求伪装成用户意图; 标记四处(播放器取流 + 播放器补齐清晰度菜单那一发[ 新加: 它是"用户点开这一间"的后半句, 排在后台 17 发之后就是菜单转圈] + 手动录制首发 + 账号页「立即重新校验」) —— 第三处是 补的: 那颗按钮的全部意义是"现在就问", 而它过去和后台泵排在同一条尾锁之后(最坏 MAX_WAIT_MS 8 秒)。后台的登录探针仍一处都不标', `ipc=${uIpc} rec=${uRec} watcher=${/asUser/.test(wt)}`)
  assert(/if \(isUserCall\(\)\) \{[\s\S]{0,80}stamp\(lane\)[\s\S]{0,80}finally \{[\s\S]{0,40}stamp\(lane\)/.test(ng), 'D67h 用户那一发不等, 但起跑与落定都落笔: 否则"用户点一下 + 后台 17 发"会在同一瞬时刻叠成同一瞬时的 18 发')
  assert(/new AsyncLocalStorage<boolean>\(\)/.test(ng), 'D67i 标记沿异步链传递(不是逐层加参数): 快速道要覆盖的是整条链, 而 fetchPlay → runPlayChain → fetchAid → req 中间隔着四个私有函数')
  assert(/verify-netgate\.mjs/.test(pkg), 'D67j 车道套在 npm run verify 链里: 不在链里的脚本等于没写(它会与实现悄悄分家)')
}
{
  // P3-1 大厅 force 下限 + P3-2 关注列表在飞合并
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const rd = seg(wt, 'async refreshDiscovery(')
  assert(/if \(force && since < Watcher\.TICK_MIN_MS\) \{[\s\S]{0,160}return this\.discovery/.test(rd) && /大厅刷新节流/.test(rd), 'D68a force 只豁免 60 秒复用窗口, 8 秒下限照管并留痕: 渲染层那 2.5 秒冷却管的是按钮自身, 连点仍会每 2.5 秒打四到五页整表(刚拉过一屏时再点也读不到新东西)')
  assert(!/if \(force && since < \d/.test(rd) && (wt.match(/TICK_MIN_MS = 8_000/g) || []).length === 1, 'D68b 与 tick() 同一条下限、同一个常量: 两处各写一个 8000 就是第二份真相, 改一处忘另一处不会报错')
  const fw = seg(so, 'async fetchFavorites(')
  assert(/if \(this\.favInflight\) return this\.favInflight/.test(fw) && /if \(this\.favInflight === p\) this\.favInflight = null/.test(fw) && !/this\.req\(/.test(fw), 'D68c 关注列表这一发有在飞合并且按身份撒锁: 轮询那一发与"同步关注"撞在同一瞬时时合并发, 失败/异常都不把键留在表上挡后来者')
  assert((seg(so, 'private async readFavorites(').match(/this\.req\(/g) || []).length === 1, 'D68d 真请求只在 readFavorites 一处: 合并层自己不许再发一发, 否则"合了个寂寞"')
}
{
  // A2 预取泵让路 + 停轮清队
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  assert(/if \(!this\.running \|\| this\.loop\[platform\]\.inFlight\) break/.test(seg(wt, 'private async pumpPrewarm(')), 'D69a 预取泵与轮次让路: 停轮即不再发预取、一轮正在打整表时先不发 —— 旧写法只挡 Panda 熔断, 于是关掉监控以后这条泵仍按 1.2s 一发逐房拉源')
  const st = seg(wt, 'stop(): void {')
  assert(/this\.prewarmQueue\[p\] = \[\]/.test(st) && /this\.idleQueue = \[\]/.test(st), 'D69b 停轮把两条队列一起清掉: 只清定时器等于把"下一发要发真请求"的待办留在手里, 泵自己还会排空')
  assert(/void this\.pumpPrewarm\(platform\)/.test(wt) && !/this\.prewarmQueue\[platform\] = \[\]/.test(seg(wt, 'private async pumpPrewarm(')), 'D69c 让路是 break 不是清队: 轮次落地由 runRound 的 finally 重新点泵, 排在后面的房照旧秒开(清队会把时效赔进去)')
}
{
  // A3 源缓存年龄收手: 两平台同规约, 且不再被保活开关关掉
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const mi = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const sweep = seg(so, 'sweepPlayCache(): number {')
  assert(/private static CACHE_GUEST_TTL = 10 \* 60_000/.test(so) && /private static CACHE_OFFLINE_TTL = 30 \* 60_000/.test(so) && /if \(a\.isLive \|\| age <= SoopApi\.CACHE_OFFLINE_TTL\) continue/.test(sweep), 'D69d SOOP 的时限抄 Panda 那两档(回访客 10 分钟 / 已下播 30 分钟), 在播且仍在关注表的不限年龄: 时限再掐长场次只会多打一条整链')
  assert(!/this\.req\(|ses\.fetch|nodeHttpRequest/.test(sweep), 'D69e 年龄收手只扫内存、零网络: 这一趟的存在理由是"徽标别谎报", 不是"顺手复查一下"')
  assert(/if \(!pack\.fetchedAt\) continue/.test(sweep), 'D69f 没有年龄读数的不收手: 宁漏一次清理也不误杀(与 D61h 同口径)')
  assert(/if \(this\.cacheSweepTimer\) return/.test(seg(so, 'startCacheSweep(): void {')) && /setTimeout\(loop, 60_000\)/.test(so) && /soopApi\.startCacheSweep\(\)/.test(mi), 'D69g 清扫由启动挂上且幂等(重复调用不长出第二个定时器): 60 秒自续, 关掉保活也照跑')
  const kt = seg(pd, 'private async keepaliveTick(')
  assert(kt.indexOf('if (!store.getSettings().keepaliveStream) return') > kt.indexOf('KEEPALIVE_OFFLINE_TTL_MS') && kt.indexOf('if (!store.getSettings().keepaliveStream) return') < kt.indexOf('KEEPALIVE_LANES'), 'D69h 闸门只关心跳、不关记账(位置断言): 年龄收手全靠扫描那一趟落地, 把它压在开关后面 = 关掉保活就不再收尸')
}
{
  // B 观测面: 重发、合流、页面来源三处过去都是无声的
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const hp = fs.readFileSync(R('src', 'main', 'services', 'hlsProxy.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ipcf = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  assert(/this\.fallbackLogUntil = now \+ 60_000/.test(so) && /this\.fallbackLogUntil = now \+ 60_000/.test(pd), 'D70a 兜底重发只在 60 秒窗口出声一次、把窗口内的次数一起报: 逐条写会在断网/DNS 黑洞期把日志刷成计数器(那一形态每请求都触发)')
  assert((so.match(/this\.noteFallback\(/g) || []).length === 1 && (pd.match(/this\.noteFallback\(/g) || []).length === 2, 'D70b 三个"同一个请求打了第二遍"的现场全部留痕(SOOP req 一处 + Panda json 与 fetchText 两处), 一个都不许多也不许少: HTTP 状态码错误按 M3 绝不重发, 给它们记账会把纪律读歪', `soop=${(so.match(/this\.noteFallback\(/g) || []).length} panda=${(pd.match(/this\.noteFallback\(/g) || []).length}`)
  assert(/if \(flying\) \{\s*this\.noteMerge\(kind\)/.test(hp) && /上游在途合流/.test(hp), 'D70c 代理合流要出声: 省下的请求数是这一项唯一的成果, 没有读数就没人知道它有没有在工作(同样 60 秒一句、按清单/分片分开计)')
  assert(/async fetchPageMeta\(channel: string, quiet = false, fresh = false, why = '取流'\)/.test(so) && /页面元信息\(来源=\$\{why\}\)/.test(so), 'D70d 页面读那一发的日志带来源标签: 探针/取流/添加/录制取名四种形状混在同一句里, 审计就只能靠猜(默认值 = 取流, 漏标不会新增读数面)')
  assert(/soopApi\.fetchPageMeta\(a\.userId, true, true, '探针'\)/.test(wt) && /soopApi\.fetchPageMeta\(userId, false, false, '添加'\)/.test(ipcf) && /soopApi\.fetchPageMeta\(userId, true, false, '录制取名'\)/.test(ipcf) && /this\.fetchPageMeta\(channel, false, false, '取流复查'\)/.test(so), 'D70e 四个调用点各自带标签: 一处漏标就少一种可分派的形状, 而"谁在读这一页"正是请求面审计要回答的第一问。 复查那一格从 fresh 改为吃微缓存 —— 标签不变, 变的只有"它要不要一个新读数"')
}

// ============================================================================
// D71 D: 保活扇出收口 —— 每源一轮一发主档
//   这一条不是"少发为快"的偏好, 是被两轮实测推着改口的: 已经把周期从 15s 放到 60s,
//   却仍以"副档不养会饿死"为由留着全档齐养(D61i 旧文)。复量(杀掉实例、静置、逐分钟 curl):
//   3 房 × 5 档 = 15 条变体清单在 +1/+3/+5/+10/+15 分钟全部 200 且清单持续变长,
//   而同批 master 的 JWT payload 现场解出 exp = 签发 +600/601/602s(到点必过期; 那一发 403 今天没有自然样本, 记为量不到) ——
//   会死的那一个(按令牌语义)从来不在心跳里, 不会死实测的那五个每轮各读一发。
//   行为侧由 verify-keepalive S1/S5-3/S7/S10/S12/S15-3/S17 数实发请求。
// ============================================================================
{
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const segD = (decl) => {
    const i = pd.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(pd, i)
    return pd.slice(i, j < 0 ? undefined : j)
  }
  const ks = segD('private async keepaliveSource(')
  assert((ks.match(/for \(/g) || []).length === 0 && !/const urls = \[/.test(ks), 'D71a 心跳里没有档循环: 结构上只剩一发, 想再齐养必须先把循环长回来(旧写法是 for + Set, 变异只需删掉一行就"看起来仍然养全档")')
  assert(
    /this\.keepaliveInfo\.set\(userId, \{ at: Date\.now\(\), ok: !primaryDead, variants: pack\.variants\?\.length \|\| 1 \}\)/.test(ks),
    'D71b 投影那格报的是"档在手"而不是心跳发数: 播放页侧栏说用户手上几份清晰度, 减发不许把读数改成"1 档"骗人'
  )
  assert(
    /变体地址不靠心跳续命/.test(pd) && /exp = 取源 \+585~600s/.test(pd) && !/只要会话被持续请求养着, 旧源就能一直看/.test(pd),
    'D71c 实测依据写在泵抬头而不是只写在报告里: 这一层的周期与覆盖面两格都靠它, 后人调参时要能看见数(旧的"会话被持续请求养着"是猜测, 已删净)'
  )
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  assert(/kaOn: '[^']*主档心跳 \{s\} 秒前'/.test(zh) && /kaOn: '[^']*primary beat \{s\}s ago'/.test(en) && !/档齐养/.test(zh) && !/tiers ·/.test(en), 'D71d 读数跟着行为改口(双语一起): 「N档齐养」已经是过去式, 留着它就是把"每轮只点主档"这件事对用户藏起来', `zh=${/主档心跳/.test(zh)} en=${/primary beat/.test(en)}`)
  const kt = segD('private async keepaliveTick(')
  assert(
    (kt.match(/queue\.push/g) || []).length === 2 && /if \(!a\.isLive\)/.test(kt) && /KEEPALIVE_OFFLINE_TTL_MS/.test(kt),
    'D71e 减的是档不是纪律: 入队两格、下播零心跳、两道活性时限原样不动(那三条边界不因本改动松动)'
  )
  assert(/if \(n < 2\) return/.test(ks) && /this\.invalidatePlay\(userId\)/.test(ks) && /this\.enqueueRemint\(userId\)/.test(ks), 'D71f 判死仍是"连续两发 + 收尸 + 在播且开预取才重铸": 一发换窄了也不许顺手把两连击改成一击(单次 403 误杀正是 S4 锁的那一条)')
}

// ============================================================================
// D72~D76: 请求面上的四条闸门 + 一条留痕
//   起点是一张"有没有大批量/重复请求"的问句, 落下来的东西分两类:
//   加闸门(D73/D74/D75)与加可见性(D72/D76)。D76 那一条只留留痕、不减发 —— 减发
//   会踩掉锁死的检测路径; 这一形状也要站岗, 否则会被原样再写回来。
//   行为侧取证: verify-playcache T37(留痕只在该出声时出声)、T38(两道新泵闸)、T39(游标轮换),
//   verify-keepalive S18(风控账只认形状不认发起方)。
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (decl) => {
    const i = wt.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  }
  const sq = seg('private setIdleQueue(rest: Anchor[]): void {')
  const pi = seg('private async pumpIdle(): Promise<void> {')
  assert(/this\.idleCursor = n \? \(this\.idleCursor \+ this\.idleDrained\) % n : 0/.test(sq), 'D72a 续扫游标按"这一窗口实际消费了几发"续算并取模: 快照长度每轮都在变, 不取模的游标会把下一批排到数组外面')
  assert(/\[\.\.\.rest\.slice\(this\.idleCursor\), \.\.\.rest\.slice\(0, this\.idleCursor\)\]/.test(sq), 'D72b 轮换的是同一批房、只换起点(与 SOOP 探针游标同一环形规约): 队尾饿死的根因是"每轮都从 r0 起排", 不是"扫得慢"')
  assert(/const n = rest\.length/.test(sq) && /this\.idleQueue = n > 1 \?/.test(sq), 'D72c 长度 0/1 的快照走原路: 只有一间时不必复制一遍数组, 空批更要游标归零(不留指向不存在位置的游标)')
  assert((wt.match(/this\.setIdleQueue\(/g) || []).length === 2 && (wt.match(/private setIdleQueue\(/g) || []).length === 1, 'D72d 两处轮次快照都走这一扇门 + 定义一处: 谁再直接赋 idleQueue 谁就绕过续扫(T10b 那种"看着还在跑其实没接线"的变异)', `调用=${(wt.match(/this\.setIdleQueue\(/g) || []).length}`)
  assert(!/this\.idleQueue = (?:missing|rest|queue)/.test(wt), 'D72e 旧写法"新快照整批替换"不许回来(它把队首重扫、队尾一次都扫不到写进了结构里; stop/per-anchor 那两处的清空是作废队列, 不是换快照)')
  assert((pi.match(/this\.idleDrained\+\+/g) || []).length === 1, 'D72f 每间房只计一次消费: 双计会让游标一次跳两间, 等于一半关注永远轮不到(这条泵的存在理由恰恰是"列表此刻不可用")')
}
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const i = wt.indexOf('private async pumpPrewarm(platform: Platform): Promise<void> {')
  const pp = wt.slice(i, i < 0 ? undefined : i + 4200)
  assert(/const a = store\.listAnchors\(\)\.find\(\(x\) => x\.platform === platform && x\.userId === uid\)/.test(pp) && /if \(!a \|\| !a\.isLive\) continue/.test(pp), 'D73a 出队时按当下真值重判(还在表里吗 + 还在播吗)在同一次查找里办完: 队列是首轮落地那一刻的快照, 而排空要几分钟 —— 秒开只对在播房有意义')
  assert(!/if \(!this\.stillMonitored\(platform, uid\)\) continue/.test(pp), 'D73b 旧的"只查取关"那一行不许回来: 它旁边再补一条 isLive 会变成两次查找、两个答案来源(同一件事不该有两处真值)')
  assert(/if \(!a \|\| !a\.isLive\) continue(?![\s\S]{0,60}q\.length = 0)/.test(pp), 'D73c 跳过只针对掉线者, 不许顺手清队(清队 = 把排在后面的在播房一起牺牲掉)')
  assert(/22 发整页 HTML/.test(pp) && /103 个房/.test(pp), 'D73d 实测依据写在改动处而不是只写在报告里: 这一格的量级(22/22 全回 offline = 100% 白付)只能从现场来, 后人调它时要能看见数')
}
{
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const segP = (decl) => {
    const i = pd.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(pd, i)
    return pd.slice(i, j < 0 ? undefined : j)
  }
  assert(/private riskUntil = 0/.test(pd) && /private static RISK_COOL_MS = 5 \* 60_000/.test(pd) && /riskCooling\(\): boolean \{\s*return Date\.now\(\) < this\.riskUntil/.test(pd), 'D74a Panda 那本账与 SOOP 同语义同长度(读时间戳, 不自减计数): 两边各造一种冷却, 后台泵就要读两面钟')
  assert((pd.match(/this\.noteRisk\(/g) || []).length === 8, 'D74b 八种风控形状全部记账(403/429、≥500、接口回 HTML、不回 JSON、整表 result=false, 再加 bj/关注列表/play 三处业务码里的限流话术): 漏一种就等于那条路上泵照旧失明 —— 旧写法正是只认 403 抛错、不认账, 而现场那句「너무 많은 요청」配的正是 HTTP 200', `实数=${(pd.match(/this\.noteRisk\(/g) || []).length}`)
  assert((pd.match(/this\.noteRisk\([^)]*\)\s*\n\s*throw new RiskError/g) || []).length === 6, 'D74c 记账不许代替判决: 六处抛错型的都在 noteRisk 之后照旧抛出 RiskError(熔断/轮次失败语义靠它, 只记不抛会把风控读成"没事"); 另外两处(关注列表降级/play 回包)按各自契约只记不抛 —— 它们要把"读不到"还给调用方, 抛出会把降级轮变成崩轮', `成对数=${(pd.match(/this\.noteRisk\([^)]*\)\s*\n\s*throw new RiskError/g) || []).length}`)
  assert(/if \(PandaApi\.isRateLimitMsg\(j\.message \|\| ''\)\) this\.noteRisk\(/.test(segP('async fetchBj(')) && segP('async fetchBj(').indexOf('throw new BjNotFoundError') < segP('async fetchBj(').indexOf('isRateLimitMsg'), 'D74d 业务错误只在"限流话术"这一格记账: bj 的 result=false 里"查无此人/无权限"那一类仍一条不记 —— 把它们记进冷却会让一个查无此人的房闷掉全部后台泵 5 分钟; 判据先走 BjNotFoundError 那条早退, 才轮到限流话术')
  assert((wt.match(/api\.riskCooling\(\)/g) || []).length === 1 && (wt.match(/api\.oracleRiskCooling\(\)/g) || []).length === 2 && !/\.noteRisk\(/.test(wt), 'D74e watcher 里 Panda 那两格钟的分工: 总账只被预取泵读(它买的是秒开, 没有人在等), 整表那一格被轮次扇出面与间隙泵读(两条检测路要收一起收) —— 且 watcher 一处记账都不写', `总账=${(wt.match(/api\.riskCooling\(\)/g) || []).length} 整表格=${(wt.match(/api\.oracleRiskCooling\(\)/g) || []).length}`)
  assert(/if \(platform === 'pandalive' && api\.riskCooling\(\)\) \{\s*q\.length = 0\s*break\s*\}/.test(wt), 'D74f 预取泵看 Panda 的账整条收手且清队: 预取买的是 2~6 发链, 正是冷却期最不该重发的形状(与 SOOP 那一条同规约)')
  const er = segP('private enqueueRemint(userId: string): void {')
  assert(/if \(this\.riskCooling\(\)\) \{/.test(er) && /this\.remintTail = this\.remintTail\.then\(async \(\) => \{\s*\/\/ 链步内二次检查[\s\S]{0,80}if \(!this\.riskCooling\(\)\) \{/.test(er), 'D74g 重铸链头一道 + 链步内二次检查: 前序步刚把冷却立起来时, 已经排在链上的后续步也不许发问("冷却期零重铸"是结构保证, 不是时序运气)')
  assert(!/riskCooling/.test(ipc) && !/riskCooling/.test(segP('async getPlayCached(')), 'D74h 冷却只归后台的泵消费: 用户进房、手动拉源、播放器起录一律不看它 —— 冷却期把用户意图也挡下是拿时效换安全, 这笔交易没谈过')
  assert(/this\.riskUntil = 0/.test(segP('clearPlayCache(): void {')), 'D74i 换号即撤账: 上一号的风控静默不该闷住新账号的泵(与 SOOP/D64j 同语义)')
}
{
  const hp = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'HlsPlayer.vue'), 'utf8')
  assert(/const NET_RETRY_MAX = 3/.test(hp) && /let netRetry = 0/.test(hp), 'D75a 网络类致命错误的重试有上限且计数住在 load() 里(每条 src 一份): 上限存在的意义是让循环有终点')
  assert(/hls\.on\(Hls\.Events\.MANIFEST_PARSED, \(_e, data\) => \{\s*netRetry = 0/.test(hp), 'D75b 清单解析成功即重新给满预算: 播得动就不算重试, 否则一次断流后的第一发正常片段也会被后来的抖动打死')
  assert(/\} else if \(netRetry < NET_RETRY_MAX\) \{\s*netRetry\+\+\s*hls\?\.startLoad\(\)/.test(hp), 'D75c 有预算才 startLoad: startLoad() 每次调用都把 hls.js 自己的重试计数重新武装一遍, 无脑调用等于一条没有终点的循环')
  assert((hp.match(/hls\?\.startLoad\(\)/g) || []).length === 1, 'D75d 全文件只有一处真调用 startLoad: 第二处就是第二条没有计数的重连路', `实数=${(hp.match(/hls\?\.startLoad\(\)/g) || []).length}`)
  assert(/网络重试满 \$\{NET_RETRY_MAX\} 次: 上抛换源/.test(hp), 'D75e 满次数要出声并上抛 url-dead(不是静默停止): 停在"重试完"与停在"源死了"在日志里必须分得开')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  assert(
    /(?:async )?function onUrlDead\(\) \{[\s\S]*?m3u8\.value = ''[\s\S]*?\n\}/.test(pv) &&
      /<HlsPlayer v-if="m3u8"[\s\S]{0,120}@url-dead="onUrlDead"/.test(pv),
    'D75f 终点真的存在: 上层收 url-dead 后清空 m3u8 → v-if 卸载组件 → onUnmounted destroy。没有这一环, 上限 3 次只是把无限循环改成每 3 次重挂载的循环。判据按函数体边界而不按字数窗口 —— 在清空之前插了「报案 + 现取一次」那一段, 窗口按字数写就会随每一轮的插入变短'
  )
}
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const i = wt.indexOf('private async roundSoop(')
  const rs = wt.slice(i, bodyEnd(wt, i))
  assert(!/soopProbeSkipUntil|SOOP_BLIND_MAX_MS|probeHeld/.test(wt), 'D76a 撤销要撤干净: 退避终点、封顶常量、让路标志三枚死字段一律不在(留着它们比留着 bug 更坏 —— 下一轮审计会照着它们再写一遍占空比)')
  assert(!/if \([^)]*soopBlindStreak/.test(rs), 'D76b 失明轮数只喂日志, 不参与任何判定: 它一旦进了 if, 这条逐房整页就开始被压节奏, 而 covered===0 时它就是检测路径(全站榜对 SOOP 不存在, 站内列表又读不到)')
  assert(/if \(sent\.length && covered === 0 && fail < sent\.length\)/.test(rs), 'D76c 留痕只在"列表失明且探针读得动"那一格出声: 常态轮它是噪声(列表覆盖时 probe 是个位数), 全灭轮那句 warn 已经在报同一件事(两句=重复读数面)。 判据 rows===null → covered===0: "整表读通了但我的关注一个都不在里面"也是失明')
  assert(/降级探针回执: \$\{sent\.length\}\/\$\{probe\.length\} 发整页/.test(rs) && /关注列表已连续 \$\{this\.soopBlindStreak\} 轮没覆盖到我的关注/.test(rs), 'D76d 回执报的是这一轮的账(发数/在播/下播/失败)并带连续失明轮数: 探针那一发走 quiet, 不写这一句就没人知道最贵的一发烧了多少。 那句话改口成"没覆盖到我的关注" —— 说"不可用"会在整表明明读通时撒谎')
  assert(/为什么不做占空比/.test(rs) && /要再减, 得先由用户认下时效那笔账/.test(rs), 'D76e 不改的理由写在代码里: 没有它, 下一份审计报告会把同一个"5.76 万发/天"再判一次, 而这一次的结论是"减发需授权"')
  assert(/const allFail = anchors\.length > 0 && covered === 0 && \(sent\.length > 0 \? fail === sent\.length : probe\.length > 0\)/.test(rs), 'D76f 失明判据与旧写法一字不差(留痕不改变任何判据): 这一轮的改动只加了一句日志, 冷却/连败/提醒的触发条件全部原样')
  assert(!/sent = \[\]/.test(rs.slice(rs.indexOf('let fail = 0'), rs.indexOf('const allFail'))), 'D76g 探针循环与失明判据之间不许再出现"把 sent 清空"那一格(只有风控冷却那一格有权这么做, 而它由 D64h 站岗)。 地标从 const covered 换成 const allFail —— covered 那一行上移到了探针之前, 再拿它当终点会切出一个空区间, 断言就变成白过')
  // ①: 「整表读通而这一间不在里面」那一支从前既不出声也不进 covered, 于是 hag1947 一天 ≈1,358 发整页在日志里是隐形的
  // 加第五用: 诊断台 ① 那一格要把名单读给屏幕(只读, 不改任何判据)。名册仍然只住 watcher 一处。
  assert(/private soopUnlisted = new Set<string>\(\)/.test(wt) && (wt.match(/this\.soopUnlisted/g) || []).length === 5 && /this\.soopUnlisted\.clear\(\)/.test(wt.slice(0, wt.indexOf('private async roundSoop('))), 'D76h 缺席名册只住 watcher 一处且五用途闭合(声明/clear/has+add/delete/诊断台只读一份), clear 必须在 roundSoop 之外的那一站(start): 报过的名册属本场会话, 重启后要重新出一份 —— 与 soopBlindStreak 同一本账')
  assert(/else if \(byId && !this\.soopUnlisted\.has\(a\.userId\)\) \{[\s\S]{0,200}不在站内关注表[\s\S]{0,160}probe\.push\(a\)/.test(rs) && (rs.match(/probe\.push\(a\)/g) || []).length === 1, 'D76i 出声只加在 else 那一支的边上(边沿触发: 掉出报一次), 而 probe.push 全轮只有一处且在 if 之外: 留痕不许把这一发吃掉, 也不许把它多推一遍 —— 减不减发是用户的三档, 不是这一格偷偷定的')
  assert(/if \(byId && this\.soopUnlisted\.delete\(a\.userId\)\) logger\.info\('soop', `回到站内关注表, 整页回落结束 @\$\{a\.userId\}`\)/.test(rs), 'D76j 回到表里必须收场报一句: 只报"掉出"不报"回来", 名册就成了单向的黑名单, 下一轮读到它不在时没人知道它其实回来过')
}

// ============================================================================
// D77~D84: 按"主播状态优先, 其余尽量省"重排的那一版请求面
//   三条撤销过的判据同样要站岗(撤销过的东西最容易被原样再写一遍), 所以 D78/D84 是负断言。
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const fl = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const rp = (() => {
    const i = wt.indexOf('private async roundPanda(')
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  })()
  const bm = (() => {
    const i = wt.indexOf('private async roundByBookmark(')
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  })()
  // ---- D77 C1: 冷却期停的是扇出面, 不停那一发预言机 ----
  assert(/private cooldownOracleAt = 0/.test(wt) && /private static COOLDOWN_ORACLE_MS = 5 \* 60_000/.test(wt), 'D77a 冷却期那一发预言机有自己的再问时刻(5 分钟): 熔断期"压轮距到 30s 为了早点探到恢复"那一压从来就没探到过东西(30 秒到点的一轮仍走到冷却分支的 return, 探针没发出去过), C1 已把这一压整个撤掉, 探测只由这一发承担')
  assert(/this\.running = true[\s\S]{0,200}this\.cooldownOracleAt = 0/.test(wt), 'D77b 重启即作废这一次问闸(与 D55d 同规约): 新会话第一次撞冷却就该立刻问, 不许继承上一场的那次时间戳')
  assert(/this\.cooldownOracleAt = Date\.now\(\)[\s\S]{0,80}const found = await this\.roundByBookmark\(anchors, true\)/.test(rp), 'D77c 先落时间戳再发问: 这一发要是抛了(风控高压下的常态), 没落账就是 30 秒后再撞一次 —— 5 分钟节奏必须由时间戳而不是由结果守住')
  assert(/if \(found !== null\) \{[\s\S]{0,300}sent = true/.test(rp) && (rp.match(/sent = true/g) || []).length === 2, 'D77d "读到"才算这一轮真发了请求: roundByBookmark 回 null 的那几条支路(没罐/探针节流)整轮零网络, 顶栏「上次拉取」不许被这种空转刷成刚刚(第二处 sent 是正常轮)', `实数=${(rp.match(/sent = true/g) || []).length}`)
  assert(/if \(found !== null\) \{[\s\S]{0,400}this\.cooldownUntil = 0[\s\S]{0,120}this\.errorStreak = 0/.test(rp), 'D77e 读通即当场解除退避: 冷却买的是"别再打了", 不是"打死也不听" —— 平台已经答话了还继续静默 1~15 分钟, 那段时间是白瞎的 158 个关注')
  assert(/const found = await this\.roundByBookmark\(anchors, true\)[\s\S]{0,400}this\.pandaLiveFound = found/.test(rp), 'D77f 在播数必须在 return 之前落到 pandaLiveFound: finally 那句 P.liveFound 读的就是这一枚, 漏了它顶栏就显示上一场的数(而且是"刚刚拉的"那一枚时钟下的上一场)')
  assert((bm.match(/if \(!oracleOnly\) this\.pandaOracle = 'list'/g) || []).length === 3 && /this\.pandaOracle = 'bookmark'/.test(bm), 'D77g 冷却探针不许把预言机记成 list: 那一轮根本没打过全站榜, 写了就是一个假读数(轮次摘要与顶栏都拿它说话)。' + "'bookmark' 那一支不加闸是故意的 —— 冷却轮真读到了整表", `三处闸=${(bm.match(/if \(!oracleOnly\) this\.pandaOracle = 'list'/g) || []).length}`)
  // 锚在"闸 + 它第一眼"上: 这个函数里 !oracleOnly 的块状写法有两处(上面 rows===null 那一处也长这样), 只认紧接着 const urgent 的那一处
  const fanIdx = bm.search(/if \(!oracleOnly\) \{\s*\r?\n\s*const urgent = missing\.filter/)
  const sessIdx = bm.indexOf('if (api.hasSession()) {')
  const fanout = bm.slice(fanIdx, sessIdx)
  assert(fanIdx > 0 && sessIdx > fanIdx && /this\.setIdleQueue\(missing/.test(fanout) && !/this\.pandaOracle/.test(fanout), 'D77h 扇出面(逐房 member/bj + 间隙泵快照)整块在 !oracleOnly 闸内, 而会话存续记账(sessionDeadStreak/cookieValid)两边都跑: 那一发 result:true 的整表就是活会话证据, 冷却轮没理由不为它记账', `闸=${fanIdx} 记账=${sessIdx}`)
  assert(!/if \(oracleOnly\) \{[\s\S]{0,120}return /.test(bm), 'D77i 早退式写法(if (oracleOnly) \{ pushAnchors; return \})不许回来: 它看着更干净, 但会把会话存续记账一起跳掉 —— 冷却轮读到整表却不再为"罐还活着"落笔, cookieValid 那一格就被这一轮自己说成没证据')
  // ---- D78 C2: 只落地零关注早退, 大厅年龄闸一笔撤销 ----
  assert(/if \(!anchors\.length\) \{[\s\S]{0,300}this\.cooldownUntil = 0[\s\S]{0,200}return/.test(rp), 'D78a 零关注 Panda 也早退(SOOP 那一条的孪生): 没有东西可失明, 连退避时间戳一起作废, 也不为一间不存在的房翻五页全站榜')
  assert(!/hallFetchedAt|lastListScanAt|listScanAge/.test(wt), 'D78b 大厅回落的"年龄闸"不许回来: 子间隔重读(用户立即刷新)可能真的携带新开播, 给回落加缓存买到的是漏检而不是省发')
  // ---- D79 C4: 刚添加的离线房当场进间隙泵 ----
  const ti = (() => {
    const i = wt.indexOf('trackIdle(platform: Platform, userId: string): void {')
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  })()
  assert(ti.length > 0 && /if \(platform !== 'pandalive'\) return/.test(ti) && /if \(!a \|\| a\.isLive \|\| this\.isGone\(a\)\) return/.test(ti), 'D79a 间隙泵补队按当下真值收口: 不在表里/已在播/查无此人一律不排, SOOP 那一侧根本没有这条泵(它的逐房探针每轮按游标重切整表)')
  assert(/this\.idleQueue\.some\([\s\S]{0,120}\)\)\s*return[\s\S]{0,120}this\.idleQueue\.unshift\(a\)/.test(ti), 'D79b 去重在排入之前、排的是队首: 这一间是用户刚点"添加"的, 与续扫游标那套"防尾部饿死"的公平账不冲突(游标只服务整批快照轮换)')
  assert(/watcher\.trackIdle\(plat, userId\)/.test(fl) && /else \{\s*\r?\n\s*\/\/ 未开播: 当场排进间隙泵队首/.test(fl), 'D79c 手工添加那一条接线: 在播走预取泵, 离线走间隙泵 —— 旧写法它要等下一轮才被 setIdleQueue 收进快照, 之后再排到几百间长的队尾')
  // ---- D80 C5: 自动录制不借用户快速道 ----
  const rc2 = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  assert(/const play = this\.auto\s*\r?\n\s*\? await sourceFor\(this\.platform\)\.getPlayCached\(this\.userId, this\.password\)\s*\r?\n\s*: await asUser\(/.test(rc2), 'D80a 首发取源按发起者分流: 手动那一条 asUser, 自动那一条走后台车道 —— 机器一开播批量起录时全员盖 userMark = 集体绕开按站节流, 恰在平台刚说"这人开播了"的时刻叠速')
  assert((rc2.match(/asUser\(\(\) =>/g) || []).length === 1, 'D80b 录制文件里用户级标记只有一处(首发), 判活与续录一律后台级: 第二处就是第二条插队路', `实数=${(rc2.match(/asUser\(\(\) =>/g) || []).length}`)
  // ---- D81 C7a: 强制刷新有 8 秒下限, 且只有真成功才落账 ----
  assert(/const PLAY_FRESH_MIN_MS = 8_000/.test(fl) && /const freshNow = !!fresh && !freshThrottled\(roomKeyStr\)/.test(fl), 'D81a 取流那一发补上下限(与 tick() 同一条 8 秒纪律): 它同时拿着 force、fullVariants、asUser 三重特权, 连点 N 下 = N 条完整取源链同时插队(SOOP 单链实测 8~10 发)')
  assert(/if \(!r\.ok\) \{[\s\S]{0,200}return[\s\S]{0,120}if \(freshNow\) markFreshTaken\(roomKeyStr\)/.test(fl), 'D81b 落账在失败早退之后、且只认"真强制取到源"那一发: 失败绝不闸掉下一次重试(源真死了再点一次永远照发), 而进房那一发(非强制)也不落账 —— 免得把手动刷新那个按钮闸成哑的')
  assert(/function markFreshTaken\(key: string\): void \{[\s\S]{0,300}freshTakenAt\.set\(key, Date\.now\(\)\)/.test(fl) && (fl.match(/freshTakenAt\.set\(/g) || []).length === 1, 'D81c 落账函数真的写那一笔且只有这一扇门: 这一格抓的是"只清扫不写入"的空转形状 —— 只做"超过 256 条就清扫"而一次 set 都没写, 节流永远读不到东西、整台闸空转', `写入点=${(fl.match(/freshTakenAt\.set\(/g) || []).length}`)
  // ---- D82 C7b: 播放器那三枚死旋钮 ----
  const hp2 = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'HlsPlayer.vue'), 'utf8')
  assert(!/manifestLoadingMaxRetry|levelLoadingMaxRetry|fragLoadingMaxRetry/.test(hp2), 'D82a 三枚 *LoadingMaxRetry 已从配置里删掉: hls.js 1.7.1 只在默认值表里留着这些旧名, 真正的预算来自 loadPolicy(清单 2 发/分片 4~6 发) —— 写在这里不生效, 只会骗到下一个人')
  assert(/loadPolicy/.test(hp2) && /const NET_RETRY_MAX = 3/.test(hp2), 'D82b 死字段撤了, 但"本层只管外层循环"这件事留在注释里, 且 NET_RETRY_MAX 那条真计数还在: 别让下一次审计再来装一遍这三个旋钮')
  // ---- D83 C8: 自录房排到预取队首 ----
  const ep2 = (() => {
    const i = wt.indexOf('private enqueuePrewarm(platform: Platform, userId: string): boolean {')
    const j = bodyEnd(wt, i)
    return wt.slice(i, j < 0 ? undefined : j)
  })()
  assert(/if \(a\?\.autoRecord\) q\.unshift\(userId\)\s*\r?\n\s*else q\.push\(userId\)/.test(ep2), 'D83a 自录房排队首: 队列排空要几分钟(实测 103 个房 ≈12 分钟), 排在尾巴上等于让录制自己等一整轮泵 —— 请求数一字不减, 只是把同一批发出的活排得更早(这是优先级调整, 不是减量)')
  // ---- D84 C6: 撤销的那一笔倒计时不许回来 ----
  assert(!/soopCooling/.test(wt) && !/watcher\.soopCooling/.test(fs.readFileSync(R('src', 'main', 'i18n.ts'), 'utf8')), 'D84a SOOP 冷却倒计时不设独立 key, 调用点一起不留: 退避只由 soopFailStreak>=2 武装, 武装那一轮写的 message 本就是 watcher.soopDown, 冷却整轮跳过 ⇒ 那句原样留在顶栏 —— 盲区不静默, 补一句只是把它说两遍(D55e 站的就是这一格)')
}

// ============================================================================
// D85~D90: 四张账各自到位之后, 把"同一件事打两遍"的剩下四处钉住
//   这一组没有新的判据, 只有把判据落到代码上: 主播状态读数该发的一发不少, 而"为已经拿到手的答案再买一遍"
//   (加房的 bj 两发)、"为十秒内刚读过的页面再买一整页"(取流复查)、"被拦下时反而换更贵的问法"(Panda 扇出面)、
//   "为没人等的秒开买整页"(SOOP 失明期预取) 四处各自收口, 外加一处完全隐形的读数面补留痕。
//   D86b 是负断言: 写过又撤掉的那一笔(bnoCache 的第三个写入点), 不许被当成缺陷再装回来。
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const fl = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const add = seg(fl, 'ipcMain.handle(CH.anchorsAdd,')
  // ---- D85: 加房那一发 member/bj 的 media 真值当场用掉 ----
  assert(/import \{ api, LiveItem, SESSION_PARTITION/.test(fl), 'D85a LiveItem 走类型导入而不是现场重新描述形状: media 那三格的判据必须与 applyBj 读同一份类型, 抄一份字段名就是给下一次改版留一处对不上的地方')
  assert(/const info = await api\.fetchBj\(userId\)[\s\S]{0,400}if \(info\.media\?\.isLive\) bjLive = info\.media/.test(add), 'D85b fetchBj 那一发顺带回来的整包在播读数被留下(旧写法只取 nick/userIdx/userImg 三格、把 media 整包丢掉)')
  assert(/isLive: isLive \|\| !!disc \|\| !!bjLive/.test(add) && /lastSeenAt: disc \|\| bjLive \? Date\.now\(\) : 0/.test(add), 'D85c 卡片按真值落库: 已在播的新房不再"离线落库 + 1.2 秒后对同一 userId 再发同一端点" —— 那第二发买的答案第一发已经拿在手里')
  assert(/if \(anchor\.isLive && cfg\.monitor\[anchor\.platform\]\.prefetchStream\)[\s\S]{0,200}else \{[\s\S]{0,300}watcher\.trackIdle\(plat, userId\)/.test(add), 'D85d trackIdle 只在"真没有数据"时走: 分支读的是落库后的 anchor.isLive, 不是那句 fetchBj 之前的局部量(补洞的条件跟着真值走, 不跟着猜测走)')
  assert((add.match(/api\.fetchBj\(/g) || []).length === 1, 'D85e 加房这一条链上 member/bj 只有一个调用点: 第二处就是那条重复本身', `实数=${(add.match(/api\.fetchBj\(/g) || []).length}`)
  // ---- D86: 复查那一页不再重买 + 场次号账本只有一个写入点 ----
  assert(!/seedBroadNo/.test(so) && !/seedBroadNo/.test(wt), 'D86a 第三个写入点不许回来: 探针那条路本来就走 readPageMeta, 号已经入账了 —— 再补一处是同一件事两处真值')
  assert((so.match(/this\.bnoCache\.set\(/g) || []).length === 2, 'D86b 场次号账本恰好两处写入(列表整表 + 任何一次真读到的页面): 少一处会漏掉一条来路, 多一处就是有两处各说各话', `实数=${(so.match(/this\.bnoCache\.set\(/g) || []).length}`)
  assert(/const m = await this\.fetchPageMeta\(channel, false, false, '取流复查'\)/.test(seg(so, 'async fetchPlay(')), 'D86c 取流复查吃微缓存: 它要的三个判据(在播/号码变没变/页面那句话)一页 HTML 里都齐, 而十秒内刚读过的那一页就是最新读数 —— fresh 把微缓存与在途合并一并绕过, 于是探针几秒前买过的那一页在这里被原样重买')
  // ---- D87: 风控账管到轮次扇出面 + 那一面从此有留痕 ----
  assert(/this\.pandaBlindStreak\+\+[\s\S]{0,200}风控冷却中: 本轮只发站内关注那一发/.test(seg(wt, 'private async roundPanda(')), 'D87a 冷却期读不到整表 = 收手而不是换问法, 且这一句必须出声: "被拦下"这件事在日志里过去完全隐形, 事后无人能解释那一轮为什么只有 1 发')
  assert(/降级轮留痕: 站内关注列表连续 \$\{this\.pandaBlindStreak\} 轮不可用, 本轮逐房复查 \$\{this\.pandaUrgentCnt\} 发 \+ 间隙泵快照 \$\{this\.idleQueue\.length\} 间在排队/.test(wt), 'D87b 降级轮的扇出面有数可核(连续轮数 + 两个扇出面的量): 口径抄 SOOP 那句降级探针回执 —— 只留痕不减发, 减发要先谈时效那笔账')
  assert((wt.match(/this\.pandaUrgentCnt = urgent\.length/g) || []).length === 2, 'D87c 两条逐房复查路(bookmark 的 rest / roundByList)都落这一个数: 只写一处会让留痕报"0 发"而实际吃满 —— 留痕报错了比不报更坏', `实数=${(wt.match(/this\.pandaUrgentCnt = urgent\.length/g) || []).length}`)
  assert(/if \(api\.oracleRiskCooling\(\)\) break\s*\r?\n\s*const a = this\.idleQueue\.shift\(\)!/.test(wt), 'D87d 间隙泵收手但不清队列: 熔断那一条清(它等的是整轮重排), 风控这一条等的只是 5 分钟, 把快照丢掉等于让恢复后的第一轮重新等一轮轮询。 它读的是整表那一格 —— 与轮次扇出同一把闸, 两条检测路要停一起停, 后台拉源撞的限流不许把它们闷掉')
  // ---- D88: SOOP 失明期的预取不为"没有号"买整页 ----
  const pp4 = seg(wt, 'private async pumpPrewarm(')
  assert(/if \(platform === 'soop' && this\.soopBlindStreak >= 3 && !soopApi\.hasBroadNo\(uid\)\) \{\s*q\.push\(uid\)/.test(pp4), 'D88a 门槛是"连续 3 轮整表失明"而不是"这一轮读不到": 一轮抖动就把预取关掉, 秒开要为它变慢一整场。跳过的写法是排回队尾(不作废)—— 检测面(每轮 ≤40 发整页)一发不少, 预取只是晚一场拿到号')
  assert(/if \(\+\+skippedNoBno >= q\.length\) break/.test(pp4), 'D88b 整条队列都是这一形状时出泵而不是原地空转: 泵拿的是入队那一刻的数组引用, 一直 shift/push 会把这一趟变成死循环')
  assert(/private soopBlindStreak = 0/.test(wt), 'D88c 失明连败计数住在 watcher(与降级留痕共用一本账), 不在 SoopApi 里再造一个: 两处计数会各报各的轮数')
  // ---- D89: SOOP 门槛回执账 ----
  assert(/private gates = new Map<string, \{ until: number; pack: PlayResult; code: string \}>\(\)/.test(so) && /private static GATE_TTL_MS = 15 \* 60_000/.test(so) && /private static GATE_TTL_MS = 15 \* 60_000/.test(pd), 'D89a 两站各有一本门槛账、同一档 TTL(两站同规约): 这一格连码一起存(与 Panda 的 D112q 同规约: 屏上 kind 与「重启后还挡着」都要查表, 不许从翻过语言的那句话反推)')
  assert((so.match(/this\.noteGate\(/g) || []).length === 2, 'D89b 只记两类不会自己好的回答("要登录且没托管账密" / "要密码而这一路没密码"): 密码不对下次可能改对、托管账号 60 秒后可能自愈, 把它们记账等于把可自愈的读数锁死在墙上', `实数=${(so.match(/this\.noteGate\(/g) || []).length}`)
  assert(/if \(!this\.canAutoRelogin\(\)\) this\.noteGate\(channel, pack\)/.test(so) && /private canAutoRelogin\(\): boolean \{\s*return Boolean\(secrets\.get\(CRED_USER\) && secrets\.get\(CRED_PASS\)\)/.test(so), 'D89c 托管账密在不在, 决定"要登录"是不是一条终局: 判据必须是这一个而不是"这次失败了几回"')
  const gp = seg(so, 'async getPlayCached(')
  const gateIdx = gp.indexOf('this.gates.get(channel)')
  const flyIdx = gp.indexOf('this.playInflight.get(key)')
  assert(gateIdx > 0 && flyIdx > gateIdx && /if \(g && g\.until > Date\.now\(\) && !password\) return \{ \.\.\.g\.pack \}/.test(gp), 'D89d 短路放在在途合并之前、且带密码来与手动强刷一律绕开: 排在后面的房该立刻拿到那一句"这房要密码", 而不是再去撞一条注定被拒的 9~10 发链(改一次密码就重新问一次平台)')
  assert(/this\.dropGate\(channel\)/.test(seg(so, 'invalidatePlay(')) && /this\.gates\.clear\(\)/.test(seg(so, 'clearPlayCache(): void {')), 'D89e 事件解除两条都在: 开播/作废/换号各自把账抹掉 —— 门槛账只许活到下一个事件, 否则"他刚开播"会被上一场的"取不到源"遮掉')
  // ---- SOOP 那本门槛账也落盘。下面五格与 Panda 侧的 D65f2/f3/f4/h + D112q 逐条成对,
  //      两站各写各的形状 = 下一次只改一边的老毛病(Panda 落盘那三格 SOOP 全无对应断言, 就是这么漏掉的) ----
  const hg = seg(so, 'private hydrateGates(): void {')
  const cpc = seg(so, 'clearPlayCache(): void {')
  assert(/private static GATE_PERSIST = \['pw', 'login'\]/.test(so) && (so.match(/store\.updateAnchor\('soop', channel, \{ gateCode: code/g) || []).length === 1 && /if \(SoopApi\.GATE_PERSIST\.includes\(code\)\) store\.updateAnchor\('soop', channel, \{ gateCode: code, gateUntil: until \}\)\s*else this\.dropPersistedGate\(channel\)/.test(so), 'D89f 落盘点唯一且门就是 GATE_PERSIST 那一列(与 Panda 的 D65f2 同形): 进账的两类都落盘 —— pw 是房间属性(主播设的密码, 重启不改), login 说的是"这一路没有登录态且没有托管账密可重登", 它唯一的翻面路径是登录而登录必过 clearPlayCache。不落盘的那一支必须走 dropPersistedGate(只清残留, 无账不写), 不然门开宽就等于把会自己翻的门槛钉在盘上')
  assert(/const until = Date\.now\(\) \+ SoopApi\.GATE_TTL_MS\s*const code = SoopApi\.gateKind\(pack\)\s*this\.gates\.set\(channel, \{ until, pack, code \}\)/.test(so) && (so.match(/needPassword \? 'pw' : pack\.needLogin \? 'login'/g) || []).length === 1, 'D89g 内存与盘写的是同一个 until(那把尺, 两站同规约), 且"两个布尔 → 码"全文件只有一处(gateKind): 从前 diag 里另抄了一份同样的三元, 两处一旦对不上, 屏上那格就说谎。写盘那一发省的正是"同一场连着两次冷启动"那 9~10 发/间 —— SOOP 被拒的那一句在整链第 3 步, 前两步已经花掉了, 比 Panda 那一发贵一个量级')
  assert(/\n {4}if \(this\.gatesHydrated\) return/.test(hg) && /if \(a\.platform !== 'soop' \|\| !a\.gateCode\) continue/.test(hg) && /const until = Math\.min\(a\.gateUntil \|\| 0, now \+ SoopApi\.GATE_TTL_MS\)/.test(hg) && /if \(until <= now\) \{\s*this\.dropPersistedGate\(a\.userId\)/.test(hg) && /const cur = this\.gates\.get\(a\.userId\)\s*if \(cur && cur\.until > now\) continue/.test(hg), 'D89h 读回四件: 只读一次(gatesHydrated)、分平台(两站同一个 userId 完全可能, 读串了就是拿一站的"过不去"去挡另一站的整条链)、盘上那个时刻钳到"从现在起最多一把尺"、到期就内存与盘一起清而不是留成永久挡; 内存里已有更新的一格不被旧的盘格覆盖(与 Panda 的 D65f4 同规约)。三处都钉到行首那一格 = 注释形变异也要红(那两刀第一轮就是那样溜过去的)')
  assert(/\n {6}this\.hydrateGates\(\)/.test(gp) && gp.indexOf('this.hydrateGates()') < gp.indexOf('this.gates.get(channel)'), 'D89h2 读回排在短路之前且在 !forceFresh 那一支之内: 放在短路之后就等于冷启动第一次仍然重打整链, 放在 forceFresh 那一头就是用户点"重新取源"时被旧账挡回去(手动那一发本来就不该被挡)。钉的是行首那一格 = 把它注释掉同样要红(变异刀 K5 第一轮就是注释形, 行为面红了而这一格绿着)')
  assert(/\n {8}if \(r\.ok\) this\.dropGate\(channel\)/.test(gp) && /\n {6}if \(a\.platform === 'soop' && \(a\.gateCode \|\| a\.gateUntil\)\) store\.updateAnchor\('soop', a\.userId, \{ gateCode: '', gateUntil: 0 \}\)/.test(cpc) && /\n {4}this\.gatesHydrated = false/.test(cpc) && cpc.indexOf("this.gates.clear()") < cpc.indexOf("a.platform === 'soop'") && cpc.indexOf("a.platform === 'soop'") < cpc.indexOf('this.gatesHydrated = false'), 'D89i 解除三条连着盘一起走(与 Panda 的 D65h 成对): 平台答应了当场撤两本(没有这一笔, 落了盘那一格就是单向棘轮 —— 用户充好登录/主播撤了密码, 短路口仍替他挡掉整条链)、换号逐行扫盘抹净、并把"读回一次"那面旗归位(读回的那本是上一号的), 旗子必须在扫盘之后归位(先归位再扫盘 = 中间那次取源仍读得到上一号的格)。三处都钉到行首那一格 = 注释形变异也要红(变异刀 K12 第一轮就是那样溜过去的: 它把那一行前面加了两个斜杠, 子串断言照样绿)')
  assert(!/persisted: false/.test(so) && /kind: g\.code, persisted: SoopApi\.GATE_PERSIST\.includes\(g\.code\)/.test(so) && !/pack\.error[^\n]*split\(':'\)/.test(so), 'D89j 诊断台 ⑫ 那一格从前对 SOOP 恒写 persisted:false —— 落盘之后这就是假读数(盘上明明有一格而屏上说"只活在内存")。kind 取的是记账那一次映射好的码, 反推那句话那条路在这份源码里仍然不存在(D112q2 的 SOOP 侧)')
}

// ============================================================================
// (~): 风控账收下业务码那句限流 · 账分两格 · 预取认"正在判下播" · 失明改口 covered===0 · 降级轮在界面上持续说话
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const tn = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const segP2 = (decl) => seg(pd, decl)
  // ---- D90: 那句「请求太多」进门, 但只让它自己那一格说话 ----
  assert(/private static isRateLimitMsg\(msg: string\): boolean/.test(pd) && (pd.match(/PandaApi\.isRateLimitMsg\(/g) || []).length === 3, 'D90a 限流话术的判据只定义一处、消费三处(bj / 关注列表 / play 三个 result=false 出口): 判据散开写就会有一处漏掉某种语言', `实数=${(pd.match(/PandaApi\.isRateLimitMsg\(/g) || []).length}`)
  assert(/너무 많은 요청\|too many requests\|rate\.\?limit\|请求过多\|请求太频繁\|слишком много запросов/.test(pd), 'D90b 词表按现场样本起步并覆盖四语(韩/英/中/俄): 现场那句「너무 많은 요청이 발생했습니다」配的正是 HTTP 200, 旧账本只读状态码 ⇒ 平台亲口喊停的这一刻一条都不记')
  assert(/private oracleRiskUntil = 0/.test(pd) && /oracleRiskCooling\(\): boolean \{\s*return Date\.now\(\) < this\.oracleRiskUntil/.test(pd) && /if \(PandaApi\.isOraclePath\(path\)\) this\.oracleRiskUntil = Date\.now\(\) \+ PandaApi\.RISK_COOL_MS/.test(segP2('private noteRisk(')), 'D90c 账分两格(分两格的核心): 总账抬时间戳, 只有整表那一发的路径才顺带抬整表格 —— 一轮记账把两条检测路一起闷掉, 正是用户 2026-10-03 那笔拍板拒绝的那笔交易(「只把账说出来, 不减发」)')
  assert(/return path === '\/v1\/live\/bookmark' \|\| path === '\/v1\/live' \|\| path\.startsWith\('\/v1\/live\?'\)/.test(pd), 'D90d 整表路径族的判据是三条精确式而不是 /v1/live 前缀: 前缀会把 /v1/live/play(逐房拉源)一起圈进来 —— 那正是这一格必须放过的那一发')
  assert((pd.match(/this\.noteRisk\([^)]*\)\s*\n\s*throw new RiskError/g) || []).length === 6 && /if \(PandaApi\.isRateLimitMsg\(j\.message \|\| ''\)\) this\.noteRisk\(`关注列表限流话术/.test(segP2('async fetchBookmarks(')) && /if \(PandaApi\.isRateLimitMsg\(msg\)\) this\.noteRisk\(`拉源限流话术/.test(segP2('async fetchPlay(')), 'D90e 两处"降级而不抛"的出口(play 回一句话 / 关注列表回 null)也记账, 但各自仍按原契约返回: 记账不许改变调用方看到的东西 —— 关注列表那句连未登录都不记(死会话期的逐房复查是检测路径本身), 只有那句限流才记')
  assert(/this\.riskUntil = 0/.test(segP2('clearPlayCache(): void {')) && /this\.oracleRiskUntil = 0/.test(segP2('clearPlayCache(): void {')), 'D90f 换号两格一起撤: 上一号的风控静默与"整表那一发被拒"对这一个账号都毫无意义(与 SOOP/D74i 同语义)')
  assert(/if \(platform === 'pandalive' && api\.riskCooling\(\)\) \{\s*q\.length = 0/.test(seg(wt, 'private async pumpPrewarm(')), 'D90g 总账的消费端没被搬走: 预取泵(买 2~6 发链换"秒开", 没有人在等)继续读总账 —— 分家只把两条检测路挪去读整表格, 后台的便利面一格都没松')
  // ---- D91: 预取泵认"正在判下播"那张表 ----
  assert(/private offlinePending\(a: Anchor\): boolean \{\s*const at = a\.offlinePendingAt \|\| 0\s*return at > 0 && Date\.now\(\) - at <= OFFLINE_PENDING_FRESH_MS/.test(wt) && !/OfflineStreak/.test(wt) && /offlinePendingAt\?: number/.test(ty), 'D91a 判据借的还是"待第二轮确认"那一本账, 只是把它从两本进程内存表搬进了锚点行(types 里那一格 = 落库位置, 两本 Map 一根都不留): 内存表买不到跨重启, 而重启正是现场丢账那一次(06:58 报下播 → 07:04 起来)')
  assert((seg(wt, 'private enqueuePrewarm(').match(/this\.offlinePending\(a\)/g) || []).length === 1 && (seg(wt, 'private async pumpPrewarm(').match(/this\.offlinePending\(a\)/g) || []).length === 1 && !/offlinePending/.test(seg(wt, 'private async pumpIdle(')) && !/offlinePending/.test(seg(wt, 'private async roundSoop(')), 'D91b 这一格只挡预取那两条(入队 + 出队), 检测面一条都不用它收手: 间隙泵与降级探针要的就是"第二轮那发读数", 挡它等于把下播判定本身压慢一轮(实数 入队=' + (seg(wt, 'private enqueuePrewarm(').match(/this\.offlinePending\(a\)/g) || []).length + ' 出队=' + (seg(wt, 'private async pumpPrewarm(').match(/this\.offlinePending\(a\)/g) || []).length + ')')
  assert(/if \(this\.offlinePending\(a\)\) \{\s*q\.push\(uid\)[\s\S]{0,120}if \(\+\+skippedPending >= q\.length\) break/.test(seg(wt, 'private async pumpPrewarm(')), 'D91c 出队那一头是排回队尾而不是作废(与 D88a 同规约) + 独立计数出泵: 第二轮若真读回在播(瞬回离线的抖动), 那一格一清下一趟泵照买 —— 秒开只是晚一场, 不会被一次抖动永久摘掉')
  assert(/if \(this\.enqueuePrewarm\(platform, a\.userId\)\) queued\+\+/.test(seg(wt, 'private prewarmSweep(')), 'D91d 补扫那句「N 个在播房排队」按入队返回值计数: 上一版是无条件 ++, 于是被密码房/重复项挡下的也算进去了 —— 留痕报错了比不报更坏')
  // ---- D92: 失明判据从 rows===null 改口 covered===0 ----
  assert((wt.match(/const covered = anchors\.length - probe\.length/g) || []).length === 1 && seg(wt, 'private async roundSoop(').indexOf('const covered =') < seg(wt, 'private async roundSoop(').indexOf('let fail = 0'), 'D92a covered 只算一次且早于探针循环: 失明判据、留痕、allFail 三处读同一个数 —— 两处各算一遍就是两本账(实数=' + (wt.match(/const covered = anchors\.length - probe\.length/g) || []).length + ')')
  assert(/this\.soopBlindStreak = covered === 0 && anchors\.length/.test(wt), 'D92b 失明计数的判据换的是"列表对我覆盖了几房", 不是"接口有没有回东西": 现场那个形状(整表读通、我的关注一个不在)过去永远不记, 于是那道闸门从不落地')
  assert(/const allFail = anchors\.length > 0 && covered === 0/.test(wt) && /if \(this\.soopFailStreak >= 2\) this\.soopCooldownUntil = Date\.now\(\) \+ Watcher\.SOOP_COOLDOWN_MS/.test(wt) && (wt.match(/rows === null/g) || []).length === 1, 'D92c 只改判据不碰收手面: allFail/连败/冷却三条一条没动, 而 SOOP 那两处 rows===null 都改了口(整本只剩 Panda 侧 roundByBookmark 那一处"有没有列表"的原始语义) —— 这一笔买到的不是减量, 是让那道既有闸门第一次真落地', `残留=${(wt.match(/rows === null/g) || []).length}`)
  // ---- D93: 已买档位的复用账 ----
  // 写入点从 1 个变成 2 个: 第二个是 ①补 的复活递账。计数从"一个"改成"两个"不是放宽断言,
  // 而是这本账多了一条来源; 判据没变(只记无密码买回的档), 所以两条各钉各的: 省发链那一条仍由 D93c 钉原句。
  assert(/private partialBuy = new Map<string, \{ bno: string; bought: \{ name: string; variant: VariantInfo \}\[\] \}>\(\)/.test(so) && (so.match(/this\.partialBuy\.set\(/g) || []).length === 2 && /if \(!sp\.isPw && sp\.tiers\.every\(\(t\) => !!t\.name\)\) this\.partialBuy\.set\(channel, \{ bno: sp\.bno,/.test(so), 'D93a 复用账的写入点是两个(省发型链 + 跨重启复活递账), 两条都不许记带密码买回的那一档: 预取泵永远没有密码, 而这一格按频道记账 —— 密码不同就是不同的房; 多一个来源必须多钉一条同判据, 少一句 !sp.isPw 就是"主播中途关掉口令"时白捡别人用密码换来的档位', `写入=${(so.match(/this\.partialBuy\.set\(/g) || []).length}`)
  assert(/const e = this\.partialBuy\.get\(channel\)\s*\r?\n\s*if \(e && e\.bno === info\.broadNo\)/.test(so) && /if \(allPresets\.findIndex\(\(p\) => p\.name === b\.name\) !== reuse\.length\) break/.test(so), 'D93b 复用判据是场次而不是时间, 且只对"前缀对得上"的那一段负责: aid/签名地址在同一场内本来就长效(与 playCache"只认显式作废"同规约); 平台中途换菜单名字时对不上的那档就当没买过、照买')
  assert(/if \(!fullVariants && !password && allPresets\.length > 1\) this\.partialBuy\.set\(channel, \{ bno: info\.broadNo, bought \}\)/.test(so) && /if \(fullVariants\) this\.partialBuy\.delete\(channel\)/.test(so), 'D93c 记账只记"真省下来的那几发", 满档链落地即摘账: 留着它下一场对不上号是必然, 而缓存此时已经不缺档 —— 一本只增不减的账早晚会骗人')
  assert(/this\.partialBuy\.delete\(channel\)/.test(seg(so, 'invalidatePlay(')) && /this\.partialBuy\.clear\(\)/.test(seg(so, 'clearPlayCache(): void {')), 'D93d 事件解除两条都在(与门槛账 D89e 同规约): 开播/作废/收尸抹这一房, 换号抹整本 —— 上一号买过的档对这一个账号不成立')
  assert(/const variants: VariantInfo\[\] = reuse\.map\(\(b\) => b\.variant\)/.test(so) && (so.match(/reuse\.length \? ` 复用已买档=/g) || []).length === 1, 'D93e 复用那份从数组头接起(菜单顺序即档位顺序, variants[0] 恒为最高档), 且省下的发数要写进成功日志: 事后数包的人必须能一眼看出"这一条链少打了 2 发"')
  // ---- D94: 降级轮在界面上持续说话(只报账, 不减发) ----
  assert(/private pandaDegradeWhy\(\): string \{\s*if \(!api\.hasSession\(\)\) return mt\('watcher\.degradeNoLogin'\)\s*if \(!api\.cookieValid\) return mt\('watcher\.degradeSessionDead'\)/.test(wt) && !/await|this\.json|fetch/.test(seg(wt, 'private pandaDegradeWhy(')), 'D94a 归因三条各说一句(未登录 / 会话被服务端作废 / 风控·改版)且判据全是客户端已有的读数: 现场那句「cookie=30 枚 会话=有 官方校验=未登录」正是中间这一条 —— 为归因再发一发就是新增请求面')
  assert(/degradeMsg = mt\('watcher\.degraded', \{[\s\S]{0,240}r: this\.pandaUrgentCnt,[\s\S]{0,60}q: this\.idleQueue\.length/.test(seg(wt, 'private async roundPanda(')) && /P\.message = degradeMsg/.test(wt), 'D94b 界面上那一行报的是刚刚这一轮的账(连续轮数 + 归因 + 两个扇出面的量): 日志里那句留痕只有翻日志的人看得见, 而这一面在现场挂了 40 分钟无人知情')
  assert(/P\.degraded = Boolean\(degradeMsg\)/.test(wt) && /P\.degraded = true/.test(wt) && /P\.degraded = false/.test(wt), 'D94c 降级旗与那一行同一个来源(每轮重算 + 预言机读通当场摘): 顶栏那一格若停在上一场的状态, 就是"绿点骗人"的另一种写法')
  assert(/degraded: boolean/.test(ty) && /w\.degraded\) return \{ tone: 'warn', text: t\('nav\.wDegraded'\)/.test(tn), 'D94d 读数面一条都不新增: 复用平台状态里那一个 message 字段所在的两处既有承载(工作区横幅 + 顶栏胶囊), 胶囊只为它换一个不撒谎的词(「本轮失败」是读不到的口径, 降级轮读得到)')
}

// ============================================================================
// (A): 降级轮在工作区也给一条出路 —— 「去登录」不再只跟熔断旗
// ============================================================================
{
  const wv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const zh = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
  const en = fs.readFileSync(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'), 'utf8')
  // ---- D95 那颗按钮的口径 = 「这一轮要你去修会话」的两种形状, 而不是只有熔断那一种 ----
  assert(/v-if="store\.watcher\.byPlatform\[plat\]\.circuitOpen \|\| store\.watcher\.byPlatform\[plat\]\.degraded"/.test(wv), 'D95a 「去登录」跟 circuitOpen 或 degraded: 新举的那面旗讲的正是"预言机读不通、正在逐房兜底"—— 那句归因当时看得到, 那条出路却按旧口径藏着, 死会话的 40 分钟里用户被留在"只有一句话"的界面上')
  assert(/P\.degraded = true/.test(wt) && /degraded: boolean/.test(ty), 'D95b 前提自证: 这一面旗真的有人举、类型里真的有这一格 —— 否则 D95a 锁的是任何构建都走不到的条件(负向断言恒绿的同一课,)')
  assert((wv.match(/t\('ws\.gotoLogin'\)/g) || []).length === 2 && /v-if="store\.watcher\?\.byPlatform\?\.\[plat\]\?\.message"/.test(wv), 'D95c 出路仍只有既有那两颗(没会话的空态 + 本平台那一行横幅), 这一格只改了横幅这一颗的触发条件: 新增一面旗不该再多长出一个读数面("读数面一条都不新增"在这一笔里继续成立)', `实数=${(wv.match(/t\('ws\.gotoLogin'\)/g) || []).length}`)
  assert(/:class="store\.watcher\.byPlatform\[plat\]\.circuitOpen \? 'text-liveink' : 'text-warnink'"/.test(wv), 'D95d 颜色口径不动: 熔断是被拒答(红), 降级仍在逐房读得到(琥珀)—— 只有"要不要给出路"这一格跟着 degraded 走, 严重度不许被一次按钮改动顺带抹平')
  assert(/gotoLogin:/.test(zh) && /gotoLogin:/.test(en), 'D95e 文案零新增(zh/en 沿用既有那一条「去登录」): 一颗按钮两种触发不需要两句话')
}

// ============================================================================
// 冷启动留下的旧账 · 登录态核对那两行的缓存标记 · 预取队列的排序
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const bs = seg(wt, 'private staleOnFirstLook(')
  const st = seg(wt, 'private settleStaleOffline(')
  // ---- D96 陈旧基线: 豁免的只有"那场下播的通知", 翻转/作废/两轮防抖一条不动 ----
  assert(/return !pending && a\.lastSeenAt > 0 && Date\.now\(\) - a\.lastSeenAt > 2 \* this\.intervalFor\(platform\)/.test(bs), 'D96a 判据三格都在(加了第一格): 先看"这一轮的账上是不是还差第二次确认"(没排进防抖才谈豁免), 阈值跟着 intervalFor 走而不是钉常量(intervalFor 只剩"各自那一格"一条规则, 熔断期不再把 2×轮距 压成 60 秒 —— 见 D104), 且 lastSeenAt=0 不算陈旧 —— 这一格判的是"证明它旧", "没记过"证明不了任何事, 证不出来就维持两轮')
  assert(!/await|fetch|sourceFor\(|api\./.test(bs), 'D96b 判这一件事不发任何请求: 读的全是卡片上已有的 lastSeenAt 和行上那"待第二轮确认"的一格 —— 为"要不要免掉一次通知"再发一发, 就把这一笔做成了新增请求面')
  assert((wt.match(/this\.staleOnFirstLook\(/g) || []).length === 4, 'D96c 四条会读"报离线"的面都在(预言机整表 / 逐房 applyBj / SOOP 整表 / SOOP 整页探针): 只免一条就是同一份旧账在两条链上两种说法(实数=' + (wt.match(/this\.staleOnFirstLook\(/g) || []).length + ')')
  assert(/store\.updateAnchor\(a\.platform, a\.userId, this\.offPatch\(a, \{ lastSeenAt: now, offlinePendingAt: 0 \}\)\)\s*sourceFor\(a\.platform\)\.invalidatePlay\(a\.userId\)/.test(st) && !/onLiveEnd/.test(st), 'D96d 状态照翻、旧源照作废、只有那场"下播"不报: offPatch 保留房态/场次的分档口径, 留着死源只会挂着「秒开」徽标骗人; 这一支还把行上那一格写 0 —— 静默翻完就不许再留"还差第二轮"的活账')
  assert((wt.match(/if \(!pending\) \{/g) || []).length === 3, 'D96e 新基线的两轮防抖一条不减(三处排第一轮的面都在: 预言机整表 / SOOP 整表 / SOOP 整页探针): 这一笔豁免的是"那场结束时我们根本没在场", 不是"离线的抖动不拦了"', `实数=${(wt.match(/if \(!pending\) \{/g) || []).length}`)
  assert((wt.match(/const pending = this\.offlinePending\(a\)/g) || []).length === 3 && /const pending = this\.offlinePending\(a\)\s*if \(this\.staleOnFirstLook\(a, a\.platform, pending\)/.test(wt) && (wt.match(/store\.updateAnchor\(a\.platform, a\.userId, \{ offlinePendingAt: now \}\)/g) || []).length === 3, 'D96f 豁免的门槛读的就是那本"待第二轮确认"的账, 这一本从此写在锚点行上: 三处排轮的那一句写的都是这一行的 offlinePendingAt(pending>0 ⇒ 这一发就是确认轮, 走 onLiveEnd), 而豁免那一支不再靠"顺手清内存"来兜正(旧写法那本内存表 + 只看时间 = 把稳态的下播通知整条吞掉的帮凶, 而且重启一次就账销), 实数 读=3 写=3')
  assert(/const minutes = Math\.min\(15, 2 \*\* Math\.min\(4, this\.errorStreak - 1\)\)/.test(wt) && /this\.cooldownUntil = 0\s*this\.errorStreak = 0\s*P\.circuitOpen = false/.test(wt) && /冷却期预言机读通: 退避提前解除/.test(wt), 'D96g P0 退避阶梯的现状钉在源码上(用户 2026-10-03 拍板: 维持现状不改): 指数段与 15 分钟上限都在, 而冷却期那一发预言机读通时把三格一起清零 ⇒ 阶梯顶在第二级。清零那一句按它们在源码里的相邻形状锁(旧写法只查"roundPanda 里有 errorStreak = 0", 而那个函数里本来就有两处, 砍掉这一句照样绿), 行为取证在 verify-playcache T53, 这一格守的是"改它必须是有意的"')
  // ---- D97 登录态核对那两行: 把"这一句是真发的还是缓存里读的"写进留痕 ----
  assert(/fromCache\?: boolean/.test(pd) && /fromCache\?: boolean/.test(so), 'D97a 两站的 login_info 应答契约各加这一格(可选): 缺席 = 真发, 老调用点不必改也能读对 —— 这一行日志每取一次态就落一行, 不吃掉缓存就会把 2 发数成 6 发')
  assert(/return \{ \.\.\.hit\.info, fromCache: true \}/.test(seg(so, 'async verifyLogin(')) && /return \{ \.\.\.this\.loginInfoCache\.info, fromCache: true \}/.test(seg(pd, 'async checkLoginInfo(')), 'D97b 缓存命中那两条出口只多挂一面旗, 内容原样展开: 加标记不许改变调用方读到的任何一格(与 D90e"记账不许改变返回契约"同规约)')
  assert((ip.match(/官方校验\[\$\{verify\}\]/g) || []).length === 2 && /let verify: '真发' \| '缓存' \| '合并' \| '未问' = '未问'/.test(ip) && /const verify = !hasCookies \? '未问' : /.test(ip), 'D97c 两行日志各带这一格, 且"没问"(匿名态压根不发那一发)与"缓存"(问了但没出门)是分开的两种: 合并成一格就分不清"这一行没有真发"和"这一行根本没人答"(这一串是四档, 逐档映射与互斥口径由 D102 钉)')
  assert((ip.match(/api\.checkLoginInfo\(\)/g) || []).length === 1 && (ip.match(/soopApi\.verifyLogin\(\)/g) || []).length === 1 && !/fromCache/.test(ty), 'D97d 发数一字未改(两处调用点各一个, 没有为标记补第二问), 且缓存标记不进 IPC 契约: 它只是日志的自证, 界面读的是 lastVerifyAt 那一格')
  // ---- D98 预取队列按观众数排队: 改的是顺序, 不是发数 ----
  const ps = seg(wt, 'private prewarmSweep(')
  assert(/\.sort\(\(x, y\) => \(y\.viewerCount \|\| 0\) - \(x\.viewerCount \|\| 0\)\)/.test(ps), 'D98a 排队顺序 = 观众数降序(队首那间就是最可能被人点的那间): 队列排空要几分钟(实测 103 房 ≈12 分钟), 旧写法按库里加的先后排 ⇒ 大房还没排到就散场')
  assert(/\.filter\(\(a\) => a\.platform === platform && a\.isLive && !this\.isGone\(a\) && !cached\.has\(roomKey\(platform, a\.userId\)\)\)/.test(ps), 'D98b 入围条件与排序写在同一句里且一条没放宽: 平台/在播/未判死/手上已有有效源四条还是那四条 —— 排序若顺手改了过滤, 这一笔就变成拿秒开换发数')
  assert(!/\.sort\(/.test(seg(wt, 'private async pumpPrewarm(')) && /if \(a\?\.autoRecord\) q\.unshift\(userId\)/.test(seg(wt, 'private enqueuePrewarm(')), 'D98c 排序只住在补扫这一处(泵按 shift 消费, 顺序由入队定), 且自录房那条插队仍在最前: 观众数排不到"开播就得有源"前面(这一笔不覆盖排序那条规约)')
  assert(/首轮后补预取: \$\{queued\} 个在播房排队\(按观众数从高到低\)/.test(ps), 'D98d 留痕写明这一批是按什么排的: 事后数包的人看见 22 发整页时, 必须能一眼看出这是顺序策略而不是又一批重复请求')
}

// ============================================================================
// A1: 陈旧基线那条豁免只给「第一次读到离线」那一轮
// (修好落地后在稳态把下播通知整条吞掉 —— 实测 0 条 vs 落地前 168 条, 中途 5/5 全中)
// ============================================================================
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  assert(/private staleOnFirstLook\(a: Anchor, platform: Platform, pending: boolean\): boolean \{\s*return !pending && a\.lastSeenAt > 0/.test(wt), 'D99a 短路顺序是先读账、再看表: "没排进防抖"排在时间判据之前 —— 只补注释不挪格子没用, 稳态第二轮到达时年龄那一格必然为真(两轮防抖自己保证它超过 2×轮距)。 这一格从此是布尔(那一本账落在行上, 读得出"排没排过", 不再数第几轮)')
  assert(/稳态的下播通知整条吞了[\s\S]{0,600}168 条/.test(wt), 'D99b 这一改判的两个实测数留在判据自己的注释里(5/5 与 0 vs 168): 谁要把"只看时间"简化回去, 先要撞见这份读数 —— 与 D96g「改它必须是有意的」同规约')
  assert(/if \(this\.staleOnFirstLook\(a, 'pandalive', this\.offlinePending\(a\)\)\)/.test(wt) && /this\.offPatch\(a, \{ offlinePendingAt: 0 \}\)\)\s*this\.onLiveEnd\(a\)/.test(wt), 'D99c 逐房 member/bj 那一支(它自己不走两轮, 一发就宣判)读的也是同一本账: 同一间若已被预言机排进「待第二轮确认」, 这一发读数就是确认轮, 通知照发 —— 两条链共用一本账才不会同一场两种说法。 这一支宣判完必须就地销账: 旧的内存表在这一条上从不删键(键留着 = 下一场的第一轮离线被当作第二轮直接宣判), 而落在行上的账不清就会一路活到下次重启')
  assert((wt.match(/this\.offlinePending\(a\)/g) || []).length === 6 && !/OfflineStreak|awaitingOffline/.test(wt), 'D99d 豁免门槛、防抖计数、预取泵的「正等第二轮」读的是同一个函数、同一本行上的账(四个判离线的面 + 预取那两条), 没有平行计数器也没有旧表残留: 「免一次通知」与「不为这一间买秒开」永远说同一个状态(实数 读=' + (wt.match(/this\.offlinePending\(a\)/g) || []).length + ' 残留=' + (wt.match(/OfflineStreak|awaitingOffline/g) || []).length + ')')
  assert(/const OFFLINE_PENDING_FRESH_MS = 10 \* 60_000/.test(wt) && /return at > 0 && Date\.now\(\) - at <= OFFLINE_PENDING_FRESH_MS/.test(wt) && /两头/.test(wt), 'D99f 落库那一格带新鲜上限而不是无限作数, 且上限的来源写在旁边: 没有它, "隔夜留下的 pending"就会被下一轮当"已经排过一轮"直接宣判 —— 那正是"停摆期间的散场不许冒充现值"这条规矩要防的那件事; 有它, 6 分钟的停摆(现场实测)照修而 8 小时的停摆照旧静默。行为取证 verify-playcache T57-2(跨重启发通知)与 T57-6(隔夜不发)', `上限=${/OFFLINE_PENDING_FRESH_MS = (\d+)/.exec(wt)?.[0]}`)
  const ty99 = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  assert((ty99.match(/offlinePendingAt\?: number/g) || []).length === 1 && (wt.match(/offlinePendingAt/g) || []).length === 11 &&
    !/offlinePendingAt/.test(fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')) && !/offlinePendingAt/.test(fs.readFileSync(R('src', 'main', 'services', 'store.ts'), 'utf8')),
    'D99g 契约面只有一格、消费全在一个文件: Anchor 上是可选的(旧库没这一格 = "从没排过第二轮", 语义正好, 所以 migrateAnchor 一条都不用加 —— 换成必填才需要迁移), 而 IPC/store 都不认它 —— 落库不等于对外契约, 界面不读它就不会有人把它当现值读(实数 types=1 watcher=' + (wt.match(/offlinePendingAt/g) || []).length + ')')
  assert((wt.match(/baselineStale/g) || []).length === 0, 'D99e 旧名一条不剩: 只看时间那一版整条换掉而不是并存一份 —— 名字就是判据, 现名 staleOnFirstLook 写的是「第一次看到它报离线」而不是「隔了很久」')
}

// ============================================================================
// A2: 播放器亲证死源 ⇒ 当场作废的只有"那一份源包", 不是那几本防重复的账
// (现场 2026-10-03 23:33:38 @kurzzang123: 播放器已拿到 manifestLoadError http=404, 主进程那份缓存却到
//  23:38:52 才被保活的双测追认 —— 5min14s 里卡片一直挂着「秒开」, 而 Panda 的地址不过本地代理, 渲染层是唯一证人)
// ============================================================================
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const sc = fs.readFileSync(R('src', 'main', 'services', 'source.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const pr = fs.readFileSync(R('src', 'preload', 'index.ts'), 'utf8')
  const pv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const dso = seg(so, 'dropCachedPlay(channel: string, provenDeadUrl')
  const dpd = seg(pd, 'dropCachedPlay(userId: string, provenDeadUrl')
  // ---- D100a 契约: 这一格与 invalidatePlay 是两口, 并存而不是改名 ----
  assert(/dropCachedPlay\(id: string, provenDeadUrl\?: string\): boolean/.test(sc) && /invalidatePlay\(id: string\): void/.test(sc), 'D100a RoomSource 里新增的是第六口且与 invalidatePlay 并存(返回 boolean 是给日志说实话的那一格): 事件作废(重开播/收尸/换号)与"亲证这一份死了"是两件事, 合成一口就必然有一边做错')
  assert(/dropCachedPlay\(channel: string, provenDeadUrl\?: string\): boolean/.test(so) && /dropCachedPlay\(userId: string, provenDeadUrl\?: string\): boolean/.test(pd), 'D100b 两站都实现且签名一致(source.ts 的契约不是装饰): 少一站就是那一站继续说假话')
  // ---- D100c 窄的那一面: 除源包与广播, 防重复的账一条不碰 ----
  assert(dso && !/bumpEpoch|dropGate|gates\.|partialBuy|deadStreak|playInflight/.test(dso) && /this\.playCache\.delete\(channel\)/.test(dso) && /broadcastSrcCache\(\)/.test(dso), 'D100d SOOP 那一口只删 playCache + 广播: 门槛账与本场已买档与纪元一条不动 —— 源包死了不等于"平台那句话"作废, 跟着撤就是让下一次问价重打整链(加请求, 与用户口径相反; H6a/N1g/N1i 是这一条的行为面)')
  assert(dpd && !/bumpEpoch|gates\.|keepaliveInfo|playInflight/.test(dpd) && /this\.playCache\.delete\(userId\)/.test(dpd) && /this\.pushSrcCache\(\)/.test(dpd), 'D100e Panda 那一口同规约(它没有买档账, 有门槛账与保活读数两本): 保活读数被顺手清会让播放页那格"上次保活成功于…"当场改口成没保过 —— 那不是这一句报案该说的话')
  // ---- D100f 亲证地址那一格: 报的不是手里这份就不许摘 ----
  assert(/if \(provenDeadUrl && pack\.m3u8 !== provenDeadUrl && !pack\.variants\?\.some\(\(v\) => v\.url === provenDeadUrl\)\)\s*return false/.test(dso) && /if \(provenDeadUrl && pack\.m3u8 !== provenDeadUrl && !pack\.variants\?\.some\(\(v\) => v\.url === provenDeadUrl\)\)\s*return false/.test(dpd), 'D100g 两站都对一遍地址(m3u8 或任一变体, 与 onUpstreamDead 认源同一判据): 播放器停在别的档位上/手里这份早被换过时, 摘错=白删一次好秒开(T54-2/N1b 行为面)')
  // ---- D100h 强制重取没拿到源那一支 ----
  assert(/const t0 = Date\.now\(\)/.test(so) && /const t0 = Date\.now\(\)/.test(pd) && /if \(cur && \(cur\.fetchedAt \|\| 0\) < t0\)/.test(so) && /if \(cur && \(cur\.fetchedAt \|\| 0\) < t0\)/.test(pd), 'D100i 作废的是"这条链出发之前"那一份: 在飞窗口里另一把键(带密/满档)落回来的新源不许顺手摘(那时说谎的不是它)(M3 变异由 N3c/T54b-9 接住)')
  assert((so.match(/\} else if \(forceFresh && !r\.ok && !r\.needPassword\) \{/g) || []).length === 1 && (pd.match(/\} else if \(forceFresh && !r\.ok && !r\.needPassword\) \{/g) || []).length === 1, 'D100j 两处都排除 needPassword(各一处, 不多不少): 那句说的是"这次没带密码"而不是"源死了", 拿它当证据会把还能用的那份撤掉(M4 变异由 N4c/T54b-2 接住)')
  assert(/this\.dropCachedPlay\(channel\)/.test(seg(so, 'async getPlayCached(')) && /this\.dropCachedPlay\(userId\)/.test(seg(pd, 'async getPlayCached(')) && !/this\.invalidatePlay\(/.test(seg(so, 'async getPlayCached(')) && !/this\.invalidatePlay\(/.test(seg(pd, 'async getPlayCached(')), 'D100k 取流缓存这一支只叫窄作废, 全程不出现 invalidatePlay: 宽作废是事件(重开播/收尸/换号/录制出错)的用语, 一次失败的重取不是事件')
  // ---- D100l IPC 三件套 + 边界收敛 ----
  assert(/liveSrcDead: 'live:src-dead'/.test(ty) && /liveSrcDead\(platform: Platform, userId: string, deadUrl\?: string\): Promise<boolean>/.test(ty) && /liveSrcDead: \(platform: Platform, userId: string, deadUrl\?: string\): Promise<boolean> =>\s*ipcRenderer\.invoke\(CH\.liveSrcDead/.test(pr), 'D100m 通道/桥面/预载三处一字不差地配套(缺任何一处就是渲染层那句判决永远到不了主进程): Panda 的地址不过代理, 没有这一条链路时主进程连"有人踩过 404"都不知道')
  {
    const h = seg(ip, 'ipcMain.handle(CH.liveSrcDead')
    assert(/if \(roomErr\(platform, userId\)\) return false/.test(h) && /dropCachedPlay\(String\(userId\), dead \|\| undefined\)/.test(h) && !/invalidatePlay/.test(h), 'D100n handler 先过房间入参那道边界闸(它拿的是渲染层递进来的两个字符串), 只调窄作废: 边界校验与作废宽度是两件独立的事, 少一件都是把这一口开成后门')
    assert(/typeof deadUrl === 'string' \? deadUrl\.slice\(0, 500\)\.replace\(\/\[\\u0000-\\u001f\\u007f\]\/g, ''\)/.test(h) && !/\$\{dead\}|\$\{deadUrl\}/.test(h), 'D100o 亲证地址按 safePwd 那把尺收(截 500 + 去控制字符)且不进日志(日志只要结论, 不要载荷): 那串里带着会话签名, 而 \r\n 放进去就是日志伪造的入口')
  }
  // ---- D100p 渲染层: 先报案再重取, 且只报一次 ----
  {
    const f = seg(pv, 'async function onUrlDead(')
    assert(/if \(errorMsg\.value\) return/.test(f) && f.indexOf('api.liveSrcDead(') > -1 && f.indexOf('api.liveSrcDead(') < f.indexOf('loadPlay(pwdInput.value, true)') && /const deadUrl = m3u8\.value/.test(f), 'D100q 顺序是先报案后强制重取(且第一道守卫仍是"已提示过就静默"): 那份死源留在缓存里时, 卡片徽标/录制/保活读数都还在读同一本账, 而这一发若被 7 那 8 秒闸挡掉就退回复用缓存 —— 摘没摘过在那一刻是两种结局')
    assert(/const deadRetryLeft = ref\(1\)/.test(pv) && /deadRetryLeft\.value--/.test(f) && /m3u8\.value !== deadUrl/.test(f) && !/setTimeout|setInterval/.test(f), 'D100r 额度每次进房只有一份, 且只有"换回一串不同的地址"才算救回来, 这一支不起任何计时器: 把自己接成无限重连就是拿亲证失败去换请求量的无界增长')
  }
  assert(/23:33:38[\s\S]{0,200}23:38:52|23:33:38[\s\S]{0,200}404/.test(so + pd) && /5min14s/.test(so + pd), 'D100s 那两个时刻与那个窗口留在代码里(与 D99b 同规约): 谁要把这一口改回宽作废或干脆不接渲染层那句判决, 先要撞见这份实测读数')
}

// ============================================================================
// A3: 卡片图两域的本机缓存 —— 只消灭「同一件东西被问两遍」, 不消灭「该问的那一遍」
// (实测 2026-10-03 普查 + 2026-10-04 复测: liveimg.sooplive.com 零缓存指示头、query 是平台自己的版本号
//  (同路径隔 45 秒内容就换: 146f8e1505ff → 8b20579c08f3 → 4dada6831308), stimg.sooplive.com 只给 max-age=60;
//  于是普查那 1400 秒里这两域共 42 个路径各留下 2 发。Panda 的 CDN 是 27 个 URL 各 1 发, Chromium 本来就命中 ⇒ 不入白名单)
// ( 真机改判: 上面那"各 2 发"不是同一件东西被问两遍 —— 计数键是 host+pathname, query 没进键(整份 jsonl 里 '?' 出现 0 次),
//  平台每轮换的版本号被合并了。真机两次切墙读到 hit=0 / merged=0 / 34 发: 卡片图每轮必问(版本号在换), 头像 Chromium 没再问;
//  而这一层先付了一次代价 —— 8 秒上限把冷启动那 9 秒停顿整批掐掉, 打嗝又被记成 15 秒账 ⇒ 首面卡片整轮空白(D101u/D101v/T12))
// ============================================================================
{
  const iu = fs.readFileSync(R('src', 'shared', 'imgUrl.ts'), 'utf8')
  const ic = fs.readFileSync(R('src', 'main', 'services', 'imgCache.ts'), 'utf8')
  const lm = fs.readFileSync(R('src', 'main', 'services', 'localMedia.ts'), 'utf8')
  const av = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AvatarImg.vue'), 'utf8')
  const lc = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'LiveCard.vue'), 'utf8')
  const pvw = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')
  const rv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  const html = fs.readFileSync(R('src', 'renderer', 'index.html'), 'utf8')
  const pk = fs.readFileSync(R('package.json'), 'utf8')
  const seg2 = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  // 顶层函数(不在类里)的收尾是列零的那一刀: bodyEnd 找的是缩进两格的方法尾, 套到顶层上会停在函数体中间的 `}`
  const segTop = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = s.indexOf('\n}', i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const ld = seg2(ic, 'private async load(url: string): Promise<Entry>')
  const ck = segTop(ic, 'function cacheKey(')
  const fi = segTop(ic, 'async function fetchImage(')
  const psi = segTop(iu, 'export function parseImgSrc(')
  const hl = iu.split(/\r?\n/).find((l) => l.includes('export const IMG_CACHE_HOSTS')) || ''
  // ---- D101a 白名单就是实测那两域, 定义只有一处 ----
  assert(
    /export const IMG_CACHE_HOSTS: readonly string\[\] = \['liveimg\.sooplive\.com', 'stimg\.sooplive\.com'\]/.test(iu) &&
      !/IMG_CACHE_HOSTS\s*=\s*\[/.test(ic) && (hl.match(/'[^']+'/g) || []).length === 2 && !/pandalive/.test(hl),
    'D101a 域名清单只有两域且只住在共享层(imgCache 不许自带第二份): Panda CDN 实测 27 个 URL 各 1 发 —— Chromium 那边本来就命中, 把它加进来只会多一条我方正经手的取图面(缓存别人的缓存)'
  )
  // ---- D101b 翻译只有一处实现, 四处 <img> 全部过它 ----
  assert(
    [av, lc, pvw, rv].every((f) => /from '@shared\/imgUrl'/.test(f) && /imgSrc\(/.test(f)) &&
      /:src="shown"/.test(av) && /v-if="m\.isLive && cardThumb"[\s\S]{0,40}:src="cardThumb"/.test(lc) &&
      /v-if="thumb" :src="thumb"/.test(pvw) && /:src="imgSrc\(task\.thumbUrl\)"/.test(rv),
    'D101b 四个 <img> 绑的都是 imgSrc 的产物(头像/卡片/播放页/库海报), 一处翻译两边共用: 少一个绑定就是那一域的图继续直连, 多一处实现就是两套口径(D39 的兜底判据跟着分叉)'
  )
  assert(
    [av, lc, pvw, rv].every((f) => !/'liveimg\.sooplive\.com'/.test(f) && !/btoa\(/.test(f)),
    'D101c 渲染层不自己拼域名清单、不自己编码: 组件里出现任何一份平行实现, 下一步改白名单就只改到主进程那一半(与 D26「唯一定义处」同规约)'
  )
  // ---- D101d 空串/别的域原样返回 ⇒ 调用方那句 v-if 的判据一字不变 ----
  assert(
    /export function imgSrc\(u: string\): string \{\s*if \(!imgCacheable\(u\)\) return u/.test(iu) &&
      /if \(!u\.startsWith\('https:\/\/'\)\) return false/.test(iu) &&
      /const show = computed\(\(\) => !!shown\.value && !failed\.value\)/.test(av),
    'D101d 翻不动的就原样递出去: 「有没有图」的判据仍然是"有没有地址", 不是"能不能进缓存" —— 把这两件事合并会让空地址那一档在卡片上变成一条破图(破图不画在圆位上那一课)'
  )
  // ---- D101e 协议分叉点在文件白名单之前, 且只有一条 protocol.handle ----
  assert(
    /import \{ imgCache \} from '\.\/imgCache'/.test(lm) &&
      lm.indexOf("u.host === 'img'") > -1 && lm.indexOf("u.host === 'img'") < lm.indexOf('const b64 = ') &&
      (lm.match(/protocol\.handle\(/g) || []).length === 1 &&
      /privileges: \{ standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: false \}/.test(lm),
    'D101e 卡片图那一支在 plocal://file/ 的 fs 白名单之前分叉, 且不给这一层新注册第二条协议: 载荷是"要去取的一条地址"而不是"本机某个文件", 拿文件白名单判它就是两套边界互相冒充; 复用 plocal 也是 CSP 一字不改的前提(img-src 里那句 plocal: 早就在位)'
  )
  assert(/img-src 'self' data: https: http: plocal:/.test(html), 'D101g CSP 没被这一笔动过: 这一层能起来靠的是"复用已批准的 scheme", 不是"再开一条口子"')
  // ---- D101h 安全边界: 解回来那一趟逐项判, 少一项就是后门 ----
  assert(
    /if \(!raw\.startsWith\(PREFIX\)\) return ''/.test(psi) && /if \(!code \|\| code\.length > MAX_ENCODED\) return ''/.test(psi) &&
      /url\.protocol !== 'https:'/.test(psi) && /url\.username \|\| url\.password \|\| url\.port/.test(psi) &&
      /IMG_CACHE_HOSTS\.includes\(url\.hostname\)/.test(psi) && /url\.pathname\.startsWith\('\/'\) \|\| url\.pathname\.length > 512/.test(psi),
    'D101h parseImgSrc 八项判据齐全(前缀/空/超长/https/无账号/无端口/域全等/路径形状): 这一段拿的是渲染层递进来的字符串, imgCacheable 在它之前跑过也不作数 —— 渲染层是可以被别的页签喂字符串的那一面, 主进程这一侧必须自己再判一遍'
  )
  assert(!/require\(|from 'electron'|Buffer\./.test(iu) && /new TextEncoder\(\)/.test(iu), 'D101i 共享层是零依赖纯函数且不用 Buffer: 渲染层是 sandbox + nodeIntegration:false(没有 Buffer), preload 与 main 各有各的 polyfill —— 与 preload/index.ts 的 localFileUrl 同一把尺')
  // ---- D101j 键 = 抹掉纯数字版本号之后的地址(改判这一条), TTL 就说实测那 60 秒 ----
  assert(
    /return url\.toString\(\)/.test(psi) &&
      /if \(\/\^\\d\+\$\/\.test\(u\.search\.slice\(1\)\)\) return u\.origin \+ u\.pathname/.test(ck) &&
      /return url$/.test(ck) &&
      /const key = cacheKey\(url\)/.test(ld) && /fetchImage\(url\)/.test(ld) && !/fetchImage\(key\)/.test(ld) &&
      /const TTL_MS = 60_000/.test(ic) && /max-age=60/.test(ic),
    'D101j 键只抹 `?<纯数字>` 这一种形状(实测 28 间在播房的 thumbUrl 共用同一枚 ?29851761 ⇒ 那是上游逐轮推的全局计数, 不是这张图的身份), 其余 query 整条照旧进键; 取法仍用原地址(fetchImage 拿的是 url 而不是 key): 那句"抹平它等于卡片停在上一帧"已被"5 枚计数同一份字节 + 3.0 秒双绘字节相同"推翻, 停帧的上限从来是 TTL 那 60 秒(T2 是行为面)'
  )
  // ---- D101k 只收图; 失败不冒充成功; 404 原样回 404 ----
  assert(
    /if \(!buf\.byteLength \|\| !type\.startsWith\('image\/'\)\) return \{ ok: false, status: 502, type \}/.test(fi) &&
      /if \(!e\.bytes\) \{[\s\S]{0,200}status: e\.status === 404 \? 404 : 502/.test(ic) &&
      /return new Response\(e\.bytes, \{\s*status: 200,/.test(ic),
    'D101k 三档分开: 200 但不是 image/* 一律 502 不当图收(反代劫持页/HTML 错误页), 账上没有字节就不回 200, 404 照旧回 404 —— 渲染层那句「没有头像」靠的就是 @error, 把它翻译成 200 空图就是让兜底永远不触发'
  )
  // ---- D101l 到点重取失败不许把还能看的那份一起带走 ----
  assert(
    /const FAIL_TTL_MS = 15_000/.test(ic) && /if \(e\?\.bytes\) \{[\s\S]{0,120}e\.exp = Date\.now\(\) \+ FAIL_TTL_MS/.test(ld),
    'D101l 重取失败时保留旧字节且只推到短账(15 秒): 读不到 ≠ 这张图不存在了; 记满 60 秒则"刚传了头像"要晚一分钟才出现在卡片上 —— 展示面不值得那样(T5 是行为面)'
  )
  // ---- D101m 并发合并: 合并的是问, 不是等 ----
  assert(
    /this\.stat\.miss\+\+\s*this\.stat\.send\+\+/.test(ld) && /const flying = this\.inflight\.get\(key\)[\s\S]{0,80}this\.stat\.merged\+\+/.test(ld) &&
      /this\.inflight\.set\(key, p\)/.test(ld) && /this\.inflight\.delete\(key\)/.test(ld) && /const e = this\.store\.get\(key\)/.test(ld),
    'D101m send 只在未命中那一支加, 在飞的那一发由 merged 计数且落定即摘: 一整面卡片同时问同一个地址时真发的只有一发, 而计数若把合并算成发送, 这本账就在撒谎(T3 与取证口径都读它)'
  )
  // ---- D101n 淘汰: LRU 靠命中挪队尾, 预算按张数与字节双顶 ----
  assert(
    /this\.stat\.hit\+\+[\s\S]{0,160}this\.store\.delete\(key\)\s*this\.store\.set\(key, e\)/.test(ic) &&
      /if \(v\.exp <= now && k !== key\)/.test(ic) &&
      /while \(this\.store\.size > MAX_ENTRIES \|\| this\.bytes > MAX_BYTES\)/.test(ic) &&
      /const MAX_ENTRIES = 300/.test(ic) && /const MAX_BYTES = 24 \* 1024 \* 1024/.test(ic),
    'D101n 命中要把这一格挪到队尾(否则刚被要的头像先被剪), 清过期时不许把刚写进去的那一格顺手清掉(k !== url), 剪法按张数与字节两个上限一起管: 这一层没有磁盘, 内存就是它的全部预算, 而"无界缓存"在监控应用里就是第二个泄漏面(T9/T10 是行为面)'
  )
  // ---- D101o 取法跟着「设置-代理」, 且只带 UA 不带凭据 ----
  assert(
    /session\.fromPartition\(SESSION_PARTITION\)/.test(fi) && /sesFetch\.call\(ses, url/.test(fi) && /await net\.fetch\(url/.test(fi) &&
      /'User-Agent': UA/.test(fi) && !/[Cc]ookie|Authorization/.test(fi),
    'D101o 先走本窗口 session 的 fetch(与渲染层今天发这些请求同一条道, 换代理设置照样跟着), session 不可用才回落 net.fetch; 带 UA 不带 cookie: 实测这两域的图不需要任何凭据 —— 把会话 cookie 顺手挂到图片请求上, 换来的只是无谓的暴露面'
  )
  assert(!/netGate|laneRun/.test(ic) && /车道豁免/.test(ic), 'D101q 这一层不进按站后台车道(与 D67d 媒体/CDN 豁免同规约且理由在案): 42 发排在一条尾锁后面会把卡片墙拖成白屏, 而它们本来就不是 API 站的读数')
  assert(!/from 'fs'|from 'path'/.test(ic), 'D101r 只在内存不落盘: 落盘要么扩 plocal 的文件白名单(多一条边界)要么再造一条协议(多一次注册), 而这一格要省的是"同一次运行里重拉", 跨启动那 42 发与地址每场都换的卡片图不成比例')
  // ---- D101s 实测读数留在代码里(含把自己那笔推翻的那一段) + 行为套子在链上 ----
  assert(
    /45 秒/.test(iu + ic) && /146f8e1505ff/.test(iu + ic) && /hit=0/.test(ic) && /'\?' 出现 0 次/.test(ic) && /34 发/.test(ic) &&
      /29851761/.test(ic) && /3\.0 秒/.test(ic) && /自己把它改判了/.test(ic),
    'D101s 两域的读数(45 秒换内容 / 三枚 sha)、改判的两把尺(计数键里 query 出现 0 次、真机 hit=0 merged=0)与 34 发这笔账留在注释里(与 D99b、D100s 同规约), 加上那三笔(28 间共用一枚 ?29851761、3.0 秒双绘字节相同、键归一这一条改判本身): 谁要拉长 TTL、再抹一种 query 或收一个新域进来, 先要撞见这三份读数 —— 一份是我说的, 一份是把我说的那句推翻的'
  )
  assert(/node scripts\/verify-imgcache\.mjs/.test(pk), 'D101t 行为套子在 npm run verify 链上: 上面这些是"代码长什么样", 发没发那一发只有套子数得着 —— 不在链上它就会悄悄烂掉(第十一套起每条链都要逐个点名)')
  // ---- D101u 那一发的上限跟着真机读数走(这一格被自己的探针改判过一次) ----
  assert(
    /const FETCH_TIMEOUT_MS = 20_000/.test(ic) && /447~1339ms/.test(ic) && /9 秒/.test(ic),
    'D101u 上限 20 秒且理由带着两次真机读数(暖着 447~1339ms / 冷启动整站停顿过一次约 9 秒): 原来那 8 秒是照"图都很快"拍的, 而真机第一次取证就把 18 发整批掐在 8.000 秒 —— 有界要留, 但上限不该掐一张本来会画好的图(T12 是行为面)'
  )
  // ---- D101v 失败的账只给官方那句「没有」 ----
  assert(
    /if \(r\.status === 404\) this\.put\(key, bad\)/.test(ic) && !/^ {6}this\.put\(key, bad\)/m.test(ic) &&
      (ic.match(/this\.put\(key, /g) || []).length === 3 && !/this\.put\(url/.test(ic),
    'D101v 手里没旧图时只有 404 留短账, 超时/5xx/非图一律不留: 404 是答案(没传过 logo 的房, 同一面卡片再问就是白问), 后三种是"我方这一发没成" —— 给它留账就是把一次网络打嗝画成卡片上 15 秒的空白, 而 <img> 不会自己重试, 空白要一直挂到下一次重渲染(T12 是行为面)'
  )
}

// A4: 登录态那行留痕的第四档「合并」—— 只改一句话的说法, 不改任何一发请求
// (现场: 启动期 authState + 自愈核对 + 登录窗口关闭后的 pushAccounts 会在同一瞬连着取态, 而结果缓存要等那一发
//  落地才写得上 ⇒ 吃掉那几发的是在途合并; 三档年代那一行读作「真发」, 于是"按日志行数复请求数"又在合流的那几行上失真)
// ============================================================================
{
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const ip = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const ci = seg(pd, 'async checkLoginInfo(')
  const vl = seg(so, 'async verifyLogin(')
  const span = (src, a, b) => {
    const i = src.indexOf(a)
    const j = i < 0 ? -1 : src.indexOf(b, i)
    return i < 0 || j < 0 ? '' : src.slice(i, j + b.length)
  }
  // ---- D102a 两站的应答契约各多这一格, 且是可选的 ----
  assert(/merged\?: boolean/.test(pd) && /merged\?: boolean/.test(so) && (pd.match(/merged\?: boolean/g) || []).length === 1 && (so.match(/merged\?: boolean/g) || []).length === 1, 'D102a 两站各一处、只加这一格(可选 ⇒ 缺席即"这一问自己出门了"): 老调用点不必跟着改就能读对, 而两站各写一份是为了让"合并"在两站日志里是同一个词')
  // ---- D102b 合流那一支: 只挂旗, 内容原样 ----
  assert(/const r = await this\.loginInfoInflight\.p\s*return \{ \.\.\.r, merged: true \}/.test(ci), 'D102b Panda 的合流出口 = 等别人那一发 + 原样展开 + 只多一面旗: 不许顺手改 isLogin/净身出户式重建字段(调用方读到的必须是同一条真答案, 与 D90e/D97b"记账不改返回契约"同规约)')
  assert(/if \(flying\) \{\s*const r = await flying\s*return \{ \.\.\.r, merged: true \}/.test(vl), 'D102c SOOP 的合流出口同一把尺(await + 展开 + 旗): 两站这一支的形状必须一样, 否则同一句"合并"在两边指的不是同一件事')
  assert(!/rawFetch|fetchLoginInfo\(/.test(span(pd, 'if (!force && this.loginInfoInflight', 'return { ...r, merged: true }')) && !/this\.req\(|nodeHttpRequest/.test(span(so, 'const flying = this.loginInflight.get(key)', 'return { ...r, merged: true }')), 'D102d 合流那两支里一次请求都没有(整支从判据到 return 只含 await 与挂旗; span 为空即锚点丢了): 这一档是"给已经出门的那一发正名", 不是"多问一发好挂旗"')
  // ---- D102e 三档 → 四档: 映射只住在日志那两行 ----
  assert(/let verify: '真发' \| '缓存' \| '合并' \| '未问' = '未问'/.test(ip), 'D102e 那一格的取值域就是这四档且默认仍是"未问": 加一档必须同时改到这里(旧写法少一格 ⇒ 合流那一问被写成"真发"), 而默认值不许改成"真发"(没问过就不能自称问过)')
  assert(/verify = info\.fromCache \? '缓存' : info\.merged \? '合并' : '真发'/.test(ip) && /const verify = !hasCookies \? '未问' : v\.fromCache \? '缓存' : v\.merged \? '合并' : '真发'/.test(ip), 'D102f 两行的判序一致(缓存先于合并, 合并先于真发): 顺序换了就是同一行在两个平台上说不同的话; "未问"仍在最外层由"有没有凭证"决定, 与"有没有出门"是两件事')
  assert((ip.match(/'合并'/g) || []).length === 3 && (ip.match(/\.merged/g) || []).length === 2, 'D102g "合并"这一档在 IPC 层只出现在该出现的地方(取值域一处 + 两行判档各一处; .merged 只读两处): 别把它抄进 state 投影或第三处判据, 那是第二个真相源')
  assert(!/[{,]\s*merged\??\s*:/.test(ty), 'D102h 这一格不进 IPC 契约(types.ts 里没有一个叫 merged 的字段): 它只是那行日志的自证, 界面读的是 lastVerifyAt 与 realLogin —— 传进契约就会有人拿它当业务状态用。判据从裸 /merged/ 收成"键名就叫 merged": 诊断台那本代理账里的 mergedPlays/mergedSegs 是"省了几次重复取"的计数, 与这一旗同名不同物')
  // ---- D102i 为什么必须有这一档: 理由留在代码里 ----
  assert(/三档不齐时, 行数照复仍会多算/.test(ip) && /不能替这一发冒充「真发」/.test(pd) && /接的是别人在飞的那一发, 本次没有出门/.test(so), 'D102i 三处各写明这一档的所以然(ipc 那一行的"为什么还要加一档" + 两站旗的语义): 后来人要删这一格时先要撞见这句理由, 而不是只看见一行日志')
  // ---- D102j 发数与净Fail 语义一条没动 ----
  assert((ip.match(/api\.checkLoginInfo\(\)/g) || []).length === 1 && (ip.match(/soopApi\.verifyLogin\(\)/g) || []).length === 1, 'D102j 两处调用点各一个(没有为标记补第二问): 这一笔的诚实形状就是"请求数一字不改" —— 行为取证 verify-playcache T55(五问三发 / 两问一发)与 verify-follows O1~O4(走真 IPC 处理器的两行字样)')
  assert(/if \(!force && this\.loginInfoCache &&/.test(ci) && /if \(!force && this\.loginInfoInflight &&/.test(ci) && /if \(!force && hit && Date\.now\(\) - hit\.at < LOGIN_TTL\) return \{ \.\.\.hit\.info, fromCache: true \}/.test(vl) && /const flying = this\.loginInflight\.get\(key\)\s*if \(flying\) \{/.test(vl), 'D102k 两站的判序与改前一字不差(Panda 的缓存与在飞两支都归 !force 管; SOOP 的缓存归 !force、在飞那一支一律合流 —— 这是改前就有的形状, A4 只在那一支里挂旗): 账号页「立即重新校验」不许被这面旗冒充, 强制位自己发的就是真发 —— 行为取证在 T55-7 与 N9-8')
  assert(/if \(!info\.netFail\) \{/.test(vl) && /if \(!jarOverride && !out\.netFail\) this\.loginInfoCache =/.test(pd), 'D102l netFail 仍旧不进结果缓存(两站各一处, 这一笔没顺手改它): 合流接来的若是失败链, 那一行读「合并」而结论仍是"请求失败" —— 两格各说各的, 行为取证在 T55b 与 O4')
}

// ============================================================================
// A5: 回放那份清单只读一遍 —— 一次读取同时给出「进度分母」与「交给 ffmpeg 的正文」
// (现场读数(2026-10-03 请求普查): recorder 先 fetchPlaylistDurationSec 求 EXTINF 和、正文用完就丢,
//  转头又把同一个 URL 交给 ffmpeg 读第二遍 ⇒ 串行双读, 两发之间不重叠, hlsProxy 的在途合流拦不住,
//  而且 Panda 回放根本不走本地代理。每次回放多 1 发。`vod:true` 今日无样本 ⇒ 行为面只有台架, 标未实拍)
// ============================================================================
{
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const rc = fs.readFileSync(R('src', 'main', 'services', 'recorder.ts'), 'utf8')
  const hp = fs.readFileSync(R('src', 'shared', 'hlsPlaylist.ts'), 'utf8')
  const ut = fs.readFileSync(R('src', 'main', 'util.ts'), 'utf8')
  const rv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'RecordingsView.vue'), 'utf8')
  const pk = fs.readFileSync(R('package.json'), 'utf8')
  const seg = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(src, i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  // 顶层函数(不在类里)的收尾是列零的那一刀: bodyEnd 找的是缩进两格的方法尾
  const segTop = (src, decl) => {
    const i = src.indexOf(decl)
    if (i < 0) return ''
    const j = src.indexOf('\n}', i)
    return src.slice(i, j < 0 ? undefined : j)
  }
  const fv = seg(pd, 'async fetchVodPlaylist(')
  const hv = seg(rc, 'private handVodPlaylist(')
  const cv = seg(rc, 'private cleanVodPlaylist(')
  const run = seg(rc, 'async run(): Promise<void>')
  const loc = segTop(hp, 'export function localizeVodPlaylist(')
  // ---- D103a 读取口只有一个, 且它的返回值就是那两件事 ----
  assert(
    /async fetchVodPlaylist\(url: string\): Promise<\{ sec: number; text: string \} \| null>/.test(pd) &&
      !/async fetchPlaylistDurationSec/.test(pd) &&
      (pd.match(/this\.fetchText\(url\)/g) || []).length === 1 &&
      /return \{ sec: sum, text \}/.test(fv),
    'D103a 回放清单的读取口只有一个, 一发 fetchText 换回 { sec, text }(旧的双读入口既没定义也没人调): 这一笔要省的就是"第二发", 若读取口裂成两个或函数里再藏一次 fetchText, 省下的那一发就又还回去了 —— 行为取证 verify-vodduration V1-2/V6-2(只发一次)'
  )
  // ---- D103b 「算不出」与「0 秒」是两件事: 三道 null 门都在位 ----
  assert(
    /catch \{\s*return null/.test(fv) &&
      /if \(!\/\^#EXTM3U\/\.test\(text\.trim\(\)\)\) return null/.test(fv) &&
      /if \(!segs\) return null/.test(fv) &&
      /if \(Number\.isFinite\(s\)\) sum \+= s/.test(fv),
    'D103b 三道门各拦一件事(拉不到→null / 非清单正文→null / 没有 EXTINF 段行(master)→null), 脏行仍是"丢那一行"而不是"整份作废": 「0 秒」不是分母、「没有正文」也不是正文 —— 行为取证 V3-1/V4-1/V5-1'
  )
  // ---- D103c recorder 的接线: 一次读取的两个消费端 + 退回真 URL 的那一条 || ----
  {
    const iRead = run.indexOf('await api.fetchVodPlaylist(src)')
    const iWrite = run.indexOf('this.handVodPlaylist(src, pl.text)')
    const iGate = run.indexOf("if (this.finalized || this.stopping", iRead)
    assert(
      /let input = src/.test(run) &&
        iRead >= 0 &&
        /this\.vodTotalSec = pl\.sec/.test(run) &&
        /input = this\.handVodPlaylist\(src, pl\.text\) \|\| src/.test(run) &&
        /this\.spawnFfmpeg\(input\)/.test(run) &&
        !/this\.spawnFfmpeg\(src\)/.test(run) &&
        iWrite > iRead && iGate > iRead && iGate < iWrite,
      'D103c 两个消费端接的是同一次读取(分母取 sec、交棒取 text), 交棒回空串就用 `|| src` 退回改动前那条真 URL; H2 那道停止闸仍在"读完之后、落盘之前" —— 用户已按停止就不许再 spawn, 也不许先写一份没人读的清单元凶'
    )
  }
  // ---- D103d 绝对化只有一处实现, 且 recorder 里没有第二把尺 ----
  assert(
    /import \{ localizeVodPlaylist \} from '\.\.\/\.\.\/shared\/hlsPlaylist'/.test(rc) &&
      /localizeVodPlaylist\(text, baseUrl\)/.test(hv) &&
      !/new URL\(/.test(rc) &&
      hp.includes('const URI_ATTR_RE = /\\bURI="([^"]*)"/g'),
    'D103d 相对 URI 的绝对化只住在共享层(交棒正文由真实现改写, recorder 里一个 new URL 都没有): 本地文件的基准是录制目录, 不改写就是去磁盘上找 seg-0.ts —— 两处实现就会有两套口径, 而这类分叉只在"下载跑到一半才 404"时露头'
  )
  // ---- D103e 交棒要么整份可用, 要么整份作废(绝不半绝对化) ----
  assert(
    /if \(\/URI='\/\.test\(text\)\) return null/.test(loc) &&
      /if \(bad\) return null/.test(loc) &&
      /if \(a === null\) return null/.test(loc) &&
      loc.indexOf('if (bad) return null') < loc.indexOf('out.push(mapped)') &&
      !/if \(bad\)\s*continue/.test(loc),
    'D103e 三种"没资格交棒"的形状一律整份回 null(基准不是地址 / 单引号 URI / 任一条 URI 解析不出), 且作废判据排在写入结果之前: 半绝对化的清单是静默丢段 —— 用户拿到一部短了几分钟的片子而进度、日志、对账一路全绿。退路是"照旧多花 ffmpeg 那一发", 不能拿产物换 —— 行为取证 V10-1~3 与 verify-p1 K3'
  )
  // ---- D103f 盘上那份是"用完即删"的: 记账失败之后才挂旗, 三条路都指向删除 ----
  assert(
    /fs\.writeFileSync\(f, body\)/.test(hv) &&
      rc.indexOf('fs.writeFileSync(f, body)') < rc.indexOf('this.vodPlaylistFile = f') &&
      /_vod\.m3u8/.test(hv) &&
      (rc.match(/this\.cleanVodPlaylist\(\)/g) || []).length === 3 &&
      /if \(!this\.vodPlaylistFile\) return/.test(cv) &&
      /catch \{\s*\/\* ignore \*\/\s*\}/.test(cv),
    'D103f 只有真写成功才把路径挂到自己名下(挂了就必须有人删), 删除口有三处(ffmpeg 退出 / 收尾 / spawn 起跑就炸)且删不到也不抛: 那份文件写着这条回放的签名源地址, 它出现在目录里的每一分钟都是白给的面 —— 行为取证 verify-p1 K1-13/K2-3/K3-3'
  )
  // ---- D103g 对账口径看不见 .m3u8, 而产物一条不少 ----
  assert(
    rc.includes('const SEG_RE = /_(\\d{4}|vod)\\.(mp4|ts)$/i') &&
      rc.includes("f.endsWith('.ts') || f.endsWith('.mp4')") &&
      ut.includes('.filter((n) => n.startsWith(base) && /\\.(mp4|ts)$/i.test(n))'),
    'D103g SEG_RE 与两处媒体过滤一字未改(交棒清单因此在产物对账里是隐形的, 而 _vod.ts 照旧被认下来): 这一笔只换"清单怎么读", 不换"什么算产物" —— 若过滤被顺手扩到 .m3u8, 库里就多一条永远打不开的条目(D 系列里那条"零产物不入库"的同族)'
  )
  // ---- D103h 输入换成本地文件, 代理与协议白名单不能跟着换 ----
  assert(
    /'-protocol_whitelist', 'file,http,https,tcp,tls,crypto'/.test(rc) &&
      /if \(cfg\.proxyUrl && !LOOPBACK_RE\.test\(m3u8\)\) args\.push\('-http_proxy', cfg\.proxyUrl\)/.test(rc),
    'D103h 白名单里本来就有 file(本地清单第一步才开得了), 而 -http_proxy 仍按"输入不是回环地址"给: 交棒换的只是清单从哪儿读, 段仍然在 CDN 上 —— 把本地路径当成"不需要上游代理", 用户挂代理时回放必然连不上 —— 行为取证 verify-p1 K4-2/K4-3'
  )
  // ---- D103i 进度语义一字未动 ----
  assert(
    /if \(!task\.vodTotalSec\) return null/.test(rv) && /out_time_\(\?:us\|ms\)/.test(rc) && /vodTotalSec = 0/.test(rc),
    'D103i 分母初值仍是 0、0 分母在渲染层仍是退文字而不是 0%、已下载时长仍从 -progress 管道的 out_time_us|ms 读: A5 拿的是"多出来的那一发", 不是把进度条换成另一种说法 —— 行为取证 verify-p1 K1-12/K2-2'
  )
  // ---- D103j 实测读数与"为什么"留在代码里(与 D99b、D101s 同规约) ----
  assert(
    /串行双读/.test(hp + pd) && /每次回放白多一发|每次回放多 1 发/.test(hp + pd) && /基准就变成录制目录|解析到录制目录/.test(hp) && /静默丢段/.test(hp + rc),
    'D103j 那三句所以然留在源码里(双读的形状 / 相对地址在本地文件里会变成什么 / 为什么宁可整份作废): 后来人要恢复第二次读取、要往 recorder 里再塞一份改写、或者要"跳过那一条解析不出的 URI"时, 先要撞见这三句理由'
  )
  // ---- D103k 行为套子在链上 ----
  assert(
    /node scripts\/verify-p1\.mjs/.test(pk) && /node scripts\/verify-vodduration\.mjs/.test(pk),
    'D103k 两套行为取证都在 npm run verify 链上(vodduration 数得着那一发, verify-p1 的 K 组让真 recorder 落真文件再删掉): 上面 D103a~j 全是"代码长什么样", 交棒到底成没成只有跑过才知道(第十一套起每条链都要逐个点名)'
  )
}

// ============================================================================
// 熔断期不再加速轮距: intervalFor 只剩"各自那一格"一条规则
// ============================================================================
{
  const wa = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const pc = fs.readFileSync(R('scripts', 'verify-playcache.mjs'), 'utf8')
  const ivSeg = (wa.match(/\/\*\*[\s\S]*?\*\/\s*private intervalFor\(platform: Platform\): number \{[\s\S]*?\n {2}\}/) || [''])[0]
  const ivBody = (ivSeg.match(/private intervalFor\(platform: Platform\): number \{[\s\S]*?\n {2}\}/) || [''])[0]
  // ---- D104a 提速那一行确实没了 ----
  assert(
    ivSeg !== '' && !/circuitOpen/.test(ivBody) && (ivBody.match(/return /g) || []).length === 1 && /Math\.max\(1,/.test(ivBody),
    'D104a intervalFor 只剩一条 return(没有熔断态那一支、也没有第二处提速): 这一格的改判是"撤"而不是"加一档更小的", 若谁把熔断期再塞回来, 先要撞见 D104b 那三句理由'
  )
  // ---- D104b 熔断账本本身一条没动 ----
  assert(
    !/circuitOpen/.test(ivBody) && (wa.match(/circuitOpen/g) || []).length >= 5 && /P\.circuitOpen = false/.test(wa),
    'D104b 撤的只是调度读它这一处, 熔断标志本身照旧是那张账(置位/清零/投影都在): "不再提速"不等于"不再熔断" —— 行为取证 verify-playcache T56-3/T56-4(通知照发、整表照两发)'
  )
  // ---- D104c 三条理由留在注释里 ----
  assert(
    /风控期把轮距砍短/.test(ivSeg) && /cooldownOracleAt/.test(ivSeg) && /staleOnFirstLook 的阈值/.test(ivSeg),
    'D104c 撤这一压的三个理由写在函数头上(方向与防风控相反 / 它买不到探针机会只买到空转 / 它顺手把陈旧阈值压成 60 秒): 后来人看到的是一个"少了特判"的 intervalFor, 要恢复它必须先读完这三句'
  )
  // ---- D104d 探测改由预言机单独承担, 判序没动 ----
  assert(
    /if \(Date\.now\(\) >= this\.cooldownOracleAt \+ Watcher\.COOLDOWN_ORACLE_MS\) \{/.test(wa) && /退避当场解除/.test(wa) && /代价是探测时刻最多比 5 分钟线晚一个轮距/.test(wa),
    'D104d 冷却期那一发预言机仍是熔断期唯一的提前探测(5 分钟一闸, 读通即当场解除退避), 且这一笔把它"晚一个轮距"的代价写在旁边而不是藏起来: 撤轮距提速不能把探测一起撤掉 —— 行为取证 verify-playcache T40'
  )
  // ---- D104e 陈旧阈值仍跟着 intervalFor(A1 那一格没回退) ----
  assert(
    /return !pending && a\.lastSeenAt > 0 && Date\.now\(\) - a\.lastSeenAt > 2 \* this\.intervalFor\(platform\)/.test(wa),
    'D104e staleOnFirstLook 的阈值仍是 2×intervalFor 且"没排进防抖"仍在最前: 撤提速之后这一处自然变宽(熔断期不再把 120s 轮距读成 30s), 而判序一字未改 —— 行为取证 verify-playcache T51(冷启动旧账)与 T56-1/T56-2(熔断轮里刚散的那场不被当旧账)'
  )
  // ---- D104f 本机真读数与「未实拍」的口径写在测试里 ----
  assert(
    /pollIntervalSec=120/.test(pc) && /现场实测 141 秒/.test(pc) && /未实拍/.test(pc),
    'D104f 这一笔的两条读数留在测试里: 本机 Panda 的格子是 120 秒(data/db.json 2026-10-04 真读), 141 秒那一圈是改前现场样本, 改后外推 ≈180 秒并明标「未实拍」(风控窗口不能按需复现) —— 不许后人把外推当实测'
  )
  // ---- D104g 分家那一段的历史没被改写成"从来如此" ----
  assert(
    /旧实现只有一条 timer 跑完两平台/.test(wa) && /熔断期不再改轮距/.test(wa),
    'D104g Loop 字段注释仍写明"旧实现一条 timer 带两站"这段历史, 同时记下 C1 之后连那一压也撤了: 分家的理由(一站熔断不拖另一站)与撤压的理由(风控期不加倍发问)是两条不同的账, 抹掉任一条都会让下一次改动没有依据'
  )
}

// ============================================================================
// verify 套件的落盘面: 原命题被探针改判, 留下来的是"不许再有人把写口指回仓库"这道守卫
// ============================================================================
{
  const scriptDir = R('scripts')
  const suites = fs.readdirSync(scriptDir).filter((f) => /^verify-.*\.mjs$/.test(f))
  const readSuite = (f) => fs.readFileSync(path.join(scriptDir, f), 'utf8')
  const allSuites = suites.map(readSuite).join('\n')
  const fo = readSuite('verify-follows.mjs')
  const ut = fs.readFileSync(R('src', 'main', 'util.ts'), 'utf8')
  const pk = fs.readFileSync(R('package.json'), 'utf8')
  // ---- D105a 扫面本身不是空的(空扫=恒绿) ----
  assert(
    suites.length >= 12 && suites.includes('verify-follows.mjs') && allSuites.length > 100_000,
    `D105a 这一节的扫面覆盖 ${suites.length} 套 verify 脚本(链上 12 套全在内): 扫描清单如果哪天筛不到文件, 下面几条会一起变成假绿, 所以先把"扫到了东西"本身钉成断言`
  )
  // ---- D105b 三根指路针不许再指回仓库根 ----
  assert(
    !/dataDir:\s*\(\)\s*=>\s*ROOT/.test(allSuites) && !/defaultRecordRoot:\s*\(\)\s*=>\s*ROOT/.test(allSuites) && !/getPath:\s*\(\)\s*=>\s*ROOT/.test(allSuites),
    'D105b 没有任何一套把 dataDir / defaultRecordRoot / app.getPath 指回 ROOT(仓库根): 这三根就是真 app 的写口落点, 替身指在仓库=哪天真 store 上车就写进用户的库 —— 改前 verify-follows 三根全指 ROOT(今天没人写只因为 store 是替身), 现已改指本套自己的 mkdtemp'
  )
  assert(
    /const SANDBOX = fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'plm-follows-'\)\)/.test(fo) && /dataDir: \(\) => SANDBOX/.test(fo) && /defaultRecordRoot: \(\) => SANDBOX/.test(fo) && /getPath: \(\) => SANDBOX/.test(fo) && /fs\.rmSync\(SANDBOX, \{ recursive: true, force: true \}\)/.test(fo),
    'D105c verify-follows 的三根针确实改指 mkdtemp, 且那份临时根用完就删: 只改指不删会在系统临时目录里每跑一次留一副骸骨(getAppPath 仍指 ROOT —— 那是找源码/资源的路, 不是写口)'
  )
  // ---- D105d 守卫盯的三处与真写口一致 ----
  assert(
    /const GUARD_WATCH = \['data', 'recording'\]/.test(fo) && /const GUARD_ROOT_FILES = \['db\.json', 'vault\.dat', 'secrets\.dat'\]/.test(fo) && /path\.join\(dataRoot\(\), 'recording'\)/.test(ut),
    "D105d 守卫的覆盖面照着 util 的真写口列(库与缩略图在 data/, 录像默认落在 defaultRecordRoot()=dataRoot()/recording, 根目录散落件是认领前的旧位置): 只列 'data' 就等于对录像开门"
  )
  // ---- D105e 守卫是当场跑的断言, 不是一次性探针 ----
  assert(
    /const GUARD_BEFORE = guardSnap\(\)/.test(fo) && /C2-1 本套\(\$\{Object\.keys\(GUARD_BEFORE\)\.length\} 项快照/.test(fo) && /\[读数\] C2 守卫: 快照 \$\{/.test(fo) && /assert\(\s*touched\.length === 0,/.test(fo),
    'D105e 守卫在套件开头拍快照、结尾比对并当场断言, 断言的条件就是那句"差异项为空"(不是挂着个恒真的第二参数), 还把"快照几项/差异几项"打在末行: 这一格把 2026-10-04 那次一次性探针做成了每套必跑的常驻验收 —— 行为取证就是这一句 C2-1(变异 M3"真往 data/ 写一份"必须让它红, M2"条件改成 true"必须让这一格红)'
  )
  // ---- D105f 实测读数写在测试文件头, 不留在别处 ----
  assert(
    /12\/12 套跑完, 那 1609 个可写文件字节未变/.test(fo) && /这一条不成立/.test(fo),
    'D105f 探针的实测读数与结论写在 verify-follows 文件头(12/12 套零落盘 / 1609 项快照 / 范围含真 app 的 %APPDATA%): 后来人要再提"verify 会写你的库"时先撞见这句, 也不会误以为这一笔是修好了一个正在发生的写'
  )
  // ---- D105g 链上还是那 12 套(没为这一格加第十三套慢扫描) ----
  assert(
    (pk.match(/node scripts\/verify-[a-z0-9-]+\.mjs/g) || []).length === 12 && !/verify-noside|verify-nodatawrite/.test(pk),
    'D105g 验收链仍是 12 套: 这一笔的守卫挂在最广的那套里面随链跑, 没有为它单开一套"把 12 套再跑一遍"的慢扫描(代价大于收益, 且会双写临时目录)'
  )
}

// ============ D106: SOOP 源包跨重启留存与秒开快道的结构契约 ============
// 立这一组的理由不是"新代码要有新契约", 而是这一笔的失效方式全是静默的: 留存读不出 = 照旧每次重买整链
// (日志上看不出发过); playlistUrl 改了查询串 = upstreamOf 一律回空 → 每一包都被 isUsableUp 拒掉, 代码一行
// 不报错而留存从此为零; 复活点排到 return 之后 = 预取泵在列表落地那一刻就排队, 晚半拍它照样把在播房买一遍。
{
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const hp = fs.readFileSync(R('src', 'main', 'services', 'hlsProxy.ts'), 'utf8')
  const idx = fs.readFileSync(R('src', 'main', 'index.ts'), 'utf8')
  const segSo = (decl) => {
    const i = so.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(so, i)
    return so.slice(i, j < 0 ? undefined : j)
  }
  // ---- D106a 留存期限写死成常量, 旁边就是实测口径(下界实测、上界未测), 且那条改判不许被抹回 ----
  assert(
    /private static PACK_TTL = 3 \* 60 \* 60_000/.test(so) &&
      /实测下界 110 分钟/.test(so) &&
      /上界尚未测到/.test(so) &&
      /旧写法每次开机都要付的整链/.test(so) &&
      /\+110 分钟仍回 200/.test(so),
    'D106a 复活判据的"过龄"那一格有常量、有实测下界、并且明写上界未测: 挂着 3 小时的签名地址是我们从没读到过的读数, 把它写成"实测可用 3 小时"就是拿猜测当证据。后面两条钉的是同一件事的另一半 —— 那句"没有心跳可打 ⇒ 放着不管就是徽标亮着而流已死"已被今天的裸读改判, 改判的话如果被抹回去, 下一个读代码的人就会照着假理由再收紧一次时限'
  )
  assert(/private static MAX_STORED = 64/.test(so) && /while \(this\.storedPacks\.size > SoopApi\.MAX_STORED\)/.test(segSo('private notePack(')), 'D106b 留存有上限且挤出的是最旧那一份: 这本账要落盘、要进用户目录, 无界的一本内存表配一个 json 就是迟早撑爆的存档')
  // ---- D106c 盘上只许是上游地址 ----
  assert(/up: upstreamOf\(v\.url\)/.test(segSo('private notePack(')) && !/up: v\.url/.test(so), 'D106c 记的是从代理地址里解出来的上游(全项目只有 HlsProxy.playlistUrl 一处在签发这种串): 原样存 v.url 就是存一串端口与令牌都属于上一个实例的废地址, 而它在日志里与真地址长得一样')
  assert(/url=\$\{encodeURIComponent\(upstream\)\}/.test(hp), 'D106d 代理的签发形状钉在契约上(?url= 那一位的名字): upstreamOf 解的就是它, 改名或换编码方式不会报错, 只会让每一包都被 isUsableUp 判成"签不出去"而静默丢掉整个留存')
  // ---- D106e 判据与写点 ----
  assert(/if \(!pack\.ok \|\| !pack\.bno\) return/.test(segSo('private notePack(')) && /bno: info\.broadNo/.test(so), 'D106e 没有场次号的一律不留存: 号是重启后唯一零请求的判据, 对不上号的地址留在盘上就是下一场开播时交出去的一份旧源')
  assert((so.match(/this\.notePack\(/g) || []).length === 2 && (so.match(/this\.forgetPack\(channel\)/g) || []).length === 2, 'D106f 留存账与 playCache 严格同批: 写点两处(整链落地 + 种子)各配一处摘点(亲证死 + 事件作废) —— 少一处摘就是"内存判死了、重启照旧复活那颗哑弹", 而 G1/G3 立的"作废不许复活"从此只对进程内成立', `note=${(so.match(/this\.notePack\(/g) || []).length} forget=${(so.match(/this\.forgetPack\(channel\)/g) || []).length}`)
  assert(/await this\.promoteStoredPacks\(rows\)\s*\r?\n\s*return rows/.test(so), 'D106g 复活排在列表那一发的 return 之前: 预取泵就在轮次落地那一刻排队, 排后面等于这些在播房各买一遍整链(这一笔省的全部意义)', '顺序反了 = 留存白留')
  assert(/restorePlayCache\(\)/.test(idx) && (idx.match(/soopApi\.flushPacks\(\)/g) || []).length === 2, 'D106h 启动读回 + 两条退出路径都结掉挂起的落盘: 只读不 flush = 退出前那 2 秒合并窗口里的账从此不见(下一次开机又重买)', `flush=${(idx.match(/soopApi\.flushPacks\(\)/g) || []).length}`)
  assert(/const tmp = PACK_FILE\(\) \+ '\.tmp'/.test(segSo('private persistPacks(')) && /fs\.renameSync\(tmp, PACK_FILE\(\)\)/.test(segSo('private persistPacks(')), 'D106i 落盘 tmp+rename 与 db.json/vault 同规约: 被强杀或断电截断出半个 json 就等于静默丢掉整个留存(读回那一支 catch 里什么都不做, 没有第二处会发现)')
  // ---- D106j 秒开快道 ----
  assert(/if \(c\.partial && !password\) void this\.getPlayCached\(channel, '', false, true\)/.test(segSo('async getPlayFast(')), 'D106j 补齐那一发是"不给密码的那一条腿": 预取泵永远没有密码, 手里那份残缺而这次带密来时若照补无密整链, 那一间换回的是一句"要密码"(白烧 9~10 发)。与残缺包规则同一条判据的另一面')
  assert(/if \(r\.partial\) void fillMenu\(\)/.test(fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')) && /if \(seq !== menuSeq \|\| !m\.ok\) return/.test(fs.readFileSync(R('src', 'renderer', 'src', 'views', 'PlayerView.vue'), 'utf8')), 'D106k 渲染层的补齐要有序号作废: 秒开让"回包"和"菜单齐"变成两件事, 没有 seq 就是上一条房间的菜单落在这一条上面(与 D62g2 的"要追"是两格: 那一格管追不追, 这一格管追回来的还能不能信)')
  // ---- D106l Panda 不装这一套 ----
  assert(!/playcache\.json|storedPacks/.test(pd) && /async getPlayFast\(userId: string, password = '', forceFresh = false\): Promise<PlayResult> \{\s*return this\.getPlayCached\(userId, password, forceFresh\)/.test(pd), 'D106l Panda 那一份是纯粹的转发(它没有档级旋钮, 包永远不残缺)且一处留存代码都不长: 它的 master 令牌服务端就写死 600 秒过期, 跨重启留存对它是纯风险无收益 —— 两边同形是假整齐')
  // ---- D106m: 复活的那一档要能递回已买档位的复用账(真机 14:50:29 @1101momoda 拍到过"复活 1 档还买 4 档") ----
  assert(
    /name: p\.name/.test(segSo('private async runPlayChain(')) && /name: v\.name/.test(segSo('private notePack(')) && /if \(!sp\.isPw && sp\.tiers\.every\(\(t\) => !!t\.name\)\) this\.partialBuy\.set\(channel, \{ bno: sp\.bno, bought: variants\.map\(\(variant, i\) => \(\{ name: String\(sp\.tiers\[i\]\.name\), variant \}\)\)/.test(segSo('private async promoteStoredPacks(')),
    'D106m 档名要一路带到留存, 复活时再递回复用账: 这三格任何一格断了都不报错, 只会让"复活那一档"在后台补齐时被原样再买一遍(每间两发重复读, 正是要省的那一类形状), 而日志里的区别只是少一句「复用已买档=1」'
  )
}

// ============ D107: 视图身份 = 页名+路径参数, 不含 query(治「切视图整片重挂」) ============
// 立这一组的理由: 这一格改错的两种失效都是静默的。把 params 也省掉 → player/A → player/B 复用同一实例,
// 跨房间状态残留(一开始就写死要避免的形状)与「粘错平台寄存的原文」一起回来; 把 query 留在身份里 → 每次点
// 在播/发现/已下播都把整片列表连根拔掉重建(实测 347 ms 空白, 而顶栏的分段高亮早已是 computed, 根本不需要的重建)。
{
  const app = fs.readFileSync(R('src', 'renderer', 'src', 'App.vue'), 'utf8')
  const ws = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'WorkspaceView.vue'), 'utf8')
  const acc = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'AccountView.vue'), 'utf8')
  const nav = fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')
  const store = fs.readFileSync(R('src', 'renderer', 'src', 'stores', 'app.ts'), 'utf8')
  // ---- D107a 身份里必须有 params, 必须没有 query ----
  assert(
    /:key="viewKey\(route\)"/.test(app) &&
      !/key="route\.fullPath"/.test(app) &&
      /String\(r\.name \?\? ''\)/.test(app) &&
      /JSON\.stringify\(r\.params\)/.test(app),
    'D107a 视图身份是「页名 + 路径参数」而不是 fullPath: 这一行是整个工作区/账号页切视图要不要重挂的唯一开关。写成 route.fullPath = 每点一次三视图把几百个卡片连根重建(实测空白 347 ms); 连 params 一起省掉 = player/A → player/B 复用实例, 跨房间状态残留回来了'
  )
  // ---- D107b 省掉 query 的前提: 那两个读数面各自有原地接手者 ----
  assert(
    /const view = computed<WSView>\(\(\) => \{\s*const v = route\.query\.view/.test(ws) &&
      /watch\(\s*\(\) => route\.query\.plat,/.test(acc),
    'D107b 「切视图不换实例」成立的唯一理由是这两处本来就原地接得住: 工作区的 view 是 route.query 上的 computed, 账号页自带 watch(route.query.plat)。哪一处哪天改成 setup 里一次性读 route.query, 这一格就必须同时变 —— 否则点了没反应(账号页 :23 那句注释说的正是这个形状)'
  )
  // ---- D107c 换平台那一侧重挂是承重的, 不许被"顺手也省掉 params" ----
  assert(
    /store\.addDraft = text/.test(ws) &&
      /raw\.value = store\.addDraft/.test(fs.readFileSync(R('src', 'renderer', 'src', 'components', 'AddFollowDialog.vue'), 'utf8')) &&
      /:key=页名\+路径参数/.test(store),
    'D107c 换平台仍然要真重挂, 而且这条依赖是显式登记的: 粘错平台的原文经 store.addDraft 过境、新实例挂载时撑开对话框。若哪天把 params 也从身份里去掉, 过境机制就变成"草稿写进一个不会重挂的实例"—— 用户粘的那一句原地消失, 而代码里三处注释还在说会重挂'
  )
  // ---- D107d 普查(收成"逐个键"): 每一个 route.query.<键> 都要有原地接手者 ----
  // 判据为什么这么写: 复核当天真机抓到一格真缺陷 —— 设置页深链读的是 route.query.sec, 而它的 watch 源只有
  // scrollRef(容器到手才滚)。文件里"确实有个 watch", 老的普查就此放行; 身份去掉 query 之后不重挂, 于是
  // 已在设置页时换 ?sec= 滚位不动(实测 scrollTop 251 两次读数一样)。所以判据必须落到"键"这一层:
  // 接手者 = 这个键出现在 computed 的函数体里, 或 watch 的"第一个源参数"里。
  // 为什么不能整段扫(这把刀当天自己挨了一记): 用括号深度一路扫到调用结束, 会把 watch 的回调也扫进来 ——
  // 而回调里恰恰就写着 route.query.sec(它只在落位时读一次)。K1(源回写成只盯 scrollRef)因此照样绿,
  // 而那一格正是本次要钉的缺陷。所以必须按顶层逗号切参数, 只认第一个源。
  const callArgs = (t, openIdx) => {
    const args = []
    let cur = ''
    let depth = 0
    for (let i = openIdx + 1; i < t.length; i++) {
      const c = t[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) {
          args.push(cur)
          return args
        }
        depth--
      } else if (c === ',' && depth === 0) {
        args.push(cur)
        cur = ''
      } else cur += c
    }
    return args
  }
  const sources = (t) => {
    const out = []
    const re = /(?:computed|watch)\s*(?:<[^>]*>)?\s*\(/g
    let m
    while ((m = re.exec(t)) !== null) {
      const openIdx = re.lastIndex - 1
      const args = callArgs(t, openIdx)
      // watch: 只有第一个参数是"源"; computed: 整个函数体都是
      out.push(/watch/.test(m[0]) ? args[0] || '' : args.join(','))
    }
    return out
  }
  const orphans = []
  for (const f of RENDERER.filter((x) => /\.vue$/.test(x))) {
    // 先剔掉整行被注释掉的代码(变异 K3 把 watch 注释掉, 若不剔行, `// watch(` 会被下面的正则当成真源)
    const t = fs
      .readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n')
    const src = sources(t)
    const keys = [...new Set([...t.matchAll(/route\.query\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
    for (const key of keys) {
      if (!src.some((b) => new RegExp(`route\\.query\\.${key}\\b`).test(b))) orphans.push(`${rel(f)}:?${key}`)
    }
  }
  assert(
    orphans.length === 0,
    'D107d 每一个读 route.query.<键> 的视图/组件都得为"这一个键"备真接手者(该键写在 computed 体内或 watch 的源参数里, 而不是只在回调里读一次): 身份里没有 query 之后, 一次性读就再也等不到重挂来救它。这份名单是 5 个文件 5 个键(工作区 view、账号页 plat、顶栏 plat、设置页 sec、诊断台 sec), 再多一处就得先回答"它切过来接不接得住"',
    `无接手者=${orphans.join(',') || '无'}`
  )
  // ---- D107e 顶栏的平台读数不能改成一次性 ----
  assert(
    /const plat = computed<Platform>\(\(\) => \{\s*if \(isPlatform\(route\.params\.plat\)\)/.test(nav),
    'D107e 顶栏的当前平台是 computed: 它在账号页退到 ?plat=, 而账号页换方现在只改 query 不重挂 —— 顶栏高亮、头像状态与页面内容必须指向同一方(TopNav :19 那句话), 一次性读就等于在账号页点了分段而顶栏不动'
  )
}

// ============ D108: 复核 —— 设置页 ?sec= 深链的接手者必须盯住 sec 本身 ============
// 这一组是复核当天真机抓出来的那一格(复核补): 视图身份收窄之后, "已在设置页时再换 ?sec=" 不再重挂,
// 而落位那段挂在 scrollRef 上 —— 容器早就有了, 于是 watch 不重跑, 滚位原地不动(两次读数 scrollTop 都是 251)。
// D107d 那条普查当时也没拦住它: 文件里"确实有个 watch"。所以判据要精确到"盯的是哪一个键"。
{
  const set = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'SettingsView.vue'), 'utf8')
  // ---- D108a watch 的源里必须同时有容器与这个键(少任何一个都失效: 前者=表单未到就找不到节点, 后者=不重挂时不滚) ----
  assert(
    /watch\(\s*\(\) => \[scrollRef\.value, route\.query\.sec\]/.test(set) && /\(\[el\]\) => \{/.test(set),
    'D108a 深链落位的 watch 源是 [scrollRef.value, route.query.sec] 这一对: 容器那半是为了 settings 未到(v-if="form")时等节点到手, query 那半是为了身份不含 query 之后原地换 ?sec= 也重新落位。回写成只盯 scrollRef 就退回复核抓到的那个形状 —— 点「录制设置」进得来、再点别的深链不滚, 而且不报错'
  )
  // ---- D108b 认不到的 sec 不许乱滚(名单判据仍在回调里, 而不是源里) ----
  assert(
    /if \(!el \|\| !navs\.value\.some\(\(n\) => n\.key === sec\)\) return/.test(set),
    'D108b 落位前先问这一节在不在名单里: ?sec= 是外部可写的地址(收藏夹/别人给的链接), 认不到就 return, 不许把页面滚到一个不存在的位置'
  )
}

// ============ D109: 请求预算审计 —— 四条"永不落地"的口子各自有了尽头 ============
// 这一组对着的是同一个形状: 一条请求不结束, 它上游的每一层都无限等下去, 于是"监控死了"在日志上与
// "今天没人开播"长得一模一样。实测那一夜: 慢网 12 分钟里 Panda/SOOP 两侧各卡在没回来的请求上,
// 而 SOOP 一处 ×11 的重复全部是超时换来的。五处改动(请求层超时 / 握手单独计时 / 等位上限 / 轮次看门狗 /
// 兜底判据收窄)各占一格, 变异测试逐条删。
{
  const ng = fs.readFileSync(R('src', 'main', 'services', 'netGate.ts'), 'utf8')
  const so = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const sr = seg(pd, 'private async sendRaw(')
  // ---- D109a 请求层有截止时刻, 两种 fetch 形状都带上 signal(只带一边 = 另一条路照旧永不落地) ----
  assert(
    /const API_DEADLINE_MS = Number\(process\.env\.PD_API_DEADLINE_MS \|\| 20_000\)/.test(pd) &&
      /const ctrl = new AbortController\(\)/.test(sr) &&
      /const deadline = setTimeout\(\(\) => ctrl\.abort\(\), API_DEADLINE_MS\)/.test(sr) &&
      (sr.match(/signal: ctrl\.signal/g) || []).length === 2 &&
      /finally \{\s*clearTimeout\(deadline\)/.test(sr),
    'D109a Panda 每一发 API 请求 20 秒封顶: session.fetch 与 net.fetch 两条路都挂同一个 signal(实测把 ses.fetch 的 signal 摘掉这一刀, 计数就从 2 掉到 1), 且计时器在 finally 下班不放空枪。这一格可由 PD_API_DEADLINE_MS 压刻度(与 PD_LANE_QUEUE_CAP 同门, 生产不设) —— 默认值仍在断言里'
  )
  // ---- D109b 截止时刻罩住正文: 响应头到手而 body 半路停住是同一个病(按先后次序判, 不按字符距离) ----
  {
    const iDeadline = sr.indexOf('const deadline = setTimeout')
    const iText = sr.indexOf('text = await res.text()')
    const iFinally = sr.indexOf('finally {')
    assert(
      iDeadline >= 0 && iText > iDeadline && iFinally > iText && /clearTimeout\(deadline\)/.test(sr.slice(iFinally, iFinally + 120)),
      'D109b 那把 20 秒的尺子把 await res.text() 一并罩在里面(而不是只掐 fetch): 头到了、正文停在半路同样锁死车道与轮次 —— 把 text 挪到 finally 之后是最省事的回退写法'
    )
  }
  // ---- D109c 超时不换第二发: 兜底判据仍只认 ERR_FAILED ----
  assert(
    (pd.match(/includes\('ERR_FAILED'\)/g) || []).length === 1 &&
      /if \(e instanceof Error && e\.message\.includes\('ERR_FAILED'\)\)/.test(sr) &&
      !/rescueOnTimeout/.test(pd),
    'D109c Panda 的 Node 兜底只在 Chromium 网络层报错时开火, 判据一处且没有"超时也救"的旁路: 实测 Node abort 抛的是 AbortError/「This operation was aborted」, 串里不含 ERR_FAILED ⇒ 我方截止时刻到点不会把同一请求打第二遍'
  )
  // ---- D109d 代理回 200 之后沉默: 握手那一段单独有尽头 ----
  assert(
    /const TLS_HANDSHAKE_MS = 15_000/.test(pd) &&
      /const handshake = setTimeout\(\(\) => s\.destroy\(new Error\(mt\('net\.proxyTimeout'\)\)\), TLS_HANDSHAKE_MS\)/.test(pd) &&
      /s\.on\('secureConnect', \(\) => \{\s*clearTimeout\(handshake\)/.test(pd) &&
      /s\.on\('error', \(e\) => \{\s*clearTimeout\(handshake\)/.test(pd),
    'D109d CONNECT 拿到 200 以后的 TLS 握手自己计时并撤两端: conn 那 15 秒在 200 之后已下班, 而"代理回 200 然后一言不发"(黑洞代理 hang 模式实测的形状)既不给 secureConnect 也不给 error —— 漏一端就漏一整类'
  )
  // ---- D109e 等位有尽头, 到点按失败收且交出自己那一格 ----
  assert(
    /const QUEUE_MAX_WAIT_MS = Number\(process\.env\.PD_LANE_QUEUE_CAP/.test(ng) &&
      ng.includes('PD_LANE_QUEUE_CAP || 120_000') &&
      /if \(prev !== IDLE\) \{/.test(ng) &&
      /const timedOut = await Promise\.race\(\[/.test(ng) &&
      /if \(timedOut\) \{\s*release\(\)/.test(ng) &&
      ng.includes('throw new Error(`netGate: ${host} 等位超时`)'),
    'D109e `await prev` 换成了带尽头的等位: 空道(IDLE)不挂计时, 到点先 release() 交出自己那一格再抛(不交 = 把同一次卡住传染整条队), 且不硬放行 —— 同站两发在飞正是这一层要消灭的形状'
  )
  // ---- D109f 轮次卡死出声, 但不放行下一轮 ----
  assert(
    /watchdog: NodeJS\.Timeout \| null/.test(wt) &&
      /L\.watchdog = setTimeout\(\s*\(\) => logger\.warn\('watcher'/.test(wt) &&
      /L\.watchdog\.unref\?\.\(\)/.test(wt) &&
      /if \(L\.watchdog\) \{\s*clearTimeout\(L\.watchdog\)/.test(wt) &&
      (wt.match(/L\.inFlight = false/g) || []).length === 1 &&
      /if \(L\.inFlight\) return/.test(wt),
    'D109f 看门狗只报不医: 超时那一格只 logger.warn, 全程唯一一处 L.inFlight = false 仍在轮次 finally 里, runRound 开头的在飞闸一个键都没松 —— 强清标志会让两轮并发写同一批 anchor(撞上 epoch 合并与离线判定的时序假设), 比它省下的一段延迟更贵'
  )
  // ---- D109g SOOP 兜底判据: 网络层错才重发, 我方超时不重发 ----
  assert(
    /timeoutMs = 15_000, rescueOnTimeout = false/.test(so) &&
      /const netLayerErr = \/ERR_\/\.test\(e\.message\)/.test(so) &&
      /if \(!netLayerErr && !\(rescueOnTimeout && \/abort\|timeout\/i\.test\(e\.message\)\)\) throw e/.test(so),
    'D109g 会话请求的兜底从 /ERR_|abort|Timeout/i 一刀收成两条: 只有 Chromium 网络层错(ERR_)无条件重发, 我方 abort 默认直接抛 —— 旧判据把"超时"也算进去, 于是慢网期同一请求打两遍(实测 live.sooplive 一处 ×11)。默认参数 false 是安全侧: 加新调用点不假思索就不会重发'
  )
  // ---- D109h 唯一的例外是预言机那一发, 且只有它 ----
  assert(
    /this\.req\(FAVORITES_API, \{ headers \}, 20_000, true\)/.test(so) &&
      (so.match(/this\.req\([^\n]*, true\)/g) || []).length === 1,
    'D109h rescueOnTimeout 全文件只点亮一次(关注列表那一发): 它失败的代价不是少一次读数而是整轮逐房探针(实测降级一轮 40 发、其余 678 房本轮不读), 一发重复比 40 发扇出便宜。多点亮一处 = 这条例外正在变成新的默认'
  )
  // ---- D109i 卡住的道要在验证套子里真跑一遍, 不是只看源码形状 ----
  assert(
    /PD_LANE_QUEUE_CAP/.test(fs.readFileSync(R('scripts', 'verify-netgate.mjs'), 'utf8')),
    'D109i 车道套里有一条真等位的卡死场景(靠 PD_LANE_QUEUE_CAP 压刻度): 等位上限只在源码里出现过 = 没测过, 而它要防的正是"永远不会自己发生"的那一事 —— 静默的锁与不响的尺都是没写'
  )
}

// ============ D110: 剩下那一面无上界的尺 + 「失败不是事件」那一面 ============
// 把 API 面那四条"永不落地"的口子各自加了三尺, 但同一缺陷类在两个地方还留着:
//   ① 媒体/CDN 那一面的 fetchText(清单/VOD/master 解析) —— 它比 sendRaw 更危险: 兜底判据是
//      "除 HTTP 错外一律 Node 再打一遍", 所以光加一把尺而不挡住兜底, 就把同一请求打了两遍((e) 的形状);
//   ② 预取泵失败之后无人再补 —— 真机 12:15:24 那一发 abort 之后, 这一间直到重启都没被再试过。
// 五格各锁一处, 逐刀变异。
{
  const pd = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const ft = seg(pd, 'private async fetchText(')
  const nr = seg(wt, 'private notePrewarmResult(')
  // ---- D110a 媒体面那一发同样封顶, 两条 fetch 形状都带上 signal, 尺罩住正文 ----
  assert(
    /const ctrl = new AbortController\(\)/.test(ft) &&
      /const deadline = setTimeout\(\(\) => ctrl\.abort\(\), API_DEADLINE_MS\)/.test(ft) &&
      (ft.match(/signal: ctrl\.signal/g) || []).length === 2 &&
      (() => {
        const iDeadline = ft.indexOf('const deadline = setTimeout')
        const iText = ft.indexOf('return await res.text()')
        const iFinally = ft.indexOf('finally {')
        return iDeadline >= 0 && iText > iDeadline && iFinally > iText && /clearTimeout\(deadline\)/.test(ft.slice(iFinally, iFinally + 140))
      })(),
    'D110a fetchText 与 sendRaw 共用同一把 20 秒的尺: session.fetch 与 net.fetch 两条路都挂 signal(只挂一条 = 另一条照旧永不落地), 且尺罩住 await res.text()(头到手而正文停在半路是同一个病)'
  )
  // ---- D110b 我方到点绝不换成第二发 ----
  {
    const iAbort = ft.indexOf('if (ctrl.signal.aborted) throw')
    const iFallback = ft.indexOf('this.noteFallback(')
    assert(
      iAbort >= 0 && iFallback > iAbort && /\.httpStatus\) throw e/.test(ft.slice(0, iAbort)),
      'D110b 这一面的兜底判据比 sendRaw 宽(除 HTTP 错外一律 Node 再打一遍), 所以我方尺到点必须先于 noteFallback 抛出去 —— 顺序反了就是把同一请求打两遍 —— 正是要消灭的形状; httpStatus 那条先抛的原则同旧'
    )
  }
  // ---- D110c 预取失败成为事件: 有上限、有退避、由泵那一头调用 ----
  assert(
    /private static PREWARM_RETRY_MAX = 3/.test(wt) &&
      /private prewarmRetryBaseMs = 60_000/.test(wt) &&
      /if \(tried >= Watcher\.PREWARM_RETRY_MAX \|\| this\.prewarmRetryTimers\.has\(key\)\) return/.test(nr) &&
      /this\.prewarmRetryCnt\.set\(key, tried \+ 1\)/.test(nr) &&
      /setTimeout\(/.test(nr) &&
      /this\.notePrewarmResult\(platform, uid, r\)/.test(wt) &&
      /t\.unref\?\.\(\)/.test(nr),
    'D110c 泵里那句「失败静默」之后接上了 notePrewarmResult: 每房每场封顶 3 次、退避 n×60 秒(60/120/180)、同一间同时只挂一枚定时器, 计时器 unref 不拖退出路径(退出路径被计时器拖住那一课)'
  )
  // ---- D110d 两类答案不补 + 成功即销账 ----
  assert(
    /if \(r\?\.needPassword \|\| r\?\.needLogin\) return/.test(nr) &&
      /if \(r\?\.ok\) \{\s*this\.prewarmRetryCnt\.delete\(key\)/.test(nr),
    'D110d needPassword(预取这一路永远没有密码)与 needLogin(缺的是登录态)直接不补, 拿到源即销账 —— 门槛回执那类不用挑: 它走 getPlayCached 的短路, 补排只占一次队列、零请求'
  )
  // ---- D110e 到点重新过闸 + 停轮一起撤 ----
  {
    const iStop = wt.indexOf('stop(): void {')
    const stop = wt.slice(iStop, iStop < 0 ? undefined : bodyEnd(wt, iStop))
    assert(
      /if \(!this\.running \|\| !this\.stillMonitored\(platform, userId\)\) return/.test(nr) &&
        /if \(!store\.getSettings\(\)\.monitor\[platform\]\.prefetchStream\) return/.test(nr) &&
        /for \(const t of this\.prewarmRetryTimers\.values\(\)\) clearTimeout\(t\)/.test(stop) &&
        /this\.prewarmRetryTimers\.clear\(\)/.test(stop),
      'D110e 定时器到点重读三道闸(停轮 / 已取关 / 本平台预取已关)才排队, stop 把它们与两条队列一起撤 —— 待触发的补排同属"下一发要发真请求"的待办, 只清定时器就是把它留在手里'
    )
  }
  // ---- D110f 补排要在验证套子里真跑过, 不是只看源码形状 ----
  {
    const pc = fs.readFileSync(R('scripts', 'verify-playcache.mjs'), 'utf8')
    assert(
      /T59-2 退避到点同一间重新排上并真再发一发/.test(pc) &&
        /T59-4 封顶三次/.test(pc) &&
        /T59-7 门槛房补排三次而一发不多/.test(pc) &&
        /T59-9 停轮即撤补排/.test(pc) &&
        /watcher\.prewarmRetryBaseMs = /.test(pc) &&
        /const sweptAtStop = watcher\.prewarmRetryTimers\.size === 0/.test(pc) &&
        /const requeued = enqSeen\.filter\(/.test(pc),
      'D110f 预取补排有动态取证那一格(靠压刻度而不是等真钟): 锁「到点真的再发一发」「封顶三次」「门槛房补排零重买」「停轮即撤」—— 只在源码里出现过的上限等于没测。另两把读数是变异逼出来的: 停轮那一格必须在 stop() 之后立刻读(等下去未撤的定时器会自己摘帽, 两种写法读数一样), 取关那一格必须落在「到点有没有去排队」(泵出队那头还有一道同族闸门, 只看实发数永远分辨不了) —— 变异 M6/M7 第一轮就是这样全绿的'
    )
  }
  // ---- D110g fetchText 的两型沉默也在套子里真跑过(尺可压刻度, 生产默认另有 D109a 钉) ----
  {
    const ka = fs.readFileSync(R('scripts', 'verify-keepalive.mjs'), 'utf8')
    assert(
      /process\.env\.PD_API_DEADLINE_MS = '1500'/.test(ka) &&
        /S19-1 连上以后连头都不回/.test(ka) &&
        /S19-3 响应头到手而正文停在半路/.test(ka) &&
        /const hangVia = \(signal\) =>/.test(ka) &&
        /const withCap = async \(/.test(ka) &&
        /api\.fallbackCnt === 0/.test(ka) &&
        /api\.fallbackLogUntil = Date\.now\(\) \+ 600_000/.test(ka),
      'D110g 媒体面那把尺有行为取证(S19 两型 hang: 连头都不回 / 头到手正文停在半路, 替身必须认 signal 才测得到尺), 而"没有打第二遍"读的是 noteFallback 的计数器增量并把那一句日志拨哑 —— 取证只能落在单调读数上: 日志自带 60 秒节流, 前一场景点燃气门就会把 S19 那一句吞掉, 变异 M2 第一轮正是这样让整套保持全绿的(空绿), 计数器 + 拨哑才是真读数'
    )
  }
}

// ============ D111: 「清过源账之后谁再排队」的两条入口 ============
// 补扫只认 roundCnt===1, 而 roundCnt 是进程级的一直往上数; 登录成功那一头(ipc.ts 写着「登录后一律重取」)
// 把 playCache 整表清了, 但在播房的状态并没有翻转 ⇒ onLiveStart 不会为它们再响。两处合起来在真机上的形状是:
// 源被清掉之后, 除非用户亲手点进播放器, 这批房在这台机器剩下的寿命里都不再有源。
{
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const st = seg(wt, 'start(): void {')
  // ---- D111a 归零与排程住在同一条 PLATS 循环里(两平台各自一格, 不许只归一半) ----
  assert(
    /for \(const p of PLATS\) \{\s*this\.loop\[p\]\.roundCnt = 0\s*this\.schedule\(p, 300\)\s*\}/.test(st),
    'D111a start() 里「轮数归零」写在「排首轮」之前且同在一个 PLATS 循环: 归零挪到 schedule 之后就是把首轮那一次补扫让给下一轮, 挪出循环就是只归一个平台 —— 两种写法都不报错, 只在真机上哑'
  )
  // ---- D111b 归零只此一处, 且补扫入口仍只认首轮 ----
  assert(
    (wt.match(/roundCnt = 0/g) || []).length === 1 && /if \(L\.roundCnt === 1\) this\.prewarmSweep\(platform\)/.test(wt),
    'D111b roundCnt = 0 全文件只出现在 start() 一处(每轮都归零 = 每一轮都群发补扫, 稳态轮不许再买整批发), 补扫那一格也仍只认 roundCnt===1 —— 这一格改的是"什么时候算首轮", 不是"多久群发一次"'
  )
  // ---- D111c 补排入口复用首轮那一格, 不另开第二条排队链 ----
  {
    const rs = seg(wt, 'resweepPrewarm(')
    assert(
      /resweepPrewarm\(platform\?: Platform\): void/.test(wt) &&
        /for \(const p of platform \? \[platform\] : PLATS\) this\.prewarmSweep\(p\)/.test(rs) &&
        !/enqueuePrewarm|getPlayCached|playCache/.test(rs),
      'D111c 清账之后的补排走的是 prewarmSweep 那一格(开关 / 差集 / 去重 / 观众数排序四道旧闸一起跟着), 不是自己另起一条排队链; 参数可选 = 登录哪一台就只惊动哪一台'
    )
  }
  // ---- D111d 四个「登录成功即清账」的点各接上补排, 且次序是先清后补 ----
  {
    const sites = [
      ['const n = await soopApi.storeCookies(cookieStr)', 'soop', 'SOOP Cookie 导入'],
      ['soopApi.clearPlayCache()', 'soop', 'SOOP 网页登录'],
      ['await api.importCookies(jar, info)', 'pandalive', 'Panda Cookie 导入'],
      ['await soopApi.loginWithPassword(u, String(password', 'soop', 'SOOP 账密托管']
    ]
    const miss = []
    for (const [anchor, plat, label] of sites) {
      const i = ipc.indexOf(anchor)
      const j = ipc.indexOf(`watcher.resweepPrewarm('${plat}')`, i)
      if (i < 0 || j < 0 || j - i > 400) miss.push(`${label}=${i}→${j}`)
    }
    assert(
      miss.length === 0 && (ipc.match(/watcher\.resweepPrewarm\(/g) || []).length === 4,
      'D111d 四处「清完源账」都在清的那一头当场点名补排(先清后补: 顺序反了补扫描到的是旧账), 且全文件只有这四处 —— 补排是清账的尾巴, 不是随处可点的新请求面',
      miss.join(' ')
    )
  }
  // ---- D111e 负向: 退出登录那一格不许接补排 ----
  {
    const i = ipc.indexOf('CH.authLogout')
    const j = ipc.indexOf('ipcMain.handle', i + 10)
    const lo = ipc.slice(i, j < 0 ? undefined : j)
    assert(
      /api\.clearCookies\(\)/.test(lo) && /soopApi\.logout\(\)/.test(lo) && !/resweepPrewarm/.test(lo),
      'D111e 退出登录不把补排接上: 会话已清 ⇒ 逐房重买换回的只是整条链上那一句「要登录」(每一间都白付), 而源本来就该随会话一起作废 —— 这一条负向比正向四处更容易被"顺手统一"破坏'
    )
  }
  // ---- D111f 两处都要在验证套子里真跑过, 不是只看源码形状 ----
  {
    const pc = fs.readFileSync(R('scripts', 'verify-playcache.mjs'), 'utf8')
    assert(
      /T60-2 关-开监控即把两平台轮数各自归零/.test(pc) &&
        /T60-3 归零之后的第一轮真算作首轮/.test(pc) &&
        /T60-5 清账当场重新排队/.test(pc) &&
        /T60-6 补扫只补差集/.test(pc) &&
        /T60-7 只点名的那一台/.test(pc) &&
        /T60-8 不绕过预取开关/.test(pc),
      'D111f 有动态那一格(T60): 锁「关-开监控后的第一轮真再补扫一次」「清账当场重新排队」「一发不多」「不越平台」「不越开关」—— 只在源码里出现过的排队等于没测; 归零那一格还必须在 stop 之后读, 因为台子里轮次是脚本手动驱动的。变异七刀: 删归零(D111a/b+T60-2/3) / 只归 Panda 的半刀(D111a+T60-2 —— 第一轮 T60 看不见它, 直到舞台里也给 SOOP 数了一轮) / 补排不分平台(D111c+T60-7) / 绕开 prewarmSweep 直接排队(D111c+T60-6/8) / 少接一处(D111d) / 顺序反了(D111d) / 顺手把登出也接上(D111d/e)'
    )
  }
}

// ============ D112: 诊断台「只看不动」的三条死规矩要能被机器守住 ============
// 这一页存在的理由是"把程序本来就在记的账摆到屏幕上"。它一旦能改东西、能多发一发、能把凭据递到屏上,
// 就不再是仪表而是第二个控制台 —— 而这三条恰恰都是"今天没写错, 下次顺手加一格就写错"的形状。
// 所以这里钉的不是某个字段, 而是这一层的进出口形状: 谁能被调用、什么能被递出去、什么时候必须下班。
{
  const dg = fs.readFileSync(R('src', 'main', 'services', 'diag.ts'), 'utf8')
  const lg = fs.readFileSync(R('src', 'main', 'services', 'logger.ts'), 'utf8')
  const dv = fs.readFileSync(R('src', 'renderer', 'src', 'views', 'DiagnosticsView.vue'), 'utf8')
  const ipc = fs.readFileSync(R('src', 'main', 'ipc.ts'), 'utf8')
  const ty = fs.readFileSync(R('src', 'shared', 'types.ts'), 'utf8')
  // ---- D112a 投影层零网络: 一个请求出口都不许 import(要读数就找那本账, 不要现问平台) ----
  assert(
    !/from '\.\/(net(?!Gate)|proxy|fetch|undici|http)/.test(dg) &&
      !/\bfetch\s*\(|https?:\/\/|net\.request|new Session|session\.fromPartition\([^)]*\)\.(webRequest|loadURL|clearCache)/.test(dg) &&
      /session\.fromPartition\(partition\)\.cookies\.get\(\{\}\)/.test(dg) &&
      /import \{ laneSnapshot \} from '\.\/netGate'/.test(dg),
    'D112a diag.ts 里唯一的"对外"动作是读会话罐的 cookie 列表(cookies.get({}) 一发不发), 从 netGate 只借 laneSnapshot() 那一个读数口: 出现 fetch / 任何 URL 字面量 / webRequest / loadURL 都说明这一层开始替平台回答问题了 —— 而它的全部价值就在于它只转述账本'
  )
  // ---- D112b 投影层零写盘: 日志是写文件时顺手留的, 不回头读文件也不写 ----
  assert(
    !/fs\.|require\('fs'\)|from 'fs'|writeFile|appendFile|mkdir|unlink|saveTo|persist\(/.test(dg) &&
      !/store\.patchSettings|store\.save|setSettings|\.delete\(|\.clear\(/.test(dg),
    'D112b diag.ts 不 import fs、不写一次盘、不碰任何 store 写入面: 「为了看一眼状态而改动状态」是这一页最不该犯的事, 而 clear/delete 这类名字在主进程那批模块里都是真会动手的入口'
  )
  // ---- D112c 只递本来就在记的数: 每个源都经它自己的 diag()/stats() 交账, 投影不伸手进别人的内部 ----
  assert(
    /soopApi\.diag\(\)/.test(dg) && /api\.diag\(\)/.test(dg) && /watcher\.diag\(\{ soop: sd\.riskLeftMs, pandalive: pd\.riskLeftMs \}\)/.test(dg) &&
      /recorder\.diag\(\)/.test(dg) && /thumbs\.diag\(\)/.test(dg) && /imgCache\.stats\(\)/.test(dg) && /store\.diag\(\)/.test(dg) &&
      /laneSnapshot\(\)/.test(dg) && /logRing\.stats\(\)/.test(dg),
    'D112c 九本账各经自己的公开读数口交账(watcher 的两把风控钟由调用方把 soop/pandalive 各自的 riskLeftMs 递进去 —— 它自己不认识两个平台)。新增一格的正路是"去那本账加个读数", 歪路是"在 diag.ts 里现算一个"; 断言认的是正路的形状'
  )
  // ---- D112d 负向: 没有账的格子宁可空着, 也不许在投影层现编一个数 ----
  assert(
    !/Math\.random|\bDate\.now\(\)\s*[-+]\s*\d{4,}/.test(dg) && /ttlLeftMs: number \| null/.test(ty),
    'D112d 投影层不掷骰子也不"减个默认值当读数": 类型里 ttlLeftMs 必须是可空(Panda 的源不按年龄收手, 那一格今天就没有账, 于是递 null 而不是递一个看着合理的 3 小时)。设计稿 0.1 规矩②的字面化'
  )
  // ---- D112e 环形账有上限, 且"滚走了多少"要说出来 ----
  assert(
    /const RING_CAP = (\d+)/.test(lg) && /ring\.length > RING_CAP\) ring\.shift\(\)/.test(lg) &&
      /dropped: Math\.max\(0, total - ring\.length\)/.test(lg) && /remember\(level, scope, msg, Date\.now\(\)\)/.test(lg),
    'D112e 日志留档是定长环形(写文件的同一发顺手 remember, 不额外读盘), 且 stats() 里 dropped = 总数 - 在手: 屏幕上那 600 行必须能说出"更早的还有 N 条我没拿到", 否则"看着全其实是截了"比不显示更坏'
  )
  // ---- D112f 脱敏在往外递的那一步, 而不是在记账那一步 ----
  assert(
    /text: redact\(r\.text\)/.test(dg) && !/redact/.test(lg) &&
      /\(cookie\|set-cookie\|token\|password\|passwd\|secret\|authorization\|aid\|authticket\|userticket\)/.test(dg) &&
      /const SIGNED_URL/.test(dg) && /export async function snapshot/.test(dg) &&
      /keys\.[a-z]+ = await keyJar\(/.test(dg) && !/\.value/.test(dg.slice(dg.indexOf('async function keyJar'), dg.indexOf('/** 一屏的全部读数'))),
    'D112f 盘上那份保持原样(logger.ts 里没有 redact), 只有往外递的日志行过 redact: 键名清单含 cookie/token/password/authorization/aid/authticket/userticket, 外加"任意 http/代理地址的 ? 之后整截"(临时签名地址等于一次性门钥匙)。keyJar 里不许出现 .value —— 罐里那几枚的枚数与期限是事实, 值本身不是'
  )
  // ---- D112g 渲染层只有两个只读入口, 且这一页没有任何开关 ----
  {
    const calls = [...new Set([...dv.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))]
    assert(
      calls.every((c) => c === 'diagSnapshot' || c === 'diagLogs') && calls.length === 2 &&
        !/<n-switch|NSwitch|type="checkbox"|type="radio"|type="range"|@click="api\./.test(dv) &&
        !/isLoggedIn|authState|t\('acct\./.test(dv) && !/\.partition/.test(dv),
      'D112g 诊断台只调 api.diagSnapshot / api.diagLogs 两个入口(今天恰好这两个), 模板里没有开关类控件、不引登录态、不引会话分区名: 这一页"只看不动"是设计稿写死的边界 —— 要改设置的正路是跳设置页那一节, 不是在这里再摆一个开关(摆第二个开关就有第二份同步逻辑)',
      `入口=${calls.join(',')}`
    )
  }
  // ---- D112h 这一页自己不添乱: 计时器会下班, 没人看的时候不拉 ----
  assert(
    /onUnmounted\(\(\) => \{\s*if \(timer\) clearInterval\(timer\)\s*timer = null/.test(dv) &&
      /if \(auto\.value && document\.visibilityState === 'visible'\) void poll\(\)/.test(dv) &&
      /if \(busy\) return/.test(dv),
    'D112h 三处自护: 卸载清计时器(KeepAlive 之前这一页是整片重挂的, 漏一处就是每挂一次多一条 2 秒队), 窗口藏进托盘时不拉(没人看的那一屏不该占主进程 IPC), busy 闸挡住叠起来的轮(上一发没回来就再点一次 = 同一份账读两遍)'
  )
  // ---- D112i IPC 桥面: 两个入口都只读, 且渲染层送来的数当不可信输入过一遍 ----
  {
    const i = ipc.indexOf('ipcMain.handle(CH.diagSnapshot')
    const blk = ipc.slice(i, i + 460)
    assert(
      i > 0 && /=> diagSnapshot\(\)/.test(blk) && /Math\.min\(Math\.max\(Number\(limit\) \|\| 400, 1\), 800\)/.test(blk) && !/logger\.|fs\.|store\.patch/.test(blk),
      'D112i 桥面那两行只做转发与夹取: limit 过 [1,800] 的夹(这一条口子递出去的是日志原文, 上限就是它的形状), 且不在这里顺手写日志或改设置'
    )
  }
  // ---- D112j 0.2「别把屏幕上已有的再画一遍」: 顶栏胶囊那三个数原样不搬 ----
  assert(
    !/t\('nav\.live'\)|t\('topbar\.|roundMs \?\? |上次检查/.test(dv) &&
      /fmtRoundCost\(snap\.rounds\[p\]\.measuredRoundMs\), sec: pollSec\(p\)/.test(dv),
    'D112j 这一页不重列顶栏胶囊与分段行已有的读数(间隔 / 上一轮耗时 / 登录了没有 / 关注几间·在播几间·上次检查几点); ① 那一格只放胶囊没有的那一截 —— 实测轮距与设定的差(pollSec 只作为差的分母出现, 不单独摆一行)'
  )
  // ---- D112k 顶栏三条 tab 与诊断台的路由身份: 不分平台, 也不参与"下次打开回到哪" ----
  {
    const rt = fs.readFileSync(R('src', 'renderer', 'src', 'router.ts'), 'utf8')
    assert(
      /path: '\/diag', name: 'diag'/.test(rt) && !/:plat\/diag/.test(rt) &&
        /if \(name === 'diag'\) \{\s*router\.push\(\{ name: 'diag' \}\)\s*return\s*\}/.test(fs.readFileSync(R('src', 'renderer', 'src', 'components', 'TopNav.vue'), 'utf8')),
      'D112k /diag 不带 :plat 段(它同时看两边), 顶栏点它时也不补平台段: 补了就多出一个"诊断台的 Panda/SOOP 之分"的假概念, 还会把 :plat 写进 URL 让"下次打开回到哪"记到一个不该记的页上'
    )
  }
  // ---- D112l 每一发都要有尽头, 而且停住了要自己承认(设计稿 5.2「两个新调用各带超时」那一行) ----
  assert(
    /function withDeadline<T>\(p: Promise<T>, ms = (\d+)\)/.test(dv) && /Promise\.race\(/.test(dv) &&
      /.finally\(\(\) => \{ if \(kick\) clearTimeout\(kick\) \}\)/.test(dv) &&
      /withDeadline\(api\.diagSnapshot\(\)\)/.test(dv) && /withDeadline\(api\.diagLogs\(sinceSeq/.test(dv) &&
      /noAnswer\.value = true/.test(dv) && /noAnswer\.value = false/.test(dv) &&
      /v-if="noAnswer"[^>]*badge badge-md/.test(dv) &&
      /noAnswer \? t\('diag\.noSnap'\) : t\('common\.loading'\)/.test(dv),
    'D112l 两个入口各过 withDeadline(4 秒): 桥面那一头永不落地时 busy 会一直举着, 计时器从此每 2 秒撞一次闸, 屏幕停在一屏没人说明的读数上 —— race 的计时器在真回包到手时 clearTimeout(不放空枪), 失败分支置 noAnswer 并在页头挂「程序 4 秒没回话」的提醒徽标(成功分支收回); 一屏都没读到时也不许挂着「加载中」—— 那一行在过尺之后就是假话。"留着上一屏"本身没错, 错的是让它看起来像现在的。"两个入口各过"是逐个调用点钉的(withDeadline(api.diagLogs(sinceSeq 那一处才算, 只在缓冲滚走后的补排那一次过尺不算 —— 变异刀 K14 正是从这里空的)'
  )
  // ---- D112m 快照先进账, 日志那一发挂住只该旧列表 ----
  {
    const snapAt = dv.indexOf('snap.value = s')
    const logsAt = dv.indexOf('api.diagLogs(sinceSeq')
    assert(
      snapAt >= 0 && logsAt >= 0 && snapAt < logsAt &&
        /let snapOk = false/.test(dv) && /snapOk = true/.test(dv) && /if \(snapOk\) \{/.test(dv) &&
        /logStale\.value = true/.test(dv) && /logStale\.value = false/.test(dv) &&
        /v-if="logStale"[^>]*badge badge-sm/.test(dv) &&
        /logStale && !lines\.length \? t\('diag\.logNoneStale'\) : t\('diag\.logNone'\)/.test(dv),
      'D112m 快照落账排在日志那一发之前(真机挂住 diagLogs 实测出来的: 原先两者同一条 try, snap.value 的赋值排在 await 日志之后 ⇒ 只挂日志也把整屏十二节抹成空白, 而它明明每一节都读到了)。现在日志那一发自己一条 try, 失败只置 logStale 并在⑫日志那一节的标题上挂一枚小徽标 —— 旧的是列表就说列表旧, 不顺手把没坏的也报成停了; 列表一行都没有时那句空话也分两种: 一行都没递过来 ≠ 递来了但被筛选条件挡住'
    )
  }
  // ---- D112n ⑩缓存那本账的名字: 主进程点的名与两边翻译表逐个对, 翻译表落空时必须回原名 ----
  {
    const cb = dg.slice(dg.indexOf('caches: ['), dg.indexOf('proxy: {'))
    const emitted = [...cb.matchAll(/name: '([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])
    const titled = (f) => {
      const o = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', f)))
      return Object.keys(o).filter((k) => k.startsWith('diag.cacheName.')).map((k) => k.slice('diag.cacheName.'.length))
    }
    const zhN = titled('zh-CN.ts')
    const enN = titled('en-US.ts')
    const missing = emitted.filter((n) => !zhN.includes(n) || !enN.includes(n))
    const orphan = zhN.filter((n) => !emitted.includes(n))
    assert(
      emitted.length >= 8 &&
        missing.length === 0 &&
        orphan.length === 0 &&
        zhN.length === enN.length &&
        zhN.slice().sort().join(',') === enN.slice().sort().join(',') &&
        /const k = `diag\.cacheName\.\$\{n\}`/.test(dv) &&
        /return lbl === k \? n : lbl/.test(dv),
      'D112n ⑩那一表的名字两边各数一遍(全面检查查出来的空格): 主进程 caches 里点名的每一个都得在中英文表里有写法, 反过来表里不许留已经没人点的名 —— 渲染那一头 cacheName 现在带兜底(表里没有就摆原名), 屏幕上看不出翻译表掉过键, 掉了就是普通人的屏上出现 srcPlaySoop 这种内部代号; 而名是两边各写各的, 下一次改名只有一个人记得改。emitted.length>=8 先兜住"解析空转=假绿"(D9f 同款教训)'
    )
  }
  // ---- D112o ⑫日志那一行的 scope 名: 主进程用得到的每一个, 两边表里都要有写法, 落空必须回原名 ----
  {
    const mainAll = walk(R('src', 'main'), /\.ts$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    const usedScope = [
      ...new Set([
        ...[...mainAll.matchAll(/logger\.(?:info|warn|error|debug)\('([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]),
        // 界面自己报上来的那一行不是 logger.info('名字', …) 这种写法, 是 logger[级别]('名字', …) —— 只数前一种就会漏掉 renderer
        ...[...mainAll.matchAll(/logger\[[^\]]*\]\('([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
      ])
    ]
    const scoped = (f) => {
      const o = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', f)))
      return Object.keys(o).filter((k) => k.startsWith('diag.scopeName.')).map((k) => k.slice('diag.scopeName.'.length))
    }
    const zhS = scoped('zh-CN.ts')
    const enS = scoped('en-US.ts')
    const noZh = usedScope.filter((x) => !zhS.includes(x))
    const noEn = usedScope.filter((x) => !enS.includes(x))
    assert(
      usedScope.length >= 12 &&
        noZh.length === 0 &&
        noEn.length === 0 &&
        /const k = `diag\.scopeName\.\$\{s\}`/.test(dv) &&
        /return lbl === k \? s : lbl/.test(dv) &&
        /map\[s\] \|\| s/.test(dv),
      'D112o 日志行的 scope 名两边各数一遍(与 D112n 同一条教训, 只是这本账不在诊断台里点, 而是从 logger.info(scope, ...) 与界面转发那条 logger[级别](scope, ...) 两类调用点里长出来的: 全仓 ' +
        usedScope.length +
        ' 个 scope 都要有中英两种写法, 新增一个而忘了翻译时普通人屏幕上就直接印 watcher/rec 这种内部代号; 兜底也逐个钉 —— scopeName 落空回原名、级别那本 map 缺项回原名(不硬翻成 info)'
    )
  }
  // ---- D112p ⑩表里那三把抄来的尺: 与服务里的常量同值(其余的 cap/ttl 是原样转账本, 不用钉) ----
  {
    const num = (v) => Number(String(v).replace(/_/g, ''))
    const ic = fs.readFileSync(R('src', 'main', 'services', 'imgCache.ts'), 'utf8')
    const sp = fs.readFileSync(R('src', 'main', 'services', 'soop.ts'), 'utf8')
    const imgCap = num(/const MAX_ENTRIES = ([\d_]+)/.exec(ic)[1])
    const imgTtl = num(/const TTL_MS = ([\d_]+)/.exec(ic)[1])
    const loginCap = num(/LOGIN_CACHE_MAX = ([\d_]+)/.exec(sp)[1])
    const bnoTtl = num(/BNO_TTL = ([\d_]+)/.exec(sp)[1])
    const row = (name) => {
      const m = new RegExp(`name: '${name}',[^}]*`).exec(dg)
      return m ? m[0] : ''
    }
    const imgRow = row('img')
    const loginRow = row('loginSoop')
    const bnoRow = row('bnoSoop')
    assert(
      num(/cap: ([\d_]+)/.exec(imgRow)[1]) === imgCap &&
        num(/ttlMs: ([\d_]+)/.exec(imgRow)[1]) === imgTtl &&
        num(/cap: ([\d_]+)/.exec(loginRow)[1]) === loginCap &&
        num(/ttlMs: ([\d_]+)/.exec(bnoRow)[1]) === bnoTtl,
      'D112p 屏幕上「上限/多久过期」那三格是把服务里的常量抄了一份过来(封面图 ' +
        imgCap +
        '/' +
        imgTtl +
        ' ms、SOOP 登录核对 ' +
        loginCap +
        '、场次号 ' +
        bnoTtl +
        ' ms) —— 抄的就得对着: 服务那边改数而这里没跟着改, 屏幕会说谎说"到 300 张才剪", 而实际早就在按新数剪。其余每一格的 cap/ttl 都直接从 sd./pd./img. 的账上取, 本来就是同一个数, 不需要钉'
    )
  }
  // ---- D112q 复核: 门槛账的每一格自带原始码, 屏上那两格不许再从"已本地化的那句话"里反推 ----
  {
    const pl = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
    assert(
      /private gates = new Map<string, \{ until: number; pack: PlayResult; code: string \}>/.test(pl) &&
        /this\.gates\.set\(a\.userId, \{ until, pack: this\.gateResult\(a\.gateCode, ''\), code: a\.gateCode \}\)/.test(pl) &&
        /this\.gates\.set\(userId, \{ until, pack: gate, code \}\)/.test(pl) &&
        /kind: g\.pack\.needPassword \? 'pw' : g\.pack\.needLogin \? 'login' : g\.code, persisted: PandaApi\.GATE_PERSIST\.includes\(g\.code\)/.test(pl) &&
        (pl.match(/this\.gates\.set\(/g) || []).length === 2,
      'D112q 门槛账的每一格自己带码(读盘那一路 + 平台刚答那一路, 写点恰好两处): diag() 的 kind 与「重启后还挡着」从前是拿 pack.error 那句**已经翻过语言**的话 split(\":\") 反推的 —— 五个正经码走的都是整句翻译, 反推出来的是"付费直播间"这种句子, 于是永远不在 GATE_PERSIST 里。真机实拍: 盘上那五间一颗徽章都没亮, 而 kind 绕过渲染层自己的翻译表(换语言就把旧话钉在旧语言上)。写点数===2 是防"第三条路 set 时忘了带码"'
    )
    assert(
      !/pack\.error[^\n]*split\(':'\)/.test(pl),
      'D112q2 反推那条路整个断掉: 主进程里不再从 pack.error 切冒号。回到这个写法只要一次, 屏上那一格就又变成"只有没认出来的码才亮徽章"——恰好把落盘那三类说成不在盘上'
    )
  }
  // ---- D112r ⑩「多久过期」那一格: 撤掉阶梯之后这一格就是一个数, 且两处口径跟着主进程那把尺 ----
  {
    const zh = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts')))
    const en = flatten(evalDefault(R('src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts')))
    const pl = fs.readFileSync(R('src', 'main', 'services', 'pandalive.ts'), 'utf8')
    const base = (/private static GATE_TTL_MS = (\d+) \* 60_000/.exec(pl) || [, '0'])[1]
    assert(
      Number(base) === 15 &&
        !/GATE_LADDER_MS|gateTries/.test(pl) &&
        /function ttlCell\(c: DiagCacheRow\): string \{\s*return c\.ttlMs === null \? t\('diag\.ttlNone'\) : dur\(c\.ttlMs\)\s*\}/.test(dv) &&
        /\{\{ ttlCell\(c\) \}\}/.test(dv) &&
        !/diag\.ttlLadder/.test(dv) &&
        !/ttlLadder/.test(JSON.stringify(zh)) &&
        !/ttlLadder/.test(JSON.stringify(en)) &&
        String(zh['diag.gatesNote']).includes(`记 ${base} 分钟`) &&
        String(en['diag.gatesNote']).includes(`for ${base} minutes`),
      'D112r 撤掉递增退避之后「多久过期」回到一个数: ⑩那一格念主进程递上来的 gateTtlMs(这边不抄字面值, 只留"不按时间剪"那一支), ⑫ 那句说明里的分钟数与同一把尺钉在一起(base 就是 15)。gatePanda 的专门写法与 ttlLadder 那两把键一并删净 —— 屏上写着"一档一档往后挪"而源码里只有一把尺, 就是让读数替一个不存在的机制说话。变异刀 K5 由此反过来: 把 gatePanda 那一支加回去才红, 删掉它不再是一条路'
    )
  }
}

// ============================================================================
// D113: 预取泵的步距跟着设置那把尺走 —— 300~1199 那一段从前被 Math.max(1200, gap) 顶回,
//   设置页允许 300 而泵只认 1200 ⇒ 用户把滑块往下拖等于没拖(死带)。车道那一侧用的是原值, 两路不同尺。
// D114: 「verify 有几套」这个数字写在四处文案里, 链从 10 长到 12 之后那四处全过期 —— 现在拿真量对账
// ============================================================================
{
  const seg = (s, decl) => {
    const i = s.indexOf(decl)
    if (i < 0) return ''
    const j = bodyEnd(s, i)
    return s.slice(i, j < 0 ? undefined : j)
  }
  const wt = fs.readFileSync(R('src', 'main', 'services', 'watcher.ts'), 'utf8')
  const sg = fs.readFileSync(R('src', 'main', 'services', 'settingsGuard.ts'), 'utf8')
  const pump = seg(wt, 'private async pumpPrewarm(platform: Platform): Promise<void> {')
  assert(/const gap = store\.getSettings\(\)\.monitor\[platform\]\.requestGapMs/.test(pump) && /await sleep\(gap \* \(0\.8 \+ Math\.random\(\) \* 0\.4\)\)/.test(pump), 'D113a 泵这一头的步距读的就是设置那一格(逐平台各读各的), 抖动照旧保留 —— 下限由 settingsGuard 说了算, 不由泵自己再夹一道')
  assert(!/Math\.max\(1200/.test(wt.split(/\r?\n/).filter((l) => !isCommentLine(l)).join('\n')), 'D113b 负向: 1200 那个字面值不许再回到 watcher 的代码行里(注释里作为"从前怎么写"的交代留着)。它从前住在 sleep 的那一句里把 300~1199 整段吃掉, 而设置页允许到 300 —— 两处各写一把尺, 用户看到的永远是宽的那一把')
  assert(/requestGapMs: \[300, 10000\]/.test(sg), 'D113c 闸门那把尺仍是 [300, 10000](泵跟随的是这一把; 把它改窄就等于把"跟随"改成"另一定义"): 0 与负数进不来, 所以泵这一头不需要自己的下限')
  assert(/if \(platform === 'pandalive'\) api\.setGap\(gap\)/.test(pump), 'D113d 车道那一句用的是同一个 gap: 修完之后两路同一把尺(从前泵 1200 / 车道原值, 同一个设置两个读数)')

  const pkg = JSON.parse(fs.readFileSync(R('package.json'), 'utf8'))
  const chain = (String(pkg.scripts.verify).match(/verify-[a-z0-9-]+\.mjs/g) || [])
  const onDisk = walk(R('scripts'), /\.mjs$/)
    .map((f) => f.split(/[\\/]/).pop())
    .filter((n) => n.startsWith('verify-'))
  assert(chain.length === onDisk.length && onDisk.every((n) => chain.includes(n)), 'D114a package.json 的 verify 串起 scripts/ 里全部 verify-*.mjs: 漏一套 = CI 与「npm run verify」都在假绿(那套自己的格子一个都不跑, 而链照样退 0)', `串=${chain.length} 盘=${onDisk.length}`)
  const n = chain.length
  const DOC = [
    ['README.md', /(\d+) 个纯 Node 脚本/],
    ['README.md', /verify-\*\.mjs 行为回归链\((\d+) 个\)/],
    ['README_EN.md', /(\d+) pure-Node scripts/],
    ['README_EN.md', /behaviour chain \((\d+)\)/],
    ['.github/workflows/release.yml', /共 (\d+) 个脚本/],
    ['.github/workflows/ci.yml', /现为 (\d+) 个/]
  ]
  for (const [f, re] of DOC) {
    const t = fs.readFileSync(R(f), 'utf8')
    const m = re.exec(t)
    assert(m && Number(m[1]) === n, `D114b ${f} 里这一处写的套数 == 链上真实的 ${n}(数字是抄来的快照: 链从 10 长到 12 那两轮没人回来改文案, 四处就过期了四年份的读数)`, m ? `${m[1]} vs ${n}` : '无匹配')
  }
  const ENUM = [
    ['README.md', /个纯 Node 脚本\(([^)]*)\)/],
    ['README_EN.md', /pure-Node scripts \(([^)]*)\)/],
    ['.github/workflows/release.yml', /行为回归链\(([^)]*)\)/]
  ]
  for (const [f, re] of ENUM) {
    const t = fs.readFileSync(R(f), 'utf8')
    const m = re.exec(t)
    const items = m ? String(m[1]).split(',')[0].split('/').filter((x) => x.trim()).length : 0
    assert(items === n, `D114c ${f} 那份枚举逐个点名到 ${n} 套(只改数字不补名 = 读者仍然不知道 netgate/imgcache 这两套是谁)`, `项=${items}`)
  }
}

// ============================================================================
console.log('\n' + '─'.repeat(72))
console.log(`设计契约: 通过 ${PASS} / 失败 ${FAIL}`)
if (FAIL) {
  console.log('\n失败项:')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
