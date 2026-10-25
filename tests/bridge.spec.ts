import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/bindings.ts'
import { ChatLog } from '../src/chatlog.ts'
import { Switchboard, type BridgeSettings } from '../src/bridge.ts'
import { FakeHarness } from './fakes.ts'
import type { LineSettings } from '../src/lines.ts'
import type { TgUpdate } from '../src/telegram.ts'

const USER = { id: 42, is_bot: false, first_name: 'Ann', username: 'ann' }
const STRANGER = { id: 7, is_bot: false, first_name: 'Eve' }
const CHAT = { id: 1000, type: 'private' as const }
/** CHAT's key: the legacy Telegram line keeps bare ids. */
const KEY = String(CHAT.id)

/** In-memory Bot API: records calls, serves queued updates, long-polls until aborted. */
class FakeTelegram {
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  private queue: TgUpdate[] = []
  private wake: (() => void) | undefined
  private nextMessageId = 1
  /** Downloadable files by file id. */
  readonly files = new Map<string, Uint8Array>()
  readonly uploads: { method: string; name: string; bytes: number; caption?: string }[] = []
  /** Answer the next HTML sendMessage with Telegram's entity-parse error. */
  rejectHtml = 0
  /** Answer the next N calls of any method with 429. */
  rateLimit = 0

  push(update: Omit<TgUpdate, 'update_id'>): void {
    this.queue.push({ update_id: this.queue.length + this.calls.length + 1, ...update })
    this.wake?.()
  }

  sent(): string[] {
    return this.calls.filter(c => c.method === 'sendMessage').map(c => String(c.params['text']))
  }

  edits(): string[] {
    return this.calls.filter(c => c.method === 'editMessageText').map(c => String(c.params['text']))
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
    if (url.includes('/file/bot')) {
      const data = this.files.get(url.split('/').pop() ?? '')
      return data === undefined ? new Response('missing', { status: 404 }) : new Response(data as Uint8Array<ArrayBuffer>)
    }
    const method = url.split('/').pop() ?? ''
    if (init?.body instanceof FormData) {
      const form = init.body
      const file = (form.get('photo') ?? form.get('document')) as File
      this.uploads.push({
        method, name: file.name, bytes: file.size,
        ...(form.get('caption') === null ? {} : { caption: String(form.get('caption')) }),
      })
      return ok({ message_id: this.nextMessageId++, chat: { id: Number(form.get('chat_id')) }, date: 0 })
    }
    const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (method === 'getFile') {
      const id = String(params['file_id'])
      return ok({ file_id: id, file_unique_id: id, ...(this.files.has(id) ? { file_path: id } : {}) })
    }
    if (method === 'getUpdates') {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve
          init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
        })
      }
      const batch = this.queue
      this.queue = []
      return ok(batch)
    }
    this.calls.push({ method, params })
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' })
    if (this.rateLimit > 0 && method !== 'getMe') {
      this.rateLimit--
      return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }))
    }
    if (method === 'sendMessage' && params['parse_mode'] === 'HTML' && this.rejectHtml > 0) {
      this.rejectHtml--
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }))
    }
    if (method === 'sendMessage') return ok({ message_id: this.nextMessageId++, chat: { id: params['chat_id'] }, date: 0 })
    return ok(true)
  }
}

const quiet = { info() {}, warn() {}, debug() {} }

let dir: string
let telegram: FakeTelegram
let harness: FakeHarness
let store: BindingStore
let bridge: Switchboard
let settings: BridgeSettings
let chatLog: ChatLog

function text(from: typeof USER | typeof STRANGER, body: string): Omit<TgUpdate, 'update_id'> {
  return { message: { message_id: 1, from, chat: CHAT, date: 0, text: body } }
}

const TELEGRAM_LINE: LineSettings = {
  id: 'telegram', type: 'telegram', name: 'Telegram', enabled: true,
  secret: 'TOKEN', apiBaseUrl: 'https://api.telegram.test', pollTimeoutSec: 1,
  allowedUsers: ['42'], allowedChats: [], groupMentionOnly: true, workspacePath: '',
}

/** Settings with the Telegram line changed. */
function withLine(patch: Partial<LineSettings>): BridgeSettings {
  return { ...settings, lines: [{ ...TELEGRAM_LINE, ...patch }] }
}

/** Wait until a predicate holds (the poll loop runs asynchronously). */
async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  for (let waited = 0; waited < timeoutMs && !predicate(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-bridge-'))
  telegram = new FakeTelegram()
  harness = new FakeHarness()
  store = new BindingStore(join(dir, 'state.json'))
  settings = {
    enabled: true,
    lines: [TELEGRAM_LINE],
    questionsViaTelegram: true,
    streamReplies: true,
    turnSummary: 'long',
    turnSummaryMinSec: 60,
    transcribeVoice: true,
    scheduleChats: [],
    workspacePath: dir,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    approvalViaTelegram: true,
    approvalTimeoutSec: 60,
    notifyToolCalls: false,
    language: 'en',
    maxDownloadMb: 1,
    sendDeliverables: true,
  }
  chatLog = new ChatLog(join(dir, 'chats'), () => 2000)
  bridge = new Switchboard(() => settings, harness, store, quiet, { fetch: telegram.fetch }, chatLog)
  await bridge.reconcile()
  await until(() => bridge.state.kind === 'running')
})

afterEach(async () => {
  await bridge.stop()
  await chatLog.settled()
  await store.settled()
  await rm(dir, { recursive: true, force: true })
})

describe('TelegramBridge', () => {
  it('rejects strangers and tells them their id', async () => {
    telegram.push(text(STRANGER, 'rm -rf /'))
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('7')
    expect(harness.prompts).toEqual([])
  })

  it('creates a Session on first text and prompts it', async () => {
    telegram.push(text(USER, 'run the tests'))
    await until(() => harness.prompts.length === 1)
    expect(harness.created).toEqual([{ cwd: dir, agentPreset: 'standard', permissionPreset: 'workspace-write' }])
    expect(harness.prompts[0]).toEqual({ sessionId: 's1', parts: [{ type: 'text', text: 'run the tests' }], mode: 'queue' })
    expect(store.get(KEY).sessionId).toBe('s1')
  })

  it('mirrors committed assistant text to the bound chat', async () => {
    await store.update(KEY, { sessionId: 's9' })
    bridge.onSessionEvent('s9', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'All green.' }] } },
    })
    await until(() => telegram.sent().includes('All green.'))
    bridge.onSessionEvent('other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(telegram.sent()).not.toContain('x')
  })

  it('stops a running Session with /stop', async () => {
    await store.update(KEY, { sessionId: 's3' })
    harness.running = true
    telegram.push(text(USER, '/stop'))
    await until(() => harness.cancelled.length === 1)
    expect(harness.cancelled).toEqual(['s3'])
  })

  it('steers with /steer and forwards unknown slash commands verbatim', async () => {
    await store.update(KEY, { sessionId: 's4' })
    telegram.push(text(USER, '/steer focus on lint'))
    telegram.push(text(USER, '/plan refactor auth'))
    await until(() => harness.prompts.length === 2)
    expect(harness.prompts).toEqual([
      { sessionId: 's4', parts: [{ type: 'text', text: 'focus on lint' }], mode: 'steer' },
      { sessionId: 's4', parts: [{ type: 'text', text: '/plan refactor auth' }], mode: 'queue' },
    ])
  })

  it('validates /cwd and uses it for /new', async () => {
    telegram.push(text(USER, '/cwd relative/path'))
    await until(() => telegram.sent().length === 1)
    expect(store.get(KEY).workspacePath).toBeUndefined()
    telegram.push(text(USER, `/cwd ${tmpdir()}`))
    await until(() => store.get(KEY).workspacePath === tmpdir())
    telegram.push(text(USER, '/new'))
    await until(() => harness.created.length === 1)
    expect(harness.created[0]?.cwd).toBe(tmpdir())
  })

  it('answers approvals from inline buttons', async () => {
    await store.update(KEY, { sessionId: 's5' })
    bridge.onSessionEvent('s5', { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } })
    const outcome = bridge.requestApproval({ sessionId: 's5', toolName: 'bash', callId: 'c1' })
    await until(() => telegram.calls.some(c => c.method === 'sendMessage' && c.params['reply_markup'] !== undefined))
    const prompt = telegram.calls.find(c => c.params['reply_markup'] !== undefined)!
    expect(String(prompt.params['text'])).toContain('command: npm test')
    const markup = prompt.params['reply_markup'] as { inline_keyboard: { callback_data: string }[][] }
    const allow = markup.inline_keyboard[0]![0]!.callback_data
    telegram.push({ callback_query: { id: 'q1', from: USER, data: allow } })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('ignores approval presses from strangers', async () => {
    await store.update(KEY, { sessionId: 's6' })
    const outcome = bridge.requestApproval({ sessionId: 's6', toolName: 'bash' })
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    const markup = telegram.calls.find(c => c.params['reply_markup'] !== undefined)!.params['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][]
    }
    telegram.push({ callback_query: { id: 'q2', from: STRANGER, data: markup.inline_keyboard[0]![0]!.callback_data } })
    await until(() => telegram.calls.some(c => c.method === 'answerCallbackQuery'))
    await bridge.stop()
    await expect(outcome).resolves.toBe('delegate')
  })

  it('delegates approvals for unbound Sessions and withdraws on abort', async () => {
    await expect(bridge.requestApproval({ sessionId: 'unbound', toolName: 'bash' })).resolves.toBe('delegate')
    await store.update(KEY, { sessionId: 's7' })
    const controller = new AbortController()
    const outcome = bridge.requestApproval({ sessionId: 's7', toolName: 'bash', signal: controller.signal })
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')
  })

  it('persists bindings and the update offset across restarts', async () => {
    telegram.push(text(USER, 'hello'))
    await until(() => harness.prompts.length === 1)
    await store.settled()
    const reloaded = new BindingStore(join(dir, 'state.json'))
    await reloaded.load()
    expect(reloaded.get(KEY).sessionId).toBe('s1')
    expect(reloaded.offset()).toBeGreaterThan(0)
  })
})

describe('turn end notices', () => {
  it('reports failures with their message and stays quiet on completion', async () => {
    await store.update(KEY, { sessionId: 's8' })
    bridge.onSessionEvent('s8', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    bridge.onSessionEvent('s8', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'no model selected' } } } })
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toBe('⚠️ Turn failed: no model selected')
  })
})

describe('media', () => {
  const photo = (id: string, extra: object = {}) => ({
    message: {
      message_id: 5, from: USER, chat: CHAT, date: 0,
      photo: [{ file_id: `${id}-small`, file_unique_id: 'a', width: 90, height: 90, file_size: 10 },
        { file_id: id, file_unique_id: 'b', width: 900, height: 900, file_size: 3 }],
      ...extra,
    },
  })

  it('stages the largest photo as a prompt image with its caption', async () => {
    telegram.files.set('big', new Uint8Array([0xff, 0xd8, 0xff]))
    telegram.push(photo('big', { caption: 'what is this?' }))
    await until(() => harness.prompts.length === 1)
    expect(harness.staged).toEqual([{ sessionId: 's1', bytes: 3, name: 'photo_5.jpg', imageType: 'image/jpeg' }])
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'text', text: 'what is this?' }, { type: 'file', receiptId: 'r1' }])
  })

  it('trusts image bytes over the declared type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    telegram.files.set('png', png)
    telegram.files.set('fake', new Uint8Array([1, 2, 3]))
    telegram.push({ message: { message_id: 8, from: USER, chat: CHAT, date: 0, document: { file_id: 'png', file_unique_id: 'p', file_name: 'a.jpg', mime_type: 'image/jpeg' } } })
    telegram.push({ message: { message_id: 9, from: USER, chat: CHAT, date: 0, document: { file_id: 'fake', file_unique_id: 'f', file_name: 'b.png', mime_type: 'image/png' } } })
    await until(() => harness.prompts.length === 2)
    expect(harness.staged.map(f => f.imageType)).toEqual(['image/png', undefined])
  })

  it('stages documents as plain files under a sanitized name', async () => {
    telegram.files.set('doc', new Uint8Array(8))
    telegram.push({
      message: {
        message_id: 6, from: USER, chat: CHAT, date: 0,
        document: { file_id: 'doc', file_unique_id: 'd', file_name: '../../etc/report.pdf', mime_type: 'application/pdf', file_size: 8 },
      },
    })
    await until(() => harness.prompts.length === 1)
    expect(harness.staged).toEqual([{ sessionId: 's1', bytes: 8, name: 'report.pdf' }])
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'file', receiptId: 'r1' }])
  })

  it('merges an album into one prompt', async () => {
    telegram.files.set('p1', new Uint8Array(1))
    telegram.files.set('p2', new Uint8Array(2))
    telegram.push(photo('p1', { media_group_id: 'g', caption: 'compare these' }))
    telegram.push(photo('p2', { media_group_id: 'g' }))
    await until(() => harness.prompts.length === 1, 4000)
    expect(harness.prompts[0]?.parts).toEqual([
      { type: 'text', text: 'compare these' }, { type: 'file', receiptId: 'r1' }, { type: 'file', receiptId: 'r2' },
    ])
  }, 10_000)

  it('refuses files over the size limit without prompting', async () => {
    telegram.push({
      message: {
        message_id: 7, from: USER, chat: CHAT, date: 0,
        video: { file_id: 'huge', file_unique_id: 'h', file_size: 5 * 1024 * 1024 },
      },
    })
    await until(() => telegram.sent().some(text => text.includes('video_7.mp4')))
    expect(telegram.calls.some(c => c.method === 'getFile')).toBe(false)
    expect(harness.prompts).toEqual([])
  })

  it('does not download anything for strangers', async () => {
    telegram.files.set('x', new Uint8Array(1))
    telegram.push({ message: { ...photo('x').message, from: STRANGER } })
    await until(() => telegram.sent().length === 1)
    expect(telegram.calls.some(c => c.method === 'getFile')).toBe(false)
  })

  it('sends presented files back: images inline, others as documents', async () => {
    await store.update(KEY, { sessionId: 's10' })
    await writeFile(join(dir, 'chart.png'), new Uint8Array(4))
    await writeFile(join(dir, 'report.csv'), 'a,b\n')
    bridge.onSessionEvent('s10', {
      type: 'deliverables/presented',
      data: { turn: 1, callId: 'c', files: [{ path: 'chart.png', description: 'Q3' }, { path: join(dir, 'report.csv') }] },
    }, dir)
    await until(() => telegram.uploads.length === 2)
    expect(telegram.uploads).toEqual([
      { method: 'sendPhoto', name: 'chart.png', bytes: 4, caption: 'chart.png\nQ3' },
      { method: 'sendDocument', name: 'report.csv', bytes: 4, caption: 'report.csv' },
    ])
  })
})

describe('chat history', () => {
  it('records prompts, Agent replies, tool lines, and bot notices with the bound Session', async () => {
    telegram.push(text(USER, 'run the tests'))
    await until(() => harness.prompts.length === 1)
    settings = { ...settings, notifyToolCalls: true }
    bridge.onSessionEvent('s1', { type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"npm test"}' } })
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All green.' }] } } })
    await until(() => telegram.sent().includes('All green.'))
    await chatLog.settled()
    const { entries } = await chatLog.history(KEY, undefined, 50)
    expect(entries.map(e => [e.dir, e.kind])).toEqual([
      ['in', 'text'], ['out', 'notice'], ['out', 'tool'], ['out', 'assistant'],
    ])
    expect(entries[0]?.from).toEqual({ id: '42', name: 'Ann', username: 'ann' })
    expect(entries[3]?.sessionId).toBe('s1')
    const [summary] = await chatLog.chats()
    expect(summary).toMatchObject({ chatId: KEY, title: 'Ann', username: 'ann', sessionId: 's1', count: 4 })
  })

  it('records blocked users without prompting', async () => {
    telegram.push(text(STRANGER, 'let me in'))
    await until(() => telegram.sent().length === 1)
    await chatLog.settled()
    const { entries } = await chatLog.history(KEY, undefined, 10)
    expect(entries[0]).toMatchObject({ dir: 'in', kind: 'denied', text: 'let me in', from: { id: '7', name: 'Eve' } })
  })

  it('keeps a viewable copy of received images', async () => {
    telegram.files.set('jpg', new Uint8Array([0xff, 0xd8, 0xff, 0]))
    telegram.push({ message: { message_id: 3, from: USER, chat: CHAT, date: 0, caption: 'look', photo: [{ file_id: 'jpg', file_unique_id: 'j', width: 1, height: 1 }] } })
    await until(() => harness.prompts.length === 1)
    await chatLog.settled()
    const media = (await chatLog.history(KEY, undefined, 10)).entries.find(e => e.kind === 'media')
    expect(media?.text).toBe('look')
    const image = media?.attachments?.[0]
    expect(image).toMatchObject({ name: 'photo_3.jpg', kind: 'image', size: 4 })
    expect(await chatLog.readMedia(KEY, image!.media!)).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0]))
  })

  it('records approval outcomes with who answered', async () => {
    await store.update(KEY, { sessionId: 's5' })
    const outcome = bridge.requestApproval({ sessionId: 's5', toolName: 'bash', reason: 'writes outside the workspace' })
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    const markup = telegram.calls.find(c => c.params['reply_markup'] !== undefined)!.params['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][]
    }
    telegram.push({ callback_query: { id: 'q', from: USER, data: markup.inline_keyboard[0]![1]!.callback_data } })
    await expect(outcome).resolves.toBe('rejected')
    await chatLog.settled()
    const approval = (await chatLog.history(KEY, undefined, 10)).entries.find(e => e.kind === 'approval')
    expect(approval).toMatchObject({ text: 'writes outside the workspace', approval: { tool: 'bash', outcome: 'rejected', by: '@ann' } })
  })
})

describe('models', () => {
  it('pins the configured model on Sessions the bot creates', async () => {
    settings = { ...settings, model: { provider: 'deepseek', model: 'deepseek-chat' } }
    telegram.push(text(USER, 'hello'))
    await until(() => harness.created.length === 1)
    expect(harness.created[0]?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('lists models as buttons and switches the live Session from a press', async () => {
    await store.update(KEY, { sessionId: 's1' })
    harness.loaded.set('s1', { provider: 'local', model: 'small' })
    telegram.push(text(USER, '/model'))
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    const picker = telegram.calls.find(c => c.params['reply_markup'] !== undefined)!
    expect(String(picker.params['text'])).toContain('local/small')
    const rows = (picker.params['reply_markup'] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(rows.map(row => row[0]!.text)).toEqual(['✓ Small · Local', 'Qwen Large · Local', 'DeepSeek Chat · DeepSeek', 'DeepSeek Reasoner · DeepSeek'])
    expect(rows.every(row => Buffer.byteLength(row[0]!.callback_data) <= 64)).toBe(true)
    telegram.push({ callback_query: { id: 'q', from: USER, message: { message_id: 1, chat: CHAT, date: 0 }, data: rows[3]![0]!.callback_data } })
    await until(() => harness.selected.length === 1)
    expect(harness.loaded.get('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    await until(() => telegram.sent().some(t => t.includes('deepseek/deepseek-reasoner')))
  })

  it('matches /model <name> and defers the choice for a cold Session', async () => {
    await store.update(KEY, { sessionId: 's2' })
    telegram.push(text(USER, '/model qwen'))
    await until(() => harness.selected.length === 1)
    expect(harness.selected[0]).toEqual({ sessionId: 's2', choice: { provider: 'local', model: 'qwen-large' } })
    expect(bridge.modelOf('s2')).toEqual({ provider: 'local', model: 'qwen-large' })
    await until(() => telegram.sent().length === 1)
    expect(bridge.takePending('s2')).toEqual({ model: { provider: 'local', model: 'qwen-large' } })
    await store.settled()
    expect(bridge.takePending('s2')).toBeUndefined()
  })

  it('asks for detail when several models match, and reports unknown names', async () => {
    await store.update(KEY, { sessionId: 's3' })
    telegram.push(text(USER, '/model deepseek'))
    telegram.push(text(USER, '/model gpt-9'))
    await until(() => telegram.sent().length === 2)
    expect(telegram.sent()[0]).toContain('DeepSeek Chat (deepseek/deepseek-chat)')
    expect(telegram.sent()[1]).toContain('gpt-9')
    expect(harness.selected).toEqual([])
  })

  it('shows the model in /status', async () => {
    await store.update(KEY, { sessionId: 's4' })
    harness.loaded.set('s4', { provider: 'local', model: 'small', reasoningEffort: 'high' })
    telegram.push(text(USER, '/status'))
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('local/small (high)')
  })
})

describe('rendering and delivery', () => {
  it('renders Agent Markdown as Telegram HTML', async () => {
    await store.update(KEY, { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**Done**: run `npm test`' }] } } })
    await until(() => telegram.sent().length === 1)
    const call = telegram.calls.find(c => c.method === 'sendMessage')!
    expect(call.params['parse_mode']).toBe('HTML')
    expect(call.params['text']).toBe('<b>Done</b>: run <code>npm test</code>')
  })

  it('falls back to plain text when Telegram rejects the markup', async () => {
    await store.update(KEY, { sessionId: 's1' })
    telegram.rejectHtml = 1
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**x**' }] } } })
    await until(() => telegram.sent().includes('**x**'))
  })

  it('retries after flood control', async () => {
    await store.update(KEY, { sessionId: 's1' })
    telegram.rateLimit = 2
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'after the wait' }] } } })
    await until(() => telegram.sent().includes('after the wait'))
  })

  it('batches a burst of tool calls into one message, flushed before the reply', async () => {
    settings = { ...settings, notifyToolCalls: true }
    await store.update(KEY, { sessionId: 's1' })
    for (const [i, command] of ['ls', 'cat a', 'npm test'].entries()) {
      bridge.onSessionEvent('s1', { type: 'tool/call', data: { callId: `c${i}`, name: 'bash', arguments: JSON.stringify({ command }) } })
    }
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
    await until(() => telegram.sent().length === 2)
    expect(telegram.sent()[0]).toBe('🛠 Tool calls · 3\n🔧 bash · command: ls\n🔧 bash · command: cat a\n🔧 bash · command: npm test')
    expect(telegram.sent()[1]).toBe('ok')
  })

  it('edits one activity message as calls keep coming, and starts a new one after a reply', async () => {
    settings = { ...settings, notifyToolCalls: true }
    await store.update(KEY, { sessionId: 's1' })
    const call = (i: number) => bridge.onSessionEvent('s1', { type: 'tool/call', data: { callId: `k${i}`, name: 'bash', arguments: JSON.stringify({ command: `step ${i}` }) } })
    call(1)
    await until(() => telegram.sent().length === 1, 3000)
    call(2)
    await until(() => telegram.edits().some(t => t.startsWith('🛠 Tool calls · 2')), 3000)
    expect(telegram.sent()).toHaveLength(1)
    for (let i = 3; i <= 15; i++) call(i)
    await until(() => telegram.edits().some(t => t.startsWith('🛠 Tool calls · 15\n…')), 4000)
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'halfway' }] } } })
    call(16)
    await until(() => telegram.sent().filter(t => t.startsWith('🛠')).length === 2, 4000)
    expect(telegram.sent().at(-1)).toBe('🛠 Tool calls · 1\n🔧 bash · command: step 16')
  })

  it('streams a draft and turns it into the final reply', async () => {
    await store.update(KEY, { sessionId: 's1' })
    bridge.onAssistantStream('s1', { type: 'start' })
    bridge.onAssistantStream('s1', { type: 'chunk', chunk: { type: 'text-delta', text: 'Working through the failing tests one by one now' } })
    await until(() => telegram.sent().length === 1, 3000)
    expect(telegram.sent()[0]).toMatch(/one by one now ▍$/u)
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All **fixed**.' }] } } })
    await until(() => telegram.edits().includes('All <b>fixed</b>.'))
    expect(telegram.sent()).toHaveLength(1)
  })
})

describe('turn summaries and following', () => {
  it('summarizes long turns with changed files for bound chats', async () => {
    await store.update(KEY, { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'turn/start', time: 0 })
    bridge.onSessionEvent('s1', { type: 'tool/call', data: { callId: 'c', name: 'edit', arguments: '{}' } })
    bridge.onSessionEvent('s1', { type: 'workspace/changes', seq: 9 })
    bridge.onSessionEvent('s1', { type: 'turn/end', time: 125_000, data: { reason: { kind: 'completed' } } })
    await until(() => telegram.sent().some(t => t.startsWith('✅')))
    const summary = telegram.sent().find(t => t.startsWith('✅'))!
    expect(summary).toContain('2m 5s')
    expect(summary).toContain('1 tool call')
    expect(summary).toContain('src/a.ts, README.md')
  })

  it('keeps short turns quiet in the bound chat', async () => {
    await store.update(KEY, { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'turn/start', time: 0 })
    bridge.onSessionEvent('s1', { type: 'turn/end', time: 5000, data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(telegram.sent()).toEqual([])
  })

  it('/watch follows another Session: summaries with an excerpt, and its approvals', async () => {
    harness.loaded.set('s1', { provider: 'local', model: 'small' })
    telegram.push(text(USER, '/sessions'))
    await until(() => telegram.sent().length === 1)
    telegram.push(text(USER, '/watch 1'))
    await until(() => telegram.sent().length === 2)
    expect(store.watchersOf('s1')).toEqual([KEY])
    bridge.onSessionEvent('s1', { type: 'turn/start', time: 0 })
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Deployed to staging.' }] } } })
    bridge.onSessionEvent('s1', { type: 'turn/end', time: 3000, data: { reason: { kind: 'completed' } } })
    await until(() => telegram.sent().some(t => t.startsWith('✅')))
    expect(telegram.sent().find(t => t.startsWith('✅'))).toContain('Deployed to staging.')
    // The follower does not get the reply itself.
    expect(telegram.sent()).not.toContain('Deployed to staging.')
    const outcome = bridge.requestApproval({ sessionId: 's1', toolName: 'bash' })
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined && String(c.params['text']).includes('bash')))
    await bridge.stop()
    await expect(outcome).resolves.toBe('delegate')
  })
})

describe('commands', () => {
  it('/mode switches a live Session and defers for a cold one', async () => {
    await store.update(KEY, { sessionId: 's1' })
    harness.loaded.set('s1', { provider: 'local', model: 'small' })
    telegram.push(text(USER, '/mode read'))
    await until(() => harness.presets.get('s1') === 'read-only')
    await store.update(KEY, { sessionId: 's9' })
    telegram.push(text(USER, '/mode workspace'))
    await until(() => telegram.sent().length === 2)
    expect(bridge.takePending('s9')).toEqual({ preset: 'workspace-write' })
  })

  it('/mode lists presets as buttons', async () => {
    await store.update(KEY, { sessionId: 's1' })
    harness.loaded.set('s1', { provider: 'local', model: 'small' })
    telegram.push(text(USER, '/mode'))
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    const rows = (telegram.calls.find(c => c.params['reply_markup'] !== undefined)!.params['reply_markup'] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(rows.map(r => r[0]!.text)).toEqual(['Read only', '✓ Workspace write'])
    telegram.push({ callback_query: { id: 'q', from: USER, message: { message_id: 1, chat: CHAT, date: 0 }, data: rows[0]![0]!.callback_data } })
    await until(() => harness.presets.get('s1') === 'read-only')
  })

  it('/get sends files and lists directories inside the workspace, never outside', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hi')
    telegram.push(text(USER, '/get notes.txt'))
    await until(() => telegram.uploads.length === 1)
    expect(telegram.uploads[0]).toMatchObject({ method: 'sendDocument', name: 'notes.txt' })
    telegram.push(text(USER, '/get .'))
    await until(() => telegram.sent().some(t => t.includes('📄 notes.txt')))
    telegram.push(text(USER, '/get /etc/hosts'))
    await until(() => telegram.sent().filter(t => t.includes('inside the working directory')).length === 1)
    // A symlink inside the workspace cannot reach out of it either.
    await symlink('/etc', join(dir, 'escape'))
    telegram.push(text(USER, '/get escape/hosts'))
    await until(() => telegram.sent().filter(t => t.includes('inside the working directory')).length === 2)
    expect(telegram.uploads).toHaveLength(1)
  })

  it('/queue lists and /cancel drops queued prompts', async () => {
    await store.update(KEY, { sessionId: 's1' })
    harness.loaded.set('s1', { provider: 'local', model: 'small' })
    harness.inbox.set('s1', [{ id: 'm1', text: 'first' }, { id: 'm2', text: 'second' }])
    telegram.push(text(USER, '/queue'))
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('1. first')
    telegram.push(text(USER, '/cancel 2'))
    await until(() => telegram.sent().length === 2)
    expect(harness.inbox.get('s1')).toEqual([{ id: 'm1', text: 'first' }])
  })
})

describe('access', () => {
  const GROUP = { id: -100, type: 'supergroup' as const, title: 'Team' }
  const groupText = (body: string, extra: object = {}) => ({ message: { message_id: 1, from: USER, chat: GROUP, date: 0, text: body, ...extra } })

  it('answers only addressed messages in groups, and strips the mention', async () => {
    telegram.push(groupText('chatting among ourselves'))
    telegram.push(groupText('@testbot please run the tests'))
    await until(() => harness.prompts.length === 1)
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'text', text: 'please run the tests' }])
    telegram.push(groupText('and lint too', { reply_to_message: { message_id: 9, from: { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }, chat: GROUP, date: 0 } }))
    await until(() => harness.prompts.length === 2)
  })

  it('admits every member of an allowed chat', async () => {
    settings = withLine({ allowedChats: [String(GROUP.id)] })
    telegram.push({ message: { message_id: 1, from: STRANGER, chat: GROUP, date: 0, text: '/status' } })
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('Bot: @testbot')
  })

  it('tells a stranger only once', async () => {
    telegram.push(text(STRANGER, 'one'))
    telegram.push(text(STRANGER, 'two'))
    telegram.push(text(USER, '/status'))
    await until(() => telegram.sent().some(t => t.startsWith('Bot:')))
    expect(telegram.sent().filter(t => t.includes('Not authorized'))).toHaveLength(1)
  })
})

describe('voice and schedules', () => {
  const voice = { message: { message_id: 4, from: USER, chat: CHAT, date: 0, voice: { file_id: 'v', file_unique_id: 'v', file_size: 3, mime_type: 'audio/ogg' } } }

  it('prompts with the transcript of a voice note', async () => {
    telegram.files.set('v', new Uint8Array([1, 2, 3]))
    harness.transcript = 'check the build'
    telegram.push(voice)
    await until(() => harness.prompts.length === 1)
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'text', text: 'check the build' }])
    expect(telegram.sent()).toContain('🎤 check the build')
  })

  it('sends the voice note as a file when transcription is unavailable', async () => {
    telegram.files.set('v', new Uint8Array([1, 2, 3]))
    telegram.push(voice)
    await until(() => harness.prompts.length === 1)
    expect(harness.staged[0]).toMatchObject({ name: 'voice_4.ogg' })
    expect(telegram.sent().some(t => t.includes('speech recognition is not installed'))).toBe(true)
  })

  it('reports scheduled runs to the schedule chats', async () => {
    settings = { ...settings, scheduleChats: ['777'] }
    bridge.onSessionEvent('s5', { type: 'turn/start', time: 0 })
    bridge.onSessionEvent('s5', { type: 'user/message', data: { message: { source: { kind: 'schedule' } } } })
    bridge.onSessionEvent('s5', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Nightly report: green' }] } } })
    await until(() => telegram.calls.some(c => c.method === 'sendMessage' && c.params['chat_id'] === 777))
    expect(telegram.calls.find(c => c.params['chat_id'] === 777)?.params['text']).toBe('Nightly report: green')
  })
})

describe('web operations', () => {
  it('links a chat from the Web UI and sends as the bot', async () => {
    await bridge.linkChat(KEY, 's7', 'active')
    expect(store.get(KEY).sessionId).toBe('s7')
    expect(bridge.linksOf('s7')).toEqual([{ chatId: KEY, mode: 'active' }])
    await bridge.linkChat(KEY, 's7', 'watch')
    expect(bridge.linksOf('s7')).toEqual([{ chatId: KEY, mode: 'watch' }])
    await bridge.sendFromWeb(KEY, 'from the **web**')
    await until(() => telegram.sent().includes('from the <b>web</b>'))
    await chatLog.settled()
    const kinds = (await chatLog.history(KEY, undefined, 10)).entries.map(e => e.kind)
    expect(kinds).toContain('web')
    const stats = await chatLog.stats()
    expect(stats.today.out).toBeGreaterThan(0)
    expect(stats.series).toHaveLength(14)
  })
})

describe('agent questions', () => {
  const ask = (questions: object[]) => bridge.requestAnswers({ sessionId: 's1', questions: questions as never })
  const keyboard = (index = 0) => {
    const calls = telegram.calls.filter(c => c.params['reply_markup'] !== undefined && String(c.params['text']).startsWith('❓'))
    return (calls[index]!.params['reply_markup'] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
  }

  it('answers a single-choice question from a button', async () => {
    await store.update(KEY, { sessionId: 's1' })
    const answer = ask([{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }])
    await until(() => telegram.sent().some(t => t.startsWith('❓')))
    expect(keyboard().map(row => row.map(b => b.text))).toEqual([['main'], ['dev'], ['Skip']])
    telegram.push({ callback_query: { id: 'c', from: USER, message: { message_id: 1, chat: CHAT, date: 0 }, data: keyboard()[1]![0]!.callback_data } })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['dev'] }] })
    await until(() => telegram.edits().some(t => t.includes('Answered: dev')))
  })

  it('takes plain text as a custom answer instead of a new prompt', async () => {
    await store.update(KEY, { sessionId: 's1' })
    const answer = ask([{ id: 'q1', question: 'Name the release?' }])
    await until(() => telegram.sent().some(t => t.startsWith('❓')))
    telegram.push(text(USER, 'v2.0 "Aurora"'))
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'v2.0 "Aurora"' }] })
    expect(harness.prompts).toEqual([])
  })

  it('collects multi-select answers until Done, across a batch', async () => {
    await store.update(KEY, { sessionId: 's1' })
    const answer = ask([
      { id: 'a', question: 'Targets?', multiSelect: true, options: [{ label: 'web' }, { label: 'ios' }, { label: 'android' }] },
      { id: 'b', question: 'Ship today?', options: [{ label: 'yes' }, { label: 'no' }] },
    ])
    await until(() => telegram.sent().filter(t => t.startsWith('❓')).length === 2)
    const press = (index: number, row: number) => telegram.push({ callback_query: { id: `p${index}${row}`, from: USER, message: { message_id: 1, chat: CHAT, date: 0 }, data: keyboard(index)[row]![0]!.callback_data } })
    press(0, 0)
    press(0, 2)
    await until(() => telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length === 2)
    telegram.push({ callback_query: { id: 'done', from: USER, message: { message_id: 1, chat: CHAT, date: 0 }, data: keyboard(0)[3]![0]!.callback_data } })
    press(1, 0)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'a', selected: ['web', 'android'] }, { id: 'b', selected: ['yes'] }] })
  })

  it('hands unlinked Sessions to the next answerer', async () => {
    await expect(bridge.requestAnswers({ sessionId: 'nobody', questions: [{ id: 'q', question: '?' }] })).resolves.toBe('delegate')
  })
})

describe('web workspaces', () => {
  it('adds Sessions to their Web workspace when a chat switches to or follows them', async () => {
    telegram.push(text(USER, '/use session-abc'))
    telegram.push(text(USER, '/watch session-def'))
    await until(() => harness.workspaced.length === 2)
    expect(harness.workspaced).toEqual(['session-abc', 'session-def'])
    await bridge.linkChat(KEY, 'session-ghi', 'active')
    await until(() => harness.workspaced.includes('session-ghi'))
  })

  it('backfills every bound or followed Session at startup', async () => {
    await store.update(KEY, { sessionId: 's-bound' })
    await store.setWatch(KEY, 's-watched', true)
    await bridge.attachLinkedSessions()
    expect(harness.workspaced.sort()).toEqual(['s-bound', 's-watched'])
  })
})

describe('harness commands', () => {
  it('runs registered Harness commands on the Host and replies with their result', async () => {
    await store.update(KEY, { sessionId: 's1' })
    telegram.push(text(USER, '/compact keep the API notes'))
    await until(() => telegram.sent().includes('Compacted: 48k → 9k tokens'))
    expect(harness.ran).toEqual([{ sessionId: 's1', line: '/compact keep the API notes' }])
    expect(harness.prompts).toEqual([])
  })

  it('reports a command error plainly', async () => {
    await store.update(KEY, { sessionId: 's1' })
    telegram.push(text(USER, '/goal'))
    await until(() => telegram.sent().some(t => t.startsWith('⚠️ /goal')))
    expect(telegram.sent().at(-1)).toBe('⚠️ /goal: goal text required')
  })

  it('sends unregistered slash text to the Agent, and keeps the bridge\'s own commands', async () => {
    await store.update(KEY, { sessionId: 's1' })
    telegram.push(text(USER, '/review the auth module'))
    await until(() => harness.prompts.length === 1)
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'text', text: '/review the auth module' }])
    telegram.push(text(USER, '/status'))
    await until(() => telegram.sent().some(t => t.startsWith('Bot:')))
    expect(harness.ran).toEqual([])
  })

  it('lists Harness commands in /help and in the bot menu', async () => {
    const menu = telegram.calls.find(c => c.method === 'setMyCommands')!.params['commands'] as { command: string }[]
    expect(menu.map(c => c.command)).toEqual(['new', 'stop', 'model', 'mode', 'watch', 'get', 'status', 'help', 'compact', 'goal'])
    await store.update(KEY, { sessionId: 's1' })
    telegram.push(text(USER, '/help'))
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('/compact [focus] — Compact the context')
    expect(telegram.sent()[0]).not.toContain('Harness status (shadowed')
  })
})
