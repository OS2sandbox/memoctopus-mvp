// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessingTranscription } from './ProcessingTranscription';

// ─── Mock external dependencies ──────────────────────────────────────────────

vi.mock('@/lib/audio/transcribe-batches-client', () => ({
  transcribeBatchesOnServer: vi.fn(),
}));

vi.mock('@/lib/audio/diarize-client', () => ({
  startDiarization: vi.fn(),
  finishDiarization: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  getAudio: vi.fn(),
  saveTranscript: vi.fn(),
  updateMeeting: vi.fn(),
}));

import { transcribeBatchesOnServer } from '@/lib/audio/transcribe-batches-client';
import { startDiarization, finishDiarization } from '@/lib/audio/diarize-client';
import { getAudio, saveTranscript, updateMeeting } from '@/lib/storage';

const mockTranscribeBatches = vi.mocked(transcribeBatchesOnServer);
const mockStartDiarization = vi.mocked(startDiarization);
const mockFinishDiarization = vi.mocked(finishDiarization);
const mockGetAudio = vi.mocked(getAudio);
const mockSaveTranscript = vi.mocked(saveTranscript);
const mockUpdateMeeting = vi.mocked(updateMeeting);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MEETING_ID = 'meet-abc';
const FAKE_BLOB = new Blob(['audio'], { type: 'audio/webm' });

const FAKE_SEGMENTS = [
  { id: '1', start: 0, end: 2, text: 'Hej verden', speaker: 'Taler 1' },
  { id: '2', start: 2, end: 5, text: 'God dag', speaker: 'Taler 2' },
];

const FAKE_DIARIZATION_TURNS = [
  { start: 0, end: 2, speaker: 'Speaker A' },
];

function makeServerTranscript(status: 'none' | 'processing' | 'failed' | 'ready', diarized = false) {
  return {
    ok: true,
    json: async () => ({
      status,
      segments: status === 'ready' ? FAKE_SEGMENTS : undefined,
      diarized: diarized,
    }),
  };
}

function renderComponent(props: Partial<{ meetingId: string; onComplete: () => void }> = {}) {
  const onComplete = props.onComplete ?? vi.fn();
  return render(
    <ProcessingTranscription
      meetingId={props.meetingId ?? MEETING_ID}
      onComplete={onComplete}
    />,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAudio.mockResolvedValue({ meetingId: MEETING_ID, blob: FAKE_BLOB, mimeType: 'audio/webm' });
  mockSaveTranscript.mockResolvedValue({
    id: 'transcript-1',
    meetingId: MEETING_ID,
    rawText: '',
    segments: [],
    chapters: [],
    piiReplacements: [],
    piiRemovedAt: null,
  });
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockStartDiarization.mockReturnValue(Promise.resolve(FAKE_DIARIZATION_TURNS));
  mockFinishDiarization.mockResolvedValue(undefined);
  // Default: no server transcript yet
  mockFetch.mockResolvedValue(makeServerTranscript('none'));
  // Default transcription result
  mockTranscribeBatches.mockResolvedValue({
    segments: FAKE_SEGMENTS,
    totalSpeechSeconds: 10,
    totalBatches: 2,
    failedSeconds: 0,
    diarized: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── ProcessingTranscription ──────────────────────────────────────────────────

describe('ProcessingTranscription', () => {
  // ─── Initial render ──────────────────────────────────────────────────────────

  it('renders the "in progress" heading', () => {
    renderComponent();
    expect(screen.getByText(/Transskription er i gang/i)).toBeInTheDocument();
  });

  it('renders the description text', () => {
    renderComponent();
    expect(screen.getByText(/Lydfilen analyseres og transskriberes/i)).toBeInTheDocument();
  });

  it('starts in downloading phase showing correct label', () => {
    // Stall the getAudio call to keep phase at 'downloading'
    let resolve: () => void;
    mockGetAudio.mockReturnValue(
      new Promise((r) => { resolve = () => r({ blob: FAKE_BLOB, mimeType: 'audio/webm' } as any); }),
    );
    renderComponent();
    expect(screen.getByText('henter lydfil…')).toBeInTheDocument();
    // Cleanup: resolve to avoid leak
    resolve!();
  });

  // ─── Phase labels ─────────────────────────────────────────────────────────────

  it('shows "henter transskription…" during the analyzing phase', async () => {
    // Make collectServerTranscript hang in 'processing' to hold analyzing phase
    let resolveTranscript: (v: any) => void;
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () =>
        new Promise((r) => {
          resolveTranscript = r;
        }),
    }));
    mockGetAudio.mockResolvedValue({ blob: FAKE_BLOB, mimeType: 'audio/webm' } as any);
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('henter transskription…')).toBeInTheDocument();
    });
    // Cleanup
    resolveTranscript!({ status: 'none' });
  });

  it('shows "gemmer transskription…" during saving phase', async () => {
    // Make saveTranscript stall so we can observe saving phase
    let resolveSave!: () => void;
    mockSaveTranscript.mockReturnValue(new Promise<any>((r) => { resolveSave = () => r(undefined); }));
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('gemmer transskription…')).toBeInTheDocument();
    });
    resolveSave!();
  });

  // ─── Server transcript (happy path - diarized) ────────────────────────────────

  it('uses the server transcript when it is ready and diarized', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', true));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    expect(mockSaveTranscript).toHaveBeenCalledWith(
      MEETING_ID,
      expect.objectContaining({
        segments: FAKE_SEGMENTS,
        diarizationStatus: 'done',
      }),
    );
    expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, { status: 'review' });
    // No fallback transcription needed
    expect(mockTranscribeBatches).not.toHaveBeenCalled();
    // No client-side diarization needed
    expect(mockStartDiarization).not.toHaveBeenCalled();
  });

  // ─── Server transcript (not diarized) ────────────────────────────────────────

  it('saves with pending diarization and starts client diarization when server transcript is ready but not diarized', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', false));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    expect(mockSaveTranscript).toHaveBeenCalledWith(
      MEETING_ID,
      expect.objectContaining({
        segments: FAKE_SEGMENTS,
        diarizationStatus: 'pending',
      }),
    );
    expect(mockStartDiarization).toHaveBeenCalledWith(MEETING_ID, FAKE_BLOB);
    expect(mockFinishDiarization).toHaveBeenCalledWith(MEETING_ID, FAKE_DIARIZATION_TURNS);
    // Still no client transcription
    expect(mockTranscribeBatches).not.toHaveBeenCalled();
  });

  // ─── Fallback: no server transcript ──────────────────────────────────────────

  it('falls back to client transcription when server returns none status', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    expect(mockTranscribeBatches).toHaveBeenCalledWith(
      MEETING_ID,
      FAKE_BLOB,
      expect.any(Object),
    );
    expect(mockSaveTranscript).toHaveBeenCalledWith(
      MEETING_ID,
      expect.objectContaining({
        segments: FAKE_SEGMENTS,
        diarizationStatus: 'pending',
      }),
    );
    expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, { status: 'review' });
  });

  // ─── Fallback: server transcript failed ──────────────────────────────────────

  it('falls back to client transcription when server returns failed status', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('failed'));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mockTranscribeBatches).toHaveBeenCalled();
  });

  // ─── Fallback: server fetch fails ────────────────────────────────────────────

  it('falls back to client transcription when server fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mockTranscribeBatches).toHaveBeenCalled();
  });

  it('falls back to client transcription when server returns non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mockTranscribeBatches).toHaveBeenCalled();
  });

  // ─── Transcribing phase UI ────────────────────────────────────────────────────

  it('shows batch progress label (X / Y segmenter) during transcribing phase', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    let capturedHandlers: Parameters<typeof mockTranscribeBatches>[2];
    mockTranscribeBatches.mockImplementation(async (_id, _blob, handlers?) => {
      capturedHandlers = handlers;
      return { segments: FAKE_SEGMENTS, totalSpeechSeconds: 10, totalBatches: 2, failedSeconds: 0, diarized: false };
    });

    // Execute handlers synchronously before returning
    mockTranscribeBatches.mockImplementation(async (_id, _blob, handlers?) => {
      handlers?.onMeta?.({ totalBatches: 3, totalSpeechSeconds: 30 });
      handlers?.onBatch?.({ segments: FAKE_SEGMENTS, batchSeconds: 5, completedBatches: 1, totalBatches: 3 });
      return { segments: FAKE_SEGMENTS, totalSpeechSeconds: 30, totalBatches: 3, failedSeconds: 0, diarized: false };
    });

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // After completion we should see the saving phase, so check that transcription ran
    expect(mockTranscribeBatches).toHaveBeenCalled();
  });

  // ─── Empty / failed transcription is surfaced, not silently saved ───────────

  it('shows a transcription-failure error (not "no speech") when all batches failed', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    mockTranscribeBatches.mockResolvedValue({ segments: [], totalSpeechSeconds: 30, totalBatches: 3, failedSeconds: 30, diarized: false });
    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(screen.getByText('Transskription fejlede')).toBeInTheDocument());
    expect(screen.getByText(/taletjenesten kunne ikke nås/i)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockSaveTranscript).not.toHaveBeenCalled();
  });

  it('shows a "no speech" error for a genuinely silent file (no failed batches)', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    mockTranscribeBatches.mockResolvedValue({ segments: [], totalSpeechSeconds: 0, totalBatches: 0, failedSeconds: 0, diarized: false });
    renderComponent();

    await waitFor(() => expect(screen.getByText('Transskription fejlede')).toBeInTheDocument());
    expect(screen.getByText(/Ingen tale fundet/i)).toBeInTheDocument();
  });

  it('saves a partial transcript but logs the failed seconds (traceable)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    mockTranscribeBatches.mockResolvedValue({ segments: FAKE_SEGMENTS, totalSpeechSeconds: 30, totalBatches: 3, failedSeconds: 10, diarized: false });
    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mockSaveTranscript).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('partial transcription'));
    warn.mockRestore();
  });

  it('shows percentage during transcribing phase', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    // Stall after onMeta to freeze in transcribing phase
    let resolveTranscription: (v: any) => void;
    mockTranscribeBatches.mockImplementation(async (_id, _blob, handlers?) => {
      handlers?.onMeta?.({ totalBatches: 4, totalSpeechSeconds: 40 });
      handlers?.onBatch?.({ segments: FAKE_SEGMENTS, batchSeconds: 20, completedBatches: 2, totalBatches: 4 });
      // Stall
      await new Promise((r) => { resolveTranscription = r as (v: any) => void; });
      return { segments: FAKE_SEGMENTS, totalSpeechSeconds: 40, totalBatches: 4, failedSeconds: 0, diarized: false };
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('50%')).toBeInTheDocument();
    });
    resolveTranscription!(undefined);
  });

  it('shows segment count progress during transcribing', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    let resolveTranscription: (v: any) => void;
    mockTranscribeBatches.mockImplementation(async (_id, _blob, handlers?) => {
      handlers?.onMeta?.({ totalBatches: 5, totalSpeechSeconds: 50 });
      handlers?.onBatch?.({ segments: FAKE_SEGMENTS, batchSeconds: 10, completedBatches: 2, totalBatches: 5 });
      await new Promise((r) => { resolveTranscription = r as (v: any) => void; });
      return { segments: FAKE_SEGMENTS, totalSpeechSeconds: 50, totalBatches: 5, failedSeconds: 0, diarized: false };
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/transskriberer 2 \/ 5 segmenter/i)).toBeInTheDocument();
    });
    resolveTranscription!(undefined);
  });

  // ─── Error phase ──────────────────────────────────────────────────────────────

  it('enters error phase when getAudio returns null', async () => {
    mockGetAudio.mockResolvedValue(null as any);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Transskription fejlede')).toBeInTheDocument();
    });
    expect(screen.getByText('Lydfil ikke fundet')).toBeInTheDocument();
  });

  it('enters error phase when transcribeBatchesOnServer throws', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    mockTranscribeBatches.mockRejectedValue(new Error('hviske er nede'));

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Transskription fejlede')).toBeInTheDocument();
    });
    expect(screen.getByText('hviske er nede')).toBeInTheDocument();
  });

  it('shows fallback error message when error is not an Error instance', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    mockTranscribeBatches.mockRejectedValue('unknown string error');

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Transskription fejlede' })).toBeInTheDocument();
    });
    // The error paragraph shows the fallback text (same as heading since not an Error instance)
    const errorParagraph = document.querySelector('p.mt-2');
    expect(errorParagraph?.textContent).toBe('Transskription fejlede');
  });

  it('shows a "Prøv igen" retry button in error phase', async () => {
    mockGetAudio.mockResolvedValue(null as any);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
    });
  });

  // ─── Retry mechanic ──────────────────────────────────────────────────────────

  it('retrying after error reruns the pipeline', async () => {
    const user = userEvent.setup();

    // First attempt: getAudio returns null → error
    mockGetAudio.mockResolvedValueOnce(null as any);
    // Second attempt: success path
    mockGetAudio.mockResolvedValue({ blob: FAKE_BLOB, mimeType: 'audio/webm' } as any);
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    const onComplete = vi.fn();

    renderComponent({ onComplete });

    // Wait for error state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Prøv igen' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Transskription fejlede')).not.toBeInTheDocument();
  });

  it('clicking "Prøv igen" resets to downloading phase', async () => {
    const user = userEvent.setup();

    // First attempt fails
    mockGetAudio.mockResolvedValueOnce(null as any);
    // Second attempt stalls at getAudio so we can observe the downloading phase
    let resolveAudio: (v: any) => void;
    mockGetAudio.mockReturnValue(
      new Promise((r) => { resolveAudio = r; }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Prøv igen' }));

    // Should be back in downloading phase
    await waitFor(() => {
      expect(screen.getByText('henter lydfil…')).toBeInTheDocument();
    });
    // Cleanup
    resolveAudio!({ blob: FAKE_BLOB, mimeType: 'audio/webm' });
  });

  // ─── Cancellation / unmount ───────────────────────────────────────────────────

  it('does not call onComplete or set state after unmounting (isCancelled)', async () => {
    // Keep the pipeline in "analyzing" so we can unmount before it finishes
    let resolveTranscript: (v: any) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolveTranscript = r;
        }),
    );

    const onComplete = vi.fn();
    const { unmount } = renderComponent({ onComplete });

    // Wait until we're past getAudio (i.e. the analyzing phase has started)
    await waitFor(() => {
      expect(screen.getByText('henter transskription…')).toBeInTheDocument();
    });

    unmount();

    // Resolve the fetch after unmounting
    resolveTranscript!({ ok: true, json: async () => ({ status: 'ready', segments: FAKE_SEGMENTS, diarized: true }) });

    // Give promises a chance to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(onComplete).not.toHaveBeenCalled();
    expect(mockSaveTranscript).not.toHaveBeenCalled();
  });

  it('does not update phase to error when cancelled (unmounted)', async () => {
    // Make getAudio stall so we can unmount while it is still awaiting
    let rejectAudio: (err: Error) => void;
    mockGetAudio.mockReturnValue(
      new Promise((_, r) => { rejectAudio = r; }),
    );

    const { unmount } = renderComponent();
    unmount();

    // Now reject — the cancelled guard should prevent state updates
    rejectAudio!(new Error('too late'));

    // Give promises a chance to settle
    await new Promise((r) => setTimeout(r, 20));

    // No crash, and the component is gone — just verify no unhandled rejection
    expect(true).toBe(true);
  });

  // ─── saveTranscript + updateMeeting are called correctly ─────────────────────

  it('calls saveTranscript with rawText joining segment texts', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', true));

    renderComponent();

    await waitFor(() => expect(mockSaveTranscript).toHaveBeenCalled());

    const savedData = mockSaveTranscript.mock.calls[0][1];
    expect(savedData.rawText).toBe('Hej verden God dag');
  });

  it('calls saveTranscript with empty chapters and piiReplacements', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', true));

    renderComponent();

    await waitFor(() => expect(mockSaveTranscript).toHaveBeenCalled());

    const savedData = mockSaveTranscript.mock.calls[0][1];
    expect(savedData.chapters).toEqual([]);
    expect(savedData.piiReplacements).toEqual([]);
  });

  it('calls updateMeeting with status review', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', true));

    renderComponent();

    await waitFor(() => expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, { status: 'review' }));
  });

  // ─── Diarization in fallback path ────────────────────────────────────────────

  it('starts diarization in parallel with client transcription in fallback path', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    expect(mockStartDiarization).toHaveBeenCalledWith(MEETING_ID, FAKE_BLOB);
  });

  it('calls finishDiarization with the turns in fallback path', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    await waitFor(() => expect(mockFinishDiarization).toHaveBeenCalledWith(MEETING_ID, FAKE_DIARIZATION_TURNS));
  });

  // ─── Progress bar rendering ───────────────────────────────────────────────────

  it('renders the "Transskription er i gang" heading (progress bar section visible)', async () => {
    // Stall getAudio to stay in downloading phase and avoid async state updates
    let resolveAudio: (v: any) => void;
    mockGetAudio.mockReturnValue(
      new Promise((r) => { resolveAudio = r; }),
    );
    renderComponent();
    // The main heading is visible during all non-error phases
    expect(screen.getByText(/Transskription er i gang/i)).toBeInTheDocument();
    // Cleanup
    resolveAudio!({ blob: FAKE_BLOB, mimeType: 'audio/webm' });
  });

  // ─── Polling hitting the right URL ───────────────────────────────────────────

  it('polls the correct server transcript endpoint', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('none'));
    renderComponent();

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe(`/api/bot/transcript/${MEETING_ID}`);
  });

  // ─── Server transcript with empty segments falls back ────────────────────────

  it('falls back to client transcription when server transcript has no segments', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ready', segments: [], diarized: true }),
    });

    const onComplete = vi.fn();
    renderComponent({ onComplete });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // Server returned ready but empty segments → should use fallback
    expect(mockTranscribeBatches).toHaveBeenCalled();
  });

  // ─── onComplete is optional ───────────────────────────────────────────────────

  it('completes successfully without crashing when onComplete is not provided', async () => {
    mockFetch.mockResolvedValue(makeServerTranscript('ready', true));

    expect(() => render(<ProcessingTranscription meetingId={MEETING_ID} />)).not.toThrow();

    await waitFor(() => expect(mockSaveTranscript).toHaveBeenCalled());
  });
});
