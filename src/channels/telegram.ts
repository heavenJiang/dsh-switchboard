/**
 * Telegram line: long-polls the Bot API, groups albums into one message, and
 * sends Markdown as Telegram HTML with a plain-text fallback.
 */

import type { LineSettings } from '../lines.ts'
import { chunkMarkdown, markdownToTelegramHtml } from '../markdown.ts'
import { incomingAttachments } from '../media.ts'
import { TelegramApiError, TelegramClient, type TgCallbackQuery, type TgChat, type TgInlineButton, type TgMessage, type TgUpdate, type TgUser } from '../telegram.ts'
import { chunkText } from '../text.ts'
import {
  FileTooLargeError, sleep,
  type Button, type Channel, type ChannelChat, type ChannelSink, type ChannelUser, type InboundAction,
  type InboundAttachment, type InboundMessage, type OutFile, type OutMessage, type SentMarkdown,
} from './types.ts'

/** Where a Telegram line keeps its getUpdates position. */
export interface UpdateCursor {
  get(): number
  set(offset: number): Promise<void>
}

export interface TelegramChannelOptions {
  readonly cursor: UpdateCursor
  readonly logger: { warn(message: string): void }
  /** Fetch implementation; tests substitute it. */
  readonly fetch?: typeof fetch
}

const MAX_BACKOFF_MS = 60_000
/** How long to wait for the rest of an album before delivering it. */
const MEDIA_GROUP_WAIT_MS = 1500
/** Telegram's document upload ceiling for bots. */
const SEND_LIMIT_BYTES = 50 * 1024 * 1024

export class TelegramChannel implements Channel {
  readonly sendLimitBytes = SEND_LIMIT_BYTES
  private readonly client: TelegramClient
  private me: TgUser | undefined
  private readonly albums = new Map<string, { messages: TgMessage[]; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly line: LineSettings, private readonly options: TelegramChannelOptions) {
    this.client = new TelegramClient({
      token: line.secret ?? '',
      apiBaseUrl: line.apiBaseUrl ?? 'https://api.telegram.org',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }

  get username(): string | undefined {
    return this.me?.username
  }

  async run(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    let connected = false
    sink.state({ kind: 'connecting' })
    try {
      while (!signal.aborted) {
        try {
          if (!connected) {
            this.me = await this.client.getMe(signal)
            connected = true
            sink.state({ kind: 'running', username: this.me.username ?? String(this.me.id) })
          }
          const updates = await this.client.getUpdates(this.options.cursor.get(), this.line.pollTimeoutSec ?? 30, signal)
          backoff = 1000
          for (const update of updates) {
            // Advance first: an update that crashes the handler is not replayed forever.
            await this.options.cursor.set(update.update_id + 1)
            await this.dispatch(update, sink).catch((error: unknown) => {
              this.options.logger.warn(`update ${update.update_id} failed: ${describe(error)}`)
            })
          }
        } catch (error: unknown) {
          if (signal.aborted) break
          if (error instanceof TelegramApiError && error.code === 401) {
            sink.state({ kind: 'error', message: 'bot token rejected (401)' })
            this.options.logger.warn('bot token rejected; fix it on the plugin page')
            return
          }
          connected = false
          sink.state({ kind: 'error', message: describe(error) })
          this.options.logger.warn(`polling failed, retrying in ${backoff / 1000}s: ${describe(error)}`)
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
          if (!signal.aborted) sink.state({ kind: 'connecting' })
        }
      }
    } finally {
      for (const album of this.albums.values()) clearTimeout(album.timer)
      this.albums.clear()
    }
  }

  private async dispatch(update: TgUpdate, sink: ChannelSink): Promise<void> {
    if (update.callback_query !== undefined) return sink.action(this.action(update.callback_query))
    const message = update.message
    if (message === undefined || message.from === undefined || message.from.is_bot) return
    if (message.media_group_id === undefined) return sink.message(this.inbound([message]))
    // Album items arrive as separate updates; deliver them together once no more arrive.
    const key = `${message.chat.id}:${message.media_group_id}`
    const album = this.albums.get(key) ?? { messages: [], timer: undefined as unknown as ReturnType<typeof setTimeout> }
    clearTimeout(album.timer)
    album.messages.push(message)
    album.timer = setTimeout(() => {
      this.albums.delete(key)
      void sink.message(this.inbound(album.messages)).catch((error: unknown) => {
        this.options.logger.warn(`album failed: ${describe(error)}`)
      })
    }, MEDIA_GROUP_WAIT_MS)
    this.albums.set(key, album)
  }

  /** One inbound message from a message or an album. */
  private inbound(messages: readonly TgMessage[]): InboundMessage {
    const first = messages[0]!
    const from = first.from!
    const texts = messages.map(m => (m.text ?? m.caption ?? '').trim()).filter(text => text !== '')
    const { text, addressed } = this.address(first, texts.length === 0 ? undefined : texts.join('\n\n'))
    const attachments: InboundAttachment[] = messages.flatMap(incomingAttachments).map(a => ({
      ref: a.fileId, name: a.name,
      ...(a.mediaType === undefined ? {} : { mediaType: a.mediaType }),
      ...(a.size === undefined ? {} : { size: a.size }),
    }))
    const voice = first.voice
    return {
      chat: chat(first.chat, from),
      from: user(from),
      messageId: String(first.message_id),
      ...(text === undefined ? {} : { text }),
      addressed,
      attachments,
      ...(voice === undefined || messages.length > 1 ? {} : {
        voice: { ref: voice.file_id, name: `voice_${first.message_id}.ogg`, mediaType: 'audio/ogg', ...(voice.file_size === undefined ? {} : { size: voice.file_size }) },
      }),
    }
  }

  /** Strip the bot's @mention; in groups, report whether the message was meant for the bot. */
  private address(message: TgMessage, text: string | undefined): { text: string | undefined; addressed: boolean } {
    const bot = this.me?.username?.toLowerCase()
    const mention = bot === undefined ? undefined : new RegExp(`@${bot}\\b`, 'iu')
    const isCommand = text?.trimStart().startsWith('/') === true
    const mentioned = !isCommand && text !== undefined && mention?.test(text) === true
    const stripped = mentioned ? text.replace(mention!, '').trim() : text
    if (message.chat.type === 'private') return { text: stripped, addressed: true }
    const repliedTo = message.reply_to_message?.from
    const reply = repliedTo?.is_bot === true && repliedTo.username?.toLowerCase() === bot
    return { text: stripped, addressed: mentioned || reply }
  }

  private action(query: TgCallbackQuery): InboundAction {
    return {
      id: query.id,
      from: user(query.from),
      data: query.data ?? '',
      ...(query.message === undefined ? {} : { chat: chat(query.message.chat, query.from), messageId: String(query.message.message_id) }),
    }
  }

  async send(chatId: string, message: OutMessage): Promise<string> {
    const sent = await this.client.sendMessage(Number(chatId), message.text, message.buttons === undefined ? {} : { buttons: keyboard(message.buttons) })
    return String(sent.message_id)
  }

  async edit(chatId: string, messageId: string, message: OutMessage): Promise<void> {
    await this.client.call('editMessageText', {
      chat_id: Number(chatId), message_id: Number(messageId), text: message.text,
      link_preview_options: { is_disabled: true },
      ...(message.buttons === undefined ? {} : { reply_markup: { inline_keyboard: keyboard(message.buttons) } }),
    })
  }

  async editButtons(chatId: string, messageId: string, message: OutMessage): Promise<void> {
    await this.client.call('editMessageReplyMarkup', {
      chat_id: Number(chatId), message_id: Number(messageId), reply_markup: { inline_keyboard: keyboard(message.buttons ?? []) },
    })
  }

  async sendMarkdown(chatId: string, markdown: string, replaceId?: string): Promise<SentMarkdown | undefined> {
    const chat = Number(chatId)
    let first = true
    let last: SentMarkdown | undefined
    for (const piece of chunkMarkdown(markdown)) {
      const html = markdownToTelegramHtml(piece)
      const target = first && replaceId !== undefined ? Number(replaceId) : undefined
      first = false
      try {
        if (target === undefined) last = { messageId: String((await this.client.sendMessage(chat, html, { parseMode: 'HTML' })).message_id), markdown: piece }
        else {
          await this.client.editMessageText(chat, target, html, 'HTML')
          last = { messageId: String(target), markdown: piece }
        }
      } catch (error: unknown) {
        if (!(error instanceof TelegramApiError) || error.code !== 400) throw error
        if (/not modified/iu.test(error.description)) {
          if (target !== undefined) last = { messageId: String(target), markdown: piece }
          continue
        }
        // Telegram rejected the markup: send the piece as plain text.
        for (const plain of chunkText(piece)) {
          if (target === undefined) last = { messageId: String((await this.client.sendMessage(chat, plain)).message_id), markdown: plain }
          else {
            last = await this.client.editMessageText(chat, target, plain).then(
              () => ({ messageId: String(target), markdown: plain }),
              async () => ({ messageId: String((await this.client.sendMessage(chat, plain)).message_id), markdown: plain }),
            )
          }
        }
      }
    }
    return last
  }

  async addButtons(chatId: string, sent: SentMarkdown, buttons: readonly (readonly Button[])[]): Promise<void> {
    await this.client.call('editMessageReplyMarkup', {
      chat_id: Number(chatId), message_id: Number(sent.messageId), reply_markup: { inline_keyboard: keyboard(buttons) },
    })
  }

  /** 👀 while working, cleared when done, 👎 on failure (emoji from the Bot API's reaction set). */
  async react(chatId: string, messageId: string, state: 'working' | 'done' | 'failed'): Promise<unknown> {
    const emoji = state === 'working' ? '👀' : state === 'failed' ? '👎' : undefined
    await this.client.call('setMessageReaction', {
      chat_id: Number(chatId), message_id: Number(messageId), reaction: emoji === undefined ? [] : [{ type: 'emoji', emoji }],
    })
    return undefined
  }

  async sendFile(chatId: string, file: OutFile, caption?: string): Promise<void> {
    await this.client.sendFile(file.photo ? 'photo' : 'document', Number(chatId), { data: file.data, name: file.name }, caption?.slice(0, 1024))
  }

  async download(attachment: InboundAttachment, limit: number): Promise<Uint8Array> {
    if (attachment.size !== undefined && attachment.size > limit) throw new FileTooLargeError(attachment.size, limit)
    const file = await this.client.getFile(attachment.ref)
    // The public Bot API omits file_path for files over 20 MB.
    if (file.file_path === undefined) throw new FileTooLargeError(file.file_size ?? limit + 1, limit)
    return this.client.downloadFile(file.file_path, limit)
  }

  async typing(chatId: string): Promise<void> {
    await this.client.sendTyping(Number(chatId))
  }

  async setMenu(commands: readonly { command: string; description: string }[]): Promise<void> {
    await this.client.setMyCommands(commands)
  }

  async ack(action: InboundAction, notice?: string): Promise<void> {
    await this.client.answerCallbackQuery(action.id, notice)
  }
}

function keyboard(rows: readonly (readonly Button[])[]): TgInlineButton[][] {
  return rows.map(row => row.map(button => ({ text: button.text.slice(0, 60), callback_data: button.data })))
}

function chat(source: TgChat, from: TgUser): ChannelChat {
  const username = source.username ?? (source.type === 'private' ? from.username : undefined)
  return {
    id: String(source.id),
    type: source.type === 'private' ? 'private' : 'group',
    title: source.title ?? displayName(from),
    ...(username === undefined ? {} : { username }),
  }
}

function user(source: TgUser): ChannelUser {
  return { id: String(source.id), name: displayName(source), ...(source.username === undefined ? {} : { username: source.username }) }
}

function displayName(source: TgUser): string {
  return [source.first_name, source.last_name].filter(Boolean).join(' ') || (source.username ?? String(source.id))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
