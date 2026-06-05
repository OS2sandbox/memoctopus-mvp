import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    // @ts-ignore — valid Vitest option, not in Next.js tsconfig types
    environmentMatchGlobs: [['src/components/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/test/setup.ts'],
    // bot-service uses @playwright/test — excluded to avoid Vitest/Playwright runner conflicts
    exclude: ['node_modules/**', 'bot-service/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/lib/**', 'src/app/api/**', 'src/components/**'],
      exclude: ['src/components/ui/**', 'src/test/**', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
