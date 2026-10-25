/**
 * Feishu (Lark) line: receives events over the Open Platform's persistent
 * connection, so no public callback URL is needed. Plain notices go out as
 * text messages; replies, drafts, and anything with buttons go out as
 * interactive cards, the only message kind Feishu lets a bot edit freely.
 */

import { extname } from 'node:path'
import type { LineSettings } from '../lines.ts'
import { chunkMarkdown } from '../markdown.ts'
import { safeName } from '../media.ts'
import {
  CredentialsRejectedError, FileTooLargeError, sleep,
  type Button, type Channel, type ChannelChat, type ChannelSink, type InboundAction, type InboundAttachment,
  type InboundMessage, type OutFile, type OutMessage,
} from './types.ts'

/** `im.message.receive_v1`, the fields read here. */
export interface FeishuMessageEvent {
  readonly sender: {
    readonly sender_id?: { readonly open_id?: string; readonly user_id?: string; readonly union_id?: string }
    readonly sender_type: string
  }
  readonly message: {
    readonly message_id: string
    readonly parent_id?: string
    readonly chat_id: string
    readonly chat_type: string
    readonly message_type: string
    readonly content: string
    readonly mentions?: readonly { readonly key: string; readonly id: { readonly open_id?: string }; readonly name: string }[]
  }
}

/** `card.action.trigger`, the fields read here. */
export interface FeishuCardActionEvent {
  readonly operator?: { readonly open_id?: string; readonly user_id?: string; readonly union_id?: string }
  readonly action?: { readonly value?: { readonly d?: string } | string }
  readonly context?: { readonly open_message_id?: string; readonly open_chat_id?: string }
  /** Older callbacks carry these at the top level. */
  readonly open_message_id?: string
  readonly open_chat_id?: string
}

/** What a card action may answer within Feishu's three seconds. */
export interface FeishuCardResponse {
  readonly toast?: { readonly type: 'info' | 'success' | 'error' | 'warning'; readonly content: string }
}

/** The Open Platform calls this adapter makes; the SDK implements them in production, tests fake them. */
export interface FeishuApi {
  botInfo(): Promise<{ openId: string; name: string }>
  /**
   * Receive events until `signal` aborts.
   * @param handlers - event callbacks; `status` follows the connection.
   */
  connect(handlers: {
    message(event: FeishuMessageEvent): void
    action(event: FeishuCardActionEvent): Promise<FeishuCardResponse | undefined>
    status(state: 'ready' | 'reconnecting' | 'failed', error?: Error): void
  }, signal: AbortSignal): Promise<void>
  /** @returns the new message's id. */
  sendMessage(chatId: string, type: 'text' | 'interactive' | 'image' | 'file', content: object): Promise<string>
  patchCard(messageId: string, card: object): Promise<void>
  uploadImage(data: Uint8Array): Promise<string>
  uploadFile(data: Uint8Array, name: string, fileType: string): Promise<string>
  /** Download a message's image or file. */
  download(messageId: string, key: string, type: 'image' | 'file', limit: number): Promise<Uint8Array>
  /** Display name of a user, when the app may read contacts. */
  userName(openId: string): Promise<string | undefined>
  /** Name of a group chat, when the app may read it. */
  chatName(chatId: string): Promise<string | undefined>
}

export interface FeishuChannelOptions {
  readonly api: FeishuApi
  readonly logger: { warn(message: string): void }
}

const MAX_BACKOFF_MS = 60_000
/** Feishu's file message ceiling; images are limited to 10 MB and go as files beyond it. */
const SEND_LIMIT_BYTES = 30 * 1024 * 1024
const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024
/** A card stays well under Feishu's 30 KB card limit at this many characters. */
const CARD_TEXT_LIMIT = 8000
/** Card actions must be answered within three seconds. */
const ACTION_REPLY_MS = 2500
/** Feishu redelivers events it thinks were missed; remember this many ids. */
const SEEN_LIMIT = 500
/** Name lookups give up after this long rather than delay a message. */
const LOOKUP_MS = 2000

const FILE_TYPES: Record<string, string> = {
  '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt', '.mp4': 'mp4', '.opus': 'opus',
}

export class FeishuChannel implements Channel {
  readonly sendLimitBytes = SEND_LIMIT_BYTES
  private bot: { openId: string; name: string } | undefined
  private readonly seen = new Set<string>()
  private readonly names = new Map<string, Promise<string | undefined>>()
  /** Chat kinds seen in messages, so a button press knows whether it came from a group. */
  private readonly chatTypes = new Map<string, ChannelChat['type']>()
  private readonly pendingActions = new Map<string, (notice?: string) => void>()
  private actionSeq = 0

  constructor(private readonly line: LineSettings, private readonly options: FeishuChannelOptions) {}

  /** Feishu commands carry no bot suffix. */
  get username(): string | undefined {
    return undefined
  }

  async run(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    if ((this.line.appId ?? '').trim() === '' || (this.line.secret ?? '') === '') {
      sink.state({ kind: 'error', message: 'app id or secret missing' })
      return
    }
    let backoff = 1000
    sink.state({ kind: 'connecting' })
    while (!signal.aborted) {
      try {
        this.bot = await this.options.api.botInfo()
        const name = this.bot.name
        await this.options.api.connect({
          message: (event) => {
            void this.onMessage(event, sink).catch((error: unknown) => {
              this.options.logger.warn(`message ${event.message.message_id} failed: ${describe(error)}`)
            })
          },
          action: event => this.onAction(event, sink),
          status: (state, error) => {
            if (state === 'ready') sink.state({ kind: 'running', username: name })
            else if (state === 'reconnecting') sink.state({ kind: 'connecting' })
            else sink.state({ kind: 'error', message: error === undefined ? 'connection failed' : describe(error) })
          },
        }, signal)
        return
      } catch (error: unknown) {
        if (signal.aborted) return
        if (error instanceof CredentialsRejectedError) {
          sink.state({ kind: 'error', message: error.message })
          this.options.logger.warn(`${error.message}; fix it on the plugin page`)
          return
        }
        sink.state({ kind: 'error', message: describe(error) })
        this.options.logger.warn(`connection failed, retrying in ${backoff / 1000}s: ${describe(error)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        if (!signal.aborted) sink.state({ kind: 'connecting' })
      }
    }
  }

  private async onMessage(event: FeishuMessageEvent, sink: ChannelSink): Promise<void> {
    const { message, sender } = event
    if (sender.sender_type !== 'user' || this.seen.has(message.message_id)) return
    this.seen.add(message.message_id)
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string)
    const openId = sender.sender_id?.open_id ?? ''
    const type: ChannelChat['type'] = message.chat_type === 'p2p' ? 'private' : 'group'
    this.chatTypes.set(message.chat_id, type)
    const parsed = parseContent(message.message_type, message.content, message.message_id)
    const mentions = message.mentions ?? []
    const botMentioned = mentions.some(m => this.bot === undefined || m.id.open_id === this.bot.openId)
    let text = parsed.text
    for (const mention of mentions) {
      const self = this.bot !== undefined && mention.id.open_id === this.bot.openId
      text = text?.split(mention.key).join(self ? '' : `@${mention.name}`)
    }
    text = text?.replace(/[ \t]{2,}/gu, ' ').trim()
    const [name, title] = await Promise.all([
      this.lookup(`u:${openId}`, () => this.options.api.userName(openId)),
      type === 'group' ? this.lookup(`c:${message.chat_id}`, () => this.options.api.chatName(message.chat_id)) : Promise.resolve(undefined),
    ])
    const aliases = [sender.sender_id?.user_id, sender.sender_id?.union_id].filter((id): id is string => id !== undefined && id !== '')
    const userName = name ?? openId
    const inbound: InboundMessage = {
      chat: { id: message.chat_id, type, title: type === 'private' ? userName : (title ?? message.chat_id) },
      from: { id: openId, name: userName, ...(aliases.length === 0 ? {} : { aliases }) },
      messageId: message.message_id,
      ...(text === undefined || text === '' ? {} : { text }),
      addressed: type === 'private' || botMentioned,
      attachments: parsed.attachments,
      ...(parsed.voice === undefined ? {} : { voice: parsed.voice }),
    }
    await sink.message(inbound)
  }

  /** Answer the press within Feishu's window; the bridge acknowledges it while it handles the action. */
  private onAction(event: FeishuCardActionEvent, sink: ChannelSink): Promise<FeishuCardResponse | undefined> {
    const value = event.action?.value
    const data = typeof value === 'string' ? value : value?.d ?? ''
    const openId = event.operator?.open_id ?? ''
    const chatId = event.context?.open_chat_id ?? event.open_chat_id
    const messageId = event.context?.open_message_id ?? event.open_message_id
    const id = `a${++this.actionSeq}`
    const reply = Promise.withResolvers<FeishuCardResponse | undefined>()
    const timer = setTimeout(() => { settle() }, ACTION_REPLY_MS)
    const settle = (notice?: string): void => {
      if (!this.pendingActions.delete(id)) return
      clearTimeout(timer)
      reply.resolve(notice === undefined ? undefined : { toast: { type: 'info', content: notice } })
    }
    this.pendingActions.set(id, settle)
    const aliases = [event.operator?.user_id, event.operator?.union_id].filter((alias): alias is string => alias !== undefined && alias !== '')
    void this.lookup(`u:${openId}`, () => this.options.api.userName(openId)).then(name => sink.action({
      id,
      from: { id: openId, name: name ?? openId, ...(aliases.length === 0 ? {} : { aliases }) },
      data,
      ...(chatId === undefined ? {} : { chat: { id: chatId, type: this.chatTypes.get(chatId) ?? 'group' } }),
      ...(messageId === undefined ? {} : { messageId }),
    })).catch((error: unknown) => {
      this.options.logger.warn(`card action failed: ${describe(error)}`)
    }).finally(() => { settle() })
    return reply.promise
  }

  private lookup(key: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
    let found = this.names.get(key)
    if (found === undefined) {
      found = Promise.race([
        load().catch(() => undefined),
        new Promise<undefined>(resolve => setTimeout(resolve, LOOKUP_MS)),
      ])
      this.names.set(key, found)
      // A failed or slow lookup is retried on a later message.
      void found.then((name) => { if (name === undefined) this.names.delete(key) })
    }
    return found
  }

  async send(chatId: string, message: OutMessage): Promise<string> {
    if (message.buttons === undefined && message.editable !== true) {
      return this.options.api.sendMessage(chatId, 'text', { text: message.text })
    }
    return this.options.api.sendMessage(chatId, 'interactive', card({ plain: message.text }, message.buttons))
  }

  async edit(_chatId: string, messageId: string, message: OutMessage): Promise<void> {
    await this.options.api.patchCard(messageId, card({ plain: message.text }, message.buttons))
  }

  /** A card is replaced whole. */
  async editButtons(chatId: string, messageId: string, message: OutMessage): Promise<void> {
    await this.edit(chatId, messageId, message)
  }

  async sendMarkdown(chatId: string, markdown: string, replaceId?: string): Promise<void> {
    let first = true
    for (const piece of chunkMarkdown(markdown, CARD_TEXT_LIMIT)) {
      const content = card({ markdown: piece })
      if (first && replaceId !== undefined) await this.options.api.patchCard(replaceId, content)
      else await this.options.api.sendMessage(chatId, 'interactive', content)
      first = false
    }
  }

  async sendFile(chatId: string, file: OutFile, caption?: string): Promise<void> {
    if (file.photo && file.data.byteLength <= IMAGE_LIMIT_BYTES) {
      const imageKey = await this.options.api.uploadImage(file.data)
      await this.options.api.sendMessage(chatId, 'image', { image_key: imageKey })
    } else {
      const fileType = FILE_TYPES[extname(file.name).toLowerCase()] ?? 'stream'
      const fileKey = await this.options.api.uploadFile(file.data, file.name, fileType)
      await this.options.api.sendMessage(chatId, 'file', { file_key: fileKey })
    }
    // File messages carry no caption.
    if (caption !== undefined && caption.trim() !== '' && caption.trim() !== file.name) {
      await this.options.api.sendMessage(chatId, 'text', { text: caption })
    }
  }

  async download(attachment: InboundAttachment, limit: number): Promise<Uint8Array> {
    if (attachment.size !== undefined && attachment.size > limit) throw new FileTooLargeError(attachment.size, limit)
    const [type, messageId = '', key = ''] = attachment.ref.split('|')
    return this.options.api.download(messageId, key, type === 'image' ? 'image' : 'file', limit)
  }

  /** Feishu shows no typing indicator for bots. */
  async typing(): Promise<void> {}

  /** Feishu bots have no command menu; `/help` lists the commands. */
  async setMenu(): Promise<void> {}

  async ack(action: InboundAction, notice?: string): Promise<void> {
    this.pendingActions.get(action.id)?.(notice)
  }
}

/** Text and attachments of one message, by message type. */
export function parseContent(type: string, raw: string, messageId: string): {
  text?: string
  attachments: InboundAttachment[]
  voice?: InboundAttachment
} {
  let content: Record<string, unknown>
  try {
    content = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { attachments: [] }
  }
  const short = messageId.slice(-8)
  const image = (key: string): InboundAttachment => ({ ref: `image|${messageId}|${key}`, name: `image_${short}.png`, mediaType: 'image/png' })
  switch (type) {
    case 'text':
      return { ...(typeof content['text'] === 'string' ? { text: content['text'] } : {}), attachments: [] }
    case 'image':
      return { attachments: typeof content['image_key'] === 'string' ? [image(content['image_key'])] : [] }
    case 'file': {
      const key = content['file_key']
      const name = typeof content['file_name'] === 'string' ? safeName(content['file_name']) : `file_${short}`
      return { attachments: typeof key === 'string' ? [{ ref: `file|${messageId}|${key}`, name }] : [] }
    }
    case 'audio': {
      const key = content['file_key']
      if (typeof key !== 'string') return { attachments: [] }
      const voice: InboundAttachment = { ref: `file|${messageId}|${key}`, name: `voice_${short}.opus`, mediaType: 'audio/ogg' }
      return { attachments: [voice], voice }
    }
    case 'media': {
      const key = content['file_key']
      const name = typeof content['file_name'] === 'string' ? safeName(content['file_name']) : `video_${short}.mp4`
      return { attachments: typeof key === 'string' ? [{ ref: `file|${messageId}|${key}`, name, mediaType: 'video/mp4' }] : [] }
    }
    case 'post':
      return parsePost(content, image)
    default:
      return { attachments: [] }
  }
}

/** A rich-text post: paragraphs of text runs, links, mentions, images, and code blocks. */
function parsePost(content: Record<string, unknown>, image: (key: string) => InboundAttachment): { text?: string; attachments: InboundAttachment[] } {
  // Received posts are flat; posts written per locale nest under the locale.
  const body = (Array.isArray(content['content']) ? content : Object.values(content).find(v => typeof v === 'object' && v !== null && Array.isArray((v as Record<string, unknown>)['content']))) as
    { title?: string; content?: unknown[][] } | undefined
  const lines: string[] = []
  const attachments: InboundAttachment[] = []
  if (typeof body?.title === 'string' && body.title.trim() !== '') lines.push(body.title.trim())
  for (const paragraph of body?.content ?? []) {
    let line = ''
    for (const element of Array.isArray(paragraph) ? paragraph as Record<string, unknown>[] : []) {
      const tag = element['tag']
      if (tag === 'text' || tag === 'md') line += String(element['text'] ?? '')
      else if (tag === 'a') line += `${String(element['text'] ?? '')} (${String(element['href'] ?? '')})`
      else if (tag === 'at') line += element['user_name'] === undefined ? String(element['user_id'] ?? '') : `@${String(element['user_name'])}`
      else if (tag === 'code_block') line += `\n\`\`\`${String(element['language'] ?? '').toLowerCase()}\n${String(element['text'] ?? '')}\n\`\`\`\n`
      else if (tag === 'img' && typeof element['image_key'] === 'string') attachments.push(image(element['image_key']))
    }
    lines.push(line)
  }
  const text = lines.join('\n').trim()
  return { ...(text === '' ? {} : { text }), attachments }
}

/** A card 2.0 with one text element and optional button rows; editable by every recipient. */
export function card(body: { plain: string } | { markdown: string }, buttons?: readonly (readonly Button[])[]): object {
  const elements: object[] = ['markdown' in body
    ? { tag: 'markdown', content: body.markdown }
    : { tag: 'div', text: { tag: 'plain_text', content: body.plain } }]
  for (const row of buttons ?? []) {
    elements.push({
      tag: 'column_set',
      columns: row.map((button, index) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: button.text.slice(0, 60) },
          type: row.length > 1 && index === 0 ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: { d: button.data } }],
        }],
      })),
    })
  }
  return { schema: '2.0', config: { update_multi: true }, body: { elements } }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
