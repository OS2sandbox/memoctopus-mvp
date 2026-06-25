import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Convention: .test.ts → Vitest (pure logic, HTTP). .spec.ts → Playwright (real browser).
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
