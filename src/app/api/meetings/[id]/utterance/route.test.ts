import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockTranscribeRaw = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/transcription', () => ({
  HviskeProvider: class MockHviskeProvider {
    transcribeRaw = mockTranscribeRaw;
  },
}));

import { NextRequest } from 'next/server';
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { POST } from './route';
import { liveTranscriptionCoalescer } from './coalesce';
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/utterance';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

function makeAudioRequest(byteLength: number, mimeType = 'audio/wav'): NextRequest {
  const buffer = Buffer.alloc(byteLength, 0x01);
  const file = new File([buffer], `audio.${mimeType.split('/')[1]}`, { type: mimeType });
  const formData = new FormData();
  formData.append('audio', file);
  return new NextRequest(BASE_URL, { method: 'POST', body: formData });
}

function makeRequestWithoutAudio(): NextRequest {
  return new NextRequest(BASE_URL, { method: 'POST', body: new FormData() });
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockTranscribeRaw.mockReset();
});

describe('POST /api/meetings/[id]/utterance', () => {
  describe('authentication', () => {
    it('returns 401 when no session exists', async () => {
      mockGetSession.mockResolvedValueOnce(null as never);
      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
    });

    it('does not call transcribeRaw when unauthenticated', async () => {
      mockGetSession.mockResolvedValueOnce(null as never);
      await POST(makeAudioRequest(5_000), PARAMS);
      expect(mockTranscribeRaw).not.toHaveBeenCalled();
    });
  });

  describe('request validation', () => {
    it('returns 400 when audio field is missing', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeRequestWithoutAudio(), PARAMS);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Missing audio');
    });
  });

  describe('short audio handling', () => {
    it('returns empty text for audio smaller than 2 000 bytes', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeAudioRequest(1_999), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).text).toBe('');
    });

    it('does not call transcribeRaw for tiny clips', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      await POST(makeAudioRequest(1_000), PARAMS);
      expect(mockTranscribeRaw).not.toHaveBeenCalled();
    });

    it('proceeds to transcription for audio exactly at the 2 000 byte threshold', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'Hej', latencyMs: 0 });
      await POST(makeAudioRequest(2_000), PARAMS);
      expect(mockTranscribeRaw).toHaveBeenCalled();
    });
  });

  describe('successful transcription', () => {
    it('returns 200 with text from transcribeRaw', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'Hej verden', latencyMs: 50 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).text).toBe('Hej verden');
    });

    it('passes buffer and mime type to transcribeRaw', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'ok', latencyMs: 0 });

      await POST(makeAudioRequest(5_000, 'audio/wav'), PARAMS);

      expect(mockTranscribeRaw).toHaveBeenCalledOnce();
      const [buffer, mimeType] = mockTranscribeRaw.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(5_000);
      expect(mimeType).toBe('audio/wav');
    });

    it('returns text as-is (trimming happens client-side)', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: '  Hej  ', latencyMs: 0 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('  Hej  ');
    });
  });

  describe('hallucination filter', () => {
    it('returns empty text when a single word dominates output (>50%)', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      // 5 of 6 words are the same — clearly a hallucination loop
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'tak tak tak tak tak okay', latencyMs: 0 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('');
    });

    it('returns empty text when the same word repeats 3+ times consecutively', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'hej hej hej verden', latencyMs: 0 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('');
    });

    it('passes through short output (under 4 words) even if repetitive', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      // 3 words — filter is skipped for short utterances
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'ja ja ja', latencyMs: 0 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('ja ja ja');
    });

    it('passes through valid output with no repetitions', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce({ text: 'det er en god idé at gøre det', latencyMs: 0 });

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('det er en god idé at gøre det');
    });
  });

  describe('transcription errors', () => {
    it('returns 502 when transcribeRaw throws, so callers can retry the batch', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockRejectedValueOnce(new Error('provider timeout'));

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBeDefined();
    });

    it('does not propagate provider exceptions to the caller', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockRejectedValueOnce(new Error('network error'));

      await expect(POST(makeAudioRequest(5_000), PARAMS)).resolves.toBeDefined();
    });
  });
});

describe('audit: transcription.request (live, coalesced)', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const OTHER_MEETING = '99999999-2222-4333-8444-555555555555';
  const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });
  const events = () => mockRecord.mock.calls.map((c) => c[1]);
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  beforeEach(() => {
    liveTranscriptionCoalescer.clear();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockTranscribeRaw.mockReset();
    mockTranscribeRaw.mockResolvedValue({ text: 'Hemmelig udtalelse fra Alice', latencyMs: 5 });
  });

  it('emits one event (mode live) with duration only and no content', async () => {
    const res = await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect(res.status).toBe(200);

    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e).toMatchObject({
      type: 'transcription.request',
      actorUserId: 'user-123',
      entityId: MEETING,
      details: { mode: 'live' },
    });
    expect(typeof e.details.durationMs).toBe('number');
    expect(e.details).not.toHaveProperty('outcomeCode');
    expectValidMetadataOnly(e, ['Hemmelig', 'Alice', 'audio.wav']);
  });

  it('writes at most one event per actor+meeting across many utterances', async () => {
    for (let i = 0; i < 25; i++) await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect(mockTranscribeRaw).toHaveBeenCalledTimes(25);
    expect(events()).toHaveLength(1);
  });

  it('keeps separate events for another meeting and for another user', async () => {
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    await POST(makeAudioRequest(5_000), paramsFor(OTHER_MEETING));
    mockGetSession.mockResolvedValue({ user: { id: 'user-456' } } as never);
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect(events()).toHaveLength(3);
    expect(events().map((e) => e.actorUserId)).toEqual(['user-123', 'user-123', 'user-456']);
  });

  it('does not emit for the hallucination-filtered response differently: still one coalesced event', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'tak tak tak tak tak okay', latencyMs: 0 });
    const res = await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect((await res.json()).text).toBe('');
    expect(events()).toHaveLength(1);
  });

  it('emits nothing for a non-UUID id, however often it is sent', async () => {
    await POST(makeAudioRequest(5_000), PARAMS);
    await POST(makeAudioRequest(5_000), paramsFor('x'.repeat(5_000)));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('coalesces case variants of the same meeting id into one event', async () => {
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    await POST(makeAudioRequest(5_000), paramsFor(MEETING.toUpperCase()));
    expect(events()).toHaveLength(1);
  });

  it('keeps a later failure apart from an earlier success for the same meeting', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    mockTranscribeRaw.mockRejectedValueOnce(new Error('network error'));
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect(events().map((e) => e.outcome)).toEqual(['success', 'error']);
    spy.mockRestore();
  });

  it('records outcome error with a code, never the message, and keeps the 502', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTranscribeRaw.mockRejectedValueOnce(leakyError('Hemmelig udtalelse', { status: 502 }));
    const res = await POST(makeAudioRequest(5_000), paramsFor(MEETING));

    expect(res.status).toBe(502);
    expect(events()[0]).toMatchObject({ outcome: 'error', details: { mode: 'live', outcomeCode: 'http_502' } });
    expectValidMetadataOnly(events()[0], ['Hemmelig']);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hemmelig');
    spy.mockRestore();
  });

  it('still answers 200 with the text when the audit write rejects', async () => {
    mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('Hemmelig udtalelse fra Alice');
    warn.mockRestore();
  });

  it('emits nothing for 401, missing audio or a too-short clip', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeAudioRequest(5_000), paramsFor(MEETING));
    await POST(makeRequestWithoutAudio(), paramsFor(MEETING));
    await POST(makeAudioRequest(1_999), paramsFor(MEETING));
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/meetings/[id]/utterance — access gate', () => {
  it('answers 403 for a disabled user and never calls the STT provider', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeAudioRequest(5_000), PARAMS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(recordAuthzDenied).toHaveBeenCalledWith(expect.objectContaining({ required: 'login', reason: 'disabled' }));
    expect(mockTranscribeRaw).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('refuses before validating the body', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeRequestWithoutAudio(), PARAMS);
    expect(res.status).toBe(403);
  });
});
