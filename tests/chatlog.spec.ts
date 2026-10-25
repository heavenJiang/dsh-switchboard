import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'

let dir: string
let limit: number
let log: ChatLog

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-chatlog-'))
  limit = 100
  log = new ChatLog(dir, () => limit)
})

afterEach(async () => {
  await log.settled()
  await rm(dir, { recursive: true, force: true })
})

describe('ChatLog', () => {
  it('pages history oldest first and reports older entries', async () => {
    for (let i = 0; i < 5; i++) await log.record({ chatId: '1' }, { dir: 'in', kind: 'text', text: `m${i}` })
    const newest = await log.history('1', undefined, 2)
    expect(newest.entries.map(e => e.text)).toEqual(['m3', 'm4'])
    expect(newest.more).toBe(true)
    const older = await log.history('1', newest.entries[0]!.id, 10)
    expect(older.entries.map(e => e.text)).toEqual(['m0', 'm1', 'm2'])
    expect(older.more).toBe(false)
  })

  it('keeps summaries newest first, with titles and denied-only flags', async () => {
    await log.record({ chatId: '1', title: 'Ann', type: 'private', username: 'ann' }, { dir: 'in', kind: 'text', text: 'hi' })
    await log.record({ chatId: '2', title: 'Eve' }, { dir: 'in', kind: 'denied', text: 'let me in' })
    await log.record({ chatId: '2' }, { dir: 'out', kind: 'notice', text: 'not authorized' })
    await log.record({ chatId: '1' }, { dir: 'out', kind: 'assistant', text: 'hello Ann', sessionId: 's1' })
    const chats = await log.chats()
    expect(chats.map(c => [c.chatId, c.title, c.count, c.deniedOnly, c.sessionId ?? null])).toEqual([
      ['1', 'Ann', 2, false, 's1'],
      ['2', 'Eve', 2, true, null],
    ])
    // A fresh instance reads the persisted index.
    await log.settled()
    const reopened = new ChatLog(dir, () => limit)
    expect((await reopened.chats()).map(c => c.chatId)).toEqual(['1', '2'])
  })

  it('trims old entries and drops media nothing references', async () => {
    limit = 100
    const old = await log.saveMedia('1', '.png', new Uint8Array([1]))
    await log.record({ chatId: '1' }, { dir: 'in', kind: 'media', attachments: [{ name: 'a.png', kind: 'image', media: old }] })
    for (let i = 0; i < 125; i++) await log.record({ chatId: '1' }, { dir: 'in', kind: 'text', text: String(i) })
    await log.settled()
    const page = await log.history('1', undefined, 1000)
    expect(page.entries).toHaveLength(100)
    expect(page.entries.at(-1)?.text).toBe('124')
    expect(await readdir(join(dir, '1'))).toEqual([])
  })

  it('serves stored media and refuses path tricks', async () => {
    const name = await log.saveMedia('5', '.jpg', new Uint8Array([9, 9]))
    expect(await log.readMedia('5', name)).toEqual(new Uint8Array([9, 9]))
    expect(await log.readMedia('5', '../index.json')).toBeUndefined()
    expect(await log.readMedia('5', '..')).toBeUndefined()
    expect(await log.readMedia('../5', name)).toBeUndefined()
  })
  it('keeps chats of other lines apart and reads indexes with numeric ids', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), JSON.stringify([{ chatId: 7, title: 'Old', type: 'private', lastAt: 1, lastText: 'x', count: 1, deniedOnly: false }]))
    await writeFile(join(dir, '7.jsonl'), `${JSON.stringify({ id: 'a', at: 1, dir: 'in', kind: 'text', text: 'before lines', from: { id: 7, name: 'Old' } })}\n`)
    await log.record({ chatId: 'feishu:oc_1', title: 'Team' }, { dir: 'in', kind: 'text', text: 'from feishu' })
    expect((await log.chats()).map(c => c.chatId)).toEqual(['feishu:oc_1', '7'])
    expect((await log.history('7', undefined, 10)).entries.map(e => e.text)).toEqual(['before lines'])
    expect((await log.history('feishu:oc_1', undefined, 10)).entries.map(e => e.text)).toEqual(['from feishu'])
    const name = await log.saveMedia('feishu:oc_1', '.png', new Uint8Array([1]))
    expect(await log.readMedia('feishu:oc_1', name)).toEqual(new Uint8Array([1]))
  })
})
