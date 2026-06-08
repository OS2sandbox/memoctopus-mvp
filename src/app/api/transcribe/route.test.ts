import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

vi.mock('@/lib/ai/transcription', () => ({
  getTranscriptionProvider: vi.fn(() => ({
    transcribe: vi.fn().mockResolvedValue([
      { speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' },
    ]),
  })),
}));

vi.mock('@/lib/ai/pii', () => ({
  detectPiiInSegments: vi.fn().mockResolvedValue({ replacements: [] }),
}));

vi.mock('@/lib/audio/storage', () => ({
  saveAudioFile: vi.fn().mockResolvedValue({ filename: 'test.webm', sizeBytes: 100 }),
}));

// Execute the after() callback synchronously in tests so we can assert on its effects.
const afterCallbacks: Array<() => Promise<void>> = [];
vi.mock('next/server', async (importOriginal) => {
  const mod = await importOriginal<typeof import('next/server')>();
  return {
    ...mod,
    after: vi.fn((cb: () => Promise<void>) => { afterCallbacks.push(cb); }),
  };
});

import { POST } from './route';
import { after } from 'next/server';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockAfter = vi.mocked(after);

function makeFormRequest(meetingId: string | null, includeFile = true): NextRequest {
  const form = new FormData();
  if (meetingId !== null) form.append('meetingId', meetingId);
  if (includeFile) {
    form.append('audio', new File(['audio bytes'], 'recording.webm', { type: 'audio/webm' }));
  }
  form.append('duration', '30');
  return new NextRequest('http://localhost/api/transcribe', { method: 'POST', body: form });
}

// ─── POST /api/transcribe ─────────────────────────────────────────────────────

describe('POST /api/transcribe', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockAfter.mockReset();
    afterCallbacks.length = 0;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when audio file is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeFormRequest('meet-1', false));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing/i);
  });

  it('returns 400 when meetingId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeFormRequest(null));
    expect(res.status).toBe(400);
  });

  it('returns 404 when meeting does not belong to user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it('returns 200 ok immediately (transcription runs in background)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValue({} as never); // all subsequent DB calls

    const res = await POST(makeFormRequest('meet-1'));

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('sets meeting status to processing before returning', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never);
    mockQueryOne.mockResolvedValue({} as never);

    await POST(makeFormRequest('meet-1'));

    const processingCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'processing'"),
    );
    expect(processingCall).toBeDefined();
  });

  it('queues a background job via after()', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never);
    mockQueryOne.mockResolvedValue({} as never);

    await POST(makeFormRequest('meet-1'));

    expect(mockAfter).toHaveBeenCalledOnce();
  });

  it('background job: sets meeting to review after successful transcription', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never);
    // save audio + set processing
    mockQueryOne.mockResolvedValue({} as never);

    await POST(makeFormRequest('meet-1'));

    // Run the queued background callback
    for (const cb of afterCallbacks) await cb();

    const reviewCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'review'"),
    );
    expect(reviewCall).toBeDefined();
  });

  it('background job: resets meeting status to recording on transcription error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never);
    mockQueryOne.mockResolvedValue({} as never);

    const { getTranscriptionProvider } = await import('@/lib/ai/transcription');
    vi.mocked(getTranscriptionProvider).mockReturnValueOnce({
      transcribe: vi.fn().mockRejectedValueOnce(new Error('Transcription failed')),
    });

    await POST(makeFormRequest('meet-1'));
    for (const cb of afterCallbacks) await cb();

    const resetCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'recording'"),
    );
    expect(resetCall).toBeDefined();
  });
});
