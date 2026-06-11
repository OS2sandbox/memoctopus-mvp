import dotenv from 'dotenv';
import path from 'path';
// Load root .env.local so BOT_INTERNAL_SECRET and other vars are available in dev
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { createBotService } from './server';

const PORT = parseInt(process.env.BOT_PORT ?? '3001', 10);
const INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET;
if (!INTERNAL_SECRET) {
  console.error('[bot-service] FATAL: BOT_INTERNAL_SECRET is not set. Refusing to start.');
  process.exit(1);
}
const NEXT_APP_URL = process.env.NEXT_APP_URL ?? 'http://localhost:3004';
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.BOT_MAX_SESSIONS ?? '5', 10);

const { app, drain } = createBotService({
  internalSecret: INTERNAL_SECRET,
  nextAppUrl: NEXT_APP_URL,
  maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
});

const server = app.listen(PORT, () => {
  console.log(`[bot-service] Listening on port ${PORT}`);
});

// 90 s — comfortably inside the compose stop_grace_period: 120s
const DRAIN_TIMEOUT_MS = 90_000;

function shutdown(signal: string): void {
  console.log(`[bot-service] ${signal} received — draining sessions before exit`);
  server.close();

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.error('[bot-service] Drain timeout exceeded — forcing exit');
      resolve();
    }, DRAIN_TIMEOUT_MS),
  );

  void Promise.race([drain(), timeout]).then(() => {
    console.log('[bot-service] Exiting');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
// SIGINT (Ctrl-C in dev with ts-node-dev) — same drain so sessions aren't abandoned
process.on('SIGINT', () => shutdown('SIGINT'));
