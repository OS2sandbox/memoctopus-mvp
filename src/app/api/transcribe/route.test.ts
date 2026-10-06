import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
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
import { leakyError } from '@/app/api/meetings/ai-audit.test-utils';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

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

describe('audit: pipeline steps are not audited', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('writes no audit event for a successful transcription (transcription and chapters are pipeline steps)', async () => {
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(200);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('writes none for failures either, and logs no message from the failing call', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTranscribe.mockRejectedValueOnce(leakyError('Hej verden', { status: 503 }));
    const res = await POST(makeFormRequest(MEETING));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Transcription failed' });
    // PII and chapter failures are non-fatal and must not log the message either.
    mockGroupChapters.mockRejectedValueOnce(leakyError('Hej verden'));
    expect((await (await POST(makeFormRequest(MEETING))).json()).chapters).toEqual([]);
    mockDetectPii.mockRejectedValueOnce(leakyError('Hej verden'));
    await POST(makeFormRequest(MEETING));
    expect(mockRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hej verden');
    spy.mockRestore();
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

describe('POST /api/transcribe — access gate', () => {
  beforeEach(() => {
    mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
    mockTranscribe.mockReset();
    mockDetectPii.mockReset();
    mockGroupChapters.mockReset();
    mockRecord.mockReset();
  });

  it('answers 403 for a disabled user and never transcribes', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeFormRequest('meet-1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(recordAuthzDenied).toHaveBeenCalledWith(expect.objectContaining({ required: 'login', reason: 'disabled' }));
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockDetectPii).not.toHaveBeenCalled();
    expect(mockGroupChapters).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
