/**
 * Host-side update check: asks GitHub or the npm registry for the newest
 * release of the installed bundle. Requests go through Node's fetch, so the
 * launcher's proxy policy applies.
 */

import { readFile } from 'node:fs/promises'
import { compareVersions, parseSource, type LatestRelease, type UpdateCheck } from './version.ts'

/** Registries asked in order for npm installs. */
const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
/** Answers are reused this long so the GitHub API's anonymous limit is never a concern. */
const CACHE_MS = 10 * 60 * 1000
const TIMEOUT_MS = 10_000

/** Name and version of the running copy, from its own package.json. */
export async function installedPackage(): Promise<{ name: string; version: string }> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
  return { name: manifest.name, version: manifest.version }
}

/** Update checks keyed by source spec, with a short-lived cache. */
export class UpdateChecker {
  private cache = new Map<string, { at: number; value: Promise<UpdateCheck> }>()

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Find the newest release for an installed copy.
   * @param spec - the profile dependency spec (from the plugin manager's bundle list).
   * @param force - skip the cache.
   */
  check(spec: string | undefined, force = false): Promise<UpdateCheck> {
    const key = spec ?? ''
    const hit = this.cache.get(key)
    if (!force && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value
    const value = this.run(spec)
    this.cache.set(key, { at: Date.now(), value })
    // A failed check is retried on the next request instead of being cached.
    void value.then((result) => { if (result.error !== undefined) this.cache.delete(key) })
    return value
  }

  private async run(spec: string | undefined): Promise<UpdateCheck> {
    const { name, version } = await installedPackage()
    const source = parseSource(spec, name)
    const base = { installed: version, source, checkedAt: Date.now() }
    try {
      let latest: LatestRelease | undefined
      if (source.kind === 'github') latest = await this.github(source.owner, source.repo)
      else if (source.kind === 'npm') latest = await this.npm(source.name)
      return latest === undefined
        ? { ...base, newer: false }
        : { ...base, latest, newer: compareVersions(latest.version, version) > 0 }
    } catch (error: unknown) {
      return { ...base, newer: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`)
    return await response.json() as T
  }

  /** The default branch head, and the version its package.json declares. */
  private async github(owner: string, repo: string): Promise<LatestRelease> {
    const api = `https://api.github.com/repos/${owner}/${repo}`
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-telegram-bridge' }
    const head = await this.json<{ sha: string; commit: { message: string; committer?: { date?: string } } }>(`${api}/commits/HEAD`, headers)
    const manifest = await this.json<{ version?: string }>(`https://raw.githubusercontent.com/${owner}/${repo}/${head.sha}/package.json`)
    if (typeof manifest.version !== 'string') throw new Error('the repository package.json declares no version')
    const date = head.commit.committer?.date
    return {
      version: manifest.version,
      commit: head.sha,
      ...(date === undefined ? {} : { date }),
      summary: head.commit.message.split('\n', 1)[0] ?? '',
      url: `https://github.com/${owner}/${repo}/commits/${head.sha}`,
      spec: `github:${owner}/${repo}#${head.sha}`,
    }
  }

  private async npm(name: string): Promise<LatestRelease> {
    let failure: unknown
    for (const registry of NPM_REGISTRIES) {
      try {
        const latest = await this.json<{ version: string }>(`${registry}/${name}/latest`)
        return { version: latest.version, url: `https://www.npmjs.com/package/${name}/v/${latest.version}`, spec: `${name}@${latest.version}` }
      } catch (error: unknown) {
        failure = error
      }
    }
    throw failure instanceof Error ? failure : new Error('no registry answered')
  }
}
