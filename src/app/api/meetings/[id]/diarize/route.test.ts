import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      mockGetSession.mockResolvedValueOnce(null);
      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
    });

    it('does not call diarize when unauthenticated', async () => {
      mockGetSession.mockResolvedValueOnce(null);
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
