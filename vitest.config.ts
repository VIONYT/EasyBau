import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // CLAUDE.md: packages/domain (pure business logic) requires 100 % coverage.
      include: ['packages/domain/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/domain/src/index.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      reporter: ['text', 'text-summary'],
    },
  },
})
