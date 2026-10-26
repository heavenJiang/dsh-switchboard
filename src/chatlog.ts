/**
 * Chat history for the Web viewer, across every line. Each chat keeps an append-only
 * JSONL file plus an index of chat summaries; received images are kept next
 * to it so the viewer can show them. Everything lives under the bridge's
 * state directory and never enters a Session.
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatEntry, ChatInfo, ChatPage, ChatStats, ChatSummary } from './history-types.ts'

export type * from './history-types.ts'

const MEDIA_NAME = /^[\w.-]+$/u
const CHAT_KEY = /^[\w.:-]{1,200}$/u
/** Days of counters kept for the dashboard. */
const STATS_DAYS = 30

/** One day's counters. */
interface DayCounters {
  in: number
  out: number
  allowed: number
  rejected: number
  denied: number
  chats: string[]
}

/** File-name form of a chat key; legacy Telegram ids are unchanged. */
function fileKey(chat: string): string {
  return chat.replace(/[^\w.-]/gu, '~')
}

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Per-chat JSONL history with a summary index and bounded retention. */
export class ChatLog {
  private summaries = new Map<string, ChatSummary>()
  private tails = new Map<string, Promise<void>>()
  private indexTail: Promise<void> = Promise.resolve()
  private seq = 0
  private loaded: Promise<void> | undefined
  private readonly inflight = new Set<Promise<unknown>>()
  private days: Record<string, DayCounters> = {}
  private statsTail: Promise<void> = Promise.resolve()

  /**
   * @param dir - directory holding `index.json`, `<chat key>.jsonl`, and `<chat key>/` media.
   * @param limit - entries kept per chat; older ones and their media are dropped.
   */
  constructor(private readonly dir: string, private readonly limit: () => number) {}

  /** Load the summary index once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const rows = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as ChatSummary[]
        // Releases before lines stored Telegram chat ids as numbers.
        for (const row of rows) this.summaries.set(String(row.chatId), { ...row, chatId: String(row.chatId) })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        this.days = JSON.parse(await readFile(join(this.dir, 'stats.json'), 'utf8')) as Record<string, DayCounters>
      } catch {
        // Counters are a convenience; a missing or damaged file starts them over.
        this.days = {}
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
    const sender = stored.dir === 'in' ? stored.from : undefined
    if (sender !== undefined || previous?.sender !== undefined) summary.sender = sender ?? previous!.sender!
    this.summaries.set(chat.chatId, summary)
    await this.enqueue(chat.chatId, async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(chat.chatId), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
      if (summary.count > this.limit() * 1.25) await this.compact(chat.chatId, summary)
    })
    this.count(chat.chatId, stored)
    await this.saveIndex()
    return stored
  }

  /** Fold one entry into its day's counters and drop days past the window. */
  private count(chatId: string, entry: ChatEntry): void {
    const key = dayKey(entry.at)
    const day = this.days[key] ??= { in: 0, out: 0, allowed: 0, rejected: 0, denied: 0, chats: [] }
    if (entry.kind === 'denied') day.denied++
    else if (entry.dir === 'in') day.in++
    else day.out++
    if (entry.approval?.outcome === 'allowed-once') day.allowed++
    if (entry.approval?.outcome === 'rejected') day.rejected++
    if (entry.kind !== 'denied' && !day.chats.map(String).includes(chatId)) day.chats.push(chatId)
    const keys = Object.keys(this.days).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - STATS_DAYS))) delete this.days[old]
    const snapshot = JSON.stringify(this.days)
    this.statsTail = this.statsTail.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = join(this.dir, `stats.json.${process.pid}.tmp`)
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, join(this.dir, 'stats.json'))
    })
  }

  /** Dashboard figures: today, the last 7 days, and a 14-day series. */
  async stats(now: number = Date.now()): Promise<ChatStats> {
    await this.load()
    const series: { day: string; in: number; out: number }[] = []
    const week = { messages: 0, allowed: 0, rejected: 0, denied: 0, chats: new Set<string>() }
    for (let i = 13; i >= 0; i--) {
      const key = dayKey(now - i * 86_400_000)
      const day = this.days[key]
      series.push({ day: key, in: day?.in ?? 0, out: day?.out ?? 0 })
      if (i < 7 && day !== undefined) {
        week.messages += day.in + day.out
        week.allowed += day.allowed
        week.rejected += day.rejected
        week.denied += day.denied
        for (const chat of day.chats) week.chats.add(String(chat))
      }
    }
    const today = this.days[dayKey(now)]
    return {
      today: { in: today?.in ?? 0, out: today?.out ?? 0 },
      week: { messages: week.messages, activeChats: week.chats.size, allowed: week.allowed, rejected: week.rejected, denied: week.denied },
      series,
    }
  }

  /**
   * Recent entries about one Session across the given chats, oldest first.
   * @param sessionId - the Session.
   * @param chatIds - chats to look in (those linked to it now or before).
   * @param limit - most entries returned.
   */
  async sessionHistory(sessionId: string, chatIds: readonly string[], limit: number): Promise<(ChatEntry & { chatId: string })[]> {
    const all: (ChatEntry & { chatId: string })[] = []
    for (const chatId of new Set(chatIds)) {
      await this.tails.get(chatId)
      for (const entry of await this.readAll(chatId)) if (entry.sessionId === sessionId) all.push({ ...entry, chatId })
    }
    return all.sort((a, b) => a.at - b.at).slice(-limit)
  }

  /** Remember the Session a chat is bound to, without adding an entry. */
  bind(chatId: string, sessionId: string): Promise<void> {
    return this.track(this.writeBinding(chatId, sessionId))
  }

  private async writeBinding(chatId: string, sessionId: string): Promise<void> {
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
  async saveMedia(chatId: string, extension: string, data: Uint8Array): Promise<string> {
    const name = `${Date.now().toString(36)}-${(this.seq++).toString(36)}${extension}`
    const dir = join(this.dir, fileKey(chatId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), data, { mode: 0o600 })
    return name
  }

  /**
   * Read a stored media file.
   * @returns the bytes, or undefined for an unknown or malformed name.
   */
  async readMedia(chatId: string, name: string): Promise<Uint8Array | undefined> {
    if (!CHAT_KEY.test(chatId) || !MEDIA_NAME.test(name) || name.startsWith('.')) return undefined
    try {
      return new Uint8Array(await readFile(join(this.dir, fileKey(chatId), name)))
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
  async history(chatId: string, before: string | undefined, limit: number): Promise<ChatPage> {
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
    await Promise.allSettled([...this.tails.values(), this.indexTail, this.statsTail])
  }

  private track<V>(work: Promise<V>): Promise<V> {
    this.inflight.add(work)
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work))
    return work
  }

  private file(chatId: string): string {
    return join(this.dir, `${fileKey(chatId)}.jsonl`)
  }

  private async readAll(chatId: string): Promise<ChatEntry[]> {
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
  private async compact(chatId: string, summary: ChatSummary): Promise<void> {
    const kept = (await this.readAll(chatId)).slice(-this.limit())
    const temp = `${this.file(chatId)}.${process.pid}.tmp`
    await writeFile(temp, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    await rename(temp, this.file(chatId))
    summary.count = kept.length
    const referenced = new Set(kept.flatMap(entry => entry.attachments ?? []).flatMap(a => a.media === undefined ? [] : [a.media]))
    const mediaDir = join(this.dir, fileKey(chatId))
    let names: string[] = []
    try {
      names = await readdir(mediaDir)
    } catch {
      return
    }
    await Promise.all(names.filter(name => !referenced.has(name)).map(name => rm(join(mediaDir, name), { force: true })))
  }

  private enqueue(chatId: string, write: () => Promise<void>): Promise<void> {
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
