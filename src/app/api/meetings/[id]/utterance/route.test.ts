import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

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
      mockGetSession.mockResolvedValueOnce(null);
      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
    });

    it('does not call transcribeRaw when unauthenticated', async () => {
      mockGetSession.mockResolvedValueOnce(null);
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
      mockTranscribeRaw.mockResolvedValueOnce('Hej');
      await POST(makeAudioRequest(2_000), PARAMS);
      expect(mockTranscribeRaw).toHaveBeenCalled();
    });
  });

  describe('successful transcription', () => {
    it('returns 200 with text from transcribeRaw', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce('Hej verden');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).text).toBe('Hej verden');
    });

    it('passes buffer and mime type to transcribeRaw', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce('ok');

      await POST(makeAudioRequest(5_000, 'audio/wav'), PARAMS);

      expect(mockTranscribeRaw).toHaveBeenCalledOnce();
      const [buffer, mimeType] = mockTranscribeRaw.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(5_000);
      expect(mimeType).toBe('audio/wav');
    });

    it('returns text as-is (trimming happens client-side)', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce('  Hej  ');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('  Hej  ');
    });
  });

  describe('hallucination filter', () => {
    it('returns empty text when a single word dominates output (>50%)', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      // 5 of 6 words are the same — clearly a hallucination loop
      mockTranscribeRaw.mockResolvedValueOnce('tak tak tak tak tak okay');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('');
    });

    it('returns empty text when the same word repeats 3+ times consecutively', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce('hej hej hej verden');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('');
    });

    it('passes through short output (under 4 words) even if repetitive', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      // 3 words — filter is skipped for short utterances
      mockTranscribeRaw.mockResolvedValueOnce('ja ja ja');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('ja ja ja');
    });

    it('passes through valid output with no repetitions', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockResolvedValueOnce('det er en god idé at gøre det');

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect((await res.json()).text).toBe('det er en god idé at gøre det');
    });
  });

  describe('transcription errors', () => {
    it('returns 200 with empty text when transcribeRaw throws', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockRejectedValueOnce(new Error('provider timeout'));

      const res = await POST(makeAudioRequest(5_000), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).text).toBe('');
    });

    it('does not propagate provider exceptions to the caller', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockTranscribeRaw.mockRejectedValueOnce(new Error('network error'));

      await expect(POST(makeAudioRequest(5_000), PARAMS)).resolves.toBeDefined();
    });
  });
});
