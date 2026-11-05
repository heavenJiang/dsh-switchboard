/**
 * Remote namespaces this page uses, followed while this client may call them.
 * They are injected only for peers with access (the owner), so nothing else
 * in the plugin waits on them.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Remote answers carry either a value or an error. */
export type RemoteResult<V> = { ok: true; value: V } | { ok: false; error: { message: string } }

/** The plugin manager remote namespace, as far as this page uses it. */
export interface PluginManagerRemote {
  /** `updatable` is absent on a Host whose Plugins page has no update dialog. */
  listBundles(): Promise<RemoteResult<{ name: string; version?: string; source?: string; installed: boolean; updatable?: boolean }[]>>
}

/** The credentials remote namespace, as far as this page uses it. */
export interface CredentialsRemote {
  describe(refs: string[]): Promise<RemoteResult<Record<string, { configured: boolean; writable: boolean }>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
}

/** Live references; undefined while the namespace is not available. */
export const remotes: { pluginManager?: PluginManagerRemote; credentials?: CredentialsRemote } = {}

/**
 * Follow the namespaces' availability for the plugin's lifetime.
 * @param ctx - the browser plugin context.
 */
export function trackRemotes(ctx: ClientContext): void {
  ctx.inject(['remote', 'remote.pluginManager'], (scope) => {
    remotes.pluginManager = (scope as unknown as { remote: { pluginManager: PluginManagerRemote } }).remote.pluginManager
    scope.effect(() => () => { delete remotes.pluginManager }, 'switchboard: plugin manager remote')
  })
  ctx.inject(['remote', 'remote.credentials'], (scope) => {
    remotes.credentials = (scope as unknown as { remote: { credentials: CredentialsRemote } }).remote.credentials
    scope.effect(() => () => { delete remotes.credentials }, 'switchboard: credentials remote')
  })
}
