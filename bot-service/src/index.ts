import dotenv from 'dotenv';
import path from 'path';
// Load root .env.local so BOT_INTERNAL_SECRET and other vars are available in dev
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TeamsMeetingBot, BotSessionConfig } from './teams-bot';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.BOT_PORT ?? '3001', 10);
const INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET;
if (!INTERNAL_SECRET) {
  console.error('[bot-service] FATAL: BOT_INTERNAL_SECRET is not set. Refusing to start.');
  process.exit(1);
}
const NEXT_APP_URL = process.env.NEXT_APP_URL ?? 'http://localhost:3004';
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.BOT_MAX_SESSIONS ?? '5', 10);

interface BotSession {
  id: string;
  bot: TeamsMeetingBot;
  meetingId: string;
  createdAt: Date;
}

const sessions = new Map<string, BotSession>();

// ─── Auth middleware ─────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers['authorization'];
  if (!INTERNAL_SECRET || auth !== `Bearer ${INTERNAL_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /sessions — create and start a bot session
app.post('/sessions', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { meetingUrl, meetingId, userId, botName } = req.body as {
    meetingUrl: string;
    meetingId: string;
    userId: string;
    botName?: string;
  };

  if (!meetingUrl || !meetingId || !userId) {
    res.status(400).json({ error: 'Missing meetingUrl, meetingId, or userId' });
    return;
  }

  // Evict ended sessions older than 1 hour to keep the Map clean
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if ((s.bot.status === 'ended' || s.bot.status === 'error') && s.createdAt.getTime() < oneHourAgo) {
      sessions.delete(id);
    }
  }

  const activeSessions = [...sessions.values()].filter(
    (s) => s.bot.status !== 'ended' && s.bot.status !== 'error',
  ).length;
  if (activeSessions >= MAX_CONCURRENT_SESSIONS) {
    res.status(429).json({ error: 'Too many concurrent sessions', max: MAX_CONCURRENT_SESSIONS });
    return;
  }

  // Reject anything that is clearly not a Teams meeting URL
  let parsedUrl: URL;
  try { parsedUrl = new URL(meetingUrl); } catch {
    res.status(400).json({ error: 'Invalid meeting URL' });
    return;
  }
  const validHost = parsedUrl.hostname === 'teams.microsoft.com' || parsedUrl.hostname === 'teams.live.com';
  if (!validHost) {
    res.status(400).json({ error: 'URL is not a Microsoft Teams meeting link' });
    return;
  }

  const sessionId = uuidv4();

  const config: BotSessionConfig = {
    meetingUrl,
    meetingId,
    userId,
    botName: botName ?? 'Memoctopus',
    // Always derived server-side — never accepted from the caller to prevent SSRF
    callbackUrl: `${NEXT_APP_URL}/api/bot/audio-upload`,
    internalSecret: INTERNAL_SECRET,
  };

  const bot = new TeamsMeetingBot(config);
  sessions.set(sessionId, { id: sessionId, bot, meetingId, createdAt: new Date() });

  // Start async — do not await so the HTTP response is immediate
  bot.start().catch((err: unknown) => {
    console.error('[bot-service] Bot start error:', err);
  });

  res.status(201).json({ sessionId });
});

// GET /sessions/:id — get session status
app.get('/sessions/:id', requireAuth, (req: Request, res: Response): void => {
  const session = sessions.get(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { bot } = session;
  res.json({
    status: bot.status,
    participants: bot.participants,
    elapsed: bot.elapsed,
    error: bot.error ?? null,
  });
});

// POST /sessions/:id/pause
app.post('/sessions/:id/pause', requireAuth, (req: Request, res: Response): void => {
  const session = sessions.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.bot.pause();
  res.json({ ok: true });
});

// POST /sessions/:id/resume
app.post('/sessions/:id/resume', requireAuth, (req: Request, res: Response): void => {
  const session = sessions.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.bot.resume();
  res.json({ ok: true });
});

// POST /sessions/:id/stop — stop and trigger audio upload
app.post('/sessions/:id/stop', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const session = sessions.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  // Respond immediately; upload happens asynchronously
  res.json({ ok: true });

  session.bot.stop().catch((err: unknown) => {
    console.error('[bot-service] Stop error:', err);
  });
});

// DELETE /sessions/:id — abort without uploading
app.delete('/sessions/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const session = sessions.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  res.json({ ok: true });

  await session.bot.abort().catch(() => {});
  sessions.delete(req.params.id as string);
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const now = Date.now();
  const sessionDetails = [...sessions.values()].map((s) => ({
    id: s.id,
    status: s.bot.status,
    elapsed: s.bot.elapsed,
    ageSeconds: Math.floor((now - s.createdAt.getTime()) / 1000),
  }));

  // Stuck: joining for more than 5 minutes (browser is likely hung)
  const stuckJoining = sessionDetails.find((s) => s.status === 'joining' && s.ageSeconds > 300);
  // Leaked: active session older than 6 hours
  const leakedSession = sessionDetails.find(
    (s) => s.status !== 'ended' && s.status !== 'error' && s.ageSeconds > 21_600,
  );

  const healthy = !stuckJoining && !leakedSession;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    sessions: sessions.size,
    activeSessions: sessionDetails.filter((s) => s.status !== 'ended' && s.status !== 'error').length,
    maxSessions: MAX_CONCURRENT_SESSIONS,
    stuckJoining: stuckJoining?.id ?? null,
    leakedSession: leakedSession?.id ?? null,
    details: sessionDetails,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[bot-service] Listening on port ${PORT}`);
});

// 90 s — comfortably inside the compose stop_grace_period: 120s
const DRAIN_TIMEOUT_MS = 90_000;

function shutdown(signal: string): void {
  console.log(`[bot-service] ${signal} received — draining sessions before exit`);
  server.close();

  const drain = Promise.allSettled(
    [...sessions.values()].map(async (s) => {
      try {
        if (s.bot.status === 'recording' || s.bot.status === 'paused') {
          await s.bot.stop();
        } else if (s.bot.status === 'joining') {
          await s.bot.abort();
        }
      } catch (err) {
        console.error(`[bot-service] Shutdown error for session ${s.id}:`, err);
      }
    }),
  );

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.error('[bot-service] Drain timeout exceeded — forcing exit');
      resolve();
    }, DRAIN_TIMEOUT_MS),
  );

  void Promise.race([drain, timeout]).then(() => {
    console.log('[bot-service] Exiting');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
// SIGINT (Ctrl-C in dev with ts-node-dev) — same drain so sessions aren't abandoned
process.on('SIGINT', () => shutdown('SIGINT'));
