/**
 * Version facts shared by the Host update check and the browser half. No
 * Node imports: the browser half bundles this file.
 */

/** Where the installed copy came from, read from the profile dependency spec. */
export type InstallSource =
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string; readonly ref?: string }
  | { readonly kind: 'npm'; readonly name: string }
  | { readonly kind: 'local'; readonly spec: string }
  /** No dependency spec was available; nothing is checked or installed. */
  | { readonly kind: 'unknown' }

/** The newest release the check found. */
export interface LatestRelease {
  readonly version: string
  /** Commit the release points at (GitHub installs). */
  readonly commit?: string
  readonly date?: string
  /** First line of the commit message (GitHub installs). */
  readonly summary?: string
  /** Page describing the release. */
  readonly url: string
  /** Spec that installs exactly this release. */
  readonly spec: string
}

/** What the update check answers. */
export interface UpdateCheck {
  readonly installed: string
  readonly source: InstallSource
  readonly latest?: LatestRelease
  /** True when `latest` is a newer version than `installed`. */
  readonly newer: boolean
  readonly checkedAt: number
  readonly error?: string
}

/**
 * Classify a profile dependency spec.
 * @param spec - the saved dependency spec, such as `github:owner/repo#ref`, `^0.3.0`, or `link:/path`.
 * @param name - the package name, for registry specs.
 */
export function parseSource(spec: string | undefined, name: string): InstallSource {
  const value = (spec ?? '').trim()
  // Guessing a registry name could fetch an unrelated package that happens to share it.
  if (value === '') return { kind: 'unknown' }
  const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/u.exec(value)
  if (github !== null) {
    const [, owner = '', repo = '', ref] = github
    return { kind: 'github', owner, repo, ...(ref === undefined ? {} : { ref }) }
  }
  if (/^(link:|file:|\/|\.)/u.test(value) || value.endsWith('.tgz')) return { kind: 'local', spec: value }
  // Only a version or range saved under the package's own name is a registry install.
  if (/^(npm:)?[\^~<>=v\d*x\s|.-]+$/u.test(value) || value === 'latest') return { kind: 'npm', name }
  return { kind: 'unknown' }
}

/**
 * Compare two semver strings (numeric core, then prerelease identifiers).
 * @returns positive when `a` is newer, negative when older, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string[]] => {
    const [core = '', pre] = v.trim().replace(/^v/u, '').split('+', 1)[0]!.split(/-(.*)/su)
    return [core.split('.').map(n => Number.parseInt(n, 10) || 0), pre === undefined || pre === '' ? [] : pre.split('.')]
  }
  const [ca, pa] = split(a)
  const [cb, pb] = split(b)
  for (let i = 0; i < Math.max(ca.length, cb.length, 3); i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0)
    if (d !== 0) return d
  }
  // A release outranks its prereleases.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/u.test(x)
    const ny = /^\d+$/u.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
