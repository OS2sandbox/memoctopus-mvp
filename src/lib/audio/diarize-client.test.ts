import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetTranscript = vi.hoisted(() => vi.fn());
const mockSaveSegments = vi.hoisted(() => vi.fn());
const mockNotify = vi.hoisted(() => vi.fn());

vi.mock('@/lib/storage', () => ({
  getTranscript: mockGetTranscript,
  saveTranscriptSegments: mockSaveSegments,
}));
vi.mock('@/lib/transcript-events', () => ({ notifyTranscriptUpdated: mockNotify }));

import {
  fetchDiarizationTurns,
  startDiarization,
  finishDiarization,
  ensureDiarization,
  isDiarizationInFlight,
} from './diarize-client';
import type { SpeakerTurn } from '@/lib/ai/diarization';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  mockGetTranscript.mockReset();
  mockSaveSegments.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const wav = new Blob([new Uint8Array(3000)], { type: 'audio/wav' });
const TALER1 = 'Taler 1';
const seg = (start: number, end: number, speaker = TALER1) => ({ speaker, start, end, text: 'x' });

describe('fetchDiarizationTurns', () => {
  it('POSTs the WAV to the diarize route and returns the turns', async () => {
    const turns = [{ speaker: 'SPEAKER_00', start: 0, end: 2 }];
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns }));

    const result = await fetchDiarizationTurns('meet-1', wav);

    expect(result).toEqual(turns);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/meetings/meet-1/diarize');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('fails soft to [] when the response is not ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });

  it('fails soft to [] when turns is missing or not an array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: null }));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });

  it('fails soft to [] when the request throws (service/tunnel down)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });
});

describe('diarization lifecycle (start / finish / ensure)', () => {
  const TURNS: SpeakerTurn[] = [
    { speaker: 'SPEAKER_00', start: 0, end: 5 },
    { speaker: 'SPEAKER_01', start: 5, end: 10 },
  ];

  it('startDiarization marks the meeting in-flight; finishDiarization clears it', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));
    mockGetTranscript.mockResolvedValueOnce({ segments: [seg(0, 5)], rawText: 'x' });

    const p = startDiarization('m-life', wav);
    expect(isDiarizationInFlight('m-life')).toBe(true);
    await finishDiarization('m-life', await p);
    expect(isDiarizationInFlight('m-life')).toBe(false);
  });

  it('finishDiarization merges speaker labels and marks status done', async () => {
    mockGetTranscript.mockResolvedValueOnce({
      segments: [seg(0, 5), seg(6, 10)],
      rawText: 'x x',
    });

    await finishDiarization('m1', TURNS);

    expect(mockSaveSegments).toHaveBeenCalledOnce();
    const [meetingId, segments, status] = mockSaveSegments.mock.calls[0];
    expect(meetingId).toBe('m1');
    expect(status).toBe('done');
    // Two distinct speakers assigned from the turns.
    expect(new Set(segments.map((s: { speaker: string }) => s.speaker)).size).toBe(2);
    expect(mockNotify).toHaveBeenCalledWith('m1');
  });

  it('finishDiarization clears the pending state to done even with zero turns', async () => {
    const segs = [seg(0, 5)];
    mockGetTranscript.mockResolvedValueOnce({ segments: segs, rawText: 'x' });

    await finishDiarization('m2', []);

    const [, savedSegments, status] = mockSaveSegments.mock.calls[0];
    expect(status).toBe('done');
    expect(savedSegments).toEqual(segs); // unchanged labels
    expect(mockNotify).toHaveBeenCalledWith('m2');
  });

  it('finishDiarization never clobbers manually relabelled speakers', async () => {
    const segs = [seg(0, 5, 'Anna'), seg(6, 10, 'Bo')];
    mockGetTranscript.mockResolvedValueOnce({ segments: segs, rawText: 'x x' });

    await finishDiarization('m3', TURNS);

    const [, savedSegments, status] = mockSaveSegments.mock.calls[0];
    expect(savedSegments).toEqual(segs); // user labels preserved
    expect(status).toBe('done'); // but pending still cleared
  });

  it('finishDiarization no-ops (no save) when no transcript is stored yet', async () => {
    mockGetTranscript.mockResolvedValueOnce(null);
    await finishDiarization('m4', TURNS);
    expect(mockSaveSegments).not.toHaveBeenCalled();
  });

  it('ensureDiarization runs a fresh pass when none is in flight', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: TURNS }));
    mockGetTranscript.mockResolvedValueOnce({ segments: [seg(0, 5), seg(6, 10)], rawText: 'x x' });

    await ensureDiarization('m-ensure', wav);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockSaveSegments).toHaveBeenCalledOnce();
    expect(isDiarizationInFlight('m-ensure')).toBe(false);
  });

  it('ensureDiarization no-ops when a pass is already in flight (no double work)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ turns: [] }));
    startDiarization('m-dup', wav); // leaves it in-flight (not finished)
    mockFetch.mockClear();

    await ensureDiarization('m-dup', wav);

    expect(mockFetch).not.toHaveBeenCalled();
    // clean up the lingering in-flight marker for other tests
    await finishDiarization('m-dup', []);
  });
});
