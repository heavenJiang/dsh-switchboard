/**
 * Messages that could not reach their chat: the line was down, or the send
 * failed before the platform received it. They are kept on disk and sent,
 * oldest first, once their line is connected again. A send whose outcome is
 * unknown is never retried, so a chat does not see the same reply twice.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** What to send again. */
export type OutboxPayload =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string; readonly description?: string }

export interface OutboxItem {
  readonly id: string
  /** Chat key. */
  readonly chat: string
  readonly payload: OutboxPayload
  readonly sessionId?: string
  /** When the message was first due. */
  readonly at: number
  /** Sends attempted so far. */
  attempts: number
}

/** Sends per item before it is dropped. */
export const OUTBOX_ATTEMPTS = 3
/** Items older than this are dropped rather than sent late. */
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000
/** Items kept per chat; the oldest go first. */
const PER_CHAT = 50

/** Disk-backed queue of undelivered messages. */
export class Outbox {
  private items: OutboxItem[] = []
  private seq = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Load the file; a missing or damaged one starts empty. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { items?: OutboxItem[] }
      this.items = Array.isArray(parsed.items) ? parsed.items : []
    } catch {
      this.items = []
    }
  }

  /** Queue a message for a chat. */
  add(chat: string, payload: OutboxPayload, options: { sessionId?: string; at?: number; attempts?: number } = {}): Promise<void> {
    const item: OutboxItem = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      chat, payload, at: options.at ?? Date.now(), attempts: options.attempts ?? 0,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }
    this.items.push(item)
    const mine = this.items.filter(other => other.chat === chat)
    if (mine.length > PER_CHAT) {
      const drop = new Set(mine.slice(0, mine.length - PER_CHAT).map(other => other.id))
      this.items = this.items.filter(other => !drop.has(other.id))
    }
    return this.flush()
  }

  /**
   * Items due for chats a predicate selects, oldest first; expired and spent items are dropped.
   * @returns the items to send now.
   */
  due(select: (chat: string) => boolean, now: number = Date.now()): OutboxItem[] {
    const before = this.items.length
    this.items = this.items.filter(item => now - item.at <= OUTBOX_TTL_MS && item.attempts < OUTBOX_ATTEMPTS)
    if (this.items.length !== before) void this.flush()
    return this.items.filter(item => select(item.chat))
  }

  /** Forget a sent item. */
  remove(id: string): Promise<void> {
    this.items = this.items.filter(item => item.id !== id)
    return this.flush()
  }

  /** Count another attempt; the item is dropped once it is spent. */
  failed(id: string, retry: boolean): Promise<void> {
    const item = this.items.find(candidate => candidate.id === id)
    if (item === undefined) return this.writing
    item.attempts++
    if (!retry || item.attempts >= OUTBOX_ATTEMPTS) this.items = this.items.filter(candidate => candidate.id !== id)
    return this.flush()
  }

  /** Waiting items per chat key. */
  counts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const item of this.items) counts.set(item.chat, (counts.get(item.chat) ?? 0) + 1)
    return counts
  }

  /** Wait for queued writes. */
  settled(): Promise<void> {
    return this.writing
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, items: this.items }, null, 2)
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.path)
    })
    return this.writing
  }
}
