/**
 * Telegram ⇄ Harness bridge core: long-polls the Bot API, turns messages and
 * commands into Session operations, mirrors committed assistant output back
 * to the bound chats, and asks tool approvals with inline buttons. Photos and
 * files sent to the bot are staged into the Session as prompt attachments;
 * files the Agent presents are sent back.
 *
 * Harness access goes through {@link HarnessPort}, so this module does not
 * touch Cordis and can be exercised with a fake.
 */

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { BindingStore } from './bindings.ts'
import type { ChatAttachment, ChatEntry, ChatInfo, ChatLog } from './chatlog.ts'
import { incomingAttachments, outgoingKind, promptImageType, sniffImageType, type IncomingAttachment } from './media.ts'
import { MESSAGES, type BotLanguage, type Messages } from './messages.ts'
import {
  FileTooLargeError, TelegramApiError, TelegramClient, type TgCallbackQuery, type TgChat, type TgMessage, type TgUpdate, type TgUser,
} from './telegram.ts'
import { chunkText, isAllowed, parseInput, previewArguments } from './text.ts'

/** Live settings the bridge reads at the start of each operation. */
export interface BridgeSettings {
  readonly enabled: boolean
  readonly botToken: string | undefined
  readonly apiBaseUrl: string
  readonly allowedUsers: readonly string[]
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly approvalViaTelegram: boolean
  readonly approvalTimeoutSec: number
  readonly notifyToolCalls: boolean
  readonly language: BotLanguage
  readonly pollTimeoutSec: number
  /** Largest file accepted from Telegram, in MB (the public Bot API serves at most 20). */
  readonly maxDownloadMb: number
  /** Send files the Agent presents back to the chat. */
  readonly sendDeliverables: boolean
}

/** One part of a prompt: text, or an attachment staged with {@link HarnessPort.stageFile}. */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly receiptId: string }

/** Bytes to stage into a Session. */
export interface StagedFileInput {
  readonly data: Uint8Array
  readonly name: string
  /** Set to send through the image channel, where the model sees the picture. */
  readonly imageType?: string
}

/** One Session row for `/sessions`. */
export interface SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
}

/** What the bridge needs from the Harness. */
export interface HarnessPort {
  /** Create a Session in `cwd` and return its id. */
  createSession(cwd: string, agentPreset: string, permissionPreset: string): Promise<string>
  /** Queue (or steer) one prompt into a Session, resuming it when cold. */
  prompt(sessionId: string, parts: readonly PromptPart[], mode: 'queue' | 'steer'): Promise<void>
  /**
   * Store bytes for a Session and return a receipt a later prompt cites.
   * An image the deployment does not accept as a prompt image falls back to a plain file.
   */
  stageFile(sessionId: string, file: StagedFileInput): Promise<string>
  /** Cancel a live Session's work; false when it is not live. */
  cancel(sessionId: string): boolean
  /** Live state of a Session, or undefined when it is not loaded. */
  live(sessionId: string): { running: boolean; cwd?: string } | undefined
  /** Recent root Sessions, newest first. */
  listSessions(): Promise<SessionRow[]>
}

/** Minimal logger face. */
export interface BridgeLogger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/** Approval answer from Telegram, or a hand-back to the next answerer. */
export type TelegramApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'delegate'

/** One question waiting on an inline button. */
interface PendingApproval {
  readonly sessionId: string
  readonly prompts: { chatId: number; messageId: number }[]
  settle(outcome: TelegramApprovalOutcome, note: string, by?: string): void
}

/** How a bot message is labelled in the chat history. */
type OutKind = 'assistant' | 'tool' | 'notice'

/** Images up to this size are copied into the history for the viewer. */
const VIEWER_IMAGE_LIMIT = 5 * 1024 * 1024
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
}

/** Per-chat output state for one Session's current activity. */
interface ChatActivity {
  typing?: ReturnType<typeof setInterval>
}

/** Observable connection state for `/status` and logs. */
export type BridgeState =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'running'; readonly username: string }
  | { readonly kind: 'error'; readonly message: string }

const TYPING_INTERVAL_MS = 4500
const MAX_BACKOFF_MS = 60_000
const TOOL_PREVIEW_LENGTH = 300
/** How long to wait for the rest of an album before prompting with it. */
const MEDIA_GROUP_WAIT_MS = 1500
/** Telegram's document upload ceiling for bots. */
const SEND_LIMIT_BYTES = 50 * 1024 * 1024

/** The bridge core. One instance lives for the plugin's lifetime; polling restarts on token changes. */
export class TelegramBridge {
  state: BridgeState = { kind: 'stopped' }
  private client: TelegramClient | undefined
  private poll: { controller: AbortController; done: Promise<void>; key: string } | undefined
  private botUsername: string | undefined
  private readonly sendTails = new Map<number, Promise<void>>()
  private readonly activity = new Map<string, ChatActivity>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  private readonly albums = new Map<string, { chatId: number; messages: TgMessage[]; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly settings: () => BridgeSettings,
    private readonly harness: HarnessPort,
    private readonly store: BindingStore,
    private readonly logger: BridgeLogger,
    private readonly fetchImpl?: typeof fetch,
    private readonly chatLog?: ChatLog,
  ) {}

  /** @returns the bot's username while connected. */
  get username(): string | undefined {
    return this.state.kind === 'running' ? this.state.username : undefined
  }

  /** Append to the Web viewer's history; failures are logged, never surfaced to Telegram. */
  private log(chat: ChatInfo, entry: Omit<ChatEntry, 'id' | 'at' | 'sessionId'>): void {
    if (this.chatLog === undefined) return
    const sessionId = this.store.get(chat.chatId).sessionId
    void this.chatLog.record(chat, { ...entry, ...(sessionId === undefined ? {} : { sessionId }) }).catch((error: unknown) => {
      this.logger.warn(`telegram-bridge: chat history write failed: ${describe(error)}`)
    })
  }

  private get t(): Messages {
    return MESSAGES[this.settings().language]
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  /** Start, stop, or restart polling so it matches the current settings. */
  async reconcile(): Promise<void> {
    const s = this.settings()
    const token = s.botToken?.trim() ?? ''
    const key = s.enabled && token !== '' ? `${s.apiBaseUrl}\n${token}` : ''
    if (this.poll?.key === key) return
    await this.stop()
    if (key === '') {
      this.state = { kind: 'stopped' }
      return
    }
    this.client = new TelegramClient({
      token,
      apiBaseUrl: s.apiBaseUrl,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    })
    const controller = new AbortController()
    const done = this.run(this.client, controller.signal)
    this.poll = { controller, done, key }
  }

  /** Stop polling, withdraw pending approvals, and stop typing indicators. */
  async stop(): Promise<void> {
    const poll = this.poll
    this.poll = undefined
    if (poll !== undefined) {
      poll.controller.abort()
      await poll.done
    }
    for (const approval of this.approvals.values()) approval.settle('delegate', this.t.approvalCancelled)
    for (const album of this.albums.values()) clearTimeout(album.timer)
    this.albums.clear()
    for (const activity of this.activity.values()) clearInterval(activity.typing)
    this.activity.clear()
    await Promise.allSettled([...this.sendTails.values()])
    this.client = undefined
    this.state = { kind: 'stopped' }
  }

  /** The long-poll loop; returns once `signal` aborts or the token is rejected. */
  private async run(client: TelegramClient, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    this.state = { kind: 'connecting' }
    while (!signal.aborted) {
      try {
        if (this.state.kind !== 'running') {
          const me = await client.getMe(signal)
          this.botUsername = me.username
          this.state = { kind: 'running', username: me.username ?? String(me.id) }
          this.logger.info(`telegram-bridge: connected as @${this.state.username}`)
          await this.registerCommands(client)
        }
        const updates = await client.getUpdates(this.store.offset, this.settings().pollTimeoutSec, signal)
        backoff = 1000
        for (const update of updates) {
          // Advance first: an update that crashes the handler is not replayed forever.
          await this.store.setOffset(update.update_id + 1)
          await this.handleUpdate(update).catch((error: unknown) => {
            this.logger.warn(`telegram-bridge: update ${update.update_id} failed: ${describe(error)}`)
          })
        }
      } catch (error: unknown) {
        if (signal.aborted) break
        if (error instanceof TelegramApiError && error.code === 401) {
          this.state = { kind: 'error', message: 'bot token rejected (401)' }
          this.logger.warn('telegram-bridge: bot token rejected; fix it on the plugin page')
          return
        }
        this.state = { kind: 'error', message: describe(error) }
        this.logger.warn(`telegram-bridge: polling failed, retrying in ${backoff / 1000}s: ${describe(error)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        if (!signal.aborted) this.state = { kind: 'connecting' }
      }
    }
  }

  private async registerCommands(client: TelegramClient): Promise<void> {
    const t = this.t
    await client.setMyCommands([
      { command: 'new', description: t.cmdNew },
      { command: 'stop', description: t.cmdStop },
      { command: 'status', description: t.cmdStatus },
      { command: 'help', description: t.cmdHelp },
    ]).catch((error: unknown) => {
      this.logger.debug(`telegram-bridge: setMyCommands failed: ${describe(error)}`)
    })
  }

  // ─── inbound ────────────────────────────────────────────────────────────

  /** Route one update. Exposed for tests. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query !== undefined) return this.handleCallback(update.callback_query)
    if (update.message !== undefined) return this.handleMessage(update.message)
  }

  private async handleMessage(message: TgMessage): Promise<void> {
    const from = message.from
    if (from === undefined || from.is_bot) return
    const chatId = message.chat.id
    const t = this.t
    const text = message.text ?? message.caption
    const parsed = text === undefined ? undefined : parseInput(text, this.botUsername)
    const allowed = isAllowed(this.settings().allowedUsers, from.id, from.username)
    const attachments = incomingAttachments(message)
    const chat = chatInfo(message.chat, from)
    if (!allowed) {
      this.log(chat, {
        dir: 'in', kind: 'denied', from: sender(from),
        ...(text === undefined ? {} : { text }),
        ...(attachments.length === 0 ? {} : { attachments: attachments.map(a => ({ name: a.name, kind: 'file' as const })) }),
      })
    } else if (attachments.length === 0 && text !== undefined) {
      this.log(chat, { dir: 'in', kind: parsed?.kind === 'command' ? 'command' : 'text', from: sender(from), text })
    }
    if (parsed?.kind === 'command' && parsed.name === 'whoami') {
      return this.reply(chatId, t.whoami(from.id, chatId))
    }
    if (!allowed) {
      // Answer strangers only in private chats so a group does not get spammed.
      if (message.chat.type === 'private') await this.reply(chatId, t.unauthorized(from.id))
      return
    }
    if (message.media_group_id !== undefined) return this.collectAlbum(chatId, message)
    try {
      if (attachments.length > 0) return await this.promptWithMedia(chatId, [message])
      if (text === undefined) return await this.reply(chatId, t.unsupported)
      if (parsed === undefined) return
      if (parsed.kind === 'text') return await this.promptFromChat(chatId, [{ type: 'text', text: parsed.text }], 'queue')
      return await this.runCommand(chatId, parsed.name, parsed.args)
    } catch (error: unknown) {
      await this.reply(chatId, t.failed(describe(error)))
    }
  }

  /** Buffer one album item; the album is prompted once no item arrived for a moment. */
  private collectAlbum(chatId: number, message: TgMessage): void {
    const key = `${chatId}:${message.media_group_id}`
    const album = this.albums.get(key) ?? { chatId, messages: [], timer: undefined as unknown as ReturnType<typeof setTimeout> }
    clearTimeout(album.timer)
    album.messages.push(message)
    album.timer = setTimeout(() => {
      this.albums.delete(key)
      void this.promptWithMedia(chatId, album.messages).catch(async (error: unknown) => {
        await this.reply(chatId, this.t.failed(describe(error)))
      })
    }, MEDIA_GROUP_WAIT_MS)
    this.albums.set(key, album)
  }

  /**
   * Download every attachment of one message or album, stage it into the
   * chat's Session, and prompt with the captions plus the receipts.
   */
  private async promptWithMedia(chatId: number, messages: readonly TgMessage[]): Promise<void> {
    const client = this.client
    if (client === undefined) return
    const t = this.t
    const sessionId = await this.ensureSession(chatId)
    if (sessionId === undefined) return
    const limit = this.settings().maxDownloadMb * 1024 * 1024
    const parts: PromptPart[] = []
    const captions = messages.map(m => (m.caption ?? m.text ?? '').trim()).filter(c => c !== '')
    const logged: ChatAttachment[] = []
    this.startTyping(sessionId)
    for (const attachment of messages.flatMap(incomingAttachments)) {
      try {
        const data = await this.download(client, attachment, limit)
        const imageType = promptImageType(attachment, data)
        const receiptId = await this.harness.stageFile(sessionId, {
          data,
          name: attachment.name,
          ...(imageType === undefined ? {} : { imageType }),
        })
        parts.push({ type: 'file', receiptId })
        logged.push(await this.viewerAttachment(chatId, attachment.name, data, imageType))
      } catch (error: unknown) {
        logged.push({ name: attachment.name, kind: 'file', ...(attachment.size === undefined ? {} : { size: attachment.size }) })
        await this.reply(chatId, t.attachmentFailed(attachment.name, describe(error)))
      }
    }
    const first = messages[0]
    if (first !== undefined && first.from !== undefined) {
      this.log(chatInfo(first.chat, first.from), {
        dir: 'in', kind: 'media', from: sender(first.from), attachments: logged,
        ...(captions.length === 0 ? {} : { text: captions.join('\n\n') }),
      })
    }
    if (parts.length === 0) {
      this.stopTyping(sessionId)
      return
    }
    if (captions.length > 0) parts.unshift({ type: 'text', text: captions.join('\n\n') })
    await this.harness.prompt(sessionId, parts, 'queue')
  }

  /** Describe an attachment for the history, keeping a copy of images the viewer can show. */
  private async viewerAttachment(chatId: number, name: string, data: Uint8Array, imageType?: string): Promise<ChatAttachment> {
    const base = { name, size: data.byteLength }
    if (imageType === undefined || this.chatLog === undefined || data.byteLength > VIEWER_IMAGE_LIMIT) return { ...base, kind: imageType === undefined ? 'file' : 'image' }
    const media = await this.chatLog.saveMedia(chatId, IMAGE_EXTENSIONS[imageType] ?? '', data).catch(() => undefined)
    return { ...base, kind: 'image', ...(media === undefined ? {} : { media }) }
  }

  private async download(client: TelegramClient, attachment: IncomingAttachment, limit: number): Promise<Uint8Array> {
    if (attachment.size !== undefined && attachment.size > limit) throw new FileTooLargeError(attachment.size, limit)
    const file = await client.getFile(attachment.fileId)
    // The public Bot API omits file_path for files over 20 MB.
    if (file.file_path === undefined) throw new FileTooLargeError(file.file_size ?? limit + 1, limit)
    return client.downloadFile(file.file_path, limit)
  }

  private async runCommand(chatId: number, name: string, args: string): Promise<void> {
    const t = this.t
    const binding = this.store.get(chatId)
    switch (name) {
      case 'start':
      case 'help':
        return this.reply(chatId, t.help)
      case 'new': {
        const cwd = args === '' ? this.defaultWorkspace(chatId) : args
        if (cwd === undefined) return this.reply(chatId, t.noWorkspace)
        const sessionId = await this.newSession(chatId, cwd)
        return this.reply(chatId, t.created(sessionId, cwd))
      }
      case 'cwd': {
        if (args === '') return this.reply(chatId, this.defaultWorkspace(chatId) ?? t.noWorkspace)
        if (!(await isDirectory(args))) return this.reply(chatId, t.badWorkspace(args))
        await this.store.update(chatId, { workspacePath: args })
        return this.reply(chatId, t.cwdSet(args))
      }
      case 'use': {
        if (args === '') return this.reply(chatId, t.useUsage)
        await this.store.update(chatId, { sessionId: args })
        await this.chatLog?.bind(chatId, args).catch(() => {})
        return this.reply(chatId, t.bound(args))
      }
      case 'sessions': {
        const rows = (await this.harness.listSessions()).slice(0, 10)
        const lines = rows.map(row => `${row.running ? '▶' : '·'} ${row.sessionId}${row.cwd === undefined ? '' : `  ${row.cwd}`}`)
        return this.reply(chatId, t.sessions(lines))
      }
      case 'stop': {
        if (binding.sessionId === undefined) return this.reply(chatId, t.noSession)
        const live = this.harness.live(binding.sessionId)
        if (live?.running !== true || !this.harness.cancel(binding.sessionId)) return this.reply(chatId, t.notRunning)
        return this.reply(chatId, t.stopped)
      }
      case 'steer': {
        if (args === '') return this.reply(chatId, t.steerUsage)
        return this.promptFromChat(chatId, [{ type: 'text', text: args }], 'steer')
      }
      case 'status': {
        const live = binding.sessionId === undefined ? undefined : this.harness.live(binding.sessionId)
        return this.reply(chatId, t.status({
          bot: this.state.kind === 'running' ? `@${this.state.username}` : this.state.kind,
          ...(binding.sessionId === undefined ? {} : { session: binding.sessionId }),
          ...(live?.cwd === undefined ? {} : { cwd: live.cwd }),
          ...(live === undefined ? {} : { running: live.running }),
        }))
      }
      default:
        // Unknown slash commands go to the Agent verbatim (skills such as /plan are commands there too).
        return this.promptFromChat(chatId, [{ type: 'text', text: `/${name}${args === '' ? '' : ` ${args}`}` }], 'queue')
    }
  }

  private defaultWorkspace(chatId: number): string | undefined {
    const path = this.store.get(chatId).workspacePath ?? this.settings().workspacePath
    return path.trim() === '' ? undefined : path
  }

  private async newSession(chatId: number, cwd: string): Promise<string> {
    if (!(await isDirectory(cwd))) throw new Error(this.t.badWorkspace(cwd))
    const s = this.settings()
    const sessionId = await this.harness.createSession(cwd, s.agentPreset, s.permissionPreset)
    await this.store.update(chatId, { sessionId })
    await this.chatLog?.bind(chatId, sessionId).catch(() => {})
    return sessionId
  }

  /** The chat's Session, creating one in the default directory when it has none. */
  private async ensureSession(chatId: number): Promise<string | undefined> {
    const existing = this.store.get(chatId).sessionId
    if (existing !== undefined) return existing
    const cwd = this.defaultWorkspace(chatId)
    if (cwd === undefined) {
      await this.reply(chatId, this.t.noWorkspace)
      return undefined
    }
    const sessionId = await this.newSession(chatId, cwd)
    await this.reply(chatId, this.t.created(sessionId, cwd))
    return sessionId
  }

  private async promptFromChat(chatId: number, parts: readonly PromptPart[], mode: 'queue' | 'steer'): Promise<void> {
    const sessionId = await this.ensureSession(chatId)
    if (sessionId === undefined) return
    this.startTyping(sessionId)
    await this.harness.prompt(sessionId, parts, mode)
  }

  // ─── outbound: Session events ───────────────────────────────────────────

  /**
   * Mirror one committed Session event to the chats bound to it.
   * @param sessionId - the event's Session.
   * @param event - committed durable event (`type` + `data`).
   * @param cwd - the Session's working directory, which relative presented paths resolve against.
   */
  onSessionEvent(sessionId: string, event: { type: string; data?: unknown }, cwd?: string): void {
    if (this.client === undefined) return
    const chats = this.store.chatsFor(sessionId)
    if (chats.length === 0) return
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data)
      if (text !== '') for (const chatId of chats) void this.reply(chatId, text, 'assistant')
    } else if (event.type === 'tool/call') {
      const data = event.data as { callId: string; name: string; arguments: string }
      this.rememberToolCall(data.callId, data.name, data.arguments)
      if (this.settings().notifyToolCalls) {
        const message = this.t.toolCall(data.name, previewArguments(data.arguments, TOOL_PREVIEW_LENGTH))
        for (const chatId of chats) void this.reply(chatId, message, 'tool')
      }
    } else if (event.type === 'deliverables/presented') {
      if (!this.settings().sendDeliverables) return
      const files = (event.data as { files?: readonly { path: string; description?: string }[] }).files ?? []
      for (const file of files) {
        const path = isAbsolute(file.path) || cwd === undefined ? file.path : resolve(cwd, file.path)
        for (const chatId of chats) void this.sendLocalFile(chatId, path, file.description)
      }
    } else if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      const kind = reason?.kind ?? 'completed'
      if (kind !== 'completed') {
        const message = this.t.turnEnded(kind, reason?.error?.message)
        for (const chatId of chats) void this.reply(chatId, message)
      }
    }
  }

  /**
   * Follow a bound Session's run state for the typing indicator.
   * @param sessionId - the Agent's Session.
   * @param running - true on `running`, false on `idle`.
   */
  onAgentStatus(sessionId: string, running: boolean): void {
    if (running) this.startTyping(sessionId)
    else this.stopTyping(sessionId)
  }

  private startTyping(sessionId: string): void {
    const client = this.client
    if (client === undefined || this.activity.get(sessionId)?.typing !== undefined) return
    const chats = this.store.chatsFor(sessionId)
    if (chats.length === 0) return
    const tick = (): void => {
      for (const chatId of this.store.chatsFor(sessionId)) void client.sendTyping(chatId).catch(() => {})
    }
    tick()
    this.activity.set(sessionId, { typing: setInterval(tick, TYPING_INTERVAL_MS) })
  }

  private stopTyping(sessionId: string): void {
    clearInterval(this.activity.get(sessionId)?.typing)
    this.activity.delete(sessionId)
  }

  private rememberToolCall(callId: string, name: string, args: string): void {
    this.toolCalls.set(callId, { name, arguments: args })
    // Approvals arrive right after their call; a short memory is enough.
    if (this.toolCalls.size > 64) this.toolCalls.delete(this.toolCalls.keys().next().value as string)
  }

  /** Send one local file to a chat, in order with its text messages. */
  private sendLocalFile(chatId: number, path: string, description?: string): Promise<void> {
    return this.enqueue(chatId, async (client) => {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`${path} is not a file`)
      if (info.size > SEND_LIMIT_BYTES) {
        const notice = this.t.deliverableTooLarge(path)
        await client.sendMessage(chatId, notice)
        this.log({ chatId }, { dir: 'out', kind: 'notice', text: notice })
        return
      }
      const data = new Uint8Array(await readFile(path))
      const caption = description === undefined ? basename(path) : `${basename(path)}\n${description}`.slice(0, 1024)
      const kind = outgoingKind(path, info.size)
      await client.sendFile(kind, chatId, { data, name: basename(path) }, caption)
      const attachment = await this.viewerAttachment(chatId, basename(path), data, kind === 'photo' ? sniffImageType(data) : undefined)
      this.log({ chatId }, {
        dir: 'out', kind: 'file', attachments: [{ ...attachment, path }],
        ...(description === undefined ? {} : { text: description }),
      })
    })
  }

  /** Send text to a chat in order, split to Telegram's size limit. */
  private reply(chatId: number, text: string, kind: OutKind = 'notice'): Promise<void> {
    return this.enqueue(chatId, async (client) => {
      for (const chunk of chunkText(text)) await client.sendMessage(chatId, chunk)
      this.log({ chatId }, { dir: 'out', kind, text })
    })
  }

  /** Run one send operation after the chat's earlier ones, containing its failure. */
  private enqueue(chatId: number, send: (client: TelegramClient) => Promise<void>): Promise<void> {
    const client = this.client
    if (client === undefined) return Promise.resolve()
    const previous = this.sendTails.get(chatId) ?? Promise.resolve()
    const next = previous.then(() => send(client)).catch((error: unknown) => {
      this.logger.warn(`telegram-bridge: send to chat ${chatId} failed: ${describe(error)}`)
    })
    this.sendTails.set(chatId, next)
    void next.then(() => {
      if (this.sendTails.get(chatId) === next) this.sendTails.delete(chatId)
    })
    return next
  }

  // ─── approvals ──────────────────────────────────────────────────────────

  /**
   * Ask the chats bound to a Session to approve one tool call.
   * @param request - the Session, tool, optional call id and reason, and withdrawal signal.
   * @returns the Telegram answer, or `delegate` when no chat is bound, approvals are off, or the wait timed out.
   */
  async requestApproval(request: {
    sessionId: string
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<TelegramApprovalOutcome> {
    const s = this.settings()
    const client = this.client
    if (!s.approvalViaTelegram || client === undefined || this.state.kind !== 'running') return 'delegate'
    const chats = this.store.chatsFor(request.sessionId)
    if (chats.length === 0) return 'delegate'
    if (request.signal?.aborted === true) return 'cancelled'
    const t = this.t
    const id = randomUUID().slice(0, 12)
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.callId)
    const detail = call === undefined ? '' : previewArguments(call.arguments, 800)
    const text = t.approvalAsk(request.toolName, detail, request.reason)
    const buttons = [[
      { text: t.allow, callback_data: `ap:${id}:y` },
      { text: t.reject, callback_data: `ap:${id}:n` },
    ]]

    const answer = Promise.withResolvers<TelegramApprovalOutcome>()
    const pending: PendingApproval = {
      sessionId: request.sessionId,
      prompts: [],
      settle: (outcome, note, by) => {
        if (!this.approvals.delete(id)) return
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        for (const prompt of pending.prompts) {
          void client.editMessageText(prompt.chatId, prompt.messageId, `${text}\n\n${note}`).catch(() => {})
          this.log({ chatId: prompt.chatId }, {
            dir: 'out', kind: 'approval',
            ...(request.reason === undefined ? {} : { text: request.reason }),
            approval: {
              tool: request.toolName,
              ...(detail === '' ? {} : { detail }),
              outcome: outcome === 'delegate' ? 'timeout' : outcome,
              ...(by === undefined ? {} : { by }),
            },
          })
        }
        answer.resolve(outcome)
      },
    }
    const onAbort = (): void => { pending.settle('cancelled', t.approvalCancelled) }
    const timer = setTimeout(() => { pending.settle('delegate', t.approvalTimedOut) }, s.approvalTimeoutSec * 1000)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.approvals.set(id, pending)

    const sent = await Promise.allSettled(chats.map(chatId => client.sendMessage(chatId, text, buttons)))
    for (const result of sent) {
      if (result.status === 'fulfilled') pending.prompts.push({ chatId: result.value.chat.id, messageId: result.value.message_id })
    }
    if (pending.prompts.length === 0) pending.settle('delegate', '')
    return answer.promise
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const client = this.client
    if (client === undefined) return
    const match = /^ap:([\w-]+):([yn])$/u.exec(query.data ?? '')
    if (match === null) {
      await client.answerCallbackQuery(query.id)
      return
    }
    const t = this.t
    if (!isAllowed(this.settings().allowedUsers, query.from.id, query.from.username)) {
      await client.answerCallbackQuery(query.id, t.unauthorized(query.from.id))
      return
    }
    const pending = this.approvals.get(match[1] ?? '')
    if (pending === undefined) {
      await client.answerCallbackQuery(query.id, t.approvalGone)
      return
    }
    const who = query.from.username === undefined ? query.from.first_name : `@${query.from.username}`
    if (match[2] === 'y') pending.settle('allowed-once', t.approvalAllowed(who), who)
    else pending.settle('rejected', t.approvalRejected(who), who)
    await client.answerCallbackQuery(query.id)
  }
}

/** What the history knows about a chat from one incoming message. */
function chatInfo(chat: TgChat, from: TgUser): ChatInfo {
  const username = chat.username ?? (chat.type === 'private' ? from.username : undefined)
  return {
    chatId: chat.id,
    title: chat.title ?? displayName(from),
    type: chat.type,
    ...(username === undefined ? {} : { username }),
  }
}

function sender(user: TgUser): { id: number; name: string; username?: string } {
  return { id: user.id, name: displayName(user), ...(user.username === undefined ? {} : { username: user.username }) }
}

function displayName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ?? String(user.id))
}

/** Concatenate the visible text blocks of a committed assistant message. */
export function assistantText(data: unknown): string {
  const content = (data as { message?: { content?: readonly { type: string; text?: string }[] } })?.message?.content
  if (content === undefined) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
}

async function isDirectory(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
