import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
