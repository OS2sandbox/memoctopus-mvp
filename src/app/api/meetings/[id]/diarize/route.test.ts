import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// bruger unless a test says otherwise.
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

const mockDiarize = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/diarization', () => ({
  getDiarizationProvider: () => ({ diarize: mockDiarize }),
}));

import { NextRequest } from 'next/server';
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/diarize';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

function makeAudioRequest(byteLength: number, mimeType = 'audio/wav'): NextRequest {
  const buffer = Buffer.alloc(byteLength, 0x01);
  const file = new File([buffer], 'recording.wav', { type: mimeType });
  const formData = new FormData();
  formData.append('audio', file);
  return new NextRequest(BASE_URL, { method: 'POST', body: formData });
}

function makeRequestWithoutAudio(): NextRequest {
  return new NextRequest(BASE_URL, { method: 'POST', body: new FormData() });
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockDiarize.mockReset();
});

describe('POST /api/meetings/[id]/diarize', () => {
  describe('authentication', () => {
    it('returns 401 when no session exists', async () => {
      mockGetSession.mockResolvedValueOnce(null as never);
      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
    });

    it('does not call diarize when unauthenticated', async () => {
      mockGetSession.mockResolvedValueOnce(null as never);
      await POST(makeAudioRequest(5_000), PARAMS);
      expect(mockDiarize).not.toHaveBeenCalled();
    });
  });

  describe('request validation', () => {
    it('returns 400 when audio field is missing', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeRequestWithoutAudio(), PARAMS);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Missing audio');
    });

    it('returns empty turns for audio smaller than 2 000 bytes', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeAudioRequest(1_999), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).turns).toEqual([]);
      expect(mockDiarize).not.toHaveBeenCalled();
    });
  });

  describe('successful diarization', () => {
    it('returns 200 with turns from the provider', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const turns = [
        { speaker: 'SPEAKER_00', start: 0, end: 2 },
        { speaker: 'SPEAKER_01', start: 2, end: 4 },
      ];
      mockDiarize.mockResolvedValueOnce(turns);

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).turns).toEqual(turns);
    });

    it('passes buffer and mime type to the provider', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockDiarize.mockResolvedValueOnce([]);

      await POST(makeAudioRequest(5_000, 'audio/wav'), PARAMS);

      expect(mockDiarize).toHaveBeenCalledOnce();
      const [buffer, mimeType] = mockDiarize.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(5_000);
      expect(mimeType).toBe('audio/wav');
    });
  });

  describe('diarization errors', () => {
    it('returns 200 with empty turns when the provider throws', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockDiarize.mockRejectedValueOnce(new Error('service down'));

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).turns).toEqual([]);
    });

    it('does not propagate provider exceptions to the caller', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockDiarize.mockRejectedValueOnce(new Error('network error'));
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
    mockDiarize.mockReset();
  });

  it('records the recording sent for speaker detection (channel diarize: size, time, meeting), never the turns', async () => {
    mockDiarize.mockResolvedValueOnce([{ speaker: 'SPEAKER_00', start: 0, end: 2 }]);
    await POST(makeAudioRequest(5_000), UUID_PARAMS);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      type: 'audio.upload',
      actorUserId: FAKE_SESSION.user.id,
      entityId: MEETING,
      details: { channel: 'diarize', bytes: 5_000, durationMs: expect.any(Number) },
    });
    expect(events()[0].outcome ?? 'success').toBe('success');
    expect(JSON.stringify(events())).not.toContain('SPEAKER');
  });

  it('records an error outcome with a closed code when diarization fails (the response stays empty turns)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDiarize.mockRejectedValueOnce(Object.assign(new Error('down: Jensens barn'), { status: 503 }));
    const res = await POST(makeAudioRequest(5_000), PARAMS);
    spy.mockRestore();
    expect((await res.json()).turns).toEqual([]);
    expect(events()[0]).toMatchObject({ outcome: 'error', details: { channel: 'diarize', outcomeCode: 'http_503' } });
    expect(events()[0].entityId).toBeUndefined();
    expect(JSON.stringify(events())).not.toContain('Jensen');
  });

  it('records nothing for rejected input', async () => {
    await POST(makeRequestWithoutAudio(), PARAMS);
    await POST(makeAudioRequest(1_000), PARAMS);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
