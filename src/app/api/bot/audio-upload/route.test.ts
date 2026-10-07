import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/bot-pending-audio', () => ({
  storePendingAudio: vi.fn().mockResolvedValue(undefined),
  storePendingTranscript: vi.fn().mockResolvedValue(undefined),
  markNoRecording: vi.fn().mockResolvedValue(undefined),
  getBotMeetingOwner: vi.fn().mockResolvedValue('owner-1'),
}));

vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

vi.mock('@/lib/bot-transcribe', () => ({
  processBotRecording: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { storePendingAudio, storePendingTranscript, markNoRecording, getBotMeetingOwner } from '@/lib/bot-pending-audio';
import { recordServerEvent } from '@/lib/audit/record';
import { processBotRecording } from '@/lib/bot-transcribe';

const mockStore = vi.mocked(storePendingAudio);
const mockStoreTranscript = vi.mocked(storePendingTranscript);
const mockMarkNoRecording = vi.mocked(markNoRecording);
const mockProcess = vi.mocked(processBotRecording);
const mockOwner = vi.mocked(getBotMeetingOwner);
const mockRecord = vi.mocked(recordServerEvent);
const MEETING = '11111111-2222-4333-8444-555555555555';

const SECRET = 'test-bot-secret';

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  mockStore.mockReset().mockResolvedValue(undefined);
  mockStoreTranscript.mockReset().mockResolvedValue(undefined);
  mockMarkNoRecording.mockReset().mockResolvedValue(undefined);
  mockProcess.mockReset().mockResolvedValue(undefined);
  mockOwner.mockReset().mockResolvedValue('owner-1');
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
  consoleErrorSpy.mockClear();
  process.env.BOT_INTERNAL_SECRET = SECRET;
});

afterEach(() => {
  consoleErrorSpy.mockClear();
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
  it('returns 401 for a missing, empty, prefix-only or longer Authorization header, and when the secret is unset', async () => {
    for (const auth of ['', 'Bearer ', `Bearer ${SECRET}x`, `bearer ${SECRET}`, SECRET]) {
      expect((await POST(jsonReq({ meetingId: 'm1', hasRecording: false }, auth))).status).toBe(401);
    }
    const noHeader = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      body: JSON.stringify({ meetingId: 'm1', hasRecording: false }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect((await POST(noHeader)).status).toBe(401);
    delete process.env.BOT_INTERNAL_SECRET;
    expect((await POST(jsonReq({ meetingId: 'm1', hasRecording: false }, 'Bearer undefined'))).status).toBe(401);
    expect(mockMarkNoRecording).not.toHaveBeenCalled();
  });

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

  it('logs and continues when markNoRecording fails (does not silently drop the error)', async () => {
    mockMarkNoRecording.mockRejectedValueOnce(new Error('fs error'));
    const res = await POST(jsonReq({ meetingId: 'm1', hasRecording: false }));
    // Still returns 200 (best-effort), but the error must be logged.
    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('markNoRecording'));
    // safeLogError: error name only, never the message ('fs error') or the meeting id.
    const line = String(consoleErrorSpy.mock.calls[0][0]);
    expect(line).toContain('name=Error');
    expect(line).not.toContain('fs error');
    expect(line).not.toContain('m1');
  });

  it('logs a warning when participants JSON is malformed, but still stores audio', async () => {
    const form = new FormData();
    form.append('audio', new File(['audio bytes'], 'r.webm', { type: 'audio/webm' }));
    form.append('meetingId', 'm1');
    form.append('participants', 'not-valid-json{{{');

    const res = await POST(formReq(form));
    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('participants'));
    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('name=SyntaxError');
    // Participants defaults to empty array — stash still proceeds.
    expect(mockStore).toHaveBeenCalledTimes(1);
    expect(mockStore.mock.calls[0][2]).toMatchObject({ participants: [] });
  });

  it('logs and continues when storePendingTranscript fails, still starts processing', async () => {
    mockStoreTranscript.mockRejectedValueOnce(new Error('write error'));
    const form = new FormData();
    form.append('audio', new File(['audio bytes'], 'r.webm', { type: 'audio/webm' }));
    form.append('meetingId', 'm1');

    const res = await POST(formReq(form));
    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('storePendingTranscript'));
    expect(String(consoleErrorSpy.mock.calls[0][0])).not.toContain('write error');
    // Fire-and-forget processing should still be kicked off despite transcript marker failure.
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  describe('audit: audio.upload (system source)', () => {
    const form = (id = MEETING) => {
      const f = new FormData();
      f.append('audio', new File(['audio bytes'], 'Møde med Jensens barn.webm', { type: 'audio/webm' }));
      f.append('meetingId', id);
      return f;
    };

    it('records the hand-in as the system, on behalf of the session owner, with the size only', async () => {
      expect((await POST(formReq(form()))).status).toBe(200);
      expect(mockRecord).toHaveBeenCalledTimes(1);
      const event = mockRecord.mock.calls[0][1] as unknown as Record<string, unknown>;
      expect(event).toMatchObject({
        type: 'audio.upload',
        source: 'system',
        actorUserId: 'owner-1',
        entityId: MEETING,
        details: { channel: 'bot', bytes: 'audio bytes'.length },
      });
      expect(event.outcome ?? 'success').toBe('success');
      expect(JSON.stringify(event)).not.toMatch(/Jensen|\.webm/);
    });

    it('records an error outcome with a closed code when the stash fails', async () => {
      mockStore.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      expect((await POST(formReq(form()))).status).toBe(500);
      expect(mockRecord.mock.calls[0][1]).toMatchObject({
        type: 'audio.upload',
        outcome: 'error',
        details: { channel: 'bot', outcomeCode: 'unknown' },
      });
    });

    it('uses no entity for a meeting id that is not a uuid, and no actor when the owner binding is gone', async () => {
      mockOwner.mockResolvedValue(null);
      await POST(formReq(form('m1')));
      const event = mockRecord.mock.calls[0][1] as unknown as Record<string, unknown>;
      expect(event.entityId).toBeUndefined();
      expect(event.actorUserId).toBeNull();
    });

    it('records nothing for the no-recording notification or a bad secret', async () => {
      await POST(jsonReq({ meetingId: MEETING, hasRecording: false }));
      await POST(formReq(form(), 'Bearer wrong'));
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });
});
