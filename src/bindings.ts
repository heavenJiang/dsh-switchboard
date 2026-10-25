/**
 * Durable chat → Session bindings. One small JSON file the bridge owns, so a
 * restart resumes each chat's conversation instead of starting a new one.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What the bridge remembers per Telegram chat. */
export interface ChatBinding {
  /** Session the chat currently talks to. */
  sessionId?: string
  /** Workspace directory for the next new Session; overrides the configured default. */
  workspacePath?: string
  /** Sessions this chat follows for completion and approval notices without talking to them. */
  watch?: string[]
}

/** A choice made in Telegram for a Session that was not loaded at the time. */
export interface PendingChoice {
  model?: { provider: string; model: string; reasoningEffort?: string }
  preset?: string
}

/** File format version 1. */
interface BindingsFile {
  version: 1
  /** Last processed update id + 1, so a restart does not replay messages. */
  offset: number
  chats: Record<string, ChatBinding>
  /** Choices applied when their Session next loads, by Session id. */
  pending?: Record<string, PendingChoice>
}

/**
 * Default state file location: `$DSH_HOME/switchboard/state.json`,
 * with `$DSH_HOME` defaulting to `~/.dsh` like the launcher.
 */
export function defaultStateFile(): string {
  return join(dshHome(), 'switchboard', 'state.json')
}

function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/**
 * Move the data directory of releases named dsh-telegram-bridge
 * (`$DSH_HOME/telegram-bridge`) to `$DSH_HOME/switchboard`, keeping bindings,
 * chat history, and media. Does nothing once the new directory exists.
 * @returns whether a directory was moved.
 */
export async function migrateLegacyStateDir(): Promise<boolean> {
  const target = join(dshHome(), 'switchboard')
  const legacy = join(dshHome(), 'telegram-bridge')
  if (await exists(target) || !await exists(legacy)) return false
  await rename(legacy, target)
  return true
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Serialized read-modify-write store over one JSON file. */
export class BindingStore {
  private data: BindingsFile = { version: 1, offset: 0, chats: {} }
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Load the file; a missing file starts empty, a corrupt one fails loud. */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(text) as Partial<BindingsFile>
    if (parsed.version !== 1 || typeof parsed.chats !== 'object' || parsed.chats === null) {
      throw new Error(`switchboard: unrecognized state file ${this.path}`)
    }
    this.data = {
      version: 1, offset: Number(parsed.offset) || 0, chats: parsed.chats,
      ...(parsed.pending === undefined ? {} : { pending: parsed.pending }),
    }
  }

  /** @returns the next getUpdates offset. */
  get offset(): number {
    return this.data.offset
  }

  /** @returns the chat's binding; an empty object when none is stored. */
  get(chatId: number): Readonly<ChatBinding> {
    return this.data.chats[String(chatId)] ?? {}
  }

  /** @returns every chat that follows a Session without being bound to it. */
  watchersOf(sessionId: string): number[] {
    return Object.entries(this.data.chats)
      .filter(([, binding]) => binding.sessionId !== sessionId && binding.watch?.includes(sessionId) === true)
      .map(([chatId]) => Number(chatId))
  }

  /** Start or stop following a Session from a chat. */
  setWatch(chatId: number, sessionId: string, on: boolean): Promise<void> {
    const key = String(chatId)
    const binding: ChatBinding = { ...this.data.chats[key] }
    const list = new Set(binding.watch ?? [])
    if (on) list.add(sessionId)
    else list.delete(sessionId)
    if (list.size === 0) delete binding.watch
    else binding.watch = [...list]
    this.data.chats[key] = binding
    return this.flush()
  }

  /** @returns the pending choice for a Session, if any. */
  pending(sessionId: string): Readonly<PendingChoice> | undefined {
    return this.data.pending?.[sessionId]
  }

  /**
   * Merge or clear a pending choice.
   * @param patch - fields to set; `undefined` clears that field; an empty result removes the entry.
   */
  setPending(sessionId: string, patch: Partial<Record<keyof PendingChoice, unknown>>): Promise<void> {
    const pending = { ...this.data.pending }
    const next: Record<string, unknown> = { ...pending[sessionId] }
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field]
      else next[field] = value
    }
    if (Object.keys(next).length === 0) delete pending[sessionId]
    else pending[sessionId] = next as PendingChoice
    this.data.pending = pending
    return this.flush()
  }

  /** @returns every Session some chat is bound to or follows. */
  linkedSessions(): string[] {
    const ids = new Set<string>()
    for (const binding of Object.values(this.data.chats)) {
      if (binding.sessionId !== undefined) ids.add(binding.sessionId)
      for (const id of binding.watch ?? []) ids.add(id)
    }
    return [...ids]
  }

  /** @returns every chat bound to a Session id. */
  chatsFor(sessionId: string): number[] {
    return Object.entries(this.data.chats)
      .filter(([, binding]) => binding.sessionId === sessionId)
      .map(([chatId]) => Number(chatId))
  }

  /**
   * Merge fields into one chat's binding and persist.
   * @param chatId - Telegram chat id.
   * @param patch - fields to set; `undefined` removes a field.
   */
  update(chatId: number, patch: Partial<Record<'sessionId' | 'workspacePath', string | undefined>>): Promise<void> {
    const key = String(chatId)
    const next: ChatBinding = { ...this.data.chats[key] }
    for (const [field, value] of Object.entries(patch) as ['sessionId' | 'workspacePath', string | undefined][]) {
      if (value === undefined) delete next[field]
      else next[field] = value
    }
    this.data.chats[key] = next
    return this.flush()
  }

  /** Record the next update offset and persist. */
  setOffset(offset: number): Promise<void> {
    if (offset <= this.data.offset) return this.writing
    this.data.offset = offset
    return this.flush()
  }

  /** Wait for queued writes. */
  settled(): Promise<void> {
    return this.writing
  }

  /** Queue one atomic whole-file write (temp file + rename). */
  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.path)
    })
    return this.writing
  }
}
