/**
 * Durable chat → Session bindings. One small JSON file the bridge owns, so a
 * restart resumes each chat's conversation instead of starting a new one.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What the bridge remembers per Telegram chat. */
export interface ChatBinding {
  /** Session the chat currently talks to. */
  sessionId?: string
  /** Workspace directory for the next new Session; overrides the configured default. */
  workspacePath?: string
}

/** File format version 1. */
interface BindingsFile {
  version: 1
  /** Last processed update id + 1, so a restart does not replay messages. */
  offset: number
  chats: Record<string, ChatBinding>
}

/**
 * Default state file location: `$DSH_HOME/telegram-bridge/state.json`,
 * with `$DSH_HOME` defaulting to `~/.dsh` like the launcher.
 */
export function defaultStateFile(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'telegram-bridge', 'state.json')
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
      throw new Error(`telegram-bridge: unrecognized state file ${this.path}`)
    }
    this.data = { version: 1, offset: Number(parsed.offset) || 0, chats: parsed.chats }
  }

  /** @returns the next getUpdates offset. */
  get offset(): number {
    return this.data.offset
  }

  /** @returns the chat's binding; an empty object when none is stored. */
  get(chatId: number): Readonly<ChatBinding> {
    return this.data.chats[String(chatId)] ?? {}
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
  update(chatId: number, patch: Partial<Record<keyof ChatBinding, string | undefined>>): Promise<void> {
    const key = String(chatId)
    const next: ChatBinding = { ...this.data.chats[key] }
    for (const [field, value] of Object.entries(patch) as [keyof ChatBinding, string | undefined][]) {
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
