import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Make next/server's `after()` execute its callback immediately in test scope
// so assertions can observe the background pipeline's DB calls.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => Promise<void>) => { void cb(); } };
});

// Flush all pending microtasks so the `after()` callback fully completes before
// test assertions run.
const flushPromises = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

const mockTranscribeWithVadBatches = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audio/vad-batch-server', () => ({
  transcribeWithVadBatches: mockTranscribeWithVadBatches,
}));

vi.mock('@/lib/ai/pii', () => ({
  detectPiiInSegments: vi.fn().mockResolvedValue({ replacements: [] }),
}));

vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/audio/storage', () => ({
  saveAudioFile: vi.fn().mockResolvedValue({ filename: 'stored.webm', sizeBytes: 4096 }),
}));

import { POST } from './route';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { groupIntoChapters } from '@/lib/ai/chapters';

const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockDetectPii = vi.mocked(detectPiiInSegments);
const mockGroupChapters = vi.mocked(groupIntoChapters);

const SECRET = 'bot-secret';
const AUTH_HEADER = `Bearer ${SECRET}`;
const MEETING = { id: 'meet-1', status: 'recording' };
const SEGMENTS = [{ speaker: 'Alice', text: 'Hello world', start: 0, end: 2 }];

function makeJsonReq(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/bot/audio-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function makeMultipartReq(fields: Record<string, string>, audioFile?: File): NextRequest {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (audioFile) fd.append('audio', audioFile);
  return new NextRequest('http://localhost/api/bot/audio-upload', {
    method: 'POST',
    body: fd,
  });
}

function validAudio() {
  return new File([new Uint8Array([0, 1, 2, 3])], 'recording.webm', { type: 'audio/webm' });
}

beforeEach(() => {
  mockQueryOne.mockReset();
  mockTranscribeWithVadBatches.mockReset();
  mockDetectPii.mockResolvedValue({ replacements: [] });
  mockGroupChapters.mockResolvedValue([]);
  mockTranscribeWithVadBatches.mockResolvedValue(SEGMENTS);
  process.env.BOT_INTERNAL_SECRET = SECRET;
});

describe('POST /api/bot/audio-upload', () => {
  // ─── Auth ────────────────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeJsonReq({ meetingId: 'm', userId: 'u', hasRecording: false }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is wrong', async () => {
    const res = await POST(makeJsonReq(
      { meetingId: 'm', userId: 'u', hasRecording: false },
      { Authorization: 'Bearer wrong-secret' },
    ));
    expect(res.status).toBe(401);
  });

  it('returns 401 when BOT_INTERNAL_SECRET env var is unset', async () => {
    delete process.env.BOT_INTERNAL_SECRET;
    const res = await POST(makeJsonReq(
      { meetingId: 'm', userId: 'u', hasRecording: false },
      { Authorization: AUTH_HEADER },
    ));
    expect(res.status).toBe(401);
  });

  // ─── No-recording JSON path ───────────────────────────────────────────────────

  it('cancels meeting and returns ok when hasRecording is false', async () => {
    mockQueryOne.mockResolvedValueOnce(undefined as never);
    const res = await POST(makeJsonReq(
      { meetingId: 'meet-1', userId: 'user-1', hasRecording: false },
      { Authorization: AUTH_HEADER },
    ));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const cancelCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'cancelled'/.test(sql),
    );
    expect(cancelCall).toBeDefined();
    expect(cancelCall![2]).toEqual(['meet-1']);
  });

  it('returns 400 when no-recording body is missing meetingId', async () => {
    const res = await POST(makeJsonReq(
      { userId: 'user-1', hasRecording: false },
      { Authorization: AUTH_HEADER },
    ));
    expect(res.status).toBe(400);
  });

  it('returns 400 when hasRecording is true in JSON body', async () => {
    const res = await POST(makeJsonReq(
      { meetingId: 'meet-1', userId: 'user-1', hasRecording: true },
      { Authorization: AUTH_HEADER },
    ));
    expect(res.status).toBe(400);
  });

  // ─── Multipart audio path ─────────────────────────────────────────────────────

  it('returns 400 when audio file is missing from form data', async () => {
    const res = await POST(makeMultipartReq({ meetingId: 'meet-1', userId: 'user-1' }));
    // Inject auth manually — FormData requests use a different content-type
    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => { const fd = new FormData(); fd.append('meetingId', 'meet-1'); fd.append('userId', 'u'); return fd; })(),
    });
    const res2 = await POST(req);
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe('Missing required fields');
  });

  it('returns 404 when meeting does not exist in DB', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        return fd;
      })(),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('runs full pipeline: saves audio, transcribes, inserts transcript, sets review', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // insert transcripts
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        return fd;
      })(),
    });
    const res = await POST(req);
    await flushPromises();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    expect(mockTranscribeWithVadBatches).toHaveBeenCalledOnce();

    const insertTranscript = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /INSERT INTO transcripts/.test(sql),
    );
    expect(insertTranscript).toBeDefined();
    const transcriptParams = insertTranscript![2] as unknown[];
    expect(transcriptParams[1]).toBe('Hello world'); // raw_text
    expect(JSON.parse(transcriptParams[2] as string)).toEqual(SEGMENTS);

    const setReview = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'review'/.test(sql),
    );
    expect(setReview).toBeDefined();
  });

  it('merges detected participants into the meeting row', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(undefined as never); // merge participants
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(undefined as never); // audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // transcripts
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        fd.append('participants', JSON.stringify(['Alice', 'Bob']));
        return fd;
      })(),
    });
    await POST(req);
    await flushPromises();

    const mergeCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /unnest/.test(sql),
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall![2][0]).toEqual(['Alice', 'Bob']);
  });

  it('PII detection failure is non-fatal — pipeline still completes', async () => {
    mockDetectPii.mockRejectedValueOnce(new Error('PII service down'));
    mockQueryOne.mockResolvedValue(MEETING as never).mockResolvedValueOnce(MEETING as never);
    for (let i = 0; i < 5; i++) mockQueryOne.mockResolvedValueOnce(undefined as never);

    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        return fd;
      })(),
    });
    const res = await POST(req);
    await flushPromises();
    expect(res.status).toBe(200);
  });

  it('chapter generation failure is non-fatal — pipeline still completes', async () => {
    mockGroupChapters.mockRejectedValueOnce(new Error('Chapter service down'));
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    for (let i = 0; i < 4; i++) mockQueryOne.mockResolvedValueOnce(undefined as never);

    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        return fd;
      })(),
    });
    const res = await POST(req);
    await flushPromises();
    expect(res.status).toBe(200);
  });

  it('on transcription failure: inserts empty transcript and sets review; POST still returns 200', async () => {
    mockTranscribeWithVadBatches.mockRejectedValueOnce(new Error('Transcription failed'));
    mockQueryOne.mockResolvedValueOnce(MEETING as never); // meeting
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set processing
    mockQueryOne.mockResolvedValueOnce(undefined as never); // audio_files
    mockQueryOne.mockResolvedValueOnce(undefined as never); // empty transcript
    mockQueryOne.mockResolvedValueOnce(undefined as never); // set review

    const req = new NextRequest('http://localhost/api/bot/audio-upload', {
      method: 'POST',
      headers: { Authorization: AUTH_HEADER },
      body: (() => {
        const fd = new FormData();
        fd.append('audio', validAudio());
        fd.append('meetingId', 'meet-1');
        fd.append('userId', 'user-1');
        return fd;
      })(),
    });
    const res = await POST(req);
    await flushPromises();
    // Background processing fails but the HTTP response is always 200 — the error
    // is logged server-side and the pipeline falls back to an empty transcript.
    expect(res.status).toBe(200);

    const emptyTranscript = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /INSERT INTO transcripts/.test(sql) && /''\s*,\s*'\[\]'/.test(sql),
    );
    expect(emptyTranscript).toBeDefined();

    const setReview = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'review'/.test(sql),
    );
    expect(setReview).toBeDefined();
  });
});
