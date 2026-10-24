// Build both halves with esbuild. Self-contained (no monorepo checkout needed),
// so it also runs as the `prepare` script of a git install.
//
//   lib/index.js  — host half, ESM for Node; every package import stays external
//                   and resolves to the running dsh installation.
//   lib/client.js — browser half in the client module system's lazy factory
//                   format: window.__ModuleLoader__.load({ id, factory(require) }).
//                   react and @deepseek-ai/* resolve through the injected require
//                   against the Web shell's platform module table.

import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

await build({
  absWorkingDir: root.pathname,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  // tsconfig paths point at a sibling checkout for type-checking only; never inline it.
  external: ['@deepseek-ai/*'],
  tsconfigRaw: {},
  sourcemap: true,
  logLevel: 'info',
})

await build({
  absWorkingDir: root.pathname,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
