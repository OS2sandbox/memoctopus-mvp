import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The transcribe route is stateless: it transcribes the uploaded audio, runs PII
// detection + chapter grouping, and returns the result. Persistence happens
// client-side in IndexedDB, so there is no auth / DB / background-job behaviour here.

const mockTranscribe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/transcription', () => ({
  getTranscriptionProvider: () => ({ transcribe: mockTranscribe }),
}));

const mockDetectPii = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/pii', () => ({
  detectPiiInSegments: mockDetectPii,
}));

const mockGroupChapters = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: mockGroupChapters,
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { POST } from './route';
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' }];
const CHAPTERS = [{ id: 'c1', title: 'Intro', summary: '', startTime: 0, endTime: 5, segmentIndices: [0] }];

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
    mockTranscribe.mockReset();
    mockTranscribe.mockResolvedValue(SEGMENTS);
    mockDetectPii.mockReset();
    mockDetectPii.mockResolvedValue({ replacements: [] });
    mockGroupChapters.mockReset();
    mockGroupChapters.mockResolvedValue(CHAPTERS);
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(401);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('returns 400 when audio file is missing', async () => {
    const res = await POST(makeFormRequest('meet-1', false));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing/i);
  });

  it('returns 400 when meetingId is missing', async () => {
    const res = await POST(makeFormRequest(null));
    expect(res.status).toBe(400);
  });

  it('transcribes and returns segments, pii, rawText and chapters', async () => {
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(mockTranscribe).toHaveBeenCalledOnce();
    expect(data.segments).toEqual(SEGMENTS);
    expect(data.chapters).toEqual(CHAPTERS);
    expect(data.rawText).toBe('Hej verden.');
    expect(data.piiReplacements).toEqual([]);
  });

  it('passes the recording duration through to the provider', async () => {
    await POST(makeFormRequest('meet-1'));
    expect(mockTranscribe).toHaveBeenCalledWith(expect.anything(), 'audio/webm', 30);
  });

  it('returns 500 when transcription fails', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(500);
  });

  it('still returns segments when PII detection fails (non-fatal)', async () => {
    mockDetectPii.mockRejectedValueOnce(new Error('pii down'));
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.segments).toEqual(SEGMENTS);
    expect(data.piiReplacements).toEqual([]);
  });

  it('still returns segments when chapter grouping fails (non-fatal)', async () => {
    mockGroupChapters.mockRejectedValueOnce(new Error('chapters down'));
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.segments).toEqual(SEGMENTS);
    expect(data.chapters).toEqual([]);
  });
});

describe('audit: transcription.request (upload) and chapters.request', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const events = () => mockRecord.mock.calls.map((c) => c[1]);
  const ofType = (t: string) => events().filter((e) => e.type === t);
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('emits one transcription.request (mode upload) with bytes, audioSeconds and duration, no content', async () => {
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(200);

    const [e, ...rest] = ofType('transcription.request');
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      actorUserId: 'user-123',
      entityId: MEETING,
      details: { mode: 'upload', bytes: 11, audioSeconds: 30 },
    });
    expect(typeof e.details.durationMs).toBe('number');
    expect(e.outcome ?? 'success').toBe('success');
    expectValidMetadataOnly(e, ['Hej verden', 'recording.webm']);
  });

  it('emits chapters.request with counts only', async () => {
    await POST(makeFormRequest(MEETING));
    const [e] = ofType('chapters.request');
    expect(e).toMatchObject({ entityId: MEETING, details: { segmentCount: 1, chapterCount: 1 } });
    expectValidMetadataOnly(e, ['Intro', 'Hej verden']);
  });

  it('omits the entity when meetingId is not a UUID', async () => {
    await POST(makeFormRequest('meet-1'));
    for (const e of events()) {
      expect(e.entityId).toBeUndefined();
      expectValidMetadataOnly(e, ['meet-1']);
    }
  });

  it('on transcription failure records outcome error with a code, never the message, and answers 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTranscribe.mockRejectedValueOnce(leakyError('Hej verden', { status: 503 }));
    const res = await POST(makeFormRequest(MEETING));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Transcription failed' });
    const [e] = ofType('transcription.request');
    expect(e).toMatchObject({ outcome: 'error', details: { mode: 'upload', outcomeCode: 'http_503' } });
    expectValidMetadataOnly(e, ['Hej verden']);
    expect(ofType('chapters.request')).toHaveLength(0);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hej verden');
    spy.mockRestore();
  });

  it('records a failing chapters call as outcome error and keeps the response unchanged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGroupChapters.mockRejectedValueOnce(leakyError('Hej verden'));
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(ofType('chapters.request')[0]).toMatchObject({ outcome: 'error' });
    expectValidMetadataOnly(ofType('chapters.request')[0], ['Hej verden']);
    // PII and chapter failures are non-fatal and must not log the message either.
    mockDetectPii.mockRejectedValueOnce(leakyError('Hej verden'));
    await POST(makeFormRequest(MEETING));
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hej verden');
    spy.mockRestore();
  });

  it('still answers 200 with the transcript when the audit write rejects', async () => {
    mockRecord.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(200);
    expect((await res.json()).segments).toEqual(SEGMENTS);
    warn.mockRestore();
  });

  it('emits nothing for 401 or 400', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeFormRequest(MEETING));
    await POST(makeFormRequest(MEETING, false));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns a JSON 500 (withHandler) for an unexpected failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetSession.mockRejectedValueOnce(leakyError('Hej verden'));
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hej verden');
    spy.mockRestore();
  });
});
