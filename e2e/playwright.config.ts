import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against a running stack (docker compose up), e.g.:
 *   BASE_URL=https://localhost:8443 SETUP_TOKEN=... pnpm test:e2e
 * The stack must be fresh (setup not yet done). Chromium only: security keys are emulated
 * with the Chrome DevTools virtual authenticator.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://localhost',
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
})
