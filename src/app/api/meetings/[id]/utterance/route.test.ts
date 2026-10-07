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
import { __resetLiveAudio } from '@/app/api/meetings/ai-audit';
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

describe('audit', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const UUID_PARAMS = { params: Promise.resolve({ id: MEETING }) };
  const events = () => mockRecord.mock.calls.map((c) => c[1] as Record<string, unknown>);

  beforeEach(() => {
    mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockTranscribeRaw.mockReset();
    __resetLiveAudio();
  });

  it('records the live audio (channel live, that utterance size) at most once per meeting and 5 minutes, never the text', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'Hemmelig udtalelse fra Alice', latencyMs: 5 });
    expect((await POST(makeAudioRequest(5_000), UUID_PARAMS)).status).toBe(200);
    expect((await POST(makeAudioRequest(6_000), UUID_PARAMS)).status).toBe(200);
    expect((await POST(makeAudioRequest(7_000), UUID_PARAMS)).status).toBe(200);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      type: 'audio.upload',
      actorUserId: FAKE_SESSION.user.id,
      entityId: MEETING,
      details: { channel: 'live', bytes: 5_000, durationMs: expect.any(Number) },
    });
    expect(JSON.stringify(events())).not.toContain('Hemmelig');
  });

  it('records a failed utterance as an error with a closed code', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTranscribeRaw.mockRejectedValueOnce(Object.assign(new Error('down: Jensens barn'), { status: 502 }));
    expect((await POST(makeAudioRequest(5_000), UUID_PARAMS)).status).toBe(502);
    warn.mockRestore();
    expect(events()[0]).toMatchObject({ outcome: 'error', details: { channel: 'live', bytes: 5_000, outcomeCode: 'http_502' } });
    expect(JSON.stringify(events())).not.toContain('Jensen');
  });

  it('records nothing for rejected input or a clip too short to transcribe', async () => {
    await POST(makeRequestWithoutAudio(), PARAMS);
    await POST(makeAudioRequest(1_999), PARAMS);
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
