/**
 * Telegram bridge for DeepSeek Harness, host half.
 *
 * A Telegram bot becomes another client of the Web host: messages prompt a
 * Session through `ctx.sessionController` (the same path the Web UI uses, so
 * Telegram Sessions appear in the Web sidebar and vice versa), committed
 * assistant output is mirrored back to the bound chat, and tool approvals can
 * be answered with inline buttons. Photos and files are staged through
 * `ctx.fileUploads` — the Web composer's attachment path — and files the Agent
 * presents are sent back. Every user-facing setting is a volatile
 * Config field, edited on the Plugins page by the browser half in
 * `src/client` and applied without restarting the plugin.
 *
 * @module dsh-telegram-bridge
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: merges the `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
// Type-only: ctx.connection, for the history viewer's routes.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-permission-presets'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { BindingStore, defaultStateFile } from './bindings.ts'
import { TelegramBridge, type BridgeSettings, type HarnessPort, type SessionRow } from './bridge.ts'
import { ChatLog } from './chatlog.ts'
import { registerHistoryRoutes } from './routes.ts'
import type { BotLanguage } from './messages.ts'

export { TelegramBridge } from './bridge.ts'
export type { BridgeSettings, HarnessPort } from './bridge.ts'

export const name = 'telegram-bridge'
/** The Web host's Session controller drives Sessions exactly as the Web UI does. */
export const inject = ['agents', 'sessionController', 'permissionPresets', 'fileUploads']

/** Plugin configuration. Volatile fields are live-editable from the Plugins page. */
export interface Config {
  /** Run the bot. Turning it off stops polling without unloading the plugin. */
  enabled: Volatile<boolean>
  /** Bot token from @BotFather. A secret: never returned to the Web client. */
  botToken: Volatile<string | undefined>
  /** Telegram user ids (or `@username`) allowed to drive the Harness. Empty admits no one. */
  allowedUsers: Volatile<string[]>
  /** Working directory for new Sessions when a chat has not set one with /cwd. */
  workspacePath: Volatile<string>
  /** Agent preset for Sessions the bot creates. */
  agentPreset: Volatile<string>
  /** Permission preset applied to Sessions the bot creates; empty keeps the deployment default. */
  permissionPreset: Volatile<string>
  /** Ask tool approvals in Telegram for Sessions bound to a chat. */
  approvalViaTelegram: Volatile<boolean>
  /** Seconds to wait for a Telegram answer before handing the approval to the next answerer. */
  approvalTimeoutSec: Volatile<number>
  /** Post a short line for every tool call. */
  notifyToolCalls: Volatile<boolean>
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
  /** Long-poll wait in seconds. */
  pollTimeoutSec: number
  /** Chat-to-Session binding file; defaults to `$DSH_HOME/telegram-bridge/state.json`. */
  stateFile?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  botToken: Schema.string().role('secret').volatile(),
  allowedUsers: Schema.array(Schema.string()).default([]).volatile(),
  workspacePath: Schema.string().default('').volatile(),
  agentPreset: Schema.string().default('standard').volatile(),
  permissionPreset: Schema.string().default('workspace-write').volatile(),
  approvalViaTelegram: Schema.boolean().default(true).volatile(),
  approvalTimeoutSec: Schema.natural().min(10).max(3600).default(300).volatile(),
  notifyToolCalls: Schema.boolean().default(true).volatile(),
  language: Schema.union(['zh', 'en'] as const).default('zh').volatile(),
  apiBaseUrl: Schema.string().pattern(/^https?:\/\/\S+$/u).default('https://api.telegram.org').volatile(),
  maxDownloadMb: Schema.natural().min(1).max(2000).default(20).volatile(),
  sendDeliverables: Schema.boolean().default(true).volatile(),
  historyLimit: Schema.natural().min(100).max(100000).default(2000).volatile(),
  pollTimeoutSec: Schema.natural().min(1).max(50).default(30),
  stateFile: Schema.string(),
}) as unknown as Schema<Config>

/**
 * Mount the bridge.
 * @param ctx - plugin context with the Agent registry, Session controller, and permission presets.
 * @param config - validated configuration with live volatile fields.
 */
export function apply(ctx: Context, config: Config): void {
  // Handlers run outside the plugin's injection scope; capture services now.
  const { agents, sessionController, permissionPresets, fileUploads, logger } = ctx

  const settings = (): BridgeSettings => ({
    enabled: config.enabled.get(),
    botToken: config.botToken.get(),
    apiBaseUrl: config.apiBaseUrl.get(),
    allowedUsers: config.allowedUsers.get(),
    workspacePath: config.workspacePath.get(),
    agentPreset: config.agentPreset.get(),
    permissionPreset: config.permissionPreset.get(),
    approvalViaTelegram: config.approvalViaTelegram.get(),
    approvalTimeoutSec: config.approvalTimeoutSec.get(),
    notifyToolCalls: config.notifyToolCalls.get(),
    language: config.language.get(),
    pollTimeoutSec: config.pollTimeoutSec,
    maxDownloadMb: config.maxDownloadMb.get(),
    sendDeliverables: config.sendDeliverables.get(),
  })

  const harness: HarnessPort = {
    async createSession(cwd, agentPreset, permissionPreset) {
      const { sessionId } = await sessionController.create({ cwd, ...(agentPreset === '' ? {} : { agentPreset }) })
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
          logger.debug(`telegram-bridge: ${file.name} staged as a file: ${String(error)}`)
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
    async listSessions() {
      const { items } = await sessionController.list({}, new AbortController().signal)
      return items
        .filter(item => item.origin !== 'subagent' && !item.blank)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((item): SessionRow => ({
          sessionId: item.sessionId,
          updatedAt: item.updatedAt,
          running: item.running,
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        }))
    },
  }

  const stateFile = config.stateFile ?? defaultStateFile()
  const store = new BindingStore(stateFile)
  const chatLog = new ChatLog(join(dirname(stateFile), 'chats'), () => config.historyLimit.get())
  const bridge = new TelegramBridge(settings, harness, store, logger, undefined, chatLog)

  // The Web viewer reads history through owner-only routes on the shared API channel.
  ctx.inject(['connection'], (scope) => {
    registerHistoryRoutes(scope, chatLog, bridge)
  })

  ctx.on('session/event', (session, event) => {
    bridge.onSessionEvent(session.header.id, event, agents.get(session.header.id)?.session.header.cwd ?? session.header.cwd)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    bridge.onAgentStatus(agent.session.header.id, status === 'running')
  })

  // Prepended so a bound chat is asked before the Web UI; a timeout or an
  // unbound Session hands the question on unchanged.
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

  // Token, endpoint, or switch edits restart polling; other fields are read per operation.
  ctx.on('loader/volatile-update', () => {
    void bridge.reconcile().catch((error: unknown) => {
      logger.warn(`telegram-bridge: restart failed: ${String(error)}`)
    })
  })

  ctx.effect(() => {
    const started = store.load().then(() => bridge.reconcile()).catch((error: unknown) => {
      logger.warn(`telegram-bridge: failed to start: ${String(error)}`)
    })
    return async () => {
      await started
      await bridge.stop()
      await store.settled()
      await chatLog.settled()
    }
  }, 'telegram-bridge: polling')
}
