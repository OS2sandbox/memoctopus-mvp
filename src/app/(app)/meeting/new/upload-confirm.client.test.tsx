// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UploadConfirmScreen } from './upload-confirm.client';

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/storage
// ---------------------------------------------------------------------------
const mockCreateMeeting = vi.fn();
const mockSaveAudio = vi.fn();
const mockSaveTranscript = vi.fn();
const mockUpdateMeeting = vi.fn();
const mockDeleteMeeting = vi.fn();

vi.mock('@/lib/storage', () => ({
  createMeeting: (...args: unknown[]) => mockCreateMeeting(...args),
  saveAudio: (...args: unknown[]) => mockSaveAudio(...args),
  saveTranscript: (...args: unknown[]) => mockSaveTranscript(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
  deleteMeeting: (...args: unknown[]) => mockDeleteMeeting(...args),
}));

// ---------------------------------------------------------------------------
// Mock transcribe-batches-client
// ---------------------------------------------------------------------------
const mockTranscribeBatchesOnServer = vi.fn();
vi.mock('@/lib/audio/transcribe-batches-client', () => ({
  transcribeBatchesOnServer: (...args: unknown[]) => mockTranscribeBatchesOnServer(...args),
}));

// ---------------------------------------------------------------------------
// Mock diarize-client
// ---------------------------------------------------------------------------
const mockStartDiarization = vi.fn();
const mockFinishDiarization = vi.fn();
vi.mock('@/lib/audio/diarize-client', () => ({
  startDiarization: (...args: unknown[]) => mockStartDiarization(...args),
  finishDiarization: (...args: unknown[]) => mockFinishDiarization(...args),
}));

// ---------------------------------------------------------------------------
// Mock isDefaultSpeakerLabel (used for speaker label rendering in live view)
// ---------------------------------------------------------------------------
vi.mock('@/lib/audio/speaker-labels', () => ({
  isDefaultSpeakerLabel: (label: string) => /^Taler \d+$/.test(label.trim()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a synthetic File with a known name and size. */
function makeFile(name: string, size: number, type = 'audio/mp3'): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type, lastModified: Date.now() });
}

/** Default successful transcription result. */
const DEFAULT_RESULT = {
  segments: [
    { start: 0, end: 5, text: 'Hej verden', speaker: 'Taler 1', confidence: 0.9 },
  ],
  totalSpeechSeconds: 60,
  totalBatches: 3,
  failedSeconds: 0,
};

/** Default meeting created by createMeeting. */
const DEFAULT_MEETING = { id: 'meeting-abc' };

/**
 * Render the component and flush all async effects so the component
 * reaches 'done' (happy path) or 'error' phase.
 */
async function renderAndWaitForDone(file: File) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<UploadConfirmScreen file={file} onCancel={vi.fn()} />);
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Browser API stubs: URL.createObjectURL / URL.revokeObjectURL / Audio
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Stub URL methods
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: vi.fn(),
  });

  // Stub Audio constructor — fires onloadedmetadata immediately with duration=90
  const MockAudio = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.src = '';
    this.onloadedmetadata = null;
    this.onerror = null;
    // Use a setter on src to trigger metadata load immediately
    Object.defineProperty(this, 'src', {
      set(_v: string) {
        // After assigning src, schedule onloadedmetadata on next microtask
        queueMicrotask(() => {
          if (typeof (this as Record<string, unknown>).onloadedmetadata === 'function') {
            (this as Record<string, unknown>).duration = 90;
            ((this as Record<string, unknown>).onloadedmetadata as () => void)();
          }
        });
      },
      get() { return ''; },
      configurable: true,
    });
    this.duration = 90;
  });
  vi.stubGlobal('Audio', MockAudio);

  // Default mock implementations
  mockCreateMeeting.mockResolvedValue(DEFAULT_MEETING);
  mockSaveAudio.mockResolvedValue(undefined);
  mockSaveTranscript.mockResolvedValue(undefined);
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockDeleteMeeting.mockResolvedValue(undefined);
  mockTranscribeBatchesOnServer.mockResolvedValue(DEFAULT_RESULT);
  mockStartDiarization.mockResolvedValue([]);
  mockFinishDiarization.mockResolvedValue(undefined);

  mockPush.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Rendering — file name and size
// ===========================================================================

describe('UploadConfirmScreen — initial rendering', () => {
  it('renders the file name', async () => {
    const file = makeFile('optagelse.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getAllByText('optagelse.mp3').length).toBeGreaterThan(0);
  });

  it('formats size in KB when below 1 MB (e.g. 512 KB)', async () => {
    const file = makeFile('small.mp3', 512 * 1024); // exactly 512 KB
    await renderAndWaitForDone(file);
    expect(screen.getByText('512.0 KB')).toBeInTheDocument();
  });

  it('formats size in MB when at or above 1 MB (e.g. 2.5 MB)', async () => {
    const file = makeFile('big.mp3', Math.round(2.5 * 1024 * 1024)); // 2.5 MB
    await renderAndWaitForDone(file);
    expect(screen.getByText('2.5 MB')).toBeInTheDocument();
  });

  it('formats size right at the KB/MB boundary — 1023 KB is shown as KB', async () => {
    const file = makeFile('boundary.mp3', 1023 * 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText('1023.0 KB')).toBeInTheDocument();
  });

  it('formats size right at the KB/MB boundary — exactly 1 MB shown as MB', async () => {
    const file = makeFile('boundary.mp3', 1024 * 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
  });

  it('renders the file extension', async () => {
    const file = makeFile('meeting.wav', 2048);
    await renderAndWaitForDone(file);
    expect(screen.getByText('wav')).toBeInTheDocument();
  });

  it('renders the "annullér · upload anden fil" cancel button', async () => {
    const file = makeFile('test.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByRole('button', { name: /annullér/i })).toBeInTheDocument();
  });

  it('renders the continue button (disabled while processing)', async () => {
    // Use a never-resolving transcription so we stay in processing
    mockTranscribeBatchesOnServer.mockReturnValue(new Promise(() => {}));
    const file = makeFile('test.mp3', 1024);
    render(<UploadConfirmScreen file={file} onCancel={vi.fn()} />);
    // Wait for the component to start running
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /afventer transskription/i });
      expect(btn).toBeDisabled();
    });
  });
});

// ===========================================================================
// 2. Happy path — confirm creates meeting, saves audio, transcribes, saves transcript
// ===========================================================================

describe('UploadConfirmScreen — happy path (confirm)', () => {
  it('calls createMeeting on mount', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockCreateMeeting).toHaveBeenCalledTimes(1);
  });

  it('calls createMeeting with source:local and status:processing', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockCreateMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'local', status: 'processing' }),
    );
  });

  it('calls saveAudio with the meeting id and file', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockSaveAudio).toHaveBeenCalledWith('meeting-abc', file, file.type || 'audio/webm');
  });

  it('calls transcribeBatchesOnServer with meeting id and file', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockTranscribeBatchesOnServer).toHaveBeenCalledWith(
      'meeting-abc',
      file,
      expect.any(Object),
    );
  });

  it('calls saveTranscript with meeting id after transcription', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockSaveTranscript).toHaveBeenCalledWith(
      'meeting-abc',
      expect.objectContaining({ diarizationStatus: 'pending' }),
    );
  });

  it('calls updateMeeting to set status:review after saving transcript', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockUpdateMeeting).toHaveBeenCalledWith('meeting-abc', { status: 'review' });
  });

  it('shows progress at 100% and "done" label after transcription completes', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText(/transskription færdig/i)).toBeInTheDocument();
  });

  it('enables the continue button once done', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByRole('button', { name: /fortsæt til gennemgang/i })).not.toBeDisabled();
  });

  it('navigates to /meeting/:id/review when continue is clicked', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /fortsæt til gennemgang/i }));
    });
    expect(mockPush).toHaveBeenCalledWith('/meeting/meeting-abc/review');
  });

  it('uses the typed title when navigating', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    fireEvent.change(screen.getByPlaceholderText('Navngiv mødet…'), {
      target: { value: 'Kvartalsreview' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /fortsæt til gennemgang/i }));
    });

    expect(mockUpdateMeeting).toHaveBeenCalledWith(
      'meeting-abc',
      expect.objectContaining({ title: 'Kvartalsreview' }),
    );
    expect(mockPush).toHaveBeenCalledWith('/meeting/meeting-abc/review');
  });

  it('falls back to file name (without extension) when title is empty', async () => {
    const file = makeFile('monthly_sync.mp3', 1024);
    await renderAndWaitForDone(file);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /fortsæt til gennemgang/i }));
    });

    expect(mockUpdateMeeting).toHaveBeenCalledWith(
      'meeting-abc',
      expect.objectContaining({ title: 'monthly_sync' }),
    );
  });
});

// ===========================================================================
// 3. Diarization started/finished around transcription
// ===========================================================================

describe('UploadConfirmScreen — diarization lifecycle', () => {
  it('calls startDiarization with meeting id and file', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(mockStartDiarization).toHaveBeenCalledWith('meeting-abc', file);
  });

  it('calls finishDiarization after transcript is saved', async () => {
    const mockTurns = [{ speaker: 'A', start: 0, end: 5 }];
    mockStartDiarization.mockResolvedValue(mockTurns);
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    // finishDiarization is called via a void promise.then, wait for it
    await waitFor(() => {
      expect(mockFinishDiarization).toHaveBeenCalledWith('meeting-abc', mockTurns);
    });
  });

  it('startDiarization is called before transcription completes (in parallel)', async () => {
    const callOrder: string[] = [];
    // Make transcription slow (but resolve)
    let resolveTranscribe!: (v: typeof DEFAULT_RESULT) => void;
    mockTranscribeBatchesOnServer.mockReturnValueOnce(
      new Promise((r) => { resolveTranscribe = r; }),
    );
    mockStartDiarization.mockImplementation(() => {
      callOrder.push('startDiarization');
      return Promise.resolve([]);
    });

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={vi.fn()} />);

    // startDiarization should be called before transcription resolves
    await waitFor(() => expect(callOrder).toContain('startDiarization'));

    // Now resolve transcription
    await act(async () => {
      resolveTranscribe(DEFAULT_RESULT);
    });
  });
});

// ===========================================================================
// 4. Failure path
// ===========================================================================

describe('UploadConfirmScreen — failure path', () => {
  it('shows error UI when transcription throws', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('server down'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText(/transskription fejlede/i)).toBeInTheDocument();
  });

  it('displays a user-friendly message for unsupported format errors', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('format error'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    // The component wraps transcription errors with a fixed message
    expect(
      screen.getByText(/lydformatet understøttes ikke/i),
    ).toBeInTheDocument();
  });

  it('shows error message for zero-batches result (silent file)', async () => {
    mockTranscribeBatchesOnServer.mockResolvedValue({
      ...DEFAULT_RESULT,
      totalBatches: 0,
      segments: [],
    });
    const file = makeFile('silent.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText(/ingen tale fundet/i)).toBeInTheDocument();
  });

  it('does NOT call deleteMeeting on failure (meeting stays for archival)', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('fail'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    // The source code does NOT delete the meeting on transcription failure —
    // only when the user manually cancels from the error screen.
    expect(mockDeleteMeeting).not.toHaveBeenCalled();
  });

  it('shows the file name and size in the error footer', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('fail'));
    const file = makeFile('broken.mp3', 512 * 1024);
    await renderAndWaitForDone(file);
    // Error footer shows: "fil: <name> (<size>)"
    expect(screen.getByText(/fil: broken\.mp3/)).toBeInTheDocument();
    expect(screen.getByText(/512\.0 KB/)).toBeInTheDocument();
  });

  it('error screen has a "← upload en anden fil" button', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('fail'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByRole('button', { name: /upload en anden fil/i })).toBeInTheDocument();
  });
});

// ===========================================================================
// 5. Cancel behaviour
// ===========================================================================

describe('UploadConfirmScreen — cancel behaviour', () => {
  it('calls onCancel when the cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const file = makeFile('audio.mp3', 1024);
    render(<UploadConfirmScreen file={file} onCancel={onCancel} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /annullér/i }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls deleteMeeting with meeting id when cancel is clicked after meeting was created', async () => {
    const onCancel = vi.fn();

    // Allow the meeting to be created but then stall transcription
    let resolveTranscribe!: (v: typeof DEFAULT_RESULT) => void;
    mockTranscribeBatchesOnServer.mockReturnValueOnce(
      new Promise((r) => { resolveTranscribe = r; }),
    );

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={onCancel} />);

    // Wait for meeting to be created
    await waitFor(() => expect(mockCreateMeeting).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /annullér/i }));
    });

    expect(mockDeleteMeeting).toHaveBeenCalledWith('meeting-abc');
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Cleanup — resolve to avoid unhandled rejection
    resolveTranscribe(DEFAULT_RESULT);
  });

  it('calls onCancel without calling deleteMeeting when no meeting has been created yet', async () => {
    // Stall createMeeting so cancel fires before meeting exists
    let resolveCreate!: (v: typeof DEFAULT_MEETING) => void;
    mockCreateMeeting.mockReturnValueOnce(new Promise((r) => { resolveCreate = r; }));
    const onCancel = vi.fn();

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={onCancel} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /annullér/i }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockDeleteMeeting).not.toHaveBeenCalled();

    // Cleanup
    resolveCreate(DEFAULT_MEETING);
  });

  it('does not navigate to review when cancel is clicked', async () => {
    const onCancel = vi.fn();
    mockTranscribeBatchesOnServer.mockReturnValue(new Promise(() => {}));
    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={onCancel} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /annullér/i }));
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('cancel from error screen also calls onCancel', async () => {
    mockTranscribeBatchesOnServer.mockRejectedValue(new Error('fail'));
    const onCancel = vi.fn();
    const file = makeFile('audio.mp3', 1024);

    render(<UploadConfirmScreen file={file} onCancel={onCancel} />);
    await waitFor(() => screen.getByText(/transskription fejlede/i));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /upload en anden fil/i }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 6. Participant management
// ===========================================================================

describe('UploadConfirmScreen — participant management', () => {
  it('adds a participant when Enter is pressed in the participant input', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('clears the participant input after adding', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((input as HTMLInputElement).value).toBe('');
  });

  it('removes a participant when the × button is clicked', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Charlie' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Charlie')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fjern Charlie' }));
    expect(screen.queryByText('Charlie')).toBeNull();
  });

  it('includes participants in the updateMeeting call on continue', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Diana' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /fortsæt til gennemgang/i }));
    });

    expect(mockUpdateMeeting).toHaveBeenCalledWith(
      'meeting-abc',
      expect.objectContaining({ participants: ['Diana'] }),
    );
  });

  it('does not add a participant when the input is blank', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // No participant chip should appear
    expect(screen.queryByRole('button', { name: /^Fjern/ })).toBeNull();
  });
});

// ===========================================================================
// 7. Progress labels per phase
// ===========================================================================

describe('UploadConfirmScreen — progress labels', () => {
  it('shows "forbereder…" label initially', () => {
    mockTranscribeBatchesOnServer.mockReturnValue(new Promise(() => {}));
    const file = makeFile('audio.mp3', 1024);
    render(<UploadConfirmScreen file={file} onCancel={vi.fn()} />);
    expect(screen.getByText('forbereder…')).toBeInTheDocument();
  });

  it('shows 0% progress initially', () => {
    mockTranscribeBatchesOnServer.mockReturnValue(new Promise(() => {}));
    const file = makeFile('audio.mp3', 1024);
    render(<UploadConfirmScreen file={file} onCancel={vi.fn()} />);
    // The large number "0" followed by "%" in a span
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows 100% and "transskription færdig" when done', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('transskription færdig')).toBeInTheDocument();
  });
});

// ===========================================================================
// 8. Live segment rendering
// ===========================================================================

type BatchSegment = { start: number; end: number; text: string; speaker: string; confidence: number };
type BatchUpdate = {
  segments: BatchSegment[];
  batchSeconds: number;
  completedBatches: number;
  totalBatches: number;
};
type TranscribeHandlers = {
  onMeta?: (meta: { totalBatches: number; totalSpeechSeconds: number }) => void;
  onBatch?: (update: BatchUpdate) => void;
};

/**
 * Creates a controllable transcription mock: the returned promise only resolves
 * when you call `resolve()`. `fireOnBatch` lets you push segments synchronously.
 */
function makeControlledTranscribeMock(resultSegments: BatchSegment[] = DEFAULT_RESULT.segments) {
  let capturedHandlers: TranscribeHandlers = {};
  let resolveTranscribe!: (v: typeof DEFAULT_RESULT) => void;
  const transcribePromise = new Promise<typeof DEFAULT_RESULT>((r) => { resolveTranscribe = r; });

  mockTranscribeBatchesOnServer.mockImplementation(
    async (_id: string, _file: File, handlers: TranscribeHandlers) => {
      capturedHandlers = handlers;
      handlers.onMeta?.({ totalBatches: 2, totalSpeechSeconds: 60 });
      return transcribePromise;
    },
  );

  return {
    fireOnBatch(segments: BatchSegment[]) {
      capturedHandlers.onBatch?.({
        segments,
        batchSeconds: 10,
        completedBatches: 1,
        totalBatches: 2,
      });
    },
    resolve() {
      resolveTranscribe({ ...DEFAULT_RESULT, segments: resultSegments });
    },
  };
}

describe('UploadConfirmScreen — live segment rendering', () => {
  it('renders live segments as they arrive via onBatch', async () => {
    const ctrl = makeControlledTranscribeMock();

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={vi.fn()} />);

    // Wait for the analyzing phase (createMeeting done, transcription started)
    await waitFor(() => expect(mockTranscribeBatchesOnServer).toHaveBeenCalled());

    await act(async () => {
      ctrl.fireOnBatch([
        { start: 10, end: 15, text: 'Første sætning', speaker: 'Taler 1', confidence: 0.9 },
      ]);
    });

    expect(screen.getByText('Første sætning')).toBeInTheDocument();

    // Cleanup — resolve so no dangling promise
    await act(async () => { ctrl.resolve(); });
  });

  it('shows "indlæser lyd…" in live view during init phase', () => {
    mockTranscribeBatchesOnServer.mockReturnValue(new Promise(() => {}));
    const file = makeFile('audio.mp3', 1024);
    render(<UploadConfirmScreen file={file} onCancel={vi.fn()} />);
    expect(screen.getByText('indlæser lyd…')).toBeInTheDocument();
  });

  it('does not show speaker label for default speaker "Taler 1"', async () => {
    const ctrl = makeControlledTranscribeMock([
      { start: 0, end: 5, text: 'Default speaker text', speaker: 'Taler 1', confidence: 0.9 },
    ]);

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={vi.fn()} />);
    await waitFor(() => expect(mockTranscribeBatchesOnServer).toHaveBeenCalled());

    await act(async () => {
      ctrl.fireOnBatch([
        { start: 0, end: 5, text: 'Default speaker text', speaker: 'Taler 1', confidence: 0.9 },
      ]);
    });

    expect(screen.getByText('Default speaker text')).toBeInTheDocument();
    // "taler 1:" should NOT appear because isDefaultSpeakerLabel returns true
    expect(screen.queryByText(/taler 1:/i)).toBeNull();

    await act(async () => { ctrl.resolve(); });
  });

  it('shows speaker label for non-default speakers', async () => {
    const ctrl = makeControlledTranscribeMock([
      { start: 0, end: 5, text: 'Named speaker text', speaker: 'Alice', confidence: 0.9 },
    ]);

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={vi.fn()} />);
    await waitFor(() => expect(mockTranscribeBatchesOnServer).toHaveBeenCalled());

    await act(async () => {
      ctrl.fireOnBatch([
        { start: 0, end: 5, text: 'Named speaker text', speaker: 'Alice', confidence: 0.9 },
      ]);
    });

    expect(screen.getByText('Named speaker text')).toBeInTheDocument();
    expect(screen.getByText(/alice:/i)).toBeInTheDocument();

    await act(async () => { ctrl.resolve(); });
  });
});

// ===========================================================================
// 9. saveAudio failure is non-fatal (archiveFailedRef)
// ===========================================================================

describe('UploadConfirmScreen — saveAudio failure non-fatal', () => {
  it('still reaches done phase even if saveAudio throws', async () => {
    mockSaveAudio.mockRejectedValue(new Error('storage full'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    // Should show done, not error
    expect(screen.getByText('transskription færdig')).toBeInTheDocument();
  });

  it('shows archive warning in footer when saveAudio fails', async () => {
    mockSaveAudio.mockRejectedValue(new Error('storage full'));
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText(/lydfilen kunne ikke arkiveres/i)).toBeInTheDocument();
  });

  it('shows normal footer message when saveAudio succeeds', async () => {
    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);
    expect(screen.getByText(/transskriptionen er klar — gennemgå/i)).toBeInTheDocument();
  });
});

// ===========================================================================
// 10. Error logging (traceability fixes)
// ===========================================================================

describe('UploadConfirmScreen — error logging (traceability)', () => {
  it('logs the original error when saveAudio fails (non-fatal archive path)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storageError = new Error('quota exceeded');
    mockSaveAudio.mockRejectedValue(storageError);

    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[upload-confirm]'),
      storageError,
    );
    consoleErrorSpy.mockRestore();
  });

  it('logs the original transcription error before re-throwing user-friendly message', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const networkError = new Error('network timeout');
    mockTranscribeBatchesOnServer.mockRejectedValue(networkError);

    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    // The original error should be logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[upload-confirm]'),
      networkError,
    );
    // The user-facing message should still be the friendly one
    expect(screen.getByText(/lydformatet understøttes ikke/i)).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it('logs when deleteMeeting fails during cancel (non-fatal)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deleteError = new Error('idb failure');
    mockDeleteMeeting.mockRejectedValue(deleteError);

    const onCancel = vi.fn();
    // Allow meeting to be created but stall transcription so we can cancel
    let resolveTranscribe!: (v: typeof DEFAULT_RESULT) => void;
    mockTranscribeBatchesOnServer.mockReturnValueOnce(
      new Promise((r) => { resolveTranscribe = r; }),
    );

    render(<UploadConfirmScreen file={makeFile('audio.mp3', 1024)} onCancel={onCancel} />);
    await waitFor(() => expect(mockCreateMeeting).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /annullér/i }));
    });

    // onCancel still fires despite deleteMeeting failing
    expect(onCancel).toHaveBeenCalledTimes(1);

    // deleteMeeting failure should be logged asynchronously
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[upload-confirm]'),
        deleteError,
      );
    });

    consoleErrorSpy.mockRestore();
    resolveTranscribe(DEFAULT_RESULT);
  });

  it('logs when updateMeeting fails in handleContinue (non-fatal, navigation still happens)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const updateError = new Error('idb write failed');
    // First call (status:review) succeeds; second call (title/participants) fails
    mockUpdateMeeting
      .mockResolvedValueOnce(undefined) // saveAudio path
      .mockResolvedValueOnce(undefined) // status:review
      .mockRejectedValueOnce(updateError); // handleContinue

    const file = makeFile('audio.mp3', 1024);
    await renderAndWaitForDone(file);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /fortsæt til gennemgang/i }));
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[upload-confirm]'),
      updateError,
    );
    // Navigation still happens despite the error
    expect(mockPush).toHaveBeenCalledWith('/meeting/meeting-abc/review');
    consoleErrorSpy.mockRestore();
  });
});
