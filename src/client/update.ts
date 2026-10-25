/**
 * Version check and self-update for the browser half.
 *
 * The plugin manager's bundle list says which version is installed and from
 * where; the Host's update-check route asks GitHub or npm for the newest
 * release. Updating goes through the plugin manager itself: npm installs use
 * its own `updateBundle` (the Plugins page's update path); GitHub installs
 * reinstall at the newest commit (`github:owner/repo#sha`), which pnpm applies
 * in place. A new commit needs its build script allowed once; the manager
 * names the exact keys, and the page asks before passing them back.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import type { UpdateCheck } from '../version.ts'
import { remotes, type ChangeResult, type PluginManagerRemote } from './remotes.ts'

export type { UpdateCheck } from '../version.ts'

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
    const source = listed?.ok === true ? listed.value.find(bundle => bundle.name === name)?.source : undefined
    const response = await fetch('api/switchboard/update-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(source === undefined ? {} : { source }), force }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as UpdateCheck
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
 * Install the newest release through the plugin manager.
 * @param ctx - the browser plugin context.
 * @param check - a check that found a newer release.
 * @param approvedBuilds - build-script keys the person allowed after a first attempt asked.
 */
export async function applyUpdate(ctx: ClientContext, check: UpdateCheck, approvedBuilds?: string[]): Promise<UpdateOutcome> {
  const manager = pluginManager(ctx)
  const latest = check.latest
  if (manager === undefined) return { kind: 'failed', message: 'plugin management is not available to this page' }
  if (latest === undefined) return { kind: 'failed', message: 'no newer release' }
  const requestId = crypto.randomUUID()
  let result: ChangeResult
  if (check.source.kind === 'npm') {
    const answer = await manager.updateBundle(check.source.name, latest.version, { requestId })
    if (!answer.ok) return { kind: 'failed', message: answer.error.message }
    result = answer.value.result
  } else if (check.source.kind === 'github') {
    const answer = await manager.installBundle(latest.spec, {
      enabled: true, requestId, ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
    })
    if (!answer.ok) return { kind: 'failed', message: answer.error.message }
    result = answer.value
  } else {
    return { kind: 'failed', message: 'the install source is not GitHub or npm, so it cannot be updated from here' }
  }
  if (result.application === 'applied' || result.application === 'overridden') return { kind: 'applied', version: result.version ?? latest.version }
  if (result.application === 'restart-required') return { kind: 'restart', version: result.version ?? latest.version }
  if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0 && approvedBuilds === undefined) {
    return { kind: 'approval', builds: result.pendingBuilds }
  }
  const output = result.packageResult?.output?.trim().split('\n').slice(-3).join('\n')
  return { kind: 'failed', message: [result.error?.diagnostic ?? result.error?.code ?? result.application, output].filter(Boolean).join('\n') }
}
