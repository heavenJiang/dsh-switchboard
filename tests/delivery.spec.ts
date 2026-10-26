import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/bindings.ts'
import { Switchboard, type BridgeSettings, type SessionLogEvent } from '../src/bridge.ts'
import type { FeishuApi } from '../src/channels/feishu.ts'
import { undelivered } from '../src/channels/types.ts'
import { ChatLog } from '../src/chatlog.ts'
import type { LineSettings } from '../src/lines.ts'
import { Outbox } from '../src/outbox.ts'
import { TelegramApiError } from '../src/telegram.ts'
import { FakeHarness } from './fakes.ts'

const quiet = { info() {}, warn() {}, debug() {} }
const FEISHU_CHAT = 'feishu:oc_dm'
const TG_CHAT = '1000'
const reply = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

/** A Feishu platform whose connection the test drops and restores; records text sent per chat. */
class Feishu implements FeishuApi {
  readonly sent: { chatId: string; text: string }[] = []
  failNext: Error | undefined
  private handlers: Parameters<FeishuApi['connect']>[0] | undefined
  async botInfo() { return { openId: 'ou_bot', name: 'Bot' } }
  async connect(handlers: Parameters<FeishuApi['connect']>[0], signal: AbortSignal) {
    this.handlers = handlers
    handlers.status('ready')
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  status(state: 'ready' | 'reconnecting') { this.handlers!.status(state) }
  async sendMessage(chatId: string, type: string, content: object) {
    if (this.failNext !== undefined) {
      const error = this.failNext
      this.failNext = undefined
      throw error
    }
    const value = content as { text?: string; body?: { elements: { content?: string; text?: { content: string } }[] } }
    const element = value.body?.elements[0]
    this.sent.push({ chatId, text: type === 'text' ? String(value.text) : String(element?.content ?? element?.text?.content ?? `[${type}]`) })
    return `om_${this.sent.length}`
  }
  async patchCard() {}
  async uploadImage() { return 'img' }
  async uploadFile() { return 'file' }
  async download(): Promise<Uint8Array> { return new Uint8Array() }
  async userName() { return undefined }
  async chatName() { return undefined }
}

/** A Telegram Bot API stand-in that only answers getMe, long-polls, and records sendMessage. */
function telegramFetch(sent: { chat: number; text: string }[]): typeof fetch {
  return async (input, init) => {
    const method = String(input).split('/').pop() ?? ''
    if (method === 'getUpdates') {
      await new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) })
    }
    const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (method === 'sendMessage') sent.push({ chat: Number(params['chat_id']), text: String(params['text']) })
    const result = method === 'getMe' ? { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } : { message_id: 1, chat: { id: 1 }, date: 0 }
    return new Response(JSON.stringify({ ok: true, result }))
  }
}

const LINES: LineSettings[] = [
  { id: 'feishu', type: 'feishu', name: '飞书', enabled: true, secret: 'S', appId: 'cli_x', domain: 'feishu', allowedUsers: [], allowedChats: [], groupMentionOnly: true, workspacePath: '' },
  { id: 'telegram', type: 'telegram', name: 'Telegram', enabled: true, secret: 'T', apiBaseUrl: 'https://api.telegram.test', pollTimeoutSec: 1, allowedUsers: [], allowedChats: [], groupMentionOnly: true, workspacePath: '' },
]

async function until(predicate: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1000 && !predicate(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

let dir: string
let feishu: Feishu
let tgSent: { chat: number; text: string }[]
let harness: FakeHarness & { events?: SessionLogEvent[] }
let store: BindingStore
let outbox: Outbox
let chatLog: ChatLog
let bridge: Switchboard
let settings: BridgeSettings

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switchboard-delivery-'))
  feishu = new Feishu()
  tgSent = []
  harness = new FakeHarness()
  store = new BindingStore(join(dir, 'state.json'))
  outbox = new Outbox(join(dir, 'outbox.json'))
  chatLog = new ChatLog(join(dir, 'chats'), () => 2000)
  settings = {
    enabled: true, lines: LINES, workspacePath: dir, agentPreset: 'standard', permissionPreset: 'workspace-write',
    approvalViaTelegram: true, questionsViaTelegram: true, approvalTimeoutSec: 60, notifyToolCalls: false,
    streamReplies: false, turnSummary: 'off', turnSummaryMinSec: 60, transcribeVoice: false, scheduleChats: [],
    alertChats: [TG_CHAT], alertAfterMin: 5, language: 'en', maxDownloadMb: 1, sendDeliverables: true,
  }
  bridge = new Switchboard(() => settings, harness, store, quiet, { feishu: () => feishu, fetch: telegramFetch(tgSent) }, chatLog, outbox)
  await bridge.reconcile()
  await until(() => bridge.lineStates().every(line => line.state.kind === 'running'))
  await store.update(FEISHU_CHAT, { sessionId: 's1' })
})

afterEach(async () => {
  await bridge.dispose()
  await chatLog.settled()
  await store.settled()
  await rm(dir, { recursive: true, force: true })
})

describe('outbox', () => {
  it('keeps replies while the line is down and sends them, marked late, once it is back', async () => {
    feishu.status('reconnecting')
    bridge.onSessionEvent('s1', reply('Digest: 12 stories'))
    bridge.onSessionEvent('s1', { type: 'turn/end', data: { reason: { kind: 'failed', error: { message: 'model timeout' } } } })
    await until(() => (outbox.counts().get(FEISHU_CHAT) ?? 0) === 2)
    expect(feishu.sent).toEqual([])
    expect(bridge.lineStates().find(line => line.id === 'feishu')?.queued).toBe(2)
    feishu.status('ready')
    await until(() => feishu.sent.length === 2)
    expect(feishu.sent[0]?.text).toMatch(/^⏳ Sent late: due at .+\n\nDigest: 12 stories$/u)
    expect(feishu.sent[1]?.text).toContain('model timeout')
    await until(() => outbox.counts().size === 0)
  })

  it('retries a send that certainly failed, and only once delivered', async () => {
    feishu.failNext = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    bridge.onSessionEvent('s1', reply('Report ready'))
    await until(() => outbox.counts().get(FEISHU_CHAT) === 1)
    await bridge.flushOutbox()
    await until(() => feishu.sent.length === 1)
    expect(feishu.sent[0]?.text).toContain('Report ready')
    await bridge.flushOutbox()
    expect(feishu.sent).toHaveLength(1)
  })

  it('does not resend when the platform may have received it', async () => {
    feishu.failNext = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    bridge.onSessionEvent('s1', reply('Maybe sent'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(outbox.counts().size).toBe(0)
  })

  it('sends presented files late too', async () => {
    await writeFile(join(dir, 'digest.md'), '# news')
    feishu.status('reconnecting')
    bridge.onSessionEvent('s1', { type: 'deliverables/presented', data: { files: [{ path: join(dir, 'digest.md') }] } })
    await until(() => outbox.counts().get(FEISHU_CHAT) === 1)
    feishu.status('ready')
    await until(() => feishu.sent.length === 2)
    expect(feishu.sent.map(m => m.text)).toEqual(['[file]', expect.stringMatching(/^⏳ Sent late: .+\ndigest\.md$/u)])
  })

  it('survives a restart of the plugin', async () => {
    feishu.status('reconnecting')
    bridge.onSessionEvent('s1', reply('Kept on disk'))
    await until(() => outbox.counts().get(FEISHU_CHAT) === 1)
    await outbox.settled()
    const reopened = new Outbox(join(dir, 'outbox.json'))
    await reopened.load()
    expect([...reopened.counts()]).toEqual([[FEISHU_CHAT, 1]])
  })
})

describe('catch-up after a restart', () => {
  it('sends the final reply of turns that ended while the plugin was down', async () => {
    harness.events = [
      { type: 'turn/start', seq: 11, time: 1 },
      { type: 'assistant/message', seq: 12, time: 2, data: { message: { content: [{ type: 'text', text: 'draft thought' }] } } },
      { type: 'assistant/message', seq: 14, time: 3, data: { message: { content: [{ type: 'text', text: 'Final digest' }] } } },
      { type: 'turn/end', seq: 15, time: 4, data: { reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 16, time: 5 },
      { type: 'turn/end', seq: 17, time: 6, data: { reason: { kind: 'failed', error: { message: 'quota' } } } },
    ]
    await store.setCursor('s1', 10)
    await store.setWatch(TG_CHAT, 's1', true)
    await bridge.catchUp()
    await until(() => feishu.sent.length === 2 && tgSent.length === 2)
    expect(feishu.sent[0]?.text).toMatch(/^⏳ Reply that finished while the plugin was restarting .+\n\nFinal digest$/u)
    expect(feishu.sent[1]?.text).toContain('quota')
    expect(tgSent[0]?.text).toContain('Final digest')
    expect(store.cursor('s1')).toBe(17)
    // Nothing new: a second pass sends nothing.
    harness.events = []
    await bridge.catchUp()
    expect(feishu.sent).toHaveLength(2)
  })

  it('remembers how far it mirrored', async () => {
    bridge.onSessionEvent('s1', { ...reply('live'), seq: 42 })
    await until(() => store.cursor('s1') === 42)
    bridge.onSessionEvent('s-unlinked', { ...reply('nobody'), seq: 50 })
    expect(store.cursor('s-unlinked')).toBeUndefined()
  })
})

describe('outage alerts', () => {
  it('tells the alert chats on another line, once, and again when it is back', async () => {
    feishu.status('reconnecting')
    bridge.checkOutages(Date.now() + 4 * 60_000)
    expect(tgSent).toEqual([])
    bridge.checkOutages(Date.now() + 6 * 60_000)
    bridge.checkOutages(Date.now() + 9 * 60_000)
    await until(() => tgSent.length === 1)
    expect(tgSent[0]?.text).toMatch(/Line "飞书" has been down for 6 min/u)
    feishu.status('ready')
    await until(() => tgSent.length === 2)
    expect(tgSent[1]?.text).toContain('Line "飞书" is back')
  })

  it('stays quiet when turned off', async () => {
    settings = { ...settings, alertAfterMin: 0 }
    feishu.status('reconnecting')
    bridge.checkOutages(Date.now() + 60 * 60_000)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tgSent).toEqual([])
  })
})

describe('undelivered', () => {
  it('trusts only failures that happened before the platform saw the request', () => {
    expect(undelivered(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(true)
    expect(undelivered(new TelegramApiError('sendMessage', 502, 'Bad Gateway'))).toBe(true)
    expect(undelivered(new TelegramApiError('sendMessage', 429, 'Too Many Requests'))).toBe(true)
    expect(undelivered(new TelegramApiError('sendMessage', 400, 'Bad Request'))).toBe(false)
    expect(undelivered(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(false)
    expect(undelivered(new Error('timeout'))).toBe(false)
  })
})
