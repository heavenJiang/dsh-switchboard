/**
 * Switchboard (掌上指挥台) for DeepSeek Harness, host half.
 *
 * Bots on chat platforms — Telegram, Feishu — become other clients of the Web
 * host, one line per bot account: messages prompt a Session through
 * `ctx.sessionController` (the same path the Web UI uses, so chat Sessions
 * appear in the Web sidebar and vice versa), assistant output is mirrored
 * back to the bound chat as rendered Markdown, and tool approvals can be
 * answered with buttons. Photos and files are staged
 * through `ctx.fileUploads` — the Web composer's attachment path — voice notes
 * are transcribed by `ctx.speechToText` when it is composed, and files the
 * Agent presents are sent back. Every user-facing setting is a volatile Config
 * field, edited on the Plugins page by the browser half in `src/client` and
 * applied without restarting the plugin.
 *
 * Optional services (`connection`, `commands`, `systemPrompt`, `credentials`,
 * `speechToText`, `workspaceChanges`) are picked up while they exist; the
 * bridge runs without any of them.
 *
 * @module dsh-switchboard
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: merges the `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
// Type-only service merges for the optional integrations below.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
// Side-effect type import: declaration-merges the question waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { BindingStore, defaultStateFile, migrateLegacyStateDir } from './bindings.ts'
import {
  Switchboard, type BridgeSettings, type HarnessPort, type ModelChoice, type SessionRow, type TurnSummaryMode,
} from './bridge.ts'
import { ChatLog } from './chatlog.ts'
import { Outbox } from './outbox.ts'
import { RegistrationDesk } from './channels/feishu-register.ts'
import { registerWebCommand } from './command.ts'
import { LEGACY_LINE, LINE_ID, type ChannelType, type LineSettings } from './lines.ts'
import type { PersonSettings } from './people.ts'
import type { BotLanguage } from './messages.ts'
import { registerHistoryRoutes } from './routes.ts'
import { UpdateChecker } from './updates.ts'

export { Switchboard } from './bridge.ts'
export type { BridgeSettings, HarnessPort } from './bridge.ts'

export const name = 'switchboard'
/** The Web host's Session controller drives Sessions exactly as the Web UI does. */
export const inject = ['agents', 'sessionController', 'permissionPresets', 'fileUploads', 'llm']

/** Model-facing note for Sessions mirrored to a chat, unless the plugin page replaces it. */
const CHANNEL_PROMPT = [
  'This conversation is mirrored to the user\'s chat app (such as Telegram or Feishu), usually read on a phone.',
  'Keep replies concise: short paragraphs and lists, no wide tables, at most a few lines of code inline.',
  'Hand over long output, logs, or code as files with the present tool instead of pasting them.',
  'Messages from the user may arrive as photos, files, or voice-note transcripts.',
].join(' ')

/** One line as configured: a bot account on one platform and who may use it. */
export interface LineConfig {
  /** Stable key; chat keys of the line start with it. */
  id: string
  type: ChannelType
  /** Display name on the Web pages; the platform's name when empty. */
  name: string
  enabled: boolean
  /** Credential reference holding the Telegram bot token or the Feishu app secret. */
  secretRef: string
  /** User ids allowed to drive the Harness: Telegram ids or `@username`; Feishu open_id, user_id, or union_id. */
  allowedUsers: readonly string[]
  /** Chat ids whose every member may drive the Harness. */
  allowedChats: readonly string[]
  /** In groups, answer only commands, @mentions, and replies to the bot. */
  groupMentionOnly: boolean
  /** Working directory for this line's new Sessions; empty uses the plugin-wide one. */
  workspacePath: string
  /** Telegram: Bot API root. */
  apiBaseUrl: string
  /** Feishu: app id (`cli_…`). */
  appId: string
  /** Feishu: `feishu` (open.feishu.cn) or `lark` (open.larksuite.com). */
  domain: 'feishu' | 'lark'
}

const LineConfig: Schema<LineConfig> = Schema.object({
  id: Schema.string().pattern(LINE_ID).required(),
  type: Schema.union(['telegram', 'feishu'] as const).default('telegram'),
  name: Schema.string().default(''),
  enabled: Schema.boolean().default(true),
  secretRef: Schema.string().role('credential-ref').default(''),
  allowedUsers: Schema.array(Schema.string()).default([]),
  allowedChats: Schema.array(Schema.string()).default([]),
  groupMentionOnly: Schema.boolean().default(true),
  workspacePath: Schema.string().default(''),
  apiBaseUrl: Schema.string().default('https://api.telegram.org'),
  appId: Schema.string().default(''),
  domain: Schema.union(['feishu', 'lark'] as const).default('feishu'),
}) as unknown as Schema<LineConfig>

/** Plugin configuration. Volatile fields are live-editable from the Plugins page. */
export interface Config {
  /** Run the bots. Turning it off stops every line without unloading the plugin. */
  enabled: Volatile<boolean>
  /**
   * Lines to run. When empty, the Telegram fields below (from releases before
   * lines) make up one Telegram line with id `telegram`; the plugin page
   * moves them here on its next save.
   */
  lines: Volatile<LineConfig[]>
  /** Literal bot token (legacy); prefer {@link botTokenRef}, which keeps the token out of the profile file. */
  botToken: Volatile<string | undefined>
  /** Credential reference holding the bot token (the credentials store, or an environment variable of that name). */
  botTokenRef: Volatile<string>
  /** Telegram user ids (or `@username`) allowed to drive the Harness. Empty admits no one. */
  allowedUsers: Volatile<string[]>
  /** Chat ids whose every member may drive the Harness. */
  allowedChats: Volatile<string[]>
  /** In groups, answer only commands, @mentions, and replies to the bot. */
  groupMentionOnly: Volatile<boolean>
  /** Working directory for new Sessions when a chat has not set one with /cwd. */
  workspacePath: Volatile<string>
  /** Agent preset for Sessions the bot creates. */
  agentPreset: Volatile<string>
  /** Permission preset applied to Sessions the bot creates; empty keeps the deployment default. */
  permissionPreset: Volatile<string>
  /** Provider route of the model for Sessions the bot creates; empty follows the Web default model. */
  modelProvider: Volatile<string>
  /** Model id on that route; empty follows the Web default model. */
  model: Volatile<string>
  /** Reasoning effort for that model; empty uses the model's own default. */
  reasoningEffort: Volatile<string>
  /** Tell the model its replies are read in Telegram. */
  channelPrompt: Volatile<boolean>
  /** Replacement for the built-in channel note; empty uses the built-in one. */
  channelPromptText: Volatile<string>
  /** Ask tool approvals in Telegram for Sessions linked to a chat. */
  approvalViaTelegram: Volatile<boolean>
  /** Ask the Agent's questions in Telegram too. */
  questionsViaTelegram: Volatile<boolean>
  /** Seconds to wait for a Telegram answer before handing the approval to the next answerer. */
  approvalTimeoutSec: Volatile<number>
  /** Post tool calls (batched). */
  notifyToolCalls: Volatile<boolean>
  /** Show the reply in a draft message while it is written. */
  streamReplies: Volatile<boolean>
  /** Turn-end summary for bound chats: never, for long turns, or always. */
  turnSummary: Volatile<TurnSummaryMode>
  /** What counts as a long turn, in seconds. */
  turnSummaryMinSec: Volatile<number>
  /** Chat ids that receive scheduled-run results. */
  scheduleChats: Volatile<string[]>
  /** Replies longer than this many characters go as a Markdown file with a short preview; 0 never. */
  longReplyChars: Volatile<number>
  /** Roles, presets, and directories of people; anyone not listed is an admin (a member when admitted by chat). */
  people: Volatile<PersonSettings[]>
  /** Chat keys told when a line stays down; the schedule chats when empty. */
  alertChats: Volatile<string[]>
  /** Minutes a line may be down before the alert chats hear of it; 0 turns alerts off. */
  alertAfterMin: Volatile<number>
  /** Transcribe voice notes when speech recognition is composed. */
  transcribeVoice: Volatile<boolean>
  /** ffmpeg used to turn Telegram's Ogg/Opus voice notes into WAV for recognition. */
  ffmpegPath: Volatile<string>
  /** Language of the bot's own replies. */
  language: Volatile<BotLanguage>
  /** Bot API root; replace for a self-hosted Bot API server or a reverse proxy. */
  apiBaseUrl: Volatile<string>
  /** Largest file accepted from Telegram, in MB. The public Bot API serves at most 20; a self-hosted one up to 2000. */
  maxDownloadMb: Volatile<number>
  /** Send files the Agent presents with the `present` tool back to the chat. */
  sendDeliverables: Volatile<boolean>
  /** Entries kept per chat in the Web history viewer. */
  historyLimit: Volatile<number>
  /** Show the Telegram entry in the Web sidebar. */
  showPanel: Volatile<boolean>
  /** Show the Telegram tab inside every Session. */
  showSessionTab: Volatile<boolean>
  /** Long-poll wait in seconds. */
  pollTimeoutSec: number
  /** Chat-to-Session binding file; defaults to `$DSH_HOME/switchboard/state.json`. */
  stateFile?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  lines: Schema.array(LineConfig).default([]).volatile(),
  botToken: Schema.string().role('secret').volatile(),
  botTokenRef: Schema.string().role('credential-ref').default('TELEGRAM_BOT_TOKEN').volatile(),
  allowedUsers: Schema.array(Schema.string()).default([]).volatile(),
  allowedChats: Schema.array(Schema.string()).default([]).volatile(),
  groupMentionOnly: Schema.boolean().default(true).volatile(),
  workspacePath: Schema.string().default('').volatile(),
  agentPreset: Schema.string().default('standard').volatile(),
  permissionPreset: Schema.string().default('workspace-write').volatile(),
  modelProvider: Schema.string().default('').volatile(),
  model: Schema.string().default('').volatile(),
  reasoningEffort: Schema.string().default('').volatile(),
  channelPrompt: Schema.boolean().default(true).volatile(),
  channelPromptText: Schema.string().default('').volatile(),
  approvalViaTelegram: Schema.boolean().default(true).volatile(),
  questionsViaTelegram: Schema.boolean().default(true).volatile(),
  approvalTimeoutSec: Schema.natural().min(10).max(3600).default(300).volatile(),
  notifyToolCalls: Schema.boolean().default(true).volatile(),
  streamReplies: Schema.boolean().default(true).volatile(),
  turnSummary: Schema.union(['off', 'long', 'always'] as const).default('long').volatile(),
  turnSummaryMinSec: Schema.natural().max(86400).default(60).volatile(),
  scheduleChats: Schema.array(Schema.string()).default([]).volatile(),
  longReplyChars: Schema.natural().max(100000).default(6000).volatile(),
  people: Schema.array(Schema.object({
    line: Schema.string().required(),
    id: Schema.string().required(),
    role: Schema.union(['admin', 'member', 'guest'] as const).default('member'),
    preset: Schema.string(),
    dirs: Schema.array(Schema.string()).default([]),
  })).default([]).volatile(),
  alertChats: Schema.array(Schema.string()).default([]).volatile(),
  alertAfterMin: Schema.natural().max(1440).default(5).volatile(),
  transcribeVoice: Schema.boolean().default(true).volatile(),
  ffmpegPath: Schema.string().default('ffmpeg').volatile(),
  language: Schema.union(['zh', 'en'] as const).default('zh').volatile(),
  apiBaseUrl: Schema.string().pattern(/^https?:\/\/\S+$/u).default('https://api.telegram.org').volatile(),
  maxDownloadMb: Schema.natural().min(1).max(2000).default(20).volatile(),
  sendDeliverables: Schema.boolean().default(true).volatile(),
  historyLimit: Schema.natural().min(100).max(100000).default(2000).volatile(),
  showPanel: Schema.boolean().default(true).volatile(),
  showSessionTab: Schema.boolean().default(true).volatile(),
  pollTimeoutSec: Schema.natural().min(1).max(50).default(30),
  stateFile: Schema.string(),
}) as unknown as Schema<Config>

/**
 * Turn Telegram's Ogg/Opus voice note into 16 kHz mono PCM16 WAV with ffmpeg.
 * @throws when ffmpeg is missing or fails.
 */
function toWav(ffmpeg: string, input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { signal })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'ENOENT' ? `ffmpeg not found (${ffmpeg})` : error.message))
    })
    child.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)))
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 200)}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(input))
  })
}

/**
 * Mount the bridge.
 * @param ctx - plugin context with the Agent registry, Session controller, and permission presets.
 * @param config - validated configuration with live volatile fields.
 */
export function apply(ctx: Context, config: Config): void {
  // Handlers run outside the plugin's injection scope; capture services now.
  const { agents, sessionController, permissionPresets, fileUploads, llm, logger } = ctx

  // Optional services, followed while they exist.
  const optional: {
    credentials?: Context['credentials']
    speech?: Context['speechToText']
    changes?: Context['workspaceChanges']
    workspaces?: Context['workspaceRegistry']
    commands?: Context['commands']
  } = {}
  ctx.inject(['workspaceRegistry'], (scope) => {
    optional.workspaces = scope.workspaceRegistry
    scope.effect(() => () => { delete optional.workspaces }, 'switchboard: workspace registry')
  })
  ctx.inject(['speechToText'], (scope) => {
    optional.speech = scope.speechToText
    scope.effect(() => () => { delete optional.speech }, 'switchboard: speech service')
  })
  ctx.inject(['workspaceChanges'], (scope) => {
    optional.changes = scope.workspaceChanges
    scope.effect(() => () => { delete optional.changes }, 'switchboard: workspace changes')
  })

  ctx.inject(['commands'], (scope) => {
    optional.commands = scope.commands
    scope.effect(() => () => { delete optional.commands }, 'switchboard: command registry')
  })

  /** The Session's live Agent, resumed through the Session controller like any other Host API domain. */
  const resolveAgent = async (sessionId: string) => {
    const live = agents.get(sessionId as SessionId)
    if (live !== undefined) return live
    const resolved = await sessionController.resolveAgent(sessionId as SessionId)
    return 'agent' in resolved ? resolved.agent : undefined
  }

  /** Configured lines; the legacy Telegram fields stand in while none is configured. */
  const configuredLines = (): readonly Readonly<LineConfig>[] => {
    const lines = config.lines.get()
    if (lines.length > 0) return lines
    return [{
      id: LEGACY_LINE, type: 'telegram', name: '', enabled: true,
      secretRef: config.botTokenRef.get(),
      allowedUsers: [...config.allowedUsers.get()],
      allowedChats: [...config.allowedChats.get()],
      groupMentionOnly: config.groupMentionOnly.get(),
      workspacePath: '',
      apiBaseUrl: config.apiBaseUrl.get(),
      appId: '', domain: 'feishu',
    }]
  }

  /**
   * Secrets the lines connect with, by line id: the credential reference. The
   * legacy literal token serves the `telegram` line: first while lines are
   * not configured (as before), afterwards only until the store holds one.
   */
  let secrets = new Map<string, string>()
  const refreshToken = async (): Promise<void> => {
    const next = new Map<string, string>()
    const literal = config.botToken.get()?.trim() || undefined
    const legacy = config.lines.get().length === 0
    for (const line of configuredLines()) {
      if (line.id === LEGACY_LINE && legacy && literal !== undefined) {
        next.set(line.id, literal)
        continue
      }
      const ref = line.secretRef.trim()
      const value = ref === '' || optional.credentials === undefined
        ? undefined
        : (await optional.credentials.resolve(ref as CredentialRef).catch(() => undefined))?.value
      const secret = value || (line.id === LEGACY_LINE ? literal : undefined)
      if (secret !== undefined) next.set(line.id, secret)
    }
    secrets = next
  }

  /** A configured line as the bridge runs it. */
  const lineSettings = (line: Readonly<LineConfig>): LineSettings => {
    const secret = secrets.get(line.id)
    return {
      id: line.id,
      type: line.type,
      name: line.name.trim() || (line.type === 'feishu' ? (line.domain === 'lark' ? 'Lark' : '飞书') : 'Telegram'),
      enabled: line.enabled,
      allowedUsers: line.allowedUsers,
      allowedChats: line.allowedChats,
      groupMentionOnly: line.groupMentionOnly,
      workspacePath: line.workspacePath,
      ...(secret === undefined ? {} : { secret }),
      ...(line.type === 'telegram'
        ? { apiBaseUrl: line.apiBaseUrl, pollTimeoutSec: config.pollTimeoutSec }
        : { appId: line.appId.trim(), domain: line.domain }),
    }
  }

  /** The bot's own default model from config, when both route and model are set. */
  const configuredModel = (): ModelChoice | undefined => {
    const provider = config.modelProvider.get().trim()
    const model = config.model.get().trim()
    const effort = config.reasoningEffort.get().trim()
    return provider === '' || model === '' ? undefined : { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  }

  /** Check a route can serve a model before recording it (Agent.model.select leaves validation to callers). */
  const validateModel = async (choice: ModelChoice): Promise<void> => {
    const { groups } = await sessionController.modelCatalog()
    const listed = groups.some(group => group.id === choice.provider && group.models.some(model => model.id === choice.model))
    if (!listed) throw new Error(`model ${choice.provider}/${choice.model} is not available`)
    await llm.resolveCallConfig({
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    } as Parameters<typeof llm.resolveCallConfig>[0])
  }

  /** Record a choice on a live Agent's Session: durable, Session-local, and never the Web default. */
  const pinModel = (sessionId: string, choice: ModelChoice): boolean => {
    const agent = agents.get(sessionId as SessionId)
    if (agent === undefined) return false
    agent.model.select(choice as Parameters<typeof agent.model.select>[0])
    return true
  }

  const settings = (): BridgeSettings => {
    const model = configuredModel()
    return {
      enabled: config.enabled.get(),
      lines: configuredLines().map(lineSettings),
      workspacePath: config.workspacePath.get(),
      agentPreset: config.agentPreset.get(),
      permissionPreset: config.permissionPreset.get(),
      approvalViaTelegram: config.approvalViaTelegram.get(),
      questionsViaTelegram: config.questionsViaTelegram.get(),
      approvalTimeoutSec: config.approvalTimeoutSec.get(),
      notifyToolCalls: config.notifyToolCalls.get(),
      streamReplies: config.streamReplies.get(),
      turnSummary: config.turnSummary.get(),
      turnSummaryMinSec: config.turnSummaryMinSec.get(),
      transcribeVoice: config.transcribeVoice.get(),
      scheduleChats: config.scheduleChats.get(),
      alertChats: config.alertChats.get(),
      longReplyChars: config.longReplyChars.get(),
      people: config.people.get(),
      alertAfterMin: config.alertAfterMin.get(),
      language: config.language.get(),
      maxDownloadMb: config.maxDownloadMb.get(),
      sendDeliverables: config.sendDeliverables.get(),
      ...(model === undefined ? {} : { model }),
    }
  }

  const harness: HarnessPort = {
    async createSession(cwd, agentPreset, permissionPreset, model) {
      if (model !== undefined) await validateModel(model)
      // Create inside the directory's Web Workspace (made on first use), the
      // way the Web composer does, so the Session lists in the sidebar.
      const workspace = await optional.workspaces?.create(cwd).catch((error: unknown) => {
        logger.warn(`switchboard: no Web workspace for ${cwd}: ${String(error)}`)
        return undefined
      })
      const { sessionId } = await sessionController.create({
        ...(workspace === undefined ? { cwd } : { workspaceId: workspace.id as WorkspaceId }),
        ...(agentPreset === '' ? {} : { agentPreset }),
      })
      if (model !== undefined) pinModel(sessionId, model)
      if (permissionPreset !== '') {
        permissionPresets.resolve(permissionPreset)
        const agent = agents.get(sessionId)
        if (agent !== undefined) permissionPresets.set(agent.session, permissionPreset)
      }
      return sessionId
    },
    async prompt(sessionId, parts, mode) {
      await sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode,
        content: parts.map(part => part.type === 'text'
          ? part
          : { type: 'file' as const, receiptId: part.receiptId as FileUploadReceiptId }),
      }, new AbortController().signal)
    },
    async stageFile(sessionId, file) {
      const data = async function* () { yield file.data }
      if (file.imageType !== undefined) {
        try {
          const { receiptId } = await fileUploads.uploadImageStream({
            sessionId: sessionId as SessionId, data: data(), mediaType: file.imageType, name: file.name,
          })
          return receiptId
        } catch (error: unknown) {
          // Unaccepted types and oversized images still reach the Agent as files.
          logger.debug(`switchboard: ${file.name} staged as a file: ${String(error)}`)
        }
      }
      const { receiptId } = await fileUploads.uploadStream({ sessionId: sessionId as SessionId, data: data(), name: file.name })
      return receiptId
    },
    cancel(sessionId) {
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return false
      agent.cancel({ kind: 'user' })
      return true
    },
    live(sessionId) {
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return undefined
      const cwd = agent.session.header.cwd
      return { running: agent.status === 'running', ...(cwd === undefined ? {} : { cwd }) }
    },
    async listModels() {
      const catalog = await sessionController.modelCatalog()
      return {
        default: catalog.default,
        groups: catalog.groups.map(group => ({
          provider: group.id,
          name: group.name,
          models: group.models.map(model => ({ id: model.id, name: model.name })),
        })),
      }
    },
    currentModel(sessionId) {
      const current = agents.get(sessionId as SessionId)?.model.current()
      return current === undefined ? undefined : {
        provider: current.provider,
        model: current.model,
        ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
      }
    },
    async selectModel(sessionId, choice) {
      await validateModel(choice)
      return pinModel(sessionId, choice)
    },
    listPresets() {
      return permissionPresets.catalog().options.map(option => ({
        value: option.value, name: option.name, ...(option.description === undefined ? {} : { description: option.description }),
      }))
    },
    currentPreset(sessionId) {
      const agent = agents.get(sessionId as SessionId)
      return agent === undefined ? undefined : permissionPresets.current(agent.session)
    },
    selectPreset(sessionId, preset) {
      permissionPresets.resolve(preset)
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return false
      permissionPresets.set(agent.session, preset)
      return true
    },
    async listSessions() {
      const { items } = await sessionController.list({}, new AbortController().signal)
      return items
        .filter(item => item.origin !== 'subagent' && !item.blank)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((item): SessionRow => {
          const title = (item.projections?.values as { title?: unknown } | undefined)?.title
          return {
            sessionId: item.sessionId,
            updatedAt: item.updatedAt,
            running: item.running,
            ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
            ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          }
        })
    },
    queued(sessionId) {
      const inbox = agents.get(sessionId as SessionId)?.inbox
      if (inbox === undefined) return undefined
      return [...inbox.nextStep, ...inbox.nextTurn].map(message => ({
        id: message.id,
        text: message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' '),
      }))
    },
    dropQueued(sessionId, ids) {
      const inbox = agents.get(sessionId as SessionId)?.inbox
      if (inbox === undefined) return 0
      if (ids === 'all') {
        const count = inbox.nextStep.length + inbox.nextTurn.length
        inbox.clear()
        return count
      }
      return ids.filter(id => inbox.remove(id as Parameters<typeof inbox.remove>[0])).length
    },
    async ensureWorkspace(sessionId) {
      const registry = optional.workspaces
      if (registry === undefined) return
      if (registry.archivedSessionIds.includes(sessionId as SessionId)) return
      if (registry.list().some(workspace => workspace.sessionIds.includes(sessionId as SessionId))) return
      const cwd = agents.get(sessionId as SessionId)?.session.header.cwd
        ?? (await sessionController.list({}, new AbortController().signal)).items.find(item => item.sessionId === sessionId)?.cwd
      if (cwd === undefined) return
      const workspace = await registry.create(cwd)
      await workspace.attachSession(sessionId as SessionId)
      logger.info(`switchboard: added ${sessionId} to Web workspace ${workspace.path}`)
    },
    async listCommands(sessionId) {
      const commands = optional.commands
      if (commands === undefined) return []
      const agent = sessionId === undefined
        ? agents.roots()[0]
        : await resolveAgent(sessionId)
      if (agent === undefined) return []
      return commands.list(agent).map(descriptor => ({
        name: descriptor.name,
        description: descriptor.description,
        ...(descriptor.input === undefined ? {} : { hint: descriptor.input.hint }),
      }))
    },
    async runCommand(sessionId, line) {
      const commands = optional.commands
      if (commands === undefined) return undefined
      const agent = await resolveAgent(sessionId)
      if (agent === undefined) return undefined
      const execution = await commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) return undefined
      const { result } = execution
      return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) }
    },
    changedFiles(sessionId, seq) {
      const summary = optional.changes?.summary(sessionId as SessionId, seq as never)
      return summary?.files.map(file => file.display)
    },
    async eventsSince(sessionId, afterSeq) {
      const signal = AbortSignal.timeout(15_000)
      const projections = await sessionController.projections({ sessionId: sessionId as SessionId }, signal)
      if (projections === null || projections.kind !== 'sequenced') return undefined
      if (projections.asOfSeq <= afterSeq) return []
      // Read backwards page by page until the cursor, keeping only newer events.
      const events = new Map<number, { type: string; seq: number; time: number; data?: unknown }>()
      let before: number | undefined
      for (let page = 0; page < 8; page++) {
        const result = await sessionController.page({
          address: { kind: 'session', sessionId: sessionId as SessionId },
          throughSeq: projections.asOfSeq,
          maxMessages: 50,
          ...(before === undefined ? {} : { beforeSeq: before }),
        }, signal)
        const read = result.records.map(record => record.event)
        for (const event of read) if (event.seq > afterSeq) events.set(event.seq, event)
        const first = read[0]
        if (!result.hasMore || first === undefined || first.seq <= afterSeq || first.seq === before) break
        before = first.seq
      }
      return [...events.values()].sort((a, b) => a.seq - b.seq)
    },
    async transcribe(audio, signal) {
      const speech = optional.speech
      if (speech === undefined) throw new Error('speech recognition is not installed (voice input plugin)')
      const wav = await toWav(config.ffmpegPath.get().trim() || 'ffmpeg', audio, signal)
      const transcript = await speech.transcribe(speech.resolve({ audio: wav }), signal)
      return transcript.text
    },
  }

  const stateFile = config.stateFile ?? defaultStateFile()
  const store = new BindingStore(stateFile)
  const chatLog = new ChatLog(join(dirname(stateFile), 'chats'), () => config.historyLimit.get())
  const outbox = new Outbox(join(dirname(stateFile), 'outbox.json'))
  const bridge = new Switchboard(settings, harness, store, logger, {}, chatLog, outbox)
  const updates = new UpdateChecker()

  const restart = (): void => {
    void refreshToken().then(() => bridge.reconcile()).catch((error: unknown) => {
      logger.warn(`switchboard: restart failed: ${String(error)}`)
    })
  }

  ctx.inject(['credentials'], (scope) => {
    optional.credentials = scope.credentials
    scope.effect(() => () => { delete optional.credentials }, 'switchboard: credentials')
    // A secret written on the plugin page lands in the credentials store; reconnect with it.
    scope.on('credentials/reference-updated', (ref) => {
      if (configuredLines().some(line => line.secretRef.trim() === ref)) restart()
    })
    restart()
  })

  // Secrets of apps created by QR go straight to the credentials store.
  const registrations = new RegistrationDesk(async (ref, secret) => {
    if (optional.credentials === undefined) throw new Error('the credentials store is not available')
    await optional.credentials.set(ref as CredentialRef, secret)
  })
  ctx.effect(() => () => { registrations.dispose() }, 'switchboard: feishu registrations')

  // The Web viewer reads history through owner-only routes on the shared API channel.
  ctx.inject(['connection'], (scope) => {
    registerHistoryRoutes(scope, chatLog, bridge, () => sessionController.modelCatalog(), updates, registrations)
  })

  // `/switchboard` in the Web composer links the open Session to a chat.
  ctx.inject(['commands'], (scope) => {
    registerWebCommand(scope, bridge, chatLog, () => config.language.get())
  })

  // Sessions linked to a chat learn that their replies are read on a phone.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.context({
      name: 'switchboard:channel',
      order: 950,
      interpolate: false,
      text: (assembly) => {
        const agent = assembly.agent
        if (agent === undefined || !config.channelPrompt.get()) return ''
        if (store.chatsFor(agent.session.header.id).length === 0) return ''
        return config.channelPromptText.get().trim() || CHANNEL_PROMPT
      },
    }), 'switchboard: channel prompt')
  })

  ctx.on('session/event', (session, event) => {
    bridge.onSessionEvent(session.header.id, event, agents.get(session.header.id)?.session.header.cwd ?? session.header.cwd)
  })

  // Only top-level Agents stream to chats; subagent output stays inside their parent's turn.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.session.header.parentSession !== undefined) return
    bridge.onAssistantStream(agent.session.header.id, frame as Parameters<typeof bridge.onAssistantStream>[1])
  })

  // /model and /mode choices made while a Session was cold land as soon as it
  // loads, before the Agent handles the prompt that loaded it.
  ctx.on('agent/created', ({ agent }) => {
    const pending = bridge.takePending(agent.session.header.id)
    if (pending?.model !== undefined) agent.model.select(pending.model as Parameters<typeof agent.model.select>[0])
    if (pending?.preset !== undefined) {
      try {
        permissionPresets.set(agent.session, pending.preset)
      } catch (error: unknown) {
        logger.warn(`switchboard: pending permission mode ${pending.preset} not applied: ${String(error)}`)
      }
    }
    return undefined
  })

  ctx.on('agent/status', ({ agent, status }) => {
    bridge.onAgentStatus(agent.session.header.id, status === 'running')
  })

  // Prepended so a linked chat is asked before the Web UI; a timeout or an
  // unlinked Session hands the question on unchanged.
  ctx.on('approval/request', async (request, next) => {
    const outcome = await bridge.requestApproval({
      sessionId: request.agent.session.header.id,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return outcome === 'delegate' ? next() : outcome
  }, { prepend: true })

  // The Agent's questions go to linked chats first, like approvals.
  ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent
    if (agent === undefined) return next()
    const outcome = await bridge.requestAnswers({
      sessionId: agent.session.header.id,
      questions: request.questions,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (outcome === 'delegate') return next()
    return outcome === 'cancelled' ? { answers: [] } : outcome
  }, { prepend: true })

  // Line, secret, or switch edits restart the affected lines; other fields are read per operation.
  ctx.on('loader/volatile-update', restart)

  ctx.effect(() => {
    const migrated = config.stateFile === undefined ? migrateLegacyStateDir() : Promise.resolve(false)
    const started = migrated.then((moved) => {
      if (moved) logger.info('switchboard: moved data from the telegram-bridge directory')
      return Promise.all([store.load(), outbox.load()])
    }).then(() => refreshToken()).then(() => bridge.reconcile()).then(async () => {
      // Replies that finished while the plugin was not running go out now (or once their line connects).
      await bridge.catchUp().catch((error: unknown) => { logger.warn(`switchboard: catch-up failed: ${String(error)}`) })
      // Sessions linked before workspaces were attached join theirs now.
      await bridge.attachLinkedSessions()
    }).catch((error: unknown) => {
      logger.warn(`switchboard: failed to start: ${String(error)}`)
    })
    return async () => {
      await started
      await bridge.dispose()
      await store.settled()
      await chatLog.settled()
    }
  }, 'switchboard: polling')
}
