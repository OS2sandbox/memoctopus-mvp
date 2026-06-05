import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/ai/transcription', () => ({
  getTranscriptionProvider: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { auth } from '@/lib/auth';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetProvider = vi.mocked(getTranscriptionProvider);

const BASE_URL = 'http://localhost/api/meetings/meet-1/live-transcribe';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

function makeAudioRequest(byteLength: number, mimeType = 'audio/webm'): NextRequest {
  const buffer = Buffer.alloc(byteLength, 0x01);
  const file = new File([buffer], 'audio.webm', { type: mimeType });
  const formData = new FormData();
  formData.append('audio', file);
  return new NextRequest(BASE_URL, { method: 'POST', body: formData });
}

function makeRequestWithoutAudio(): NextRequest {
  const formData = new FormData();
  return new NextRequest(BASE_URL, { method: 'POST', body: formData });
}

const SAMPLE_SEGMENTS = [
  { speaker: 'Taler 1', start: 0, end: 3, text: 'Hej alle.' },
  { speaker: 'Taler 2', start: 4, end: 7, text: 'God morgen.' },
];

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetProvider.mockReset();
});

describe('POST /api/meetings/[id]/live-transcribe', () => {
  describe('authentication', () => {
    it('returns 401 when no session exists', async () => {
      mockGetSession.mockResolvedValueOnce(null);
      const res = await POST(makeAudioRequest(20_000), PARAMS);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
    });

    it('does not call getTranscriptionProvider when unauthenticated', async () => {
      mockGetSession.mockResolvedValueOnce(null);
      await POST(makeAudioRequest(20_000), PARAMS);
      expect(mockGetProvider).not.toHaveBeenCalled();
    });
  });

  describe('request validation', () => {
    it('returns 400 when audio field is missing', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeRequestWithoutAudio(), PARAMS);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Missing audio');
    });

    it('does not call transcription provider when audio is missing', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      await POST(makeRequestWithoutAudio(), PARAMS);
      expect(mockGetProvider).not.toHaveBeenCalled();
    });
  });

  describe('short audio handling', () => {
    it('returns empty segments for audio smaller than 10 000 bytes', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await POST(makeAudioRequest(9_999), PARAMS);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.segments).toEqual([]);
      expect(body.text).toBe('');
    });

    it('does not call the transcription provider for tiny clips', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      await POST(makeAudioRequest(5_000), PARAMS);
      expect(mockGetProvider).not.toHaveBeenCalled();
    });

    it('proceeds to transcription for audio exactly at the 10 000 byte threshold', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const mockTranscribe = vi.fn().mockResolvedValueOnce([]);
      mockGetProvider.mockReturnValueOnce({ transcribe: mockTranscribe });

      await POST(makeAudioRequest(10_000), PARAMS);
      expect(mockTranscribe).toHaveBeenCalled();
    });
  });

  describe('successful transcription', () => {
    it('returns 200 with segments and joined text', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const mockTranscribe = vi.fn().mockResolvedValueOnce(SAMPLE_SEGMENTS);
      mockGetProvider.mockReturnValueOnce({ transcribe: mockTranscribe });

      const res = await POST(makeAudioRequest(20_000), PARAMS);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.segments).toEqual(SAMPLE_SEGMENTS);
      expect(body.text).toBe('Hej alle. God morgen.');
    });

    it('passes the audio buffer and mime type to the provider', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const mockTranscribe = vi.fn().mockResolvedValueOnce([]);
      mockGetProvider.mockReturnValueOnce({ transcribe: mockTranscribe });

      await POST(makeAudioRequest(15_000, 'audio/ogg'), PARAMS);

      expect(mockTranscribe).toHaveBeenCalledOnce();
      const [buffer, mimeType] = mockTranscribe.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(15_000);
      expect(mimeType).toBe('audio/ogg');
    });

    it('joins segment texts with a space', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const segments = [
        { speaker: 'A', start: 0, end: 1, text: 'One.' },
        { speaker: 'B', start: 2, end: 3, text: 'Two.' },
        { speaker: 'A', start: 4, end: 5, text: 'Three.' },
      ];
      mockGetProvider.mockReturnValueOnce({ transcribe: vi.fn().mockResolvedValueOnce(segments) });

      const res = await POST(makeAudioRequest(20_000), PARAMS);
      expect((await res.json()).text).toBe('One. Two. Three.');
    });

    it('returns empty text when provider returns no segments', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockGetProvider.mockReturnValueOnce({ transcribe: vi.fn().mockResolvedValueOnce([]) });

      const res = await POST(makeAudioRequest(20_000), PARAMS);
      const body = await res.json();
      expect(body.segments).toEqual([]);
      expect(body.text).toBe('');
    });

    it('forwards the file mime type to the provider', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const mockTranscribe = vi.fn().mockResolvedValueOnce([]);
      mockGetProvider.mockReturnValueOnce({ transcribe: mockTranscribe });

      await POST(makeAudioRequest(20_000, 'audio/ogg'), PARAMS);

      const [, mimeType] = mockTranscribe.mock.calls[0];
      expect(mimeType).toBe('audio/ogg');
    });
  });

  describe('transcription provider errors', () => {
    it('returns 200 with empty segments when provider throws', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockGetProvider.mockReturnValueOnce({
        transcribe: vi.fn().mockRejectedValueOnce(new Error('provider down')),
      });

      const res = await POST(makeAudioRequest(20_000), PARAMS);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.segments).toEqual([]);
      expect(body.text).toBe('');
    });

    it('does not propagate provider exceptions to the caller', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockGetProvider.mockReturnValueOnce({
        transcribe: vi.fn().mockRejectedValueOnce(new Error('network timeout')),
      });

      await expect(POST(makeAudioRequest(20_000), PARAMS)).resolves.toBeDefined();
    });
  });
});
