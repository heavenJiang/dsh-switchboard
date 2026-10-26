/** Test doubles shared by the bridge specs. */

import type { HarnessPort, ModelChoice, PromptPart, StagedFileInput } from '../src/bridge.ts'

/** In-memory Harness: records prompts, staged files, created Sessions, and command runs. */
export class FakeHarness implements HarnessPort {
  readonly prompts: { sessionId: string; parts: readonly PromptPart[]; mode: string }[] = []
  readonly staged: (Omit<StagedFileInput, 'data'> & { sessionId: string; bytes: number })[] = []
  readonly created: { cwd: string; agentPreset: string; permissionPreset: string; model?: ModelChoice }[] = []
  readonly selected: { sessionId: string; choice: ModelChoice }[] = []
  /** Sessions currently loaded, with their model. */
  readonly loaded = new Map<string, ModelChoice>()
  readonly cancelled: string[] = []
  running = false

  async createSession(cwd: string, agentPreset: string, permissionPreset: string, model?: ModelChoice): Promise<string> {
    this.created.push({ cwd, agentPreset, permissionPreset, ...(model === undefined ? {} : { model }) })
    return `s${this.created.length}`
  }
  async listModels() {
    return {
      default: { provider: 'local', model: 'small' },
      groups: [
        { provider: 'local', name: 'Local', models: [{ id: 'small', name: 'Small' }, { id: 'qwen-large', name: 'Qwen Large' }] },
        { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] },
      ],
    }
  }
  presets = new Map<string, string>()
  inbox = new Map<string, { id: string; text: string }[]>()
  transcript: string | Error = new Error('speech recognition is not installed')
  listPresets() {
    return [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace write' }]
  }
  currentPreset(sessionId: string): string | undefined {
    return this.loaded.has(sessionId) ? (this.presets.get(sessionId) ?? 'workspace-write') : undefined
  }
  selectPreset(sessionId: string, preset: string): boolean {
    if (!this.listPresets().some(p => p.value === preset)) throw new Error(`unknown preset ${preset}`)
    if (!this.loaded.has(sessionId)) return false
    this.presets.set(sessionId, preset)
    return true
  }
  queued(sessionId: string) {
    return this.loaded.has(sessionId) ? [...(this.inbox.get(sessionId) ?? [])] : undefined
  }
  dropQueued(sessionId: string, ids: readonly string[] | 'all'): number {
    const items = this.inbox.get(sessionId) ?? []
    const keep = ids === 'all' ? [] : items.filter(item => !ids.includes(item.id))
    this.inbox.set(sessionId, keep)
    return items.length - keep.length
  }
  /** Harness commands this fake Session offers, and the lines it ran. */
  commands = [
    { name: 'compact', description: 'Compact the context', hint: '[focus]' },
    { name: 'goal', description: 'Set a goal' },
    { name: 'status', description: 'Harness status (shadowed by the bridge)' },
    { name: 'export-log', description: 'Not a valid Telegram menu name' },
    { name: 'switchboard', description: 'Web-only' },
  ]
  readonly ran: { sessionId: string; line: string }[] = []
  async listCommands(): Promise<{ name: string; description: string; hint?: string }[]> {
    return this.commands
  }
  async runCommand(sessionId: string, line: string): Promise<{ kind: 'success' | 'error'; text?: string } | undefined> {
    const name = line.slice(1).split(/\s/u)[0]
    if (!this.commands.some(command => command.name === name)) return undefined
    this.ran.push({ sessionId, line })
    if (name === 'goal') return { kind: 'error', text: 'goal text required' }
    return { kind: 'success', text: 'Compacted: 48k → 9k tokens' }
  }
  readonly workspaced: string[] = []
  async ensureWorkspace(sessionId: string): Promise<void> {
    if (!this.workspaced.includes(sessionId)) this.workspaced.push(sessionId)
  }
  changedFiles(): string[] | undefined {
    return ['src/a.ts', 'README.md']
  }
  /** Committed events eventsSince serves; undefined leaves the method unavailable. */
  events: { type: string; seq: number; time: number; data?: unknown }[] | undefined
  async eventsSince(_sessionId: string, afterSeq: number) {
    return this.events?.filter(event => event.seq > afterSeq)
  }
  async transcribe(): Promise<string> {
    if (this.transcript instanceof Error) throw this.transcript
    return this.transcript
  }
  currentModel(sessionId: string): ModelChoice | undefined {
    return this.loaded.get(sessionId)
  }
  async selectModel(sessionId: string, choice: ModelChoice): Promise<boolean> {
    this.selected.push({ sessionId, choice })
    if (!this.loaded.has(sessionId)) return false
    this.loaded.set(sessionId, choice)
    return true
  }
  async prompt(sessionId: string, parts: readonly PromptPart[], mode: 'queue' | 'steer'): Promise<void> {
    this.prompts.push({ sessionId, parts, mode })
  }
  async stageFile(sessionId: string, file: StagedFileInput): Promise<string> {
    const { data, ...rest } = file
    this.staged.push({ sessionId, bytes: data.byteLength, ...rest })
    return `r${this.staged.length}`
  }
  cancel(sessionId: string): boolean {
    this.cancelled.push(sessionId)
    return true
  }
  live() {
    return { running: this.running, cwd: '/tmp' }
  }
  async listSessions() {
    return [{ sessionId: 's1', cwd: '/tmp', updatedAt: 1, running: false }]
  }
}
