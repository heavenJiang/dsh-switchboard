import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FEISHU_SCOPES, RegistrationDesk, encodeAddons } from '../src/channels/feishu-register.ts'

/** Accounts endpoint stand-in: begin, then pending polls, then the given final answer. */
function accounts(final: Record<string, unknown>, options: { pending?: number; larkFirst?: boolean } = {}) {
  const calls: { host: string; form: Record<string, string> }[] = []
  let polls = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
    calls.push({ host: url.host, form })
    if (form['action'] === 'begin') {
      return Response.json({ device_code: 'dev-1', verification_uri_complete: 'https://accounts.feishu.cn/page/register?code=abc', expires_in: 600, interval: 0 })
    }
    polls++
    if (options.larkFirst === true && url.host === 'accounts.feishu.cn') return Response.json({ user_info: { tenant_brand: 'lark' } }, { status: 400 })
    if (polls <= (options.pending ?? 1)) return Response.json({ error: 'authorization_pending' }, { status: 400 })
    return Response.json(final, { status: 'error' in final ? 400 : 200 })
  }
  return { calls, fetch: fetchImpl }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000 && !predicate(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

describe('Feishu registration', () => {
  it('pre-fills the bot, permissions, event, and callback in the QR link', () => {
    const decoded = JSON.parse(gunzipSync(Buffer.from(encodeAddons().replace(/-/gu, '+').replace(/_/gu, '/'), 'base64')).toString()) as Record<string, unknown>
    expect(decoded).toEqual({
      preset: false,
      scopes: { tenant: [...FEISHU_SCOPES] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    })
  })

  it('creates an app, stores its secret on the Host, and reports the scanner', async () => {
    const stored: [string, string][] = []
    const platform = accounts({ client_id: 'cli_new', client_secret: 'SECRET', user_info: { open_id: 'ou_me', tenant_brand: 'feishu' } })
    const desk = new RegistrationDesk(async (ref, secret) => { stored.push([ref, secret]) }, platform.fetch, 10)
    const { id, status } = await desk.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET', appName: '{user} 的掌上指挥台' })
    expect(status.state).toBe('waiting')
    const url = new URL(status.state === 'waiting' ? status.url : '')
    expect(url.searchParams.get('createOnly')).toBe('true')
    expect(url.searchParams.get('name')).toBe('{user} 的掌上指挥台')
    expect(url.searchParams.get('addons')).toBe(encodeAddons())
    expect(platform.calls[0]?.form).toEqual({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })
    await until(() => desk.status(id)?.state === 'done')
    expect(desk.status(id)).toEqual({ state: 'done', appId: 'cli_new', domain: 'feishu', ownerOpenId: 'ou_me' })
    expect(stored).toEqual([['FEISHU_APP_SECRET', 'SECRET']])
    // The secret is never part of a status.
    expect(JSON.stringify(desk.status(id))).not.toContain('SECRET')
  })

  it('extends an existing app instead of creating one', async () => {
    const platform = accounts({ client_id: 'cli_old', client_secret: 'S2' })
    const desk = new RegistrationDesk(async () => {}, platform.fetch, 10)
    const { status } = await desk.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET', appId: 'cli_old' })
    const url = new URL(status.state === 'waiting' ? status.url : '')
    expect(url.searchParams.get('clientID')).toBe('cli_old')
    expect(url.searchParams.get('createOnly')).toBeNull()
  })

  it('follows a Lark tenant to the Lark accounts host', async () => {
    const platform = accounts({ client_id: 'cli_lark', client_secret: 'S' }, { larkFirst: true })
    const desk = new RegistrationDesk(async () => {}, platform.fetch, 10)
    const { id } = await desk.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET' })
    await until(() => desk.status(id)?.state === 'done')
    expect(desk.status(id)).toMatchObject({ appId: 'cli_lark', domain: 'lark' })
    expect(platform.calls.at(-1)?.host).toBe('accounts.larksuite.com')
  })

  it('reports a declined confirmation and stops polling on cancel', async () => {
    const declined = accounts({ error: 'access_denied' })
    const desk = new RegistrationDesk(async () => {}, declined.fetch, 10)
    const first = await desk.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET' })
    await until(() => desk.status(first.id)?.state === 'failed')
    expect(desk.status(first.id)).toEqual({ state: 'failed', error: 'access_denied' })

    const pending = accounts({ client_id: 'x', client_secret: 'y' }, { pending: Number.POSITIVE_INFINITY })
    const other = new RegistrationDesk(async () => {}, pending.fetch, 10)
    const run = await other.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET' })
    await until(() => pending.calls.length > 2)
    other.cancel(run.id)
    expect(other.status(run.id)).toEqual({ state: 'cancelled' })
    const seen = pending.calls.length
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(pending.calls.length).toBeLessThanOrEqual(seen + 1)
  })

  it('fails when the secret cannot be stored', async () => {
    const platform = accounts({ client_id: 'cli_new', client_secret: 'S' })
    const desk = new RegistrationDesk(async () => { throw new Error('store offline') }, platform.fetch, 10)
    const { id } = await desk.start({ domain: 'feishu', secretRef: 'FEISHU_APP_SECRET' })
    await until(() => desk.status(id)?.state === 'failed')
    expect(desk.status(id)).toEqual({ state: 'failed', error: 'could not store the app secret: store offline' })
  })
})
