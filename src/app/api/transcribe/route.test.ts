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

import { POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

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

  it('returns transcriptId, segments, piiReplacementCount on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce({} as never); // mark processing
    mockQueryOne.mockResolvedValueOnce({} as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-123' } as never); // insert transcript
    mockQueryOne.mockResolvedValueOnce({} as never); // mark review

    const res = await POST(makeFormRequest('meet-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcriptId).toBe('transcript-123');
    expect(body.segments).toHaveLength(1);
    expect(body.piiReplacementCount).toBe(0);
  });

  it('resets meeting status to recording on transcription error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce({} as never); // mark processing
    mockQueryOne.mockResolvedValueOnce({} as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce({} as never); // reset to recording (catch)

    const { getTranscriptionProvider } = await import('@/lib/ai/transcription');
    vi.mocked(getTranscriptionProvider).mockReturnValueOnce({
      transcribe: vi.fn().mockRejectedValueOnce(new Error('Transcription failed')),
    });

    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Transcription failed');

    const resetCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'recording'"),
    );
    expect(resetCall).toBeDefined();
  });
});
