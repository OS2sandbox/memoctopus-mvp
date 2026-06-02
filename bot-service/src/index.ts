import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TeamsMeetingBot, BotSessionConfig } from './teams-bot';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET ?? '';
const NEXT_APP_URL = process.env.NEXT_APP_URL ?? 'http://localhost:3000';

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
  const { meetingUrl, meetingId, userId, botName, callbackUrl } = req.body as {
    meetingUrl: string;
    meetingId: string;
    userId: string;
    botName?: string;
    callbackUrl?: string;
  };

  if (!meetingUrl || !meetingId || !userId) {
    res.status(400).json({ error: 'Missing meetingUrl, meetingId, or userId' });
    return;
  }

  const sessionId = uuidv4();

  const config: BotSessionConfig = {
    meetingUrl,
    meetingId,
    userId,
    botName: botName ?? 'Memoctopus',
    callbackUrl: callbackUrl ?? `${NEXT_APP_URL}/api/bot/audio-upload`,
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
  const session = sessions.get(req.params.id);
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
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.bot.pause();
  res.json({ ok: true });
});

// POST /sessions/:id/resume
app.post('/sessions/:id/resume', requireAuth, (req: Request, res: Response): void => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.bot.resume();
  res.json({ ok: true });
});

// POST /sessions/:id/stop — stop and trigger audio upload
app.post('/sessions/:id/stop', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  // Respond immediately; upload happens asynchronously
  res.json({ ok: true });

  session.bot.stop().catch((err: unknown) => {
    console.error('[bot-service] Stop error:', err);
  });
});

// DELETE /sessions/:id — abort without uploading
app.delete('/sessions/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  res.json({ ok: true });

  await session.bot.abort().catch(() => {});
  sessions.delete(req.params.id);
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, sessions: sessions.size });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[bot-service] Listening on port ${PORT}`);
});
