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

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BindingStore, PendingChoice } from './bindings.ts'
import { FeishuChannel, type FeishuApi } from './channels/feishu.ts'
import { createFeishuApi } from './channels/feishu-api.ts'
import { TelegramChannel } from './channels/telegram.ts'
import {
  undelivered,
  type Button, type Channel, type ChannelChat, type ChannelSink, type ChannelUser, type InboundAction, type InboundAttachment,
  type InboundMessage, type LineState, type SentMarkdown,
} from './channels/types.ts'
import type { ChatAttachment, ChatEntry, ChatInfo, ChatLog } from './chatlog.ts'
import { chatKey, splitChatKey, type LineSettings } from './lines.ts'
import { outgoingKind, promptImageType, sniffImageType } from './media.ts'
import { duration, MESSAGES, type BotLanguage, type Messages } from './messages.ts'
import { actorFor, mayRunCommand, mayUse, type Actor, type PersonSettings } from './people.ts'
import type { Outbox, OutboxPayload } from './outbox.ts'
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
  /** Replies longer than this many characters go as a Markdown file with a short preview; 0 never. */
  readonly longReplyChars?: number
  /** Roles, presets, and directories of people; anyone not listed is an admin (or a member when admitted by chat). */
  readonly people?: readonly PersonSettings[]
  /** Chat keys told when a line stays down; the schedule chats when empty. */
  readonly alertChats?: readonly string[]
  /** Minutes a line may be down before the alert chats hear of it; 0 turns alerts off. */
  readonly alertAfterMin?: number
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
  readonly title?: string
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
  /**
   * Committed events of a Session after a seq, oldest first, read without
   * loading the Session; undefined when its log cannot be read.
   */
  eventsSince?(sessionId: string, afterSeq: number): Promise<readonly SessionLogEvent[] | undefined>
}

/** One committed Session event as the log stores it. */
export interface SessionLogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
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
  | { kind: 'session'; choices: string[]; at: number }
  | { kind: 'dir'; choices: string[]; at: number }

/** How a bot message is labelled in the chat history. */
type OutKind = 'assistant' | 'tool' | 'notice'

/**
 * A turn as the chats see it while it runs: one message per chat, edited in
 * place with the elapsed time, the latest tool calls, and the reply being
 * written, and replaced by the reply once it is committed.
 */
interface Progress {
  readonly startedAt: number
  /** Tool lines since the last reply, newest last. */
  lines: string[]
  /** Tool calls since the turn started. */
  count: number
  /** Tool calls since the last reply; more than the lines shown fold into "…". */
  segment: number
  /** Reply text being streamed. */
  text: string
  /** Progress message per chat key. */
  messages: Map<string, string>
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether `timer` is only the quiet-turn delay, which real activity cuts short. */
  delayed: boolean
  /** Repaints the elapsed time while a message is shown. */
  ticker: ReturnType<typeof setInterval> | undefined
  lastFlush: number
  /** The send or edit in flight; a reply waits for it. */
  pending: Promise<void>
  /** Short id the stop button carries. */
  readonly stopId: string
}

/** A person's message being worked on, marked with a reaction until its turn ends. */
interface Receipt {
  readonly key: string
  readonly messageId: string
  /** When it was queued; 0 when it joined the running turn (steer). */
  at: number
  readonly handle: Promise<unknown>
}

/** A "queued" notice with its steer and cancel buttons. */
interface QueuedNotice {
  readonly sessionId: string
  readonly key: string
  readonly itemId: string
  readonly parts: readonly PromptPart[]
  readonly messageId: string
  /** The person's message, whose reaction follows the notice. */
  readonly sourceId?: string
  readonly at: number
}

/** What the buttons under a finished reply act on. */
interface ReplyActions {
  readonly sessionId: string
  readonly key: string
  readonly cwd?: string
  readonly files: readonly string[]
  /** The prompt Retry sends again, when the turn came from this chat. */
  readonly retry?: readonly PromptPart[]
  readonly at: number
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
  /** Since when the line has not been running; undefined while it runs. */
  downSince: number | undefined
  /** Whether the alert chats were told that it is down. */
  alerted: boolean
}

/** Observable connection state for `/status` and logs. */
export type BridgeState = LineState

/** The bridge's own commands; a Harness command of the same name is reached only from the Web. */
const BRIDGE_COMMANDS = new Set([
  'start', 'help', 'menu', 'new', 'cwd', 'use', 'sessions', 'watch', 'unwatch', 'stop', 'steer', 'queue', 'cancel',
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
/** Progress edits are at least this far apart (Telegram allows about one message per second per chat). */
const PROGRESS_INTERVAL_MS = 1500
/** Tool lines a progress message shows; older calls fold into its count. */
const PROGRESS_LINES = 6
/** A quiet turn still shows its progress message after this long. */
const PROGRESS_DELAY_MS = 4000
/** How often a shown progress message repaints its elapsed time. */
const PROGRESS_TICK_MS = 10_000
/** Streamed text shows once there is this much of it. */
const DRAFT_MIN_CHARS = 40
/** Buttons and notices are remembered this long. */
const ACTION_TTL_MS = 24 * 60 * 60 * 1000
/** Largest diff sent by Show changes. */
const DIFF_LIMIT_BYTES = 1024 * 1024
/** Buttons in one /model picker; longer catalogs are reached by name. */
const PICKER_BUTTONS = 30
const PICKER_TTL_MS = 10 * 60 * 1000
/** A stranger hears the "not authorized" reply at most this often. */
const DENIED_REPLY_INTERVAL_MS = 60 * 60 * 1000
const DIRECTORY_LIST_LIMIT = 50
const EXCERPT_LENGTH = 400
/** How often queued messages are retried and line outages checked. */
const OUTBOX_INTERVAL_MS = 30_000
/** Turns sent after a restart, newest last; older ones stay in the Web UI. */
const CATCH_UP_TURNS = 3

/** The bridge core. One instance lives for the plugin's lifetime; lines restart when their settings change. */
export class Switchboard {
  private readonly live = new Map<string, LiveLine>()
  private readonly sendTails = new Map<string, Promise<void>>()
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestions>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  /** The running turn's progress message per Session. */
  private readonly progress = new Map<string, Progress>()
  /** Stop buttons: short id → Session. */
  private readonly stopIds = new Map<string, string>()
  /** Messages marked as being worked on, per Session. */
  private readonly receipts = new Map<string, Receipt[]>()
  private readonly queuedNotices = new Map<string, QueuedNotice>()
  private readonly replyActions = new Map<string, ReplyActions>()
  /** The last reply of a Session per chat, which gets the buttons when the turn ends. */
  private readonly lastReplies = new Map<string, Map<string, SentMarkdown>>()
  /** The reply currently carrying buttons, per chat, so they move to the next one. */
  private readonly buttoned = new Map<string, SentMarkdown>()
  /** Replies of a Session still on their way; the turn's buttons wait for them. */
  private readonly replyDeliveries = new Map<string, Promise<void>>()
  /** What each chat last prompted each Session with, for Retry. */
  private readonly lastPrompts = new Map<string, readonly PromptPart[]>()
  private readonly turns = new Map<string, TurnState>()
  private readonly pickers = new Map<string, Picker>()
  /** The last /sessions listing per chat, so `/use 2` and `/watch 2` work. */
  private readonly listings = new Map<string, string[]>()
  private readonly deniedReplies = new Map<string, number>()
  private readonly lifetime = new AbortController()
  /** Outbox items being sent now. */
  private readonly sending = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly settings: () => BridgeSettings,
    private readonly harness: HarnessPort,
    private readonly store: BindingStore,
    private readonly logger: BridgeLogger,
    private readonly channelOptions: ChannelOptions = {},
    private readonly chatLog?: ChatLog,
    private readonly outbox?: Outbox,
  ) {}

  /** Messages waiting for each line, by line id. */
  queuedByLine(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [chat, count] of this.outbox?.counts() ?? []) {
      const line = splitChatKey(chat).line
      counts.set(line, (counts.get(line) ?? 0) + count)
    }
    return counts
  }

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
  lineStates(): { id: string; type: LineSettings['type']; name: string; state: LineState; queued: number }[] {
    const queued = this.queuedByLine()
    return this.settings().lines.map(line => ({
      id: line.id, type: line.type, name: line.name,
      state: this.live.get(line.id)?.state ?? { kind: 'stopped' },
      queued: queued.get(line.id) ?? 0,
    }))
  }

  /** Whether a user id may use a line now (the access lists change without a restart). */
  isAllowedUser(lineId: string, userId: string | number): boolean {
    const line = this.settings().lines.find(candidate => candidate.id === lineId)
    return line !== undefined && isAllowed(line.allowedUsers, userId)
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
    this.timer ??= setInterval(() => {
      this.checkOutages()
      void this.flushOutbox()
    }, OUTBOX_INTERVAL_MS)
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
    const entry: LiveLine = {
      line, channel, controller, done: Promise.resolve(), key: lineKey(line), state: { kind: 'connecting' },
      menuHasHarness: false, downSince: Date.now(), alerted: false,
    }
    const sink: ChannelSink = {
      state: (state) => {
        const connected = state.kind === 'running' && entry.state.kind !== 'running'
        if (state.kind !== 'running' && entry.downSince === undefined) entry.downSince = Date.now()
        entry.state = state
        if (connected) {
          logger.info(`connected as ${line.type === 'telegram' ? '@' : ''}${state.username}`)
          void this.registerCommands(entry)
          entry.downSince = undefined
          if (entry.alerted) {
            entry.alerted = false
            const queued = this.queuedByLine().get(line.id) ?? 0
            for (const key of this.alertChats(line.id)) void this.reply(key, this.t.lineBack(this.settingsOf(entry).name, queued))
          }
          void this.flushOutbox()
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
    for (const progress of this.progress.values()) {
      clearTimeout(progress.timer)
      clearInterval(progress.ticker)
    }
    this.progress.clear()
    await Promise.allSettled([...this.sendTails.values()])
    for (const id of [...this.live.keys()]) await this.stopLine(id)
  }

  /** Stop for good: also abort in-flight transcriptions. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    clearInterval(this.timer)
    this.timer = undefined
    await this.stop()
    await this.outbox?.settled()
  }

  // ─── delivery that survives outages ─────────────────────────────────────

  /**
   * Send a message that must reach its chat: a reply, a turn notice, or a
   * presented file. While the chat's line is down, or when a send certainly
   * failed, it waits in the outbox and goes out once the line is back.
   * @param replaceId - a draft message the first piece replaces.
   */
  private durable(key: string, payload: OutboxPayload, sessionId?: string, replaceId?: string): Promise<void> {
    const line = this.live.get(splitChatKey(key).line)
    if (line?.state.kind !== 'running' && this.outbox !== undefined && this.lineConfigured(key)) {
      return this.outbox.add(key, payload, sessionId === undefined ? {} : { sessionId })
    }
    return this.enqueue(key, (channel, chat) => this.sendPayload(channel, chat, key, payload, sessionId, replaceId), (error) => {
      if (this.outbox !== undefined && undelivered(error)) void this.outbox.add(key, payload, { attempts: 1, ...(sessionId === undefined ? {} : { sessionId }) })
    })
  }

  /** Whether a chat belongs to a configured, enabled line (a removed line's chats are not queued for). */
  private lineConfigured(key: string): boolean {
    const s = this.settings()
    return s.enabled && s.lines.some(line => line.id === splitChatKey(key).line && line.enabled)
  }

  private async sendPayload(
    channel: Channel, chat: string, key: string, payload: OutboxPayload, sessionId?: string, replaceId?: string, note?: string,
  ): Promise<void> {
    if (payload.kind === 'file') return this.sendLocalFileNow(channel, chat, key, payload.path, payload.description, note)
    const text = note === undefined ? payload.text : `${note}\n\n${payload.text}`
    if (payload.kind === 'markdown') {
      // A very long reply reads better as a file: a preview here, the whole text attached.
      const limit = this.settings().longReplyChars ?? 0
      const long = limit > 0 && payload.text.length > limit
      const sent = await channel.sendMarkdown(chat, long ? `${note === undefined ? '' : `${note}\n\n`}${replyPreview(payload.text, Math.min(1200, Math.floor(limit / 2)))}${this.t.longReply(payload.text.length)}` : text, replaceId)
      if (long) {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/gu, '')
        await channel.sendFile(chat, { data: new TextEncoder().encode(payload.text), name: `${this.t.longReplyName}-${stamp}.md`, photo: false })
      }
      this.log({ chatId: key }, { dir: 'out', kind: 'assistant', text: payload.text }, sessionId)
      // A live reply may get the turn's buttons; a late one does not.
      if (sent !== undefined && sessionId !== undefined && note === undefined) {
        const replies = this.lastReplies.get(sessionId) ?? new Map<string, SentMarkdown>()
        replies.set(key, sent)
        this.lastReplies.set(sessionId, replies)
      }
      return
    }
    for (const chunk of chunkText(text)) await channel.send(chat, { text: chunk })
    this.log({ chatId: key }, { dir: 'out', kind: 'notice', text: payload.text }, sessionId)
  }

  /** Send queued messages whose line is connected, oldest first, each in order with its chat. */
  async flushOutbox(): Promise<void> {
    const outbox = this.outbox
    if (outbox === undefined) return
    const due = outbox.due(key => this.live.get(splitChatKey(key).line)?.state.kind === 'running')
    await Promise.all(due.filter(item => !this.sending.has(item.id)).map((item) => {
      this.sending.add(item.id)
      let sent = false
      return this.enqueue(item.chat, async (channel, chat) => {
        await this.sendPayload(channel, chat, item.chat, item.payload, item.sessionId, undefined, this.t.late(clock(item.at)))
        sent = true
      }, (error) => { void outbox.failed(item.id, undelivered(error)) }).then(async () => {
        if (sent) await outbox.remove(item.id)
      }).finally(() => { this.sending.delete(item.id) })
    }))
  }

  /** Chats told about a line's outage: on other connected lines only. */
  private alertChats(lineId: string): string[] {
    const s = this.settings()
    const chats = (s.alertChats ?? []).length > 0 ? s.alertChats ?? [] : s.scheduleChats
    return chats.map(chat => chat.trim()).filter(chat => chat !== '' && splitChatKey(chat).line !== lineId)
  }

  /** Tell the alert chats once about each line down longer than the threshold. */
  checkOutages(now: number = Date.now()): void {
    const minutes = this.settings().alertAfterMin ?? 5
    if (minutes <= 0) return
    for (const entry of this.live.values()) {
      if (entry.downSince === undefined || entry.alerted || now - entry.downSince < minutes * 60_000) continue
      const chats = this.alertChats(entry.line.id)
      if (chats.length === 0) continue
      entry.alerted = true
      const reason = entry.state.kind === 'error' ? entry.state.message : entry.state.kind
      const down = Math.round((now - entry.downSince) / 60_000)
      for (const key of chats) void this.reply(key, this.t.lineDown(this.settingsOf(entry).name, down, reason))
    }
  }

  /**
   * Send what linked Sessions said while the plugin was not running: the
   * final reply (or failure) of each turn that ended after the last mirrored
   * event, at most {@link CATCH_UP_TURNS} per Session. Runs once at startup.
   */
  async catchUp(): Promise<void> {
    const read = this.harness.eventsSince?.bind(this.harness)
    if (read === undefined) return
    for (const sessionId of this.store.linkedSessions()) {
      const cursor = this.store.cursor(sessionId)
      if (cursor === undefined) continue
      const events = await read(sessionId, cursor).catch(() => undefined)
      if (events === undefined || events.length === 0) continue
      const ended: { text: string; kind: string; error?: string; at: number }[] = []
      let text = ''
      for (const event of events) {
        if (event.type === 'assistant/message') {
          const next = assistantText(event.data)
          if (next !== '') text = next
        } else if (event.type === 'turn/end') {
          const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason
          ended.push({ text, kind: reason?.kind ?? 'completed', at: event.time, ...(reason?.error?.message === undefined ? {} : { error: reason.error.message }) })
          text = ''
        } else if (event.type === 'turn/start') {
          text = ''
        }
      }
      const t = this.t
      const chats = this.store.chatsFor(sessionId)
      const watchers = this.store.watchersOf(sessionId)
      for (const turn of ended.slice(-CATCH_UP_TURNS)) {
        const time = clock(turn.at)
        if (turn.kind === 'completed' && turn.text !== '') {
          for (const key of chats) void this.durable(key, { kind: 'markdown', text: `${t.caughtUp(time)}\n\n${turn.text}` }, sessionId)
          const excerpt = `${t.caughtUp(time)}\n${shortId(sessionId)}: ${truncate(turn.text, EXCERPT_LENGTH)}`
          for (const key of watchers) void this.durable(key, { kind: 'text', text: excerpt }, sessionId)
        } else if (turn.kind !== 'completed' && turn.kind !== 'aborted') {
          const message = t.caughtUpFailed(time, turn.error ?? turn.kind)
          for (const key of [...chats, ...watchers]) void this.durable(key, { kind: 'text', text: message }, sessionId)
        }
      }
      await this.store.setCursor(sessionId, events.at(-1)!.seq)
    }
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
      { command: 'menu', description: t.cmdMenu },
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

  /** What a person may do on a line. */
  private actorOf(line: LineSettings, user: ChannelUser): Actor {
    const ids = [user.id, ...(user.aliases ?? []), ...(user.username === undefined ? [] : [`@${user.username}`])]
    const byName = ids.some(id => isAllowed(line.allowedUsers, id))
    const fallback = line.workspacePath.trim() || this.settings().workspacePath.trim() || undefined
    return actorFor(this.settings().people, line.id, ids, !byName, fallback)
  }

  /** Whether an actor may use a Session: admins any, others only in their directories. */
  private async mayUseSession(actor: Actor, sessionId: string): Promise<boolean> {
    if (actor.dirs === undefined) return true
    const cwd = this.harness.live(sessionId)?.cwd ?? (await this.harness.listSessions().catch(() => [])).find(row => row.sessionId === sessionId)?.cwd
    return mayUse(actor, cwd)
  }

  /** A running line's current settings (access lists and directories change without a restart). */
  private settingsOf(entry: LiveLine): LineSettings {
    return this.settings().lines.find(line => line.id === entry.line.id) ?? entry.line
  }

  private async handleMessage(entry: LiveLine, message: InboundMessage): Promise<void> {
    const { channel } = entry
    const line = this.settingsOf(entry)
    const actor = this.actorOf(line, message.from)
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
      if (message.voice !== undefined && this.settings().transcribeVoice) return await this.promptWithVoice(key, message, actor)
      if (attachments.length > 0) return await this.promptWithMedia(key, message, actor)
      if (text === undefined) return await this.reply(key, t.unsupported)
      if (parsed === undefined) return
      if (parsed.kind === 'text' && this.answerByText(key, parsed.text)) return
      if (parsed.kind === 'text') return await this.promptFromChat(key, [{ type: 'text', text: this.withQuote(parsed.text, message.quote) }], 'queue', actor, message.messageId)
      return await this.runCommand(key, parsed.name, parsed.args, actor)
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  /**
   * Download every attachment of one message (or album), stage it into the
   * chat's Session, and prompt with the text plus the receipts.
   */
  private async promptWithMedia(key: string, message: InboundMessage, actor: Actor, note?: string): Promise<void> {
    const channel = this.channelOf(key)
    if (channel === undefined) return
    const t = this.t
    const sessionId = await this.ensureSession(key, actor)
    if (sessionId === undefined) return
    const limit = this.settings().maxDownloadMb * 1024 * 1024
    const parts: PromptPart[] = []
    const caption = this.withQuote((message.text ?? '').trim(), message.quote)
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
    await this.promptSession(key, sessionId, parts, 'queue', message.messageId)
  }

  /**
   * Transcribe a voice note and prompt with the text; when the host cannot
   * transcribe, the note goes to the Agent as an audio file instead.
   */
  private async promptWithVoice(key: string, message: InboundMessage, actor: Actor): Promise<void> {
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
      return this.promptWithMedia(key, message, actor, t.voiceUnavailable(describe(error)))
    }
    if (transcript === '') return this.reply(key, t.voiceEmpty)
    const caption = (message.text ?? '').trim()
    const text = this.withQuote(caption === '' ? transcript : `${caption}\n\n${transcript}`, message.quote)
    this.log(chatInfo(key, message.chat), { dir: 'in', kind: 'text', from: sender(message.from), text: `🎤 ${text}` })
    await this.reply(key, t.voiceHeard(transcript))
    await this.promptFromChat(key, [{ type: 'text', text }], 'queue', actor, message.messageId)
  }

  /** Prefix a prompt with the message it quotes, so the Agent knows what "this" refers to. */
  private withQuote(text: string, quote: string | undefined): string {
    if (quote === undefined || quote.trim() === '') return text
    const quoted = this.t.quoted(quote.trim())
    return text === '' ? quoted : `${quoted}\n\n${text}`
  }

  /** Describe an attachment for the history, keeping a copy of images the viewer can show. */
  private async viewerAttachment(key: string, name: string, data: Uint8Array, imageType?: string): Promise<ChatAttachment> {
    const base = { name, size: data.byteLength }
    if (imageType === undefined || this.chatLog === undefined || data.byteLength > VIEWER_IMAGE_LIMIT) return { ...base, kind: imageType === undefined ? 'file' : 'image' }
    const media = await this.chatLog.saveMedia(key, IMAGE_EXTENSIONS[imageType] ?? '', data).catch(() => undefined)
    return { ...base, kind: 'image', ...(media === undefined ? {} : { media }) }
  }

  // ─── commands ───────────────────────────────────────────────────────────

  private async runCommand(key: string, name: string, args: string, actor: Actor): Promise<void> {
    const t = this.t
    const binding = this.store.get(key)
    switch (name) {
      case 'start':
      case 'menu':
        return this.sendMenu(key, name === 'start')
      case 'help': {
        const commands = (await this.harness.listCommands(binding.sessionId).catch(() => []))
          .filter(command => !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
        const entry = this.live.get(splitChatKey(key).line)
        if (commands.length > 0 && entry !== undefined && !entry.menuHasHarness) void this.registerCommands(entry, commands)
        const lines = commands.map(command => `/${command.name}${command.hint === undefined ? '' : ` ${command.hint}`} — ${command.description}`)
        return this.reply(key, lines.length === 0 ? t.help : `${t.help}\n\n${t.harnessCommands}\n${lines.join('\n')}`)
      }
      case 'new': {
        if (args === '') {
          // Recent directories as buttons; with only the default, start right there.
          const dirs = (await this.recentDirs(key, actor)).filter(dir => mayUse(actor, dir))
          if (dirs.length > 1) {
            return this.sendPicker(key, { kind: 'dir', choices: dirs, at: Date.now() },
              dirs.map((dir, index) => `${index === 0 && dir === this.defaultWorkspace(key) ? '⭐ ' : '📁 '}${tildify(dir)}`), t.newPick)
          }
        }
        const cwd = args === '' ? this.workspaceFor(key, actor) : args
        if (cwd === undefined) return this.reply(key, t.noWorkspace)
        const sessionId = await this.newSession(key, cwd, actor)
        return this.reply(key, t.created(sessionId, cwd))
      }
      case 'cwd': {
        if (args === '') return this.reply(key, this.defaultWorkspace(key) ?? t.noWorkspace)
        if (!(await isDirectory(args))) return this.reply(key, t.badWorkspace(args))
        if (!mayUse(actor, args)) return this.reply(key, t.dirDenied(actor.dirs ?? []))
        await this.store.update(key, { workspacePath: args })
        return this.reply(key, t.cwdSet(args))
      }
      case 'use': {
        if (args === '') return this.reply(key, t.useUsage)
        const sessionId = this.sessionRef(key, args)
        if (!(await this.mayUseSession(actor, sessionId))) return this.reply(key, t.dirDenied(actor.dirs ?? []))
        await this.store.update(key, { sessionId })
        await this.chatLog?.bind(key, sessionId).catch(() => {})
        this.attachToWorkspace(sessionId)
        return this.reply(key, t.bound(sessionId))
      }
      case 'sessions': {
        const rows = (await this.harness.listSessions()).filter(row => mayUse(actor, row.cwd)).slice(0, 10)
        this.listings.set(key, rows.map(row => row.sessionId))
        if (rows.length === 0) return this.reply(key, t.sessions([]))
        const lines = rows.map((row, index) =>
          `${index + 1}. ${row.running ? '▶' : '·'} ${row.title ?? row.sessionId}${row.cwd === undefined ? '' : `  ${tildify(row.cwd)}`}${row.sessionId === binding.sessionId ? ' ✓' : ''}`)
        const labels = rows.map((row, index) =>
          `${row.sessionId === binding.sessionId ? '✓ ' : ''}${index + 1}. ${truncate(row.title ?? shortId(row.sessionId), 36)}${row.running ? ' ▶' : ''}`)
        return this.sendPicker(key, { kind: 'session', choices: rows.map(row => row.sessionId), at: Date.now() }, labels, `${t.sessions(lines)}\n\n${t.sessionsPick}`)
      }
      case 'watch': {
        if (args === '') return this.reply(key, t.watching((binding.watch ?? []).map(id => `· ${id}`)))
        const sessionId = this.sessionRef(key, args)
        if (!(await this.mayUseSession(actor, sessionId))) return this.reply(key, t.dirDenied(actor.dirs ?? []))
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
        return this.promptFromChat(key, [{ type: 'text', text: args }], 'steer', actor)
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
        if (actor.role === 'guest') return this.reply(key, t.adminOnly)
        return this.modelCommand(key, binding.sessionId, args)
      case 'mode':
        if (actor.role !== 'admin') return this.reply(key, t.adminOnly)
        return this.modeCommand(key, binding.sessionId, args)
      case 'get':
        return this.getCommand(key, binding.sessionId, args)
      default: {
        const line = `/${name}${args === '' ? '' : ` ${args}`}`
        // Harness commands run on the Host as in the Web composer; anything else is text for the Agent.
        if (binding.sessionId !== undefined) {
          if (!mayRunCommand(actor, name) && (await this.harness.listCommands(binding.sessionId).catch(() => [])).some(command => command.name === name)) {
            return this.reply(key, t.adminOnly)
          }
          const result = await this.harness.runCommand(binding.sessionId, line)
          if (result !== undefined) {
            return this.reply(key, result.kind === 'error'
              ? t.commandFailed(name, result.text ?? '')
              : result.text === undefined || result.text.trim() === '' ? t.commandDone(name) : result.text)
          }
        }
        return this.promptFromChat(key, [{ type: 'text', text: line }], 'queue', actor)
      }
    }
  }

  /** Put a linked Session into its directory's Web Workspace; a failure is logged, never shown in the chat. */
  private attachToWorkspace(sessionId: string): void {
    void this.harness.ensureWorkspace(sessionId).catch((error: unknown) => {
      this.logger.warn(`switchboard: could not add ${sessionId} to a Web workspace: ${describe(error)}`)
    })
  }

  /** The menu of common actions, as buttons. */
  private async sendMenu(key: string, withHelp: boolean): Promise<void> {
    const t = this.t
    const sessionId = this.store.get(key).sessionId
    const title = sessionId === undefined ? undefined
      : (await this.harness.listSessions().catch(() => [])).find(row => row.sessionId === sessionId)?.title ?? shortId(sessionId)
    const text = withHelp ? `${t.help}\n\n${t.menu(title)}` : t.menu(title)
    const buttons: Button[][] = [
      [{ text: t.menuNew, data: 'mn:new' }, { text: t.menuSessions, data: 'mn:sessions' }],
      [{ text: t.menuModel, data: 'mn:model' }, { text: t.menuMode, data: 'mn:mode' }],
      [{ text: t.menuStop, data: 'mn:stop' }, { text: t.menuCompact, data: 'mn:compact' }],
      [{ text: t.menuStatus, data: 'mn:status' }, { text: t.menuHelp, data: 'mn:help' }],
    ]
    await this.enqueue(key, async (channel, chat) => { await channel.send(chat, { text, buttons }) })
    this.log({ chatId: key }, { dir: 'out', kind: 'notice', text })
  }

  /** Directories offered by `/new`: the chat's default first, then where recent Sessions ran. */
  private async recentDirs(key: string, actor: Actor): Promise<string[]> {
    const dirs: string[] = []
    const fallback = this.workspaceFor(key, actor)
    if (fallback !== undefined) dirs.push(fallback)
    for (const row of await this.harness.listSessions().catch(() => [])) {
      if (row.cwd === undefined || dirs.some(dir => samePath(dir, row.cwd!))) continue
      if (await isDirectory(row.cwd)) dirs.push(row.cwd)
      if (dirs.length >= 6) break
    }
    return dirs
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

  /** Where an actor's new Session goes: the chat's directory when they may use it, else their first directory. */
  private workspaceFor(key: string, actor: Actor): string | undefined {
    const preferred = this.defaultWorkspace(key)
    if (mayUse(actor, preferred)) return preferred
    return actor.dirs?.[0]
  }

  private async newSession(key: string, cwd: string, actor: Actor): Promise<string> {
    if (!(await isDirectory(cwd))) throw new Error(this.t.badWorkspace(cwd))
    if (!mayUse(actor, cwd)) throw new Error(this.t.dirDenied(actor.dirs ?? []))
    const s = this.settings()
    const sessionId = await this.harness.createSession(cwd, s.agentPreset, actor.preset ?? s.permissionPreset, s.model)
    await this.store.update(key, { sessionId })
    await this.chatLog?.bind(key, sessionId).catch(() => {})
    return sessionId
  }

  /** The chat's Session, creating one in the default directory when it has none. */
  private async ensureSession(key: string, actor: Actor): Promise<string | undefined> {
    const existing = this.store.get(key).sessionId
    if (existing !== undefined) return existing
    const cwd = this.workspaceFor(key, actor)
    if (cwd === undefined) {
      await this.reply(key, this.t.noWorkspace)
      return undefined
    }
    const sessionId = await this.newSession(key, cwd, actor)
    await this.reply(key, this.t.created(sessionId, cwd))
    return sessionId
  }

  /**
   * Prompt the chat's Session. A message that waits behind a running turn gets
   * a notice with steer and cancel buttons; the person's message is marked
   * while it is worked on.
   * @param source - the person's message, for its reaction.
   */
  private async promptFromChat(key: string, parts: readonly PromptPart[], mode: 'queue' | 'steer', actor: Actor, source?: string): Promise<void> {
    const sessionId = await this.ensureSession(key, actor)
    if (sessionId === undefined) return
    await this.promptSession(key, sessionId, parts, mode, source)
  }

  private async promptSession(key: string, sessionId: string, parts: readonly PromptPart[], mode: 'queue' | 'steer', source?: string): Promise<void> {
    const busy = mode === 'queue' && this.harness.live(sessionId)?.running === true
    this.startTyping(sessionId)
    await this.harness.prompt(sessionId, parts, mode)
    this.lastPrompts.set(`${key}|${sessionId}`, parts)
    if (source !== undefined) this.markReceived(sessionId, key, source, mode === 'steer')
    if (!busy) return
    const items = this.harness.queued(sessionId) ?? []
    const item = items.at(-1)
    if (item === undefined) return
    const id = randomUUID().slice(0, 8)
    const t = this.t
    const now = Date.now()
    for (const [old, notice] of this.queuedNotices) if (now - notice.at > ACTION_TTL_MS) this.queuedNotices.delete(old)
    await this.enqueue(key, async (channel, chat) => {
      const messageId = await channel.send(chat, {
        text: t.queued(items.length - 1),
        buttons: [[{ text: t.queueSteerButton, data: `qs:${id}` }, { text: t.queueCancelButton, data: `qx:${id}` }]],
        editable: true,
      })
      this.queuedNotices.set(id, { sessionId, key, itemId: item.id, parts, messageId, at: now, ...(source === undefined ? {} : { sourceId: source }) })
    })
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
    // A restart catches up from the last reply or turn end seen here.
    if ((event.type === 'assistant/message' || event.type === 'turn/end') && event.seq !== undefined
      && (this.store.chatsFor(sessionId).length > 0 || this.store.watchersOf(sessionId).length > 0)) {
      void this.store.setCursor(sessionId, event.seq)
    }
    if (event.type === 'turn/start') {
      const startedAt = event.time ?? Date.now()
      this.turns.set(sessionId, { startedAt, tools: 0, scheduled: false })
      this.startProgress(sessionId, startedAt)
      this.clearReplyButtons(sessionId)
      this.updateQueuedNotices(sessionId)
      return
    }
    if (event.type === 'user/message') {
      // The event's data is the committed message itself.
      const source = (event.data as { source?: { kind?: string } } | undefined)?.source?.kind
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
      // Chained, so the turn end's buttons land on the last reply once it is delivered.
      const delivered = (this.replyDeliveries.get(sessionId) ?? Promise.resolve()).then(() => this.deliverReply(sessionId, chats, text))
      this.replyDeliveries.set(sessionId, delivered)
    } else if (event.type === 'tool/call') {
      const data = event.data as { callId: string; name: string; arguments: string }
      this.rememberToolCall(data.callId, data.name, data.arguments)
      if (turn !== undefined) turn.tools++
      if (chats.length > 0) this.noteToolCall(sessionId, data.name, data.arguments)
    } else if (event.type === 'deliverables/presented') {
      if (!this.settings().sendDeliverables) return
      const files = (event.data as { files?: readonly { path: string; description?: string }[] }).files ?? []
      for (const file of files) {
        const path = isAbsolute(file.path) || cwd === undefined ? file.path : resolve(cwd, file.path)
        for (const key of chats) void this.durable(key, { kind: 'file', path, ...(file.description === undefined ? {} : { description: file.description }) }, sessionId)
      }
    } else if (event.type === 'turn/end') {
      this.turns.delete(sessionId)
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      const kind = reason?.kind ?? 'completed'
      const endedAt = event.time ?? Date.now()
      const shown = this.endProgress(sessionId, kind, reason?.error?.message, endedAt)
      this.finishReceipts(sessionId, kind, turn?.startedAt ?? endedAt)
      const delivered = this.replyDeliveries.get(sessionId) ?? Promise.resolve()
      this.replyDeliveries.delete(sessionId)
      // Buttons and turn-end notices follow the turn's last reply.
      void delivered.then(() => {
        if (kind === 'completed') this.offerReplyActions(sessionId, turn, cwd)
        this.endTurn(sessionId, kind, reason?.error?.message, turn, chats.filter(key => !shown.has(key)), watchers, endedAt)
      })
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
      for (const key of chats) void this.durable(key, { kind: 'text', text: message }, sessionId)
      const watchMessage = kind === 'aborted' ? t.watchAborted(title) : t.watchFailed(title, error ?? kind)
      for (const key of watchers) void this.durable(key, { kind: 'text', text: watchMessage }, sessionId)
      return
    }
    if (turn === undefined) return
    const seconds = (endedAt - turn.startedAt) / 1000
    const s = this.settings()
    const summary = { seconds, tools: turn.tools, files: turn.files ?? [] }
    const wanted = s.turnSummary === 'always' || (s.turnSummary === 'long' && seconds >= s.turnSummaryMinSec)
    if (wanted) for (const key of chats) void this.durable(key, { kind: 'text', text: t.turnDone(summary) }, sessionId)
    if (watchers.length > 0) {
      const excerpt = turn.lastText === undefined ? undefined : truncate(turn.lastText, EXCERPT_LENGTH)
      const message = t.turnDone({ ...summary, title, ...(excerpt === undefined ? {} : { excerpt }) })
      for (const key of watchers) void this.durable(key, { kind: 'text', text: message }, sessionId)
    }
  }

  // ─── progress, reactions, and reply buttons ─────────────────────────────

  /** Begin a turn's progress: shown after a moment even if nothing happens, so the chat knows it is working. */
  private startProgress(sessionId: string, startedAt: number): Progress {
    const old = this.progress.get(sessionId)
    if (old !== undefined) {
      clearTimeout(old.timer)
      clearInterval(old.ticker)
    }
    const stopId = randomUUID().slice(0, 8)
    this.stopIds.set(stopId, sessionId)
    while (this.stopIds.size > 64) this.stopIds.delete(this.stopIds.keys().next().value as string)
    const progress: Progress = {
      startedAt, lines: [], count: 0, segment: 0, text: '', messages: new Map(), timer: undefined, delayed: true, ticker: undefined,
      lastFlush: 0, pending: Promise.resolve(), stopId,
    }
    this.progress.set(sessionId, progress)
    progress.timer = setTimeout(() => {
      progress.timer = undefined
      progress.delayed = false
      this.renderProgress(sessionId, progress)
    }, PROGRESS_DELAY_MS)
    return progress
  }

  /** Add a tool call to the progress message (and to the history, which keeps every call). */
  private noteToolCall(sessionId: string, name: string, args: string): void {
    const preview = previewArguments(args, TOOL_PREVIEW_LENGTH)
    const line = `🔧 ${name}${preview === '' ? '' : ` · ${preview}`}`
    for (const key of this.outputChats(sessionId)) this.log({ chatId: key }, { dir: 'out', kind: 'tool', text: line }, sessionId)
    const progress = this.progress.get(sessionId) ?? this.startProgress(sessionId, Date.now())
    progress.count++
    progress.segment++
    if (this.settings().notifyToolCalls) {
      progress.lines.push(line)
      if (progress.lines.length > PROGRESS_LINES) progress.lines.shift()
    }
    this.scheduleProgress(sessionId, progress)
  }

  /**
   * Follow the live reply as it is written, shown in the progress message.
   * @param sessionId - the Agent's Session (top-level Agents only).
   * @param frame - one assistant stream frame.
   */
  onAssistantStream(sessionId: string, frame: { type: string; chunk?: { type: string; text?: string }; outcome?: { kind: string } }): void {
    if (this.live.size === 0 || !this.settings().streamReplies) return
    const progress = this.progress.get(sessionId)
    if (progress === undefined) return
    if (frame.type === 'start') {
      // A new attempt replaces an abandoned one's text.
      progress.text = ''
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
      progress.text += frame.chunk.text
      if (progress.text.trim().length >= DRAFT_MIN_CHARS) this.scheduleProgress(sessionId, progress)
    }
  }

  private scheduleProgress(sessionId: string, progress: Progress): void {
    if (progress.timer !== undefined && !progress.delayed) return
    clearTimeout(progress.timer)
    progress.delayed = false
    progress.timer = setTimeout(() => {
      progress.timer = undefined
      this.renderProgress(sessionId, progress)
    }, Math.max(0, progress.lastFlush + PROGRESS_INTERVAL_MS - Date.now()))
  }

  /** Show the progress message now (before an approval or question, so they follow it). */
  private flushProgress(sessionId: string): void {
    const progress = this.progress.get(sessionId)
    if (progress === undefined || progress.messages.size === 0 && progress.count === 0) return
    clearTimeout(progress.timer)
    progress.timer = undefined
    this.renderProgress(sessionId, progress)
  }

  /** Send or edit the progress message in every output chat. */
  private renderProgress(sessionId: string, progress: Progress): void {
    if (this.progress.get(sessionId) !== progress) return
    progress.lastFlush = Date.now()
    const t = this.t
    const hidden = progress.segment - progress.lines.length
    const elapsed = duration((Date.now() - progress.startedAt) / 1000, this.settings().language)
    const draft = progress.text.trim().length >= DRAFT_MIN_CHARS ? draftPreview(progress.text, 1500) : undefined
    const text = [
      t.progress(elapsed, progress.count),
      ...(progress.lines.length > 0 && hidden > 0 ? ['…'] : []),
      ...progress.lines,
      ...(draft === undefined ? [] : ['', draft]),
    ].join('\n')
    const buttons = [[{ text: t.stopButton, data: `st:${progress.stopId}` }]]
    // Each chat's send queue is serial, so an edit runs after the send that created its message.
    const sends = this.outputChats(sessionId).map(key => this.enqueue(key, async (channel, chat) => {
      const messageId = progress.messages.get(key)
      if (messageId === undefined) progress.messages.set(key, await channel.send(chat, { text, buttons, editable: true }))
      else await channel.edit(chat, messageId, { text, buttons, editable: true }).catch(() => {})
    }))
    progress.pending = Promise.all(sends).then(() => {})
    if (progress.ticker === undefined) {
      progress.ticker = setInterval(() => {
        if (progress.timer === undefined) this.renderProgress(sessionId, progress)
      }, PROGRESS_TICK_MS)
    }
  }

  /**
   * Deliver a committed reply as a new message, so it is always the latest in
   * the chat and notifies; the progress message steps aside (removed, or
   * shrunk to a summary line), and the turn's next activity starts a fresh one.
   */
  private async deliverReply(sessionId: string, chats: string[], text: string): Promise<void> {
    const progress = this.progress.get(sessionId)
    let shown: Map<string, string> | undefined
    let summary = ''
    if (progress !== undefined) {
      clearTimeout(progress.timer)
      progress.timer = undefined
      clearInterval(progress.ticker)
      progress.ticker = undefined
      shown = progress.messages
      summary = this.t.progressSummary(duration((Date.now() - progress.startedAt) / 1000, this.settings().language), progress.segment)
      progress.messages = new Map()
      progress.lines = []
      progress.segment = 0
      progress.text = ''
      await progress.pending
    }
    await Promise.all(chats.map((key) => {
      const messageId = shown?.get(key)
      if (messageId !== undefined) void this.enqueue(key, async (channel, chat) => { await channel.retire(chat, messageId, summary) })
      return this.durable(key, { kind: 'markdown', text }, sessionId)
    }))
  }

  /**
   * Close the progress message at turn end with the outcome.
   * @returns the chats whose progress message now shows the outcome.
   */
  private endProgress(sessionId: string, kind: string, error: string | undefined, endedAt: number): Set<string> {
    const progress = this.progress.get(sessionId)
    this.progress.delete(sessionId)
    if (progress === undefined) return new Set()
    clearTimeout(progress.timer)
    clearInterval(progress.ticker)
    const shown = new Set(progress.messages.keys())
    if (shown.size === 0) return shown
    const text = this.t.progressEnded(kind, duration((endedAt - progress.startedAt) / 1000, this.settings().language), progress.count, error)
    void progress.pending.then(() => {
      for (const [key, messageId] of progress.messages) {
        void this.enqueue(key, async (channel, chat) => { await channel.edit(chat, messageId, { text, editable: true }) })
      }
    })
    // A completed turn's progress message says only "done"; failures and stops are told there instead of in a new message.
    return kind === 'completed' ? new Set() : shown
  }

  /** Mark a person's message as being worked on. */
  private markReceived(sessionId: string, key: string, messageId: string, steer: boolean): void {
    const channel = this.channelOf(key)
    if (channel === undefined) return
    const handle = channel.react(splitChatKey(key).chat, messageId, 'working').catch(() => undefined)
    const list = this.receipts.get(sessionId) ?? []
    list.push({ key, messageId, at: steer ? 0 : Date.now(), handle })
    this.receipts.set(sessionId, list.slice(-50))
  }

  /** Clear the marks of the messages a finished turn handled (those queued before it started, or steered into it). */
  private finishReceipts(sessionId: string, kind: string, startedAt: number): void {
    const list = this.receipts.get(sessionId)
    if (list === undefined) return
    const done = list.filter(receipt => receipt.at <= startedAt)
    const rest = list.filter(receipt => receipt.at > startedAt)
    if (rest.length === 0) this.receipts.delete(sessionId)
    else this.receipts.set(sessionId, rest)
    const state = kind === 'completed' || kind === 'aborted' ? 'done' : 'failed'
    for (const receipt of done) this.settleReceipt(receipt, state)
  }

  private settleReceipt(receipt: Receipt, state: 'done' | 'failed'): void {
    void receipt.handle.then(previous => this.channelOf(receipt.key)?.react(splitChatKey(receipt.key).chat, receipt.messageId, state, previous)).catch(() => {})
  }

  /** Remember a reply's actions and put the buttons under the last reply of each bound chat. */
  private offerReplyActions(sessionId: string, turn: TurnState | undefined, cwd: string | undefined): void {
    const replies = this.lastReplies.get(sessionId)
    this.lastReplies.delete(sessionId)
    if (replies === undefined) return
    const t = this.t
    const now = Date.now()
    for (const [id, actions] of this.replyActions) if (now - actions.at > ACTION_TTL_MS) this.replyActions.delete(id)
    for (const [key, sent] of replies) {
      if (!this.store.chatsFor(sessionId).includes(key)) continue
      const id = randomUUID().slice(0, 8)
      const retry = this.lastPrompts.get(`${key}|${sessionId}`)
      const files = turn?.files ?? []
      this.replyActions.set(id, {
        sessionId, key, files, at: now,
        ...(cwd === undefined ? {} : { cwd }),
        ...(retry === undefined ? {} : { retry }),
      })
      const row = [
        { text: t.actContinue, data: `ab:${id}:c` },
        ...(retry === undefined ? [] : [{ text: t.actRetry, data: `ab:${id}:r` }]),
        ...(files.length > 0 ? [{ text: t.actChanges, data: `ab:${id}:d` }] : []),
        { text: t.actNew, data: `ab:${id}:n` },
      ]
      const previous = this.buttoned.get(key)
      this.buttoned.set(key, sent)
      void this.enqueue(key, async (channel, chat) => {
        if (previous !== undefined && previous.messageId !== sent.messageId) await channel.addButtons(chat, previous, []).catch(() => {})
        await channel.addButtons(chat, sent, [row])
      })
    }
  }

  /** Take the buttons off the last reply of chats bound to a Session that starts a new turn. */
  private clearReplyButtons(sessionId: string): void {
    for (const key of this.store.chatsFor(sessionId)) {
      const sent = this.buttoned.get(key)
      if (sent === undefined) continue
      this.buttoned.delete(key)
      void this.enqueue(key, async (channel, chat) => { await channel.addButtons(chat, sent, []).catch(() => {}) })
    }
  }

  /** Mark queued notices whose message has started. */
  private updateQueuedNotices(sessionId: string): void {
    const waiting = new Set((this.harness.queued(sessionId) ?? []).map(item => item.id))
    for (const [id, notice] of this.queuedNotices) {
      if (notice.sessionId !== sessionId || waiting.has(notice.itemId)) continue
      this.queuedNotices.delete(id)
      void this.enqueue(notice.key, async (channel, chat) => { await channel.edit(chat, notice.messageId, { text: this.t.queueStarted }) })
    }
  }

  /** Send the files a turn changed as a diff (or their names, outside a git work tree). */
  private async sendChanges(key: string, actions: ReplyActions): Promise<void> {
    const t = this.t
    if (actions.files.length === 0 || actions.cwd === undefined) return this.reply(key, t.changesNone)
    const diff = await gitDiff(actions.cwd, actions.files).catch(() => '')
    if (diff.trim() === '') return this.reply(key, `${t.changesCaption(actions.files.length)}\n${actions.files.map(file => `· ${file}`).join('\n')}`)
    const data = new TextEncoder().encode(diff)
    await this.enqueue(key, async (channel, chat) => {
      await channel.sendFile(chat, { data: data.slice(0, DIFF_LIMIT_BYTES), name: `changes-${shortId(actions.sessionId)}.diff`, photo: false }, t.changesCaption(actions.files.length))
    })
  }

  /**
   * Send Markdown rendered for the chat's platform, in order with the chat's other messages.
   * @param replaceId - a draft message to turn into the first piece.
   */
  private deliverMarkdown(key: string, markdown: string, replaceId?: string): Promise<void> {
    return this.enqueue(key, async (channel, chat) => { await channel.sendMarkdown(chat, markdown, replaceId) })
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
    return this.enqueue(key, (channel, chat) => this.sendLocalFileNow(channel, chat, key, path, description))
  }

  private async sendLocalFileNow(channel: Channel, chat: string, key: string, path: string, description?: string, note?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > channel.sendLimitBytes) {
      const notice = this.t.deliverableTooLarge(path)
      await channel.send(chat, { text: notice })
      this.log({ chatId: key }, { dir: 'out', kind: 'notice', text: notice })
      return
    }
    const data = new Uint8Array(await readFile(path))
    const label = description === undefined ? basename(path) : `${basename(path)}\n${description}`
    const caption = (note === undefined ? label : `${note}\n${label}`).slice(0, 1024)
    const photo = outgoingKind(path, info.size) === 'photo'
    await channel.sendFile(chat, { data, name: basename(path), photo }, caption)
    const attachment = await this.viewerAttachment(key, basename(path), data, photo ? sniffImageType(data) : undefined)
    this.log({ chatId: key }, {
      dir: 'out', kind: 'file', attachments: [{ ...attachment, path }],
      ...(description === undefined ? {} : { text: description }),
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

  /**
   * Run one send operation after the chat's earlier ones, containing its failure.
   * @param failed - told about a failure after it is logged.
   */
  private enqueue(key: string, send: (channel: Channel, chat: string) => Promise<void>, failed?: (error: unknown) => void): Promise<void> {
    const channel = this.channelOf(key)
    if (channel === undefined) return Promise.resolve()
    const { chat } = splitChatKey(key)
    const previous = this.sendTails.get(key) ?? Promise.resolve()
    const next = previous.then(() => send(channel, chat)).catch((error: unknown) => {
      this.logger.warn(`switchboard: send to chat ${key} failed: ${describe(error)}`)
      failed?.(error)
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
    this.flushProgress(request.sessionId)
    const t = this.t
    const id = randomUUID().slice(0, 12)
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.callId)
    const detail = call === undefined ? '' : approvalDetail(call.name, call.arguments)
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
    this.flushProgress(request.sessionId)
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
    const actor = this.actorOf(this.settingsOf(line), action.from)
    if (action.data.startsWith('pk:')) return this.handlePick(line, action, actor)
    if (action.data.startsWith('st:')) return this.handleStop(line, action)
    if (action.data.startsWith('qs:') || action.data.startsWith('qx:')) return this.handleQueued(line, action)
    if (action.data.startsWith('ab:')) return this.handleReplyAction(line, action, actor)
    if (action.data.startsWith('mn:')) return this.handleMenu(line, action, actor)
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
    // Guests watch; someone else (or the Web UI) answers.
    if (actor.role === 'guest') {
      await channel.ack(action, t.approvalNotYours)
      return
    }
    const who = action.from.username === undefined ? action.from.name : `@${action.from.username}`
    if (match[2] === 'y') pending.settle('allowed-once', t.approvalAllowed(who), who)
    else pending.settle('rejected', t.approvalRejected(who), who)
    await channel.ack(action)
  }

  private async handleStop(line: LiveLine, action: InboundAction): Promise<void> {
    const sessionId = this.stopIds.get(action.data.slice(3))
    const live = sessionId === undefined ? undefined : this.harness.live(sessionId)
    if (sessionId === undefined || live?.running !== true || !this.harness.cancel(sessionId)) {
      await line.channel.ack(action, this.t.notRunning)
      return
    }
    await line.channel.ack(action, this.t.stopRequested)
  }

  private async handleQueued(line: LiveLine, action: InboundAction): Promise<void> {
    const t = this.t
    const id = action.data.slice(3)
    const notice = this.queuedNotices.get(id)
    const waiting = notice === undefined ? undefined : this.harness.queued(notice.sessionId)?.some(item => item.id === notice.itemId)
    if (notice === undefined || waiting !== true) {
      await line.channel.ack(action, t.queueGone)
      return
    }
    this.queuedNotices.delete(id)
    await line.channel.ack(action)
    this.harness.dropQueued(notice.sessionId, [notice.itemId])
    const steer = action.data.startsWith('qs:')
    if (steer) await this.harness.prompt(notice.sessionId, notice.parts, 'steer')
    // The person's message now ends with the running turn, or is no longer being worked on.
    const receipt = this.receipts.get(notice.sessionId)?.find(candidate => candidate.key === notice.key && candidate.messageId === notice.sourceId)
    if (receipt !== undefined) {
      if (steer) receipt.at = 0
      else {
        this.receipts.set(notice.sessionId, (this.receipts.get(notice.sessionId) ?? []).filter(candidate => candidate !== receipt))
        this.settleReceipt(receipt, 'done')
      }
    }
    await this.enqueue(notice.key, async (channel, chat) => {
      await channel.edit(chat, notice.messageId, { text: steer ? t.queueSteered : t.queueDropped })
    })
  }

  private async handleMenu(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    await line.channel.ack(action)
    if (action.chat === undefined) return
    const key = chatKey(line.line.id, action.chat.id)
    const command = action.data.slice(3)
    if (!['new', 'sessions', 'model', 'mode', 'stop', 'compact', 'status', 'help'].includes(command)) return
    // Compact is a Harness command: without a Session it would reach the Agent as text.
    if (command === 'compact' && this.store.get(key).sessionId === undefined) return this.reply(key, this.t.noSession)
    try {
      await this.runCommand(key, command, '', actor)
    } catch (error: unknown) {
      await this.reply(key, this.t.failed(describe(error)))
    }
  }

  private async handleReplyAction(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    const [, id = '', verb = ''] = action.data.split(':')
    const actions = this.replyActions.get(id)
    if (actions === undefined) {
      await line.channel.ack(action, this.t.modelPickerExpired)
      return
    }
    await line.channel.ack(action)
    const key = action.chat === undefined ? actions.key : chatKey(line.line.id, action.chat.id)
    try {
      if (verb === 'c') await this.promptSession(key, actions.sessionId, [{ type: 'text', text: this.t.continuePrompt }], 'queue')
      else if (verb === 'r' && actions.retry !== undefined) await this.promptSession(key, actions.sessionId, actions.retry, 'queue')
      else if (verb === 'd') await this.sendChanges(key, actions)
      else if (verb === 'n') await this.runCommand(key, 'new', '', actor)
    } catch (error: unknown) {
      await this.reply(key, this.t.failed(describe(error)))
    }
  }

  private async handlePick(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    const [, id = '', index = ''] = action.data.split(':')
    const picker = this.pickers.get(id)
    if (picker === undefined || action.chat === undefined) {
      await line.channel.ack(action, this.t.modelPickerExpired)
      return
    }
    await line.channel.ack(action)
    const key = chatKey(line.line.id, action.chat.id)
    // Each press is checked against whoever pressed, not whoever asked for the list.
    if (picker.kind === 'mode' && actor.role !== 'admin') return this.reply(key, this.t.adminOnly)
    if (picker.kind === 'model' && actor.role === 'guest') return this.reply(key, this.t.adminOnly)
    if (picker.kind === 'session') {
      const sessionId = picker.choices[Number(index)]
      if (sessionId === undefined) return
      if (!(await this.mayUseSession(actor, sessionId))) return this.reply(key, this.t.dirDenied(actor.dirs ?? []))
      await this.store.update(key, { sessionId })
      await this.chatLog?.bind(key, sessionId).catch(() => {})
      this.attachToWorkspace(sessionId)
      return this.reply(key, this.t.bound(sessionId))
    }
    if (picker.kind === 'dir') {
      const cwd = picker.choices[Number(index)]
      if (cwd === undefined) return
      try {
        const sessionId = await this.newSession(key, cwd, actor)
        return await this.reply(key, this.t.created(sessionId, cwd))
      } catch (error: unknown) {
        return this.reply(key, this.t.failed(describe(error)))
      }
    }
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

/** Local wall-clock time of a timestamp, for notes about late messages. */
function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The tail of a reply in progress, sized for the progress message. */
function draftPreview(text: string, limit: number): string {
  const trimmed = text.trimEnd()
  const body = trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed
  return `${body} ▍`
}

/** The opening of a long reply, cut at a paragraph break. */
function replyPreview(text: string, limit = 1200): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  const cut = head.lastIndexOf('\n\n')
  const body = cut > limit / 2 ? head.slice(0, cut) : head
  // An unclosed code fence would swallow the note after it.
  return (body.match(/^```/gmu)?.length ?? 0) % 2 === 1 ? `${body}\n\`\`\`` : body
}

/**
 * What an approval shows of a call: a diff for file edits, the start of the
 * content for writes, the arguments otherwise.
 */
export function approvalDetail(name: string, raw: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return previewArguments(raw, 800)
  }
  const path = typeof args['file_path'] === 'string' ? args['file_path'] : undefined
  const lines = (text: string, mark: string, max: number): string[] => {
    const all = text.split('\n')
    const shown = all.slice(0, max).map(line => `${mark} ${line}`)
    return all.length > max ? [...shown, `${mark} … (+${all.length - max})`] : shown
  }
  if (name === 'edit' && path !== undefined && typeof args['old_string'] === 'string' && typeof args['new_string'] === 'string') {
    return [`📝 ${path}${args['replace_all'] === true ? ' (all matches)' : ''}`, ...lines(args['old_string'], '-', 12), ...lines(args['new_string'], '+', 12)].join('\n')
  }
  if (name === 'write' && path !== undefined && typeof args['content'] === 'string') {
    return [`📝 ${path}`, ...lines(args['content'], '+', 16)].join('\n')
  }
  return previewArguments(raw, 800)
}

/** A path with the home directory as `~`. */
function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/u, '') === b.replace(/[\\/]+$/u, '')
}

/** `git diff` of some files against HEAD, untracked files included as additions. */
function gitDiff(cwd: string, files: readonly string[]): Promise<string> {
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: DIFF_LIMIT_BYTES * 2, timeout: 15_000 }, (error, stdout) => {
      if (error !== null && stdout === '') reject(error)
      else resolve(stdout)
    })
  })
  return run(['diff', '--no-color', 'HEAD', '--', ...files]).then(async (tracked) => {
    const untracked = (await run(['ls-files', '--others', '--exclude-standard', '--', ...files]).catch(() => '')).split('\n').filter(Boolean)
    const added = await Promise.all(untracked.slice(0, 20).map(file => run(['diff', '--no-color', '--no-index', '--', '/dev/null', file]).catch(() => '')))
    return [tracked, ...added].filter(part => part.trim() !== '').join('\n')
  })
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
