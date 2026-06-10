import express, { Request, Response, NextFunction, Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TeamsMeetingBot, BotSessionConfig, BotStatus } from './teams-bot';
import { validateTeamsUrl } from './lib/url-validator';

/**
 * Express app factory for the bot service.
 *
 * Extracted from index.ts so it can be exercised by HTTP integration tests
 * without binding a real port, without calling process.exit(), and without
 * spawning a real Chromium. The `botFactory` injection point lets tests pass
 * a stub bot that just records lifecycle calls.
 */

export interface BotLike {
  status: BotStatus;
  participants: string[];
  elapsed: number;
  error: string | null;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  abort(): Promise<void>;
}

export type BotFactory = (config: BotSessionConfig) => BotLike;

export interface BotServiceOptions {
  internalSecret: string;
  nextAppUrl: string;
  maxConcurrentSessions: number;
  /**
   * Bot constructor — overridable for tests. Production wires this to
   * `(config) => new TeamsMeetingBot(config)`.
   */
  botFactory?: BotFactory;
  /**
   * Time source — overridable for tests of the eviction window. Production
   * wires this to `Date.now`.
   */
  now?: () => number;
}

export interface BotSession {
  id: string;
  bot: BotLike;
  meetingId: string;
  createdAt: number;
}

export interface BotService {
  app: Express;
  sessions: Map<string, BotSession>;
  drain(): Promise<void>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_S = 6 * 60 * 60;
const FIVE_MINUTES_S = 5 * 60;

export function createBotService(opts: BotServiceOptions): BotService {
  const {
    internalSecret,
    nextAppUrl,
    maxConcurrentSessions,
    botFactory = (config) => new TeamsMeetingBot(config),
    now = Date.now,
  } = opts;

  const sessions = new Map<string, BotSession>();
  const app = express();
  app.use(express.json());

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (req.headers['authorization'] !== `Bearer ${internalSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  // POST /sessions — create and start a bot session
  app.post('/sessions', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const { meetingUrl, meetingId, userId, botName } = req.body as {
      meetingUrl?: string;
      meetingId?: string;
      userId?: string;
      botName?: string;
    };

    if (!meetingUrl || !meetingId || !userId) {
      res.status(400).json({ error: 'Missing meetingUrl, meetingId, or userId' });
      return;
    }

    // Evict ended sessions older than 1 hour to keep the Map clean.
    const evictBefore = now() - ONE_HOUR_MS;
    for (const [id, s] of sessions) {
      if ((s.bot.status === 'ended' || s.bot.status === 'error') && s.createdAt < evictBefore) {
        sessions.delete(id);
      }
    }

    const activeSessions = [...sessions.values()].filter(
      (s) => s.bot.status !== 'ended' && s.bot.status !== 'error',
    ).length;
    if (activeSessions >= maxConcurrentSessions) {
      res.status(429).json({ error: 'Too many concurrent sessions', max: maxConcurrentSessions });
      return;
    }

    const urlValidation = validateTeamsUrl(meetingUrl);
    if (!urlValidation.ok) {
      const message = urlValidation.reason === 'wrong-host'
        ? 'URL is not a Microsoft Teams meeting link'
        : 'Invalid meeting URL';
      res.status(400).json({ error: message });
      return;
    }

    const sessionId = uuidv4();
    const config: BotSessionConfig = {
      meetingUrl,
      meetingId,
      userId,
      botName: botName ?? 'Memoctopus',
      callbackUrl: `${nextAppUrl}/api/bot/audio-upload`,
      internalSecret,
    };
    const bot = botFactory(config);
    sessions.set(sessionId, { id: sessionId, bot, meetingId, createdAt: now() });
    bot.start().catch((err: unknown) => {
      console.error('[bot-service] Bot start error:', err);
    });
    res.status(201).json({ sessionId });
  });

  app.get('/sessions/:id', requireAuth, (req: Request, res: Response): void => {
    const s = sessions.get(req.params.id as string);
    if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({
      status: s.bot.status,
      participants: s.bot.participants,
      elapsed: s.bot.elapsed,
      error: s.bot.error,
    });
  });

  app.post('/sessions/:id/pause', requireAuth, (req: Request, res: Response): void => {
    const s = sessions.get(req.params.id as string);
    if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
    s.bot.pause();
    res.json({ ok: true });
  });

  app.post('/sessions/:id/resume', requireAuth, (req: Request, res: Response): void => {
    const s = sessions.get(req.params.id as string);
    if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
    s.bot.resume();
    res.json({ ok: true });
  });

  app.post('/sessions/:id/stop', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const s = sessions.get(req.params.id as string);
    if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({ ok: true });
    s.bot.stop().catch((err: unknown) => {
      console.error('[bot-service] Stop error:', err);
    });
  });

  app.delete('/sessions/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const s = sessions.get(req.params.id as string);
    if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({ ok: true });
    await s.bot.abort().catch(() => {});
    sessions.delete(req.params.id as string);
  });

  app.get('/health', (_req: Request, res: Response) => {
    const t = now();
    const sessionDetails = [...sessions.values()].map((s) => ({
      id: s.id,
      status: s.bot.status,
      elapsed: s.bot.elapsed,
      ageSeconds: Math.floor((t - s.createdAt) / 1000),
    }));

    const stuckJoining = sessionDetails.find((s) => s.status === 'joining' && s.ageSeconds > FIVE_MINUTES_S);
    const leakedSession = sessionDetails.find(
      (s) => s.status !== 'ended' && s.status !== 'error' && s.ageSeconds > SIX_HOURS_S,
    );

    const healthy = !stuckJoining && !leakedSession;
    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      sessions: sessions.size,
      activeSessions: sessionDetails.filter((s) => s.status !== 'ended' && s.status !== 'error').length,
      maxSessions: maxConcurrentSessions,
      stuckJoining: stuckJoining?.id ?? null,
      leakedSession: leakedSession?.id ?? null,
      details: sessionDetails,
    });
  });

  /**
   * Drain all sessions on shutdown. Recording → stop (audio uploaded);
   * joining → abort (no audio). Resolves when all per-session promises
   * settle. The caller is responsible for the outer timeout.
   */
  async function drain(): Promise<void> {
    await Promise.allSettled(
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
  }

  return { app, sessions, drain };
}
