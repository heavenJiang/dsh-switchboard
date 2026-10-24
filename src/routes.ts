/**
 * Owner-only routes the Web history viewer reads. They ride the shared `/api`
 * channel, so the carrier's trust and authentication policy applies before
 * any handler runs; nothing here changes state.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { modelLabel, type TelegramBridge } from './bridge.ts'
import type { ChatLog } from './chatlog.ts'

/** Route prefix; the browser half calls these relative to the page. */
export const API_PREFIX = '/api/telegram-bridge'

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
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
 */
export function registerHistoryRoutes(ctx: Context, log: ChatLog, bridge: TelegramBridge, models: () => Promise<unknown>): void {
  const fetchRoutes = ctx.connection.fetch
  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/overview`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const chats = (await log.chats()).map((chat) => {
        const model = chat.sessionId === undefined ? undefined : bridge.modelOf(chat.sessionId)
        return model === undefined ? chat : { ...chat, model: modelLabel(model) }
      })
      return json({ state: bridge.state, chats })
    },
  }), 'telegram-bridge: overview route')

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
  }), 'telegram-bridge: models route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/history`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { chatId, before, limit } = await body(request)
      if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId)) return json({ error: 'chatId must be an integer' }, 400)
      const size = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : 100
      return json(await log.history(chatId, typeof before === 'string' ? before : undefined, size))
    },
  }), 'telegram-bridge: history route')

  ctx.effect(() => fetchRoutes.register({
    path: `${API_PREFIX}/media`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const chatId = Number(url.searchParams.get('chat'))
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
  }), 'telegram-bridge: media route')
}
