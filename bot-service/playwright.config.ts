import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',

  // .spec.ts → Playwright real-browser tests
  // .test.ts → Vitest unit / HTTP tests
  testMatch: '**/*.spec.ts',

  timeout: 30_000,
  workers: 1,

  use: {
    browserName: 'chromium',
    headless: true,

    permissions: ['camera', 'microphone'],

    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
});
