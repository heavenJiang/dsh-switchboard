import { describe, expect, it } from 'vitest'
import { parseScheduleAdd, scheduleIdsIn } from '../src/schedules.ts'
import { parseDuration } from '../src/text.ts'

const ZONE = 'Asia/Shanghai'

describe('parseDuration', () => {
  it('reads spans, with bare numbers as minutes', () => {
    expect(parseDuration('45s')).toBe(45_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('2H')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('90')).toBe(5_400_000)
  })

  it('refuses nonsense, zero, and anything past 30 days', () => {
    for (const text of ['', 'soon', '2w', '-1h', '0m', '31d', '1.5h']) expect(parseDuration(text)).toBeUndefined()
  })
})

describe('parseScheduleAdd', () => {
  it('reads each kind of timing', () => {
    expect(parseScheduleAdd('daily 9:05 check it', ZONE)?.timing).toEqual({ kind: 'daily', daily: { time: '09:05:00', time_zone: ZONE } })
    expect(parseScheduleAdd('every 30m check it', ZONE)?.timing).toEqual({ kind: 'every', every_seconds: 1800 })
    expect(parseScheduleAdd('in 2h check it', ZONE)?.timing).toEqual({ kind: 'after', after_seconds: 7200 })
    expect(parseScheduleAdd('cron 0 9 * * 1-5 check it', ZONE)).toMatchObject({ prompt: 'check it', timing: { kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: ZONE } } })
  })

  it('shortens a long instruction into the title only', () => {
    const prompt = 'x'.repeat(100)
    const task = parseScheduleAdd(`in 5m ${prompt}`, ZONE)
    expect(task?.prompt).toBe(prompt)
    expect(task?.title.length).toBeLessThanOrEqual(40)
  })

  it('refuses what the Host would, and what has no instruction', () => {
    for (const text of ['', 'daily 25:00 x', 'daily 09:00', 'every 30s x', 'in soon x', 'cron 0 9 * * x', 'weekly 1 x']) {
      expect(parseScheduleAdd(text, ZONE)).toBeUndefined()
    }
  })
})

describe('scheduleIdsIn', () => {
  it('ignores text without the framing, or with broken framing', () => {
    expect(scheduleIdsIn('hello')).toEqual([])
    expect(scheduleIdsIn('schedule_id_json: "unterminated')).toEqual([])
    expect(scheduleIdsIn('reminders_json: [oops]')).toEqual([])
  })
})
