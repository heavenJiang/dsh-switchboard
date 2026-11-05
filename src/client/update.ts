/**
 * Version check for the browser half.
 *
 * The plugin manager's bundle list says which version is installed, from where,
 * and whether the Plugins page can update it; the Host's update-check route
 * asks GitHub or npm for the newest release.
 *
 * Updating is left to the Plugins page's own dialog. The Host replaces a bundle
 * by removing it and installing the new version, which unloads this page, so an
 * update started from here could not show its steps or its outcome. It also
 * refuses to install over an installed package, so there is no in-place path.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import type { UpdateCheck as HostUpdateCheck } from '../version.ts'
import { remotes, type PluginManagerRemote } from './remotes.ts'

/** The Host's answer, plus what the plugin manager says about this install. */
export type UpdateCheck = HostUpdateCheck & {
  /** True when the Plugins page shows its own Versions section and update dialog for this bundle. */
  readonly hostUpdates: boolean
}

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
