import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/bot-pending-audio', () => ({
  storePendingAudio: vi.fn().mockResolvedValue(undefined),
  markNoRecording: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { storePendingAudio, markNoRecording } from '@/lib/bot-pending-audio';

const mockStore = vi.mocked(storePendingAudio);
const mockMarkNoRecording = vi.mocked(markNoRecording);

const SECRET = 'test-bot-secret';

beforeEach(() => {
  mockStore.mockReset().mockResolvedValue(undefined);
  mockMarkNoRecording.mockReset().mockResolvedValue(undefined);
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
});
