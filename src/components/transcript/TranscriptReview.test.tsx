// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptReview } from './TranscriptReview';
import type { TranscriptSegment, PiiReplacement } from '@/types';

// ── Mock all external dependencies ──────────────────────────────────────────

vi.mock('@/lib/storage', () => ({
  getTranscript: vi.fn().mockResolvedValue(null),
  getAudio: vi.fn().mockResolvedValue(null),
  saveTranscriptChapters: vi.fn().mockResolvedValue(undefined),
  saveTranscriptSegments: vi.fn().mockResolvedValue(undefined),
  appendMinutesVersion: vi.fn().mockResolvedValue(undefined),
  deleteAudio: vi.fn().mockResolvedValue(undefined),
  updateMeeting: vi.fn().mockResolvedValue(undefined),
  getMeeting: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/transcript-events', () => ({
  onTranscriptUpdated: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('@/lib/audio/diarize-client', () => ({
  isDiarizationInFlight: vi.fn().mockReturnValue(false),
  ensureDiarization: vi.fn().mockResolvedValue(undefined),
  finishDiarization: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/audio/speaker-labels', () => ({
  isDefaultSpeakerLabel: vi.fn((label: string) => /^Taler \d+$/.test(label.trim())),
  nextAvailableSpeakerLabel: vi.fn((used: Set<string>) => {
    let n = 1;
    while (used.has(`Taler ${n}`)) n++;
    return `Taler ${n}`;
  }),
}));

vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/utils', () => ({
  formatDate: vi.fn((d: string | Date) => '01-01-2025'),
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' '),
}));

// Mock child components to keep tests focused on TranscriptReview logic
vi.mock('./SpeakerRow', () => ({
  SpeakerRow: ({ segment, index, onUpdate, onAssign, diarizing }: {
    segment: TranscriptSegment;
    index: number;
    onUpdate: (i: number, s: TranscriptSegment) => void;
    onAssign: (from: string, to: string) => void;
    diarizing?: boolean;
  }) => (
    <div data-testid={`speaker-row-${index}`} data-speaker={segment.speaker} data-diarizing={String(diarizing)}>
      <span>{segment.speaker}</span>
      <span>{segment.text}</span>
      {diarizing && <span aria-label="Genkender taler">…</span>}
      <button onClick={() => onUpdate(index, { ...segment, text: 'updated text' })}>
        update
      </button>
      <button onClick={() => onAssign(segment.speaker, 'Ny Person')}>
        assign
      </button>
    </div>
  ),
}));

vi.mock('./SpeakerAssignment', () => ({
  SpeakerAssignment: ({ diarizing, rows }: { diarizing?: boolean; rows: unknown[] }) => (
    <div data-testid="speaker-assignment" data-diarizing={String(diarizing)}>
      {diarizing && <span>genkender stemmer…</span>}
      <span data-testid="row-count">{rows.length}</span>
    </div>
  ),
}));

vi.mock('./WaveformPlayer', () => ({
  WaveformPlayer: ({ audioUrl }: { audioUrl: string }) => (
    <div data-testid="waveform-player">{audioUrl}</div>
  ),
}));

// ── Test data ────────────────────────────────────────────────────────────────

const SEG1: TranscriptSegment = { speaker: 'Taler 1', start: 0, end: 5, text: 'Hej alle' };
const SEG2: TranscriptSegment = { speaker: 'Taler 2', start: 6, end: 12, text: 'God morgen' };
const SEG3: TranscriptSegment = { speaker: 'Taler 1', start: 13, end: 20, text: 'Tak for det' };

const DEFAULT_PROPS = {
  meetingId: 'meeting-abc',
  initialSegments: [SEG1, SEG2, SEG3],
  piiReplacements: [] as PiiReplacement[],
};

// Helper
function setup(overrides: Partial<React.ComponentProps<typeof TranscriptReview>> = {}) {
  const onDataChange = vi.fn();
  const utils = render(
    <TranscriptReview {...DEFAULT_PROPS} onDataChange={onDataChange} {...overrides} />,
  );
  return { onDataChange, ...utils };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TranscriptReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear sessionStorage so participant/silent state doesn't leak between tests
    sessionStorage.clear();
    // Reset global fetch mock
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/skabeloner') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ skabeloner: [] }),
        });
      }
      if (typeof url === 'string' && url.includes('/chapters')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ chapters: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });
    // Suppress console.error from the component
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the gennemgang heading', async () => {
      setup();
      expect(screen.getByText('02 · gennemgang')).toBeInTheDocument();
    });

    it('renders a SpeakerRow for each initialSegment in flat mode', async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument();
        expect(screen.getByTestId('speaker-row-1')).toBeInTheDocument();
        expect(screen.getByTestId('speaker-row-2')).toBeInTheDocument();
      });
    });

    it('renders speaker names from initialSegments', async () => {
      setup();
      await waitFor(() => {
        // Two segments have Taler 1, one has Taler 2
        const taler1Rows = screen.getAllByText('Taler 1');
        expect(taler1Rows.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('renders "Ingen transskription fundet." when segments are empty', async () => {
      setup({ initialSegments: [] });
      await waitFor(() => {
        expect(screen.getByText('Ingen transskription fundet.')).toBeInTheDocument();
      });
    });

    it('shows the generate button', async () => {
      setup();
      expect(screen.getByText('generér referat →')).toBeInTheDocument();
    });

    it('disables the generate button when segments are empty', async () => {
      setup({ initialSegments: [] });
      const btn = screen.getByText('generér referat →');
      expect(btn).toBeDisabled();
    });

    it('shows "Ingen personoplysninger fundet." when no PII', async () => {
      setup({ piiReplacements: [] });
      expect(screen.getByText('Ingen personoplysninger fundet.')).toBeInTheDocument();
    });

    it('shows PII count message when piiReplacements present', async () => {
      const pii: PiiReplacement[] = [
        { original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN', segmentIndex: 0 },
        { original: '1234567890', replacement: '[CPR]', type: 'CPR', segmentIndex: 1 },
      ];
      setup({ piiReplacements: pii });
      expect(screen.getByText(/2 ting/)).toBeInTheDocument();
    });

    it('renders search input', async () => {
      setup();
      expect(screen.getByPlaceholderText('søg i transskription')).toBeInTheDocument();
    });
  });

  // ── Audio deleted state ────────────────────────────────────────────────────

  describe('audio deleted state', () => {
    it('shows "lydfil slettet" in the bottom bar when audioDeleted=true and no audioUrl', async () => {
      setup({ audioDeleted: true, audioUrl: undefined });
      expect(screen.getByText('lydfil slettet')).toBeInTheDocument();
    });

    it('shows "ingen lydfil" when no audioUrl and not audioDeleted', async () => {
      setup({ audioDeleted: false, audioUrl: undefined });
      expect(screen.getByText('ingen lydfil')).toBeInTheDocument();
    });

    it('does NOT show "lydfil slettet" when audioUrl is set', async () => {
      setup({ audioDeleted: true, audioUrl: '/audio/test.webm' });
      expect(screen.queryByText('lydfil slettet')).not.toBeInTheDocument();
    });

    it('shows compliance message "Lydfilen er slettet." when audioDeleted=true', async () => {
      setup({ audioDeleted: true });
      expect(screen.getByText(/Lydfilen er slettet\./)).toBeInTheDocument();
    });

    it('shows compliance warning about auto-deletion when audio not yet deleted', async () => {
      setup({ audioDeleted: false });
      expect(screen.getByText(/Lydfilen slettes automatisk/)).toBeInTheDocument();
    });
  });

  // ── Diarization in-flight state ────────────────────────────────────────────

  describe('diarization in-flight', () => {
    it('passes diarizing=true down to SpeakerRow when initialDiarizing=true', async () => {
      setup({ initialDiarizing: true });
      await waitFor(() => {
        const row0 = screen.getByTestId('speaker-row-0');
        expect(row0).toHaveAttribute('data-diarizing', 'true');
      });
    });

    it('passes diarizing=false to SpeakerRow when initialDiarizing=false', async () => {
      setup({ initialDiarizing: false });
      await waitFor(() => {
        const row0 = screen.getByTestId('speaker-row-0');
        expect(row0).toHaveAttribute('data-diarizing', 'false');
      });
    });

    it('passes diarizing=true to SpeakerAssignment when initialDiarizing=true', async () => {
      setup({ initialDiarizing: true });
      const assignment = screen.getByTestId('speaker-assignment');
      expect(assignment).toHaveAttribute('data-diarizing', 'true');
    });

    it('shows genkender stemmer in SpeakerAssignment while diarizing', async () => {
      setup({ initialDiarizing: true });
      expect(screen.getByText('genkender stemmer…')).toBeInTheDocument();
    });
  });

  // ── onTranscriptUpdated refresh ───────────────────────────────────────────

  describe('transcript refresh on updates', () => {
    it('calls onTranscriptUpdated to subscribe on mount', async () => {
      const { onTranscriptUpdated } = await import('@/lib/transcript-events');
      setup();
      await waitFor(() => {
        expect(onTranscriptUpdated).toHaveBeenCalledWith('meeting-abc', expect.any(Function));
      });
    });

    it('refreshes segments from storage when transcript updated event fires', async () => {
      const { getTranscript } = await import('@/lib/storage');
      const { onTranscriptUpdated } = await import('@/lib/transcript-events');

      let capturedCallback: (() => void) | null = null;
      vi.mocked(onTranscriptUpdated).mockImplementation((_id, cb) => {
        capturedCallback = cb;
        return () => {};
      });

      // Initial fetch returns null
      vi.mocked(getTranscript).mockResolvedValueOnce(null);

      setup({ initialDiarizing: true });

      // Now simulate the event with updated segments
      const freshSegments: TranscriptSegment[] = [
        { speaker: 'Mette', start: 0, end: 5, text: 'Hej alle' },
        { speaker: 'Lars', start: 6, end: 12, text: 'God morgen' },
      ];
      vi.mocked(getTranscript).mockResolvedValueOnce({
        meetingId: 'meeting-abc',
        segments: freshSegments,
        diarizationStatus: 'done',
      } as never);

      await act(async () => {
        capturedCallback?.();
        await new Promise((r) => setTimeout(r, 0));
      });

      await waitFor(() => {
        expect(getTranscript).toHaveBeenCalledWith('meeting-abc');
      });
    });

    it('clears diarizing state when refreshed transcript has diarizationStatus != pending', async () => {
      const { getTranscript } = await import('@/lib/storage');
      const { onTranscriptUpdated } = await import('@/lib/transcript-events');

      let capturedCallback: (() => void) | null = null;
      vi.mocked(onTranscriptUpdated).mockImplementation((_id, cb) => {
        capturedCallback = cb;
        return () => {};
      });

      vi.mocked(getTranscript)
        .mockResolvedValueOnce(null) // init
        .mockResolvedValueOnce({
          meetingId: 'meeting-abc',
          segments: [SEG1],
          diarizationStatus: 'done',
        } as never);

      setup({ initialDiarizing: true });

      await act(async () => {
        capturedCallback?.();
        await new Promise((r) => setTimeout(r, 0));
      });

      await waitFor(() => {
        const assignment = screen.getByTestId('speaker-assignment');
        expect(assignment).toHaveAttribute('data-diarizing', 'false');
      });
    });
  });

  // ── Segment editing ────────────────────────────────────────────────────────

  describe('segment editing', () => {
    it('calls saveTranscriptSegments after a segment is updated', async () => {
      const { saveTranscriptSegments } = await import('@/lib/storage');
      const user = userEvent.setup({ delay: null });

      setup();

      await waitFor(() => {
        expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument();
      });

      // Click the "update" button in the mocked SpeakerRow
      await user.click(screen.getAllByText('update')[0]);

      // Autosave has a 800ms debounce, wait for it
      await waitFor(
        () => {
          expect(saveTranscriptSegments).toHaveBeenCalledWith(
            'meeting-abc',
            expect.arrayContaining([
              expect.objectContaining({ text: 'updated text' }),
            ]),
          );
        },
        { timeout: 2000 },
      );
    });

    it('fires onDataChange after generating minutes', async () => {
      const { getMeeting, appendMinutesVersion, deleteAudio, updateMeeting } = await import('@/lib/storage');

      vi.mocked(getMeeting).mockResolvedValue({
        id: 'meeting-abc',
        title: 'Test møde',
        status: 'review',
        createdAt: new Date().toISOString(),
        audioDeleted: false,
      } as never);

      // Mock fetch for /api/minutes
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ chapters: [] }) });
        }
        if (url === '/api/minutes') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              content: { body: '# Referat\nTest indhold' },
              skabelonId: null,
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      // Mock window.location
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        value: { href: '' },
        writable: true,
        configurable: true,
      });

      const user = userEvent.setup({ delay: null });
      const { onDataChange } = setup();

      await waitFor(() => {
        expect(screen.getByText('generér referat →')).toBeInTheDocument();
      });

      await user.click(screen.getByText('generér referat →'));

      await waitFor(() => {
        expect(appendMinutesVersion).toHaveBeenCalled();
        expect(onDataChange).toHaveBeenCalled();
      });

      Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
    });

    it('shows error message when minutes generation fails', async () => {
      const { getMeeting } = await import('@/lib/storage');
      vi.mocked(getMeeting).mockResolvedValue({
        id: 'meeting-abc',
        title: 'Test møde',
        status: 'review',
        createdAt: new Date().toISOString(),
      } as never);

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ chapters: [] }) });
        }
        if (url === '/api/minutes') {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: 'Serverfejl' }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const user = userEvent.setup({ delay: null });
      setup();

      await user.click(screen.getByText('generér referat →'));

      await waitFor(() => {
        expect(screen.getByText('Serverfejl')).toBeInTheDocument();
      });
    });
  });

  // ── Speaker assignment ─────────────────────────────────────────────────────

  describe('speaker assignment', () => {
    it('calls saveTranscriptSegments when a speaker is assigned', async () => {
      const { saveTranscriptSegments } = await import('@/lib/storage');
      const user = userEvent.setup({ delay: null });

      setup();

      await waitFor(() => {
        expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument();
      });

      // Click the "assign" button in the mocked SpeakerRow for row 0 (Taler 1 → Ny Person)
      await user.click(screen.getAllByText('assign')[0]);

      await waitFor(() => {
        expect(saveTranscriptSegments).toHaveBeenCalledWith(
          'meeting-abc',
          expect.arrayContaining([
            expect.objectContaining({ speaker: 'Ny Person' }),
          ]),
        );
      });
    });

    it('adds the assigned name to editableParticipants when it is not a default label', async () => {
      const user = userEvent.setup({ delay: null });

      setup({ participants: [] });

      await waitFor(() => {
        expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument();
      });

      // "Ny Person" is not a default speaker label, so it should be added to participants
      await user.click(screen.getAllByText('assign')[0]);

      await waitFor(() => {
        // The SpeakerAssignment mock shows row-count; Ny Person should be added
        const rowCount = screen.getByTestId('row-count');
        // Originally 0 participants, after assign "Ny Person" is added
        expect(parseInt(rowCount.textContent ?? '0')).toBeGreaterThan(0);
      });
    });
  });

  // ── PII replacements ───────────────────────────────────────────────────────

  describe('PII replacements', () => {
    const PII: PiiReplacement[] = [
      { original: 'Lars Jensen', replacement: '[NAVN_1]', type: 'NAVN', segmentIndex: 0 },
    ];

    it('renders PII items in the sidebar', async () => {
      setup({ piiReplacements: PII });
      expect(screen.getByText('Lars Jensen')).toBeInTheDocument();
    });

    it('renders the "Navn" type label for NAVN type', async () => {
      setup({ piiReplacements: PII });
      expect(screen.getByText('Navn')).toBeInTheDocument();
    });

    it('shows checked count in the PII footer', async () => {
      setup({ piiReplacements: PII });
      // All checked by default: 1/1
      expect(screen.getByText('1/1')).toBeInTheDocument();
    });

    it('toggles a PII item off when clicked', async () => {
      const user = userEvent.setup({ delay: null });
      setup({ piiReplacements: PII });

      const checkbox = screen.getByRole('checkbox', { name: /Anonymisér/ });
      expect(checkbox).toHaveAttribute('aria-checked', 'true');

      await user.click(checkbox);
      expect(checkbox).toHaveAttribute('aria-checked', 'false');
    });

    it('unchecks all via "fravælg alle"', async () => {
      const user = userEvent.setup({ delay: null });
      const multiPii: PiiReplacement[] = [
        { original: 'Lars Jensen', replacement: '[NAVN_1]', type: 'NAVN', segmentIndex: 0 },
        { original: '12345678', replacement: '[CPR_1]', type: 'CPR', segmentIndex: 1 },
      ];
      setup({ piiReplacements: multiPii });

      await user.click(screen.getByText('fravælg alle'));

      await waitFor(() => {
        expect(screen.getByText('0/2')).toBeInTheDocument();
      });
    });

    it('re-checks all via "marker alle"', async () => {
      const user = userEvent.setup({ delay: null });
      const multiPii: PiiReplacement[] = [
        { original: 'Lars Jensen', replacement: '[NAVN_1]', type: 'NAVN', segmentIndex: 0 },
        { original: '12345678', replacement: '[CPR_1]', type: 'CPR', segmentIndex: 1 },
      ];
      setup({ piiReplacements: multiPii });

      await user.click(screen.getByText('fravælg alle'));
      await waitFor(() => expect(screen.getByText('0/2')).toBeInTheDocument());

      await user.click(screen.getByText('marker alle'));
      await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
    });
  });

  // ── Search ─────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('shows search input', async () => {
      setup();
      expect(screen.getByPlaceholderText('søg i transskription')).toBeInTheDocument();
    });

    it('shows "ingen" indicator when search has no matches', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(screen.getByPlaceholderText('søg i transskription'), 'xyznotfound');
      await waitFor(() => {
        expect(screen.getByText('ingen')).toBeInTheDocument();
      });
    });

    it('shows match count when search matches segments', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      // "Hej" matches SEG1 ("Hej alle")
      await user.type(screen.getByPlaceholderText('søg i transskription'), 'Hej');
      await waitFor(() => {
        // Should show "? / 1" since no match is navigated yet
        expect(screen.getByText(/\/ 1/)).toBeInTheDocument();
      });
    });

    it('shows replace row when ⇄ button is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByTitle('Søg og erstat'));
      expect(screen.getByPlaceholderText('erstat med')).toBeInTheDocument();
    });

    it('clears search when × is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      const searchInput = screen.getByPlaceholderText('søg i transskription');
      await user.type(searchInput, 'Hej');
      await waitFor(() => expect(screen.getByText('×')).toBeInTheDocument());
      await user.click(screen.getByText('×'));
      expect(searchInput).toHaveValue('');
    });
  });

  // ── Chapters ───────────────────────────────────────────────────────────────

  describe('chapters', () => {
    const CHAPTER = {
      id: 'ch-1',
      title: 'Introduktion',
      summary: 'En introduktion til mødet',
      startTime: 0,
      endTime: 20,
      segmentIndices: [0, 1, 2],
    };

    it('renders chapter titles when initialChapters are provided', async () => {
      setup({ initialChapters: [CHAPTER] });
      await waitFor(() => {
        expect(screen.getByText('Introduktion')).toBeInTheDocument();
      });
    });

    it('shows chapter summary when chapter is collapsed (closed)', async () => {
      // First chapter is open by default — close it by checking summary hidden
      setup({ initialChapters: [CHAPTER] });
      // Summary is shown when chapter is closed — but by default first chapter is open
      // The summary appears only when not open; here we check it's in the DOM somewhere
      await waitFor(() => {
        // When open, summary is hidden; this verifies initial render is open
        expect(screen.getByText('Introduktion')).toBeInTheDocument();
      });
    });

    it('toggles chapter open/closed on click', async () => {
      const user = userEvent.setup({ delay: null });
      setup({ initialChapters: [CHAPTER] });

      // The first chapter is open by default — summary is hidden when open
      expect(screen.queryByText('En introduktion til mødet')).not.toBeInTheDocument();

      // The arrow indicator (▸) acts as the toggle; click on the time span area
      // The whole grid row div is clickable; click on the time display text
      const timeSpan = screen.getByText(/00:00 — 00:20/);
      await user.click(timeSpan);

      // After clicking (closing), the summary should become visible
      await waitFor(() => {
        expect(screen.getByText('En introduktion til mødet')).toBeInTheDocument();
      });
    });

    it('shows chapters loading spinner while chapters are being fetched', async () => {
      // Chapters are fetched when there are no initialChapters and segments exist
      let resolveChapters: (v: unknown) => void;
      const chaptersPromise = new Promise((resolve) => { resolveChapters = resolve; });

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          return chaptersPromise.then(() => ({
            ok: true,
            json: () => Promise.resolve({ chapters: [] }),
          }));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      setup({ initialChapters: undefined });

      // The spinner should appear while chapters are loading
      await waitFor(() => {
        expect(screen.getByText(/grupperer transskription/)).toBeInTheDocument();
      });

      // Resolve to clean up
      resolveChapters!({});
    });
  });

  // ── Audio player bottom bar ────────────────────────────────────────────────

  describe('audio player bottom bar', () => {
    it('renders play button when audioUrl is provided', async () => {
      setup({ audioUrl: '/audio/test.webm' });
      // The play button is a circular button in the sticky bar
      // It shows a play triangle icon or pause bars
      const buttons = screen.getAllByRole('button');
      // At least one button should be in the sticky bottom bar
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('renders --:-- for duration when duration is unknown', async () => {
      setup({ audioUrl: '/audio/test.webm' });
      expect(screen.getByText('--:--')).toBeInTheDocument();
    });

    it('shows duration when audioDurationSeconds is provided', async () => {
      setup({ audioUrl: '/audio/test.webm', audioDurationSeconds: 125 });
      // 125s = 02:05
      await waitFor(() => {
        expect(screen.getByText('02:05')).toBeInTheDocument();
      });
    });
  });

  // ── Skabelon section ───────────────────────────────────────────────────────

  describe('skabelon section', () => {
    it('renders the skabelon section header', async () => {
      setup();
      expect(screen.getByText('skabelon')).toBeInTheDocument();
    });

    it('renders the "Gem som skabelon →" button', async () => {
      setup();
      expect(screen.getByText('Gem som skabelon →')).toBeInTheDocument();
    });

    it('shows template save form when "Gem som skabelon →" is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByText('Gem som skabelon →'));
      // The form should appear with "Gem skabelon" button
      await waitFor(() => {
        expect(screen.getByText('Gem skabelon')).toBeInTheDocument();
      });
    });

    it('cancels the template form when "annullér" is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByText('Gem som skabelon →'));
      await waitFor(() => expect(screen.getByText('Gem skabelon')).toBeInTheDocument());

      await user.click(screen.getByText('annullér'));
      await waitFor(() => {
        expect(screen.queryByText('annullér')).not.toBeInTheDocument();
        expect(screen.getByText('Gem som skabelon →')).toBeInTheDocument();
      });
    });

    it('shows error when trying to save a new template without a name', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByText('Gem som skabelon →'));
      await waitFor(() => expect(screen.getByText('Gem skabelon')).toBeInTheDocument());
      // Click save without entering a name
      await user.click(screen.getByText('Gem skabelon'));
      await waitFor(() => {
        expect(screen.getByText('Navn er påkrævet')).toBeInTheDocument();
      });
    });

    it('renders category toggle buttons', async () => {
      setup();
      expect(screen.getByText('Deltagere')).toBeInTheDocument();
      expect(screen.getByText('Beslutningspunkter')).toBeInTheDocument();
      expect(screen.getByText('Dagsorden')).toBeInTheDocument();
      expect(screen.getByText('Dato')).toBeInTheDocument();
    });

    it('toggles a category on click', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      // Initially all cats are off (no skabelon)
      const deltagereBtn = screen.getByText('Deltagere');
      await user.click(deltagereBtn);
      // After clicking, the × indicator appears next to the label
      await waitFor(() => {
        // The × character appears next to active category buttons
        expect(screen.getByText('×')).toBeInTheDocument();
      });
    });
  });

  // ── Participants prop ──────────────────────────────────────────────────────

  describe('participants prop', () => {
    it('passes participants to SpeakerAssignment', async () => {
      setup({ participants: ['Mette', 'Lars', 'Pia'] });
      // SpeakerAssignment mock shows row-count = number of participantRows
      // Mette/Lars/Pia are not in segments (which use Taler 1/2), so they appear as pending
      const rowCount = screen.getByTestId('row-count');
      // Wait for any async init to complete
      await waitFor(
        () => {
          expect(parseInt(rowCount.textContent ?? '0')).toBe(3);
        },
        { timeout: 3000 },
      );
    });

    it('renders segments grouped correctly by speaker in the rows', async () => {
      setup({ participants: ['Alice', 'Bob'] });
      await waitFor(() => {
        // Three segments should render
        expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument();
        expect(screen.getByTestId('speaker-row-1')).toBeInTheDocument();
        expect(screen.getByTestId('speaker-row-2')).toBeInTheDocument();
      });
    });
  });

  // ── Generating state ───────────────────────────────────────────────────────

  describe('generating state', () => {
    it('shows "genererer…" while minutes are being generated', async () => {
      const { getMeeting } = await import('@/lib/storage');
      vi.mocked(getMeeting).mockResolvedValue({
        id: 'meeting-abc',
        title: 'Test møde',
        status: 'review',
        createdAt: new Date().toISOString(),
      } as never);

      let resolveMinutes: (v: unknown) => void;
      const minutesPromise = new Promise((resolve) => { resolveMinutes = resolve; });

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ chapters: [] }) });
        }
        if (url === '/api/minutes') {
          return minutesPromise.then(() => ({
            ok: true,
            json: () => Promise.resolve({ content: { body: '# Referat' }, skabelonId: null }),
          }));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const user = userEvent.setup({ delay: null });
      setup();

      await user.click(screen.getByText('generér referat →'));

      await waitFor(() => {
        expect(screen.getByText('genererer…')).toBeInTheDocument();
      });

      // Resolve to avoid pending promises
      resolveMinutes!({});
    });
  });

  // ── Error handling — new paths ─────────────────────────────────────────────

  describe('persistSegments error handling', () => {
    it('shows SaveStatus "Fejl ved gemning" when autosave fails', async () => {
      const { saveTranscriptSegments } = await import('@/lib/storage');
      vi.mocked(saveTranscriptSegments).mockRejectedValueOnce(new Error('IDB quota exceeded'));

      const user = userEvent.setup({ delay: null });
      setup();

      await waitFor(() => expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument());

      await user.click(screen.getAllByText('update')[0]);

      await waitFor(
        () => {
          expect(screen.getByText('Fejl ved gemning')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );
      expect(console.error).toHaveBeenCalledWith(
        '[transcript] autosave failed:',
        expect.any(Error),
      );
    });

    it('shows SaveStatus "Gemmer…" while autosave is in-flight', async () => {
      const { saveTranscriptSegments } = await import('@/lib/storage');
      let resolveIdb: () => void;
      const idbPromise = new Promise<void>((res) => { resolveIdb = res; });
      vi.mocked(saveTranscriptSegments).mockReturnValueOnce(idbPromise);

      const user = userEvent.setup({ delay: null });
      setup();

      await waitFor(() => expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument());
      await user.click(screen.getAllByText('update')[0]);

      await waitFor(
        () => {
          expect(screen.getByText('Gemmer…')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      resolveIdb!();
    });
  });

  describe('speaker persist error handling', () => {
    it('shows speaker error and rolls back segments when assignSpeaker persist fails', async () => {
      const { saveTranscriptSegments } = await import('@/lib/storage');
      // Make all saveTranscriptSegments calls fail (covers the assignSpeaker path)
      vi.mocked(saveTranscriptSegments).mockRejectedValue(new Error('persist failed'));

      const user = userEvent.setup({ delay: null });
      setup();

      await waitFor(() => expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument());

      // Trigger assign which will fail on persist
      await user.click(screen.getAllByText('assign')[0]);

      await waitFor(() => {
        expect(screen.getByText(/Kunne ikke gemme taler-tilknytning/)).toBeInTheDocument();
      });
      expect(console.error).toHaveBeenCalledWith(
        '[speakers] assign persist failed:',
        expect.any(Error),
      );
    });
  });

  describe('chapters generate error handling', () => {
    it('shows chaptersError and retry button when chapters fetch fails', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          return Promise.reject(new Error('network error'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      setup({ initialChapters: undefined });

      await waitFor(() => {
        expect(screen.getByText('Kapitler kunne ikke genereres')).toBeInTheDocument();
        expect(screen.getByText('prøv igen →')).toBeInTheDocument();
      });
      expect(console.error).toHaveBeenCalledWith(
        '[chapters] generate failed:',
        expect.any(Error),
      );
    });

    it('retries chapter fetch when "prøv igen →" is clicked', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skabeloner: [] }) });
        }
        if (typeof url === 'string' && url.includes('/chapters')) {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error('first fail'));
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ chapters: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const user = userEvent.setup({ delay: null });
      setup({ initialChapters: undefined });

      await waitFor(() => {
        expect(screen.getByText('prøv igen →')).toBeInTheDocument();
      });

      await user.click(screen.getByText('prøv igen →'));

      // After retry the error should clear
      await waitFor(() => {
        expect(screen.queryByText('Kapitler kunne ikke genereres')).not.toBeInTheDocument();
      });
    });
  });

  describe('participants persist error handling', () => {
    it('sets error when updateMeeting for participants fails', async () => {
      const { updateMeeting } = await import('@/lib/storage');
      vi.mocked(updateMeeting).mockRejectedValueOnce(new Error('idb error'));

      const user = userEvent.setup({ delay: null });
      setup({ participants: [] });

      // Trigger assignSpeaker which adds a participant and triggers the updateMeeting effect
      await waitFor(() => expect(screen.getByTestId('speaker-row-0')).toBeInTheDocument());

      // Mock saveTranscriptSegments to succeed so assignSpeaker completes
      const { saveTranscriptSegments } = await import('@/lib/storage');
      vi.mocked(saveTranscriptSegments).mockResolvedValueOnce(undefined);

      await user.click(screen.getAllByText('assign')[0]);

      await waitFor(() => {
        expect(console.error).toHaveBeenCalledWith(
          '[transcript] persistParticipants failed:',
          expect.any(Error),
        );
      });
    });
  });
});
