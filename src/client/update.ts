/**
 * Version check for the browser half.
 *
 * The plugin manager's bundle list says which version is installed, from where,
 * and whether the Plugins page can update it; the Host's update-check route
 * asks GitHub or npm for the newest release.
 *
 * npm installs update through the Plugins page's own dialog: the Host replaces
 * them by removing the bundle first, which unloads this page, so an update
 * started from here could not show its steps or its outcome. The Plugins page
 * does not update GitHub installs, so they reinstall from here at the newest
 * commit (`github:owner/repo#sha`), which pnpm applies in place. A new commit
 * needs its build script allowed once; the manager names the exact keys, and
 * the page asks before passing them back.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import type { UpdateCheck as HostUpdateCheck } from '../version.ts'
import { remotes, type ChangeResult, type PluginManagerRemote } from './remotes.ts'

/** The Host's answer, plus what the plugin manager says about this install. */
export type UpdateCheck = HostUpdateCheck & {
  /** True when the Plugins page shows its own Versions section and update dialog for this bundle. */
  readonly hostUpdates: boolean
}

/** How an update attempt ended. */
export type UpdateOutcome =
  | { kind: 'applied'; version: string }
  | { kind: 'restart'; version: string }
  | { kind: 'approval'; builds: string[] }
  | { kind: 'failed'; message: string }

const CHECK_TTL_MS = 60 * 60 * 1000
let cached: { at: number; value: Promise<UpdateCheck | undefined> } | undefined
const listeners = new Set<(value: UpdateCheck | undefined) => void>()

function pluginManager(_ctx: ClientContext): PluginManagerRemote | undefined {
  return remotes.pluginManager
}

/**
 * Check for a newer release; answers are shared and reused for an hour unless forced.
 * @param ctx - the browser plugin context, for the plugin manager remote.
 * @param name - this bundle's package name.
 * @param force - ask again now.
 */
export function checkForUpdate(ctx: ClientContext, name: string, force = false): Promise<UpdateCheck | undefined> {
  if (!force && cached !== undefined && Date.now() - cached.at < CHECK_TTL_MS) return cached.value
  const value = (async (): Promise<UpdateCheck | undefined> => {
    const manager = pluginManager(ctx)
    const listed = await manager?.listBundles().catch(() => undefined)
    const bundle = listed?.ok === true ? listed.value.find(item => item.name === name) : undefined
    const source = bundle?.source
    const response = await fetch('api/switchboard/update-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(source === undefined ? {} : { source }), force }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { ...await response.json() as HostUpdateCheck, hostUpdates: bundle?.updatable === true }
  })()
  cached = { at: Date.now(), value }
  void value.then(result => { for (const listener of listeners) listener(result) }, () => { cached = undefined })
  return value
}

/**
 * Follow the shared update check from a component; starts one when none is cached.
 * @returns the latest answer, or undefined before the first one.
 */
export function useUpdateCheck(ctx: ClientContext, name: string): UpdateCheck | undefined {
  const [value, setValue] = useState<UpdateCheck | undefined>(undefined)
  useEffect(() => {
    let live = true
    const listener = (next: UpdateCheck | undefined): void => { if (live) setValue(next) }
    listeners.add(listener)
    void checkForUpdate(ctx, name).then(listener, () => {})
    return () => {
      live = false
      listeners.delete(listener)
    }
  }, [ctx, name])
  return value
}

/**
 * Install the newest commit of a GitHub install through the plugin manager.
 * @param ctx - the browser plugin context.
 * @param check - a check that found a newer release.
 * @param approvedBuilds - build-script keys the person allowed after a first attempt asked.
 */
export async function applyUpdate(ctx: ClientContext, check: UpdateCheck, approvedBuilds?: string[]): Promise<UpdateOutcome> {
  const manager = pluginManager(ctx)
  const latest = check.latest
  if (manager === undefined) return { kind: 'failed', message: 'plugin management is not available to this page' }
  if (latest === undefined) return { kind: 'failed', message: 'no newer release' }
  if (check.source.kind !== 'github') return { kind: 'failed', message: 'only GitHub installs update from here' }
  const answer = await manager.installBundle(latest.spec, {
    enabled: true, requestId: crypto.randomUUID(), ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
  })
  if (!answer.ok) return { kind: 'failed', message: answer.error.message }
  const result: ChangeResult = answer.value
  if (result.application === 'applied' || result.application === 'overridden') return { kind: 'applied', version: result.version ?? latest.version }
  if (result.application === 'restart-required') return { kind: 'restart', version: result.version ?? latest.version }
  if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0 && approvedBuilds === undefined) {
    return { kind: 'approval', builds: result.pendingBuilds }
  }
  const output = result.packageResult?.output?.trim().split('\n').slice(-3).join('\n')
  return { kind: 'failed', message: [result.error?.diagnostic ?? result.error?.code ?? result.application, output].filter(Boolean).join('\n') }
}
