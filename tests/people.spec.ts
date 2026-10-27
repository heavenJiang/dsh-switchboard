import { describe, expect, it } from 'vitest'
import { actorFor, mayRunCommand, mayUse } from '../src/people.ts'

describe('people', () => {
  const people = [
    { line: 'telegram', id: '42', role: 'member' as const, preset: 'workspace-write', dirs: ['/work/app'] },
    { line: 'telegram', id: '@eve', role: 'guest' as const },
  ]

  it('treats anyone unlisted as an admin, and chat-admitted people as members', () => {
    expect(actorFor(people, 'telegram', ['7'], false, '/home')).toEqual({ role: 'admin' })
    expect(actorFor(people, 'telegram', ['7'], true, '/home')).toEqual({ role: 'member', preset: 'workspace-write', dirs: ['/home'] })
    // Records belong to their line.
    expect(actorFor(people, 'feishu', ['42'], false, '/home')).toEqual({ role: 'admin' })
  })

  it('applies a record by id or @username', () => {
    expect(actorFor(people, 'telegram', ['42'], false, '/home')).toEqual({ role: 'member', preset: 'workspace-write', dirs: ['/work/app'] })
    expect(actorFor(people, 'telegram', ['9', '@Eve'], false, '/home')).toEqual({ role: 'guest', preset: 'read-only', dirs: ['/home'] })
  })

  it('keeps members to their directories, without prefix tricks', () => {
    const member = { role: 'member' as const, dirs: ['/work/app'] }
    expect(mayUse(member, '/work/app')).toBe(true)
    expect(mayUse(member, '/work/app/src')).toBe(true)
    expect(mayUse(member, '/work/app-secret')).toBe(false)
    expect(mayUse(member, '/work/app/../other')).toBe(false)
    expect(mayUse(member, undefined)).toBe(false)
    expect(mayUse({ role: 'admin' }, '/anywhere')).toBe(true)
  })

  it('keeps permission-changing Harness commands to admins', () => {
    expect(mayRunCommand({ role: 'member' }, 'compact')).toBe(true)
    expect(mayRunCommand({ role: 'member' }, 'permission')).toBe(false)
    expect(mayRunCommand({ role: 'guest' }, 'compact')).toBe(false)
    expect(mayRunCommand({ role: 'admin' }, 'permission')).toBe(true)
  })
})
