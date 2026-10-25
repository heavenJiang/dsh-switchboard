/**
 * Telegram ⇄ Harness bridge core: long-polls the Bot API, turns messages and
 * commands into Session operations, mirrors assistant output back to the bound
 * chats (rendered from Markdown, streamed as a draft while it is written), and
 * asks tool approvals with inline buttons. Photos, files, and voice notes are
 * staged into the Session; files the Agent presents are sent back. Chats can
 * follow Sessions they do not drive for completion and approval notices, and
 * scheduled runs can report to chosen chats.
 *
 * Harness access goes through {@link HarnessPort}, so this module does not
 * touch Cordis and can be exercised with a fake.
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BindingStore, PendingChoice } from './bindings.ts'
import type { ChatAttachment, ChatEntry, ChatInfo, ChatLog } from './chatlog.ts'
import { chunkMarkdown, markdownToTelegramHtml } from './markdown.ts'
import { incomingAttachments, outgoingKind, promptImageType, sniffImageType, type IncomingAttachment } from './media.ts'
import { MESSAGES, type BotLanguage, type Messages } from './messages.ts'
import {
  FileTooLargeError, TelegramApiError, TelegramClient,
  type TgCallbackQuery, type TgChat, type TgInlineButton, type TgMessage, type TgUpdate, type TgUser,
} from './telegram.ts'
import { chunkText, isAllowed, parseInput, previewArguments, truncate } from './text.ts'

/** When to post a summary at the end of a bound Session's turn. */
export type TurnSummaryMode = 'off' | 'long' | 'always'

/** Live settings the bridge reads at the start of each operation. */
export interface BridgeSettings {
  readonly enabled: boolean
  readonly botToken: string | undefined
  readonly apiBaseUrl: string
  readonly allowedUsers: readonly string[]
  /** Chat ids whose every member may drive the Harness (groups shared with a team). */
  readonly allowedChats: readonly string[]
  /** In groups, answer only commands, @mentions, and replies to the bot. */
  readonly groupMentionOnly: boolean
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly approvalViaTelegram: boolean
  /** Ask the Agent's questions (ask_user_question) in Telegram too. */
  readonly questionsViaTelegram: boolean
  readonly approvalTimeoutSec: number
  readonly notifyToolCalls: boolean
  /** Edit a draft message while the reply is written instead of waiting for the whole reply. */
  readonly streamReplies: boolean
  readonly turnSummary: TurnSummaryMode
  /** Minimum turn length for `long` summaries. */
  readonly turnSummaryMinSec: number
  /** Transcribe voice notes into prompts when the host can. */
  readonly transcribeVoice: boolean
  /** Chats that receive scheduled-run results. */
  readonly scheduleChats: readonly string[]
  readonly language: BotLanguage
  readonly pollTimeoutSec: number
  /** Largest file accepted from Telegram, in MB (the public Bot API serves at most 20). */
  readonly maxDownloadMb: number
  /** Send files the Agent presents back to the chat. */
  readonly sendDeliverables: boolean
  /** Model for Sessions the bot creates; the Web default when undefined. */
  readonly model?: ModelChoice
}

/** A provider route, model, and optional reasoning effort. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One selectable model, grouped under its provider. */
export interface ModelGroup {
  readonly provider: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** One permission preset the deployment offers. */
export interface PresetOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

/** One Harness slash command available to a Session. */
export interface HarnessCommand {
  readonly name: string
  readonly description: string
  readonly hint?: string
}

/** What a Harness command answered. */
export type HarnessCommandResult = { readonly kind: 'success' | 'error'; readonly text?: string }

/** One queued prompt of a live Session. */
export interface QueuedItem {
  readonly id: string
  readonly text: string
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
  /** Create a Session in `cwd` and return its id; `model` pins its model instead of following the Web default. */
  createSession(cwd: string, agentPreset: string, permissionPreset: string, model?: ModelChoice): Promise<string>
  /** Every currently routable model, and the Web default. */
  listModels(): Promise<{ groups: ModelGroup[]; default: ModelChoice }>
  /** The model a live Session's next step uses, or undefined when it is not loaded. */
  currentModel(sessionId: string): ModelChoice | undefined
  /**
   * Validate a choice and select it for one live Session only (the Web default is untouched).
   * @returns false when the Session is not loaded; the bridge applies it when the Session loads.
   * @throws when the route cannot serve the model.
   */
  selectModel(sessionId: string, choice: ModelChoice): Promise<boolean>
  /** Permission presets the deployment offers. */
  listPresets(): PresetOption[]
  /** A live Session's permission preset, or undefined when it is not loaded. */
  currentPreset(sessionId: string): string | undefined
  /**
   * Validate and switch a live Session's permission preset.
   * @returns false when the Session is not loaded.
   */
  selectPreset(sessionId: string, preset: string): boolean
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
  /**
   * Make a Session a member of the Web Workspace for its working directory,
   * creating the Workspace when none owns that directory yet, so it lists in
   * the sidebar with the user's other Sessions. Archived Sessions are left alone.
   */
  ensureWorkspace(sessionId: string): Promise<void>
  /**
   * Harness slash commands (`/compact`, `/plan`, …) the Session can run; the
   * Session is resumed when needed. With no Session, any live top-level Agent's view.
   */
  listCommands(sessionId: string | undefined): Promise<HarnessCommand[]>
  /**
   * Run one slash-command line the way the Web composer does: on the Host,
   * outside the model conversation.
   * @returns the command's result, or undefined when no Harness command has that name.
   */
  runCommand(sessionId: string, line: string): Promise<HarnessCommandResult | undefined>
  /** Prompts waiting in a live Session's inbox; undefined when it is not loaded. */
  queued(sessionId: string): QueuedItem[] | undefined
  /** Drop queued prompts by id, or all; returns how many were dropped. */
  dropQueued(sessionId: string, ids: readonly string[] | 'all'): number
  /** Files a finished turn changed, from the workspace-changes summary at `seq`; undefined when unknown. */
  changedFiles(sessionId: string, seq: number): string[] | undefined
  /**
   * Transcribe a voice note.
   * @throws with a short reason when transcription is unavailable.
   */
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string>
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

/** One question the Agent asked, as Telegram shows it. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string }[]
  readonly multiSelect?: boolean
}

/** The answer batch for one question request. */
export interface QuestionAnswer {
  readonly answers: { id: string; selected: string[]; custom?: string }[]
}

/** A question request waiting on Telegram. */
interface PendingQuestions {
  readonly sessionId: string
  readonly chats: number[]
  readonly items: {
    readonly item: QuestionItem
    readonly messages: Map<number, number>
    readonly selected: Set<string>
    custom?: string
    done: boolean
  }[]
  settle(outcome: QuestionAnswer | 'delegate' | 'cancelled', note?: string): void
}

/** A list of buttons sent with /model or /mode, kept so a press fits Telegram's 64-byte callback data. */
type Picker =
  | { kind: 'model'; sessionId: string; choices: { choice: ModelChoice; name: string }[]; at: number }
  | { kind: 'mode'; sessionId: string; choices: PresetOption[]; at: number }

/** How a bot message is labelled in the chat history. */
type OutKind = 'assistant' | 'tool' | 'notice'

/** A reply being written, shown as one edited message per chat. */
interface Draft {
  text: string
  /** Draft message per chat, once sent. */
  readonly messages: Map<number, number>
  lastFlush: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** The send or edit in flight; finalization waits for it. */
  pending: Promise<void>
}

/** Tool calls between two replies, shown as one message edited in place. */
interface ToolActivity {
  readonly lines: string[]
  count: number
  readonly messages: Map<number, number>
  timer: ReturnType<typeof setTimeout> | undefined
  lastFlush: number
  pending: Promise<void>
}

/** What the bridge tracks about a Session's running turn. */
interface TurnState {
  startedAt: number
  tools: number
  files?: string[]
  /** Started by the schedule subsystem: results also go to the schedule chats. */
  scheduled: boolean
  lastText?: string
}

/** Observable connection state for `/status` and logs. */
export type BridgeState =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'running'; readonly username: string }
  | { readonly kind: 'error'; readonly message: string }

/** The bridge's own commands; a Harness command of the same name is reached only from the Web. */
const BRIDGE_COMMANDS = new Set([
  'start', 'help', 'new', 'cwd', 'use', 'sessions', 'watch', 'unwatch', 'stop', 'steer', 'queue', 'cancel',
  'status', 'model', 'mode', 'get', 'whoami',
])
/** Harness commands that only make sense in the Web composer (`/telegram` links a Web Session to a chat). */
const WEB_ONLY_COMMANDS = new Set(['telegram'])
/** Telegram's command-name rule for the bot menu. */
const MENU_NAME = /^[a-z0-9_]{1,32}$/u

/** Images up to this size are copied into the history for the viewer. */
const VIEWER_IMAGE_LIMIT = 5 * 1024 * 1024
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
}
const TYPING_INTERVAL_MS = 4500
const MAX_BACKOFF_MS = 60_000
const TOOL_PREVIEW_LENGTH = 200
/** Tool lines arriving within this window go out as one message (Telegram allows about one message per second per chat). */
const TOOL_BATCH_MS = 1500
/** Lines an activity message shows; older calls fold into its count. */
const TOOL_LINES_SHOWN = 12
/** Draft edits are at least this far apart. */
const DRAFT_INTERVAL_MS = 1500
/** A draft appears once the reply has this much text. */
const DRAFT_MIN_CHARS = 40
/** How long to wait for the rest of an album before prompting with it. */
const MEDIA_GROUP_WAIT_MS = 1500
/** Telegram's document upload ceiling for bots. */
const SEND_LIMIT_BYTES = 50 * 1024 * 1024
/** Buttons in one /model picker; longer catalogs are reached by name. */
const PICKER_BUTTONS = 30
const PICKER_TTL_MS = 10 * 60 * 1000
/** A stranger hears the "not authorized" reply at most this often. */
const DENIED_REPLY_INTERVAL_MS = 60 * 60 * 1000
const DIRECTORY_LIST_LIMIT = 50
const EXCERPT_LENGTH = 400

/** The bridge core. One instance lives for the plugin's lifetime; polling restarts on token changes. */
export class TelegramBridge {
  state: BridgeState = { kind: 'stopped' }
  private client: TelegramClient | undefined
  private poll: { controller: AbortController; done: Promise<void>; key: string } | undefined
  private botUsername: string | undefined
  private readonly sendTails = new Map<number, Promise<void>>()
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestions>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  /** One edited "tool activity" message per Session and chat, until the next reply. */
  private readonly toolBatches = new Map<string, ToolActivity>()
  private readonly drafts = new Map<string, Draft>()
  private readonly turns = new Map<string, TurnState>()
  private readonly pickers = new Map<string, Picker>()
  private readonly albums = new Map<string, { chatId: number; messages: TgMessage[]; timer: ReturnType<typeof setTimeout> }>()
  /** The last /sessions listing per chat, so `/use 2` and `/watch 2` work. */
  private readonly listings = new Map<number, string[]>()
  private readonly deniedReplies = new Map<number, number>()
  private readonly lifetime = new AbortController()
  /** Whether the bot menu already lists Harness commands (it is filled once a Session can list them). */
  private menuHasHarness = false

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

  private get t(): Messages {
    return MESSAGES[this.settings().language]
  }

  /** Append to the Web viewer's history; failures are logged, never surfaced to Telegram. */
  private log(chat: ChatInfo, entry: Omit<ChatEntry, 'id' | 'at' | 'sessionId'>, sessionId?: string): void {
    if (this.chatLog === undefined) return
    const session = sessionId ?? this.store.get(chat.chatId).sessionId
    void this.chatLog.record(chat, { ...entry, ...(session === undefined ? {} : { sessionId: session }) }).catch((error: unknown) => {
      this.logger.warn(`switchboard: chat history write failed: ${describe(error)}`)
    })
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
    for (const pending of this.questions.values()) pending.settle('delegate', this.t.questionTimedOut)
    for (const album of this.albums.values()) clearTimeout(album.timer)
    this.albums.clear()
    for (const timer of this.typing.values()) clearInterval(timer)
    this.typing.clear()
    for (const sessionId of [...this.toolBatches.keys()]) this.flushTools(sessionId)
    for (const draft of this.drafts.values()) clearTimeout(draft.timer)
    this.drafts.clear()
    await Promise.allSettled([...this.sendTails.values()])
    this.client = undefined
    this.state = { kind: 'stopped' }
  }

  /** Stop for good: also abort in-flight transcriptions. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.stop()
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
          this.logger.info(`switchboard: connected as @${this.state.username}`)
          await this.registerCommands(client)
        }
        const updates = await client.getUpdates(this.store.offset, this.settings().pollTimeoutSec, signal)
        backoff = 1000
        for (const update of updates) {
          // Advance first: an update that crashes the handler is not replayed forever.
          await this.store.setOffset(update.update_id + 1)
          await this.handleUpdate(update).catch((error: unknown) => {
            this.logger.warn(`switchboard: update ${update.update_id} failed: ${describe(error)}`)
          })
        }
      } catch (error: unknown) {
        if (signal.aborted) break
        if (error instanceof TelegramApiError && error.code === 401) {
          this.state = { kind: 'error', message: 'bot token rejected (401)' }
          this.logger.warn('switchboard: bot token rejected; fix it on the plugin page')
          return
        }
        this.state = { kind: 'error', message: describe(error) }
        this.logger.warn(`switchboard: polling failed, retrying in ${backoff / 1000}s: ${describe(error)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        if (!signal.aborted) this.state = { kind: 'connecting' }
      }
    }
  }

  /** The bot menu: the bridge's main commands, then the Harness commands Telegram can name. */
  private async registerCommands(client: TelegramClient, harnessCommands?: readonly HarnessCommand[]): Promise<void> {
    const t = this.t
    const extra = (harnessCommands ?? await this.harness.listCommands(undefined).catch(() => []))
      .filter(command => MENU_NAME.test(command.name) && !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
      .slice(0, 20)
      .map(command => ({ command: command.name, description: truncate(command.description || command.name, 256) }))
    this.menuHasHarness = extra.length > 0
    await client.setMyCommands([
      { command: 'new', description: t.cmdNew },
      { command: 'stop', description: t.cmdStop },
      { command: 'model', description: t.cmdModel },
      { command: 'mode', description: t.cmdMode },
      { command: 'watch', description: t.cmdWatch },
      { command: 'get', description: t.cmdGet },
      { command: 'status', description: t.cmdStatus },
      { command: 'help', description: t.cmdHelp },
      ...extra,
    ]).catch((error: unknown) => {
      this.logger.debug(`switchboard: setMyCommands failed: ${describe(error)}`)
    })
  }

  // ─── inbound ────────────────────────────────────────────────────────────

  /** Route one update. Exposed for tests. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query !== undefined) return this.handleCallback(update.callback_query)
    if (update.message !== undefined) return this.handleMessage(update.message)
  }

  /** Whether a user (or the whole chat) may drive the Harness. */
  private allowed(user: TgUser, chat: TgChat): boolean {
    const s = this.settings()
    return isAllowed(s.allowedUsers, user.id, user.username) || s.allowedChats.some(id => id.trim() === String(chat.id))
  }

  /**
   * In groups the bot answers only what is addressed to it.
   * @returns the message text with the bot's @mention removed, or undefined to ignore the message.
   */
  private addressed(message: TgMessage, text: string | undefined): { text: string | undefined } | undefined {
    const group = message.chat.type === 'group' || message.chat.type === 'supergroup'
    if (!group || !this.settings().groupMentionOnly) return { text }
    const bot = this.botUsername?.toLowerCase()
    const mention = bot === undefined ? undefined : new RegExp(`@${bot}\\b`, 'iu')
    if (text !== undefined && text.trimStart().startsWith('/')) return { text }
    if (text !== undefined && mention?.test(text) === true) return { text: text.replace(mention, '').trim() }
    const repliedTo = message.reply_to_message?.from
    if (repliedTo?.is_bot === true && repliedTo.username?.toLowerCase() === bot) return { text }
    return undefined
  }

  private async handleMessage(message: TgMessage): Promise<void> {
    const from = message.from
    if (from === undefined || from.is_bot) return
    const chatId = message.chat.id
    const t = this.t
    const addressed = this.addressed(message, message.text ?? message.caption)
    if (addressed === undefined) return
    const text = addressed.text
    const parsed = text === undefined ? undefined : parseInput(text, this.botUsername)
    const allowed = this.allowed(from, message.chat)
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
      // Answer strangers only in private chats, and only now and then, so nobody can make the bot spam.
      const last = this.deniedReplies.get(from.id) ?? 0
      if (message.chat.type === 'private' && Date.now() - last > DENIED_REPLY_INTERVAL_MS) {
        this.deniedReplies.set(from.id, Date.now())
        await this.reply(chatId, t.unauthorized(from.id))
      }
      return
    }
    if (message.media_group_id !== undefined) return this.collectAlbum(chatId, message)
    try {
      if (message.voice !== undefined && this.settings().transcribeVoice) return await this.promptWithVoice(chatId, message)
      if (attachments.length > 0) return await this.promptWithMedia(chatId, [message])
      if (text === undefined) return await this.reply(chatId, t.unsupported)
      if (parsed === undefined) return
      if (parsed.kind === 'text' && this.answerByText(chatId, parsed.text)) return
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
  private async promptWithMedia(chatId: number, messages: readonly TgMessage[], note?: string): Promise<void> {
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
    if (note !== undefined) await this.reply(chatId, note)
    if (parts.length === 0) {
      this.stopTyping(sessionId)
      return
    }
    if (captions.length > 0) parts.unshift({ type: 'text', text: captions.join('\n\n') })
    await this.harness.prompt(sessionId, parts, 'queue')
  }

  /**
   * Transcribe a voice note and prompt with the text; when the host cannot
   * transcribe, the note goes to the Agent as an audio file instead.
   */
  private async promptWithVoice(chatId: number, message: TgMessage): Promise<void> {
    const client = this.client
    const voice = message.voice
    if (client === undefined || voice === undefined || message.from === undefined) return
    const t = this.t
    let transcript: string
    try {
      const limit = this.settings().maxDownloadMb * 1024 * 1024
      const audio = await this.download(client, { fileId: voice.file_id, name: `voice_${message.message_id}.ogg`, ...(voice.file_size === undefined ? {} : { size: voice.file_size }) }, limit)
      transcript = (await this.harness.transcribe(audio, this.lifetime.signal)).trim()
    } catch (error: unknown) {
      return this.promptWithMedia(chatId, [message], t.voiceUnavailable(describe(error)))
    }
    if (transcript === '') return this.reply(chatId, t.voiceEmpty)
    const caption = (message.caption ?? '').trim()
    const text = caption === '' ? transcript : `${caption}\n\n${transcript}`
    this.log(chatInfo(message.chat, message.from), { dir: 'in', kind: 'text', from: sender(message.from), text: `🎤 ${text}` })
    await this.reply(chatId, t.voiceHeard(transcript))
    await this.promptFromChat(chatId, [{ type: 'text', text }], 'queue')
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

  // ─── commands ───────────────────────────────────────────────────────────

  private async runCommand(chatId: number, name: string, args: string): Promise<void> {
    const t = this.t
    const binding = this.store.get(chatId)
    switch (name) {
      case 'start':
      case 'help': {
        const commands = (await this.harness.listCommands(binding.sessionId).catch(() => []))
          .filter(command => !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
        if (commands.length > 0 && !this.menuHasHarness && this.client !== undefined) void this.registerCommands(this.client, commands)
        const lines = commands.map(command => `/${command.name}${command.hint === undefined ? '' : ` ${command.hint}`} — ${command.description}`)
        return this.reply(chatId, lines.length === 0 ? t.help : `${t.help}\n\n${t.harnessCommands}\n${lines.join('\n')}`)
      }
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
        const sessionId = this.sessionRef(chatId, args)
        await this.store.update(chatId, { sessionId })
        await this.chatLog?.bind(chatId, sessionId).catch(() => {})
        this.attachToWorkspace(sessionId)
        return this.reply(chatId, t.bound(sessionId))
      }
      case 'sessions': {
        const rows = (await this.harness.listSessions()).slice(0, 10)
        this.listings.set(chatId, rows.map(row => row.sessionId))
        const lines = rows.map((row, index) =>
          `${index + 1}. ${row.running ? '▶' : '·'} ${row.sessionId}${row.cwd === undefined ? '' : `  ${row.cwd}`}${row.sessionId === binding.sessionId ? ' ✓' : ''}`)
        return this.reply(chatId, t.sessions(lines))
      }
      case 'watch': {
        if (args === '') return this.reply(chatId, t.watching((binding.watch ?? []).map(id => `· ${id}`)))
        const sessionId = this.sessionRef(chatId, args)
        await this.store.setWatch(chatId, sessionId, true)
        this.attachToWorkspace(sessionId)
        return this.reply(chatId, t.watchOn(sessionId))
      }
      case 'unwatch': {
        if (args.trim().toLowerCase() === 'all') {
          for (const id of binding.watch ?? []) await this.store.setWatch(chatId, id, false)
          return this.reply(chatId, t.watchOffAll)
        }
        if (args === '') return this.reply(chatId, t.watching((binding.watch ?? []).map(id => `· ${id}`)))
        const sessionId = this.sessionRef(chatId, args)
        await this.store.setWatch(chatId, sessionId, false)
        return this.reply(chatId, t.watchOff(sessionId))
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
      case 'queue': {
        if (binding.sessionId === undefined) return this.reply(chatId, t.noSession)
        const items = this.harness.queued(binding.sessionId)
        if (items === undefined) return this.reply(chatId, t.queueNotLive)
        return this.reply(chatId, t.queueList(items.map((item, index) => `${index + 1}. ${truncate(item.text.replace(/\s+/gu, ' '), 80)}`)))
      }
      case 'cancel': {
        if (binding.sessionId === undefined) return this.reply(chatId, t.noSession)
        const items = this.harness.queued(binding.sessionId)
        if (items === undefined) return this.reply(chatId, t.queueNotLive)
        if (args.trim().toLowerCase() === 'all') return this.reply(chatId, t.queueCancelled(this.harness.dropQueued(binding.sessionId, 'all')))
        const picked = args.split(/[\s,]+/u).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= items.length)
        if (picked.length === 0) return this.reply(chatId, t.cancelUsage)
        return this.reply(chatId, t.queueCancelled(this.harness.dropQueued(binding.sessionId, picked.map(n => items[n - 1]!.id))))
      }
      case 'status': {
        const live = binding.sessionId === undefined ? undefined : this.harness.live(binding.sessionId)
        const model = binding.sessionId === undefined ? undefined : this.modelOf(binding.sessionId)
        return this.reply(chatId, t.status({
          bot: this.state.kind === 'running' ? `@${this.state.username}` : this.state.kind,
          ...(binding.sessionId === undefined ? {} : { session: binding.sessionId }),
          ...(live?.cwd === undefined ? {} : { cwd: live.cwd }),
          ...(live === undefined ? {} : { running: live.running }),
          ...(model === undefined ? {} : { model: modelLabel(model) }),
        }))
      }
      case 'model':
        return this.modelCommand(chatId, binding.sessionId, args)
      case 'mode':
        return this.modeCommand(chatId, binding.sessionId, args)
      case 'get':
        return this.getCommand(chatId, binding.sessionId, args)
      default: {
        const line = `/${name}${args === '' ? '' : ` ${args}`}`
        // Harness commands run on the Host as in the Web composer; anything else is text for the Agent.
        if (binding.sessionId !== undefined) {
          const result = await this.harness.runCommand(binding.sessionId, line)
          if (result !== undefined) {
            return this.reply(chatId, result.kind === 'error'
              ? t.commandFailed(name, result.text ?? '')
              : result.text === undefined || result.text.trim() === '' ? t.commandDone(name) : result.text)
          }
        }
        return this.promptFromChat(chatId, [{ type: 'text', text: line }], 'queue')
      }
    }
  }

  /** Put a linked Session into its directory's Web Workspace; a failure is logged, never shown in Telegram. */
  private attachToWorkspace(sessionId: string): void {
    void this.harness.ensureWorkspace(sessionId).catch((error: unknown) => {
      this.logger.warn(`switchboard: could not add ${sessionId} to a Web workspace: ${describe(error)}`)
    })
  }

  /** Put every linked Session into its directory's Web Workspace (startup backfill). */
  async attachLinkedSessions(): Promise<void> {
    for (const sessionId of this.store.linkedSessions()) {
      await this.harness.ensureWorkspace(sessionId).catch((error: unknown) => {
        this.logger.warn(`switchboard: could not add ${sessionId} to a Web workspace: ${describe(error)}`)
      })
    }
  }

  /** Resolve `/use 2` against the chat's last /sessions listing; anything else is a Session id. */
  private sessionRef(chatId: number, arg: string): string {
    const value = arg.trim()
    if (/^\d{1,2}$/u.test(value)) {
      const listed = this.listings.get(chatId)?.[Number(value) - 1]
      if (listed === undefined) throw new Error(this.t.sessionNotFound(value))
      return listed
    }
    return value
  }

  /**
   * The model a Session uses next: a pending /model choice, else the live
   * Session's selection; undefined for a cold Session with no pending choice.
   */
  modelOf(sessionId: string): ModelChoice | undefined {
    return this.store.pending(sessionId)?.model ?? this.harness.currentModel(sessionId)
  }

  /**
   * Hand over /model and /mode choices made while the Session was not loaded.
   * The host calls this when the Session's Agent is created, before it handles input.
   * @returns the choices to apply, once.
   */
  takePending(sessionId: string): Readonly<PendingChoice> | undefined {
    const pending = this.store.pending(sessionId)
    if (pending !== undefined) void this.store.setPending(sessionId, { model: undefined, preset: undefined })
    return pending
  }

  /** `/model` lists models as buttons; `/model <name>` switches the chat's Session directly. */
  private async modelCommand(chatId: number, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (sessionId === undefined) return this.reply(chatId, t.modelNoSession)
    const { groups } = await this.harness.listModels()
    const all = groups.flatMap(group => group.models.map(model => ({ group, model })))
    if (args === '') {
      const current = this.modelOf(sessionId)
      const choices = all.slice(0, PICKER_BUTTONS).map(({ group, model }) => ({ choice: { provider: group.provider, model: model.id }, name: model.name }))
      const buttons = all.slice(0, PICKER_BUTTONS).map(({ group, model }) =>
        `${current?.provider === group.provider && current.model === model.id ? '✓ ' : ''}${model.name} · ${group.name}`)
      return this.sendPicker(chatId, { kind: 'model', sessionId, choices, at: Date.now() }, buttons,
        t.modelList(current === undefined ? undefined : modelLabel(current), all.length))
    }
    const needle = args.trim().toLowerCase()
    const exact = all.filter(({ group, model }) =>
      [`${group.provider}/${model.id}`, model.id, model.name].some(value => value.toLowerCase() === needle))
    const matches = exact.length > 0 ? exact : all.filter(({ group, model }) =>
      [`${group.provider}/${model.id}`, model.name].some(value => value.toLowerCase().includes(needle)))
    if (matches.length === 0) return this.reply(chatId, t.modelNotFound(args))
    if (matches.length > 1) {
      return this.reply(chatId, t.modelAmbiguous(matches.slice(0, 10).map(({ group, model }) => `${model.name} (${group.provider}/${model.id})`)))
    }
    const { group, model } = matches[0]!
    return this.switchModel(chatId, sessionId, { provider: group.provider, model: model.id }, model.name)
  }

  private async switchModel(chatId: number, sessionId: string, choice: ModelChoice, name: string): Promise<void> {
    const t = this.t
    try {
      const applied = await this.harness.selectModel(sessionId, choice)
      await this.store.setPending(sessionId, { model: applied ? undefined : { ...choice } })
      await this.reply(chatId, applied ? t.modelSwitched(name, modelLabel(choice)) : t.modelPending(name, modelLabel(choice)))
    } catch (error: unknown) {
      await this.reply(chatId, t.failed(describe(error)))
    }
  }

  /** `/mode` lists permission presets as buttons; `/mode <name>` switches directly. */
  private async modeCommand(chatId: number, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (sessionId === undefined) return this.reply(chatId, t.noSession)
    const options = this.harness.listPresets()
    if (args === '') {
      const current = this.store.pending(sessionId)?.preset ?? this.harness.currentPreset(sessionId)
      const currentName = options.find(option => option.value === current)?.name ?? current
      const buttons = options.map(option => `${option.value === current ? '✓ ' : ''}${option.name}${option.description === undefined ? '' : ` — ${option.description}`}`)
      return this.sendPicker(chatId, { kind: 'mode', sessionId, choices: options.slice(0, PICKER_BUTTONS), at: Date.now() }, buttons, t.modeList(currentName))
    }
    const needle = args.trim().toLowerCase()
    const match = options.find(option => option.value.toLowerCase() === needle || option.name.toLowerCase() === needle)
      ?? options.filter(option => option.value.toLowerCase().includes(needle) || option.name.toLowerCase().includes(needle)).at(0)
    if (match === undefined) return this.reply(chatId, t.modeNotFound(args))
    return this.switchMode(chatId, sessionId, match)
  }

  private async switchMode(chatId: number, sessionId: string, option: PresetOption): Promise<void> {
    const t = this.t
    try {
      const applied = this.harness.selectPreset(sessionId, option.value)
      await this.store.setPending(sessionId, { preset: applied ? undefined : option.value })
      await this.reply(chatId, applied ? t.modeSwitched(option.name) : t.modePending(option.name))
    } catch (error: unknown) {
      await this.reply(chatId, t.failed(describe(error)))
    }
  }

  private async sendPicker(chatId: number, picker: Picker, labels: string[], text: string): Promise<void> {
    const id = randomUUID().slice(0, 8)
    const cutoff = Date.now() - PICKER_TTL_MS
    for (const [key, old] of this.pickers) if (old.at < cutoff) this.pickers.delete(key)
    while (this.pickers.size >= 32) this.pickers.delete(this.pickers.keys().next().value as string)
    this.pickers.set(id, picker)
    const buttons: TgInlineButton[][] = labels.slice(0, PICKER_BUTTONS).map((label, index) => [{ text: label.slice(0, 60), callback_data: `pk:${id}:${index}` }])
    await this.enqueue(chatId, async (client) => { await client.sendMessage(chatId, text, { buttons }) })
    this.log({ chatId }, { dir: 'out', kind: 'notice', text })
  }

  /** `/get <path>`: send a file from the working directory, or list a directory. */
  private async getCommand(chatId: number, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (args.trim() === '') return this.reply(chatId, t.getUsage)
    const base = (sessionId === undefined ? undefined : this.harness.live(sessionId)?.cwd) ?? this.defaultWorkspace(chatId)
    if (base === undefined) return this.reply(chatId, t.noWorkspace)
    const target = resolve(base, args.trim())
    let real: string
    let root: string
    try {
      root = await realpath(base)
      real = await realpath(target)
    } catch {
      return this.reply(chatId, t.getMissing(args.trim()))
    }
    // Symlinks resolve before the check, so a link cannot reach outside the directory.
    if (real !== root && !real.startsWith(root + sep)) return this.reply(chatId, t.getOutside)
    const info = await stat(real)
    if (info.isDirectory()) {
      const entries = (await readdir(real, { withFileTypes: true }))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      const lines = entries.slice(0, DIRECTORY_LIST_LIMIT).map(entry => `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`)
      return this.reply(chatId, t.getDir(relative(root, real) || '.', lines, entries.length - lines.length))
    }
    return this.sendLocalFile(chatId, real)
  }

  private defaultWorkspace(chatId: number): string | undefined {
    const path = this.store.get(chatId).workspacePath ?? this.settings().workspacePath
    return path.trim() === '' ? undefined : path
  }

  private async newSession(chatId: number, cwd: string): Promise<string> {
    if (!(await isDirectory(cwd))) throw new Error(this.t.badWorkspace(cwd))
    const s = this.settings()
    const sessionId = await this.harness.createSession(cwd, s.agentPreset, s.permissionPreset, s.model)
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

  // ─── Web-side operations ────────────────────────────────────────────────

  /**
   * Bind a chat to a Session from the Web UI, or make it follow the Session.
   * @param mode - `active` makes the chat talk to the Session; `watch` follows it; `none` removes both.
   */
  async linkChat(chatId: number, sessionId: string, mode: 'active' | 'watch' | 'none'): Promise<void> {
    const t = this.t
    if (mode !== 'none') this.attachToWorkspace(sessionId)
    const binding = this.store.get(chatId)
    if (mode === 'active') {
      await this.store.update(chatId, { sessionId })
      await this.store.setWatch(chatId, sessionId, false)
      await this.chatLog?.bind(chatId, sessionId).catch(() => {})
      await this.reply(chatId, t.boundFromWeb(sessionId))
    } else if (mode === 'watch') {
      if (binding.sessionId === sessionId) await this.store.update(chatId, { sessionId: undefined })
      await this.store.setWatch(chatId, sessionId, true)
      await this.reply(chatId, t.watchFromWeb(sessionId))
    } else {
      if (binding.sessionId === sessionId) await this.store.update(chatId, { sessionId: undefined })
      await this.store.setWatch(chatId, sessionId, false)
    }
  }

  /** How each known chat relates to a Session. */
  linksOf(sessionId: string): { chatId: number; mode: 'active' | 'watch' }[] {
    return [
      ...this.store.chatsFor(sessionId).map(chatId => ({ chatId, mode: 'active' as const })),
      ...this.store.watchersOf(sessionId).map(chatId => ({ chatId, mode: 'watch' as const })),
    ]
  }

  /** Send a message to a chat as the bot, typed in the Web UI. */
  async sendFromWeb(chatId: number, text: string): Promise<void> {
    if (this.client === undefined) throw new Error('the bot is not connected')
    await this.deliverMarkdown(chatId, text)
    this.log({ chatId }, { dir: 'out', kind: 'web', text })
  }

  // ─── outbound: Session events ───────────────────────────────────────────

  /** Chats that see a Session's output: bound chats, plus the schedule chats during a scheduled run. */
  private outputChats(sessionId: string): number[] {
    const chats = new Set(this.store.chatsFor(sessionId))
    if (this.turns.get(sessionId)?.scheduled === true) {
      for (const id of this.settings().scheduleChats) if (Number.isSafeInteger(Number(id))) chats.add(Number(id))
    }
    return [...chats]
  }

  /**
   * Mirror one committed Session event to the chats bound to or following it.
   * @param sessionId - the event's Session.
   * @param event - committed durable event (`type`, `data`, and its log `seq` and `time`).
   * @param cwd - the Session's working directory, which relative presented paths resolve against.
   */
  onSessionEvent(sessionId: string, event: { type: string; data?: unknown; seq?: number; time?: number }, cwd?: string): void {
    if (this.client === undefined) return
    if (event.type === 'turn/start') {
      this.turns.set(sessionId, { startedAt: event.time ?? Date.now(), tools: 0, scheduled: false })
      return
    }
    if (event.type === 'user/message') {
      const source = (event.data as { message?: { source?: { kind?: string } } }).message?.source?.kind
      const turn = this.turns.get(sessionId)
      if (source === 'schedule' && turn !== undefined) turn.scheduled = true
      return
    }
    const turn = this.turns.get(sessionId)
    if (event.type === 'workspace/changes' && event.seq !== undefined) {
      const files = this.harness.changedFiles(sessionId, event.seq)
      if (files !== undefined && turn !== undefined) turn.files = files
      return
    }
    const chats = this.outputChats(sessionId)
    const watchers = this.store.watchersOf(sessionId)
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data)
      if (text === '') return
      if (turn !== undefined) turn.lastText = text
      this.flushTools(sessionId)
      void this.finishDraft(sessionId, chats, text)
    } else if (event.type === 'tool/call') {
      const data = event.data as { callId: string; name: string; arguments: string }
      this.rememberToolCall(data.callId, data.name, data.arguments)
      if (turn !== undefined) turn.tools++
      if (this.settings().notifyToolCalls && chats.length > 0) this.queueToolLine(sessionId, data.name, data.arguments)
    } else if (event.type === 'deliverables/presented') {
      if (!this.settings().sendDeliverables) return
      const files = (event.data as { files?: readonly { path: string; description?: string }[] }).files ?? []
      for (const file of files) {
        const path = isAbsolute(file.path) || cwd === undefined ? file.path : resolve(cwd, file.path)
        for (const chatId of chats) void this.sendLocalFile(chatId, path, file.description)
      }
    } else if (event.type === 'turn/end') {
      this.flushTools(sessionId)
      this.turns.delete(sessionId)
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      const kind = reason?.kind ?? 'completed'
      this.endTurn(sessionId, kind, reason?.error?.message, turn, chats, watchers, event.time ?? Date.now())
    }
  }

  /** Turn-end notices: failures to everyone, summaries by setting, and always to followers. */
  private endTurn(
    sessionId: string, kind: string, error: string | undefined, turn: TurnState | undefined,
    chats: number[], watchers: number[], endedAt: number,
  ): void {
    const t = this.t
    const title = shortId(sessionId)
    if (kind !== 'completed') {
      const message = t.turnEnded(kind, error)
      for (const chatId of chats) void this.reply(chatId, message)
      const watchMessage = kind === 'aborted' ? t.watchAborted(title) : t.watchFailed(title, error ?? kind)
      for (const chatId of watchers) void this.reply(chatId, watchMessage)
      return
    }
    if (turn === undefined) return
    const seconds = (endedAt - turn.startedAt) / 1000
    const s = this.settings()
    const summary = { seconds, tools: turn.tools, files: turn.files ?? [] }
    const wanted = s.turnSummary === 'always' || (s.turnSummary === 'long' && seconds >= s.turnSummaryMinSec)
    if (wanted) for (const chatId of chats) void this.reply(chatId, t.turnDone(summary))
    if (watchers.length > 0) {
      const excerpt = turn.lastText === undefined ? undefined : truncate(turn.lastText, EXCERPT_LENGTH)
      const message = t.turnDone({ ...summary, title, ...(excerpt === undefined ? {} : { excerpt }) })
      for (const chatId of watchers) void this.reply(chatId, message)
    }
  }

  /**
   * Add a tool call to the Session's activity message. Calls between two
   * replies share one message that is edited in place (edits do not notify),
   * so a long run of commands does not flood the chat.
   */
  private queueToolLine(sessionId: string, name: string, args: string): void {
    const preview = previewArguments(args, TOOL_PREVIEW_LENGTH)
    const line = `🔧 ${name}${preview === '' ? '' : ` · ${preview}`}`
    // The history viewer keeps every call.
    for (const chatId of this.outputChats(sessionId)) this.log({ chatId }, { dir: 'out', kind: 'tool', text: line }, sessionId)
    let activity = this.toolBatches.get(sessionId)
    if (activity === undefined) {
      activity = { lines: [], count: 0, messages: new Map(), timer: undefined, lastFlush: 0, pending: Promise.resolve() }
      this.toolBatches.set(sessionId, activity)
    }
    activity.lines.push(line)
    if (activity.lines.length > TOOL_LINES_SHOWN) activity.lines.shift()
    activity.count++
    if (activity.timer !== undefined) return
    const current = activity
    current.timer = setTimeout(() => {
      current.timer = undefined
      this.renderTools(sessionId, current)
    }, Math.max(0, current.lastFlush + TOOL_BATCH_MS - Date.now()))
  }

  /** Send or edit the activity message in every output chat. */
  private renderTools(sessionId: string, activity: ToolActivity): Promise<void> {
    activity.lastFlush = Date.now()
    const hidden = activity.count - activity.lines.length
    const text = [this.t.toolActivity(activity.count), ...(hidden > 0 ? ['…'] : []), ...activity.lines].join('\n')
    // Each chat's send queue is serial, so an edit runs after the send that
    // created its message; the id is read when the operation runs.
    const sends = this.outputChats(sessionId).map(chatId => this.enqueue(chatId, async (client) => {
      const messageId = activity.messages.get(chatId)
      if (messageId === undefined) activity.messages.set(chatId, (await client.sendMessage(chatId, text)).message_id)
      else await client.editMessageText(chatId, messageId, text).catch(() => {})
    }))
    activity.pending = Promise.all(sends).then(() => {})
    return activity.pending
  }

  /** Close the activity message: show its last state, and start a new one after the next reply. */
  private flushTools(sessionId: string): void {
    const activity = this.toolBatches.get(sessionId)
    if (activity === undefined) return
    this.toolBatches.delete(sessionId)
    if (activity.timer !== undefined) {
      clearTimeout(activity.timer)
      activity.timer = undefined
      void this.renderTools(sessionId, activity)
    }
  }

  /**
   * Follow the live reply as it is written: a draft message per chat, edited
   * at most every {@link DRAFT_INTERVAL_MS}, finalized when the reply commits.
   * @param sessionId - the Agent's Session (top-level Agents only).
   * @param frame - one assistant stream frame.
   */
  onAssistantStream(sessionId: string, frame: { type: string; chunk?: { type: string; text?: string }; outcome?: { kind: string } }): void {
    if (this.client === undefined || !this.settings().streamReplies) return
    if (frame.type === 'start') {
      const old = this.drafts.get(sessionId)
      if (old !== undefined) clearTimeout(old.timer)
      // A new attempt replaces an abandoned one's draft text; its messages are reused.
      this.drafts.set(sessionId, { text: '', messages: old?.messages ?? new Map(), lastFlush: 0, timer: undefined, pending: old?.pending ?? Promise.resolve() })
      return
    }
    const draft = this.drafts.get(sessionId)
    if (draft === undefined) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
      draft.text += frame.chunk.text
      this.scheduleDraft(sessionId, draft)
    }
  }

  private scheduleDraft(sessionId: string, draft: Draft): void {
    if (draft.timer !== undefined || draft.text.trim().length < DRAFT_MIN_CHARS) return
    const wait = Math.max(0, draft.lastFlush + DRAFT_INTERVAL_MS - Date.now())
    draft.timer = setTimeout(() => {
      draft.timer = undefined
      draft.lastFlush = Date.now()
      const text = draftPreview(draft.text)
      draft.pending = draft.pending.then(() => this.showDraft(sessionId, draft, text)).catch(() => {})
    }, wait)
  }

  private async showDraft(sessionId: string, draft: Draft, text: string): Promise<void> {
    for (const chatId of this.store.chatsFor(sessionId)) {
      const messageId = draft.messages.get(chatId)
      if (messageId === undefined) {
        await this.enqueue(chatId, async (client) => {
          const sent = await client.sendMessage(chatId, text)
          draft.messages.set(chatId, sent.message_id)
        })
      } else {
        await this.client?.editMessageText(chatId, messageId, text).catch(() => {})
      }
    }
  }

  /** Deliver a committed reply: replace the draft when there is one, else send it. */
  private async finishDraft(sessionId: string, chats: number[], text: string): Promise<void> {
    const draft = this.drafts.get(sessionId)
    this.drafts.delete(sessionId)
    if (draft !== undefined) {
      clearTimeout(draft.timer)
      await draft.pending
    }
    for (const chatId of chats) {
      void this.deliverMarkdown(chatId, text, draft?.messages.get(chatId)).then(() => {
        this.log({ chatId }, { dir: 'out', kind: 'assistant', text }, sessionId)
      })
    }
  }

  /**
   * Send Markdown as Telegram HTML, split to size; falls back to plain text when Telegram rejects the markup.
   * @param replaceId - a draft message to turn into the first piece.
   */
  private deliverMarkdown(chatId: number, markdown: string, replaceId?: number): Promise<void> {
    return this.enqueue(chatId, async (client) => {
      let first = true
      for (const piece of chunkMarkdown(markdown)) {
        const html = markdownToTelegramHtml(piece)
        const target = first ? replaceId : undefined
        first = false
        try {
          if (target === undefined) await client.sendMessage(chatId, html, { parseMode: 'HTML' })
          else await client.editMessageText(chatId, target, html, 'HTML')
        } catch (error: unknown) {
          if (!(error instanceof TelegramApiError) || error.code !== 400) throw error
          if (/not modified/iu.test(error.description)) continue
          for (const plain of chunkText(piece)) {
            if (target === undefined) await client.sendMessage(chatId, plain)
            else await client.editMessageText(chatId, target, plain).catch(() => client.sendMessage(chatId, plain))
          }
        }
      }
    })
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
    if (client === undefined || this.typing.has(sessionId)) return
    if (this.store.chatsFor(sessionId).length === 0) return
    const tick = (): void => {
      for (const chatId of this.store.chatsFor(sessionId)) void client.sendTyping(chatId).catch(() => {})
    }
    tick()
    this.typing.set(sessionId, setInterval(tick, TYPING_INTERVAL_MS))
  }

  private stopTyping(sessionId: string): void {
    clearInterval(this.typing.get(sessionId))
    this.typing.delete(sessionId)
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

  /** Send plain text to a chat in order, split to Telegram's size limit. */
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
      this.logger.warn(`switchboard: send to chat ${chatId} failed: ${describe(error)}`)
    })
    this.sendTails.set(chatId, next)
    void next.then(() => {
      if (this.sendTails.get(chatId) === next) this.sendTails.delete(chatId)
    })
    return next
  }

  // ─── approvals and pickers ──────────────────────────────────────────────

  /**
   * Ask the chats bound to or following a Session to approve one tool call.
   * @param request - the Session, tool, optional call id and reason, and withdrawal signal.
   * @returns the Telegram answer, or `delegate` when no chat is linked, approvals are off, or the wait timed out.
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
    const chats = [...new Set([...this.outputChats(request.sessionId), ...this.store.watchersOf(request.sessionId)])]
    if (chats.length === 0) return 'delegate'
    if (request.signal?.aborted === true) return 'cancelled'
    // The question should follow the reply that led to it.
    this.flushTools(request.sessionId)
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
          }, request.sessionId)
        }
        answer.resolve(outcome)
      },
    }
    const onAbort = (): void => { pending.settle('cancelled', t.approvalCancelled) }
    const timer = setTimeout(() => { pending.settle('delegate', t.approvalTimedOut) }, s.approvalTimeoutSec * 1000)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.approvals.set(id, pending)

    // Through each chat's queue, so the question follows the messages that led to it.
    await Promise.all(chats.map(chatId => this.enqueue(chatId, async (c) => {
      const sent = await c.sendMessage(chatId, text, { buttons })
      pending.prompts.push({ chatId, messageId: sent.message_id })
    })))
    if (pending.prompts.length === 0) pending.settle('delegate', '')
    return answer.promise
  }

  /**
   * Ask the Agent's questions in the chats bound to or following a Session.
   * @returns the answers, `delegate` when no chat is linked, the feature is off, or nobody answered in time.
   */
  async requestAnswers(request: { sessionId: string; questions: readonly QuestionItem[]; signal?: AbortSignal }): Promise<QuestionAnswer | 'delegate' | 'cancelled'> {
    const s = this.settings()
    const client = this.client
    if (!s.questionsViaTelegram || client === undefined || this.state.kind !== 'running' || request.questions.length === 0) return 'delegate'
    const chats = [...new Set([...this.outputChats(request.sessionId), ...this.store.watchersOf(request.sessionId)])]
    if (chats.length === 0) return 'delegate'
    if (request.signal?.aborted === true) return 'cancelled'
    this.flushTools(request.sessionId)
    const t = this.t
    const id = randomUUID().slice(0, 8)
    const answer = Promise.withResolvers<QuestionAnswer | 'delegate' | 'cancelled'>()
    const pending: PendingQuestions = {
      sessionId: request.sessionId,
      chats,
      items: request.questions.map(item => ({ item, messages: new Map(), selected: new Set(), done: false })),
      settle: (outcome, note) => {
        if (!this.questions.delete(id)) return
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        for (const entry of pending.items) {
          const summary = note ?? (entry.custom !== undefined
            ? t.questionAnswered([...entry.selected, entry.custom].join(', '))
            : entry.selected.size > 0 ? t.questionAnswered([...entry.selected].join(', ')) : t.questionSkipped)
          for (const [chatId, messageId] of entry.messages) {
            void client.editMessageText(chatId, messageId, `${questionText(t, entry.item)}\n\n${summary}`).catch(() => {})
          }
        }
        answer.resolve(outcome)
      },
    }
    const onAbort = (): void => { pending.settle('cancelled', t.questionWithdrawn) }
    const timer = setTimeout(() => { pending.settle('delegate', t.questionTimedOut) }, s.approvalTimeoutSec * 1000)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.questions.set(id, pending)
    for (const [index, entry] of pending.items.entries()) {
      const text = questionText(t, entry.item)
      for (const chatId of chats) {
        await this.enqueue(chatId, async (c) => {
          const sent = await c.sendMessage(chatId, text, { buttons: questionButtons(t, id, index, entry) })
          entry.messages.set(chatId, sent.message_id)
        })
        this.log({ chatId }, { dir: 'out', kind: 'notice', text }, request.sessionId)
      }
    }
    if (pending.items.every(entry => entry.messages.size === 0)) pending.settle('delegate', '')
    return answer.promise
  }

  /** Take free text in a chat as the answer to its oldest unanswered question. */
  private answerByText(chatId: number, text: string): boolean {
    for (const pending of this.questions.values()) {
      if (!pending.chats.includes(chatId)) continue
      const entry = pending.items.find(candidate => !candidate.done)
      if (entry === undefined) continue
      entry.custom = text
      entry.done = true
      this.afterAnswer(pending)
      return true
    }
    return false
  }

  /** Settle the request once every question has an answer. */
  private afterAnswer(pending: PendingQuestions): void {
    if (pending.items.every(entry => entry.done)) {
      pending.settle({
        answers: pending.items.map(entry => ({
          id: entry.item.id,
          selected: [...entry.selected],
          ...(entry.custom === undefined ? {} : { custom: entry.custom }),
        })),
      })
    }
  }

  private async handleQuestionPress(client: TelegramClient, query: TgCallbackQuery): Promise<void> {
    const [, id = '', index = '', action = ''] = (query.data ?? '').split(':')
    const pending = this.questions.get(id)
    const entry = pending?.items[Number(index)]
    if (pending === undefined || entry === undefined || entry.done) {
      await client.answerCallbackQuery(query.id, this.t.approvalGone)
      return
    }
    await client.answerCallbackQuery(query.id)
    const options = entry.item.options ?? []
    if (action === 's') {
      entry.selected.clear()
      entry.done = true
    } else if (action === 'd') {
      entry.done = true
    } else {
      const label = options[Number(action)]?.label
      if (label === undefined) return
      if (entry.item.multiSelect === true) {
        if (entry.selected.has(label)) entry.selected.delete(label)
        else entry.selected.add(label)
        for (const [chatId, messageId] of entry.messages) {
          void client.call('editMessageReplyMarkup', {
            chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: questionButtons(this.t, id, Number(index), entry) },
          }).catch(() => {})
        }
        return
      }
      entry.selected.add(label)
      entry.done = true
    }
    this.afterAnswer(pending)
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const client = this.client
    if (client === undefined) return
    const t = this.t
    const chat = query.message?.chat ?? { id: 0, type: 'private' as const }
    if (!this.allowed(query.from, chat)) {
      await client.answerCallbackQuery(query.id, t.unauthorized(query.from.id))
      return
    }
    if (query.data?.startsWith('pk:') === true) return this.handlePick(client, query)
    if (query.data?.startsWith('qa:') === true) return this.handleQuestionPress(client, query)
    const match = /^ap:([\w-]+):([yn])$/u.exec(query.data ?? '')
    if (match === null) {
      await client.answerCallbackQuery(query.id)
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

  private async handlePick(client: TelegramClient, query: TgCallbackQuery): Promise<void> {
    const [, id = '', index = ''] = (query.data ?? '').split(':')
    const picker = this.pickers.get(id)
    const chatId = query.message?.chat.id
    if (picker === undefined || chatId === undefined) {
      await client.answerCallbackQuery(query.id, this.t.modelPickerExpired)
      return
    }
    await client.answerCallbackQuery(query.id)
    if (picker.kind === 'model') {
      const picked = picker.choices[Number(index)]
      if (picked !== undefined) await this.switchModel(chatId, picker.sessionId, picked.choice, picked.name)
    } else {
      const picked = picker.choices[Number(index)]
      if (picked !== undefined) await this.switchMode(chatId, picker.sessionId, picked)
    }
  }
}

/** The text of one question message. */
function questionText(t: Messages, item: QuestionItem): string {
  return t.question(item.header, item.question, item.detail, item.multiSelect === true)
}

/** Option buttons, ticked for a multi-select question, plus Done/Skip. */
function questionButtons(t: Messages, id: string, index: number, entry: { item: QuestionItem; selected: Set<string> }): TgInlineButton[][] {
  const rows: TgInlineButton[][] = (entry.item.options ?? []).slice(0, PICKER_BUTTONS).map((option, optionIndex) => [{
    text: `${entry.item.multiSelect === true && entry.selected.has(option.label) ? '☑ ' : entry.item.multiSelect === true ? '☐ ' : ''}${option.label}`.slice(0, 60),
    callback_data: `qa:${id}:${index}:${optionIndex}`,
  }])
  const tail: TgInlineButton[] = []
  if (entry.item.multiSelect === true) tail.push({ text: t.questionDone, callback_data: `qa:${id}:${index}:d` })
  tail.push({ text: t.questionSkip, callback_data: `qa:${id}:${index}:s` })
  rows.push(tail)
  return rows
}

/** `provider/model`, plus the effort when one is pinned. */
export function modelLabel(choice: ModelChoice): string {
  return `${choice.provider}/${choice.model}${choice.reasoningEffort === undefined ? '' : ` (${choice.reasoningEffort})`}`
}

/** A Session id short enough for a notification line. */
function shortId(sessionId: string): string {
  const core = sessionId.replace(/^session-/u, '')
  return core.length > 8 ? core.slice(0, 8) : core
}

/** The tail of a reply in progress, sized for one message. */
function draftPreview(text: string): string {
  const trimmed = text.trimEnd()
  const body = trimmed.length > 3800 ? `…${trimmed.slice(-3800)}` : trimmed
  return `${body} ▍`
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
