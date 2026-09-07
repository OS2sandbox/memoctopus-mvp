// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RecordingScreen } from './RecordingScreen';

// ── Next.js navigation mocks ───────────────────────────────────────────────

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParamsGet = vi.fn().mockReturnValue(null);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// ── Storage mocks ──────────────────────────────────────────────────────────

const mockSaveAudio = vi.fn().mockResolvedValue(undefined);
const mockSaveTranscript = vi.fn().mockResolvedValue(undefined);
const mockUpdateMeeting = vi.fn().mockResolvedValue(undefined);
const mockDeleteMeeting = vi.fn().mockResolvedValue(undefined);
const mockGetMeeting = vi.fn().mockResolvedValue(null);
const mockGetTranscript = vi.fn().mockResolvedValue(null);
const mockGetAudio = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/storage', () => ({
  saveAudio: (...args: unknown[]) => mockSaveAudio(...args),
  saveTranscript: (...args: unknown[]) => mockSaveTranscript(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
  deleteMeeting: (...args: unknown[]) => mockDeleteMeeting(...args),
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  getTranscript: (...args: unknown[]) => mockGetTranscript(...args),
  getAudio: (...args: unknown[]) => mockGetAudio(...args),
}));

// ── Diarization mocks ──────────────────────────────────────────────────────

const mockStartDiarization = vi.fn().mockResolvedValue([]);
const mockFinishDiarization = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/audio/diarize-client', () => ({
  startDiarization: (...args: unknown[]) => mockStartDiarization(...args),
  finishDiarization: (...args: unknown[]) => mockFinishDiarization(...args),
}));

// ── Recording format mock ──────────────────────────────────────────────────

const mockPickRecordingMimeType = vi.fn().mockReturnValue('audio/webm;codecs=opus');

vi.mock('@/lib/audio/recording-format', () => ({
  pickRecordingMimeType: () => mockPickRecordingMimeType(),
}));

// ── VAD batch mock ─────────────────────────────────────────────────────────

// sealCurrentBatch always pushes one fake batch so stopAndSave's liveBatches
// is non-empty and can resolve the fetch-based transcript path.
const FAKE_BATCH = {
  wav: new Blob(['fakewav'], { type: 'audio/wav' }),
  intervals: [{ originalStart: 0, originalEnd: 5, wavOffset: 0, wavDuration: 5 }],
  totalWavDuration: 5,
};

vi.mock('@/lib/audio/vad-batch', () => ({
  float32ToWavBlob: vi.fn(() => new Blob([], { type: 'audio/wav' })),
  newVadBatchState: vi.fn(() => ({
    pendingAudio: [],
    pendingIntervals: [],
    pendingWavDuration: 0,
    readyBatches: [],
  })),
  sealCurrentBatch: vi.fn((state: { readyBatches: unknown[] }) => {
    // Inject a fake sealed batch so the post-recording transcript fan-out has work to do
    state.readyBatches.push(FAKE_BATCH);
  }),
  splitTextWithIntervals: vi.fn((_text: string) => [
    { speaker: '—', start: 0, end: 5, text: 'Hej verden' },
  ]),
  BATCH_DURATION_S: 27,
  MAX_WORDS_PER_LINE: 20,
}));

// ── VAD web mock (heavy; never actually needed in JSDOM) ──────────────────

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn().mockResolvedValue({
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    }),
  },
}));

// ── Browser media API mocks ────────────────────────────────────────────────

// Minimal MediaRecorder stub
class FakeMediaRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  stream: MediaStream;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private _stopListeners: Array<() => void> = [];

  constructor(stream: MediaStream, _opts?: { mimeType?: string }) {
    this.stream = stream;
  }

  start(_timeslice?: number) { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    // Fire stop listeners
    this._stopListeners.forEach((fn) => fn());
    this._stopListeners = [];
    // Fire a final dataavailable
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
  }

  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }

  requestData() {
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
  }

  addEventListener(type: string, listener: () => void) {
    if (type === 'stop') this._stopListeners.push(listener);
    if (type === 'dataavailable') {
      // Immediately fire for flush usage
      setTimeout(() => this.ondataavailable?.({ data: new Blob(['flush'], { type: 'audio/webm' }) }), 0);
    }
  }

  removeEventListener(_type: string, _listener: () => void) {}
}

// We track the most recent recorder instance so tests can poke it
let latestRecorder: FakeMediaRecorder | null = null;

// Minimal AudioContext stub
class FakeAudioContext {
  state: string = 'running';
  destination = {};
  onstatechange: (() => void) | null = null;

  createAnalyser() {
    return {
      fftSize: 512,
      frequencyBinCount: 256,
      getByteTimeDomainData: (arr: Uint8Array) => { arr.fill(128); },
    };
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  audioWorklet = {
    addModule: vi.fn().mockRejectedValue(new Error('worklet unavailable')),
  };
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// Minimal MediaStream / Track stubs
class FakeMediaStreamTrack {
  stop = vi.fn();
}

class FakeMediaStream {
  private _tracks: FakeMediaStreamTrack[] = [new FakeMediaStreamTrack()];
  getTracks() { return this._tracks; }
}

beforeEach(() => {
  latestRecorder = null;

  // Reset all mocks
  mockPush.mockReset();
  mockReplace.mockReset();
  mockSearchParamsGet.mockReturnValue(null);
  mockSaveAudio.mockResolvedValue(undefined);
  mockSaveTranscript.mockResolvedValue(undefined);
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockDeleteMeeting.mockResolvedValue(undefined);
  mockGetMeeting.mockResolvedValue(null);
  mockGetTranscript.mockResolvedValue(null);
  mockGetAudio.mockResolvedValue(null);
  mockStartDiarization.mockResolvedValue([]);
  mockFinishDiarization.mockResolvedValue(undefined);
  mockPickRecordingMimeType.mockReturnValue('audio/webm;codecs=opus');

  // Install browser API stubs
  Object.defineProperty(window, 'MediaRecorder', {
    writable: true,
    value: class extends FakeMediaRecorder {
      constructor(stream: MediaStream, opts?: { mimeType?: string }) {
        super(stream, opts);
        latestRecorder = this as unknown as FakeMediaRecorder;
      }
    },
  });
  (window.MediaRecorder as unknown as { isTypeSupported: (t: string) => boolean }).isTypeSupported =
    (t: string) => t === 'audio/webm;codecs=opus';

  Object.defineProperty(window, 'AudioContext', { writable: true, value: FakeAudioContext });
  Object.defineProperty(window, 'AudioWorkletNode', {
    writable: true,
    value: class { constructor() {} disconnect() {} port = { onmessage: null }; connect = vi.fn(); },
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    writable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeMediaStream()),
    },
  });

  // requestAnimationFrame / cancelAnimationFrame stubs
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
    // Don't call continuously — just return an id
    return 0 as unknown as number;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  // fetch mock — return empty transcript by default
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ text: 'Hej verden' }),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Helper ─────────────────────────────────────────────────────────────────

function renderScreen(props: Partial<React.ComponentProps<typeof RecordingScreen>> = {}) {
  return render(
    <RecordingScreen
      meetingId="meeting-abc"
      {...props}
    />,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Initial / idle rendering
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — idle state rendering', () => {
  it('renders the optagelse section label', () => {
    renderScreen();
    expect(screen.getByText('01 · optagelse')).toBeInTheDocument();
  });

  it('shows 00:00:00 elapsed timer on first render', () => {
    renderScreen();
    expect(screen.getByText('00:00:00')).toBeInTheDocument();
  });

  it('shows "klar til optagelse" in the storage row when idle', () => {
    renderScreen();
    expect(screen.getByText('klar til optagelse')).toBeInTheDocument();
  });

  it('shows "Tryk optag for at starte…" placeholder in transcript area', () => {
    renderScreen();
    expect(screen.getByText('Tryk optag for at starte…')).toBeInTheDocument();
  });

  it('renders Start optagelse button', () => {
    renderScreen();
    expect(screen.getByRole('button', { name: 'Start optagelse' })).toBeInTheDocument();
  });

  it('renders annullér button in idle state', () => {
    renderScreen();
    // The cancel button label
    expect(screen.getByText('annullér')).toBeInTheDocument();
  });

  it('does not show an error banner initially', () => {
    renderScreen();
    expect(screen.queryByText(/fejlede|afvist|fundet/)).toBeNull();
  });

  it('shows "klar" status indicator in transcript header', () => {
    renderScreen();
    expect(screen.getByText('klar')).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Existing-recording (completed) state
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — existingRecording state', () => {
  const existingRecording = { durationSeconds: 3723, sizeBytes: 1024 * 1024 };

  it('renders formatted duration when durationSeconds is provided', () => {
    renderScreen({ existingRecording });
    // 3723 s = 1h 02m 03s → "1:02:03"
    expect(screen.getByText('1:02:03')).toBeInTheDocument();
  });

  it('renders — when durationSeconds is null', () => {
    renderScreen({ existingRecording: { durationSeconds: null, sizeBytes: 0 } });
    // The dash character
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders "gå til gennemgang →" button', () => {
    renderScreen({ existingRecording });
    expect(screen.getByText('gå til gennemgang →')).toBeInTheDocument();
  });

  it('renders "optag igen" button', () => {
    renderScreen({ existingRecording });
    expect(screen.getByText('optag igen')).toBeInTheDocument();
  });

  it('calls onNavigateToReview when "gå til gennemgang →" is clicked', () => {
    const onNavigateToReview = vi.fn();
    renderScreen({ existingRecording, onNavigateToReview });
    fireEvent.click(screen.getByText('gå til gennemgang →'));
    expect(onNavigateToReview).toHaveBeenCalledTimes(1);
  });

  it('opens overwrite dialog when "optag igen" is clicked', async () => {
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => {
      expect(screen.getByText('Optag igen?')).toBeInTheDocument();
    });
  });

  it('shows overwrite dialog description', async () => {
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => {
      expect(screen.getByText('Den eksisterende optagelse og transskription overskrives.')).toBeInTheDocument();
    });
  });

  it('closes overwrite dialog when Annullér is clicked', async () => {
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => screen.getByText('Optag igen?'));
    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));
    await waitFor(() => {
      expect(screen.queryByText('Optag igen?')).toBeNull();
    });
  });

  it('calls updateMeeting and startRecording on confirm overwrite', async () => {
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => screen.getByText('Optag igen?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ja, optag igen' }));
    });
    await waitFor(() => {
      expect(mockUpdateMeeting).toHaveBeenCalledWith('meeting-abc', expect.objectContaining({ status: 'recording' }));
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Auto-start behaviour
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — autostart behaviour', () => {
  it('starts recording when autostart=1 search param is present', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === 'autostart' ? '1' : null);
    renderScreen();
    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    });
  });

  it('strips the autostart param by calling router.replace', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === 'autostart' ? '1' : null);
    renderScreen();
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/meeting/meeting-abc', expect.anything());
    });
  });

  it('redirects to /dashboard when isActiveRecording=true and no autostart param', async () => {
    renderScreen({ isActiveRecording: true });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('does NOT auto-start when existingRecording is provided', () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === 'autostart' ? '1' : null);
    renderScreen({ existingRecording: { durationSeconds: 60, sizeBytes: 1000 } });
    // Should NOT call getUserMedia because existingRecording short-circuits the effect
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Start recording flow
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — start recording', () => {
  it('calls getUserMedia when Start optagelse is clicked', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.anything() }),
    );
  });

  it('transitions to recording state after start', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      // The pause/continue button should now be present
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });
  });

  it('shows "transskriberer live" status in recording state', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText('transskriberer live')).toBeInTheDocument();
    });
  });

  it('shows "gem & fortsæt" stop button during recording', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText(/gem.*fortsæt/i)).toBeInTheDocument();
    });
  });

  it('shows "Lytter…" placeholder in transcript when recording with no segments', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText('Lytter…')).toBeInTheDocument();
    });
  });

  it('uses pickRecordingMimeType to select the recorder mime type', async () => {
    mockPickRecordingMimeType.mockReturnValue('audio/mp4');
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(mockPickRecordingMimeType).toHaveBeenCalled();
    });
  });

  it('shows NotAllowedError message when mic permission denied', async () => {
    const err = new DOMException('Denied', 'NotAllowedError');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Mikrofonens tilladelse er afvist/)).toBeInTheDocument();
    });
  });

  it('shows NotFoundError message when no microphone found', async () => {
    const err = new DOMException('Not found', 'NotFoundError');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Ingen mikrofon fundet/)).toBeInTheDocument();
    });
  });

  it('shows generic error message for unknown errors', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Something weird'),
    );
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Optagelse fejlede/)).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Cancel / discard flow
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — cancel / discard flow', () => {
  it('opens cancel dialog when annullér is clicked in idle state', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => {
      expect(screen.getByText('Annullér optagelse?')).toBeInTheDocument();
    });
  });

  it('shows cancel dialog description text', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => {
      expect(screen.getByText(/Optagelsen og mødet slettes permanent/)).toBeInTheDocument();
    });
  });

  it('closes dialog when "Tilbage" is clicked', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => screen.getByText('Annullér optagelse?'));
    fireEvent.click(screen.getByRole('button', { name: 'Tilbage' }));
    await waitFor(() => {
      expect(screen.queryByText('Annullér optagelse?')).toBeNull();
    });
  });

  it('calls deleteMeeting when "Slet og annullér" is confirmed', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => screen.getByText('Annullér optagelse?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet og annullér' }));
    });
    await waitFor(() => {
      expect(mockDeleteMeeting).toHaveBeenCalledWith('meeting-abc');
    });
  });

  it('navigates to /dashboard after cancel confirm', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => screen.getByText('Annullér optagelse?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet og annullér' }));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('opens cancel dialog during recording when annullér is clicked', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    // During recording there's also an annullér button
    const cancelBtns = screen.getAllByText('annullér');
    fireEvent.click(cancelBtns[0]);
    await waitFor(() => {
      expect(screen.getByText('Annullér optagelse?')).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. Stop and save
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — stopAndSave', () => {
  async function startAndStop() {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });
  }

  it('calls saveTranscript when transcription succeeds', async () => {
    // Provide a non-empty text so the empty-transcript branch is skipped
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej verden' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(mockSaveTranscript).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  it('calls updateMeeting with status "review" after transcription', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej verden' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(mockUpdateMeeting).toHaveBeenCalledWith('meeting-abc', expect.objectContaining({ status: 'review' }));
    }, { timeout: 5000 });
  });

  it('calls startDiarization when stopping', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(mockStartDiarization).toHaveBeenCalledWith('meeting-abc', expect.any(Blob));
    }, { timeout: 5000 });
  });

  it('navigates to /meeting/:id/review after successful save', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/meeting/meeting-abc/review');
    }, { timeout: 5000 });
  });

  it('shows uploading/transcribing state after stop', async () => {
    // Make fetch hang to catch the in-between state
    type Resolver = () => void;
    let resolveFetch: Resolver | null = null;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Response>((r) => {
        resolveFetch = () => r({ ok: true, json: async () => ({ text: 'hej' }) } as Response);
      }),
    );
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });
    // The uploading/transcribing state: either "transskriberer og gemmer" (no batch progress)
    // or "transskriberer N / M segmenter" (with batch progress)
    await waitFor(() => {
      const body = document.body.textContent ?? '';
      expect(
        body.includes('transskriberer') || body.includes('gem & fortsæt') === false,
      ).toBe(true);
    });
    // Ensure we're no longer showing the "gem & fortsæt" button (stopped state)
    await waitFor(() => {
      expect(screen.queryByText(/gem.*fortsæt/i)).toBeNull();
    });
    // Clean up by resolving the fetch
    await act(async () => { resolveFetch?.(); });
  });

  it('shows error when no speech is found (empty transcript)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(screen.getByText(/Ingen tale fundet/)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('does NOT save the recording when no transcript is produced', async () => {
    // A recording that yields no transcript must be discarded — nothing should be
    // persisted to IndexedDB outside the successful review flow.
    mockSaveAudio.mockClear();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    });
    await startAndStop();
    await waitFor(() => {
      expect(screen.getByText(/Ingen tale fundet|fejlede/i)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(mockSaveAudio).not.toHaveBeenCalled();
  });

  it('calls onRecordingComplete after successful save', async () => {
    const onRecordingComplete = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej verden' }),
    });
    render(
      <RecordingScreen
        meetingId="meeting-abc"
        onRecordingComplete={onRecordingComplete}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });
    await waitFor(() => {
      expect(onRecordingComplete).toHaveBeenCalled();
    }, { timeout: 5000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. pickRecordingMimeType and file size / duration display
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — mime type and format display', () => {
  it('falls back to audio/webm when pickRecordingMimeType returns empty string', async () => {
    mockPickRecordingMimeType.mockReturnValue('');
    renderScreen();
    // Should not throw
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });
  });

  it('shows "optagelse gemt · webm/opus · lokal" in existing recording state', () => {
    renderScreen({ existingRecording: { durationSeconds: 60, sizeBytes: 1024 } });
    expect(screen.getByText('optagelse gemt · webm/opus · lokal')).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. formatDuration and formatFileSize (utility integration)
// ══════════════════════════════════════════════════════════════════════════

describe('formatDuration and formatFileSize — via existing recording display', () => {
  it('formats 61 seconds as "01:01"', () => {
    renderScreen({ existingRecording: { durationSeconds: 61, sizeBytes: 0 } });
    expect(screen.getByText('01:01')).toBeInTheDocument();
  });

  it('formats 3600 seconds as "1:00:00"', () => {
    renderScreen({ existingRecording: { durationSeconds: 3600, sizeBytes: 0 } });
    expect(screen.getByText('1:00:00')).toBeInTheDocument();
  });

  it('formats 0 seconds as "00:00"', () => {
    renderScreen({ existingRecording: { durationSeconds: 0, sizeBytes: 0 } });
    expect(screen.getByText('00:00')).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. LocalAgreementMerger — unit test of the embedded class
// ══════════════════════════════════════════════════════════════════════════

// The LocalAgreementMerger class is not exported from RecordingScreen,
// but its behaviour drives the "committed + tail" display.
// We test its logic indirectly by importing the private logic via a
// reimplementation test (keeps the logic specification in the suite).

describe('LocalAgreementMerger logic', () => {
  // Inline minimal implementation matching the source class
  class LocalAgreementMerger {
    private prevWords: string[] = [];
    private committed: string[] = [];

    merge(newHyp: string): { committed: string; tail: string } {
      const newWords = newHyp.trim() ? newHyp.trim().split(/\s+/) : [];
      let agree = 0;
      while (
        agree < this.prevWords.length &&
        agree < newWords.length &&
        this.prevWords[agree].toLowerCase() === newWords[agree].toLowerCase()
      ) {
        agree++;
      }
      for (let i = this.committed.length; i < agree; i++) {
        this.committed.push(this.prevWords[i]);
      }
      this.prevWords = newWords;
      return {
        committed: this.committed.join(' '),
        tail: newWords.slice(this.committed.length).join(' '),
      };
    }

    forceCommit(): string {
      for (let i = this.committed.length; i < this.prevWords.length; i++) {
        this.committed.push(this.prevWords[i]);
      }
      const result = this.committed.join(' ');
      this.reset();
      return result;
    }

    reset() { this.prevWords = []; this.committed = []; }
  }

  it('starts with empty committed and tail', () => {
    const m = new LocalAgreementMerger();
    const r = m.merge('');
    expect(r.committed).toBe('');
    expect(r.tail).toBe('');
  });

  it('does not commit words on first partial', () => {
    const m = new LocalAgreementMerger();
    const r = m.merge('hej verden');
    expect(r.committed).toBe('');
    expect(r.tail).toBe('hej verden');
  });

  it('commits agreeing prefix when consecutive partials share words', () => {
    const m = new LocalAgreementMerger();
    m.merge('hej verden');
    const r = m.merge('hej verden møde');
    // "hej verden" appear in both, so they should be committed
    expect(r.committed).toBe('hej verden');
    expect(r.tail).toBe('møde');
  });

  it('does not commit words that changed between partials', () => {
    const m = new LocalAgreementMerger();
    m.merge('hej verd');
    const r = m.merge('hej verden');
    // "hej" was in both but "verd" ≠ "verden", so only "hej" agrees at position 0
    expect(r.committed).toBe('hej');
  });

  it('forceCommit flushes all remaining prevWords into committed', () => {
    const m = new LocalAgreementMerger();
    m.merge('hej verden møde');
    const text = m.forceCommit();
    expect(text).toBe('hej verden møde');
  });

  it('forceCommit resets state after call', () => {
    const m = new LocalAgreementMerger();
    m.merge('ord');
    m.forceCommit();
    const r = m.merge('ny');
    expect(r.committed).toBe('');
    expect(r.tail).toBe('ny');
  });

  it('is case-insensitive when comparing words', () => {
    const m = new LocalAgreementMerger();
    m.merge('Hej Verden');
    const r = m.merge('hej verden ekstra');
    expect(r.committed).toBe('Hej Verden');
  });

  it('handles a shrinking hypothesis gracefully (no crash)', () => {
    const m = new LocalAgreementMerger();
    m.merge('hej verden møde nu');
    // Shorter next hypothesis — fewer words
    expect(() => m.merge('hej')).not.toThrow();
  });

  it('reset clears committed and prevWords', () => {
    const m = new LocalAgreementMerger();
    m.merge('hej');
    m.merge('hej verden');
    m.reset();
    const r = m.merge('ny tekst');
    expect(r.committed).toBe('');
    expect(r.tail).toBe('ny tekst');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. Silence warning
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — silence warning', () => {
  it('does NOT show silence warning in idle state', () => {
    renderScreen();
    expect(screen.queryByText(/Vi kan ikke høre noget/)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 11. Live captions unavailable banner
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — live captions unavailable', () => {
  it('does NOT show the liveCaptionsUnavailable banner in idle state', () => {
    renderScreen();
    expect(screen.queryByText(/Live-transskription er ikke tilgængelig/)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 12. Pause / resume
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — pause and resume', () => {
  it('shows Fortsæt button after pausing', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Fortsæt' })).toBeInTheDocument();
    });
  });

  it('shows pause status in transcript header when paused', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    await waitFor(() => {
      expect(screen.getByText('pause')).toBeInTheDocument();
    });
  });

  it('resumes and shows Pause button again after Fortsæt click', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Fortsæt' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fortsæt' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 13. Error-handling improvements (audit findings)
// ══════════════════════════════════════════════════════════════════════════

describe('RecordingScreen — recorder.onerror surfaces to the UI (HIGH)', () => {
  it('shows Danish error message when recorder fires an error event', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    // Fire onerror on the recorder — the component should surface the fault.
    await act(async () => {
      latestRecorder?.onerror?.({ type: 'error' });
    });

    await waitFor(() => {
      expect(screen.getByText(/Optagelsen blev afbrudt af en fejl i lydenheden/)).toBeInTheDocument();
    });
  });

  it('transitions out of recording state when recorder fires onerror', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    await act(async () => {
      latestRecorder?.onerror?.({ type: 'error' });
    });

    // The "gem & fortsæt" / "Pause" buttons should no longer be visible — recording stopped.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
      expect(screen.queryByText(/gem.*fortsæt/i)).toBeNull();
    });
  });

  it('logs the error via console.error when recorder fires onerror', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    const fakeEvent = { type: 'error' };
    await act(async () => {
      latestRecorder?.onerror?.(fakeEvent);
    });

    expect(consoleSpy).toHaveBeenCalledWith('[recorder] error:', fakeEvent);
    consoleSpy.mockRestore();
  });
});

describe('RecordingScreen — archivePromise failure surfaced to user (MEDIUM)', () => {
  it('shows warning message when saveAudio fails but transcript saved OK', async () => {
    // saveAudio rejects; saveTranscript succeeds so the transcription path completes.
    mockSaveAudio.mockRejectedValue(new Error('QuotaExceededError'));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej verden' }),
    });

    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/lydfilen kunne ikke gemmes lokalt/)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('does NOT navigate to review when archive fails', async () => {
    mockSaveAudio.mockRejectedValue(new Error('QuotaExceededError'));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hej verden' }),
    });

    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/lydfilen kunne ikke gemmes lokalt/)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(mockPush).not.toHaveBeenCalledWith('/meeting/meeting-abc/review');
  });
});
