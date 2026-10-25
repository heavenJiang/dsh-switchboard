/**
 * Owner-only routes the Web history viewer reads. They ride the shared `/api`
 * channel, so the carrier's trust and authentication policy applies before
 * any handler runs; nothing here changes state.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { modelLabel, type Switchboard } from './bridge.ts'
import { splitChatKey } from './lines.ts'
import type { ChatLog, ChatSummary } from './chatlog.ts'
import type { UpdateChecker } from './updates.ts'

/** Route prefix; the browser half calls these relative to the page. */
export const API_PREFIX = '/api/switchboard'

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** A chat key from a request; numbers come from pages written before lines existed. */
function chatKeyOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return typeof value === 'string' && /^[\w.:-]{1,200}$/u.test(value) ? value : undefined
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Register the viewer's routes on the Host connection.
 * @param ctx - a context with `connection` injected; registrations are its effects.
 * @param log - the chat history.
 * @param bridge - the running bridge, for its connection state and Session models.
 * @param models - the Host's model catalog, for the settings page's model picker.
 * @param updates - the update checker for the settings page's version section.
 */
export function registerHistoryRoutes(
  ctx: Context, log: ChatLog, bridge: Switchboard, models: () => Promise<unknown>, updates: UpdateChecker,
): void {
  const fetchRoutes = ctx.connection.fetch
  /** The chat's line, platform, and bound Session's model, which the index does not store. */
  const describeChat = (chat: ChatSummary): ChatSummary => {
    const model = chat.sessionId === undefined ? undefined : bridge.modelOf(chat.sessionId)
    return { ...chat, ...lineOf(chat.chatId), ...(model === undefined ? {} : { model: modelLabel(model) }) }
  }
  const lineOf = (key: string): { line: string; channel?: string } => {
    const { line } = splitChatKey(key)
    const type = bridge.lineStates().find(candidate => candidate.id === line)?.type
    return { line, ...(type === undefined ? {} : { channel: type }) }
  }
  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/overview`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const chats = (await log.chats()).map(chat => describeChat(chat))
      return json({ state: bridge.state, lines: bridge.lineStates(), chats, stats: await log.stats() })
    },
  }), 'switchboard: overview route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/models`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json(await models())
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 503)
      }
    },
  }), 'switchboard: models route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/update-check`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { source, force } = await body(request)
      return json(await updates.check(typeof source === 'string' ? source : undefined, force === true))
    },
  }), 'switchboard: update check route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/session`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { sessionId } = await body(request)
      if (typeof sessionId !== 'string' || sessionId === '') return json({ error: 'sessionId required' }, 400)
      const chats = (await log.chats()).filter(chat => !chat.deniedOnly).map(chat => describeChat(chat))
      const links = bridge.linksOf(sessionId)
      const titled = links.map(link => ({ ...link, title: chats.find(chat => chat.chatId === link.chatId)?.title ?? link.chatId, ...lineOf(link.chatId) }))
      // Chats that were bound to the Session before still hold its history.
      const lookIn = [...links.map(link => link.chatId), ...chats.filter(chat => chat.sessionId === sessionId).map(chat => chat.chatId)]
      const entries = await log.sessionHistory(sessionId, lookIn, 60)
      return json({ connected: bridge.lineStates().some(line => line.state.kind === 'running'), links: titled, chats, entries })
    },
  }), 'switchboard: session route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/link`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { chatId: rawChat, sessionId, mode } = await body(request)
      const chatId = chatKeyOf(rawChat)
      if (chatId === undefined || typeof sessionId !== 'string' || !['active', 'watch', 'none'].includes(String(mode))) {
        return json({ error: 'chatId, sessionId, and mode (active | watch | none) required' }, 400)
      }
      await bridge.linkChat(chatId, sessionId, mode as 'active' | 'watch' | 'none')
      return json({ ok: true })
    },
  }), 'switchboard: link route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/send`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { chatId: rawChat, text } = await body(request)
      const chatId = chatKeyOf(rawChat)
      if (chatId === undefined || typeof text !== 'string' || text.trim() === '') return json({ error: 'chatId and text required' }, 400)
      try {
        await bridge.sendFromWeb(chatId, text.trim())
        return json({ ok: true })
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409)
      }
    },
  }), 'switchboard: send route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/history`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { chatId: rawChat, before, limit } = await body(request)
      const chatId = chatKeyOf(rawChat)
      if (chatId === undefined) return json({ error: 'chatId required' }, 400)
      const size = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : 100
      return json(await log.history(chatId, typeof before === 'string' ? before : undefined, size))
    },
  }), 'switchboard: history route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/media`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const chatId = url.searchParams.get('chat') ?? ''
      const name = url.searchParams.get('name') ?? ''
      const data = await log.readMedia(chatId, name)
      if (data === undefined) return new Response('not found', { status: 404 })
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
      return new Response(data as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': MEDIA_TYPES[extension] ?? 'application/octet-stream',
          'cache-control': 'private, max-age=86400, immutable',
          'x-content-type-options': 'nosniff',
        },
      })
    },
  }), 'switchboard: media route')
}
