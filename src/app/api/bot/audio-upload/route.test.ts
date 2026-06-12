import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/bot-pending-audio', () => ({
  storePendingAudio: vi.fn().mockResolvedValue(undefined),
  storePendingTranscript: vi.fn().mockResolvedValue(undefined),
  markNoRecording: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/bot-transcribe', () => ({
  processBotRecording: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { storePendingAudio, storePendingTranscript, markNoRecording } from '@/lib/bot-pending-audio';
import { processBotRecording } from '@/lib/bot-transcribe';

const mockStore = vi.mocked(storePendingAudio);
const mockStoreTranscript = vi.mocked(storePendingTranscript);
const mockMarkNoRecording = vi.mocked(markNoRecording);
const mockProcess = vi.mocked(processBotRecording);

const SECRET = 'test-bot-secret';

beforeEach(() => {
  mockStore.mockReset().mockResolvedValue(undefined);
  mockStoreTranscript.mockReset().mockResolvedValue(undefined);
  mockMarkNoRecording.mockReset().mockResolvedValue(undefined);
  mockProcess.mockReset().mockResolvedValue(undefined);
  process.env.BOT_INTERNAL_SECRET = SECRET;
});

function jsonReq(body: unknown, auth = `Bearer ${SECRET}`): NextRequest {
  return new NextRequest('http://localhost/api/bot/audio-upload', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: auth },
  });
}

function formReq(form: FormData, auth = `Bearer ${SECRET}`): NextRequest {
  return new NextRequest('http://localhost/api/bot/audio-upload', {
    method: 'POST',
    body: form,
    headers: { Authorization: auth },
  });
}

describe('POST /api/bot/audio-upload', () => {
  it('returns 401 with a bad secret', async () => {
    const res = await POST(jsonReq({ meetingId: 'm1', hasRecording: false }, 'Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('marks no-recording for the JSON notification', async () => {
    const res = await POST(jsonReq({ meetingId: 'm1', hasRecording: false }));
    expect(res.status).toBe(200);
    expect(mockMarkNoRecording).toHaveBeenCalledWith('m1');
  });

  it('returns 400 when required fields are missing', async () => {
    const form = new FormData();
    form.append('audio', new File(['x'], 'r.webm', { type: 'audio/webm' }));
    const res = await POST(formReq(form));
    expect(res.status).toBe(400);
  });

  it('stashes the uploaded audio with meta', async () => {
    const form = new FormData();
    form.append('audio', new File(['audio bytes'], 'r.webm', { type: 'audio/webm' }));
    form.append('meetingId', 'm1');
    form.append('userId', 'u1');
    form.append('duration', '120');
    form.append('participants', JSON.stringify(['Anna', 'Bo']));

    const res = await POST(formReq(form));
    expect(res.status).toBe(200);
    expect(mockStore).toHaveBeenCalledTimes(1);
    const [meetingId, buffer, meta] = mockStore.mock.calls[0];
    expect(meetingId).toBe('m1');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(meta).toMatchObject({
      mimeType: 'audio/webm',
      participants: ['Anna', 'Bo'],
      durationSeconds: 120,
      hasRecording: true,
    });
  });

  it('kicks off server-side processing the moment audio lands', async () => {
    const form = new FormData();
    form.append('audio', new File(['audio bytes'], 'r.webm', { type: 'audio/webm' }));
    form.append('meetingId', 'm1');

    const res = await POST(formReq(form));
    expect(res.status).toBe(200);
    // 'processing' marker is written before the response so the client never
    // races an absent stash…
    expect(mockStoreTranscript).toHaveBeenCalledWith('m1', { status: 'processing' });
    // …and transcription+diarization start immediately (fire-and-forget).
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockProcess.mock.calls[0][0]).toBe('m1');
    expect(mockProcess.mock.calls[0][2]).toBe('audio/webm');
  });

  it('does not start processing when the stash fails', async () => {
    mockStore.mockRejectedValueOnce(new Error('disk full'));
    const form = new FormData();
    form.append('audio', new File(['audio bytes'], 'r.webm', { type: 'audio/webm' }));
    form.append('meetingId', 'm1');

    const res = await POST(formReq(form));
    expect(res.status).toBe(500);
    expect(mockProcess).not.toHaveBeenCalled();
  });
});
