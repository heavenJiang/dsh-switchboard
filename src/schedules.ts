/**
 * Scheduled tasks as chats manage them: `/schedule add` syntax, the task view
 * the bridge renders, and telling which tasks a delivered reminder came from.
 * Tasks belong to the Host's `ctx.schedule`; a chat only chooses to hear them.
 */

import { parseDuration } from './text.ts'

/** A task as a chat sees it. */
export interface ScheduleTask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly status: 'active' | 'paused' | 'ended'
  /** Next occurrence while active, as an ISO time. */
  readonly scheduledAt: string
}

/** When a task runs, in the Host service's own request shape. */
export type ScheduleTimingRequest =
  | { readonly kind: 'after'; readonly after_seconds: number }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: { readonly time: string; readonly time_zone: string } }
  | { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }

/** A task to create. */
export interface NewSchedule {
  readonly title: string
  readonly prompt: string
  readonly timing: ScheduleTimingRequest
}

/** Where a created task's one Session is made. */
export interface ScheduleHome {
  readonly cwd: string
  readonly agentPreset?: string
}

/** The Host's schedule service, as the bridge uses it. */
export interface SchedulePort {
  list(): Promise<ScheduleTask[]>
  create(task: NewSchedule, home: ScheduleHome): Promise<ScheduleTask>
  /** @returns the changed task, or undefined when it is gone. */
  setActive(id: string, active: boolean): Promise<ScheduleTask | undefined>
  /** @returns `busy` while its last delivery still runs. */
  run(id: string): Promise<'started' | 'missing' | 'busy'>
  /** @returns whether the task existed. */
  remove(id: string): Promise<boolean>
}

/** A task's title when a chat gave only its instruction. */
const TITLE_LENGTH = 40
/** The shortest interval the Host accepts. */
const MIN_EVERY_SECONDS = 60
const DAILY_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/u

/**
 * Read what follows `/schedule add`:
 * `daily 09:00 <what>`, `every 30m <what>`, `in 2h <what>`, or `cron <5 fields> <what>`.
 * @param timeZone - the zone wall-clock times are in.
 * @returns the task, or undefined when the text does not parse.
 */
export function parseScheduleAdd(args: string, timeZone: string): NewSchedule | undefined {
  const words = args.trim().split(/\s+/u)
  const kind = words[0]?.toLowerCase()
  const task = (timing: ScheduleTimingRequest, skip: number): NewSchedule | undefined => {
    const prompt = words.slice(skip).join(' ').trim()
    if (prompt === '') return undefined
    const flat = prompt.replace(/\s+/gu, ' ')
    return { title: flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat, prompt, timing }
  }
  if (kind === 'daily') {
    const match = DAILY_TIME.exec(words[1] ?? '')
    if (match === null) return undefined
    return task({ kind: 'daily', daily: { time: `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}:00`, time_zone: timeZone } }, 2)
  }
  if (kind === 'every' || kind === 'in') {
    const ms = parseDuration(words[1] ?? '')
    if (ms === undefined) return undefined
    const seconds = Math.round(ms / 1000)
    if (kind === 'in') return task({ kind: 'after', after_seconds: seconds }, 2)
    return seconds < MIN_EVERY_SECONDS ? undefined : task({ kind: 'every', every_seconds: seconds }, 2)
  }
  if (kind === 'cron') {
    if (words.length < 7) return undefined
    return task({ kind: 'cron', cron: { expression: words.slice(1, 6).join(' '), time_zone: timeZone } }, 6)
  }
  return undefined
}

/**
 * The tasks a delivered reminder came from, read from the framing the Host's
 * schedule service puts around each one.
 * @param text - the text of a message whose source is the schedule.
 */
export function scheduleIdsIn(text: string): string[] {
  const single = /^schedule_id_json: (".*")$/mu.exec(text)?.[1]
  if (single !== undefined) return parsed<string>(single, value => typeof value === 'string' ? [value] : [])
  const batch = /^reminders_json: (\[.*\])$/mu.exec(text)?.[1]
  if (batch === undefined) return []
  return parsed<string>(batch, value => Array.isArray(value)
    ? value.flatMap((item: { schedule_id?: unknown }) => typeof item?.schedule_id === 'string' ? [item.schedule_id] : [])
    : [])
}

function parsed<V>(json: string, read: (value: unknown) => V[]): V[] {
  try {
    return read(JSON.parse(json))
  } catch {
    return []
  }
}
