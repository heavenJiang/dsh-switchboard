import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultStateFile, migrateLegacyStateDir } from '../src/bindings.ts'

let home: string
let saved: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'switchboard-home-'))
  saved = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (saved === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = saved
  await rm(home, { recursive: true, force: true })
})

describe('migrateLegacyStateDir', () => {
  it('moves the telegram-bridge directory to switchboard', async () => {
    await mkdir(join(home, 'telegram-bridge', 'chats'), { recursive: true })
    await writeFile(join(home, 'telegram-bridge', 'state.json'), '{"version":1,"offset":7,"chats":{}}')
    expect(await migrateLegacyStateDir()).toBe(true)
    expect(defaultStateFile()).toBe(join(home, 'switchboard', 'state.json'))
    expect(await readFile(defaultStateFile(), 'utf8')).toContain('"offset":7')
  })

  it('leaves an existing switchboard directory alone', async () => {
    await mkdir(join(home, 'telegram-bridge'), { recursive: true })
    await mkdir(join(home, 'switchboard'), { recursive: true })
    expect(await migrateLegacyStateDir()).toBe(false)
  })

  it('does nothing without legacy data', async () => {
    expect(await migrateLegacyStateDir()).toBe(false)
  })
})
