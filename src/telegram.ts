/**
 * Minimal Telegram Bot API client: the handful of methods the bridge uses,
 * over Node's built-in fetch so the launcher's proxy policy applies.
 */

import { FileTooLargeError } from './channels/types.ts'

/** Telegram user as the Bot API reports it. */
export interface TgUser {
  readonly id: number
  readonly is_bot: boolean
  readonly first_name: string
  readonly last_name?: string
  readonly username?: string
}

/** Telegram chat as the Bot API reports it. */
export interface TgChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
  readonly username?: string
}

/** Fields every downloadable Telegram media object carries. */
export interface TgFileBase {
  readonly file_id: string
  readonly file_unique_id: string
  readonly file_size?: number
}

/** One size of a photo; Telegram sends several, largest last. */
export interface TgPhotoSize extends TgFileBase {
  readonly width: number
  readonly height: number
}

/** A document, video, audio, voice, animation, or video note. */
export interface TgMediaFile extends TgFileBase {
  readonly file_name?: string
  readonly mime_type?: string
}

/** One incoming message; only the fields the bridge reads. */
export interface TgMessage {
  readonly message_id: number
  readonly from?: TgUser
  readonly chat: TgChat
  readonly date: number
  readonly text?: string
  readonly caption?: string
  /** Shared by the messages of one album. */
  readonly media_group_id?: string
  /** The message this one replies to. */
  readonly reply_to_message?: TgMessage
  /** Mentions, commands, and other marked spans in `text`. */
  readonly entities?: readonly TgEntity[]
  readonly caption_entities?: readonly TgEntity[]
  readonly photo?: readonly TgPhotoSize[]
  readonly document?: TgMediaFile
  readonly video?: TgMediaFile
  readonly audio?: TgMediaFile
  readonly voice?: TgMediaFile
  readonly animation?: TgMediaFile
  readonly video_note?: TgMediaFile
  readonly sticker?: TgFileBase & { readonly is_animated?: boolean; readonly is_video?: boolean }
}

/** One marked span of message text (UTF-16 offsets). */
export interface TgEntity {
  readonly type: string
  readonly offset: number
  readonly length: number
  readonly user?: TgUser
}

/** getFile result. */
export interface TgFile extends TgFileBase {
  /** Download path under `/file/bot<token>/`; absent when the file is too big for the Bot API. */
  readonly file_path?: string
}

/** Inline keyboard button press. */
export interface TgCallbackQuery {
  readonly id: string
  readonly from: TgUser
  readonly message?: TgMessage
  readonly data?: string
}

/** One getUpdates entry. */
export interface TgUpdate {
  readonly update_id: number
  readonly message?: TgMessage
  readonly callback_query?: TgCallbackQuery
}

/** One inline keyboard button. */
export interface TgInlineButton {
  readonly text: string
  readonly callback_data: string
}

/** Bot API failure carrying Telegram's error code and description. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    /** Seconds Telegram asked to wait (429). */
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method} failed (${code}): ${description}`)
    this.name = 'TelegramApiError'
  }
}

export { FileTooLargeError }

/** Transport options for {@link TelegramClient}. */
export interface TelegramClientOptions {
  /** Bot token from @BotFather. */
  readonly token: string
  /** Bot API root, without trailing slash; a self-hosted Bot API server or reverse proxy may replace the default. */
  readonly apiBaseUrl: string
  /** Fetch implementation; tests substitute it. */
  readonly fetch?: typeof fetch
  /** Waits between 429 retries; tests substitute it. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Rate-limit retries per call; Telegram's flood control asks for seconds at most in practice. */
const MAX_RATE_RETRIES = 3
const MAX_RETRY_AFTER_S = 60

/** Formatting for outgoing text. */
export interface SendOptions {
  /** `HTML` for text produced by markdownToTelegramHtml. */
  readonly parseMode?: 'HTML'
  readonly buttons?: readonly (readonly TgInlineButton[])[]
}

/** Thin, typed wrapper over the Bot API's JSON methods. */
export class TelegramClient {
  private readonly root: string
  private readonly fetchImpl: typeof fetch

  private readonly fileRoot: string

  constructor(options: TelegramClientOptions) {
    const base = options.apiBaseUrl.replace(/\/+$/u, '')
    this.root = `${base}/bot${options.token}`
    this.fileRoot = `${base}/file/bot${options.token}`
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private readonly sleep: (ms: number) => Promise<void>

  /**
   * Call one Bot API method.
   * @param method - Bot API method name.
   * @param params - JSON parameters.
   * @param signal - aborts the HTTP request.
   * @returns the method's `result` field.
   * @throws TelegramApiError when Telegram answers `ok: false`.
   */
  async call<T>(method: string, params: object | FormData = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce<T>(method, params, signal)
      } catch (error: unknown) {
        // Flood control: wait as asked, then retry. Long polls never hit it.
        if (!(error instanceof TelegramApiError) || error.code !== 429 || attempt >= MAX_RATE_RETRIES || signal?.aborted === true) throw error
        await this.sleep(Math.min(error.retryAfter ?? 1, MAX_RETRY_AFTER_S) * 1000)
      }
    }
  }

  private async callOnce<T>(method: string, params: object | FormData, signal?: AbortSignal): Promise<T> {
    const isForm = params instanceof FormData
    const response = await this.fetchImpl(`${this.root}/${method}`, {
      method: 'POST',
      ...(isForm ? { body: params } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
      ...(signal === undefined ? {} : { signal }),
    })
    let body: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
    try {
      body = await response.json() as typeof body
    } catch {
      throw new TelegramApiError(method, response.status, `non-JSON response (HTTP ${response.status})`)
    }
    if (body.ok !== true) {
      throw new TelegramApiError(method, body.error_code ?? response.status, body.description ?? 'unknown error', body.parameters?.retry_after)
    }
    return body.result as T
  }

  /** @returns the bot's own user. */
  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call('getMe', {}, signal)
  }

  /**
   * Long-poll for updates.
   * @param offset - first update id to return.
   * @param timeoutSec - long-poll wait on Telegram's side.
   * @param signal - aborts the poll.
   */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }, signal)
  }

  /**
   * Send one plain-text message.
   * @param chatId - destination chat.
   * @param text - at most 4096 characters.
   * @param buttons - optional inline keyboard rows.
   * @returns the sent message.
   */
  sendMessage(chatId: number, text: string, options: SendOptions | readonly (readonly TgInlineButton[])[] = {}): Promise<TgMessage> {
    const { parseMode, buttons }: SendOptions = Array.isArray(options) ? { buttons: options as SendOptions['buttons'] & object } : options as SendOptions
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      ...(buttons === undefined ? {} : { reply_markup: { inline_keyboard: buttons } }),
    })
  }

  /** Resolve a file id to its download path. */
  getFile(fileId: string): Promise<TgFile> {
    return this.call('getFile', { file_id: fileId })
  }

  /**
   * Download a file the Bot API resolved.
   * @param filePath - `file_path` from {@link getFile}.
   * @param maxBytes - refuse larger downloads before or while reading.
   * @param signal - aborts the download.
   * @returns the file's bytes.
   */
  async downloadFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.fileRoot}/${filePath}`, signal === undefined ? {} : { signal })
    if (!response.ok || response.body === null) {
      throw new TelegramApiError('downloadFile', response.status, `HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel()
      throw new FileTooLargeError(declared, maxBytes)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > maxBytes) throw new FileTooLargeError(total, maxBytes)
      chunks.push(chunk)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  /**
   * Upload one file to a chat.
   * @param kind - `photo` shows inline (images up to 10 MB); `document` keeps the file as is (up to 50 MB).
   * @param chatId - destination chat.
   * @param file - bytes and file name.
   * @param caption - optional caption (at most 1024 characters).
   */
  sendFile(kind: 'photo' | 'document', chatId: number, file: { data: Uint8Array; name: string }, caption?: string): Promise<TgMessage> {
    const form = new FormData()
    form.set('chat_id', String(chatId))
    if (caption !== undefined && caption !== '') form.set('caption', caption)
    form.set(kind, new Blob([file.data as Uint8Array<ArrayBuffer>]), file.name)
    return this.call(kind === 'photo' ? 'sendPhoto' : 'sendDocument', form)
  }

  /** Replace a sent message's text and drop its inline keyboard. */
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: 'HTML'): Promise<unknown> {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      link_preview_options: { is_disabled: true },
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
    })
  }

  /** Delete a message the bot sent. */
  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  /** Acknowledge an inline keyboard press so the client stops its spinner. */
  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text === undefined ? {} : { text }) })
  }

  /** Show "typing…" for about five seconds. */
  sendTyping(chatId: number): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' })
  }

  /** Register the bot's slash-command menu. */
  setMyCommands(commands: readonly { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands })
  }
}
