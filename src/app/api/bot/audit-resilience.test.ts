// The REAL audit writer with a failing database: the bot routes must still answer
// normally (telemetry is best-effort) and the warning must stay content-free.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/bot-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot-service')>();
  return { ...actual, getBotServiceConfig: vi.fn() };
});
vi.mock('@/lib/bot-pending-audio', () => ({
  setBotMeetingOwner: vi.fn().mockResolvedValue(undefined),
  assertBotMeetingOwner: vi.fn().mockResolvedValue(true),
  readPendingMeta: vi.fn(),
  readPendingAudio: vi.fn(),
  deletePendingAudio: vi.fn().mockResolvedValue(undefined),
  readPendingTranscript: vi.fn(),
  deletePendingTranscript: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/authz/pg-runner', () => ({
  defaultRunner: () => ({ query: vi.fn().mockRejectedValue(new Error('SECRET connection string leaked')) }),
}));
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ leftJoin: () => ({ where: () => ({ limit: () => Promise.reject(new Error('db down')) }) }) }),
    }),
  },
}));

import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { readPendingMeta, readPendingAudio, readPendingTranscript } from '@/lib/bot-pending-audio';
import { POST as startSession } from './sessions/route';
import { POST as control } from './control/[meetingId]/route';
import { GET as audio } from './audio/[meetingId]/route';
import { GET as transcript } from './transcript/[meetingId]/route';
import { FAKE_SESSION } from '@/test/helpers';

const MEETING = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ meetingId: MEETING }) };
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const jsonReq = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(auth.api.getSession).mockResolvedValue(FAKE_SESSION as never);
  vi.mocked(getBotServiceConfig).mockReturnValue({ url: 'http://bot:3001', authHeader: 'Bearer s' });
  mockFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ sessionId: 's1' }), { status: 200 }));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function expectContentFreeWarnings() {
  expect(warn).toHaveBeenCalled();
  const text = warn.mock.calls.flat().join('\n');
  expect(text).toContain('[audit] event dropped');
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain('teams.microsoft.com');
}

describe('bot routes when the audit write fails', () => {
  it('POST /sessions still returns the session id', async () => {
    const res = await startSession(
      jsonReq('/api/bot/sessions', { meetingId: MEETING, meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('s1');
    expectContentFreeWarnings();
  });

  it('POST /control still returns ok', async () => {
    const res = await control(jsonReq(`/api/bot/control/${MEETING}`, { action: 'pause', sessionId: 's1' }), params);
    expect(res.status).toBe(200);
    expectContentFreeWarnings();
  });

  it('GET /audio still hands over the recording', async () => {
    vi.mocked(readPendingMeta).mockResolvedValue({
      mimeType: 'audio/webm', participants: [], durationSeconds: 1, hasRecording: true, createdAt: 1,
    });
    vi.mocked(readPendingAudio).mockResolvedValue(Buffer.from('abc'));
    const res = await audio(new NextRequest(`http://localhost/api/bot/audio/${MEETING}`), params);
    expect(res.status).toBe(200);
    expectContentFreeWarnings();
  });

  it('GET /transcript still hands over the transcript', async () => {
    vi.mocked(readPendingTranscript).mockResolvedValue({
      status: 'ready', segments: [{ speaker: 'a', start: 0, end: 1, text: 'hej' }], diarized: false, createdAt: 1,
    } as never);
    const res = await transcript(new NextRequest(`http://localhost/api/bot/transcript/${MEETING}`), params);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ready');
    expectContentFreeWarnings();
  });
});
