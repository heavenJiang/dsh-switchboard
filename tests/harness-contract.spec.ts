/**
 * What this plugin assumes about the Host, checked against the real code of a
 * sibling deepseek-harness checkout rather than against the fakes.
 */

import { describe, expect, it } from 'vitest'
import { parseScheduleAdd, scheduleIdsIn } from '../src/schedules.ts'

const enabled = process.env['DSH_HARNESS_CHECKOUT'] !== ''
const packages = '../../deepseek-harness/packages'

describe.skipIf(!enabled)('the Host contract', () => {
  it('reads the ids out of the reminders the schedule service really writes', async () => {
    const { renderReminderFraming, renderRecurringReminderBatchFraming } = await import(/* @vite-ignore */ `${packages}/schedule/schedule/src/domain.ts`)
    const record = { id: 'schedule-1', prompt: 'say "hi"\nthen stop', scheduledAt: '2030-01-01T00:00:00.000Z' }
    expect(scheduleIdsIn(renderReminderFraming(record))).toEqual(['schedule-1'])
    const batch = renderRecurringReminderBatchFraming([
      { record, occurrenceAt: record.scheduledAt },
      { record: { ...record, id: 'schedule-2' }, occurrenceAt: record.scheduledAt },
    ])
    expect(scheduleIdsIn(batch)).toEqual(['schedule-1', 'schedule-2'])
  })

  it('has every timing a chat can write accepted by the schedule service', async () => {
    const { createScheduleRecord } = await import(/* @vite-ignore */ `${packages}/schedule/schedule/src/update.ts`)
    for (const text of ['daily 9:05 x', 'every 30m x', 'in 2h x', 'cron 0 9 * * 1-5 x']) {
      const task = parseScheduleAdd(text, 'Asia/Shanghai')!
      const record = createScheduleRecord('schedule-1', task.title, task.prompt, task.timing, Date.now())
      expect(record.prompt).toBe('x')
    }
  })
})
