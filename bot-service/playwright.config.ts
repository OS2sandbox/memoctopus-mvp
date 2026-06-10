import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // .spec.ts → Playwright (real browser tests).
  // .test.ts → Vitest (pure logic + HTTP tests).
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
});
