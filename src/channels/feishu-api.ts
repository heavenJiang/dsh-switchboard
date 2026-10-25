/**
 * {@link FeishuApi} over Node's fetch and WebSocket, so the launcher's proxy
 * policy applies as it does to Telegram and the plugin needs no SDK. The
 * persistent connection follows the official SDK's protocol: ask the
 * endpoint for a socket URL, ping on the interval it gives, merge fragmented
 * events, and answer each data frame with its result.
 */

import type { LineSettings } from '../lines.ts'
import type { FeishuApi, FeishuCardActionEvent, FeishuMessageEvent } from './feishu.ts'
import { decodeFrame, encodeFrame, type Frame } from './feishu-frame.ts'
import { CredentialsRejectedError, readLimited, sleep } from './types.ts'

/** Transports; tests substitute both. */
export interface FeishuTransport {
  readonly fetch?: typeof fetch
  readonly WebSocket?: typeof WebSocket
}

const DOMAINS = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const
/** Token codes that mean the app id or secret is wrong. */
const REJECTED_CODES = new Set([10003, 10014, 99991663, 99991664, 99991665])
/** Endpoint codes for refused credentials. */
const ENDPOINT_REJECTED = new Set([403, 514])
const TOKEN_MARGIN_MS = 3 * 60 * 1000
const FRAGMENT_TTL_MS = 10_000

/** An Open Platform call that answered a non-zero code. */
export class FeishuApiError extends Error {
  constructor(readonly what: string, readonly code: number, message: string) {
    super(`feishu ${what} failed (${code}): ${message}`)
    this.name = 'FeishuApiError'
  }
}

/** Build the API for one line; nothing connects until the channel runs. */
export function createFeishuApi(line: LineSettings, logger: { debug(message: string): void }, transport: FeishuTransport = {}): FeishuApi {
  const fetchImpl = transport.fetch ?? fetch
  const base = DOMAINS[line.domain ?? 'feishu']
  const appId = line.appId ?? ''
  const appSecret = line.secret ?? ''
  let token: { value: string; until: number } | undefined

  const tenantToken = async (): Promise<string> => {
    if (token !== undefined && Date.now() < token.until) return token.value
    const response = await fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (body.code !== 0 || body.tenant_access_token === undefined) {
      throw new CredentialsRejectedError(`feishu rejected the app credentials (${body.code ?? response.status}: ${body.msg ?? ''})`)
    }
    token = { value: body.tenant_access_token, until: Date.now() + (body.expire ?? 7200) * 1000 - TOKEN_MARGIN_MS }
    return token.value
  }

  /** One authorized JSON or multipart call; an expired token is renewed once. */
  const request = async <T>(what: string, method: string, path: string, body?: object | FormData, retried = false): Promise<T> => {
    const json = body !== undefined && !(body instanceof FormData)
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await tenantToken()}`, ...(json ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
      ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body as FormData }),
    })
    let answer: { code?: number; msg?: string } & Record<string, unknown>
    try {
      answer = await response.json() as typeof answer
    } catch {
      throw new FeishuApiError(what, response.status, `non-JSON response (HTTP ${response.status})`)
    }
    if (answer.code === 99991663 && !retried) {
      token = undefined
      return request(what, method, path, body, true)
    }
    if (answer.code !== 0) {
      const error = new FeishuApiError(what, answer.code ?? response.status, answer.msg ?? '')
      throw REJECTED_CODES.has(answer.code ?? 0) ? new CredentialsRejectedError(error.message) : error
    }
    return answer as T
  }
  const data = async <T>(what: string, method: string, path: string, body?: object | FormData): Promise<T> =>
    (await request<{ data?: T }>(what, method, path, body)).data as T

  return {
    async botInfo() {
      const answer = await request<{ bot?: { open_id?: string; app_name?: string } }>('bot info', 'GET', '/open-apis/bot/v3/info')
      return { openId: answer.bot?.open_id ?? '', name: answer.bot?.app_name ?? line.name }
    },

    async connect(handlers, signal) {
      const Socket = transport.WebSocket ?? globalThis.WebSocket
      let first = true
      while (!signal.aborted) {
        const response = await fetchImpl(`${base}/callback/ws/endpoint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', locale: 'zh' },
          body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
        })
        const answer = await response.json() as {
          code?: number; msg?: string
          data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectInterval?: number; ReconnectNonce?: number } }
        }
        if (answer.code !== 0 || answer.data?.URL === undefined) {
          const message = `feishu connection endpoint failed (${answer.code ?? response.status}): ${answer.msg ?? ''}`
          throw ENDPOINT_REJECTED.has(answer.code ?? 0) ? new CredentialsRejectedError(message) : new Error(message)
        }
        const config = answer.data.ClientConfig ?? {}
        if (!first) handlers.status('reconnecting')
        first = false
        await session(Socket, answer.data.URL, (config.PingInterval ?? 120) * 1000, handlers, signal, logger)
        if (signal.aborted) return
        const wait = (config.ReconnectInterval ?? 5) * 1000 + Math.random() * (config.ReconnectNonce ?? 5) * 1000
        handlers.status('reconnecting')
        await sleep(wait, signal)
      }
    },

    async sendMessage(chatId, type, content) {
      const sent = await data<{ message_id?: string }>('send', 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId, msg_type: type, content: JSON.stringify(content),
      })
      return sent?.message_id ?? ''
    },

    async patchCard(messageId, card) {
      await request('card update', 'PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) })
    },

    async uploadImage(bytes) {
      const form = new FormData()
      form.set('image_type', 'message')
      form.set('image', new Blob([bytes as Uint8Array<ArrayBuffer>]), 'image')
      const uploaded = await data<{ image_key?: string }>('image upload', 'POST', '/open-apis/im/v1/images', form)
      if (uploaded?.image_key === undefined) throw new Error('feishu image upload returned no key')
      return uploaded.image_key
    },

    async uploadFile(bytes, name, fileType) {
      const form = new FormData()
      form.set('file_type', fileType)
      form.set('file_name', name)
      form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), name)
      const uploaded = await data<{ file_key?: string }>('file upload', 'POST', '/open-apis/im/v1/files', form)
      if (uploaded?.file_key === undefined) throw new Error('feishu file upload returned no key')
      return uploaded.file_key
    },

    async download(messageId, key, type, limit) {
      const response = await fetchImpl(
        `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`,
        { headers: { authorization: `Bearer ${await tenantToken()}` } },
      )
      if (!response.ok || response.body === null) {
        const answer = await response.json().catch(() => ({})) as { code?: number; msg?: string }
        throw new FeishuApiError('download', answer.code ?? response.status, answer.msg ?? `HTTP ${response.status}`)
      }
      return readLimited(response.body as AsyncIterable<Uint8Array>, limit)
    },

    async userName(openId) {
      if (openId === '') return undefined
      const found = await data<{ user?: { name?: string } }>('user lookup', 'GET', `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`)
      return found?.user?.name || undefined
    },

    async chatName(chatId) {
      const found = await data<{ name?: string }>('chat lookup', 'GET', `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`)
      return found?.name || undefined
    },
  }
}

/**
 * One socket's life: ping on the interval, dispatch events, answer each data
 * frame. Resolves when the socket closes, goes silent, or `signal` aborts.
 */
function session(
  Socket: typeof WebSocket, url: string, pingMs: number,
  handlers: Parameters<FeishuApi['connect']>[0], signal: AbortSignal, logger: { debug(message: string): void },
): Promise<void> {
  const service = Number(new URL(url).searchParams.get('service_id') ?? 0)
  const fragments = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>()
  return new Promise((resolve) => {
    const socket = new Socket(url)
    socket.binaryType = 'arraybuffer'
    let ping: ReturnType<typeof setInterval> | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      clearInterval(ping)
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
      try { socket.close() } catch { /* already closed */ }
      resolve()
    }
    // Any frame proves the connection alive; three silent ping intervals end it.
    const alive = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(finish, pingMs * 3)
    }
    const onAbort = (): void => { finish() }
    signal.addEventListener('abort', onAbort, { once: true })
    const send = (frame: Frame): void => {
      if (socket.readyState === Socket.OPEN) socket.send(encodeFrame(frame))
    }
    socket.addEventListener('open', () => {
      handlers.status('ready')
      const beat = (): void => {
        send({ SeqID: 0n, LogID: 0n, service, method: 0, headers: [{ key: 'type', value: 'ping' }] })
      }
      beat()
      ping = setInterval(beat, pingMs)
      alive()
    })
    socket.addEventListener('close', finish)
    socket.addEventListener('error', () => { logger.debug('feishu socket error') })
    socket.addEventListener('message', (message: MessageEvent) => {
      alive()
      let frame: Frame
      try {
        frame = decodeFrame(new Uint8Array(message.data as ArrayBuffer))
      } catch (error: unknown) {
        logger.debug(`feishu frame dropped: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (frame.method !== 1) return
      const header = Object.fromEntries(frame.headers.map(h => [h.key, h.value]))
      if (header['type'] !== 'event') return
      const merged = merge(fragments, header['message_id'] ?? '', Number(header['sum'] ?? 1), Number(header['seq'] ?? 0), frame.payload ?? new Uint8Array())
      if (merged === undefined) return
      const started = Date.now()
      void dispatch(merged, handlers).then(
        result => ({ code: 200, ...(result === undefined ? {} : { data: Buffer.from(JSON.stringify(result)).toString('base64') }) }),
        (error: unknown) => {
          logger.debug(`feishu event failed: ${error instanceof Error ? error.message : String(error)}`)
          return { code: 500 }
        },
      ).then((reply) => {
        send({
          ...frame,
          headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }],
          payload: new TextEncoder().encode(JSON.stringify(reply)),
        })
      })
    })
  })
}

/** Collect an event's fragments; the whole JSON once every part arrived. */
function merge(
  cache: Map<string, { parts: (Uint8Array | undefined)[]; at: number }>,
  id: string, sum: number, seq: number, payload: Uint8Array,
): unknown {
  for (const [key, entry] of cache) if (Date.now() - entry.at > FRAGMENT_TTL_MS) cache.delete(key)
  if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) return undefined
  const entry = cache.get(id) ?? { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: Date.now() }
  if (entry.parts.length !== sum) return undefined
  entry.parts[seq] = payload
  if (entry.parts.some(part => part === undefined)) {
    cache.set(id, entry)
    return undefined
  }
  cache.delete(id)
  const whole = Buffer.concat(entry.parts as Uint8Array[])
  try {
    return JSON.parse(whole.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Route one event by type, flattened the way the SDK hands events to handlers. */
async function dispatch(payload: unknown, handlers: Parameters<FeishuApi['connect']>[0]): Promise<unknown> {
  const body = payload as { schema?: string; header?: { event_type?: string } & Record<string, unknown>; event?: Record<string, unknown> } & Record<string, unknown>
  const type = body.header?.event_type ?? (body.event as { type?: string } | undefined)?.type
  const { header, event, ...rest } = body
  const flat = { ...rest, ...header, ...event }
  if (type === 'im.message.receive_v1') {
    handlers.message(flat as unknown as FeishuMessageEvent)
    return undefined
  }
  if (type === 'card.action.trigger') return handlers.action(flat as unknown as FeishuCardActionEvent)
  return undefined
}
