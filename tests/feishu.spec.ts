import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/bindings.ts'
import { Switchboard, type BridgeSettings } from '../src/bridge.ts'
import { parseContent, type FeishuApi, type FeishuCardActionEvent, type FeishuCardResponse, type FeishuMessageEvent } from '../src/channels/feishu.ts'
import { ChatLog } from '../src/chatlog.ts'
import type { LineSettings } from '../src/lines.ts'
import { FakeHarness } from './fakes.ts'

const BOT = { openId: 'ou_bot', name: 'Harness 助手' }
const ANN = 'ou_ann'
const DM = 'oc_dm'
const GROUP = 'oc_group'
const KEY = `feishu:${DM}`

/** In-memory Open Platform: records sends and card updates, delivers events on demand. */
class FakeFeishu implements FeishuApi {
  readonly sent: { chatId: string; type: string; content: Record<string, unknown>; id: string }[] = []
  readonly patches: { messageId: string; card: Record<string, unknown> }[] = []
  readonly uploads: { kind: 'image' | 'file'; bytes: number; name?: string; fileType?: string }[] = []
  readonly files = new Map<string, Uint8Array>()
  private handlers: Parameters<FeishuApi['connect']>[0] | undefined
  private nextId = 1

  async botInfo() { return BOT }

  async connect(handlers: Parameters<FeishuApi['connect']>[0], signal: AbortSignal): Promise<void> {
    this.handlers = handlers
    handlers.status('ready')
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }

  get connected(): boolean {
    return this.handlers !== undefined
  }

  /** Report the connection dropping or coming back. */
  status(state: 'ready' | 'reconnecting'): void {
    this.handlers!.status(state)
  }

  deliver(event: FeishuMessageEvent): void {
    this.handlers!.message(event)
  }

  press(event: FeishuCardActionEvent): Promise<FeishuCardResponse | undefined> {
    return this.handlers!.action(event)
  }

  async sendMessage(chatId: string, type: 'text' | 'interactive' | 'image' | 'file', content: object): Promise<string> {
    const id = `om_${this.nextId++}`
    this.sent.push({ chatId, type, content: content as Record<string, unknown>, id })
    return id
  }

  async patchCard(messageId: string, card: object): Promise<void> {
    this.patches.push({ messageId, card: card as Record<string, unknown> })
  }

  readonly reactions: { messageId: string; emoji: string }[] = []
  async addReaction(messageId: string, emoji: string): Promise<string> {
    this.reactions.push({ messageId, emoji })
    return `r${this.reactions.length}`
  }
  async removeReaction(): Promise<void> {}

  async uploadImage(data: Uint8Array): Promise<string> {
    this.uploads.push({ kind: 'image', bytes: data.byteLength })
    return 'img_key'
  }

  async uploadFile(data: Uint8Array, name: string, fileType: string): Promise<string> {
    this.uploads.push({ kind: 'file', bytes: data.byteLength, name, fileType })
    return 'file_key'
  }

  async download(messageId: string, key: string): Promise<Uint8Array> {
    const data = this.files.get(`${messageId}/${key}`)
    if (data === undefined) throw new Error('resource not found')
    return data
  }

  async userName(openId: string) { return openId === ANN ? 'Ann' : undefined }
  async chatName(chatId: string) { return chatId === GROUP ? 'Team' : undefined }

  /** Plain text of every message and card sent. */
  texts(): string[] {
    return this.sent.map(m => m.type === 'text' ? String(m.content['text']) : m.type === 'interactive' ? cardText(m.content) : `[${m.type}]`)
  }
}

/** The text element of a card. */
function cardText(card: Record<string, unknown>): string {
  const first = ((card['body'] as { elements: Record<string, unknown>[] }).elements)[0]!
  return first['tag'] === 'markdown' ? String(first['content']) : String((first['text'] as { content: string }).content)
}

/** Callback payloads of a card's buttons. */
function cardButtons(card: Record<string, unknown>): string[] {
  return ((card['body'] as { elements: Record<string, unknown>[] }).elements)
    .filter(element => element['tag'] === 'column_set')
    .flatMap(row => (row['columns'] as { elements: { behaviors: { value: { d: string } }[] }[] }[]).map(column => column.elements[0]!.behaviors[0]!.value.d))
}

let n = 0
function message(chatId: string, type: string, content: object, extra: Partial<FeishuMessageEvent['message']> = {}, from = ANN): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: from, user_id: `u_${from}` }, sender_type: 'user' },
    message: {
      message_id: `om_in_${++n}`, chat_id: chatId, chat_type: chatId === DM ? 'p2p' : 'group',
      message_type: type, content: JSON.stringify(content), ...extra,
    },
  }
}

const FEISHU_LINE: LineSettings = {
  id: 'feishu', type: 'feishu', name: '飞书', enabled: true, secret: 'SECRET', appId: 'cli_test', domain: 'feishu',
  allowedUsers: [ANN], allowedChats: [], groupMentionOnly: true, workspacePath: '',
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  for (let waited = 0; waited < timeoutMs && !predicate(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

let dir: string
let feishu: FakeFeishu
let harness: FakeHarness
let store: BindingStore
let chatLog: ChatLog
let bridge: Switchboard
let settings: BridgeSettings

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switchboard-feishu-'))
  feishu = new FakeFeishu()
  harness = new FakeHarness()
  store = new BindingStore(join(dir, 'state.json'))
  chatLog = new ChatLog(join(dir, 'chats'), () => 2000)
  settings = {
    enabled: true, lines: [FEISHU_LINE], workspacePath: dir,
    agentPreset: 'standard', permissionPreset: 'workspace-write',
    approvalViaTelegram: true, questionsViaTelegram: true, approvalTimeoutSec: 60,
    notifyToolCalls: false, streamReplies: true, turnSummary: 'off', turnSummaryMinSec: 60,
    transcribeVoice: true, scheduleChats: [], language: 'en', maxDownloadMb: 1, sendDeliverables: true,
  }
  bridge = new Switchboard(() => settings, harness, store, { info() {}, warn() {}, debug() {} }, { feishu: () => feishu }, chatLog)
  await bridge.reconcile()
  await until(() => bridge.state.kind === 'running')
})

afterEach(async () => {
  await bridge.stop()
  await chatLog.settled()
  await store.settled()
  await rm(dir, { recursive: true, force: true })
})

describe('Feishu line', () => {
  it('connects and reports the bot name', () => {
    expect(bridge.state).toEqual({ kind: 'running', username: BOT.name })
    expect(bridge.lineStates()).toEqual([{ id: 'feishu', type: 'feishu', name: '飞书', state: { kind: 'running', username: BOT.name }, queued: 0 }])
  })

  it('prompts a Session from a private message and replies with a Markdown card', async () => {
    feishu.deliver(message(DM, 'text', { text: 'run the tests' }))
    await until(() => harness.prompts.length === 1)
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'text', text: 'run the tests' }])
    expect(store.get(KEY).sessionId).toBe('s1')
    expect(feishu.sent[0]).toMatchObject({ chatId: DM, type: 'text' })
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All **green**.' }] } } })
    await until(() => feishu.sent.some(m => m.type === 'interactive'))
    const reply = feishu.sent.find(m => m.type === 'interactive')!
    expect(cardText(reply.content)).toBe('All **green**.')
    await chatLog.settled()
    const [chat] = await chatLog.chats()
    expect(chat).toMatchObject({ chatId: KEY, title: 'Ann', type: 'private' })
  })

  it('answers strangers with their open_id and admits them by user_id too', async () => {
    feishu.deliver(message(DM, 'text', { text: 'hello' }, {}, 'ou_eve'))
    await until(() => feishu.sent.length === 1)
    expect(feishu.texts()[0]).toContain('ou_eve')
    expect(harness.prompts).toHaveLength(0)
    settings = { ...settings, lines: [{ ...FEISHU_LINE, allowedUsers: ['u_ou_eve'] }] }
    feishu.deliver(message(DM, 'text', { text: 'now?' }, {}, 'ou_eve'))
    await until(() => harness.prompts.length === 1)
  })

  it('in groups answers only @mentions of the bot, with the mention removed', async () => {
    feishu.deliver(message(GROUP, 'text', { text: 'just chatting' }))
    feishu.deliver(message(GROUP, 'text', { text: '@_user_1 hi @_user_2' }, {
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' }, name: 'Bob' }, { key: '@_user_2', id: { open_id: BOT.openId }, name: BOT.name }],
    }))
    feishu.deliver(message(GROUP, 'text', { text: '@_user_1 please deploy' }, { mentions: [{ key: '@_user_1', id: { open_id: BOT.openId }, name: BOT.name }] }))
    await until(() => harness.prompts.length === 2)
    expect(harness.prompts.map(p => p.parts)).toEqual([
      [{ type: 'text', text: '@Bob hi' }],
      [{ type: 'text', text: 'please deploy' }],
    ])
    await chatLog.settled()
    expect((await chatLog.chats())[0]).toMatchObject({ chatId: `feishu:${GROUP}`, title: 'Team', type: 'group' })
  })

  it('ignores events Feishu delivers twice', async () => {
    const event = message(DM, 'text', { text: 'once' })
    feishu.deliver(event)
    feishu.deliver(event)
    await until(() => harness.prompts.length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.prompts).toHaveLength(1)
  })

  it('asks approvals on a card and settles them from a button press', async () => {
    await store.update(KEY, { sessionId: 's1' })
    const outcome = bridge.requestApproval({ sessionId: 's1', toolName: 'bash' })
    await until(() => feishu.sent.length === 1)
    const prompt = feishu.sent[0]!
    expect(prompt.type).toBe('interactive')
    const [allow] = cardButtons(prompt.content)
    const response = await feishu.press({ operator: { open_id: ANN }, action: { value: { d: allow! } }, context: { open_chat_id: DM, open_message_id: prompt.id } })
    expect(response).toBeUndefined()
    await expect(outcome).resolves.toBe('allowed-once')
    await until(() => feishu.patches.length === 1)
    expect(feishu.patches[0]?.messageId).toBe(prompt.id)
    expect(cardButtons(feishu.patches[0]!.card)).toEqual([])
    expect(cardText(feishu.patches[0]!.card)).toContain('Ann')
  })

  it('turns away presses from strangers with a toast', async () => {
    await store.update(KEY, { sessionId: 's1' })
    void bridge.requestApproval({ sessionId: 's1', toolName: 'bash' })
    await until(() => feishu.sent.length === 1)
    const [allow] = cardButtons(feishu.sent[0]!.content)
    const response = await feishu.press({ operator: { open_id: 'ou_eve' }, action: { value: { d: allow! } }, context: { open_chat_id: DM } })
    expect(response?.toast?.content).toContain('ou_eve')
  })

  it('stages images from messages as prompt images', async () => {
    const event = message(DM, 'image', { image_key: 'img_1' })
    feishu.files.set(`${event.message.message_id}/img_1`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))
    feishu.deliver(event)
    await until(() => harness.prompts.length === 1)
    expect(harness.staged[0]).toMatchObject({ imageType: 'image/png', bytes: 9 })
    expect(harness.prompts[0]?.parts).toEqual([{ type: 'file', receiptId: 'r1' }])
  })

  it('streams the reply in a progress card and replaces it with the reply', async () => {
    await store.update(KEY, { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'turn/start' })
    bridge.onAssistantStream('s1', { type: 'start' })
    bridge.onAssistantStream('s1', { type: 'chunk', chunk: { type: 'text-delta', text: 'Working through the failing tests one at a time…' } })
    await until(() => feishu.sent.length === 1, 3000)
    expect(feishu.sent[0]?.type).toBe('interactive')
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done: 3 fixed.' }] } } })
    await until(() => feishu.patches.length === 1)
    expect(feishu.patches[0]?.messageId).toBe(feishu.sent[0]?.id)
    expect(cardText(feishu.patches[0]!.card)).toBe('Done: 3 fixed.')
    expect(feishu.sent).toHaveLength(1)
  })

  it('sends presented images and files back', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'chart.png'), new Uint8Array([1, 2, 3]))
    await writeFile(join(dir, 'report.pdf'), new Uint8Array([4, 5]))
    await store.update(KEY, { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'deliverables/presented', data: { files: [{ path: join(dir, 'chart.png') }, { path: join(dir, 'report.pdf'), description: 'Q3' }] } })
    await until(() => feishu.sent.length === 3)
    expect(feishu.uploads).toEqual([{ kind: 'image', bytes: 3 }, { kind: 'file', bytes: 2, name: 'report.pdf', fileType: 'pdf' }])
    expect(feishu.sent.map(m => m.type)).toEqual(['image', 'file', 'text'])
    expect(feishu.texts()[2]).toBe('report.pdf\nQ3')
  })

  it('marks messages with OnIt while working and DONE after', async () => {
    const event = message(DM, 'text', { text: 'go' })
    feishu.deliver(event)
    await until(() => feishu.reactions.length === 1)
    expect(feishu.reactions[0]).toEqual({ messageId: event.message.message_id, emoji: 'OnIt' })
    bridge.onSessionEvent('s1', { type: 'turn/start' })
    bridge.onSessionEvent('s1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await until(() => feishu.reactions.length === 2)
    expect(feishu.reactions[1]?.emoji).toBe('DONE')
  })

  it('needs an app id and secret', async () => {
    settings = { ...settings, lines: [{ ...FEISHU_LINE, appId: '' }] }
    await bridge.reconcile()
    await until(() => bridge.state.kind === 'error')
  })
})

describe('Feishu message content', () => {
  it('reads rich-text posts with links, mentions, code, and images', () => {
    const parsed = parseContent('post', JSON.stringify({
      title: 'Bug',
      content: [
        [{ tag: 'text', text: 'see ' }, { tag: 'a', text: 'log', href: 'https://x.test' }, { tag: 'at', user_id: 'ou_1', user_name: 'Bob' }],
        [{ tag: 'code_block', language: 'TS', text: 'let a = 1' }],
        [{ tag: 'img', image_key: 'img_9' }],
      ],
    }), 'om_123456789')
    expect(parsed.text).toBe('Bug\nsee log (https://x.test)@Bob\n\n```ts\nlet a = 1\n```')
    expect(parsed.attachments).toEqual([{ ref: 'image|om_123456789|img_9', name: 'image_23456789.png', mediaType: 'image/png' }])
  })

  it('reads files, audio, and locale-wrapped posts', () => {
    expect(parseContent('file', JSON.stringify({ file_key: 'f1', file_name: '../a.txt' }), 'om_1').attachments)
      .toEqual([{ ref: 'file|om_1|f1', name: 'a.txt' }])
    const audio = parseContent('audio', JSON.stringify({ file_key: 'v1' }), 'om_2')
    expect(audio.voice).toEqual(audio.attachments[0])
    expect(parseContent('post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: '你好' }]] } }), 'om_3').text).toBe('你好')
    expect(parseContent('sticker', '{}', 'om_4')).toEqual({ attachments: [] })
  })
})

describe('several lines', () => {
  it('mirrors one Session to a Feishu chat and a Telegram chat', async () => {
    const telegramCalls: string[] = []
    const fetchTelegram: typeof fetch = async (input, init) => {
      const method = String(input).split('/').pop() ?? ''
      if (method === 'getUpdates') {
        await new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) })
      }
      const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (method === 'sendMessage') telegramCalls.push(String(params['text']))
      const result = method === 'getMe' ? { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } : { message_id: 1, chat: { id: 5 }, date: 0 }
      return new Response(JSON.stringify({ ok: true, result }))
    }
    await bridge.stop()
    settings = {
      ...settings,
      lines: [FEISHU_LINE, {
        id: 'telegram', type: 'telegram', name: 'Telegram', enabled: true, secret: 'T', apiBaseUrl: 'https://api.telegram.test', pollTimeoutSec: 1,
        allowedUsers: ['42'], allowedChats: [], groupMentionOnly: true, workspacePath: '',
      }],
    }
    bridge = new Switchboard(() => settings, harness, store, { info() {}, warn() {}, debug() {} }, { feishu: () => feishu, fetch: fetchTelegram }, chatLog)
    await bridge.reconcile()
    await until(() => bridge.lineStates().every(line => line.state.kind === 'running'))
    await store.update(KEY, { sessionId: 's1' })
    await store.update('5', { sessionId: 's1' })
    bridge.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello both' }] } } })
    await until(() => telegramCalls.includes('hello both') && feishu.texts().includes('hello both'))
  })
})
