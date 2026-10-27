/**
 * Create (or extend) a Feishu app by scanning a QR code: the Open Platform's
 * device-code registration, as the official SDK's `registerApp` runs it. The
 * QR opens a confirmation page in Feishu with the bot capability, the
 * permissions, the message event, and the card callback already filled in;
 * once the scanner confirms, polling returns the app id and secret and the
 * scanner's open_id. Runs on the Host, so the secret never reaches a browser.
 */

import { gzipSync } from 'node:zlib'

/** Permissions the switchboard uses; extra ones only show names. */
export const FEISHU_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  // Downloading images and files from messages needs the general read scope.
  'im:message:readonly',
  'im:message:send_as_bot',
  // Marks a message as being worked on.
  'im:message.reactions:write_only',
  'im:resource',
  'contact:user.base:readonly',
  'im:chat:readonly',
] as const

const ACCOUNTS = { feishu: 'https://accounts.feishu.cn', lark: 'https://accounts.larksuite.com' } as const
const ENDPOINT = '/oauth/v1/app/registration'
const SLOW_DOWN_MS = 5000
/** Polls are never closer than this, whatever the server suggests. */
const POLL_FLOOR_MS = 1000

/** What a registration reports while and after it runs. */
export type RegistrationStatus =
  | { readonly state: 'waiting'; readonly url: string; readonly expiresAt: number }
  | { readonly state: 'done'; readonly appId: string; readonly domain: 'feishu' | 'lark'; readonly ownerOpenId?: string }
  | { readonly state: 'failed'; readonly error: string }
  | { readonly state: 'expired' }
  | { readonly state: 'cancelled' }

export interface RegistrationRequest {
  readonly domain: 'feishu' | 'lark'
  /** Extend this existing app (missing permissions, event, callback) instead of creating one. */
  readonly appId?: string
  /** Name and description offered for a new app; `{user}` becomes the scanner's name. */
  readonly appName?: string
  readonly appDescription?: string
  /** Receives the secret once; the status never carries it. */
  readonly onSecret: (appId: string, secret: string) => Promise<void>
  readonly fetch?: typeof fetch
  /** Shortest wait between polls; tests shorten it. */
  readonly pollFloorMs?: number
}

/** Encode the confirmation page's pre-filled items the way the page reads them. */
export function encodeAddons(): string {
  const addons = {
    preset: false,
    scopes: { tenant: [...FEISHU_SCOPES] },
    events: { items: { tenant: ['im.message.receive_v1'] } },
    callbacks: { items: ['card.action.trigger'] },
  }
  return gzipSync(Buffer.from(JSON.stringify(addons), 'utf8')).toString('base64')
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/** One registration run. */
export class FeishuRegistration {
  private current: RegistrationStatus = { state: 'waiting', url: '', expiresAt: 0 }
  private readonly controller = new AbortController()
  private readonly fetchImpl: typeof fetch

  constructor(private readonly request: RegistrationRequest) {
    this.fetchImpl = request.fetch ?? fetch
  }

  /** The latest status. */
  status(): RegistrationStatus {
    return this.current
  }

  cancel(): void {
    if (this.current.state === 'waiting') this.current = { state: 'cancelled' }
    this.controller.abort()
  }

  /**
   * Ask for a device code and resolve with the QR link; polling continues in the background.
   * @throws when the Open Platform refuses to start.
   */
  async start(): Promise<RegistrationStatus> {
    let base: string = ACCOUNTS[this.request.domain]
    const begin = await this.call(base, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })
    const link = typeof begin['verification_uri_complete'] === 'string' ? begin['verification_uri_complete'] : undefined
    const deviceCode = typeof begin['device_code'] === 'string' ? begin['device_code'] : undefined
    if (link === undefined || deviceCode === undefined) throw new Error(`feishu registration did not start: ${describeAnswer(begin)}`)
    const url = new URL(link)
    url.searchParams.set('from', 'sdk')
    url.searchParams.set('tp', 'sdk')
    url.searchParams.set('source', 'dsh-switchboard')
    url.searchParams.set('addons', encodeAddons())
    if (this.request.appId === undefined) {
      url.searchParams.set('createOnly', 'true')
      if (this.request.appName !== undefined) url.searchParams.set('name', this.request.appName)
      if (this.request.appDescription !== undefined) url.searchParams.set('desc', this.request.appDescription)
    } else {
      url.searchParams.set('clientID', this.request.appId)
    }
    const expiresIn = Number(begin['expires_in'] ?? 600) * 1000
    this.current = { state: 'waiting', url: url.toString(), expiresAt: Date.now() + expiresIn }
    const floor = this.request.pollFloorMs ?? POLL_FLOOR_MS
    const suggested = (): number => Math.max(floor, Number(begin['interval'] ?? 5) * 1000)
    let interval = suggested()
    let domain = this.request.domain
    void (async () => {
      const signal = this.controller.signal
      const deadline = Date.now() + expiresIn
      while (!signal.aborted) {
        await wait(interval, signal)
        if (signal.aborted) return
        if (Date.now() > deadline) {
          this.current = { state: 'expired' }
          return
        }
        let answer: Record<string, unknown>
        try {
          answer = await this.call(base, { action: 'poll', device_code: deviceCode })
        } catch {
          // A network hiccup: keep polling until the code expires.
          continue
        }
        const user = answer['user_info'] as { open_id?: string; tenant_brand?: string } | undefined
        if (user?.tenant_brand === 'lark' && domain !== 'lark') {
          // A Lark tenant scanned a Feishu code: continue on the Lark host.
          domain = 'lark'
          base = ACCOUNTS.lark
          continue
        }
        interval = suggested()
        const appId = answer['client_id']
        const secret = answer['client_secret']
        if (typeof appId === 'string' && typeof secret === 'string' && appId !== '' && secret !== '') {
          try {
            await this.request.onSecret(appId, secret)
            this.current = { state: 'done', appId, domain, ...(user?.open_id === undefined ? {} : { ownerOpenId: user.open_id }) }
          } catch (error: unknown) {
            this.current = { state: 'failed', error: `could not store the app secret: ${error instanceof Error ? error.message : String(error)}` }
          }
          return
        }
        const error = answer['error']
        if (error === 'authorization_pending') continue
        if (error === 'slow_down') {
          interval += SLOW_DOWN_MS
          continue
        }
        if (error === 'expired_token') {
          this.current = { state: 'expired' }
          return
        }
        if (typeof error === 'string') {
          this.current = { state: 'failed', error: error === 'access_denied' ? 'access_denied' : describeAnswer(answer) }
          return
        }
      }
    })()
    return this.current
  }

  /** One form post; pending and error answers come with HTTP 400 and are returned as data. */
  private async call(base: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${base}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: this.controller.signal,
    })
    try {
      return await response.json() as Record<string, unknown>
    } catch {
      throw new Error(`feishu registration: HTTP ${response.status}`)
    }
  }
}

function describeAnswer(answer: Record<string, unknown>): string {
  const error = answer['error'] ?? answer['code'] ?? 'unknown'
  const detail = answer['error_description'] ?? answer['msg'] ?? ''
  return `${String(error)}${detail === '' ? '' : `: ${String(detail)}`}`
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Runs kept for status polls; finished ones are forgotten after a while. */
const KEEP_MS = 15 * 60 * 1000
const MAX_RUNS = 8

/** The Host's registration runs, by id, for the settings page to start, poll, and cancel. */
export class RegistrationDesk {
  private readonly runs = new Map<string, { run: FeishuRegistration; at: number }>()
  private seq = 0

  /**
   * @param store - writes an app secret under a credential reference.
   */
  constructor(
    private readonly store: (ref: string, secret: string) => Promise<void>,
    private readonly fetchImpl?: typeof fetch,
    private readonly pollFloorMs?: number,
  ) {}

  async start(options: { domain: 'feishu' | 'lark'; secretRef: string; appId?: string; appName?: string; appDescription?: string }): Promise<{ id: string; status: RegistrationStatus }> {
    const now = Date.now()
    for (const [id, entry] of this.runs) if (now - entry.at > KEEP_MS) this.runs.delete(id)
    while (this.runs.size >= MAX_RUNS) {
      const [oldest] = this.runs.keys()
      this.runs.get(oldest!)?.run.cancel()
      this.runs.delete(oldest!)
    }
    const run = new FeishuRegistration({
      domain: options.domain,
      ...(options.appId === undefined ? {} : { appId: options.appId }),
      ...(options.appName === undefined ? {} : { appName: options.appName }),
      ...(options.appDescription === undefined ? {} : { appDescription: options.appDescription }),
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      ...(this.pollFloorMs === undefined ? {} : { pollFloorMs: this.pollFloorMs }),
      onSecret: (_appId, secret) => this.store(options.secretRef, secret),
    })
    const id = `r${now.toString(36)}${(this.seq++).toString(36)}`
    this.runs.set(id, { run, at: now })
    return { id, status: await run.start() }
  }

  status(id: string): RegistrationStatus | undefined {
    return this.runs.get(id)?.run.status()
  }

  cancel(id: string): void {
    this.runs.get(id)?.run.cancel()
  }

  /** Stop every run (plugin unload). */
  dispose(): void {
    for (const entry of this.runs.values()) entry.run.cancel()
    this.runs.clear()
  }
}
