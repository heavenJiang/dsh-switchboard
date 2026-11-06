/** Pure text helpers: command parsing, allow-list checks, and message chunking. */

/** Telegram's hard per-message text limit. */
export const TELEGRAM_TEXT_LIMIT = 4096

/** One parsed slash command, or plain text for the agent. */
export type ParsedInput =
  | { readonly kind: 'command'; readonly name: string; readonly args: string }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Split a message into a slash command or a prompt. `/cmd@BotName args`
 * addresses this bot only when the suffix matches its username; a command
 * addressed to another bot is treated as nothing.
 * @param text - raw message text.
 * @param botUsername - this bot's username, when known.
 * @returns the parsed input, or undefined for empty or foreign-bot input.
 */
export function parseInput(text: string, botUsername?: string): ParsedInput | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu.exec(trimmed)
  if (match === null) return { kind: 'text', text: trimmed }
  const [, name = '', target, args = ''] = match
  if (target !== undefined && botUsername !== undefined && target.toLowerCase() !== botUsername.toLowerCase()) {
    return undefined
  }
  return { kind: 'command', name: name.toLowerCase(), args: args.trim() }
}

/** Longest span {@link parseDuration} accepts, so a typo cannot mean years. */
const DURATION_LIMIT_MS = 30 * 24 * 60 * 60 * 1000
const DURATION_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * Read a span like `45s`, `30m`, `2h`, or `1d`; a bare number means minutes.
 * @returns milliseconds, or undefined when it is not a positive span of at most 30 days.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d{1,5})([smhd]?)$/iu.exec(text.trim())
  if (match === null) return undefined
  const ms = Number(match[1]) * (DURATION_UNIT_MS[(match[2] || 'm').toLowerCase()] ?? 0)
  return ms > 0 && ms <= DURATION_LIMIT_MS ? ms : undefined
}

/**
 * Whether a user may drive the harness. An empty list admits no one: the
 * bridge runs tools on this machine, so access is opt-in per user id.
 * @param allowed - configured user ids (`@username` entries also match on Telegram).
 * @param userId - sender id.
 * @param username - sender username, when set.
 */
export function isAllowed(allowed: readonly string[], userId: string | number, username?: string): boolean {
  const id = String(userId)
  const handle = username === undefined ? undefined : `@${username.toLowerCase()}`
  return allowed.some((entry) => {
    const value = entry.trim().toLowerCase()
    return value === id.toLowerCase() || (handle !== undefined && value === handle)
  })
}

/**
 * Split text into Telegram-sized chunks, preferring paragraph, then line,
 * then word boundaries.
 * @param text - text to send.
 * @param limit - maximum chunk length.
 * @returns non-empty chunks in order.
 */
export function chunkText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/**
 * Shorten text for a one-line preview.
 * @param text - source text.
 * @param max - maximum length including the ellipsis.
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Render a tool call's JSON arguments as a short preview.
 * @param raw - the call's argument string.
 * @param max - maximum preview length.
 */
export function previewArguments(raw: string, max: number): string {
  let text = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      // Shell-like tools carry their whole intent in one field.
      for (const key of ['command', 'cmd', 'path', 'file_path', 'url', 'query']) {
        if (typeof record[key] === 'string') return truncate(`${key}: ${record[key]}`, max)
      }
      text = JSON.stringify(parsed)
    }
  } catch {
    // Non-JSON arguments are shown verbatim.
  }
  return truncate(text, max)
}
