import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/bindings.ts'
import { ChatLog } from '../src/chatlog.ts'
import { TelegramBridge, type BridgeSettings, type HarnessPort, type ModelChoice, type PromptPart, type StagedFileInput } from '../src/bridge.ts'
import type { TgUpdate } from '../src/telegram.ts'

const USER = { id: 42, is_bot: false, first_name: 'Ann', username: 'ann' }
const STRANGER = { id: 7, is_bot: false, first_name: 'Eve' }
const CHAT = { id: 1000, type: 'private' as const }

/** In-memory Bot API: records calls, serves queued updates, long-polls until aborted. */
class FakeTelegram {
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  private queue: TgUpdate[] = []
  private wake: (() => void) | undefined
  private nextMessageId = 1
  /** Downloadable files by file id. */
  readonly files = new Map<string, Uint8Array>()
  readonly uploads: { method: string; name: string; bytes: number; caption?: string }[] = []

  push(update: Omit<TgUpdate, 'update_id'>): void {
    this.queue.push({ update_id: this.queue.length + this.calls.length + 1, ...update })
    this.wake?.()
  }

  sent(): string[] {
    return this.calls.filter(c => c.method === 'sendMessage').map(c => String(c.params['text']))
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
    if (method === 'sendMessage') return ok({ message_id: this.nextMessageId++, chat: { id: params['chat_id'] }, date: 0 })
    return ok(true)
  }
}

class FakeHarness implements HarnessPort {
  readonly prompts: { sessionId: string; parts: readonly PromptPart[]; mode: string }[] = []
  readonly staged: (Omit<StagedFileInput, 'data'> & { sessionId: string; bytes: number })[] = []
  readonly created: { cwd: string; agentPreset: string; permissionPreset: string; model?: ModelChoice }[] = []
  readonly selected: { sessionId: string; choice: ModelChoice }[] = []
  /** Sessions currently loaded, with their model. */
  readonly loaded = new Map<string, ModelChoice>()
  readonly cancelled: string[] = []
  running = false

  async createSession(cwd: string, agentPreset: string, permissionPreset: string, model?: ModelChoice): Promise<string> {
    this.created.push({ cwd, agentPreset, permissionPreset, ...(model === undefined ? {} : { model }) })
    return `s${this.created.length}`
  }
  async listModels() {
    return {
      default: { provider: 'local', model: 'small' },
      groups: [
        { provider: 'local', name: 'Local', models: [{ id: 'small', name: 'Small' }, { id: 'qwen-large', name: 'Qwen Large' }] },
        { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] },
      ],
    }
  }
  currentModel(sessionId: string): ModelChoice | undefined {
    return this.loaded.get(sessionId)
  }
  async selectModel(sessionId: string, choice: ModelChoice): Promise<boolean> {
    this.selected.push({ sessionId, choice })
    if (!this.loaded.has(sessionId)) return false
    this.loaded.set(sessionId, choice)
    return true
  }
  async prompt(sessionId: string, parts: readonly PromptPart[], mode: 'queue' | 'steer'): Promise<void> {
    this.prompts.push({ sessionId, parts, mode })
  }
  async stageFile(sessionId: string, file: StagedFileInput): Promise<string> {
    const { data, ...rest } = file
    this.staged.push({ sessionId, bytes: data.byteLength, ...rest })
    return `r${this.staged.length}`
  }
  cancel(sessionId: string): boolean {
    this.cancelled.push(sessionId)
    return true
  }
  live() {
    return { running: this.running, cwd: '/tmp' }
  }
  async listSessions() {
    return [{ sessionId: 's1', cwd: '/tmp', updatedAt: 1, running: false }]
  }
}

const quiet = { info() {}, warn() {}, debug() {} }

let dir: string
let telegram: FakeTelegram
let harness: FakeHarness
let store: BindingStore
let bridge: TelegramBridge
let settings: BridgeSettings
let chatLog: ChatLog

function text(from: typeof USER | typeof STRANGER, body: string): Omit<TgUpdate, 'update_id'> {
  return { message: { message_id: 1, from, chat: CHAT, date: 0, text: body } }
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
    botToken: 'TOKEN',
    apiBaseUrl: 'https://api.telegram.test',
    allowedUsers: ['42'],
    workspacePath: dir,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    approvalViaTelegram: true,
    approvalTimeoutSec: 60,
    notifyToolCalls: false,
    language: 'en',
    pollTimeoutSec: 1,
    maxDownloadMb: 1,
    sendDeliverables: true,
  }
  chatLog = new ChatLog(join(dir, 'chats'), () => 2000)
  bridge = new TelegramBridge(() => settings, harness, store, quiet, telegram.fetch, chatLog)
  await bridge.reconcile()
  await until(() => bridge.state.kind === 'running')
})

afterEach(async () => {
  await bridge.stop()
  await chatLog.settled()
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
    expect(store.get(CHAT.id).sessionId).toBe('s1')
  })

  it('mirrors committed assistant text to the bound chat', async () => {
    await store.update(CHAT.id, { sessionId: 's9' })
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
    await store.update(CHAT.id, { sessionId: 's3' })
    harness.running = true
    telegram.push(text(USER, '/stop'))
    await until(() => harness.cancelled.length === 1)
    expect(harness.cancelled).toEqual(['s3'])
  })

  it('steers with /steer and forwards unknown slash commands verbatim', async () => {
    await store.update(CHAT.id, { sessionId: 's4' })
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
    expect(store.get(CHAT.id).workspacePath).toBeUndefined()
    telegram.push(text(USER, `/cwd ${tmpdir()}`))
    await until(() => store.get(CHAT.id).workspacePath === tmpdir())
    telegram.push(text(USER, '/new'))
    await until(() => harness.created.length === 1)
    expect(harness.created[0]?.cwd).toBe(tmpdir())
  })

  it('answers approvals from inline buttons', async () => {
    await store.update(CHAT.id, { sessionId: 's5' })
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
    await store.update(CHAT.id, { sessionId: 's6' })
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
    await store.update(CHAT.id, { sessionId: 's7' })
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
    expect(reloaded.get(CHAT.id).sessionId).toBe('s1')
    expect(reloaded.offset).toBeGreaterThan(0)
  })
})

describe('turn end notices', () => {
  it('reports failures with their message and stays quiet on completion', async () => {
    await store.update(CHAT.id, { sessionId: 's8' })
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
    await store.update(CHAT.id, { sessionId: 's10' })
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
    const { entries } = await chatLog.history(CHAT.id, undefined, 50)
    expect(entries.map(e => [e.dir, e.kind])).toEqual([
      ['in', 'text'], ['out', 'notice'], ['out', 'tool'], ['out', 'assistant'],
    ])
    expect(entries[0]?.from).toEqual({ id: 42, name: 'Ann', username: 'ann' })
    expect(entries[3]?.sessionId).toBe('s1')
    const [summary] = await chatLog.chats()
    expect(summary).toMatchObject({ chatId: CHAT.id, title: 'Ann', username: 'ann', sessionId: 's1', count: 4 })
  })

  it('records blocked users without prompting', async () => {
    telegram.push(text(STRANGER, 'let me in'))
    await until(() => telegram.sent().length === 1)
    await chatLog.settled()
    const { entries } = await chatLog.history(CHAT.id, undefined, 10)
    expect(entries[0]).toMatchObject({ dir: 'in', kind: 'denied', text: 'let me in', from: { id: 7, name: 'Eve' } })
  })

  it('keeps a viewable copy of received images', async () => {
    telegram.files.set('jpg', new Uint8Array([0xff, 0xd8, 0xff, 0]))
    telegram.push({ message: { message_id: 3, from: USER, chat: CHAT, date: 0, caption: 'look', photo: [{ file_id: 'jpg', file_unique_id: 'j', width: 1, height: 1 }] } })
    await until(() => harness.prompts.length === 1)
    await chatLog.settled()
    const media = (await chatLog.history(CHAT.id, undefined, 10)).entries.find(e => e.kind === 'media')
    expect(media?.text).toBe('look')
    const image = media?.attachments?.[0]
    expect(image).toMatchObject({ name: 'photo_3.jpg', kind: 'image', size: 4 })
    expect(await chatLog.readMedia(CHAT.id, image!.media!)).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0]))
  })

  it('records approval outcomes with who answered', async () => {
    await store.update(CHAT.id, { sessionId: 's5' })
    const outcome = bridge.requestApproval({ sessionId: 's5', toolName: 'bash', reason: 'writes outside the workspace' })
    await until(() => telegram.calls.some(c => c.params['reply_markup'] !== undefined))
    const markup = telegram.calls.find(c => c.params['reply_markup'] !== undefined)!.params['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][]
    }
    telegram.push({ callback_query: { id: 'q', from: USER, data: markup.inline_keyboard[0]![1]!.callback_data } })
    await expect(outcome).resolves.toBe('rejected')
    await chatLog.settled()
    const approval = (await chatLog.history(CHAT.id, undefined, 10)).entries.find(e => e.kind === 'approval')
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
    await store.update(CHAT.id, { sessionId: 's1' })
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
    await store.update(CHAT.id, { sessionId: 's2' })
    telegram.push(text(USER, '/model qwen'))
    await until(() => harness.selected.length === 1)
    expect(harness.selected[0]).toEqual({ sessionId: 's2', choice: { provider: 'local', model: 'qwen-large' } })
    expect(bridge.modelOf('s2')).toEqual({ provider: 'local', model: 'qwen-large' })
    expect(bridge.takePendingModel('s2')).toEqual({ provider: 'local', model: 'qwen-large' })
    expect(bridge.takePendingModel('s2')).toBeUndefined()
  })

  it('asks for detail when several models match, and reports unknown names', async () => {
    await store.update(CHAT.id, { sessionId: 's3' })
    telegram.push(text(USER, '/model deepseek'))
    telegram.push(text(USER, '/model gpt-9'))
    await until(() => telegram.sent().length === 2)
    expect(telegram.sent()[0]).toContain('DeepSeek Chat (deepseek/deepseek-chat)')
    expect(telegram.sent()[1]).toContain('gpt-9')
    expect(harness.selected).toEqual([])
  })

  it('shows the model in /status', async () => {
    await store.update(CHAT.id, { sessionId: 's4' })
    harness.loaded.set('s4', { provider: 'local', model: 'small', reasoningEffort: 'high' })
    telegram.push(text(USER, '/status'))
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0]).toContain('local/small (high)')
  })
})
