import { defineConfig, devices } from '@playwright/test'

/**
 * Device for the run: default a phone (Pixel 7). For screenshots of all screens
 * (SCREENSHOT_DIR) also E2E_DEVICE=macbook (13" MacBook, 1440 × 900 @2x) or
 * E2E_DEVICE=iphone17 (402 × 874 @3x, iOS Safari user agent; still Chromium, because the
 * security key is emulated with the Chrome DevTools virtual authenticator).
 */
const DEVICES = {
  pixel7: devices['Pixel 7'],
  macbook: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  },
  iphone17: {
    viewport: { width: 402, height: 874 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
}
const device = (process.env.E2E_DEVICE ?? 'pixel7') as keyof typeof DEVICES

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
  projects: [{ name: `${device}-chromium`, use: { ...DEVICES[device] } }],
})
