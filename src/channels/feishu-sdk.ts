/**
 * {@link FeishuApi} over the official Node SDK. The SDK loads on first use,
 * so profiles without a Feishu line never pay for it.
 */

import type { Readable } from 'node:stream'
import type { LineSettings } from '../lines.ts'
import type { FeishuApi, FeishuCardActionEvent, FeishuMessageEvent } from './feishu.ts'
import { CredentialsRejectedError, readLimited } from './types.ts'

type Lark = typeof import('@larksuiteoapi/node-sdk')

/** Open Platform codes for an unknown app or a wrong secret. */
const REJECTED_CODES = new Set([10003, 10014, 99991663, 99991664, 99991665])

export interface FeishuSdkLogger {
  warn(message: string): void
  debug(message: string): void
}

/** Build the API for one line; nothing connects until the channel runs. */
export function createFeishuApi(line: LineSettings, logger: FeishuSdkLogger): FeishuApi {
  let loaded: Promise<{ lark: Lark; client: InstanceType<Lark['Client']> }> | undefined
  const sdk = () => loaded ??= import('@larksuiteoapi/node-sdk').then((lark) => {
    const client = new lark.Client({
      appId: line.appId ?? '',
      appSecret: line.secret ?? '',
      domain: line.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      logger: sdkLogger(logger),
    })
    return { lark, client }
  })

  /** Unwrap `{ code, msg, data }`, failing on a non-zero code. */
  const ok = <T>(result: { code?: number | undefined; msg?: string | undefined; data?: T | undefined } | null | undefined, what: string): T => {
    if (result === null || result === undefined) throw new Error(`feishu ${what}: empty response`)
    if (result.code !== undefined && result.code !== 0) {
      const message = `feishu ${what} failed (${result.code}): ${result.msg ?? ''}`
      throw REJECTED_CODES.has(result.code) ? new CredentialsRejectedError(message) : new Error(message)
    }
    return result.data as T
  }

  return {
    async botInfo() {
      const { client } = await sdk()
      const result = await client.request<{ code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } }>({
        method: 'GET', url: '/open-apis/bot/v3/info',
      }).catch((error: unknown) => { throw rejected(error) })
      if (result.code !== undefined && result.code !== 0) {
        const message = `feishu bot info failed (${result.code}): ${result.msg ?? ''}`
        throw REJECTED_CODES.has(result.code) ? new CredentialsRejectedError(message) : new Error(message)
      }
      return { openId: result.bot?.open_id ?? '', name: result.bot?.app_name ?? line.name }
    },

    async connect(handlers, signal) {
      const { lark } = await sdk()
      if (signal.aborted) return
      const ws = new lark.WSClient({
        appId: line.appId ?? '',
        appSecret: line.secret ?? '',
        domain: line.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.warn,
        logger: sdkLogger(logger),
        onReady: () => { handlers.status('ready') },
        onReconnecting: () => { handlers.status('reconnecting') },
        onReconnected: () => { handlers.status('ready') },
        onError: (error) => { handlers.status('failed', error) },
      })
      const dispatcher = new lark.EventDispatcher({}).register<{ 'card.action.trigger': (data: FeishuCardActionEvent) => Promise<unknown> }>({
        'im.message.receive_v1': (data) => { handlers.message(data as unknown as FeishuMessageEvent) },
        'card.action.trigger': data => handlers.action(data),
      })
      const stopped = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      await ws.start({ eventDispatcher: dispatcher })
      await stopped
      ws.close({ force: true })
    },

    async sendMessage(chatId, type, content) {
      const { client } = await sdk()
      const data = ok(await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content) },
      }), 'send')
      return data?.message_id ?? ''
    },

    async patchCard(messageId, content) {
      const { client } = await sdk()
      ok(await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(content) } }), 'card update')
    },

    async uploadImage(data) {
      const { client } = await sdk()
      const result = await client.im.v1.image.create({ data: { image_type: 'message', image: Buffer.from(data) } })
      if (result?.image_key === undefined) throw new Error('feishu image upload returned no key')
      return result.image_key
    },

    async uploadFile(data, name, fileType) {
      const { client } = await sdk()
      const result = await client.im.v1.file.create({
        data: { file_type: fileType as 'stream', file_name: name, file: Buffer.from(data) },
      })
      if (result?.file_key === undefined) throw new Error('feishu file upload returned no key')
      return result.file_key
    },

    async download(messageId, key, type, limit) {
      const { client } = await sdk()
      const resource = await client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type } })
      return readLimited(resource.getReadableStream() as Readable & AsyncIterable<Uint8Array>, limit)
    },

    async userName(openId) {
      if (openId === '') return undefined
      const { client } = await sdk()
      const result = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } })
      return result.data?.user?.name || undefined
    },

    async chatName(chatId) {
      const { client } = await sdk()
      const result = await client.im.v1.chat.get({ path: { chat_id: chatId } })
      return result.data?.name || undefined
    },
  }
}

/** A rejected token request surfaces as an HTTP error carrying the Open Platform code. */
function rejected(error: unknown): unknown {
  const code = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data?.code
  return code !== undefined && REJECTED_CODES.has(code)
    ? new CredentialsRejectedError(`feishu rejected the app credentials (${code})`)
    : error
}

function sdkLogger(logger: FeishuSdkLogger) {
  const text = (args: unknown[]) => args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')
  return {
    error: (...args: unknown[]) => { logger.warn(`feishu: ${text(args)}`) },
    warn: (...args: unknown[]) => { logger.warn(`feishu: ${text(args)}`) },
    info: (...args: unknown[]) => { logger.debug(`feishu: ${text(args)}`) },
    debug: (...args: unknown[]) => { logger.debug(`feishu: ${text(args)}`) },
    trace: () => {},
  }
}
