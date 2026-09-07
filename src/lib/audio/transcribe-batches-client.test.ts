import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribeBatchesOnServer } from './transcribe-batches-client';
import type { TranscribeMeta, TranscribeBatchUpdate } from './transcribe-batches-client';
import type { TranscriptSegment } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seg(start: number, end: number, text = 'x', speaker = 'Taler 1'): TranscriptSegment {
  return { speaker, start, end, text };
}

/** Encode an array of StreamEvent objects as an NDJSON ReadableStream. */
function ndjsonStream(events: object[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * Encode events in chunks to simulate partial/chunked NDJSON delivery.
 * `chunkSize` is the number of UTF-8 bytes per chunk.
 */
function chunkedStream(events: object[], chunkSize: number): ReadableStream<Uint8Array> {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      while (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }
      controller.close();
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, body: null } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Standard event fixtures
// ---------------------------------------------------------------------------

const META_EVENT = { type: 'meta', totalBatches: 3, totalSpeechSeconds: 90 };
const BATCH1_EVENT = {
  type: 'batch',
  segments: [seg(0, 10)],
  batchSeconds: 30,
  completedBatches: 1,
  totalBatches: 3,
};
const BATCH2_EVENT = {
  type: 'batch',
  segments: [seg(10, 20)],
  batchSeconds: 30,
  completedBatches: 2,
  totalBatches: 3,
};
const DONE_EVENT = {
  type: 'done',
  segments: [seg(0, 10), seg(10, 20)],
  failedSeconds: 0,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AUDIO_BLOB = new Blob([new Uint8Array(512)], { type: 'audio/webm' });
const MEETING_ID = 'meet-abc123';

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

describe('request construction', () => {
  it('POSTs to the correct endpoint with the audio blob in FormData', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/meetings/${MEETING_ID}/transcribe-batches`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    const fd = init.body as FormData;
    const audioEntry = fd.get('audio');
    expect(audioEntry).toBeInstanceOf(Blob);
  });

  it('uses POST even when no handlers are provided', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// Happy path — full stream
// ---------------------------------------------------------------------------

describe('full stream (meta → batches → done)', () => {
  it('returns segments, totalSpeechSeconds, totalBatches, and failedSeconds from the stream', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, BATCH1_EVENT, BATCH2_EVENT, DONE_EVENT])),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.segments).toEqual(DONE_EVENT.segments);
    expect(result.totalSpeechSeconds).toBe(90);
    expect(result.totalBatches).toBe(3);
    expect(result.failedSeconds).toBe(0);
  });

  it('returns the done-event segments (not the aggregated batch segments)', async () => {
    // The server is the single source of truth for the final segments list.
    const finalSegments = [seg(0, 5, 'final'), seg(5, 15, 'final')];
    const doneEvent = { type: 'done', segments: finalSegments, failedSeconds: 2 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, BATCH1_EVENT, doneEvent])),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.segments).toEqual(finalSegments);
    expect(result.failedSeconds).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// onMeta callback
// ---------------------------------------------------------------------------

describe('onMeta callback', () => {
  it('calls onMeta with totalBatches and totalSpeechSeconds when the meta event arrives', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    const onMeta = vi.fn<(meta: TranscribeMeta) => void>();
    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onMeta });

    expect(onMeta).toHaveBeenCalledOnce();
    expect(onMeta).toHaveBeenCalledWith({
      totalBatches: 3,
      totalSpeechSeconds: 90,
    });
  });

  it('does not throw when onMeta handler is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, {}),
    ).resolves.not.toThrow();
  });

  it('does not throw when no handlers object is provided', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onBatch callback
// ---------------------------------------------------------------------------

describe('onBatch callback', () => {
  it('calls onBatch once per batch event in stream order', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, BATCH1_EVENT, BATCH2_EVENT, DONE_EVENT])),
    );

    const onBatch = vi.fn<(update: TranscribeBatchUpdate) => void>();
    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onBatch });

    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(onBatch.mock.calls[0][0]).toMatchObject({
      completedBatches: 1,
      batchSeconds: 30,
      segments: [seg(0, 10)],
    });
    expect(onBatch.mock.calls[1][0]).toMatchObject({
      completedBatches: 2,
      batchSeconds: 30,
      segments: [seg(10, 20)],
    });
  });

  it('does not call onBatch when there are no batch events', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, DONE_EVENT])),
    );

    const onBatch = vi.fn();
    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onBatch });

    expect(onBatch).not.toHaveBeenCalled();
  });

  it('aggregates segment arrays across multiple batches in order via callbacks', async () => {
    const seg1 = seg(0, 5, 'first');
    const seg2 = seg(5, 10, 'second');
    const seg3 = seg(10, 15, 'third');

    const batch1 = { type: 'batch', segments: [seg1], batchSeconds: 15, completedBatches: 1, totalBatches: 2 };
    const batch2 = { type: 'batch', segments: [seg2, seg3], batchSeconds: 15, completedBatches: 2, totalBatches: 2 };
    const done = { type: 'done', segments: [seg1, seg2, seg3], failedSeconds: 0 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([{ type: 'meta', totalBatches: 2, totalSpeechSeconds: 30 }, batch1, batch2, done])),
    );

    const received: TranscriptSegment[][] = [];
    await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, {
      onBatch: (u) => received.push(u.segments),
    });

    expect(received[0]).toEqual([seg1]);
    expect(received[1]).toEqual([seg2, seg3]);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('server/HTTP errors', () => {
  it('throws when the server responds with a non-ok status', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow('500');
  });

  it('throws when the response has a 401 status', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401));

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow('401');
  });

  it('throws when the response body is null (no body from server)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, body: null } as unknown as Response);

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow();
  });

  it('propagates a stream error event as a thrown Error', async () => {
    const errorEvent = { type: 'error', message: 'Server ran out of memory' };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, errorEvent])),
    );

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow('Server ran out of memory');
  });

  it('throws when the stream ends without a done event (abrupt disconnect)', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, BATCH1_EVENT])), // no done
    );

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow('afbrudt');
  });

  it('throws when the stream is completely empty (no events at all)', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([])),
    );

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow();
  });

  it('throws when fetch itself rejects (network failure)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Chunked / partial NDJSON delivery
// ---------------------------------------------------------------------------

describe('chunked NDJSON handling', () => {
  it('correctly parses NDJSON when each event arrives in its own 1-byte chunk', async () => {
    const events = [META_EVENT, BATCH1_EVENT, DONE_EVENT];

    mockFetch.mockResolvedValueOnce(
      okResponse(chunkedStream(events, 1)),
    );

    const onMeta = vi.fn();
    const onBatch = vi.fn();
    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onMeta, onBatch });

    expect(onMeta).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledOnce();
    expect(result.totalBatches).toBe(3);
    expect(result.segments).toEqual(DONE_EVENT.segments);
  });

  it('handles chunks that split across NDJSON newlines (partial records)', async () => {
    const events = [META_EVENT, BATCH1_EVENT, BATCH2_EVENT, DONE_EVENT];

    // Small chunks of 5 bytes will split across JSON object boundaries.
    mockFetch.mockResolvedValueOnce(
      okResponse(chunkedStream(events, 5)),
    );

    const onBatch = vi.fn();
    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onBatch });

    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(result.segments).toEqual(DONE_EVENT.segments);
  });

  it('handles events split across many small chunks (12-byte chunks)', async () => {
    const events = [META_EVENT, BATCH1_EVENT, DONE_EVENT];

    mockFetch.mockResolvedValueOnce(
      okResponse(chunkedStream(events, 12)),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.totalSpeechSeconds).toBe(90);
    expect(result.totalBatches).toBe(3);
    expect(result.failedSeconds).toBe(0);
  });

  it('handles a done event that arrives at the tail of the buffer without a trailing newline', async () => {
    // Build a stream where the last line has NO trailing newline — the handleLine
    // call after the read loop should catch it.
    const lines = [META_EVENT, DONE_EVENT].map((e) => JSON.stringify(e)).join('\n');
    // Deliberately no trailing '\n':
    const bytes = new TextEncoder().encode(lines);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(okResponse(stream));

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.totalSpeechSeconds).toBe(90);
    expect(result.segments).toEqual(DONE_EVENT.segments);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('ignores blank/empty NDJSON lines without throwing', async () => {
    // Insert an empty line between events (some servers emit these as keep-alives).
    const text = [
      JSON.stringify(META_EVENT),
      '',
      '   ',
      JSON.stringify(DONE_EVENT),
    ].join('\n') + '\n';

    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(okResponse(stream));

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.totalBatches).toBe(3);
    expect(result.segments).toEqual(DONE_EVENT.segments);
  });

  it('returns failedSeconds from the done event when some batches failed', async () => {
    const doneWithFailures = { type: 'done', segments: [seg(0, 5)], failedSeconds: 15 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, doneWithFailures])),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.failedSeconds).toBe(15);
  });

  it('handles a done event with an empty segments array (silent recording)', async () => {
    const silentDone = { type: 'done', segments: [], failedSeconds: 0 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([{ type: 'meta', totalBatches: 1, totalSpeechSeconds: 0 }, silentDone])),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.segments).toEqual([]);
    expect(result.totalSpeechSeconds).toBe(0);
    expect(result.totalBatches).toBe(1);
  });

  it('uses default meta (0 batches, 0 speech seconds) when no meta event is present', async () => {
    // Only a done event — the meta event is optional in practice.
    const justDone = { type: 'done', segments: [seg(0, 5)], failedSeconds: 0 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([justDone])),
    );

    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB);

    expect(result.totalBatches).toBe(0);
    expect(result.totalSpeechSeconds).toBe(0);
    expect(result.segments).toEqual([seg(0, 5)]);
  });

  it('handles multiple meta events by using the last one', async () => {
    const meta2 = { type: 'meta', totalBatches: 5, totalSpeechSeconds: 150 };

    mockFetch.mockResolvedValueOnce(
      okResponse(ndjsonStream([META_EVENT, meta2, DONE_EVENT])),
    );

    const onMeta = vi.fn();
    const result = await transcribeBatchesOnServer(MEETING_ID, AUDIO_BLOB, { onMeta });

    // The last meta event should win in the returned result.
    expect(result.totalBatches).toBe(5);
    expect(result.totalSpeechSeconds).toBe(150);
    // onMeta should have been called twice.
    expect(onMeta).toHaveBeenCalledTimes(2);
  });
});
