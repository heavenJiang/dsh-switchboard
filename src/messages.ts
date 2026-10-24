/** Bot-side reply copy. The Web page has its own dictionaries under src/client. */

/** Languages the bot replies in. */
export type BotLanguage = 'zh' | 'en'

const zh = {
  help: [
    'DeepSeek Harness 遥控',
    '',
    '直接发送文字、图片或文件：交给当前会话的 Agent 执行',
    '/new [目录] — 新建会话（可指定工作目录）',
    '/cwd <目录> — 设置本聊天新会话的默认工作目录',
    '/use <会话ID> — 切换到已有会话（可接管 Web 端会话）',
    '/sessions — 最近的会话',
    '/stop — 中止当前会话正在进行的工作',
    '/steer <文字> — 在当前轮次中途插话引导',
    '/model [模型名] — 查看或切换当前会话的模型（不影响 Web 默认）',
    '/status — 查看当前会话与机器人状态',
    '/whoami — 查看你的 Telegram 用户 ID',
  ].join('\n'),
  unauthorized: (id: number) => `未授权。你的 Telegram 用户 ID 是 ${id}，请在 DeepSeek Harness 插件页把它加入「允许的用户」。`,
  whoami: (userId: number, chatId: number) => `用户 ID：${userId}\n聊天 ID：${chatId}`,
  noWorkspace: '还没有工作目录。请先发送 /cwd <绝对路径>，或在插件页配置默认工作目录。',
  badWorkspace: (path: string) => `不是可用的绝对目录：${path}`,
  cwdSet: (path: string) => `新会话将使用工作目录：${path}`,
  created: (id: string, cwd: string) => `已新建会话 ${id}\n工作目录：${cwd}`,
  bound: (id: string) => `已切换到会话 ${id}`,
  useUsage: '用法：/use <会话ID>',
  steerUsage: '用法：/steer <文字>',
  noSession: '当前没有会话，发送文字会自动新建。',
  stopped: '已请求中止。',
  notRunning: '当前会话空闲。',
  sessions: (lines: string[]) => lines.length === 0 ? '没有会话。' : `最近的会话：\n${lines.join('\n')}`,
  status: (s: { session?: string; cwd?: string; running?: boolean; bot: string; model?: string }) => [
    `机器人：${s.bot}`,
    `会话：${s.session ?? '（无）'}`,
    ...(s.model === undefined ? [] : [`模型：${s.model}`]),
    ...(s.cwd === undefined ? [] : [`工作目录：${s.cwd}`]),
    ...(s.running === undefined ? [] : [`状态：${s.running ? '运行中' : '空闲'}`]),
  ].join('\n'),
  unsupported: '暂不支持这种消息。',
  attachmentFailed: (name: string, detail: string) => `附件 ${name} 未能交给 Agent：${detail}`,
  deliverableTooLarge: (path: string) => `文件超过 Telegram 50 MB 上限，未发送：${path}`,
  failed: (detail: string) => `出错了：${detail}`,
  toolCall: (name: string, preview: string) => `🔧 ${name}${preview === '' ? '' : `\n${preview}`}`,
  turnEnded: (kind: string, detail?: string) => kind === 'aborted' ? '⏹ 已中止'
    : kind === 'blocked' ? '⛔ 本轮被阻止'
    : kind === 'max-tokens' ? '⚠️ 输出达到 token 上限'
    : `⚠️ 本轮出错${detail === undefined ? `（${kind}）` : `：${detail}`}`,
  approvalAsk: (tool: string, detail: string, reason?: string) => [
    `🔐 需要审批：${tool}`,
    ...(detail === '' ? [] : [detail]),
    ...(reason === undefined ? [] : [`原因：${reason}`]),
  ].join('\n'),
  allow: '✅ 允许一次',
  reject: '❌ 拒绝',
  approvalAllowed: (who: string) => `已允许（${who}）`,
  approvalRejected: (who: string) => `已拒绝（${who}）`,
  approvalTimedOut: '审批超时，已交回 Harness 其他审批渠道。',
  approvalCancelled: '审批已撤回。',
  approvalGone: '这个审批已经结束。',
  cmdNew: '新建会话', cmdStop: '中止当前工作', cmdStatus: '查看状态', cmdHelp: '帮助', cmdModel: '切换模型',
  modelNoSession: '当前没有会话。先发一条消息新建会话，再用 /model 切换；也可以在插件页设置机器人默认模型。',
  modelList: (current: string | undefined, count: number) => `当前模型：${current ?? '（会话未加载，下一条消息时确定）'}\n点击下方按钮切换当前会话的模型（共 ${count} 个；也可以发送 /model 模型名）。只影响这个会话，不改变 Web 默认模型。`,
  modelSwitched: (name: string, label: string) => `已切换到 ${name}（${label}），仅对当前会话生效。`,
  modelPending: (name: string, label: string) => `会话当前未加载，下一条消息时切换到 ${name}（${label}）。`,
  modelNotFound: (query: string) => `没有找到模型「${query}」。发送 /model 查看可用模型。`,
  modelAmbiguous: (names: string[]) => `匹配到多个模型，请写得更具体：\n${names.join('\n')}`,
  modelPickerExpired: '这个模型列表已过期，请重新发送 /model。',
}

const en: typeof zh = {
  help: [
    'DeepSeek Harness remote',
    '',
    'Send text, photos, or files: the current Session\'s Agent gets them',
    '/new [dir] — start a new Session (optionally in a directory)',
    '/cwd <dir> — default working directory for this chat\'s new Sessions',
    '/use <sessionId> — switch to an existing Session (including Web ones)',
    '/sessions — recent Sessions',
    '/stop — stop the current Session\'s work',
    '/steer <text> — steer the running turn',
    '/model [name] — show or switch the current Session\'s model (the Web default is untouched)',
    '/status — Session and bot status',
    '/whoami — your Telegram user id',
  ].join('\n'),
  unauthorized: (id: number) => `Not authorized. Your Telegram user id is ${id}; add it to "Allowed users" on the DeepSeek Harness plugin page.`,
  whoami: (userId: number, chatId: number) => `User id: ${userId}\nChat id: ${chatId}`,
  noWorkspace: 'No working directory yet. Send /cwd <absolute path> or set a default on the plugin page.',
  badWorkspace: (path: string) => `Not an absolute, existing directory: ${path}`,
  cwdSet: (path: string) => `New Sessions will use: ${path}`,
  created: (id: string, cwd: string) => `New Session ${id}\nDirectory: ${cwd}`,
  bound: (id: string) => `Switched to Session ${id}`,
  useUsage: 'Usage: /use <sessionId>',
  steerUsage: 'Usage: /steer <text>',
  noSession: 'No Session yet; sending text starts one.',
  stopped: 'Stop requested.',
  notRunning: 'The Session is idle.',
  sessions: (lines: string[]) => lines.length === 0 ? 'No Sessions.' : `Recent Sessions:\n${lines.join('\n')}`,
  status: (s: { session?: string; cwd?: string; running?: boolean; bot: string; model?: string }) => [
    `Bot: ${s.bot}`,
    `Session: ${s.session ?? '(none)'}`,
    ...(s.model === undefined ? [] : [`Model: ${s.model}`]),
    ...(s.cwd === undefined ? [] : [`Directory: ${s.cwd}`]),
    ...(s.running === undefined ? [] : [`State: ${s.running ? 'running' : 'idle'}`]),
  ].join('\n'),
  unsupported: 'This kind of message is not supported.',
  attachmentFailed: (name: string, detail: string) => `Attachment ${name} did not reach the Agent: ${detail}`,
  deliverableTooLarge: (path: string) => `Over Telegram's 50 MB limit, not sent: ${path}`,
  failed: (detail: string) => `Failed: ${detail}`,
  toolCall: (name: string, preview: string) => `🔧 ${name}${preview === '' ? '' : `\n${preview}`}`,
  turnEnded: (kind: string, detail?: string) => kind === 'aborted' ? '⏹ Stopped'
    : kind === 'blocked' ? '⛔ Turn blocked'
    : kind === 'max-tokens' ? '⚠️ Output hit the token limit'
    : `⚠️ Turn failed${detail === undefined ? ` (${kind})` : `: ${detail}`}`,
  approvalAsk: (tool: string, detail: string, reason?: string) => [
    `🔐 Approval needed: ${tool}`,
    ...(detail === '' ? [] : [detail]),
    ...(reason === undefined ? [] : [`Reason: ${reason}`]),
  ].join('\n'),
  allow: '✅ Allow once',
  reject: '❌ Reject',
  approvalAllowed: (who: string) => `Allowed (${who})`,
  approvalRejected: (who: string) => `Rejected (${who})`,
  approvalTimedOut: 'Approval timed out; handed back to the other Harness approval channels.',
  approvalCancelled: 'Approval withdrawn.',
  approvalGone: 'This approval is already settled.',
  cmdNew: 'New Session', cmdStop: 'Stop current work', cmdStatus: 'Status', cmdHelp: 'Help', cmdModel: 'Switch model',
  modelNoSession: 'No Session yet. Send a message to start one, then use /model; or set the bot\'s default model on the plugin page.',
  modelList: (current: string | undefined, count: number) => `Current model: ${current ?? '(Session not loaded; decided on the next message)'}\nTap a button to switch this Session's model (${count} available; or send /model <name>). Only this Session changes; the Web default stays.`,
  modelSwitched: (name: string, label: string) => `Switched to ${name} (${label}) for this Session only.`,
  modelPending: (name: string, label: string) => `The Session is not loaded; it switches to ${name} (${label}) on the next message.`,
  modelNotFound: (query: string) => `No model matches "${query}". Send /model to see the list.`,
  modelAmbiguous: (names: string[]) => `Several models match; be more specific:\n${names.join('\n')}`,
  modelPickerExpired: 'This model list expired; send /model again.',
}

/** Reply copy by language. */
export const MESSAGES: Record<BotLanguage, typeof zh> = { zh, en }

/** One language's reply copy. */
export type Messages = typeof zh
