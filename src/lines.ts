/**
 * Lines: one bot account on one chat platform, with the people allowed to use
 * it. Each person reaches the Harness through whichever line they are on, and
 * every chat is known by a key that names its line.
 */

/** Chat platforms the switchboard speaks. */
export type ChannelType = 'telegram' | 'feishu'

/** One line as the bridge runs it, secrets resolved. */
export interface LineSettings {
  /** Stable key; chat keys of this line start with it. */
  readonly id: string
  readonly type: ChannelType
  /** Display name on the Web pages. */
  readonly name: string
  readonly enabled: boolean
  /** User ids (or `@username` on Telegram) allowed to drive the Harness. Empty admits no one. */
  readonly allowedUsers: readonly string[]
  /** Chat ids whose every member may drive the Harness. */
  readonly allowedChats: readonly string[]
  /** In groups, answer only commands, @mentions, and replies to the bot. */
  readonly groupMentionOnly: boolean
  /** Working directory for new Sessions on this line; empty uses the plugin-wide default. */
  readonly workspacePath: string
  /** Telegram bot token, or Feishu app secret; undefined until resolved. */
  readonly secret?: string
  /** Telegram: Bot API root. */
  readonly apiBaseUrl?: string
  /** Telegram: long-poll wait in seconds. */
  readonly pollTimeoutSec?: number
  /** Feishu: app id (`cli_…`). */
  readonly appId?: string
  /** Feishu: `feishu` (open.feishu.cn) or `lark` (open.larksuite.com). */
  readonly domain?: 'feishu' | 'lark'
}

/**
 * The line of chats recorded before lines existed. Its chats keep their bare
 * Telegram ids as keys, so bindings and history from those releases carry over.
 */
export const LEGACY_LINE = 'telegram'

/** Line ids: short, lowercase, and free of the key separator. */
export const LINE_ID = /^[a-z0-9_-]{1,32}$/u

/** Credential reference a new line stores its secret under. */
export function defaultSecretRef(type: ChannelType, lineId: string): string {
  const base = type === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : 'FEISHU_APP_SECRET'
  return lineId === type ? base : `${base}_${lineId.toUpperCase().replace(/-/gu, '_')}`
}

/**
 * The key a chat is stored and addressed by.
 * @param line - line id.
 * @param chat - the platform's chat id.
 */
export function chatKey(line: string, chat: string | number): string {
  return line === LEGACY_LINE ? String(chat) : `${line}:${chat}`
}

/** Split a chat key into its line and the platform's chat id. */
export function splitChatKey(key: string | number): { line: string; chat: string } {
  const text = String(key)
  const at = text.indexOf(':')
  return at < 0 ? { line: LEGACY_LINE, chat: text } : { line: text.slice(0, at), chat: text.slice(at + 1) }
}
