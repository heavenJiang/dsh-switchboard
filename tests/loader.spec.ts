import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Runs only with a sibling deepseek-harness checkout (see vitest.config.ts).
const enabled = process.env['DSH_HARNESS_CHECKOUT'] !== ''

let root: string | undefined
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(!enabled)('real Loader composition', () => {
  it('activates with core services, registers its routes, and serves the overview', { timeout: 60_000 }, async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
    const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
    const bridge = await import('../src/index.ts')

    root = await mkdtemp(join(tmpdir(), 'tg-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-services',
      '- id: telegram-bridge',
      '  name: dsh-telegram-bridge',
      '  config:',
      `    stateFile: ${JSON.stringify(join(root, 'state', 'state.json'))}`,
      '',
    ].join('\n'))

    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const services = {
      name: 'fixture-services',
      apply(ctx: InstanceType<typeof Context>) {
        const fake = (value: object) => value as never
        ctx.provide('agents' as never, fake({ get: () => undefined }))
        ctx.provide('sessionController' as never, fake({ modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [] }) }))
        ctx.provide('permissionPresets' as never, fake({ catalog: () => ({ options: [] }) }))
        ctx.provide('fileUploads' as never, fake({}))
        ctx.provide('llm' as never, fake({}))
        ctx.provide('connection' as never, fake({
          fetch: {
            register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
              routes.set(route.path, route.fetch)
              return async () => { routes.delete(route.path) }
            },
          },
        }))
      },
    }

    const context = new Context()
    dispose = () => context.fiber.dispose()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['fixture-services', services], ['dsh-telegram-bridge', bridge]])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect([...routes.keys()].sort()).toEqual([
      '/api/telegram-bridge/history', '/api/telegram-bridge/link', '/api/telegram-bridge/media',
      '/api/telegram-bridge/models', '/api/telegram-bridge/overview', '/api/telegram-bridge/send',
      '/api/telegram-bridge/session', '/api/telegram-bridge/update-check',
    ])
    const overview = await (await routes.get('/api/telegram-bridge/overview')!(new Request('http://x/', { method: 'POST' }))).json() as {
      state: { kind: string }; chats: unknown[]; stats: { series: unknown[] }
    }
    // No token configured: the bridge stays stopped and the viewer still answers.
    expect(overview.state.kind).toBe('stopped')
    expect(overview.chats).toEqual([])
    expect(overview.stats.series).toHaveLength(14)
  })
})
