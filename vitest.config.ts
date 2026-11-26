import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Integration tests (*.integration.test.ts) create databases, run migrations and hash
    // passwords with argon2id (64 MiB): under load (CI, parallel files) 5 s was too tight and made
    // runs fail for no reason (CLAUDE.md P3.0). Unit tests stay fast either way.
    testTimeout: process.env.DATABASE_URL ? 30_000 : 5_000,
    hookTimeout: process.env.DATABASE_URL ? 60_000 : 10_000,
    // Workspace packages are executed from TypeScript sources (condition "source"), never from dist/.
    server: { deps: { inline: [/^@easybau\//] } },
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
