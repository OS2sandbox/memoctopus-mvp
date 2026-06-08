import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Make next/server's `after()` execute its callback immediately in test scope
// so assertions can observe the background pipeline's DB calls.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => Promise<void>) => { void cb(); } };
});

// Flush all pending microtasks so the `after()` callback fully completes before
// test assertions run.
const flushPromises = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

const mockTranscribe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/transcription', () => ({
  getTranscriptionProvider: () => ({ transcribe: mockTranscribe }),
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

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' }];

function makeFormRequest(meetingId: string | null, includeFile = true, transcriptId?: string): NextRequest {
  const form = new FormData();
  if (meetingId !== null) form.append('meetingId', meetingId);
  if (includeFile) {
    form.append('audio', new File(['audio bytes'], 'recording.webm', { type: 'audio/webm' }));
  }
  form.append('duration', '30');
  if (transcriptId) form.append('transcriptId', transcriptId);
  return new NextRequest('http://localhost/api/transcribe', { method: 'POST', body: form });
}

// ─── POST /api/transcribe ─────────────────────────────────────────────────────

describe('POST /api/transcribe', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockTranscribe.mockReset();
    mockTranscribe.mockResolvedValue(SEGMENTS);
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
    mockQueryOne.mockResolvedValueOnce(null as never); // meeting lookup → not found

    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it('returns ok:true immediately; transcription runs in background', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert transcript
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const res = await POST(makeFormRequest('meet-1'));
    await flushPromises();

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockTranscribe).toHaveBeenCalledOnce();

    const insertTranscript = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /INSERT INTO transcripts/.test(sql),
    );
    expect(insertTranscript).toBeDefined();

    const setReview = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'review'/.test(sql),
    );
    expect(setReview).toBeDefined();
  });

  it('updates existing transcript when transcriptId is provided', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(undefined as never); // update transcript
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const res = await POST(makeFormRequest('meet-1', true, 'draft-transcript-id'));
    await flushPromises();

    expect(res.status).toBe(200);

    const updateCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /UPDATE transcripts/.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![2]).toContain('draft-transcript-id');

    // Should NOT insert a new transcript row
    const insertCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /INSERT INTO transcripts/.test(sql),
    );
    expect(insertCall).toBeUndefined();
  });

  it('on transcription failure: keeps draft if it exists, always sets review', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('Transcription failed'));
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'recording' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(null as never); // check for existing transcript → none
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert empty transcript
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const res = await POST(makeFormRequest('meet-1'));
    await flushPromises();

    // HTTP response is always 200 — transcription failure is handled server-side
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Should NOT reset to 'recording'
    const resetToRecording = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'recording'/.test(sql),
    );
    expect(resetToRecording).toBeUndefined();

    // Should set 'review' so the user can still access the meeting
    const setReview = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'review'/.test(sql),
    );
    expect(setReview).toBeDefined();
  });
});
