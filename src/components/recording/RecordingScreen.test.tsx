// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MicVAD } from '@ricky0123/vad-web';
import { tabTo } from '@/test/keyboard';
import { getStep } from '@/lib/onboarding/steps';
import { setStorageUserId } from '@/lib/storage/scope';
import {
  createMeeting, getMeeting, updateMeeting, getTranscript, getPendingAudio, listBatches,
  putBatch, completeBatch,
} from '@/lib/storage';
import { isLeaveGuarded } from '@/lib/recording/leave-guard';
import { RecordingScreen } from './RecordingScreen';
import { renderWithOnboarding } from '@/test/onboarding';

// Onboarding hints wrap the start button, stop button, clarify panel, and
// audio-lifecycle caption; mark them already-seen so the popovers don't render and
// DOM queries keep targeting the underlying controls (mirrors the real app, which
// mounts RecordingScreen under the app-level OnboardingProvider).
function render(ui: React.ReactElement) {
  return renderWithOnboarding(ui, {
    tourSkipped: true,
    tourCompleted: true,
    // These four are `scope: 'global'` — remembered once, not once per meeting —
    // so they are seeded without a meetingId. Seeding them per meeting left them
    // unseen, and the popover that then opened swallowed the Escape key the
    // signal-bars tooltip test presses.
    seen: [
      { stepId: 'recording.start-button', meetingId: null },
      { stepId: 'recording.stop-save-continue', meetingId: null },
      { stepId: 'recording.clarify-panel', meetingId: null },
      { stepId: 'recording.audio-lifecycle', meetingId: null },
    ],
  });
}

// ── Next.js navigation mocks ───────────────────────────────────────────────

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParamsGet = vi.fn().mockReturnValue(null);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// ── Storage ────────────────────────────────────────────────────────────────

// The meeting, the recording ledger and the transcript live in a real IndexedDB
// (fake-indexeddb), one database per test. Only the audio archive is replaced:
// jsdom's Blob cannot be stored, and the archive-failure tests make it throw.
const mockSaveAudio = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/storage/audio', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/storage/audio')>();
  return { ...real, saveAudio: (...args: unknown[]) => mockSaveAudio(...args) };
});

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

// sealCurrentBatch always pushes one fake batch, so stopping always has one batch
// to send even though no real speech was captured.
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
    state.readyBatches.push(FAKE_BATCH);
  }),
  splitTextWithIntervals: vi.fn((text: string) =>
    text.trim() ? [{ speaker: '—', start: 0, end: 5, text: 'Hej verden' }] : []),
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

// The callbacks the screen handed the VAD on its last start, to simulate speech.
function vadCallbacks() {
  const options = vi.mocked(MicVAD.new).mock.calls.at(-1)?.[0];
  if (!options?.onSpeechStart || !options.onSpeechEnd) throw new Error('VAD was not started');
  return { onSpeechStart: options.onSpeechStart, onSpeechEnd: options.onSpeechEnd };
}

async function speak(seconds = 1) {
  const { onSpeechStart, onSpeechEnd } = vadCallbacks();
  await act(async () => {
    await onSpeechStart();
    await onSpeechEnd(new Float32Array(16_000 * seconds));
  });
}

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

// ── Network ────────────────────────────────────────────────────────────────

// fetch for the current test's meeting. A batch queue outlives its screen (by
// design), so a meeting from an earlier test may still retry; those requests are
// left hanging instead of reaching this test's mock.
const fetchMock = vi.fn();
let meetingId: string;
vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
  String(url).includes(meetingId) ? fetchMock(url, init) : new Promise(() => {}));

const ok = (text = 'Hej verden') => ({ ok: true, status: 200, json: async () => ({ text }) });
const serverError = () => ({ ok: false, status: 502, json: async () => ({ error: 'Transcription failed' }) });
// Batch requests, as opposed to live-caption requests to the same route.
const batchRequests = () => fetchMock.mock.calls.filter(([, init]) =>
  ((init as RequestInit).body as FormData).get('audio') instanceof File &&
  (((init as RequestInit).body as FormData).get('audio') as File).name === 'batch.wav');

let browserOnline = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });

function setOnline(online: boolean) {
  browserOnline = online;
  act(() => { window.dispatchEvent(new Event(online ? 'online' : 'offline')); });
}

beforeEach(async () => {
  latestRecorder = null;
  setStorageUserId(crypto.randomUUID());
  meetingId = (await createMeeting({ title: 'Møde' })).id;
  // Back online, with the failure count connectivity keeps across tests cleared.
  setOnline(true);

  // Reset all mocks
  mockPush.mockReset();
  mockReplace.mockReset();
  mockSearchParamsGet.mockReturnValue(null);
  mockSaveAudio.mockReset().mockResolvedValue(undefined);
  mockStartDiarization.mockResolvedValue([]);
  mockFinishDiarization.mockResolvedValue(undefined);
  mockPickRecordingMimeType.mockReturnValue('audio/webm;codecs=opus');
  fetchMock.mockReset().mockResolvedValue(ok());
  vi.mocked(MicVAD.new).mockClear();

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
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Helper ─────────────────────────────────────────────────────────────────

function renderScreen(props: Partial<React.ComponentProps<typeof RecordingScreen>> = {}) {
  return render(
    <RecordingScreen
      meetingId={meetingId}
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

  // Regression: the old recording stayed and was played back, and diarized, as the new one.
  it('drops the old recording on confirm overwrite', async () => {
    const { saveAudio: storeAudio, getAudio: readAudio } = await vi.importActual<typeof import('@/lib/storage/audio')>('@/lib/storage/audio');
    await storeAudio(meetingId, new Blob(['gammel']), 'audio/webm');
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => screen.getByText('Optag igen?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ja, optag igen' }));
    });
    await waitFor(async () => expect(await readAudio(meetingId)).toBeNull());
  });

  it('puts the meeting back to recording and starts on confirm overwrite', async () => {
    await updateMeeting(meetingId, { status: 'review' });
    renderScreen({ existingRecording });
    fireEvent.click(screen.getByText('optag igen'));
    await waitFor(() => screen.getByText('Optag igen?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ja, optag igen' }));
    });
    await waitFor(async () => {
      expect((await getMeeting(meetingId))?.status).toBe('recording');
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
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
      expect(mockReplace).toHaveBeenCalledWith(`/meeting/${meetingId}`, expect.anything());
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

  it('deletes the meeting when "Slet og annullér" is confirmed', async () => {
    renderScreen();
    fireEvent.click(screen.getByText('annullér'));
    await waitFor(() => screen.getByText('Annullér optagelse?'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet og annullér' }));
    });
    await waitFor(async () => {
      expect(await getMeeting(meetingId)).toBeNull();
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
  async function start() {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
  }

  async function stop() {
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });
  }

  async function startAndStop() {
    await start();
    await stop();
  }

  it('saves the transcript when transcription succeeds', async () => {
    await startAndStop();
    await waitFor(async () => {
      expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej verden']);
    }, { timeout: 5000 });
  });

  it('moves the meeting to review after transcription', async () => {
    await startAndStop();
    await waitFor(async () => {
      expect((await getMeeting(meetingId))?.status).toBe('review');
    }, { timeout: 5000 });
  });

  it('calls startDiarization when stopping', async () => {
    await startAndStop();
    await waitFor(() => {
      expect(mockStartDiarization).toHaveBeenCalledWith(meetingId, expect.any(Blob));
    }, { timeout: 5000 });
  });

  it('navigates to /meeting/:id/review after successful save', async () => {
    await startAndStop();
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
    }, { timeout: 5000 });
  });

  it('shows the transcription progress after stop', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await startAndStop();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('transskriberer 0 / 1 dele…');
    });
    expect(screen.queryByText(/gem.*fortsæt/i)).toBeNull();
  });

  it('shows error when no speech is found (empty transcript)', async () => {
    fetchMock.mockResolvedValue(ok(''));
    await startAndStop();
    await waitFor(() => {
      expect(screen.getByText(/Ingen tale fundet/)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('keeps nothing when no speech is found', async () => {
    fetchMock.mockResolvedValue(ok(''));
    await startAndStop();
    await waitFor(() => {
      expect(screen.getByText(/Ingen tale fundet/)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(await getMeeting(meetingId)).toBeNull();
  });

  it('calls onRecordingComplete after successful save', async () => {
    const onRecordingComplete = vi.fn();
    renderScreen({ onRecordingComplete });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await stop();
    await waitFor(() => {
      expect(onRecordingComplete).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  // Regression: a batch got one retry at stop and was then dropped from the transcript.
  it('keeps a batch that fails twice and puts it in the transcript once it succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(serverError())
      .mockResolvedValue(ok());
    await startAndStop();

    // Each failure is counted in the ledger once the retry is scheduled (stopping
    // retries at once); the browser's online event then retries instead of the backoff.
    const attempts = async () => (await listBatches(meetingId))[0]?.attempts;
    await waitFor(async () => expect(await attempts()).toBe(2));
    expect(screen.getByRole('status')).toHaveTextContent('transskriberer 0 / 1 dele…');
    setOnline(true);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
    }, { timeout: 5000 });
    expect(batchRequests()).toHaveLength(3);
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej verden']);
  });

  // Regression: a recording whose batches all failed was discarded ("ikke gemt").
  it('keeps the recording waiting for transcription when every batch fails', async () => {
    fetchMock.mockResolvedValue(serverError());
    await startAndStop();

    await waitFor(async () => {
      expect((await getMeeting(meetingId))?.status).toBe('processing');
    }, { timeout: 5000 });
    expect(await getPendingAudio(meetingId, 0)).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('transskriberer 0 / 1 dele…');
    expect(screen.queryByText(/ikke gemt/)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
    // Stored at stop, before anything settles the recording, so whoever settles it
    // later (RecordingRecovery after a reconnect) sees that it has audio.
    expect(mockSaveAudio).toHaveBeenCalledWith(meetingId, expect.any(Blob), expect.any(String));
  });

  it('tells the user what happens to the waiting parts when stopping offline', async () => {
    await start();
    setOnline(false);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await stop();

    await waitFor(() => {
      expect(screen.getByText(/1 af 1 dele er endnu ikke transskriberet/)).toBeInTheDocument();
    });
    // The panel shows the queue as soon as stopping starts; the status follows.
    await waitFor(async () => expect((await getMeeting(meetingId))?.status).toBe('processing'));
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

  it('shows warning message when saveAudio fails but transcript saved OK', async () => {
    mockSaveAudio.mockRejectedValue(new Error('QuotaExceededError'));
    await startAndStop();

    await waitFor(() => {
      expect(screen.getByText(/lydfilen kunne ikke gemmes lokalt/)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(await getTranscript(meetingId)).not.toBeNull();
  });

  it('does NOT navigate to review when archive fails', async () => {
    mockSaveAudio.mockRejectedValue(new Error('QuotaExceededError'));
    await startAndStop();

    await waitFor(() => {
      expect(screen.getByText(/lydfilen kunne ikke gemmes lokalt/)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(mockPush).not.toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
  });
});

describe('RecordingScreen — offline and start-up failures', () => {
  async function start() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start optagelse' }));
    });
  }

  it('refuses to start while offline', async () => {
    setOnline(false);
    renderScreen();
    await start();

    expect(screen.getByText(/kan ikke starte uden forbindelse/)).toBeInTheDocument();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('aborts the start and releases the microphone when the VAD cannot start', async () => {
    const stream = new FakeMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream as unknown as MediaStream);
    vi.mocked(MicVAD.new).mockRejectedValueOnce(new Error('onnx runtime failed to load'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderScreen();
    await start();

    expect(screen.getByText(/talegenkendelsen ikke kunne indlæses/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(latestRecorder).toBeNull();
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('keeps recording but pauses live captions while offline', async () => {
    renderScreen();
    await start();
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    await speak();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the caption request

    fetchMock.mockClear();
    setOnline(false);
    expect(screen.getByText(/Optagelsen fortsætter, og live-transskriptionen er sat på pause/)).toBeInTheDocument();
    await speak();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(latestRecorder?.state).toBe('recording');
  });

  it('checkpoints the batch being recorded after each utterance', async () => {
    renderScreen();
    await start();
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    await speak(2);

    await waitFor(async () => {
      expect(await listBatches(meetingId)).toMatchObject([
        { seq: 0, status: 'open', totalWavDuration: 2 },
      ]);
    });
    expect(await getPendingAudio(meetingId, 0)).not.toBeNull();
  });

  it('asks before leaving only while recording', async () => {
    renderScreen();
    expect(isLeaveGuarded()).toBe(false);
    await start();
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    expect(isLeaveGuarded()).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });
    expect(isLeaveGuarded()).toBe(false);
  });

  it('keeps what was recorded when the screen is left mid-recording', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderScreen();
    await start();
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    unmount();

    expect(isLeaveGuarded()).toBe(false);
    await waitFor(async () => {
      expect((await listBatches(meetingId)).map((r) => r.status)).toEqual(['pending']);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await getMeeting(meetingId)).toMatchObject({ status: 'recording' });
  });

  it('still removes an abandoned recording that captured nothing', async () => {
    const { unmount } = renderScreen();
    unmount();

    await waitFor(async () => {
      expect(await getMeeting(meetingId)).toBeNull();
    });
  });
});

describe('RecordingScreen — interrupted recording', () => {
  // The first session reached 01:05 on the meeting's timeline and was transcribed.
  async function interruptedAt65s() {
    const first = {
      meetingId, seq: 0, session: 0, totalWavDuration: 5,
      intervals: [{ originalStart: 60, originalEnd: 65, wavOffset: 0, wavDuration: 5 }],
    };
    await putBatch({ ...first, status: 'pending' }, new ArrayBuffer(8));
    await completeBatch(first, [{ speaker: 'Taler 1', start: 60, end: 65, text: 'Tidligere tekst' }]);
  }

  it('offers to resume, finish or delete instead of redirecting', async () => {
    await interruptedAt65s();
    renderScreen({ isActiveRecording: true });

    expect(await screen.findByText(/optagelsen blev afbrudt/i)).toBeInTheDocument();
    expect(screen.getByText('01:05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'fortsæt optagelse' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('resumes with the earlier text, the clock going on and the next batch numbers', async () => {
    await interruptedAt65s();
    renderScreen({ isActiveRecording: true });
    const button = await screen.findByRole('button', { name: 'fortsæt optagelse' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));

    // The live view renders each word in its own span.
    expect(screen.getByText('Tidligere').parentElement).toHaveTextContent('Tidligere tekst');
    expect(screen.getByText(/^00:01:0[5-6]$/)).toBeInTheDocument();
    await speak(2);
    await waitFor(async () => {
      expect((await listBatches(meetingId)).map(({ seq, session, status }) => ({ seq, session, status }))).toEqual([
        { seq: 0, session: 0, status: 'done' },
        { seq: 1, session: 1, status: 'open' },
      ]);
    });
    const [interval] = (await listBatches(meetingId))[1].intervals;
    expect(interval.originalStart).toBeGreaterThanOrEqual(65);
  });

  it('diarizes only the resumed session and keeps no audio when stopped', async () => {
    await interruptedAt65s();
    renderScreen({ isActiveRecording: true });
    const button = await screen.findByRole('button', { name: 'fortsæt optagelse' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => screen.getByText(/gem.*fortsæt/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/gem.*fortsæt/i));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
    }, { timeout: 5000 });
    await waitFor(() => expect(mockFinishDiarization).toHaveBeenCalledWith(meetingId, [], 65));
    expect(mockSaveAudio).not.toHaveBeenCalled();
    expect(await getMeeting(meetingId)).toMatchObject({ status: 'review', audioDeleted: true });
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Tidligere tekst', 'Hej verden']);
  });

  it('finishes into the transcript and goes to review', async () => {
    await interruptedAt65s();
    renderScreen({ isActiveRecording: true });
    const button = await screen.findByRole('button', { name: 'afslut og gå til gennemgang →' });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
    });
    expect(await getTranscript(meetingId)).toMatchObject({
      segments: [{ text: 'Tidligere tekst' }],
      diarizationStatus: 'done',
    });
    expect(await getMeeting(meetingId)).toMatchObject({ status: 'review', audioDeleted: true });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('deletes the meeting on request', async () => {
    await interruptedAt65s();
    renderScreen({ isActiveRecording: true });
    fireEvent.click(await screen.findByRole('button', { name: 'slet' }));
    const button = await screen.findByRole('button', { name: 'Slet og annullér' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(await getMeeting(meetingId)).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('shows the waiting panel for a stopped recording still waiting for transcription', async () => {
    let answer: (value: ReturnType<typeof ok>) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await putBatch({
      meetingId, seq: 0, session: 0, status: 'pending', totalWavDuration: 5,
      intervals: [{ originalStart: 0, originalEnd: 5, wavOffset: 0, wavDuration: 5 }],
    }, new ArrayBuffer(8));
    await updateMeeting(meetingId, { status: 'processing' });
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('transskriberer 0 / 1 dele…');
    });
    expect(screen.queryByRole('button', { name: 'Start optagelse' })).toBeNull();

    await act(async () => { answer(ok()); });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${meetingId}/review`);
    });
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej verden']);
  });
});

describe('RecordingScreen — signal bars tooltip', () => {
  it('opens when Tab reaches the signal bars and closes on Escape', async () => {
    // Fake timers would stall userEvent's internal delays.
    const user = userEvent.setup();
    renderScreen();

    await tabTo(user, screen.getByText('signal').parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(getStep('recording.signal-bars').copy);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
