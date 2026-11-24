// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const saveAudio = vi.hoisted(() => vi.fn());
vi.mock('@/lib/storage/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/audio')>()),
  saveAudio,
}));

import { useNoteRecorder } from './use-note-recorder';

const stopTrack = vi.fn();

// Hands over everything recorded as one chunk when stopped, like a recorder started
// with a timeslice that has not yet flushed.
// Like a real one, it throws when stopped a second time.
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static last: FakeMediaRecorder | null = null;
  mimeType = 'audio/webm';
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') throw new DOMException('already stopped', 'InvalidStateError');
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['lyd'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

// The transcribe-batches route's NDJSON stream, fed line by line by the test.
function ndjsonResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    send: (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(),
  };
}

const seg = (text: string, start: number) => ({ speaker: 'Taler 1', start, end: start + 2, text });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useNoteRecorder', () => {
  it('transcribes the recording on stop, showing the text in order as it arrives, and keeps no audio', async () => {
    const stream = ndjsonResponse();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useNoteRecorder('note-1'));

    await act(() => result.current.start());
    expect(result.current.state).toBe('recording');

    let finished!: Promise<string>;
    act(() => {
      finished = result.current.stop();
    });
    await waitFor(() => expect(result.current.state).toBe('transcribing'));
    expect(stopTrack).toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/note-1/transcribe-batches');
    const audio = (init.body as FormData).get('audio') as Blob;
    expect(await audio.text()).toBe('lyd');

    // The later batch finishes first; the text still reads in spoken order.
    stream.send({ type: 'meta', totalBatches: 2, totalSpeechSeconds: 54 });
    stream.send({ type: 'batch', segments: [seg('verden', 27)], batchSeconds: 27, completedBatches: 1, totalBatches: 2 });
    await waitFor(() => expect(result.current.text).toBe('verden'));
    stream.send({ type: 'batch', segments: [seg('Hej', 0)], batchSeconds: 27, completedBatches: 2, totalBatches: 2 });
    await waitFor(() => expect(result.current.text).toBe('Hej verden'));
    stream.send({ type: 'done', segments: [seg('Hej', 0), seg('verden', 27)], failedSeconds: 0 });
    stream.close();

    await act(async () => {
      expect(await finished).toBe('Hej verden');
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it('reports a failed transcription and hands back no text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, body: null } as unknown as Response);
    const { result } = renderHook(() => useNoteRecorder('note-1'));

    await act(() => result.current.start());
    let text: string | undefined;
    await act(async () => {
      text = await result.current.stop();
    });

    expect(text).toBe('');
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toMatch(/kunne ikke transskriberes/);
  });

  it('transcribes what was recorded when the recorder stopped by itself because the microphone went away', async () => {
    const stream = ndjsonResponse();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useNoteRecorder('note-1'));
    await act(() => result.current.start());

    // A MediaRecorder stops itself when its track ends.
    FakeMediaRecorder.last!.stop();

    let finished!: Promise<string>;
    act(() => {
      finished = result.current.stop();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(stopTrack).toHaveBeenCalled();
    expect(await ((fetchMock.mock.calls[0][1].body as FormData).get('audio') as Blob).text()).toBe('lyd');
    stream.send({ type: 'done', segments: [seg('Hej', 0)], failedSeconds: 0 });
    stream.close();

    await act(async () => {
      expect(await finished).toBe('Hej');
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('releases the microphone and reports the lost take when the recorder cannot be stopped', async () => {
    const { result } = renderHook(() => useNoteRecorder('note-1'));
    await act(() => result.current.start());
    FakeMediaRecorder.last!.stop = () => {
      throw new DOMException('broken', 'UnknownError');
    };

    let text: string | undefined;
    await act(async () => {
      text = await result.current.stop();
    });

    expect(text).toBe('');
    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toMatch(/er ikke gemt/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to start without microphone access', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('nej', 'NotAllowedError'));
    const { result } = renderHook(() => useNoteRecorder('note-1'));

    await act(() => result.current.start());

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toMatch(/mikrofon/);
  });
});
