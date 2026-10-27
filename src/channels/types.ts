/**
 * What the bridge needs from a chat platform. Each adapter turns its
 * platform's updates into these inbound shapes and renders these outbound
 * messages its own way; the bridge never sees platform types.
 */

import type { LineSettings } from '../lines.ts'

/** A person on a chat platform. */
export interface ChannelUser {
  readonly id: string
  readonly name: string
  readonly username?: string
  /** Other ids the same person is known by (Feishu user_id and union_id), also matched by the allow-list. */
  readonly aliases?: readonly string[]
}

/** A conversation, by the platform's own id. */
export interface ChannelChat {
  readonly id: string
  readonly type: 'private' | 'group'
  readonly title?: string
  readonly username?: string
}

/** One downloadable attachment; `ref` means something only to its adapter. */
export interface InboundAttachment {
  readonly ref: string
  readonly name: string
  /** Declared MIME type, when the platform reports or implies one. */
  readonly mediaType?: string
  /** Declared size in bytes, when known; checked before downloading. */
  readonly size?: number
}

/** A message from a person, after the adapter grouped albums and stripped the bot's @mention. */
export interface InboundMessage {
  readonly chat: ChannelChat
  readonly from: ChannelUser
  readonly messageId: string
  /** Text or captions; undefined when the message has none. */
  readonly text?: string
  /** In a group, whether the message @mentions or replies to the bot; true in private chats. */
  readonly addressed: boolean
  readonly attachments: readonly InboundAttachment[]
  /** A voice note to transcribe; also listed in `attachments`, which carry it when transcription fails. */
  readonly voice?: InboundAttachment
}

/** A button press. */
export interface InboundAction {
  /** Adapter handle for {@link Channel.ack}. */
  readonly id: string
  readonly chat?: ChannelChat
  readonly from: ChannelUser
  readonly data: string
  readonly messageId?: string
}

/** One button; `data` comes back in {@link InboundAction.data} (at most 64 bytes). */
export interface Button {
  readonly text: string
  readonly data: string
}

/** Plain text with optional buttons. */
export interface OutMessage {
  readonly text: string
  readonly buttons?: readonly (readonly Button[])[]
  /** The message will be edited later (drafts, tool activity); some platforms only edit some kinds. */
  readonly editable?: boolean
}

/** Connection state of one line. */
export type LineState =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'running'; readonly username: string }
  | { readonly kind: 'error'; readonly message: string }

/** Where an adapter delivers what it receives. */
export interface ChannelSink {
  state(state: LineState): void
  message(message: InboundMessage): Promise<void>
  action(action: InboundAction): Promise<void>
}

/** The last message a Markdown send produced. */
export interface SentMarkdown {
  readonly messageId: string
  readonly markdown: string
}

/** A file to send. */
export interface OutFile {
  readonly data: Uint8Array
  readonly name: string
  /** Show inline as a picture rather than as a file. */
  readonly photo: boolean
}

/** One connected line. Chat ids are the platform's own. */
export interface Channel {
  /** The bot's handle for `/cmd@bot`, once connected. */
  readonly username: string | undefined
  /** Largest file the platform accepts from a bot. */
  readonly sendLimitBytes: number
  /** Receive until `signal` aborts or the credentials are rejected. */
  run(sink: ChannelSink, signal: AbortSignal): Promise<void>
  /** @returns the sent message's id. */
  send(chat: string, message: OutMessage): Promise<string>
  /** Replace an editable message's text and buttons (no buttons removes them). */
  edit(chat: string, messageId: string, message: OutMessage): Promise<void>
  /** Replace only the buttons of a message sent with buttons; `message.text` is its unchanged text. */
  editButtons(chat: string, messageId: string, message: OutMessage): Promise<void>
  /**
   * Send Markdown rendered for the platform, split to size.
   * @param replaceId - an editable message to turn into the first piece.
   * @returns the last piece's message and its Markdown, for {@link addButtons}.
   */
  sendMarkdown(chat: string, markdown: string, replaceId?: string): Promise<SentMarkdown | undefined>
  /** Put buttons under a message sent with {@link sendMarkdown} (none removes them). */
  addButtons(chat: string, sent: SentMarkdown, buttons: readonly (readonly Button[])[]): Promise<void>
  /**
   * Mark a person's message as being worked on, done, or failed, where the platform has reactions.
   * @param previous - the handle `working` returned, which `done` and `failed` replace.
   * @returns a handle for the next state.
   */
  react(chat: string, messageId: string, state: 'working' | 'done' | 'failed', previous?: unknown): Promise<unknown>
  sendFile(chat: string, file: OutFile, caption?: string): Promise<void>
  download(attachment: InboundAttachment, limit: number): Promise<Uint8Array>
  /** Show that the bot is working, where the platform can. */
  typing(chat: string): Promise<void>
  /** Publish the command menu, where the platform has one. */
  setMenu(commands: readonly { command: string; description: string }[]): Promise<void>
  /** Acknowledge a button press, optionally with a short notice. */
  ack(action: InboundAction, notice?: string): Promise<void>
}

/** Builds the adapter for a line. */
export type ChannelFactory = (line: LineSettings) => Channel

/** A download over the configured size limit. */
export class FileTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`file is ${(size / 1048576).toFixed(1)} MB, over the ${(limit / 1048576).toFixed(0)} MB limit`)
    this.name = 'FileTooLargeError'
  }
}

/** Credentials the platform refused; the line stops until they change. */
export class CredentialsRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsRejectedError'
  }
}

/** Read a byte stream, refusing more than `limit` bytes. */
export async function readLimited(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > limit) throw new FileTooLargeError(total, limit)
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

/** Wait, waking early when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Socket errors raised before a request leaves this machine. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET_CONNECT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * Whether a failed send certainly did not reach the platform, so sending it
 * again cannot duplicate it: the connection never opened, the platform's
 * gateway answered that it is unavailable, or flood control outlasted the
 * client's retries. Anything else (a reset mid-request, a timeout) is
 * treated as possibly delivered.
 */
export function undelivered(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause !== undefined && cause !== null && depth < 4; depth++) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && CONNECT_CODES.has(code)) return true
    if ((cause as { name?: unknown }).name === 'TelegramApiError' && typeof code === 'number') {
      return code === 429 || code === 502 || code === 503 || code === 504
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}
