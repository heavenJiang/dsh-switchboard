import { describe, expect, it } from 'vitest'
import { UpdateChecker } from '../src/updates.ts'
import { compareVersions, parseSource } from '../src/version.ts'

describe('parseSource', () => {
  it('recognizes GitHub specs in their common spellings', () => {
    expect(parseSource('github:heavenJiang/dsh-switchboard', 'x')).toEqual({ kind: 'github', owner: 'heavenJiang', repo: 'dsh-switchboard' })
    expect(parseSource('github:a/b#abc123', 'x')).toEqual({ kind: 'github', owner: 'a', repo: 'b', ref: 'abc123' })
    expect(parseSource('git+https://github.com/a/b.git', 'x')).toEqual({ kind: 'github', owner: 'a', repo: 'b' })
  })

  it('treats links and tarballs as local, everything else as npm', () => {
    expect(parseSource('link:/Users/me/dsh-switchboard', 'x').kind).toBe('local')
    expect(parseSource('./pkg-0.1.0.tgz', 'x').kind).toBe('local')
    expect(parseSource('^0.3.0', 'dsh-switchboard')).toEqual({ kind: 'npm', name: 'dsh-switchboard' })
    expect(parseSource(undefined, 'n')).toEqual({ kind: 'unknown' })
    expect(parseSource('https://example.com/x', 'n')).toEqual({ kind: 'unknown' })
  })
})

describe('compareVersions', () => {
  it('orders numeric cores and prereleases', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })
})

describe('UpdateChecker', () => {
  const respond = (routes: Record<string, unknown>): typeof fetch => async (input) => {
    const url = String(input)
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    return hit === undefined ? new Response('no', { status: 404 }) : Response.json(hit[1])
  }

  it('reads the GitHub head commit and the version it declares', async () => {
    const checker = new UpdateChecker(respond({
      'https://api.github.com/repos/a/b/commits/HEAD': { sha: 'f00d', commit: { message: 'feat: x\n\nbody', committer: { date: '2026-10-24T00:00:00Z' } } },
      'https://raw.githubusercontent.com/a/b/f00d/package.json': { version: '99.0.0' },
    }))
    const result = await checker.check('github:a/b')
    expect(result.newer).toBe(true)
    expect(result.latest).toMatchObject({ version: '99.0.0', commit: 'f00d', summary: 'feat: x', spec: 'github:a/b#f00d' })
  })

  it('falls back to the next npm registry', async () => {
    const checker = new UpdateChecker(respond({ 'https://registry.npmmirror.com/dsh-switchboard/latest': { version: '0.0.1' } }))
    const result = await checker.check('^0.0.1')
    expect(result.latest?.spec).toBe('dsh-switchboard@0.0.1')
    expect(result.newer).toBe(false)
  })

  it('checks nothing when the install source is unknown', async () => {
    let calls = 0
    const checker = new UpdateChecker(async () => { calls++; return Response.json({ version: '99.0.0' }) })
    const result = await checker.check(undefined)
    expect(result).toMatchObject({ newer: false, source: { kind: 'unknown' } })
    expect(calls).toBe(0)
  })

  it('reports failures without caching them', async () => {
    let calls = 0
    const checker = new UpdateChecker(async () => { calls++; return new Response('down', { status: 503 }) })
    expect((await checker.check('github:a/b')).error).toContain('503')
    await checker.check('github:a/b')
    expect(calls).toBe(2)
  })
})
