import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The loader composition test runs the real Cordis loader from a sibling
// deepseek-harness checkout; without one, that test skips itself.
const harness = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const vendor = (name: string): string => `${harness}vendor/${name}/lib/index.js`

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    env: { DSH_HARNESS_CHECKOUT: existsSync(vendor('loader')) ? harness : '' },
  },
  resolve: {
    alias: existsSync(vendor('loader'))
      ? {
          '@deepseek-ai/cordis-plugin-loader': vendor('loader'),
          '@deepseek-ai/cordis-plugin-include': vendor('include'),
          '@deepseek-ai/cordis': vendor('cordis'),
          '@deepseek-ai/schemastery': `${harness}vendor/schemastery/lib/index.mjs`,
        }
      : {},
  },
})
