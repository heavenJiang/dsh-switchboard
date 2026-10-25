/**
 * Switchboard core: runs one adapter per configured line (Telegram, Feishu),
 * turns messages and commands into Session operations, mirrors assistant
 * output back to the bound chats (rendered from Markdown, streamed as a draft
 * while it is written), and asks tool approvals with buttons. Photos, files,
 * and voice notes are staged into the Session; files the Agent presents are
 * sent back. Chats can follow Sessions they do not drive for completion and
 * approval notices, and scheduled runs can report to chosen chats.
 *
 * Chats are known by chat keys (see `lines.ts`), so one Session can be
 * followed from several platforms at once. Harness access goes through
 * {@link HarnessPort}, so this module does not touch Cordis and can be
 * exercised with a fake.
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BindingStore, PendingChoice } from './bindings.ts'
import { FeishuChannel, type FeishuApi } from './channels/feishu.ts'
import { createFeishuApi } from './channels/feishu-api.ts'
import { TelegramChannel } from './channels/telegram.ts'
import type {
  Button, Channel, ChannelChat, ChannelSink, ChannelUser, InboundAction, InboundAttachment, InboundMessage, LineState,
} from './channels/types.ts'
import type { ChatAttachment, ChatEntry, ChatInfo, ChatLog } from './chatlog.ts'
import { chatKey, splitChatKey, type LineSettings } from './lines.ts'
import { outgoingKind, promptImageType, sniffImageType } from './media.ts'
import { MESSAGES, type BotLanguage, type Messages } from './messages.ts'
import { chunkText, isAllowed, parseInput, previewArguments, truncate } from './text.ts'

export type { LineState } from './channels/types.ts'

/** When to post a summary at the end of a bound Session's turn. */
export type TurnSummaryMode = 'off' | 'long' | 'always'

/** Live settings the bridge reads at the start of each operation. */
export interface BridgeSettings {
  readonly enabled: boolean
  /** Lines to run; secrets already resolved. */
  readonly lines: readonly LineSettings[]
  /** Working directory for new Sessions when neither the chat nor its line set one. */
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly approvalViaTelegram: boolean
  /** Ask the Agent's questions (ask_user_question) in chats too. */
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
  /** Chat keys that receive scheduled-run results. */
  readonly scheduleChats: readonly string[]
  readonly language: BotLanguage
  /** Largest file accepted from a chat, in MB (the public Telegram Bot API serves at most 20). */
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

/** How the bridge builds adapters; tests substitute transports. */
export interface ChannelOptions {
  /** Fetch for Telegram lines. */
  readonly fetch?: typeof fetch
  /** Open Platform client for a Feishu line. */
  readonly feishu?: (line: LineSettings) => FeishuApi
}

/** Approval answer from a chat, or a hand-back to the next answerer. */
export type TelegramApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'delegate'

/** One question waiting on a button. */
interface PendingApproval {
  readonly sessionId: string
  readonly prompts: { chat: string; messageId: string }[]
  settle(outcome: TelegramApprovalOutcome, note: string, by?: string): void
}

/** One question the Agent asked, as a chat shows it. */
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

/** A question request waiting on its chats. */
interface PendingQuestions {
  readonly sessionId: string
  readonly chats: string[]
  readonly items: {
    readonly item: QuestionItem
    /** Message id per chat key. */
    readonly messages: Map<string, string>
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
  /** Draft message per chat key, once sent. */
  readonly messages: Map<string, string>
  lastFlush: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** The send or edit in flight; finalization waits for it. */
  pending: Promise<void>
}

/** Tool calls between two replies, shown as one message edited in place. */
interface ToolActivity {
  readonly lines: string[]
  count: number
  readonly messages: Map<string, string>
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

/** One running line. */
interface LiveLine {
  readonly line: LineSettings
  readonly channel: Channel
  readonly controller: AbortController
  done: Promise<void>
  /** Restart key: the line's settings, secret included. */
  readonly key: string
  state: LineState
  /** Whether the line's menu already lists Harness commands (filled once a Session can list them). */
  menuHasHarness: boolean
}

/** Observable connection state for `/status` and logs. */
export type BridgeState = LineState

/** The bridge's own commands; a Harness command of the same name is reached only from the Web. */
const BRIDGE_COMMANDS = new Set([
  'start', 'help', 'new', 'cwd', 'use', 'sessions', 'watch', 'unwatch', 'stop', 'steer', 'queue', 'cancel',
  'status', 'model', 'mode', 'get', 'whoami',
])
/** Harness commands that only make sense in the Web composer (`/switchboard` links a Web Session to a chat). */
const WEB_ONLY_COMMANDS = new Set(['switchboard'])
/** Telegram's command-name rule for the bot menu. */
const MENU_NAME = /^[a-z0-9_]{1,32}$/u

/** Images up to this size are copied into the history for the viewer. */
const VIEWER_IMAGE_LIMIT = 5 * 1024 * 1024
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
}
const TYPING_INTERVAL_MS = 4500
const TOOL_PREVIEW_LENGTH = 200
/** Tool lines arriving within this window go out as one message (Telegram allows about one message per second per chat). */
const TOOL_BATCH_MS = 1500
/** Lines an activity message shows; older calls fold into its count. */
const TOOL_LINES_SHOWN = 12
/** Draft edits are at least this far apart. */
const DRAFT_INTERVAL_MS = 1500
/** A draft appears once the reply has this much text. */
const DRAFT_MIN_CHARS = 40
/** Buttons in one /model picker; longer catalogs are reached by name. */
const PICKER_BUTTONS = 30
const PICKER_TTL_MS = 10 * 60 * 1000
/** A stranger hears the "not authorized" reply at most this often. */
const DENIED_REPLY_INTERVAL_MS = 60 * 60 * 1000
const DIRECTORY_LIST_LIMIT = 50
const EXCERPT_LENGTH = 400

/** The bridge core. One instance lives for the plugin's lifetime; lines restart when their settings change. */
export class Switchboard {
  private readonly live = new Map<string, LiveLine>()
  private readonly sendTails = new Map<string, Promise<void>>()
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestions>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  /** One edited "tool activity" message per Session and chat, until the next reply. */
  private readonly toolBatches = new Map<string, ToolActivity>()
  private readonly drafts = new Map<string, Draft>()
  private readonly turns = new Map<string, TurnState>()
  private readonly pickers = new Map<string, Picker>()
  /** The last /sessions listing per chat, so `/use 2` and `/watch 2` work. */
  private readonly listings = new Map<string, string[]>()
  private readonly deniedReplies = new Map<string, number>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly settings: () => BridgeSettings,
    private readonly harness: HarnessPort,
    private readonly store: BindingStore,
    private readonly logger: BridgeLogger,
    private readonly channelOptions: ChannelOptions = {},
    private readonly chatLog?: ChatLog,
  ) {}

  /** State of the first line, for callers that know only one. */
  get state(): BridgeState {
    return this.live.values().next().value?.state ?? { kind: 'stopped' }
  }

  /** @returns the first line's bot handle while connected. */
  get username(): string | undefined {
    const state = this.state
    return state.kind === 'running' ? state.username : undefined
  }

  /** Every configured line with its connection state. */
  lineStates(): { id: string; type: LineSettings['type']; name: string; state: LineState }[] {
    return this.settings().lines.map(line => ({
      id: line.id, type: line.type, name: line.name,
      state: this.live.get(line.id)?.state ?? { kind: 'stopped' },
    }))
  }

  private get t(): Messages {
    return MESSAGES[this.settings().language]
  }

  /** Append to the Web viewer's history; failures are logged, never surfaced in the chat. */
  private log(chat: ChatInfo, entry: Omit<ChatEntry, 'id' | 'at' | 'sessionId'>, sessionId?: string): void {
    if (this.chatLog === undefined) return
    const session = sessionId ?? this.store.get(chat.chatId).sessionId
    void this.chatLog.record(chat, { ...entry, ...(session === undefined ? {} : { sessionId: session }) }).catch((error: unknown) => {
      this.logger.warn(`switchboard: chat history write failed: ${describe(error)}`)
    })
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  /** Start, stop, or restart lines so they match the current settings. */
  async reconcile(): Promise<void> {
    const s = this.settings()
    const wanted = new Map(s.lines
      .filter(line => s.enabled && line.enabled && (line.secret ?? '') !== '')
      .map(line => [line.id, line] as const))
    for (const [id, running] of [...this.live]) {
      const line = wanted.get(id)
      if (line === undefined || lineKey(line) !== running.key) await this.stopLine(id)
    }
    for (const [id, line] of wanted) {
      if (!this.live.has(id)) this.startLine(line)
    }
  }

  private startLine(line: LineSettings): void {
    const logger = {
      info: (message: string) => { this.logger.info(`switchboard [${line.id}]: ${message}`) },
      warn: (message: string) => { this.logger.warn(`switchboard [${line.id}]: ${message}`) },
      debug: (message: string) => { this.logger.debug(`switchboard [${line.id}]: ${message}`) },
    }
    const channel: Channel = line.type === 'feishu'
      ? new FeishuChannel(line, {
        api: this.channelOptions.feishu?.(line) ?? createFeishuApi(line, logger, this.channelOptions.fetch === undefined ? {} : { fetch: this.channelOptions.fetch }),
        logger,
      })
      : new TelegramChannel(line, {
        cursor: { get: () => this.store.offset(line.id), set: offset => this.store.setOffset(line.id, offset) },
        logger,
        ...(this.channelOptions.fetch === undefined ? {} : { fetch: this.channelOptions.fetch }),
      })
    const controller = new AbortController()
    const entry: LiveLine = { line, channel, controller, done: Promise.resolve(), key: lineKey(line), state: { kind: 'connecting' }, menuHasHarness: false }
    const sink: ChannelSink = {
      state: (state) => {
        const connected = state.kind === 'running' && entry.state.kind !== 'running'
        entry.state = state
        if (connected) {
          logger.info(`connected as ${line.type === 'telegram' ? '@' : ''}${state.username}`)
          void this.registerCommands(entry)
        }
      },
      message: message => this.handleMessage(entry, message),
      action: action => this.handleAction(entry, action),
    }
    this.live.set(line.id, entry)
    entry.done = channel.run(sink, controller.signal).catch((error: unknown) => {
      entry.state = { kind: 'error', message: describe(error) }
      logger.warn(`stopped: ${describe(error)}`)
    })
  }

  private async stopLine(id: string): Promise<void> {
    const entry = this.live.get(id)
    if (entry === undefined) return
    entry.controller.abort()
    await entry.done
    this.live.delete(id)
  }

  /** Stop every line, withdraw pending approvals, and stop typing indicators. */
  async stop(): Promise<void> {
    for (const approval of this.approvals.values()) approval.settle('delegate', this.t.approvalCancelled)
    for (const pending of this.questions.values()) pending.settle('delegate', this.t.questionTimedOut)
    for (const timer of this.typing.values()) clearInterval(timer)
    this.typing.clear()
    for (const sessionId of [...this.toolBatches.keys()]) this.flushTools(sessionId)
    for (const draft of this.drafts.values()) clearTimeout(draft.timer)
    this.drafts.clear()
    await Promise.allSettled([...this.sendTails.values()])
    for (const id of [...this.live.keys()]) await this.stopLine(id)
  }

  /** Stop for good: also abort in-flight transcriptions. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.stop()
  }

  /** The bot menu: the bridge's main commands, then the Harness commands Telegram can name. */
  private async registerCommands(entry: LiveLine, harnessCommands?: readonly HarnessCommand[]): Promise<void> {
    const t = this.t
    const extra = (harnessCommands ?? await this.harness.listCommands(undefined).catch(() => []))
      .filter(command => MENU_NAME.test(command.name) && !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
      .slice(0, 20)
      .map(command => ({ command: command.name, description: truncate(command.description || command.name, 256) }))
    entry.menuHasHarness = extra.length > 0
    await entry.channel.setMenu([
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
      this.logger.debug(`switchboard [${entry.line.id}]: menu update failed: ${describe(error)}`)
    })
  }

  // ─── inbound ────────────────────────────────────────────────────────────

  /** Whether a user (or the whole chat) may drive the Harness through a line. */
  private allowed(line: LineSettings, user: ChannelUser, chat: ChannelChat | undefined): boolean {
    if ([user.id, ...(user.aliases ?? [])].some(id => isAllowed(line.allowedUsers, id, user.username))) return true
    return chat !== undefined && line.allowedChats.some(id => id.trim() === chat.id)
  }

  /** A running line's current settings (access lists and directories change without a restart). */
  private settingsOf(entry: LiveLine): LineSettings {
    return this.settings().lines.find(line => line.id === entry.line.id) ?? entry.line
  }

  private async handleMessage(entry: LiveLine, message: InboundMessage): Promise<void> {
    const { channel } = entry
    const line = this.settingsOf(entry)
    const key = chatKey(line.id, message.chat.id)
    const from = message.from
    const t = this.t
    const text = message.text
    // In groups the bot answers only what is addressed to it.
    const isCommand = text?.trimStart().startsWith('/') === true
    if (message.chat.type === 'group' && line.groupMentionOnly && !message.addressed && !isCommand) return
    const parsed = text === undefined ? undefined : parseInput(text, channel.username)
    const allowed = this.allowed(line, from, message.chat)
    const attachments = message.attachments
    const chat = chatInfo(key, message.chat)
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
      return this.reply(key, t.whoami(from.id, message.chat.id))
    }
    if (!allowed) {
      // Answer strangers only in private chats, and only now and then, so nobody can make the bot spam.
      const strangerKey = `${line.id}:${from.id}`
      const last = this.deniedReplies.get(strangerKey) ?? 0
      if (message.chat.type === 'private' && Date.now() - last > DENIED_REPLY_INTERVAL_MS) {
        this.deniedReplies.set(strangerKey, Date.now())
        await this.reply(key, t.unauthorized(from.id))
      }
      return
    }
    try {
      if (message.voice !== undefined && this.settings().transcribeVoice) return await this.promptWithVoice(key, message)
      if (attachments.length > 0) return await this.promptWithMedia(key, message)
      if (text === undefined) return await this.reply(key, t.unsupported)
      if (parsed === undefined) return
      if (parsed.kind === 'text' && this.answerByText(key, parsed.text)) return
      if (parsed.kind === 'text') return await this.promptFromChat(key, [{ type: 'text', text: parsed.text }], 'queue')
      return await this.runCommand(key, parsed.name, parsed.args)
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  /**
   * Download every attachment of one message (or album), stage it into the
   * chat's Session, and prompt with the text plus the receipts.
   */
  private async promptWithMedia(key: string, message: InboundMessage, note?: string): Promise<void> {
    const channel = this.channelOf(key)
    if (channel === undefined) return
    const t = this.t
    const sessionId = await this.ensureSession(key)
    if (sessionId === undefined) return
    const limit = this.settings().maxDownloadMb * 1024 * 1024
    const parts: PromptPart[] = []
    const caption = (message.text ?? '').trim()
    const logged: ChatAttachment[] = []
    this.startTyping(sessionId)
    for (const attachment of message.attachments) {
      try {
        const data = await channel.download(attachment, limit)
        const imageType = promptImageType(attachment, data)
        const receiptId = await this.harness.stageFile(sessionId, {
          data,
          name: attachment.name,
          ...(imageType === undefined ? {} : { imageType }),
        })
        parts.push({ type: 'file', receiptId })
        logged.push(await this.viewerAttachment(key, attachment.name, data, imageType))
      } catch (error: unknown) {
        logged.push({ name: attachment.name, kind: 'file', ...(attachment.size === undefined ? {} : { size: attachment.size }) })
        await this.reply(key, t.attachmentFailed(attachment.name, describe(error)))
      }
    }
    this.log(chatInfo(key, message.chat), {
      dir: 'in', kind: 'media', from: sender(message.from), attachments: logged,
      ...(caption === '' ? {} : { text: caption }),
    })
    if (note !== undefined) await this.reply(key, note)
    if (parts.length === 0) {
      this.stopTyping(sessionId)
      return
    }
    if (caption !== '') parts.unshift({ type: 'text', text: caption })
    await this.harness.prompt(sessionId, parts, 'queue')
  }

  /**
   * Transcribe a voice note and prompt with the text; when the host cannot
   * transcribe, the note goes to the Agent as an audio file instead.
   */
  private async promptWithVoice(key: string, message: InboundMessage): Promise<void> {
    const channel = this.channelOf(key)
    const voice: InboundAttachment | undefined = message.voice
    if (channel === undefined || voice === undefined) return
    const t = this.t
    let transcript: string
    try {
      const limit = this.settings().maxDownloadMb * 1024 * 1024
      const audio = await channel.download(voice, limit)
      transcript = (await this.harness.transcribe(audio, this.lifetime.signal)).trim()
    } catch (error: unknown) {
      return this.promptWithMedia(key, message, t.voiceUnavailable(describe(error)))
    }
    if (transcript === '') return this.reply(key, t.voiceEmpty)
    const caption = (message.text ?? '').trim()
    const text = caption === '' ? transcript : `${caption}\n\n${transcript}`
    this.log(chatInfo(key, message.chat), { dir: 'in', kind: 'text', from: sender(message.from), text: `🎤 ${text}` })
    await this.reply(key, t.voiceHeard(transcript))
    await this.promptFromChat(key, [{ type: 'text', text }], 'queue')
  }

  /** Describe an attachment for the history, keeping a copy of images the viewer can show. */
  private async viewerAttachment(key: string, name: string, data: Uint8Array, imageType?: string): Promise<ChatAttachment> {
    const base = { name, size: data.byteLength }
    if (imageType === undefined || this.chatLog === undefined || data.byteLength > VIEWER_IMAGE_LIMIT) return { ...base, kind: imageType === undefined ? 'file' : 'image' }
    const media = await this.chatLog.saveMedia(key, IMAGE_EXTENSIONS[imageType] ?? '', data).catch(() => undefined)
    return { ...base, kind: 'image', ...(media === undefined ? {} : { media }) }
  }

  // ─── commands ───────────────────────────────────────────────────────────

  private async runCommand(key: string, name: string, args: string): Promise<void> {
    const t = this.t
    const binding = this.store.get(key)
    switch (name) {
      case 'start':
      case 'help': {
        const commands = (await this.harness.listCommands(binding.sessionId).catch(() => []))
          .filter(command => !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
        const entry = this.live.get(splitChatKey(key).line)
        if (commands.length > 0 && entry !== undefined && !entry.menuHasHarness) void this.registerCommands(entry, commands)
        const lines = commands.map(command => `/${command.name}${command.hint === undefined ? '' : ` ${command.hint}`} — ${command.description}`)
        return this.reply(key, lines.length === 0 ? t.help : `${t.help}\n\n${t.harnessCommands}\n${lines.join('\n')}`)
      }
      case 'new': {
        const cwd = args === '' ? this.defaultWorkspace(key) : args
        if (cwd === undefined) return this.reply(key, t.noWorkspace)
        const sessionId = await this.newSession(key, cwd)
        return this.reply(key, t.created(sessionId, cwd))
      }
      case 'cwd': {
        if (args === '') return this.reply(key, this.defaultWorkspace(key) ?? t.noWorkspace)
        if (!(await isDirectory(args))) return this.reply(key, t.badWorkspace(args))
        await this.store.update(key, { workspacePath: args })
        return this.reply(key, t.cwdSet(args))
      }
      case 'use': {
        if (args === '') return this.reply(key, t.useUsage)
        const sessionId = this.sessionRef(key, args)
        await this.store.update(key, { sessionId })
        await this.chatLog?.bind(key, sessionId).catch(() => {})
        this.attachToWorkspace(sessionId)
        return this.reply(key, t.bound(sessionId))
      }
      case 'sessions': {
        const rows = (await this.harness.listSessions()).slice(0, 10)
        this.listings.set(key, rows.map(row => row.sessionId))
        const lines = rows.map((row, index) =>
          `${index + 1}. ${row.running ? '▶' : '·'} ${row.sessionId}${row.cwd === undefined ? '' : `  ${row.cwd}`}${row.sessionId === binding.sessionId ? ' ✓' : ''}`)
        return this.reply(key, t.sessions(lines))
      }
      case 'watch': {
        if (args === '') return this.reply(key, t.watching((binding.watch ?? []).map(id => `· ${id}`)))
        const sessionId = this.sessionRef(key, args)
        await this.store.setWatch(key, sessionId, true)
        this.attachToWorkspace(sessionId)
        return this.reply(key, t.watchOn(sessionId))
      }
      case 'unwatch': {
        if (args.trim().toLowerCase() === 'all') {
          for (const id of binding.watch ?? []) await this.store.setWatch(key, id, false)
          return this.reply(key, t.watchOffAll)
        }
        if (args === '') return this.reply(key, t.watching((binding.watch ?? []).map(id => `· ${id}`)))
        const sessionId = this.sessionRef(key, args)
        await this.store.setWatch(key, sessionId, false)
        return this.reply(key, t.watchOff(sessionId))
      }
      case 'stop': {
        if (binding.sessionId === undefined) return this.reply(key, t.noSession)
        const live = this.harness.live(binding.sessionId)
        if (live?.running !== true || !this.harness.cancel(binding.sessionId)) return this.reply(key, t.notRunning)
        return this.reply(key, t.stopped)
      }
      case 'steer': {
        if (args === '') return this.reply(key, t.steerUsage)
        return this.promptFromChat(key, [{ type: 'text', text: args }], 'steer')
      }
      case 'queue': {
        if (binding.sessionId === undefined) return this.reply(key, t.noSession)
        const items = this.harness.queued(binding.sessionId)
        if (items === undefined) return this.reply(key, t.queueNotLive)
        return this.reply(key, t.queueList(items.map((item, index) => `${index + 1}. ${truncate(item.text.replace(/\s+/gu, ' '), 80)}`)))
      }
      case 'cancel': {
        if (binding.sessionId === undefined) return this.reply(key, t.noSession)
        const items = this.harness.queued(binding.sessionId)
        if (items === undefined) return this.reply(key, t.queueNotLive)
        if (args.trim().toLowerCase() === 'all') return this.reply(key, t.queueCancelled(this.harness.dropQueued(binding.sessionId, 'all')))
        const picked = args.split(/[\s,]+/u).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= items.length)
        if (picked.length === 0) return this.reply(key, t.cancelUsage)
        return this.reply(key, t.queueCancelled(this.harness.dropQueued(binding.sessionId, picked.map(n => items[n - 1]!.id))))
      }
      case 'status': {
        const live = binding.sessionId === undefined ? undefined : this.harness.live(binding.sessionId)
        const model = binding.sessionId === undefined ? undefined : this.modelOf(binding.sessionId)
        const entry = this.live.get(splitChatKey(key).line)
        const state = entry?.state ?? { kind: 'stopped' as const }
        return this.reply(key, t.status({
          bot: state.kind === 'running' ? `${entry?.line.type === 'telegram' ? '@' : ''}${state.username}` : state.kind,
          ...(binding.sessionId === undefined ? {} : { session: binding.sessionId }),
          ...(live?.cwd === undefined ? {} : { cwd: live.cwd }),
          ...(live === undefined ? {} : { running: live.running }),
          ...(model === undefined ? {} : { model: modelLabel(model) }),
        }))
      }
      case 'model':
        return this.modelCommand(key, binding.sessionId, args)
      case 'mode':
        return this.modeCommand(key, binding.sessionId, args)
      case 'get':
        return this.getCommand(key, binding.sessionId, args)
      default: {
        const line = `/${name}${args === '' ? '' : ` ${args}`}`
        // Harness commands run on the Host as in the Web composer; anything else is text for the Agent.
        if (binding.sessionId !== undefined) {
          const result = await this.harness.runCommand(binding.sessionId, line)
          if (result !== undefined) {
            return this.reply(key, result.kind === 'error'
              ? t.commandFailed(name, result.text ?? '')
              : result.text === undefined || result.text.trim() === '' ? t.commandDone(name) : result.text)
          }
        }
        return this.promptFromChat(key, [{ type: 'text', text: line }], 'queue')
      }
    }
  }

  /** Put a linked Session into its directory's Web Workspace; a failure is logged, never shown in the chat. */
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
  private sessionRef(key: string, arg: string): string {
    const value = arg.trim()
    if (/^\d{1,2}$/u.test(value)) {
      const listed = this.listings.get(key)?.[Number(value) - 1]
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
  private async modelCommand(key: string, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (sessionId === undefined) return this.reply(key, t.modelNoSession)
    const { groups } = await this.harness.listModels()
    const all = groups.flatMap(group => group.models.map(model => ({ group, model })))
    if (args === '') {
      const current = this.modelOf(sessionId)
      const choices = all.slice(0, PICKER_BUTTONS).map(({ group, model }) => ({ choice: { provider: group.provider, model: model.id }, name: model.name }))
      const buttons = all.slice(0, PICKER_BUTTONS).map(({ group, model }) =>
        `${current?.provider === group.provider && current.model === model.id ? '✓ ' : ''}${model.name} · ${group.name}`)
      return this.sendPicker(key, { kind: 'model', sessionId, choices, at: Date.now() }, buttons,
        t.modelList(current === undefined ? undefined : modelLabel(current), all.length))
    }
    const needle = args.trim().toLowerCase()
    const exact = all.filter(({ group, model }) =>
      [`${group.provider}/${model.id}`, model.id, model.name].some(value => value.toLowerCase() === needle))
    const matches = exact.length > 0 ? exact : all.filter(({ group, model }) =>
      [`${group.provider}/${model.id}`, model.name].some(value => value.toLowerCase().includes(needle)))
    if (matches.length === 0) return this.reply(key, t.modelNotFound(args))
    if (matches.length > 1) {
      return this.reply(key, t.modelAmbiguous(matches.slice(0, 10).map(({ group, model }) => `${model.name} (${group.provider}/${model.id})`)))
    }
    const { group, model } = matches[0]!
    return this.switchModel(key, sessionId, { provider: group.provider, model: model.id }, model.name)
  }

  private async switchModel(key: string, sessionId: string, choice: ModelChoice, name: string): Promise<void> {
    const t = this.t
    try {
      const applied = await this.harness.selectModel(sessionId, choice)
      await this.store.setPending(sessionId, { model: applied ? undefined : { ...choice } })
      await this.reply(key, applied ? t.modelSwitched(name, modelLabel(choice)) : t.modelPending(name, modelLabel(choice)))
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  /** `/mode` lists permission presets as buttons; `/mode <name>` switches directly. */
  private async modeCommand(key: string, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (sessionId === undefined) return this.reply(key, t.noSession)
    const options = this.harness.listPresets()
    if (args === '') {
      const current = this.store.pending(sessionId)?.preset ?? this.harness.currentPreset(sessionId)
      const currentName = options.find(option => option.value === current)?.name ?? current
      const buttons = options.map(option => `${option.value === current ? '✓ ' : ''}${option.name}${option.description === undefined ? '' : ` — ${option.description}`}`)
      return this.sendPicker(key, { kind: 'mode', sessionId, choices: options.slice(0, PICKER_BUTTONS), at: Date.now() }, buttons, t.modeList(currentName))
    }
    const needle = args.trim().toLowerCase()
    const match = options.find(option => option.value.toLowerCase() === needle || option.name.toLowerCase() === needle)
      ?? options.filter(option => option.value.toLowerCase().includes(needle) || option.name.toLowerCase().includes(needle)).at(0)
    if (match === undefined) return this.reply(key, t.modeNotFound(args))
    return this.switchMode(key, sessionId, match)
  }

  private async switchMode(key: string, sessionId: string, option: PresetOption): Promise<void> {
    const t = this.t
    try {
      const applied = this.harness.selectPreset(sessionId, option.value)
      await this.store.setPending(sessionId, { preset: applied ? undefined : option.value })
      await this.reply(key, applied ? t.modeSwitched(option.name) : t.modePending(option.name))
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  private async sendPicker(key: string, picker: Picker, labels: string[], text: string): Promise<void> {
    const id = randomUUID().slice(0, 8)
    const cutoff = Date.now() - PICKER_TTL_MS
    for (const [pickerId, old] of this.pickers) if (old.at < cutoff) this.pickers.delete(pickerId)
    while (this.pickers.size >= 32) this.pickers.delete(this.pickers.keys().next().value as string)
    this.pickers.set(id, picker)
    const buttons: Button[][] = labels.slice(0, PICKER_BUTTONS).map((label, index) => [{ text: label.slice(0, 60), data: `pk:${id}:${index}` }])
    await this.enqueue(key, async (channel, chat) => { await channel.send(chat, { text, buttons }) })
    this.log({ chatId: key }, { dir: 'out', kind: 'notice', text })
  }

  /** `/get <path>`: send a file from the working directory, or list a directory. */
  private async getCommand(key: string, sessionId: string | undefined, args: string): Promise<void> {
    const t = this.t
    if (args.trim() === '') return this.reply(key, t.getUsage)
    const base = (sessionId === undefined ? undefined : this.harness.live(sessionId)?.cwd) ?? this.defaultWorkspace(key)
    if (base === undefined) return this.reply(key, t.noWorkspace)
    const target = resolve(base, args.trim())
    let real: string
    let root: string
    try {
      root = await realpath(base)
      real = await realpath(target)
    } catch {
      return this.reply(key, t.getMissing(args.trim()))
    }
    // Symlinks resolve before the check, so a link cannot reach outside the directory.
    if (real !== root && !real.startsWith(root + sep)) return this.reply(key, t.getOutside)
    const info = await stat(real)
    if (info.isDirectory()) {
      const entries = (await readdir(real, { withFileTypes: true }))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      const lines = entries.slice(0, DIRECTORY_LIST_LIMIT).map(entry => `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`)
      return this.reply(key, t.getDir(relative(root, real) || '.', lines, entries.length - lines.length))
    }
    return this.sendLocalFile(key, real)
  }

  /** The chat's directory, else its line's, else the plugin-wide default. */
  private defaultWorkspace(key: string): string | undefined {
    const line = this.settings().lines.find(candidate => candidate.id === splitChatKey(key).line)
    const path = this.store.get(key).workspacePath ?? (line?.workspacePath.trim() || this.settings().workspacePath)
    return path.trim() === '' ? undefined : path
  }

  private async newSession(key: string, cwd: string): Promise<string> {
    if (!(await isDirectory(cwd))) throw new Error(this.t.badWorkspace(cwd))
    const s = this.settings()
    const sessionId = await this.harness.createSession(cwd, s.agentPreset, s.permissionPreset, s.model)
    await this.store.update(key, { sessionId })
    await this.chatLog?.bind(key, sessionId).catch(() => {})
    return sessionId
  }

  /** The chat's Session, creating one in the default directory when it has none. */
  private async ensureSession(key: string): Promise<string | undefined> {
    const existing = this.store.get(key).sessionId
    if (existing !== undefined) return existing
    const cwd = this.defaultWorkspace(key)
    if (cwd === undefined) {
      await this.reply(key, this.t.noWorkspace)
      return undefined
    }
    const sessionId = await this.newSession(key, cwd)
    await this.reply(key, this.t.created(sessionId, cwd))
    return sessionId
  }

  private async promptFromChat(key: string, parts: readonly PromptPart[], mode: 'queue' | 'steer'): Promise<void> {
    const sessionId = await this.ensureSession(key)
    if (sessionId === undefined) return
    this.startTyping(sessionId)
    await this.harness.prompt(sessionId, parts, mode)
  }

  // ─── Web-side operations ────────────────────────────────────────────────

  /**
   * Bind a chat to a Session from the Web UI, or make it follow the Session.
   * @param key - chat key.
   * @param mode - `active` makes the chat talk to the Session; `watch` follows it; `none` removes both.
   */
  async linkChat(key: string, sessionId: string, mode: 'active' | 'watch' | 'none'): Promise<void> {
    const t = this.t
    if (mode !== 'none') this.attachToWorkspace(sessionId)
    const binding = this.store.get(key)
    if (mode === 'active') {
      await this.store.update(key, { sessionId })
      await this.store.setWatch(key, sessionId, false)
      await this.chatLog?.bind(key, sessionId).catch(() => {})
      await this.reply(key, t.boundFromWeb(sessionId))
    } else if (mode === 'watch') {
      if (binding.sessionId === sessionId) await this.store.update(key, { sessionId: undefined })
      await this.store.setWatch(key, sessionId, true)
      await this.reply(key, t.watchFromWeb(sessionId))
    } else {
      if (binding.sessionId === sessionId) await this.store.update(key, { sessionId: undefined })
      await this.store.setWatch(key, sessionId, false)
    }
  }

  /** How each known chat relates to a Session. */
  linksOf(sessionId: string): { chatId: string; mode: 'active' | 'watch' }[] {
    return [
      ...this.store.chatsFor(sessionId).map(chatId => ({ chatId, mode: 'active' as const })),
      ...this.store.watchersOf(sessionId).map(chatId => ({ chatId, mode: 'watch' as const })),
    ]
  }

  /** Send a message to a chat as the bot, typed in the Web UI. */
  async sendFromWeb(key: string, text: string): Promise<void> {
    if (this.channelOf(key) === undefined) throw new Error('the line of this chat is not connected')
    await this.deliverMarkdown(key, text)
    this.log({ chatId: key }, { dir: 'out', kind: 'web', text })
  }

  // ─── outbound: Session events ───────────────────────────────────────────

  /** Chats that see a Session's output: bound chats, plus the schedule chats during a scheduled run. */
  private outputChats(sessionId: string): string[] {
    const chats = new Set(this.store.chatsFor(sessionId))
    if (this.turns.get(sessionId)?.scheduled === true) {
      for (const id of this.settings().scheduleChats) if (id.trim() !== '') chats.add(id.trim())
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
    if (this.live.size === 0) return
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
        for (const key of chats) void this.sendLocalFile(key, path, file.description)
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
    chats: string[], watchers: string[], endedAt: number,
  ): void {
    const t = this.t
    const title = shortId(sessionId)
    if (kind !== 'completed') {
      const message = t.turnEnded(kind, error)
      for (const key of chats) void this.reply(key, message)
      const watchMessage = kind === 'aborted' ? t.watchAborted(title) : t.watchFailed(title, error ?? kind)
      for (const key of watchers) void this.reply(key, watchMessage)
      return
    }
    if (turn === undefined) return
    const seconds = (endedAt - turn.startedAt) / 1000
    const s = this.settings()
    const summary = { seconds, tools: turn.tools, files: turn.files ?? [] }
    const wanted = s.turnSummary === 'always' || (s.turnSummary === 'long' && seconds >= s.turnSummaryMinSec)
    if (wanted) for (const key of chats) void this.reply(key, t.turnDone(summary))
    if (watchers.length > 0) {
      const excerpt = turn.lastText === undefined ? undefined : truncate(turn.lastText, EXCERPT_LENGTH)
      const message = t.turnDone({ ...summary, title, ...(excerpt === undefined ? {} : { excerpt }) })
      for (const key of watchers) void this.reply(key, message)
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
    for (const key of this.outputChats(sessionId)) this.log({ chatId: key }, { dir: 'out', kind: 'tool', text: line }, sessionId)
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
    const sends = this.outputChats(sessionId).map(key => this.enqueue(key, async (channel, chat) => {
      const messageId = activity.messages.get(key)
      if (messageId === undefined) activity.messages.set(key, await channel.send(chat, { text, editable: true }))
      else await channel.edit(chat, messageId, { text, editable: true }).catch(() => {})
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
    if (this.live.size === 0 || !this.settings().streamReplies) return
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
    for (const key of this.store.chatsFor(sessionId)) {
      const messageId = draft.messages.get(key)
      if (messageId === undefined) {
        await this.enqueue(key, async (channel, chat) => {
          draft.messages.set(key, await channel.send(chat, { text, editable: true }))
        })
      } else {
        const { chat } = splitChatKey(key)
        await this.channelOf(key)?.edit(chat, messageId, { text, editable: true }).catch(() => {})
      }
    }
  }

  /** Deliver a committed reply: replace the draft when there is one, else send it. */
  private async finishDraft(sessionId: string, chats: string[], text: string): Promise<void> {
    const draft = this.drafts.get(sessionId)
    this.drafts.delete(sessionId)
    if (draft !== undefined) {
      clearTimeout(draft.timer)
      await draft.pending
    }
    for (const key of chats) {
      void this.deliverMarkdown(key, text, draft?.messages.get(key)).then(() => {
        this.log({ chatId: key }, { dir: 'out', kind: 'assistant', text }, sessionId)
      })
    }
  }

  /**
   * Send Markdown rendered for the chat's platform, in order with the chat's other messages.
   * @param replaceId - a draft message to turn into the first piece.
   */
  private deliverMarkdown(key: string, markdown: string, replaceId?: string): Promise<void> {
    return this.enqueue(key, (channel, chat) => channel.sendMarkdown(chat, markdown, replaceId))
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
    if (this.live.size === 0 || this.typing.has(sessionId)) return
    if (this.store.chatsFor(sessionId).length === 0) return
    const tick = (): void => {
      for (const key of this.store.chatsFor(sessionId)) {
        void this.channelOf(key)?.typing(splitChatKey(key).chat).catch(() => {})
      }
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
  private sendLocalFile(key: string, path: string, description?: string): Promise<void> {
    return this.enqueue(key, async (channel, chat) => {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`${path} is not a file`)
      if (info.size > channel.sendLimitBytes) {
        const notice = this.t.deliverableTooLarge(path)
        await channel.send(chat, { text: notice })
        this.log({ chatId: key }, { dir: 'out', kind: 'notice', text: notice })
        return
      }
      const data = new Uint8Array(await readFile(path))
      const caption = description === undefined ? basename(path) : `${basename(path)}\n${description}`.slice(0, 1024)
      const photo = outgoingKind(path, info.size) === 'photo'
      await channel.sendFile(chat, { data, name: basename(path), photo }, caption)
      const attachment = await this.viewerAttachment(key, basename(path), data, photo ? sniffImageType(data) : undefined)
      this.log({ chatId: key }, {
        dir: 'out', kind: 'file', attachments: [{ ...attachment, path }],
        ...(description === undefined ? {} : { text: description }),
      })
    })
  }

  /** Send plain text to a chat in order, split to the platform's size limit. */
  private reply(key: string, text: string, kind: OutKind = 'notice'): Promise<void> {
    return this.enqueue(key, async (channel, chat) => {
      for (const chunk of chunkText(text)) await channel.send(chat, { text: chunk })
      this.log({ chatId: key }, { dir: 'out', kind, text })
    })
  }

  /** The connected adapter of a chat's line. */
  private channelOf(key: string): Channel | undefined {
    return this.live.get(splitChatKey(key).line)?.channel
  }

  /** Run one send operation after the chat's earlier ones, containing its failure. */
  private enqueue(key: string, send: (channel: Channel, chat: string) => Promise<void>): Promise<void> {
    const channel = this.channelOf(key)
    if (channel === undefined) return Promise.resolve()
    const { chat } = splitChatKey(key)
    const previous = this.sendTails.get(key) ?? Promise.resolve()
    const next = previous.then(() => send(channel, chat)).catch((error: unknown) => {
      this.logger.warn(`switchboard: send to chat ${key} failed: ${describe(error)}`)
    })
    this.sendTails.set(key, next)
    void next.then(() => {
      if (this.sendTails.get(key) === next) this.sendTails.delete(key)
    })
    return next
  }

  /** Chats of a Session whose line is connected now. */
  private reachable(chats: readonly string[]): string[] {
    return chats.filter(key => this.live.get(splitChatKey(key).line)?.state.kind === 'running')
  }

  // ─── approvals and pickers ──────────────────────────────────────────────

  /**
   * Ask the chats bound to or following a Session to approve one tool call.
   * @param request - the Session, tool, optional call id and reason, and withdrawal signal.
   * @returns the chat's answer, or `delegate` when no connected chat is linked, approvals are off, or the wait timed out.
   */
  async requestApproval(request: {
    sessionId: string
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<TelegramApprovalOutcome> {
    const s = this.settings()
    if (!s.approvalViaTelegram) return 'delegate'
    const chats = this.reachable([...new Set([...this.outputChats(request.sessionId), ...this.store.watchersOf(request.sessionId)])])
    if (chats.length === 0) return 'delegate'
    if (request.signal?.aborted === true) return 'cancelled'
    // The question should follow the reply that led to it.
    this.flushTools(request.sessionId)
    const t = this.t
    const id = randomUUID().slice(0, 12)
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.callId)
    const detail = call === undefined ? '' : previewArguments(call.arguments, 800)
    const text = t.approvalAsk(request.toolName, detail, request.reason)
    const buttons: Button[][] = [[
      { text: t.allow, data: `ap:${id}:y` },
      { text: t.reject, data: `ap:${id}:n` },
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
          void this.channelOf(prompt.chat)?.edit(splitChatKey(prompt.chat).chat, prompt.messageId, { text: `${text}\n\n${note}` }).catch(() => {})
          this.log({ chatId: prompt.chat }, {
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
    await Promise.all(chats.map(key => this.enqueue(key, async (channel, chat) => {
      const messageId = await channel.send(chat, { text, buttons })
      pending.prompts.push({ chat: key, messageId })
    })))
    if (pending.prompts.length === 0) pending.settle('delegate', '')
    return answer.promise
  }

  /**
   * Ask the Agent's questions in the chats bound to or following a Session.
   * @returns the answers, `delegate` when no connected chat is linked, the feature is off, or nobody answered in time.
   */
  async requestAnswers(request: { sessionId: string; questions: readonly QuestionItem[]; signal?: AbortSignal }): Promise<QuestionAnswer | 'delegate' | 'cancelled'> {
    const s = this.settings()
    if (!s.questionsViaTelegram || request.questions.length === 0) return 'delegate'
    const chats = this.reachable([...new Set([...this.outputChats(request.sessionId), ...this.store.watchersOf(request.sessionId)])])
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
          for (const [key, messageId] of entry.messages) {
            void this.channelOf(key)?.edit(splitChatKey(key).chat, messageId, { text: `${questionText(t, entry.item)}\n\n${summary}` }).catch(() => {})
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
      for (const key of chats) {
        await this.enqueue(key, async (channel, chat) => {
          entry.messages.set(key, await channel.send(chat, { text, buttons: questionButtons(t, id, index, entry) }))
        })
        this.log({ chatId: key }, { dir: 'out', kind: 'notice', text }, request.sessionId)
      }
    }
    if (pending.items.every(entry => entry.messages.size === 0)) pending.settle('delegate', '')
    return answer.promise
  }

  /** Take free text in a chat as the answer to its oldest unanswered question. */
  private answerByText(key: string, text: string): boolean {
    for (const pending of this.questions.values()) {
      if (!pending.chats.includes(key)) continue
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

  private async handleQuestionPress(channel: Channel, action: InboundAction): Promise<void> {
    const [, id = '', index = '', choice = ''] = action.data.split(':')
    const pending = this.questions.get(id)
    const entry = pending?.items[Number(index)]
    if (pending === undefined || entry === undefined || entry.done) {
      await channel.ack(action, this.t.approvalGone)
      return
    }
    await channel.ack(action)
    const options = entry.item.options ?? []
    if (choice === 's') {
      entry.selected.clear()
      entry.done = true
    } else if (choice === 'd') {
      entry.done = true
    } else {
      const label = options[Number(choice)]?.label
      if (label === undefined) return
      if (entry.item.multiSelect === true) {
        if (entry.selected.has(label)) entry.selected.delete(label)
        else entry.selected.add(label)
        const text = questionText(this.t, entry.item)
        for (const [key, messageId] of entry.messages) {
          void this.channelOf(key)?.editButtons(splitChatKey(key).chat, messageId, { text, buttons: questionButtons(this.t, id, Number(index), entry) }).catch(() => {})
        }
        return
      }
      entry.selected.add(label)
      entry.done = true
    }
    this.afterAnswer(pending)
  }

  private async handleAction(line: LiveLine, action: InboundAction): Promise<void> {
    const { channel } = line
    const t = this.t
    if (!this.allowed(this.settingsOf(line), action.from, action.chat)) {
      await channel.ack(action, t.unauthorized(action.from.id))
      return
    }
    if (action.data.startsWith('pk:')) return this.handlePick(line, action)
    if (action.data.startsWith('qa:')) return this.handleQuestionPress(channel, action)
    const match = /^ap:([\w-]+):([yn])$/u.exec(action.data)
    if (match === null) {
      await channel.ack(action)
      return
    }
    const pending = this.approvals.get(match[1] ?? '')
    if (pending === undefined) {
      await channel.ack(action, t.approvalGone)
      return
    }
    const who = action.from.username === undefined ? action.from.name : `@${action.from.username}`
    if (match[2] === 'y') pending.settle('allowed-once', t.approvalAllowed(who), who)
    else pending.settle('rejected', t.approvalRejected(who), who)
    await channel.ack(action)
  }

  private async handlePick(line: LiveLine, action: InboundAction): Promise<void> {
    const [, id = '', index = ''] = action.data.split(':')
    const picker = this.pickers.get(id)
    if (picker === undefined || action.chat === undefined) {
      await line.channel.ack(action, this.t.modelPickerExpired)
      return
    }
    await line.channel.ack(action)
    const key = chatKey(line.line.id, action.chat.id)
    if (picker.kind === 'model') {
      const picked = picker.choices[Number(index)]
      if (picked !== undefined) await this.switchModel(key, picker.sessionId, picked.choice, picked.name)
    } else {
      const picked = picker.choices[Number(index)]
      if (picked !== undefined) await this.switchMode(key, picker.sessionId, picked)
    }
  }
}

/** Restart key of a line: only connection settings restart it; the rest is read per message. */
function lineKey(line: LineSettings): string {
  return JSON.stringify([line.type, line.secret, line.apiBaseUrl, line.pollTimeoutSec, line.appId, line.domain])
}

/** The text of one question message. */
function questionText(t: Messages, item: QuestionItem): string {
  return t.question(item.header, item.question, item.detail, item.multiSelect === true)
}

/** Option buttons, ticked for a multi-select question, plus Done/Skip. */
function questionButtons(t: Messages, id: string, index: number, entry: { item: QuestionItem; selected: Set<string> }): Button[][] {
  const rows: Button[][] = (entry.item.options ?? []).slice(0, PICKER_BUTTONS).map((option, optionIndex) => [{
    text: `${entry.item.multiSelect === true && entry.selected.has(option.label) ? '☑ ' : entry.item.multiSelect === true ? '☐ ' : ''}${option.label}`.slice(0, 60),
    data: `qa:${id}:${index}:${optionIndex}`,
  }])
  const tail: Button[] = []
  if (entry.item.multiSelect === true) tail.push({ text: t.questionDone, data: `qa:${id}:${index}:d` })
  tail.push({ text: t.questionSkip, data: `qa:${id}:${index}:s` })
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
function chatInfo(key: string, chat: ChannelChat): ChatInfo {
  return {
    chatId: key,
    type: chat.type,
    ...(chat.title === undefined ? {} : { title: chat.title }),
    ...(chat.username === undefined ? {} : { username: chat.username }),
  }
}

function sender(user: ChannelUser): { id: string; name: string; username?: string } {
  return { id: user.id, name: user.name, ...(user.username === undefined ? {} : { username: user.username }) }
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
