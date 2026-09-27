// ============ 主进程文案 i18n ============
// 主进程产生的用户可见文案(toast/错误/状态条)统一经 mt() 取词
// locale 由 index.ts 启动时 + ipc settingsSet 变更时经 setMainLocale() 单向注入
// (避免 i18n 反向依赖 store 造成 util ↔ i18n ↔ store 循环引用)
// =======================================

let mainLocale = 'zh-CN'

/** 启动/设置变更时注入语言(单向数据流: store -> i18n) */
export function setMainLocale(l: string): void {
  mainLocale = l === 'en-US' ? 'en-US' : 'zh-CN'
}

type Dict = Record<string, string>

const zh: Dict = {
  // watcher
  'watcher.liveStart': '{nick} 开播了',
  'watcher.fanLiveStart': '粉丝房开播: {nick}',
  'watcher.roomAdult': '变为 19+ 房间',
  'watcher.roomFan': '变为粉丝房',
  'watcher.roomBoth': '变为 19+ 粉丝房',
  'watcher.clickWatch': '点击观看',
  'watcher.liveEnd': '{nick} 下播了',
  'watcher.circuitTitle': '监控熔断',
  'watcher.circuit': '检测到风控/连续失败({msg}), 已熔断 {minutes} 分钟',
  'watcher.cooling': '风控冷却中, {remain}s 后恢复',
  'watcher.roundFail': '本轮失败: {msg}',
  'watcher.bjGone': '关注的主播 @{id} 查无此人',
  'watcher.bjGoneHint': '该账号可能已改名/注销(或 ID 填错), 后续不再为其发请求; 建议到已关注页核对移除',
  // recorder
  'rec.toastStart': '开始录制 {nick}',
  'rec.toastDone': '{nick} 录制完成',
  'rec.segs': '{n} 个分段',
  'rec.toastErr': '{nick} 录制出错',
  'rec.toastStartFail': '{nick} 录制启动失败',
  'rec.needPw': '密码房: 需要密码才能录制',
  'rec.diskLow': '磁盘剩余空间不足 {limit}GB, 无法开始录制',
  'rec.diskStop': '磁盘剩余空间不足 {limit}GB, 已停止录制',
  'rec.stall': '源停滞无数据(可能已失效), 请手动重新开始录制',
  'rec.stallVod': '下载停滞无数据(源可能已失效), 请手动重新开始',
  'rec.interrupted': '录制中断({reason}), 主播仍在播, 请手动重新开始录制',
  'rec.retryResume': '源已失效, 自动续录中(第 {n} 次)',
  'rec.retryGiveUp': '自动续录已连续失败 {n} 次, 停手(可手动重新开始)',
  'rec.vodInterrupted': '回放下载中断({reason}), 请手动重新开始',
  'rec.streamEnd': '流连接结束',
  'rec.fetchFail': '获取直播流失败',
  'rec.failToast': '录制失败',
  // api / play
  'api.needAdult': '成人限制房: 需要已成人认证的登录Cookie',
  'api.needLogin': '需要登录后观看',
  'api.needFan': '粉丝团专属: 当前账号无权限',
  'api.needUnlimitItem': '该房间已满员: 平台要求购买「满员入场券」道具才能进入(付费门槛)',
  'api.needCoinPurchase': '付费直播间: 账号爱心余额不足, 需在平台充值爱心后观看(付费门槛)',
  'api.needPw': '密码房: 需要正确密码',
  'api.playFail': '播放失败',
  'api.noStream': '未获取到直播流(可能已下播或为回放)',
  'api.deadChannel': '直播频道已失效(主播疑似刚下播), 请稍后重试',
  'api.vodParseFail': '回放流地址未解析到(已记录到 data/logs, 反馈请附当日日志)',
  'api.riskHttp': 'HTTP {status} (可能被风控)',
  'api.riskServer': 'HTTP {status} 服务器错误',
  'api.riskHtml': '返回HTML(疑似风控验证页)',
  'api.riskJson': '响应不是JSON(疑似风控)',
  // auth
  'auth.loginOkAdult': '登录成功, 账号含成人认证',
  'auth.loginOkNoAdult': '登录成功(账号未通过 pandalive 成人认证)',
  'auth.cancelled': '已取消登录',
  'auth.importNoSess': '未找到 sessKey, 请确认粘贴的是 pandalive.co.kr 的完整 Cookie',
  'auth.importInvalid': 'Cookie 已过期或无效(官方会话校验未通过), 请在浏览器中重新登录后再复制',
  'auth.importOkAdult': '导入成功, 账号含成人认证',
  'auth.importOkNoAdult': '导入成功(账号暂未通过成人认证)',
  // anchors
  'anchors.invalid': '无效的主播 ID 或链接',
  'anchors.exists': '该主播已在监控列表中',
  // ipc play wrapper
  'ipc.playFail': '获取直播流失败: {msg}(可能是临时风控或网络问题, 稍后重试)',
  // misc: 托盘/窗口标题/网络/合并/ffmpeg/文件名
  'tray.show': '显示主窗口',
  'tray.quit': '退出',
  'auth.winTitle': '登录 PandaLive',
  'auth.winMissing': '窗口不存在',
  'app.updFail': '检查更新失败: {msg}',
  'app.unnamed': '未命名',
  'net.timeout': '请求超时',
  'net.proxyTimeout': '代理连接超时',
  'net.proxyFail': '代理 CONNECT 失败: HTTP {code}',
  'api.bjFail': 'member/bj 失败',
  'rec.ffmpegMissing': 'ffmpeg 未安装',
  'rec.mergeNoTask': '任务不存在或已被清理',
  'rec.mergeNoDir': '录制目录不存在(文件可能已被移动/删除)',
  'rec.mergeNoFiles': '该任务没有可合并的文件',
  'rec.mergeFew': '分段不足 2 个, 无需合并',
  'rec.mergeFail': '合并失败(ffmpeg 未成功完成, 详见日志)',
  'rec.delNoTask': '任务不存在或已被清理',
  'rec.delLocked': '{name} 等 {n} 个文件删除失败(可能被占用)',
  'rec.delFileNotIn': '该文件不属于此任务',
  'rec.delFileLocked': '文件删除失败(可能正在被播放)',
  // telegram
  'tg.fail': 'Telegram 推送失败',
  'tg.testBody': '✅ PandaLive Monitor Telegram 通知测试成功',
  'tg.testOk': '发送成功, 请到 Telegram 查看'
}

const en: Dict = {
  'watcher.liveStart': '{nick} is live',
  'watcher.fanLiveStart': 'Fan room live: {nick}',
  'watcher.roomAdult': 'turned into a 19+ room',
  'watcher.roomFan': 'turned into a fan-only room',
  'watcher.roomBoth': 'turned into a 19+ fan-only room',
  'watcher.clickWatch': 'Tap to watch',
  'watcher.liveEnd': '{nick} went offline',
  'watcher.circuitTitle': 'Monitor paused',
  'watcher.circuit': 'Risk control / consecutive failures ({msg}); paused for {minutes} min',
  'watcher.cooling': 'Cooling down, resume in {remain}s',
  'watcher.roundFail': 'Round failed: {msg}',
  'watcher.bjGone': 'Watched streamer @{id} not found',
  'watcher.bjGoneHint': 'The account may be renamed/deleted (or a wrong ID); no more requests for it — double-check in Followed',
  'rec.toastStart': 'Recording started: {nick}',
  'rec.toastDone': '{nick} recording finished',
  'rec.segs': '{n} segments',
  'rec.toastErr': '{nick} recording error',
  'rec.toastStartFail': '{nick} failed to start recording',
  'rec.needPw': 'Password room: password required to record',
  'rec.diskLow': 'Free disk space below {limit} GB; cannot start',
  'rec.diskStop': 'Free disk space below {limit} GB; recording stopped',
  'rec.stall': 'Stream stalled (probably expired); please restart recording manually',
  'rec.stallVod': 'Download stalled (source may be expired); please restart manually',
  'rec.interrupted': 'Recording interrupted ({reason}); streamer still live, please restart manually',
  'rec.retryResume': 'Source expired; auto-resuming recording (attempt {n})',
  'rec.retryGiveUp': 'Auto-resume failed {n} times in a row; giving up (restart manually)',
  'rec.vodInterrupted': 'Replay download interrupted ({reason}); please restart manually',
  'rec.streamEnd': 'Stream connection ended',
  'rec.fetchFail': 'Failed to get stream',
  'rec.failToast': 'Recording failed',
  'api.needAdult': 'Adult room: log in with an adult-verified account',
  'api.needLogin': 'Login required to watch',
  'api.needFan': 'Fan-club only: current account has no access',
  'api.needUnlimitItem': 'Room is full: platform requires a paid "full-entry ticket" item',
  'api.needCoinPurchase': 'Paid room: insufficient hearts balance, please top up first',
  'api.needPw': 'Password room: correct password required',
  'api.playFail': 'Playback failed',
  'api.noStream': 'No live stream (streamer may be offline or this is a replay)',
  'api.deadChannel': 'Live channel is gone (streamer likely just ended), retry later',
  'api.vodParseFail': "Could not resolve replay stream (logged to data/logs; attach today's log when reporting)",
  'api.riskHttp': 'HTTP {status} (possible rate limit)',
  'api.riskServer': 'HTTP {status} server error',
  'api.riskHtml': 'Got HTML (suspected risk-control page)',
  'api.riskJson': 'Response is not JSON (suspected risk control)',
  'auth.loginOkAdult': 'Logged in; account is adult-verified',
  'auth.loginOkNoAdult': 'Logged in (account is NOT adult-verified on pandalive)',
  'auth.cancelled': 'Login cancelled',
  'auth.importNoSess': 'sessKey not found; please paste the full Cookie of pandalive.co.kr',
  'auth.importInvalid': 'Cookie expired or invalid (official session check failed); log in again in your browser and re-copy',
  'auth.importOkAdult': 'Imported; account is adult-verified',
  'auth.importOkNoAdult': 'Imported (account is NOT adult-verified)',
  'anchors.invalid': 'Invalid streamer ID or link',
  'anchors.exists': 'This streamer is already in your watch list',
  'ipc.playFail': 'Failed to get stream: {msg} (temporary rate limit or network issue, retry later)',
  'tray.show': 'Show window',
  'tray.quit': 'Quit',
  'auth.winTitle': 'Log in to PandaLive',
  'auth.winMissing': 'Window not found',
  'app.updFail': 'Update check failed: {msg}',
  'app.unnamed': 'Untitled',
  'net.timeout': 'Request timed out',
  'net.proxyTimeout': 'Proxy connection timed out',
  'net.proxyFail': 'Proxy CONNECT failed: HTTP {code}',
  'api.bjFail': 'member/bj failed',
  'rec.ffmpegMissing': 'ffmpeg not installed',
  'rec.mergeNoTask': 'Task does not exist or was cleaned up',
  'rec.mergeNoDir': 'Recording directory missing (files may have been moved/deleted)',
  'rec.mergeNoFiles': 'No files to merge in this task',
  'rec.mergeFew': 'Fewer than 2 segments; nothing to merge',
  'rec.mergeFail': 'Merge failed (ffmpeg did not finish; see logs)',
  'rec.delNoTask': 'Task does not exist or was cleaned up',
  'rec.delLocked': '{name} and {n} other file(s) could not be deleted (possibly locked)',
  'rec.delFileNotIn': 'File does not belong to this task',
  'rec.delFileLocked': 'Delete failed (file may be playing)',
  'tg.fail': 'Telegram push failed',
  'tg.testBody': '✅ PandaLive Monitor Telegram test message',
  'tg.testOk': 'Sent; please check Telegram'
}

function dict(): Dict {
  return mainLocale === 'en-US' ? en : zh
}

/** 主进程取词: 按当前语言返回并做 {key} 插值 */
export function mt(key: string, params?: Record<string, string | number>): string {
  const d = dict()
  const tpl = d[key] ?? zh[key] ?? key
  if (!params) return tpl
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}
