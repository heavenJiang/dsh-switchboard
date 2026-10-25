import { describe, expect, it } from 'vitest'
import { createFeishuApi } from '../src/channels/feishu-api.ts'
import { decodeFrame, encodeFrame, type Frame } from '../src/channels/feishu-frame.ts'
import type { FeishuApi } from '../src/channels/feishu.ts'
import { CredentialsRejectedError } from '../src/channels/types.ts'
import type { LineSettings } from '../src/lines.ts'

const LINE: LineSettings = {
  id: 'feishu', type: 'feishu', name: '飞书', enabled: true, secret: 'SECRET', appId: 'cli_test', domain: 'feishu',
  allowedUsers: [], allowedChats: [], groupMentionOnly: true, workspacePath: '',
}
const quiet = { debug() {} }
const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)

/** The official SDK's protobufjs encoding of the frame below. */
const SDK_VECTOR = '080710eb8b9f98e4918a926718f681801020012a0d0a047479706512056576656e742a100a0a6d6573736167655f696412026d312a080a0373756d1201312a080a0373657112013042077b2261223a317d'

describe('Feishu frame', () => {
  const frame: Frame = {
    SeqID: 7n, LogID: 7432109876543210987n, service: 33554678, method: 1,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm1' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
    payload: new TextEncoder().encode('{"a":1}'),
  }

  it('encodes byte for byte like the official SDK', () => {
    expect(Buffer.from(encodeFrame(frame)).toString('hex')).toBe(SDK_VECTOR)
  })

  it('decodes 64-bit ids without losing precision', () => {
    const back = decodeFrame(Buffer.from(SDK_VECTOR, 'hex'))
    expect(back).toMatchObject({ SeqID: 7n, LogID: 7432109876543210987n, service: 33554678, method: 1, headers: frame.headers })
    expect(text(back.payload)).toBe('{"a":1}')
  })
})

/** A WebSocket the test drives: records what the client sends. */
class FakeSocket {
  static readonly OPEN = 1
  static last: FakeSocket | undefined
  readyState = 0
  binaryType = 'blob'
  readonly sent: Frame[] = []
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: Uint8Array): void {
    this.sent.push(decodeFrame(data))
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', {})
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  receive(frame: Frame): void {
    const bytes = encodeFrame(frame)
    this.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

/** Open Platform REST stand-in; records calls. */
function platform(answers: Partial<Record<string, (body: unknown, init: RequestInit) => unknown>> = {}) {
  const calls: { path: string; method: string; auth?: string; body?: unknown }[] = []
  let tokens = 0
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : init.body
    calls.push({ path, method: init.method ?? 'GET', ...(init.headers as Record<string, string> | undefined)?.['authorization'] === undefined ? {} : { auth: (init.headers as Record<string, string>)['authorization'] }, body })
    const custom = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1]
    if (custom !== undefined) return Response.json(custom(body, init))
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: `t${++tokens}`, expire: 7200 })
    if (path === '/callback/ws/endpoint') {
      return Response.json({ code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?device_id=d1&service_id=42', ClientConfig: { PingInterval: 120, ReconnectInterval: 1, ReconnectNonce: 0 } } })
    }
    if (path.startsWith('/open-apis/im/v1/messages?')) return Response.json({ code: 0, data: { message_id: 'om_1' } })
    return Response.json({ code: 0, data: {} })
  }
  return { calls, fetch: fetchImpl }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1000 && !predicate(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

describe('Feishu persistent connection', () => {
  it('pings, merges fragmented events, and answers each data frame', async () => {
    const rest = platform()
    const api = createFeishuApi(LINE, quiet, { fetch: rest.fetch, WebSocket: FakeSocket as unknown as typeof WebSocket })
    const statuses: string[] = []
    const messages: unknown[] = []
    const controller = new AbortController()
    const handlers: Parameters<FeishuApi['connect']>[0] = {
      message: (event) => { messages.push(event) },
      action: async () => ({ toast: { type: 'info', content: 'ok' } }),
      status: (state) => { statuses.push(state) },
    }
    const done = api.connect(handlers, controller.signal)
    await until(() => FakeSocket.last !== undefined)
    const socket = FakeSocket.last!
    expect(rest.calls[0]).toMatchObject({ path: '/callback/ws/endpoint', body: { AppID: 'cli_test', AppSecret: 'SECRET' } })
    socket.open()
    expect(statuses).toEqual(['ready'])
    expect(socket.sent[0]).toMatchObject({ method: 0, service: 42, headers: [{ key: 'type', value: 'ping' }] })

    const event = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: 'e1' },
      event: { sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' }, message: { message_id: 'om_9', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"hi"}' } },
    })
    const bytes = new TextEncoder().encode(event)
    const half = Math.floor(bytes.length / 2)
    const part = (seq: number, payload: Uint8Array): Frame => ({
      SeqID: 5n, LogID: 9007199254740993n, service: 42, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'f1' }, { key: 'sum', value: '2' }, { key: 'seq', value: String(seq) }],
      payload,
    })
    socket.receive(part(1, bytes.subarray(half)))
    expect(messages).toHaveLength(0)
    socket.receive(part(0, bytes.subarray(0, half)))
    await until(() => socket.sent.length === 2)
    expect(messages[0]).toMatchObject({ event_type: 'im.message.receive_v1', message: { message_id: 'om_9' }, sender: { sender_id: { open_id: 'ou_1' } } })
    const reply = socket.sent[1]!
    expect(reply).toMatchObject({ SeqID: 5n, LogID: 9007199254740993n, method: 1 })
    expect(reply.headers.map(h => h.key)).toContain('biz_rt')
    expect(JSON.parse(text(reply.payload))).toEqual({ code: 200 })

    socket.receive({
      SeqID: 6n, LogID: 1n, service: 42, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'c1' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
      payload: new TextEncoder().encode(JSON.stringify({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event: { operator: { open_id: 'ou_1' }, action: { value: { d: 'ap:x:y' } } } })),
    })
    await until(() => socket.sent.length === 3)
    const answer = JSON.parse(text(socket.sent[2]!.payload)) as { code: number; data: string }
    expect(answer.code).toBe(200)
    expect(JSON.parse(Buffer.from(answer.data, 'base64').toString())).toEqual({ toast: { type: 'info', content: 'ok' } })

    controller.abort()
    await done
  })

  it('refuses credentials the endpoint rejects', async () => {
    const rest = platform({ '/callback/ws/endpoint': () => ({ code: 514, msg: 'auth failed' }) })
    const api = createFeishuApi(LINE, quiet, { fetch: rest.fetch, WebSocket: FakeSocket as unknown as typeof WebSocket })
    await expect(api.connect({ message() {}, action: async () => undefined, status() {} }, new AbortController().signal))
      .rejects.toBeInstanceOf(CredentialsRejectedError)
  })
})

describe('Feishu REST', () => {
  it('sends with a cached tenant token and renews it once when it expires', async () => {
    let expired = true
    const rest = platform({
      '/open-apis/im/v1/messages/om_1': () => {
        if (expired) {
          expired = false
          return { code: 99991663, msg: 'token invalid' }
        }
        return { code: 0 }
      },
    })
    const api = createFeishuApi(LINE, quiet, { fetch: rest.fetch })
    expect(await api.sendMessage('oc_1', 'text', { text: 'hi' })).toBe('om_1')
    await api.patchCard('om_1', { schema: '2.0' })
    const sends = rest.calls.filter(call => !call.path.includes('tenant_access_token'))
    expect(sends.map(call => [call.method, call.path, call.auth])).toEqual([
      ['POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', 'Bearer t1'],
      ['PATCH', '/open-apis/im/v1/messages/om_1', 'Bearer t1'],
      ['PATCH', '/open-apis/im/v1/messages/om_1', 'Bearer t2'],
    ])
    expect(sends[0]?.body).toEqual({ receive_id: 'oc_1', msg_type: 'text', content: '{"text":"hi"}' })
  })

  it('reports wrong app credentials as rejected', async () => {
    const rest = platform({ '/open-apis/auth/v3/tenant_access_token/internal': () => ({ code: 10014, msg: 'app secret invalid' }) })
    const api = createFeishuApi(LINE, quiet, { fetch: rest.fetch })
    await expect(api.botInfo()).rejects.toBeInstanceOf(CredentialsRejectedError)
  })

  it('reads the bot name from bot info', async () => {
    const rest = platform({ '/open-apis/bot/v3/info': () => ({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Harness 助手' } }) })
    const api = createFeishuApi(LINE, quiet, { fetch: rest.fetch })
    expect(await api.botInfo()).toEqual({ openId: 'ou_bot', name: 'Harness 助手' })
  })
})
