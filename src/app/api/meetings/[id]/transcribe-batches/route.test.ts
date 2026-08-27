import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockPrepare = vi.hoisted(() => vi.fn());
const mockTranscribe = vi.hoisted(() => vi.fn());
const mockEnsemble = vi.hoisted(() => vi.fn());
const mockIsEnsemble = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/lib/audio/vad-batch-server', () => ({
  prepareVadBatches: mockPrepare,
  transcribeVadBatches: mockTranscribe,
  transcribeEnsemble: mockEnsemble,
  isEnsembleDiarization: mockIsEnsemble,
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/transcribe-batches';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

function makeAudioRequest(byteLength: number, mimeType = 'audio/webm'): NextRequest {
  const buffer = Buffer.alloc(byteLength, 0x01);
  const file = new File([buffer], 'recording.webm', { type: mimeType });
  const formData = new FormData();
  formData.append('audio', file);
  return new NextRequest(BASE_URL, { method: 'POST', body: formData });
}

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const FAKE_BATCH = { wav: new Blob(['x']), intervals: [], totalWavDuration: 27 };

beforeEach(() => {
  mockGetSession.mockReset();
  mockPrepare.mockReset();
  mockTranscribe.mockReset();
  mockEnsemble.mockReset();
  mockIsEnsemble.mockReset().mockReturnValue(false);
});

describe('POST /api/meetings/[id]/transcribe-batches', () => {
  it('returns 401 when no session exists', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeAudioRequest(5_000), PARAMS);
    expect(res.status).toBe(401);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('returns 400 when audio field is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(new NextRequest(BASE_URL, { method: 'POST', body: new FormData() }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('returns 400 for audio smaller than 2 000 bytes', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeAudioRequest(1_999), PARAMS);
    expect(res.status).toBe(400);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('streams meta, per-batch progress, and the final sorted segments as NDJSON', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 5, text: 'hej' },
      { speaker: 'Taler 1', start: 5, end: 9, text: 'med dig' },
    ];
    mockPrepare.mockResolvedValueOnce([FAKE_BATCH, FAKE_BATCH]);
    mockTranscribe.mockImplementationOnce(async (batches, onBatch) => {
      onBatch?.({ segments: [segments[0]], batchSeconds: 27, completedBatches: 1, totalBatches: 2, failed: false });
      onBatch?.({ segments: [segments[1]], batchSeconds: 27, completedBatches: 2, totalBatches: 2, failed: false });
      return { segments, totalBatches: 2, totalSpeechSeconds: 54, failedSeconds: 0 };
    });

    const res = await POST(makeAudioRequest(5_000), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');

    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: 'meta', totalBatches: 2, totalSpeechSeconds: 54 });
    expect(events[1]).toMatchObject({ type: 'batch', completedBatches: 1, totalBatches: 2 });
    expect(events[2]).toMatchObject({ type: 'batch', completedBatches: 2 });
    expect(events[3]).toMatchObject({ type: 'done', segments, failedSeconds: 0 });
  });

  it('streams an error event when decoding fails (no thrown 500)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockPrepare.mockRejectedValueOnce(new Error('ffmpeg exited 1: bad data'));

    const res = await POST(makeAudioRequest(5_000), PARAMS);
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('reports zero batches for silent audio via meta + done', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockPrepare.mockResolvedValueOnce([]);
    mockTranscribe.mockResolvedValueOnce({ segments: [], totalBatches: 0, totalSpeechSeconds: 0, failedSeconds: 0 });

    const res = await POST(makeAudioRequest(5_000), PARAMS);
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: 'meta', totalBatches: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'done', segments: [] });
  });

  it('ensemble mode: emits diarized segments from one call, skipping VAD batching', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockIsEnsemble.mockReturnValue(true);
    mockEnsemble.mockResolvedValueOnce([
      { speaker: 'Taler 1', start: 0, end: 3, text: 'hej' },
      { speaker: 'Taler 2', start: 3, end: 6, text: 'dav' },
    ]);

    const res = await POST(makeAudioRequest(5_000), PARAMS);
    const events = await readEvents(res);

    expect(mockEnsemble).toHaveBeenCalledOnce();
    expect(mockPrepare).not.toHaveBeenCalled();
    const done = events.at(-1) as Record<string, unknown>;
    expect(done).toMatchObject({ type: 'done', diarized: true });
    expect((done.segments as unknown[]).length).toBe(2);
  });
});
