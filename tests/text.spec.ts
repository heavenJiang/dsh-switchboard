import { describe, expect, it } from 'vitest'
import { incomingAttachments, outgoingKind, safeName } from '../src/media.ts'
import { chunkText, isAllowed, parseInput, previewArguments } from '../src/text.ts'

describe('parseInput', () => {
  it('splits commands and arguments', () => {
    expect(parseInput('/new /tmp/x')).toEqual({ kind: 'command', name: 'new', args: '/tmp/x' })
    expect(parseInput('/STOP')).toEqual({ kind: 'command', name: 'stop', args: '' })
  })

  it('accepts commands addressed to this bot and ignores other bots', () => {
    expect(parseInput('/status@MyBot', 'mybot')).toEqual({ kind: 'command', name: 'status', args: '' })
    expect(parseInput('/status@OtherBot', 'mybot')).toBeUndefined()
  })

  it('treats everything else as a prompt', () => {
    expect(parseInput('  fix the build  ')).toEqual({ kind: 'text', text: 'fix the build' })
    expect(parseInput('/etc/hosts is broken')).toEqual({ kind: 'text', text: '/etc/hosts is broken' })
    expect(parseInput('   ')).toBeUndefined()
  })
})

describe('isAllowed', () => {
  it('admits no one with an empty list', () => {
    expect(isAllowed([], 1)).toBe(false)
  })

  it('matches ids and case-insensitive usernames', () => {
    expect(isAllowed(['42'], 42)).toBe(true)
    expect(isAllowed(['@Alice'], 7, 'alice')).toBe(true)
    expect(isAllowed(['@alice'], 7)).toBe(false)
  })
})

describe('chunkText', () => {
  it('keeps short text whole', () => {
    expect(chunkText('hello')).toEqual(['hello'])
  })

  it('splits on paragraph boundaries within the limit', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`
    const chunks = chunkText(text, 100)
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })

  it('hard-splits text with no boundary', () => {
    const chunks = chunkText('x'.repeat(250), 100)
    expect(chunks.map(c => c.length)).toEqual([100, 100, 50])
  })
})

describe('previewArguments', () => {
  it('prefers the command field of shell-like tools', () => {
    expect(previewArguments('{"command":"ls -la","timeout":5}', 100)).toBe('command: ls -la')
  })

  it('truncates long values', () => {
    expect(previewArguments(JSON.stringify({ x: 'y'.repeat(50) }), 10)).toHaveLength(10)
  })
})

describe('media helpers', () => {
  it('skips animated stickers and keeps static ones as webp', () => {
    const base = { message_id: 1, chat: { id: 1, type: 'private' as const }, date: 0 }
    expect(incomingAttachments({ ...base, sticker: { file_id: 's', file_unique_id: 's', is_animated: true } })).toEqual([])
    expect(incomingAttachments({ ...base, sticker: { file_id: 's', file_unique_id: 's' } })[0]?.mediaType).toBe('image/webp')
  })

  it('sends small non-GIF images as photos', () => {
    expect(outgoingKind('/a/b.PNG', 100)).toBe('photo')
    expect(outgoingKind('/a/b.gif', 100)).toBe('document')
    expect(outgoingKind('/a/b.jpg', 11 * 1024 * 1024)).toBe('document')
    expect(outgoingKind('/a/b.pdf', 100)).toBe('document')
  })

  it('strips paths from sender file names', () => {
    expect(safeName('..\\..\\x.txt')).toBe('x.txt')
    expect(safeName('..')).toBe('file')
  })
})
