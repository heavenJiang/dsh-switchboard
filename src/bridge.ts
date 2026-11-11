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
import { randomInt, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BindingStore, BoardState, DigestItem, PendingChoice } from './bindings.ts'
import { boardMessage, type BoardRow } from './board.ts'
import { FeishuChannel, type FeishuApi } from './channels/feishu.ts'
import { createFeishuApi } from './channels/feishu-api.ts'
import { TelegramChannel } from './channels/telegram.ts'
import {
  undelivered,
  type Button, type Channel, type ChannelChat, type ChannelSink, type OutMessage, type ChannelUser, type InboundAction, type InboundAttachment,
  type InboundMessage, type LineState, type SentMarkdown,
} from './channels/types.ts'
import type { ChatAttachment, ChatEntry, ChatInfo, ChatLog } from './chatlog.ts'
import { chatKey, splitChatKey, type LineSettings } from './lines.ts'
import { outgoingKind, promptImageType, sniffImageType } from './media.ts'
import { duration, MESSAGES, type BotLanguage, type Messages } from './messages.ts'
import { actorFor, mayRunCommand, mayUse, speakerLine, type Actor, type PersonSettings } from './people.ts'
import type { Outbox, OutboxPayload } from './outbox.ts'
import { parseScheduleAdd, scheduleIdsIn, type SchedulePort, type ScheduleTask } from './schedules.ts'
import { chunkText, isAllowed, parseDuration, parseInput, previewArguments, truncate } from './text.ts'

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
  /** Local time (`HH:MM`) of the daily digest of followed Sessions; empty sends each turn's notice instead. */
  readonly watchDigestTime?: string
  /** Add the model's plain-language reading to approvals of commands. */
  readonly approvalRiskHint?: boolean
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
   * @param signal - cancels the command, for those that can stop midway.
   * @returns the command's result, or undefined when no Harness command has that name.
   */
  runCommand(sessionId: string, line: string, signal: AbortSignal): Promise<HarnessCommandResult | undefined>
  /**
   * Branch a Session at its latest completed turn; the original stays as it is.
   * @returns the new Session.
   */
  forkSession(sessionId: string): Promise<string>
  /** Prompts waiting in a live Session's inbox; undefined when it is not loaded. */
  queued(sessionId: string): QueuedItem[] | undefined
  /** Drop queued prompts by id, or all; returns how many were dropped. */
  dropQueued(sessionId: string, ids: readonly string[] | 'all'): number
  /** How full a live Session's context is, in tokens; undefined when unknown. */
  contextUsage?(sessionId: string): { used: number; window?: number } | undefined
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
  /**
   * Have the Session's model explain one pending tool call in a sentence.
   * @returns the sentence, or undefined when it has none to give.
   */
  explainRisk?(sessionId: string, tool: string, args: string, language: BotLanguage, signal: AbortSignal): Promise<string | undefined>
  /** The Host's scheduled tasks; undefined while the deployment has none. */
  schedules?(): SchedulePort | undefined
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
export type TelegramApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'delegate' | 'timeout'

/** How long a chat has to answer: a reminder shortly before the end, which can buy more time. */
interface Deadline {
  /** Reminders sent, which the answer or an extension rewrites. */
  readonly reminders: { chat: string; messageId: string }[]
  /** The chats it waits on. */
  readonly chats: readonly string[]
  /** Start the wait over. */
  extend(): void
  /** Go back to the normal wait after away mode stretched it. */
  relax(): void
  clear(): void
}

/** One question waiting on a button. */
interface PendingApproval {
  readonly sessionId: string
  readonly toolName: string
  /** What "Allow for this turn" remembers. */
  readonly grantKey: string
  readonly prompts: { chat: string; messageId: string }[]
  /** The question as shown, which the model's reading may extend. */
  text: string
  settle(outcome: TelegramApprovalOutcome, note: string, by?: string): void
  /** Wait longer before handing the approval on. */
  extend(): void
}

/** One question the Agent asked, as a chat shows it. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string }[]
  readonly multiSelect?: boolean
  /** How a capable UI presents the question; `plan-review` asks to approve the plan in `detail`. */
  readonly intent?: { readonly kind: string; readonly approve?: string }
}

/** The answer batch for one question request. */
export interface QuestionAnswer {
  readonly answers: { id: string; selected: string[]; custom?: string }[]
}

/** A question request waiting on its chats. */
interface PendingQuestions {
  readonly sessionId: string
  readonly chats: string[]
  /** Wait longer before handing the questions on. */
  extend(): void
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
  /** The context is being compacted, which can take a while with nothing else to show. */
  compacting: boolean
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

/** A Harness command in flight; its chat sees a message once it outlasts {@link COMMAND_NOTICE_MS}. */
interface CommandRun {
  /** Short id the cancel button carries. */
  readonly id: string
  readonly key: string
  readonly sessionId: string
  readonly name: string
  readonly controller: AbortController
  readonly startedAt: number
  /** The progress message, once sent. */
  messageId: string | undefined
  /** Sends the first progress message. */
  notice: ReturnType<typeof setTimeout> | undefined
  /** Lets the inbound loop move on without waiting for the command. */
  release: () => void
  /** Keeps the typing indicator and the elapsed time fresh. */
  ticker: ReturnType<typeof setInterval> | undefined
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
  /** Chats that asked to hear the tasks behind this scheduled turn. */
  pushChats?: readonly string[]
  lastText?: string
  /** Tokens the turn's model calls reported. */
  usage?: { input: number; cached: number; output: number }
}

/** One entry of an Agent's todo list, as the `todo/write` event carries it. */
interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** A goal as the `goal/change` event carries it. */
interface GoalState {
  readonly objective: string
  readonly phase: string
  readonly blockedReason?: { readonly message: string }
  readonly maxGoalRounds?: number
}

/** A person who rejected an approval and may say why in their next message. */
interface Rejection {
  readonly userId: string
  readonly tool: string
  readonly at: number
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
  'status', 'model', 'mode', 'get', 'whoami', 'digest', 'fork', 'board', 'away', 'schedule', 'link',
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
/** How long a command may run before its chat gets a progress message; quicker ones just answer. */
const COMMAND_NOTICE_MS = 1000
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
/** A waiting chat is reminded this long before its time runs out, or a quarter of the wait when that is shorter. */
const REMINDER_LEAD_MS = 60_000
/** Sessions whose todo list is remembered for progress and /status. */
const TODO_SESSIONS = 64
/** Tools "Allow for this turn" may cover. Never a shell: allowing one command says nothing about the next. */
const TURN_GRANT_TOOLS = new Set(['edit', 'write'])
/** How long the next message of someone who rejected an approval counts as the reason. */
const REJECT_REASON_MS = 2 * 60 * 1000
/** A question's detail longer than this goes as its own message: buttons cannot sit under a split message. */
const QUESTION_DETAIL_LIMIT = 1500
/** What /digest looks back on. */
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000
/** A digest time; anything else counts as no digest, so notices are never held for one that cannot come. */
const DIGEST_TIME = /^([01]\d|2[0-3]):[0-5]\d$/u
/** Characters of a reply or failure a digest line quotes. */
const DIGEST_EXCERPT = 80
/** Boards repaint at most this often, however busy the Sessions are. */
const BOARD_INTERVAL_MS = 5000
/** Telegram's limit on a button's data. */
const BUTTON_DATA_BYTES = 64
/** The most a wait may stretch to between reminders in away mode. */
const AWAY_WAIT_MAX_MS = 60 * 60 * 1000
/** Durations `/away` offers as buttons, in hours. */
const AWAY_CHOICES = [1, 4, 12]
/** How long a pairing code from the Web UI works. */
const CLAIM_TTL_MS = 10 * 60 * 1000
const CLAIM_LENGTH = 6
/** Letters and digits nobody mistakes for one another when typing a code. */
const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** How long the model may take to explain an approval before the chat goes without. */
const RISK_TIMEOUT_MS = 20_000
/** An approval this long has no room left for the model's reading. */
const RISK_TEXT_LIMIT = 3800
/** Tasks `/schedule` lists. */
const SCHEDULE_LIST_LIMIT = 10
/** Characters of a task's instruction its detail shows. */
const SCHEDULE_PROMPT_LENGTH = 800
/** The Agent may reach the phone at most this often per Session, so a loop cannot flood it. */
const AGENT_NOTICE_INTERVAL_MS = 30_000
/** Characters of one message from the Agent. */
const AGENT_NOTICE_LENGTH = 2000
/** Another plugin may post to the phone at most this often, so a loop in it cannot flood the chats. */
const PLUGIN_PUSH_INTERVAL_MS = 10_000
/** Characters of one post from another plugin; longer text is cut, and replies over `longReplyChars` still go as a file. */
const PLUGIN_PUSH_LENGTH = 60_000

/** Why a post from another plugin did not go out. */
export type PhonePushReason = 'disabled' | 'no-chat' | 'empty' | 'too-soon'

/** The bridge core. One instance lives for the plugin's lifetime; lines restart when their settings change. */
export class Switchboard {
  private readonly live = new Map<string, LiveLine>()
  private readonly sendTails = new Map<string, Promise<void>>()
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>()
  /** Harness commands in flight, by the short id their cancel button carries. */
  private readonly commandRuns = new Map<string, CommandRun>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestions>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  /** The running turn's progress message per Session. */
  private readonly progress = new Map<string, Progress>()
  /** The latest todo list per Session. */
  private readonly todos = new Map<string, readonly TodoItem[]>()
  /** The current goal per Session. */
  private readonly goals = new Map<string, GoalState & { rounds: number }>()
  /** Running subagents per top-level Session. */
  private readonly subagents = new Map<string, Set<string>>()
  /** Approvals allowed for the rest of the running turn, per Session: tool and reason → who allowed them. */
  private readonly turnGrants = new Map<string, Map<string, string>>()
  /** Chats that see a Session's next turns because they replied to it: chat key → turns left. */
  private readonly routed = new Map<string, Map<string, number>>()
  /** Rejections whose reason may still arrive, per chat key. */
  private readonly rejections = new Map<string, Rejection>()
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
  /** Waits for an answer now running. */
  private readonly deadlines = new Set<Deadline>()
  /** How each Session's last turn failed, until its next turn starts. */
  private readonly failures = new Map<string, string>()
  /** What each board last showed, so an unchanged one is not edited. */
  private readonly boardShown = new Map<string, string>()
  private boardTimer: ReturnType<typeof setTimeout> | undefined
  private boardPaintedAt = 0
  /** Pairing codes from the Web UI: code → Session and expiry. */
  private readonly claims = new Map<string, { sessionId: string; expiresAt: number }>()
  /** When the Agent last reached the phone, per Session. */
  private readonly agentNotices = new Map<string, number>()
  private lastPluginPush = 0
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
      this.checkAway()
      void this.flushOutbox()
      this.refreshBoards().catch((error: unknown) => {
        this.logger.warn(`switchboard: board update failed: ${describe(error)}`)
      })
      this.sendDailyDigest().catch((error: unknown) => {
        this.logger.warn(`switchboard: daily digest failed: ${describe(error)}`)
      })
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
    clearTimeout(this.boardTimer)
    this.boardTimer = undefined
    for (const progress of this.progress.values()) {
      clearTimeout(progress.timer)
      clearInterval(progress.ticker)
    }
    this.progress.clear()
    for (const run of this.commandRuns.values()) this.quietCommand(run)
    await Promise.allSettled([...this.sendTails.values()])
    for (const id of [...this.live.keys()]) await this.stopLine(id)
  }

  /** Stop for good: also abort in-flight transcriptions. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const run of this.commandRuns.values()) run.controller.abort()
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
      if (sent !== undefined) this.noteRoute(key, sent.messageId, sessionId)
      // A live reply may get the turn's buttons; a late one does not.
      if (sent !== undefined && sessionId !== undefined && note === undefined) {
        const replies = this.lastReplies.get(sessionId) ?? new Map<string, SentMarkdown>()
        replies.set(key, sent)
        this.lastReplies.set(sessionId, replies)
      }
      return
    }
    for (const chunk of chunkText(text)) this.noteRoute(key, await channel.send(chat, { text: chunk }), sessionId)
    this.log({ chatId: key }, { dir: 'out', kind: 'notice', text: payload.text }, sessionId)
  }

  /** Remember the Session a sent message speaks for, so a reply to it reaches that Session. */
  private noteRoute(key: string, messageId: string, sessionId: string | undefined): void {
    if (sessionId !== undefined) void this.store.addRoute(key, messageId, sessionId)
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
          void this.store.addDigest(watchers, { sessionId, at: turn.at, kind: 'completed', text: truncate(turn.text, DIGEST_EXCERPT) })
          if (!this.digestOn()) for (const key of watchers) void this.durable(key, { kind: 'text', text: excerpt }, sessionId)
        } else if (turn.kind !== 'completed' && turn.kind !== 'aborted') {
          const message = t.caughtUpFailed(time, turn.error ?? turn.kind)
          void this.store.addDigest(watchers, { sessionId, at: turn.at, kind: turn.kind, text: truncate(turn.error ?? turn.kind, DIGEST_EXCERPT) })
          for (const key of [...chats, ...watchers]) void this.durable(key, { kind: 'text', text: message }, sessionId)
        }
      }
      await this.store.setCursor(sessionId, events.at(-1)!.seq)
    }
  }

  /** The bot menu: the bridge's main commands, then the Harness commands Telegram can name. */
  private async registerCommands(entry: LiveLine, harnessCommands?: readonly HarnessCommand[]): Promise<void> {
    const t = this.t
    const listed = harnessCommands ?? await this.harness.listCommands(undefined).catch((error: unknown) => {
      this.logger.warn(`switchboard [${entry.line.id}]: Harness commands left out of the menu: ${describe(error)}`)
      return []
    })
    const extra = listed
      .filter(command => MENU_NAME.test(command.name) && !BRIDGE_COMMANDS.has(command.name) && !WEB_ONLY_COMMANDS.has(command.name))
      .slice(0, 20)
      .map(command => ({ command: command.name, description: truncate(command.description || command.name, 256) }))
    // Set from the whole list: commands that all fail the filter need no further tries.
    entry.menuHasHarness = listed.length > 0
    // Old lists stay gone once cleared, so reconnecting need not ask again; another bot on the line starts over.
    const bot = `${entry.line.id}:${entry.channel.username ?? ''}`
    const clearOthers = !this.store.menuCleared(bot)
    await entry.channel.setMenu([
      { command: 'menu', description: t.cmdMenu },
      { command: 'new', description: t.cmdNew },
      { command: 'stop', description: t.cmdStop },
      { command: 'model', description: t.cmdModel },
      { command: 'mode', description: t.cmdMode },
      { command: 'watch', description: t.cmdWatch },
      { command: 'get', description: t.cmdGet },
      { command: 'status', description: t.cmdStatus },
      { command: 'digest', description: t.cmdDigest },
      { command: 'board', description: t.cmdBoard },
      { command: 'away', description: t.cmdAway },
      { command: 'schedule', description: t.cmdSchedule },
      { command: 'help', description: t.cmdHelp },
      ...extra,
    ], clearOthers).then(async () => {
      if (clearOthers) await this.store.setMenuCleared(bot)
    }).catch((error: unknown) => {
      this.logger.debug(`switchboard [${entry.line.id}]: menu update failed: ${describe(error)}`)
    })
  }

  /** Add the Harness commands to menus registered before any Agent could name them. */
  private refreshMenus(): void {
    for (const entry of this.live.values()) {
      if (entry.state.kind === 'running' && !entry.menuHasHarness) void this.registerCommands(entry)
    }
  }

  // ─── inbound ────────────────────────────────────────────────────────────

  /** Whether a user (or the whole chat) may drive the Harness through a line. */
  private allowed(line: LineSettings, user: ChannelUser, chat: ChannelChat | undefined): boolean {
    if ([user.id, ...(user.aliases ?? [])].some(id => isAllowed(line.allowedUsers, id, user.username))) return true
    return chat !== undefined && line.allowedChats.some(id => id.trim() === chat.id)
  }

  /**
   * What a person may do on a line.
   * @param chat - where they are; in a group the Agent is told who speaks.
   */
  private actorOf(line: LineSettings, user: ChannelUser, chat?: ChannelChat): Actor {
    const ids = [user.id, ...(user.aliases ?? []), ...(user.username === undefined ? [] : [`@${user.username}`])]
    const byName = ids.some(id => isAllowed(line.allowedUsers, id))
    const fallback = line.workspacePath.trim() || this.settings().workspacePath.trim() || undefined
    const actor = actorFor(this.settings().people, line.id, ids, !byName, fallback)
    return chat?.type === 'group' ? { ...actor, speaker: speakerLine(actor.role, user.name, user.username) } : actor
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
    const actor = this.actorOf(line, message.from, message.chat)
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
      const target = parsed?.kind === 'command' ? undefined : await this.replyTarget(key, message, actor)
      if (message.voice !== undefined && this.settings().transcribeVoice) return await this.promptWithVoice(key, message, actor, target)
      if (attachments.length > 0) return await this.promptWithMedia(key, message, actor, undefined, target)
      if (text === undefined) return await this.reply(key, t.unsupported)
      if (parsed === undefined) return
      if (parsed.kind === 'text' && this.answerByText(key, parsed.text, target)) return
      const rejection = parsed.kind === 'text' && target === undefined ? this.takeRejection(key, from.id) : undefined
      if (parsed.kind === 'text' && rejection !== undefined) {
        const sessionId = this.store.get(key).sessionId
        const mode = sessionId !== undefined && this.harness.live(sessionId)?.running === true ? 'steer' : 'queue'
        return await this.promptFromChat(key, [{ type: 'text', text: t.rejectedBecause(rejection.tool, parsed.text) }], mode, actor, message.messageId)
      }
      if (parsed.kind === 'text') return await this.promptFromChat(key, [{ type: 'text', text: this.withQuote(parsed.text, message.quote) }], this.promptMode(key, message.quote), actor, message.messageId, target)
      return await this.runCommand(key, parsed.name, parsed.args, actor)
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  /**
   * Download every attachment of one message (or album), stage it into the
   * chat's Session, and prompt with the text plus the receipts.
   */
  private async promptWithMedia(key: string, message: InboundMessage, actor: Actor, note?: string, target?: string): Promise<void> {
    const channel = this.channelOf(key)
    if (channel === undefined) return
    const t = this.t
    const sessionId = target ?? await this.ensureSession(key, actor)
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
    if (target !== undefined) await this.followReply(key, target)
    await this.promptSession(key, sessionId, spoken(parts, actor), 'queue', message.messageId)
  }

  /**
   * Transcribe a voice note and prompt with the text; when the host cannot
   * transcribe, the note goes to the Agent as an audio file instead.
   */
  private async promptWithVoice(key: string, message: InboundMessage, actor: Actor, target?: string): Promise<void> {
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
      return this.promptWithMedia(key, message, actor, t.voiceUnavailable(describe(error)), target)
    }
    if (transcript === '') return this.reply(key, t.voiceEmpty)
    const caption = (message.text ?? '').trim()
    const text = this.withQuote(caption === '' ? transcript : `${caption}\n\n${transcript}`, message.quote)
    this.log(chatInfo(key, message.chat), { dir: 'in', kind: 'text', from: sender(message.from), text: `🎤 ${text}` })
    await this.reply(key, t.voiceHeard(transcript))
    await this.promptFromChat(key, [{ type: 'text', text }], this.promptMode(key, message.quote), actor, message.messageId, target)
  }

  /**
   * The Session a reply is meant for, when it is not the one the chat talks to.
   * @throws when the person may not use that Session: sending it to the bound
   *   Session instead would put the words in the wrong conversation.
   */
  private async replyTarget(key: string, message: InboundMessage, actor: Actor): Promise<string | undefined> {
    if (message.replyToId === undefined) return undefined
    const sessionId = this.store.routeOf(key, message.replyToId)
    if (sessionId === undefined || sessionId === this.store.get(key).sessionId) return undefined
    if (!(await this.mayUseSession(actor, sessionId))) throw new Error(this.t.dirDenied(actor.dirs ?? []))
    return sessionId
  }

  /** Show a chat the turn its reply starts, and say where the reply went: it is not the chat's own Session. */
  private async followReply(key: string, sessionId: string): Promise<void> {
    const chats = this.routed.get(sessionId) ?? new Map<string, number>()
    // A reply to a busy Session waits behind the running turn, which ends first.
    chats.set(key, (chats.get(key) ?? 0) + (this.harness.live(sessionId)?.running === true ? 2 : 1))
    this.routed.set(sessionId, chats)
    const title = (await this.harness.listSessions().catch(() => [])).find(row => row.sessionId === sessionId)?.title ?? shortId(sessionId)
    await this.reply(key, this.t.routedTo(title))
  }

  /** Take a turn off the chats following a Session because they replied to it. */
  private spendRouted(sessionId: string): void {
    const chats = this.routed.get(sessionId)
    if (chats === undefined) return
    for (const [key, left] of chats) {
      if (left <= 1) chats.delete(key)
      else chats.set(key, left - 1)
    }
    if (chats.size === 0) this.routed.delete(sessionId)
  }

  /** The rejection a person's next message explains, once and only while it is fresh. */
  private takeRejection(key: string, userId: string): Rejection | undefined {
    const rejection = this.rejections.get(key)
    if (rejection === undefined || rejection.userId !== userId) return undefined
    this.rejections.delete(key)
    return Date.now() - rejection.at <= REJECT_REASON_MS ? rejection : undefined
  }

  /**
   * How a person's text joins the chat's Session: into the running turn on a
   * line set to steer, else the queue. A quote points at something else, so it
   * waits for its own turn.
   */
  private promptMode(key: string, quote: string | undefined): 'queue' | 'steer' {
    if (quote !== undefined && quote.trim() !== '') return 'queue'
    const line = this.settings().lines.find(candidate => candidate.id === splitChatKey(key).line)
    if (line?.steerWhileBusy !== true) return 'queue'
    const sessionId = this.store.get(key).sessionId
    return sessionId !== undefined && this.harness.live(sessionId)?.running === true ? 'steer' : 'queue'
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
        // `t.me/<bot>?start=link_<code>` from the QR on a Web Session.
        if (name === 'start' && args.startsWith('link_')) return this.claimSession(key, args.slice('link_'.length), actor)
        return this.sendMenu(key, name === 'start')
      case 'link':
        if (args === '') return this.reply(key, t.linkUsage)
        return this.claimSession(key, args, actor)
      case 'board':
        return args.trim().toLowerCase() === 'off' ? this.closeBoard(key) : this.openBoard(key, actor)
      case 'away':
        return this.awayCommand(key, args, actor)
      case 'schedule':
        if (actor.role !== 'admin') return this.reply(key, t.adminOnly)
        return this.scheduleCommand(key, args, actor)
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
        const runs = [...this.commandRuns.values()].filter(run => run.sessionId === binding.sessionId)
        for (const run of runs) this.cancelCommand(run)
        const stopped = live?.running === true && this.harness.cancel(binding.sessionId)
        return this.reply(key, stopped || runs.length > 0 ? t.stopped : t.notRunning)
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
        const sessionId = binding.sessionId
        const turn = sessionId === undefined ? undefined : this.turns.get(sessionId)
        const context = sessionId === undefined ? undefined : this.harness.contextUsage?.(sessionId)
        const queued = sessionId === undefined ? undefined : this.harness.queued(sessionId)?.length
        const todos = sessionId === undefined ? undefined : todoSummary(t, this.todos.get(sessionId))
        const goal = sessionId === undefined ? undefined : this.goals.get(sessionId)
        const subagents = sessionId === undefined ? 0 : this.subagents.get(sessionId)?.size ?? 0
        return this.reply(key, t.status({
          bot: state.kind === 'running' ? `${entry?.line.type === 'telegram' ? '@' : ''}${state.username}` : state.kind,
          ...(binding.sessionId === undefined ? {} : { session: binding.sessionId }),
          ...(live?.cwd === undefined ? {} : { cwd: live.cwd }),
          ...(live === undefined ? {} : { running: live.running }),
          ...(model === undefined ? {} : { model: modelLabel(model) }),
          ...(context === undefined ? {} : { context: contextLabel(context) }),
          ...(turn === undefined ? {} : { turn: t.statusTurn(duration((Date.now() - turn.startedAt) / 1000, this.settings().language), turn.tools, turnTokens(t, turn)) }),
          ...(queued === undefined || queued === 0 ? {} : { queued }),
          ...(todos === undefined ? {} : { todos }),
          ...(goal === undefined ? {} : { goal: t.goalStatus(truncate(goal.objective, 80), goal.phase, goal.rounds, goal.maxGoalRounds) }),
          ...(subagents === 0 ? {} : { subagents }),
          ...(binding.away === undefined ? {} : { away: clock(binding.away.until) }),
        }))
      }
      case 'digest': {
        const digest = await this.digestText(key, Date.now() - DIGEST_WINDOW_MS)
        return this.reply(key, digest ?? ((binding.watch ?? []).length === 0 ? t.digestNoWatch : t.digestEmpty))
      }
      case 'fork':
        if (binding.sessionId === undefined) return this.reply(key, t.noSession)
        return this.forkSession(key, binding.sessionId, actor)
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
          return this.startCommand(key, binding.sessionId, name, line, actor)
        }
        return this.promptFromChat(key, [{ type: 'text', text: line }], 'queue', actor)
      }
    }
  }

  /**
   * Run a Harness command and show it working. Resolves with a quick command's
   * answer, keeping later messages behind it, or at {@link COMMAND_NOTICE_MS},
   * since inbound updates wait for this and `/stop` or an approval must still get through.
   */
  private async startCommand(key: string, sessionId: string, name: string, line: string, actor: Actor): Promise<void> {
    if ([...this.commandRuns.values()].some(run => run.sessionId === sessionId && run.name === name)) {
      return this.reply(key, this.t.commandRunning(name))
    }
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    const run: CommandRun = {
      id: randomUUID().slice(0, 8), key, sessionId, name, controller: new AbortController(), startedAt: Date.now(),
      messageId: undefined, notice: undefined, release, ticker: undefined,
    }
    this.commandRuns.set(run.id, run)
    const showTyping = (): void => {
      void this.channelOf(key)?.typing(splitChatKey(key).chat).catch(() => {})
    }
    showTyping()
    run.notice = setTimeout(() => {
      run.notice = undefined
      this.renderCommand(run)
      run.ticker = setInterval(() => {
        showTyping()
        this.renderCommand(run)
      }, TYPING_INTERVAL_MS)
      release()
    }, COMMAND_NOTICE_MS)
    await Promise.race([released, this.finishCommand(run, line, actor)])
  }

  /** Wait for a command, then answer in its chat; never rejects, since nobody may be waiting. */
  private async finishCommand(run: CommandRun, line: string, actor: Actor): Promise<void> {
    const { key, name, controller: { signal } } = run
    const t = this.t
    let text: string | undefined
    try {
      const result = await this.harness.runCommand(run.sessionId, line, signal)
      if (result?.kind === 'error') text = signal.aborted ? t.commandCancelled(name) : t.commandFailed(name, result.text ?? '')
      else if (result !== undefined) text = result.text === undefined || result.text.trim() === '' ? t.commandDone(name) : result.text
    } catch (error: unknown) {
      text = signal.aborted ? t.commandCancelled(name) : t.failed(describe(error))
    }
    this.quietCommand(run)
    this.commandRuns.delete(run.id)
    // Stepping aside rather than editing, so the answer is the latest message and notifies.
    const elapsed = duration((Date.now() - run.startedAt) / 1000, this.settings().language)
    await this.enqueue(key, async (channel, chat) => {
      if (run.messageId !== undefined) await channel.retire(chat, run.messageId, t.commandSummary(name, elapsed)).catch(() => {})
    })
    try {
      // No Harness command has that name after all: it is text for the Agent.
      await (text === undefined ? this.promptFromChat(key, [{ type: 'text', text: line }], 'queue', actor) : this.reply(key, text))
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  /** Paint a command's progress message. */
  private renderCommand(run: CommandRun): void {
    const t = this.t
    const elapsed = duration((Date.now() - run.startedAt) / 1000, this.settings().language)
    const cancelling = run.controller.signal.aborted
    const text = cancelling ? t.commandCancelling(run.name) : t.commandProgress(run.name, elapsed)
    const buttons = cancelling ? [] : [[{ text: t.cancelButton, data: `cc:${run.id}` }]]
    void this.enqueue(run.key, async (channel, chat) => {
      // A command that ended while this waited in the queue has nothing left to show.
      if (!this.commandRuns.has(run.id)) return
      if (run.messageId === undefined) run.messageId = await channel.send(chat, { text, buttons, editable: true })
      else await channel.edit(chat, run.messageId, { text, buttons, editable: true }).catch(() => {})
    })
  }

  /** Stop showing a command and stop holding the inbound loop for it; the command itself goes on. */
  private quietCommand(run: CommandRun): void {
    clearTimeout(run.notice)
    clearInterval(run.ticker)
    run.notice = undefined
    run.ticker = undefined
    run.release()
  }

  private cancelCommand(run: CommandRun): void {
    if (run.controller.signal.aborted) return
    run.controller.abort()
    // Before the first paint there is nothing to update; that paint shows the cancelling state.
    if (run.ticker !== undefined) this.renderCommand(run)
  }

  /** Branch a Session at its latest completed turn and move the chat to the branch; the original stays. */
  private async forkSession(key: string, sessionId: string, actor: Actor): Promise<void> {
    const t = this.t
    if (actor.role === 'guest') return this.reply(key, t.adminOnly)
    if (!(await this.mayUseSession(actor, sessionId))) return this.reply(key, t.dirDenied(actor.dirs ?? []))
    const forked = await this.harness.forkSession(sessionId)
    await this.store.update(key, { sessionId: forked })
    await this.chatLog?.bind(key, forked).catch(() => {})
    this.attachToWorkspace(forked)
    return this.reply(key, t.forked(shortId(forked), shortId(sessionId)))
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
      [{ text: t.menuBoard, data: 'mn:board' }, { text: t.menuAway, data: 'mn:away' }],
      [{ text: t.menuModel, data: 'mn:model' }, { text: t.menuMode, data: 'mn:mode' }],
      [{ text: t.menuStop, data: 'mn:stop' }, { text: t.menuCompact, data: 'mn:compact' }],
      [{ text: t.menuStatus, data: 'mn:status' }, { text: t.menuSchedule, data: 'mn:schedule' }],
      [{ text: t.menuHelp, data: 'mn:help' }],
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
  private async promptFromChat(key: string, parts: readonly PromptPart[], mode: 'queue' | 'steer', actor: Actor, source?: string, target?: string): Promise<void> {
    if (target !== undefined) await this.followReply(key, target)
    const sessionId = target ?? await this.ensureSession(key, actor)
    if (sessionId === undefined) return
    await this.promptSession(key, sessionId, spoken(parts, actor), mode, source)
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
    const chats = new Set([...this.store.chatsFor(sessionId), ...this.routed.get(sessionId)?.keys() ?? []])
    if (this.turns.get(sessionId)?.scheduled === true) {
      for (const id of this.settings().scheduleChats) if (id.trim() !== '') chats.add(id.trim())
      for (const id of this.turns.get(sessionId)?.pushChats ?? []) chats.add(id)
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
      this.turnGrants.delete(sessionId)
      this.failures.delete(sessionId)
      const startedAt = event.time ?? Date.now()
      this.turns.set(sessionId, { startedAt, tools: 0, scheduled: false })
      this.startProgress(sessionId, startedAt)
      this.clearReplyButtons(sessionId)
      this.updateQueuedNotices(sessionId)
      this.refreshMenus()
      this.markBoards()
      return
    }
    if (event.type === 'user/message') {
      // The event's data is the committed message itself.
      const message = event.data as { source?: { kind?: string }; content?: readonly { type: string; text?: string }[] } | undefined
      const turn = this.turns.get(sessionId)
      if (message?.source?.kind === 'schedule' && turn !== undefined) {
        turn.scheduled = true
        const text = (message.content ?? []).map(block => block.text ?? '').join('\n')
        turn.pushChats = [...new Set(scheduleIdsIn(text).flatMap(id => this.store.schedulePush(id)))]
      }
      return
    }
    const turn = this.turns.get(sessionId)
    if (event.type === 'workspace/changes' && event.seq !== undefined) {
      const files = this.harness.changedFiles(sessionId, event.seq)
      if (files !== undefined && turn !== undefined) turn.files = files
      return
    }
    if (event.type === 'todo/write') {
      this.todos.delete(sessionId)
      this.todos.set(sessionId, (event.data as { todos?: readonly TodoItem[] } | undefined)?.todos ?? [])
      while (this.todos.size > TODO_SESSIONS) this.todos.delete(this.todos.keys().next().value as string)
      const progress = this.progress.get(sessionId)
      if (progress !== undefined) this.scheduleProgress(sessionId, progress)
      return
    }
    if (event.type === 'goal/change') {
      this.onGoalChange(sessionId, event.data as GoalChange | undefined)
      return
    }
    if (event.type === 'compaction/start' || event.type === 'compaction/end') {
      const progress = this.progress.get(sessionId)
      if (progress === undefined) return
      progress.compacting = event.type === 'compaction/start'
      this.scheduleProgress(sessionId, progress)
      return
    }
    const chats = this.outputChats(sessionId)
    const watchers = this.store.watchersOf(sessionId).filter(key => !chats.includes(key))
    if (event.type === 'assistant/message') {
      if (turn !== undefined) addUsage(turn, event.data)
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
      this.turnGrants.delete(sessionId)
      this.subagents.delete(sessionId)
      this.spendRouted(sessionId)
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      const kind = reason?.kind ?? 'completed'
      const endedAt = event.time ?? Date.now()
      if (kind !== 'completed' && kind !== 'aborted') this.noteFailure(sessionId, reason?.error?.message ?? kind)
      const excerpt = kind === 'completed' ? turn?.lastText : reason?.error?.message ?? kind
      void this.store.addAwayItem(this.awayAmong([...chats, ...watchers]), {
        sessionId, at: endedAt, kind, ...(excerpt === undefined ? {} : { text: truncate(excerpt, DIGEST_EXCERPT) }),
      })
      this.markBoards()
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

  /** Remember a Session's goal, and tell its chats when it is reached or stuck: they may be nowhere near the Web UI. */
  private onGoalChange(sessionId: string, change: GoalChange | undefined): void {
    if (change === undefined) return
    if (change.goal === undefined) {
      this.goals.delete(sessionId)
      return
    }
    const rounds = change.roundsStarted ?? 0
    this.goals.delete(sessionId)
    this.goals.set(sessionId, { ...change.goal, rounds })
    while (this.goals.size > TODO_SESSIONS) this.goals.delete(this.goals.keys().next().value as string)
    const t = this.t
    const objective = truncate(change.goal.objective, EXCERPT_LENGTH)
    const text = change.operation === 'complete' ? t.goalComplete(objective, rounds)
      : change.operation === 'block' ? t.goalBlocked(objective, change.goal.blockedReason?.message) : undefined
    if (text === undefined) return
    for (const key of new Set([...this.outputChats(sessionId), ...this.store.watchersOf(sessionId)])) void this.durable(key, { kind: 'text', text }, sessionId)
  }

  /**
   * Follow a subagent's run state for its top-level Session's progress message.
   * @param rootId - the top-level Session it works for.
   * @param childId - the subagent's Session.
   */
  onSubagentStatus(rootId: string, childId: string, running: boolean): void {
    if (this.live.size === 0) return
    const children = this.subagents.get(rootId) ?? new Set<string>()
    if (running === children.has(childId)) return
    if (running) children.add(childId)
    else children.delete(childId)
    if (children.size === 0) this.subagents.delete(rootId)
    else this.subagents.set(rootId, children)
    const progress = this.progress.get(rootId)
    if (progress !== undefined) this.scheduleProgress(rootId, progress)
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
      void this.store.addDigest(watchers, { sessionId, at: endedAt, kind, text: truncate(error ?? kind, DIGEST_EXCERPT) })
      const watchMessage = kind === 'aborted' ? t.watchAborted(title) : t.watchFailed(title, error ?? kind)
      for (const key of watchers) void this.durable(key, { kind: 'text', text: watchMessage }, sessionId)
      return
    }
    if (turn === undefined) return
    const seconds = (endedAt - turn.startedAt) / 1000
    const s = this.settings()
    const tokens = turnTokens(t, turn)
    const summary = { seconds, tools: turn.tools, files: turn.files ?? [], ...(tokens === undefined ? {} : { tokens }) }
    const wanted = s.turnSummary === 'always' || (s.turnSummary === 'long' && seconds >= s.turnSummaryMinSec)
    if (wanted) for (const key of chats) void this.durable(key, { kind: 'text', text: t.turnDone(summary) }, sessionId)
    void this.store.addDigest(watchers, {
      sessionId, at: endedAt, kind,
      ...(turn.lastText === undefined ? {} : { text: truncate(turn.lastText, DIGEST_EXCERPT) }),
    })
    if (watchers.length > 0 && !this.digestOn()) {
      const excerpt = turn.lastText === undefined ? undefined : truncate(turn.lastText, EXCERPT_LENGTH)
      const message = t.turnDone({ ...summary, title, ...(excerpt === undefined ? {} : { excerpt }) })
      for (const key of watchers) void this.durable(key, { kind: 'text', text: message }, sessionId)
    }
  }

  // ─── digest of followed Sessions ────────────────────────────────────────

  /** Whether finished turns of followed Sessions wait for the daily digest. */
  private digestOn(): boolean {
    return DIGEST_TIME.test((this.settings().watchDigestTime ?? '').trim())
  }

  /**
   * One message about a chat's followed Sessions: what finished, what failed,
   * what waits for an answer, and what runs now.
   * @param since - turns before this time are left out.
   * @returns the message, or undefined when there is nothing to tell.
   */
  private async digestText(key: string, since: number): Promise<string | undefined> {
    const watched = this.store.get(key).watch ?? []
    const items = this.store.digestItems(key).filter(item => item.at >= since)
    if (watched.length === 0 && items.length === 0) return undefined
    return this.roundup(items, watched)
  }

  /**
   * What became of some Sessions: the turns given, plus what waits and runs now.
   * @returns the message, or undefined when there is nothing to tell.
   */
  private async roundup(items: readonly DigestItem[], sessions: readonly string[]): Promise<string | undefined> {
    const t = this.t
    const rows = await this.harness.listSessions().catch(() => [])
    const title = (sessionId: string): string => rows.find(row => row.sessionId === sessionId)?.title ?? shortId(sessionId)
    const lines = (kept: readonly DigestItem[]): string[] => [...new Set(kept.map(item => item.sessionId))].map((sessionId) => {
      const own = kept.filter(item => item.sessionId === sessionId)
      return t.digestLine(title(sessionId), own.length, own.at(-1)?.text)
    })
    const approvals = [...this.approvals.values()]
    const questions = [...this.questions.values()]
    const waiting = sessions.flatMap((sessionId) => {
      const count = approvals.filter(item => item.sessionId === sessionId).length + questions.filter(item => item.sessionId === sessionId).length
      return count === 0 ? [] : [t.digestWaitingLine(title(sessionId), count)]
    })
    const done = lines(items.filter(item => item.kind === 'completed'))
    const failed = lines(items.filter(item => item.kind !== 'completed'))
    const running = sessions.filter(sessionId => this.harness.live(sessionId)?.running === true).map(sessionId => `· ${title(sessionId)}`)
    if (done.length + failed.length + waiting.length + running.length === 0) return undefined
    return t.digest({ done, failed, waiting, running })
  }

  /** Send each chat its waiting turns once a day, at the set time or the first check after it. */
  async sendDailyDigest(now: Date = new Date()): Promise<void> {
    if (!this.digestOn()) return
    const time = (this.settings().watchDigestTime ?? '').trim()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` < time || this.store.digestDay() === day) return
    void this.store.setDigestDay(day)
    for (const key of this.store.digestChats()) {
      const text = await this.digestText(key, 0)
      await this.store.clearDigest(key)
      if (text !== undefined) await this.durable(key, { kind: 'text', text })
    }
  }

  // ─── the live board ─────────────────────────────────────────────────────

  /** Remember how a Session's turn failed, for the board. */
  private noteFailure(sessionId: string, error: string): void {
    this.failures.delete(sessionId)
    this.failures.set(sessionId, error)
    while (this.failures.size > TODO_SESSIONS) this.failures.delete(this.failures.keys().next().value as string)
  }

  /** What a board shows: Sessions needing something, and idle ones the chat is linked to. */
  private boardRows(key: string, sessions: readonly SessionRow[], dirs: readonly string[] | undefined): BoardRow[] {
    const t = this.t
    const binding = this.store.get(key)
    const linked = new Set([binding.sessionId, ...binding.watch ?? []])
    const pending = [...this.approvals.values(), ...this.questions.values()]
    const scope: Actor = dirs === undefined ? { role: 'admin' } : { role: 'member', dirs }
    return sessions.filter(row => mayUse(scope, row.cwd)).flatMap((row): BoardRow[] => {
      const { sessionId } = row
      const title = row.title ?? shortId(sessionId)
      const waiting = pending.filter(item => item.sessionId === sessionId).length
      const failure = this.failures.get(sessionId)
      if (waiting > 0) return [{ sessionId, title, state: 'waiting', detail: t.boardWaiting(waiting) }]
      if (row.running || this.harness.live(sessionId)?.running === true) {
        const turn = this.turns.get(sessionId)
        const todos = todoSummary(t, this.todos.get(sessionId))
        const elapsed = turn === undefined ? t.boardBusy : t.boardRunning(duration((Date.now() - turn.startedAt) / 1000, this.settings().language), turn.tools)
        return [{ sessionId, title, state: 'running', detail: todos === undefined ? elapsed : `${elapsed} · ${todos}` }]
      }
      if (failure !== undefined) return [{ sessionId, title, state: 'failed', detail: truncate(failure, DIGEST_EXCERPT) }]
      return linked.has(sessionId) ? [{ sessionId, title, state: 'idle', detail: t.boardIdle }] : []
    })
  }

  /** Open a board in a chat, replacing the one it has. */
  private async openBoard(key: string, actor: Actor): Promise<void> {
    const t = this.t
    const message = boardMessage(t, this.boardRows(key, await this.harness.listSessions(), actor.dirs))
    const old = this.store.get(key).board
    await this.enqueue(key, async (channel, chat) => {
      if (old !== undefined) await channel.retire(chat, old.messageId, t.boardClosed).catch(() => {})
      const messageId = await channel.send(chat, message)
      await this.store.setBoard(key, { messageId, ...(actor.dirs === undefined ? {} : { dirs: actor.dirs }) })
      this.boardShown.set(key, JSON.stringify(message))
      // A group may not let the bot pin; the board works unpinned.
      await channel.pin?.(chat, messageId).catch((error: unknown) => {
        this.logger.debug(`switchboard: board not pinned in ${key}: ${describe(error)}`)
      })
    })
  }

  private async closeBoard(key: string): Promise<void> {
    const t = this.t
    const board = this.store.get(key).board
    if (board === undefined) return this.reply(key, t.boardNone)
    await this.store.setBoard(key, undefined)
    this.boardShown.delete(key)
    await this.enqueue(key, async (channel, chat) => { await channel.retire(chat, board.messageId, t.boardClosed) })
  }

  /** Repaint boards soon, no more often than {@link BOARD_INTERVAL_MS}. */
  private markBoards(): void {
    if (this.boardTimer !== undefined || this.store.boardChats().length === 0) return
    const wait = Math.max(0, this.boardPaintedAt + BOARD_INTERVAL_MS - Date.now())
    this.boardTimer = setTimeout(() => {
      this.boardTimer = undefined
      this.refreshBoards().catch((error: unknown) => {
        this.logger.warn(`switchboard: board update failed: ${describe(error)}`)
      })
    }, wait)
  }

  /** Bring every board up to date; one that did not change is left alone. */
  async refreshBoards(): Promise<void> {
    const chats = this.store.boardChats().filter(key => this.channelOf(key) !== undefined)
    if (chats.length === 0) return
    this.boardPaintedAt = Date.now()
    const sessions = await this.harness.listSessions()
    for (const key of chats) {
      const board = this.store.get(key).board
      if (board !== undefined) await this.paintBoard(key, board, sessions)
    }
  }

  private async paintBoard(key: string, board: BoardState, sessions: readonly SessionRow[]): Promise<void> {
    const message = boardMessage(this.t, this.boardRows(key, sessions, board.dirs))
    const shown = JSON.stringify(message)
    if (this.boardShown.get(key) === shown) return
    this.boardShown.set(key, shown)
    await this.enqueue(key, async (channel, chat) => {
      if (this.store.get(key).board?.messageId === board.messageId) await channel.edit(chat, board.messageId, message)
    }, (error) => {
      // Someone deleted it: there is nothing left to keep up to date.
      if (!/message to edit not found|message_id_invalid/iu.test(describe(error))) return
      this.boardShown.delete(key)
      void this.store.setBoard(key, undefined)
    })
  }

  private async handleBoard(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    await line.channel.ack(action)
    if (action.chat === undefined) return
    const key = chatKey(line.line.id, action.chat.id)
    try {
      if (action.data === 'bd:x') return await this.closeBoard(key)
      if (action.data === 'bd:r') {
        const board = this.store.get(key).board
        if (board !== undefined) await this.paintBoard(key, board, await this.harness.listSessions())
        return
      }
      if (action.data.startsWith('bd:s:')) await this.runCommand(key, 'use', action.data.slice('bd:s:'.length), actor)
    } catch (error: unknown) {
      await this.reply(key, this.t.failed(describe(error)))
    }
  }

  // ─── away mode ──────────────────────────────────────────────────────────

  /** Those of some chats whose people are away now. */
  private awayAmong(chats: readonly string[], now: number = Date.now()): string[] {
    return chats.filter((key) => {
      const away = this.store.get(key).away
      return away !== undefined && away.until > now
    })
  }

  private async awayCommand(key: string, args: string, actor: Actor): Promise<void> {
    const t = this.t
    // Guests cannot answer approvals, so nothing should wait on them.
    if (actor.role === 'guest') return this.reply(key, t.adminOnly)
    const away = this.store.get(key).away
    const word = args.trim().toLowerCase()
    if (word === '') {
      const buttons: Button[][] = away !== undefined
        ? [[{ text: t.awayOffButton, data: 'aw:off' }]]
        : [AWAY_CHOICES.map(hours => ({ text: t.awayHours(hours), data: `aw:${hours}h` }))]
      await this.enqueue(key, async (channel, chat) => {
        await channel.send(chat, { text: away !== undefined ? t.awayStatus(clock(away.until)) : t.awayPick, buttons })
      })
      return
    }
    if (word === 'off') return away === undefined ? this.reply(key, t.awayNotOn) : this.endAway(key, false)
    const span = parseDuration(word)
    if (span === undefined) return this.reply(key, t.awayUsage)
    const now = Date.now()
    await this.store.setAway(key, { since: away?.since ?? now, until: now + span })
    return this.reply(key, t.awayStarted(clock(now + span)))
  }

  private async handleAway(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    await line.channel.ack(action)
    if (action.chat === undefined) return
    const key = chatKey(line.line.id, action.chat.id)
    try {
      await this.awayCommand(key, action.data.slice('aw:'.length), actor)
    } catch (error: unknown) {
      await this.reply(key, this.t.failed(describe(error)))
    }
  }

  /** End away modes whose time is up. */
  checkAway(now: number = Date.now()): void {
    for (const key of this.store.awayChats()) {
      const away = this.store.get(key).away
      if (away === undefined || away.until > now) continue
      this.endAway(key, true).catch((error: unknown) => {
        this.logger.warn(`switchboard: away report for ${key} failed: ${describe(error)}`)
      })
    }
  }

  /** Leave away mode: waits go back to normal, and the chat hears what it missed. */
  private async endAway(key: string, expired: boolean): Promise<void> {
    const t = this.t
    const binding = this.store.get(key)
    await this.store.setAway(key, undefined)
    for (const deadline of [...this.deadlines]) if (this.awayAmong(deadline.chats).length === 0) deadline.relax()
    const items = await this.store.takeAwayItems(key)
    const sessions = [...new Set([...binding.sessionId === undefined ? [] : [binding.sessionId], ...binding.watch ?? []])]
    const report = await this.roundup(items, sessions)
    await this.durable(key, { kind: 'text', text: `${expired ? t.awayExpired : t.awayEnded}\n\n${report ?? t.awayQuiet}` })
  }

  // ─── scheduled tasks ────────────────────────────────────────────────────

  private async scheduleCommand(key: string, args: string, actor: Actor): Promise<void> {
    const t = this.t
    const port = this.harness.schedules?.()
    if (port === undefined) return this.reply(key, t.scheduleUnavailable)
    const [verb = ''] = args.trim().split(/\s+/u)
    if (verb === '') return this.listSchedules(key, port)
    if (verb.toLowerCase() !== 'add') return this.reply(key, t.scheduleUsage)
    const task = parseScheduleAdd(args.trim().slice(verb.length), Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (task === undefined) return this.reply(key, t.scheduleUsage)
    const cwd = this.workspaceFor(key, actor)
    if (cwd === undefined) return this.reply(key, t.noWorkspace)
    const agentPreset = this.settings().agentPreset
    const created = await port.create(task, { cwd, ...(agentPreset === '' ? {} : { agentPreset }) })
    await this.store.setSchedulePush(created.id, key, true)
    return this.reply(key, t.scheduleCreated(created.title, clock(Date.parse(created.scheduledAt)), cwd))
  }

  private async listSchedules(key: string, port: SchedulePort): Promise<void> {
    const t = this.t
    const tasks = (await port.list()).filter(task => task.status !== 'ended').slice(0, SCHEDULE_LIST_LIMIT)
    if (tasks.length === 0) return this.reply(key, t.scheduleNone)
    const lines = tasks.map((task, index) => t.scheduleLine(
      index + 1, truncate(task.title, 40), clock(Date.parse(task.scheduledAt)), task.status === 'paused', this.store.schedulePush(task.id).includes(key),
    ))
    const buttons = tasks.flatMap((task, index) => {
      const data = `sc:v:${task.id}`
      return Buffer.byteLength(data) > BUTTON_DATA_BYTES ? [] : [[{ text: `${index + 1}. ${truncate(task.title, 30)}`, data }]]
    })
    await this.enqueue(key, async (channel, chat) => { await channel.send(chat, { text: t.scheduleList(lines), buttons }) })
  }

  /** A task's detail and the buttons that act on it. */
  private scheduleView(key: string, task: ScheduleTask): OutMessage {
    const t = this.t
    const paused = task.status === 'paused'
    const pushed = this.store.schedulePush(task.id).includes(key)
    return {
      text: t.scheduleDetail({
        title: task.title,
        prompt: truncate(task.prompt, SCHEDULE_PROMPT_LENGTH),
        next: task.status === 'active' ? clock(Date.parse(task.scheduledAt)) : '—',
        status: task.status === 'active' ? t.scheduleActive : paused ? t.schedulePaused : t.scheduleEnded,
        pushed,
      }),
      buttons: [
        [{ text: t.scheduleRun, data: `sc:r:${task.id}` }, { text: paused ? t.scheduleResume : t.schedulePause, data: `sc:${paused ? 'u' : 'p'}:${task.id}` }],
        [{ text: pushed ? t.schedulePushOff : t.schedulePushOn, data: `sc:n:${task.id}` }, { text: t.scheduleDelete, data: `sc:d:${task.id}` }],
      ],
    }
  }

  private async handleSchedule(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    const t = this.t
    const { channel } = line
    const port = this.harness.schedules?.()
    if (actor.role !== 'admin' || port === undefined || action.chat === undefined) {
      await channel.ack(action, port === undefined ? t.scheduleUnavailable : t.adminOnly)
      return
    }
    const key = chatKey(line.line.id, action.chat.id)
    const chat = action.chat.id
    const verb = action.data.slice(3, 4)
    const id = action.data.slice(5)
    const show = async (message: OutMessage): Promise<void> => {
      if (action.messageId === undefined || verb === 'v') await channel.send(chat, message)
      else await channel.edit(chat, action.messageId, message)
    }
    try {
      const task = (await port.list()).find(item => item.id === id)
      if (task === undefined) {
        await channel.ack(action, t.scheduleGone)
        return
      }
      if (verb === 'r') {
        const result = await port.run(id)
        await channel.ack(action, result === 'started' ? t.scheduleStarted : result === 'busy' ? t.scheduleBusy : t.scheduleGone)
        return
      }
      await channel.ack(action)
      if (verb === 'd') {
        await show({
          text: this.scheduleView(key, task).text,
          buttons: [[{ text: t.scheduleDeleteConfirm, data: `sc:D:${id}` }, { text: t.scheduleBack, data: `sc:b:${id}` }]],
        })
      } else if (verb === 'D') {
        await port.remove(id)
        await this.store.dropSchedulePush(id)
        await show({ text: t.scheduleDeleted(task.title) })
      } else if (verb === 'p' || verb === 'u') {
        await show(this.scheduleView(key, await port.setActive(id, verb === 'u') ?? task))
      } else {
        if (verb === 'n') await this.store.setSchedulePush(id, key, !this.store.schedulePush(id).includes(key))
        await show(this.scheduleView(key, task))
      }
    } catch (error: unknown) {
      await this.reply(key, t.failed(describe(error)))
    }
  }

  // ─── taking over a Session from the Web UI ──────────────────────────────

  /**
   * A short-lived code that binds whichever chat sends it to a Session.
   * @returns the code, and per connected line the link a QR code can carry.
   */
  createClaim(sessionId: string, now: number = Date.now()): { code: string; expiresAt: number; lines: { id: string; name: string; type: LineSettings['type']; url?: string }[] } {
    for (const [code, claim] of this.claims) if (claim.expiresAt <= now) this.claims.delete(code)
    const code = Array.from({ length: CLAIM_LENGTH }, () => CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)]).join('')
    const expiresAt = now + CLAIM_TTL_MS
    this.claims.set(code, { sessionId, expiresAt })
    const lines = [...this.live.values()].flatMap((entry) => {
      if (entry.state.kind !== 'running') return []
      const { line } = entry
      const url = line.type === 'telegram' ? `https://t.me/${entry.state.username}?start=link_${code}`
        : line.appId === undefined ? undefined
          : `https://applink.${line.domain === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/bot/open?appId=${encodeURIComponent(line.appId)}`
      return [{ id: line.id, name: line.name, type: line.type, ...(url === undefined ? {} : { url }) }]
    })
    return { code, expiresAt, lines }
  }

  /** Bind a chat to the Session a pairing code stands for; each code works once. */
  private async claimSession(key: string, text: string, actor: Actor): Promise<void> {
    const t = this.t
    const code = text.trim().toUpperCase()
    const claim = this.claims.get(code)
    if (claim === undefined || claim.expiresAt <= Date.now()) return this.reply(key, t.linkInvalid)
    if (!(await this.mayUseSession(actor, claim.sessionId))) return this.reply(key, t.dirDenied(actor.dirs ?? []))
    this.claims.delete(code)
    await this.linkChat(key, claim.sessionId, 'active')
  }

  // ─── the Agent reaching out ─────────────────────────────────────────────

  /** Whether a chat would hear from a Session. */
  reachesPhone(sessionId: string): boolean {
    return this.outputChats(sessionId).length > 0 || this.store.watchersOf(sessionId).length > 0
  }

  /**
   * Send the chats linked to a Session a message from its Agent, mid-turn.
   * @returns how many chats it went to, or why it did not go out.
   */
  notifyFromAgent(sessionId: string, text: string, now: number = Date.now()): { delivered: number; reason?: 'no-chat' | 'too-soon' } {
    const chats = [...new Set([...this.outputChats(sessionId), ...this.store.watchersOf(sessionId)])]
    if (chats.length === 0) return { delivered: 0, reason: 'no-chat' }
    const last = this.agentNotices.get(sessionId)
    if (last !== undefined && now - last < AGENT_NOTICE_INTERVAL_MS) return { delivered: 0, reason: 'too-soon' }
    this.agentNotices.delete(sessionId)
    this.agentNotices.set(sessionId, now)
    while (this.agentNotices.size > TODO_SESSIONS) this.agentNotices.delete(this.agentNotices.keys().next().value as string)
    const message = this.t.agentNotice(truncate(text.trim(), AGENT_NOTICE_LENGTH))
    for (const key of chats) void this.durable(key, { kind: 'text', text: message }, sessionId)
    return { delivered: chats.length }
  }

  /** Whether a post from another plugin would reach a chat: the bridge is on and schedule chats are set. */
  canPushToPhone(): boolean {
    const s = this.settings()
    return s.enabled && s.scheduleChats.some(id => id.trim() !== '')
  }

  /**
   * Post Markdown from another plugin to the schedule chats, the chats that
   * get scheduled runs' results. It goes out like a reply: rendered, as a file
   * when long, and queued in the outbox while a line is down. No Session is
   * involved, so a reply to it starts nothing.
   * @returns how many chats it went to, or why it did not go out.
   */
  pushToPhone(text: string, now: number = Date.now()): { delivered: number; reason?: PhonePushReason } {
    const s = this.settings()
    if (!s.enabled) return { delivered: 0, reason: 'disabled' }
    const body = text.trim()
    if (body === '') return { delivered: 0, reason: 'empty' }
    const chats = [...new Set(s.scheduleChats.map(id => id.trim()).filter(id => id !== ''))]
    if (chats.length === 0) return { delivered: 0, reason: 'no-chat' }
    if (now - this.lastPluginPush < PLUGIN_PUSH_INTERVAL_MS) return { delivered: 0, reason: 'too-soon' }
    this.lastPluginPush = now
    const message = truncate(body, PLUGIN_PUSH_LENGTH)
    for (const key of chats) void this.durable(key, { kind: 'markdown', text: message })
    return { delivered: chats.length }
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
      startedAt, lines: [], count: 0, segment: 0, text: '', compacting: false, messages: new Map(), timer: undefined, delayed: true, ticker: undefined,
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
    const todos = this.todos.get(sessionId)
    const subagents = this.subagents.get(sessionId)?.size ?? 0
    const todoLine = todos?.some(todo => todo.status !== 'completed') === true ? todoSummary(t, todos) : undefined
    const text = [
      t.progress(elapsed, progress.count),
      ...(todoLine === undefined ? [] : [todoLine]),
      ...(progress.compacting ? [t.compacting] : []),
      ...(subagents === 0 ? [] : [t.subagents(subagents)]),
      ...(progress.lines.length > 0 && hidden > 0 ? ['…'] : []),
      ...progress.lines,
      ...(draft === undefined ? [] : ['', draft]),
    ].join('\n')
    const buttons = [[{ text: t.stopButton, data: `st:${progress.stopId}` }]]
    // Each chat's send queue is serial, so an edit runs after the send that created its message.
    const sends = this.outputChats(sessionId).map(key => this.enqueue(key, async (channel, chat) => {
      const messageId = progress.messages.get(key)
      if (messageId === undefined) {
        const sent = await channel.send(chat, { text, buttons, editable: true })
        progress.messages.set(key, sent)
        this.noteRoute(key, sent, sessionId)
      }
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
      const rows = [[
        { text: t.actContinue, data: `ab:${id}:c` },
        ...(retry === undefined ? [] : [{ text: t.actRetry, data: `ab:${id}:r` }]),
        ...(files.length > 0 ? [{ text: t.actChanges, data: `ab:${id}:d` }] : []),
      ], [
        { text: t.actFork, data: `ab:${id}:f` },
        { text: t.actNew, data: `ab:${id}:n` },
      ]]
      const previous = this.buttoned.get(key)
      this.buttoned.set(key, sent)
      void this.enqueue(key, async (channel, chat) => {
        if (previous !== undefined && previous.messageId !== sent.messageId) await channel.addButtons(chat, previous, []).catch(() => {})
        await channel.addButtons(chat, sent, rows)
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
    const t = this.t
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.callId)
    const detail = call === undefined ? '' : approvalDetail(call.name, call.arguments)
    // A different reason is a different risk, so it asks again.
    const grantKey = `${request.toolName}|${request.reason ?? ''}`
    const granted = this.turnGrants.get(request.sessionId)?.get(grantKey)
    if (granted !== undefined) {
      for (const key of chats) {
        this.log({ chatId: key }, {
          dir: 'out', kind: 'approval',
          approval: { tool: request.toolName, ...(detail === '' ? {} : { detail }), outcome: 'allowed-once', by: t.grantedBy(granted) },
        }, request.sessionId)
      }
      return 'allowed-once'
    }
    // The question should follow the reply that led to it.
    this.flushProgress(request.sessionId)
    const id = randomUUID().slice(0, 12)
    const text = t.approvalAsk(request.toolName, detail, request.reason)
    const buttons: Button[][] = [[
      { text: t.allow, data: `ap:${id}:y` },
      { text: t.reject, data: `ap:${id}:n` },
    ]]
    const grantable = TURN_GRANT_TOOLS.has(request.toolName) && this.turns.has(request.sessionId)
    if (grantable) buttons.push([{ text: t.allowTurn, data: `ap:${id}:a` }])

    const answer = Promise.withResolvers<TelegramApprovalOutcome>()
    const pending: PendingApproval = {
      sessionId: request.sessionId,
      toolName: request.toolName,
      grantKey,
      prompts: [],
      text,
      extend: () => { deadline.extend() },
      settle: (outcome, note, by) => {
        if (!this.approvals.delete(id)) return
        this.markBoards()
        deadline.clear()
        this.closeReminders(deadline, note)
        request.signal?.removeEventListener('abort', onAbort)
        for (const prompt of pending.prompts) {
          void this.channelOf(prompt.chat)?.edit(splitChatKey(prompt.chat).chat, prompt.messageId, { text: `${pending.text}\n\n${note}` }).catch(() => {})
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
    const deadline = this.startDeadline(s.approvalTimeoutSec, chats, request.sessionId, () => { pending.settle('timeout', t.approvalTimedOut) }, (left, away) => ({
      text: away ? t.approvalReminderAway(request.toolName) : t.approvalReminder(request.toolName, left),
      buttons: [...buttons, [{ text: t.waitMore(this.waitLabel(s.approvalTimeoutSec)), data: `ap:${id}:w` }]],
    }))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.approvals.set(id, pending)
    this.markBoards()

    // Through each chat's queue, so the question follows the messages that led to it.
    await Promise.all(chats.map(key => this.enqueue(key, async (channel, chat) => {
      const messageId = await channel.send(chat, { text, buttons })
      pending.prompts.push({ chat: key, messageId })
      this.noteRoute(key, messageId, request.sessionId)
    })))
    if (pending.prompts.length === 0) pending.settle('delegate', '')
    else if (call !== undefined) this.explainApproval(id, pending, call, buttons)
    return answer.promise
  }

  /**
   * Add the model's reading of a command to its approval once it arrives. The
   * question has already gone out, so a slow or failed call costs nothing.
   */
  private explainApproval(id: string, pending: PendingApproval, call: { name: string; arguments: string }, buttons: readonly (readonly Button[])[]): void {
    const s = this.settings()
    // File changes come with their diff, which says more than a sentence could.
    if (s.approvalRiskHint !== true || this.harness.explainRisk === undefined || TURN_GRANT_TOOLS.has(call.name)) return
    const signal = AbortSignal.any([AbortSignal.timeout(RISK_TIMEOUT_MS), this.lifetime.signal])
    this.harness.explainRisk(pending.sessionId, call.name, call.arguments, s.language, signal).then((hint) => {
      if (hint === undefined || this.approvals.get(id) !== pending) return
      const text = `${pending.text}\n\n${this.t.riskHint(hint)}`
      if (text.length > RISK_TEXT_LIMIT) return
      pending.text = text
      for (const prompt of pending.prompts) {
        void this.enqueue(prompt.chat, async (channel, chat) => {
          if (this.approvals.get(id) === pending) await channel.edit(chat, prompt.messageId, { text, buttons })
        })
      }
    }).catch((error: unknown) => {
      this.logger.debug(`switchboard: no reading of ${call.name}: ${describe(error)}`)
    })
  }

  /** The wait a reminder's button buys, as the chat reads it. */
  private waitLabel(seconds: number): string {
    return duration(seconds, this.settings().language)
  }

  /**
   * Time a chat's answer, reminding the chats shortly before the end.
   * @param seconds - how long to wait, and how long each extension adds.
   * @param onExpire - called when nobody answered in time.
   * @param reminder - the reminder, given the time left as text and whether a chat is away.
   */
  private startDeadline(seconds: number, chats: readonly string[], sessionId: string, onExpire: () => void, reminder: (left: string, away: boolean) => OutMessage): Deadline {
    const base = seconds * 1000
    let wait = base
    let expiry: ReturnType<typeof setTimeout>
    let nudge: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const lead = Math.min(REMINDER_LEAD_MS, wait / 4)
      this.deadlines.add(deadline)
      expiry = setTimeout(() => {
        if (this.awayAmong(chats).length === 0) return onExpire()
        // Nobody is at the Web UI to take this over, so it keeps waiting, reminding less and less often.
        deadline.clear()
        this.closeReminders(deadline, this.t.awayStillWaiting)
        wait = Math.max(base, Math.min(wait * 2, AWAY_WAIT_MAX_MS))
        arm()
      }, wait)
      nudge = setTimeout(() => {
        const message = reminder(duration(lead / 1000, this.settings().language), this.awayAmong(chats).length > 0)
        for (const key of chats) {
          void this.enqueue(key, async (channel, chat) => {
            const messageId = await channel.send(chat, message)
            deadline.reminders.push({ chat: key, messageId })
            this.noteRoute(key, messageId, sessionId)
          })
          this.log({ chatId: key }, { dir: 'out', kind: 'notice', text: message.text }, sessionId)
        }
      }, wait - lead)
    }
    const deadline: Deadline = {
      reminders: [],
      chats,
      clear: () => {
        clearTimeout(expiry)
        clearTimeout(nudge)
        this.deadlines.delete(deadline)
      },
      extend: () => {
        deadline.clear()
        wait = base
        this.closeReminders(deadline, this.t.waitExtended(this.waitLabel(seconds)))
        arm()
      },
      relax: () => {
        if (wait === base) return
        deadline.clear()
        wait = base
        arm()
      },
    }
    arm()
    return deadline
  }

  /** Replace sent reminders, and their buttons, with what became of the wait. */
  private closeReminders(deadline: Deadline, note: string): void {
    for (const reminder of deadline.reminders.splice(0)) {
      if (note === '') continue
      void this.channelOf(reminder.chat)?.edit(splitChatKey(reminder.chat).chat, reminder.messageId, { text: note }).catch(() => {})
    }
  }

  /** Tell the chats that an approval nobody answered left its tool call undone. */
  noteUnanswered(sessionId: string, toolName: string): void {
    const chats = this.reachable([...new Set([...this.outputChats(sessionId), ...this.store.watchersOf(sessionId)])])
    for (const key of chats) void this.durable(key, { kind: 'text', text: this.t.approvalUnanswered(toolName) }, sessionId)
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
      extend: () => { deadline.extend() },
      settle: (outcome, note) => {
        if (!this.questions.delete(id)) return
        this.markBoards()
        deadline.clear()
        this.closeReminders(deadline, note ?? t.questionClosed)
        request.signal?.removeEventListener('abort', onAbort)
        for (const entry of pending.items) {
          const picked = [...entry.selected].map(label => optionText(t, entry.item, label))
          const summary = note ?? (entry.custom !== undefined
            ? t.questionAnswered([...picked, entry.custom].join(', '))
            : picked.length > 0 ? t.questionAnswered(picked.join(', ')) : t.questionSkipped)
          for (const [key, messageId] of entry.messages) {
            void this.channelOf(key)?.edit(splitChatKey(key).chat, messageId, { text: `${questionText(t, entry.item)}\n\n${summary}` }).catch(() => {})
          }
        }
        answer.resolve(outcome)
      },
    }
    const onAbort = (): void => { pending.settle('cancelled', t.questionWithdrawn) }
    const deadline = this.startDeadline(s.approvalTimeoutSec, chats, request.sessionId, () => { pending.settle('delegate', t.questionTimedOut) }, (left, away) => ({
      text: away ? t.questionReminderAway : t.questionReminder(left),
      buttons: [[{ text: t.waitMore(this.waitLabel(s.approvalTimeoutSec)), data: `qw:${id}` }]],
    }))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.questions.set(id, pending)
    this.markBoards()
    for (const [index, entry] of pending.items.entries()) {
      const text = questionText(t, entry.item)
      for (const key of chats) {
        // The long part goes first as Markdown, in pieces or as a file; the buttons stay on one short message.
        if (detachedDetail(entry.item) && entry.item.detail !== undefined) await this.durable(key, { kind: 'markdown', text: entry.item.detail }, request.sessionId)
        await this.enqueue(key, async (channel, chat) => {
          const messageId = await channel.send(chat, { text, buttons: questionButtons(t, id, index, entry) })
          entry.messages.set(key, messageId)
          this.noteRoute(key, messageId, request.sessionId)
        })
        this.log({ chatId: key }, { dir: 'out', kind: 'notice', text }, request.sessionId)
      }
    }
    if (pending.items.every(entry => entry.messages.size === 0)) pending.settle('delegate', '')
    return answer.promise
  }

  /**
   * Take free text in a chat as the answer to its oldest unanswered question.
   * @param target - the Session the text replies to, when it is not the chat's own; only its questions count.
   */
  private answerByText(key: string, text: string, target?: string): boolean {
    for (const pending of this.questions.values()) {
      if (!pending.chats.includes(key) || (target !== undefined && pending.sessionId !== target)) continue
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

  private async handleQuestionPress(channel: Channel, action: InboundAction, actor: Actor): Promise<void> {
    const [, id = '', index = '', choice = ''] = action.data.split(':')
    const pending = this.questions.get(id)
    const entry = pending?.items[Number(index)]
    if (pending === undefined || entry === undefined || entry.done) {
      await channel.ack(action, this.t.approvalGone)
      return
    }
    // Approving a plan lets the Agent start changing things, so it takes what an approval takes.
    if (entry.item.intent?.kind === 'plan-review' && actor.role === 'guest') {
      await channel.ack(action, this.t.approvalNotYours)
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
    const actor = this.actorOf(this.settingsOf(line), action.from, action.chat)
    if (action.data.startsWith('bd:')) return this.handleBoard(line, action, actor)
    if (action.data.startsWith('aw:')) return this.handleAway(line, action, actor)
    if (action.data.startsWith('sc:')) return this.handleSchedule(line, action, actor)
    if (action.data.startsWith('pk:')) return this.handlePick(line, action, actor)
    if (action.data.startsWith('st:')) return this.handleStop(line, action)
    if (action.data.startsWith('cc:')) return this.handleCommandCancel(line, action, actor)
    if (action.data.startsWith('qs:') || action.data.startsWith('qx:')) return this.handleQueued(line, action)
    if (action.data.startsWith('ab:')) return this.handleReplyAction(line, action, actor)
    if (action.data.startsWith('mn:')) return this.handleMenu(line, action, actor)
    if (action.data.startsWith('qa:')) return this.handleQuestionPress(channel, action, actor)
    if (action.data.startsWith('qw:')) {
      const waiting = this.questions.get(action.data.slice(3))
      waiting?.extend()
      await channel.ack(action, waiting === undefined ? t.approvalGone : undefined)
      return
    }
    const match = /^ap:([\w-]+):([ynwa])$/u.exec(action.data)
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
    if (match[2] === 'w') {
      pending.extend()
      await channel.ack(action)
      return
    }
    // Skipping later approvals is a bigger decision than answering this one.
    if (match[2] === 'a' && actor.role !== 'admin') {
      await channel.ack(action, t.adminOnly)
      return
    }
    const who = action.from.username === undefined ? action.from.name : `@${action.from.username}`
    if (match[2] === 'a') {
      const grants = this.turnGrants.get(pending.sessionId) ?? new Map<string, string>()
      grants.set(pending.grantKey, who)
      this.turnGrants.set(pending.sessionId, grants)
      pending.settle('allowed-once', t.approvalAllowedTurn(who, pending.toolName), who)
    } else if (match[2] === 'y') pending.settle('allowed-once', t.approvalAllowed(who), who)
    else {
      // A follower's next message goes to its own Session, so only the chat bound to this one can explain.
      const key = action.chat === undefined ? undefined : chatKey(line.line.id, action.chat.id)
      const bound = key !== undefined && this.store.get(key).sessionId === pending.sessionId
      if (bound) this.rejections.set(key, { userId: action.from.id, tool: pending.toolName, at: Date.now() })
      pending.settle('rejected', bound ? `${t.approvalRejected(who)}\n${t.rejectReasonHint}` : t.approvalRejected(who), who)
    }
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

  private async handleCommandCancel(line: LiveLine, action: InboundAction, actor: Actor): Promise<void> {
    const run = this.commandRuns.get(action.data.slice(3))
    if (run === undefined) {
      await line.channel.ack(action, this.t.notRunning)
      return
    }
    if (!mayRunCommand(actor, run.name)) {
      await line.channel.ack(action, this.t.adminOnly)
      return
    }
    this.cancelCommand(run)
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
    if (!['new', 'sessions', 'model', 'mode', 'stop', 'compact', 'status', 'help', 'board', 'away', 'schedule'].includes(command)) return
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
      else if (verb === 'f') await this.forkSession(key, actions.sessionId, actor)
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
/** The parts of a `goal/change` event the chats use; a cleared goal has no `goal`. */
interface GoalChange {
  readonly operation: string
  readonly goal?: GoalState
  readonly roundsStarted?: number
}

/** A todo list as one line: how far it got and what runs now; undefined for no list. */
function todoSummary(t: Messages, todos: readonly TodoItem[] | undefined): string | undefined {
  if (todos === undefined || todos.length === 0) return undefined
  const done = todos.filter(todo => todo.status === 'completed').length
  const current = todos.find(todo => todo.status === 'in_progress')?.content
  return t.todoLine(done, todos.length, current === undefined ? undefined : truncate(current, 60))
}

/** A token count as people read it: `840`, `84k`. */
function tokenSize(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`
}

/** Context use as `42% (84k / 200k)`, or the bare size when the window is unknown. */
function contextLabel(usage: { used: number; window?: number }): string {
  if (usage.window === undefined || usage.window <= 0) return tokenSize(usage.used)
  return `${Math.round(usage.used / usage.window * 100)}% (${tokenSize(usage.used)} / ${tokenSize(usage.window)})`
}

/** Add one model call's tokens to its turn. The provider's buckets do not overlap. */
function addUsage(turn: TurnState, data: unknown): void {
  const usage = (data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | undefined)?.usage
  if (usage === undefined) return
  const sum = turn.usage ?? { input: 0, cached: 0, output: 0 }
  turn.usage = {
    input: sum.input + (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    cached: sum.cached + (usage.cacheReadTokens ?? 0),
    output: sum.output + (usage.outputTokens ?? 0),
  }
}

/** A turn's tokens as text; undefined when no call reported any. */
function turnTokens(t: Messages, turn: TurnState): string | undefined {
  const usage = turn.usage
  return usage === undefined ? undefined : t.turnTokens(tokenSize(usage.input), tokenSize(usage.cached), tokenSize(usage.output))
}

function lineKey(line: LineSettings): string {
  return JSON.stringify([line.type, line.secret, line.apiBaseUrl, line.pollTimeoutSec, line.appId, line.domain])
}

/** The text of one question message. */
function questionText(t: Messages, item: QuestionItem): string {
  if (item.intent?.kind === 'plan-review') return t.planReview
  return t.question(item.header, item.question, detachedDetail(item) ? undefined : item.detail, item.multiSelect === true)
}

/** Whether a question's detail goes as its own message before the question. */
function detachedDetail(item: QuestionItem): boolean {
  return item.intent?.kind === 'plan-review' || (item.detail?.length ?? 0) > QUESTION_DETAIL_LIMIT
}

/** An option as the chat reads it; the answer keeps the label the asker gave. */
function optionText(t: Messages, item: QuestionItem, label: string): string {
  if (item.intent?.kind !== 'plan-review') return label
  return label === item.intent.approve ? t.planApprove : t.planKeep
}


/** Option buttons, ticked for a multi-select question, plus Done/Skip. */
function questionButtons(t: Messages, id: string, index: number, entry: { item: QuestionItem; selected: Set<string> }): Button[][] {
  const rows: Button[][] = (entry.item.options ?? []).slice(0, PICKER_BUTTONS).map((option, optionIndex) => [{
    text: `${entry.item.multiSelect === true && entry.selected.has(option.label) ? '☑ ' : entry.item.multiSelect === true ? '☐ ' : ''}${optionText(t, entry.item, option.label)}`.slice(0, 60),
    data: `qa:${id}:${index}:${optionIndex}`,
  }])
  // A plan is approved or sent back; skipping it would mean nothing.
  if (entry.item.intent?.kind === 'plan-review') return rows
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

/** A prompt with the group's speaker named at its start; other prompts stay as they are. */
function spoken(parts: readonly PromptPart[], actor: Actor): readonly PromptPart[] {
  if (actor.speaker === undefined) return parts
  const [first, ...rest] = parts
  if (first?.type === 'text') return [{ type: 'text', text: `${actor.speaker}\n${first.text}` }, ...rest]
  return [{ type: 'text', text: actor.speaker }, ...parts]
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
