/**
 * Telegram chat history for the Web viewer. Each chat keeps an append-only
 * JSONL file plus an index of chat summaries; received images are kept next
 * to it so the viewer can show them. Everything lives under the bridge's
 * state directory and never enters a Session.
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatEntry, ChatInfo, ChatPage, ChatSummary } from './history-types.ts'

export type * from './history-types.ts'

const MEDIA_NAME = /^[\w.-]+$/u

/** Per-chat JSONL history with a summary index and bounded retention. */
export class ChatLog {
  private summaries = new Map<number, ChatSummary>()
  private tails = new Map<number, Promise<void>>()
  private indexTail: Promise<void> = Promise.resolve()
  private seq = 0
  private loaded: Promise<void> | undefined
  private readonly inflight = new Set<Promise<unknown>>()

  /**
   * @param dir - directory holding `index.json`, `<chatId>.jsonl`, and `<chatId>/` media.
   * @param limit - entries kept per chat; older ones and their media are dropped.
   */
  constructor(private readonly dir: string, private readonly limit: () => number) {}

  /** Load the summary index once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const rows = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as ChatSummary[]
        for (const row of rows) this.summaries.set(row.chatId, row)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
    return this.loaded
  }

  /** @returns every chat, most recently active first. */
  async chats(): Promise<ChatSummary[]> {
    await this.load()
    return [...this.summaries.values()].sort((a, b) => b.lastAt - a.lastAt)
  }

  /**
   * Append one entry and refresh the chat's summary.
   * @param chat - what is known about the chat now.
   * @param entry - the entry without id and time.
   * @returns the stored entry.
   */
  record(chat: ChatInfo, entry: Omit<ChatEntry, 'id' | 'at'>): Promise<ChatEntry> {
    return this.track(this.write(chat, entry))
  }

  private async write(chat: ChatInfo, entry: Omit<ChatEntry, 'id' | 'at'>): Promise<ChatEntry> {
    await this.load()
    const at = Date.now()
    const stored: ChatEntry = { id: `${at.toString(36)}-${(this.seq++).toString(36)}`, at, ...entry }
    const previous = this.summaries.get(chat.chatId)
    const summary: ChatSummary = {
      chatId: chat.chatId,
      title: chat.title ?? previous?.title ?? String(chat.chatId),
      type: chat.type ?? previous?.type ?? 'private',
      lastAt: at,
      lastText: preview(stored),
      count: (previous?.count ?? 0) + 1,
      // Bot replies (such as the unauthorized notice) do not count either way.
      deniedOnly: (previous?.deniedOnly ?? true) && (stored.dir === 'out' || stored.kind === 'denied'),
    }
    const username = chat.username ?? previous?.username
    if (username !== undefined) summary.username = username
    const sessionId = entry.sessionId ?? previous?.sessionId
    if (sessionId !== undefined) summary.sessionId = sessionId
    this.summaries.set(chat.chatId, summary)
    await this.enqueue(chat.chatId, async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(chat.chatId), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
      if (summary.count > this.limit() * 1.25) await this.compact(chat.chatId, summary)
    })
    await this.saveIndex()
    return stored
  }

  /** Remember the Session a chat is bound to, without adding an entry. */
  bind(chatId: number, sessionId: string): Promise<void> {
    return this.track(this.writeBinding(chatId, sessionId))
  }

  private async writeBinding(chatId: number, sessionId: string): Promise<void> {
    await this.load()
    const summary = this.summaries.get(chatId)
    if (summary === undefined || summary.sessionId === sessionId) return
    summary.sessionId = sessionId
    await this.saveIndex()
  }

  /**
   * Keep a copy of a received image for the viewer.
   * @returns the stored file name to put in {@link ChatAttachment.media}.
   */
  async saveMedia(chatId: number, extension: string, data: Uint8Array): Promise<string> {
    const name = `${Date.now().toString(36)}-${(this.seq++).toString(36)}${extension}`
    const dir = join(this.dir, String(chatId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), data, { mode: 0o600 })
    return name
  }

  /**
   * Read a stored media file.
   * @returns the bytes, or undefined for an unknown or malformed name.
   */
  async readMedia(chatId: number, name: string): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(chatId) || !MEDIA_NAME.test(name) || name.startsWith('.')) return undefined
    try {
      return new Uint8Array(await readFile(join(this.dir, String(chatId), name)))
    } catch {
      return undefined
    }
  }

  /**
   * Read one page of a chat's history.
   * @param chatId - the chat.
   * @param before - return entries older than this entry id; newest page when omitted.
   * @param limit - page size.
   */
  async history(chatId: number, before: string | undefined, limit: number): Promise<ChatPage> {
    await this.tails.get(chatId)
    const entries = await this.readAll(chatId)
    const end = before === undefined ? entries.length : entries.findIndex(entry => entry.id === before)
    const stop = end < 0 ? entries.length : end
    const start = Math.max(0, stop - limit)
    return { entries: entries.slice(start, stop), more: start > 0 }
  }

  /** Wait for every write started so far, including ones still loading the index. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    await Promise.allSettled([...this.tails.values(), this.indexTail])
  }

  private track<V>(work: Promise<V>): Promise<V> {
    this.inflight.add(work)
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work))
    return work
  }

  private file(chatId: number): string {
    return join(this.dir, `${chatId}.jsonl`)
  }

  private async readAll(chatId: number): Promise<ChatEntry[]> {
    let text: string
    try {
      text = await readFile(this.file(chatId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: ChatEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line) as ChatEntry)
      } catch {
        // A torn last line from a crash is skipped.
      }
    }
    return entries
  }

  /** Rewrite a chat's file with its newest entries and drop media nothing references. */
  private async compact(chatId: number, summary: ChatSummary): Promise<void> {
    const kept = (await this.readAll(chatId)).slice(-this.limit())
    const temp = `${this.file(chatId)}.${process.pid}.tmp`
    await writeFile(temp, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    await rename(temp, this.file(chatId))
    summary.count = kept.length
    const referenced = new Set(kept.flatMap(entry => entry.attachments ?? []).flatMap(a => a.media === undefined ? [] : [a.media]))
    const mediaDir = join(this.dir, String(chatId))
    let names: string[] = []
    try {
      names = await readdir(mediaDir)
    } catch {
      return
    }
    await Promise.all(names.filter(name => !referenced.has(name)).map(name => rm(join(mediaDir, name), { force: true })))
  }

  private enqueue(chatId: number, write: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(chatId) ?? Promise.resolve()).catch(() => {}).then(write)
    this.tails.set(chatId, next)
    return next
  }

  private saveIndex(): Promise<void> {
    const snapshot = JSON.stringify([...this.summaries.values()], null, 2)
    this.indexTail = this.indexTail.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = join(this.dir, `index.json.${process.pid}.tmp`)
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, join(this.dir, 'index.json'))
    })
    return this.indexTail
  }
}

/** One-line preview of an entry for the chat list. */
function preview(entry: ChatEntry): string {
  if (entry.kind === 'approval' && entry.approval !== undefined) return `🔐 ${entry.approval.tool}`
  if (entry.kind === 'file') return `📎 ${entry.attachments?.map(a => a.name).join(', ') ?? ''}`
  const files = entry.attachments?.length ?? 0
  const text = (entry.text ?? '').replace(/\s+/gu, ' ').trim()
  const label = files === 0 ? text : `${files === 1 && entry.attachments?.[0]?.kind === 'image' ? '🖼' : '📎'} ${text}`.trim()
  return label.length > 80 ? `${label.slice(0, 79)}…` : label
}
