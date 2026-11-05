import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, type UpdateCheck } from '../src/client/update.ts'
import { remotes, type ChangeResult, type PluginManagerRemote } from '../src/client/remotes.ts'

// The Host's page supplies React; applyUpdate uses none of it.
vi.mock('react', () => ({ useEffect: () => {}, useState: () => [] }))

const ctx = {} as Parameters<typeof applyUpdate>[0]
const latest = { version: '0.6.0', url: 'https://example.test', spec: 'github:a/b#abc' }
const github: UpdateCheck = { installed: '0.5.0', source: { kind: 'github', owner: 'a', repo: 'b' }, latest, newer: true, checkedAt: 0, hostUpdates: false }

/** A plugin manager that answers every install with `results`, in order, and records the calls. */
function manager(...results: ChangeResult[]): { spec: string; options: Record<string, unknown> }[] {
  const calls: { spec: string; options: Record<string, unknown> }[] = []
  remotes.pluginManager = {
    listBundles: async () => ({ ok: true, value: [] }),
    installBundle: async (spec, options) => {
      calls.push({ spec, options })
      return { ok: true, value: results.shift()! }
    },
  } satisfies PluginManagerRemote
  return calls
}

afterEach(() => { delete remotes.pluginManager })

describe('applyUpdate', () => {
  it('reinstalls a GitHub install at the newest commit, keeping it enabled', async () => {
    const calls = manager({ application: 'applied', version: '0.6.0' })
    await expect(applyUpdate(ctx, github)).resolves.toEqual({ kind: 'applied', version: '0.6.0' })
    expect(calls[0]).toMatchObject({ spec: 'github:a/b#abc', options: { enabled: true } })
  })

  it('asks before allowing a build script, then passes the keys back', async () => {
    const calls = manager({ application: 'failed', pendingBuilds: ['dsh-switchboard@x'] }, { application: 'applied' })
    await expect(applyUpdate(ctx, github)).resolves.toEqual({ kind: 'approval', builds: ['dsh-switchboard@x'] })
    await expect(applyUpdate(ctx, github, ['dsh-switchboard@x'])).resolves.toEqual({ kind: 'applied', version: '0.6.0' })
    expect(calls[1]?.options['approvedBuilds']).toEqual(['dsh-switchboard@x'])
  })

  it('reports a restart and the failure pnpm gave', async () => {
    manager({ application: 'restart-required' }, { application: 'failed', error: { code: 'operation-error', diagnostic: 'nope' } })
    await expect(applyUpdate(ctx, github)).resolves.toEqual({ kind: 'restart', version: '0.6.0' })
    await expect(applyUpdate(ctx, github)).resolves.toEqual({ kind: 'failed', message: 'nope' })
  })

  it('never installs anything for an npm install, which the Plugins page updates', async () => {
    const calls = manager()
    const outcome = await applyUpdate(ctx, { ...github, source: { kind: 'npm', name: 'b' } })
    expect(outcome.kind).toBe('failed')
    expect(calls).toEqual([])
  })
})
