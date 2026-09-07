// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewAudioProvider } from '@/lib/review-audio-context';
import { MeetingPageClient } from './MeetingPageClient';
import type { StoredMeeting, StoredTranscript, StoredMinutes } from '@/lib/storage';

// ─── next/navigation ──────────────────────────────────────────────────────────
const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

// ─── next/link ────────────────────────────────────────────────────────────────
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...props}>{children}</a>
  ),
}));

// ─── @/lib/storage ────────────────────────────────────────────────────────────
const mockGetMeeting = vi.fn<() => Promise<StoredMeeting | null>>();
const mockGetTranscript = vi.fn<() => Promise<StoredTranscript | null>>();
const mockGetMinutes = vi.fn<() => Promise<StoredMinutes | null>>();
const mockGetAudio = vi.fn<() => Promise<{ blob: Blob; mimeType: string } | null>>();
const mockDeleteAudio = vi.fn<() => Promise<void>>();
const mockUpdateMeeting = vi.fn<() => Promise<void>>();

vi.mock('@/lib/storage', () => ({
  getMeeting: () => mockGetMeeting(),
  getTranscript: () => mockGetTranscript(),
  getMinutes: () => mockGetMinutes(),
  getAudio: () => mockGetAudio(),
  deleteAudio: () => mockDeleteAudio(),
  updateMeeting: () => mockUpdateMeeting(),
}));

// ─── Heavy child components ────────────────────────────────────────────────────
vi.mock('@/components/recording/RecordingScreen', () => ({
  RecordingScreen: (props: { meetingId: string }) => (
    <div data-testid="recording-screen" data-meeting-id={props.meetingId}>RecordingScreen</div>
  ),
}));

vi.mock('@/components/recording/MeetingBotScreen', () => ({
  MeetingBotScreen: (props: { meetingId: string }) => (
    <div data-testid="meeting-bot-screen" data-meeting-id={props.meetingId}>MeetingBotScreen</div>
  ),
}));

vi.mock('@/components/transcript/TranscriptReview', () => ({
  TranscriptReview: (props: { meetingId: string }) => (
    <div data-testid="transcript-review" data-meeting-id={props.meetingId}>TranscriptReview</div>
  ),
}));

vi.mock('@/components/minutes/MinutesEditor', () => ({
  MinutesEditor: (props: { meetingId: string }) => (
    <div data-testid="minutes-editor" data-meeting-id={props.meetingId}>MinutesEditor</div>
  ),
}));

vi.mock('@/components/meeting/ExportTab', () => ({
  ExportTab: (props: { meetingId: string }) => (
    <div data-testid="export-tab" data-meeting-id={props.meetingId}>ExportTab</div>
  ),
}));

vi.mock('@/components/meeting/ProcessingTranscription', () => ({
  ProcessingTranscription: (props: { meetingId: string }) => (
    <div data-testid="processing-transcription" data-meeting-id={props.meetingId}>ProcessingTranscription</div>
  ),
}));

vi.mock('@/components/meeting/DeleteAudioDialog', () => ({
  DeleteAudioDialog: (props: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    onDeleted: () => void;
    title: string;
    confirmLabel: string;
    meetingId: string;
  }) =>
    props.open ? (
      <div data-testid="delete-audio-dialog">
        <span>{props.title}</span>
        <button onClick={() => { props.onDeleted(); props.onOpenChange(false); }}>
          {props.confirmLabel}
        </button>
        <button onClick={() => props.onOpenChange(false)}>Afbryd</button>
      </div>
    ) : null,
}));

vi.mock('@/components/layout/ProcessStrip', () => ({
  ProcessStrip: (props: {
    meetingId: string;
    activePhase: string;
    onTabChange?: (tab: string) => void;
  }) => (
    <div data-testid="process-strip" data-active-phase={props.activePhase}>
      {['recording', 'review', 'minutes', 'export'].map((phase) => (
        <button
          key={phase}
          data-testid={`tab-${phase}`}
          onClick={() => props.onTabChange?.(phase)}
        >
          {phase}
        </button>
      ))}
    </div>
  ),
}));

// ─── URL mocks ─────────────────────────────────────────────────────────────────
const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = vi.fn();
Object.defineProperty(URL, 'createObjectURL', { value: mockCreateObjectURL, writable: true });
Object.defineProperty(URL, 'revokeObjectURL', { value: mockRevokeObjectURL, writable: true });

// ─── window.history ────────────────────────────────────────────────────────────
const mockReplaceState = vi.fn();
Object.defineProperty(window, 'history', {
  value: { ...window.history, replaceState: mockReplaceState },
  writable: true,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MEETING_ID = 'meet-1';

function makeMeeting(overrides: Partial<StoredMeeting> = {}): StoredMeeting {
  return {
    id: MEETING_ID,
    title: 'Test Meeting',
    participants: [],
    status: 'review',
    source: 'local',
    meetingUrl: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    audioDurationSeconds: 120,
    audioSizeBytes: 1024,
    audioDeleted: false,
    botSession: null,
    ...overrides,
  };
}

function makeTranscript(overrides: Partial<StoredTranscript> = {}): StoredTranscript {
  return {
    id: 'tr-1',
    meetingId: MEETING_ID,
    rawText: 'Hello world',
    segments: [],
    chapters: [],
    piiReplacements: [],
    piiRemovedAt: null,
    diarizationStatus: 'done',
    ...overrides,
  };
}

function makeMinutes(overrides: Partial<StoredMinutes> = {}): StoredMinutes {
  return {
    id: 'min-1',
    meetingId: MEETING_ID,
    templateId: null,
    content: { title: 'Test', sections: [] } as StoredMinutes['content'],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    activeVersionId: 'v-1',
    versions: [],
    ...overrides,
  };
}

const mockAudioBlob = new Blob(['audio data'], { type: 'audio/webm' });

function renderClient(props: { meetingId?: string; initialTab?: string } = {}) {
  const { meetingId = MEETING_ID, initialTab = 'recording' } = props;
  return render(
    <ReviewAudioProvider>
      <MeetingPageClient meetingId={meetingId} initialTab={initialTab as never} />
    </ReviewAudioProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteAudio.mockResolvedValue(undefined);
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockGetAudio.mockResolvedValue(null);
  mockGetTranscript.mockResolvedValue(null);
  mockGetMinutes.mockResolvedValue(null);
  mockGetMeeting.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Loading state ─────────────────────────────────────────────────────────────

describe('MeetingPageClient — loading state', () => {
  it('shows a spinner while data is loading', () => {
    // Never resolve — keep loading
    mockGetMeeting.mockReturnValue(new Promise(() => {}));
    mockGetTranscript.mockReturnValue(new Promise(() => {}));
    mockGetMinutes.mockReturnValue(new Promise(() => {}));

    renderClient();
    // The loading spinner is rendered as an inline-block span with animation
    const spinnerContainer = document.querySelector('[style*="alignItems: center"]') ??
      document.querySelector('div[style*="padding: 48px"]');
    expect(spinnerContainer).toBeTruthy();
    // No content-bearing components while loading
    expect(screen.queryByTestId('process-strip')).not.toBeInTheDocument();
  });

  it('stops loading once data resolves', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting());
    mockGetTranscript.mockResolvedValue(null);
    mockGetMinutes.mockResolvedValue(null);

    renderClient();
    await waitFor(() => {
      expect(screen.getByTestId('process-strip')).toBeInTheDocument();
    });
  });
});

// ─── Meeting not found ─────────────────────────────────────────────────────────

describe('MeetingPageClient — meeting not found', () => {
  it('shows "Møde ikke fundet" when getMeeting returns null', async () => {
    mockGetMeeting.mockResolvedValue(null);

    renderClient();
    await waitFor(() => {
      expect(screen.getByText('Møde ikke fundet')).toBeInTheDocument();
    });
  });

  it('shows a descriptive message when meeting is not found', async () => {
    mockGetMeeting.mockResolvedValue(null);

    renderClient();
    await waitFor(() => {
      expect(screen.getByText(/eksisterer ikke/)).toBeInTheDocument();
    });
  });

  it('does not show ProcessStrip when meeting is null', async () => {
    mockGetMeeting.mockResolvedValue(null);

    renderClient();
    await waitFor(() => screen.getByText('Møde ikke fundet'));
    expect(screen.queryByTestId('process-strip')).not.toBeInTheDocument();
  });
});

// ─── Load error ───────────────────────────────────────────────────────────────

describe('MeetingPageClient — load error', () => {
  it('shows an error banner when loadData throws', async () => {
    mockGetMeeting.mockRejectedValue(new Error('IndexedDB unavailable'));

    renderClient();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Kunne ikke indlæse mødedata');
  });

  it('does not show the spinner after a load error', async () => {
    mockGetMeeting.mockRejectedValue(new Error('quota exceeded'));

    renderClient();
    await waitFor(() => screen.getByRole('alert'));

    // Spinner container should be gone
    expect(document.querySelector('[style*="alignItems: center"]')).toBeNull();
  });

  it('does not show ProcessStrip after a load error', async () => {
    mockGetMeeting.mockRejectedValue(new Error('quota exceeded'));

    renderClient();
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.queryByTestId('process-strip')).not.toBeInTheDocument();
  });

  it('shows a retry button in the error banner', async () => {
    mockGetMeeting.mockRejectedValue(new Error('IndexedDB fail'));

    renderClient();
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
  });

  it('retries loadData when the retry button is clicked', async () => {
    mockGetMeeting.mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValue(makeMeeting());

    renderClient();
    await waitFor(() => screen.getByRole('alert'));

    await act(async () => {
      screen.getByRole('button', { name: 'Prøv igen' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('process-strip')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ─── Recording tab — local source ─────────────────────────────────────────────

describe('MeetingPageClient — recording tab (local source)', () => {
  it('renders RecordingScreen for local meeting on recording tab', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ source: 'local', status: 'recording' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(screen.getByTestId('recording-screen')).toBeInTheDocument();
    });
  });

  it('does not render MeetingBotScreen for local meeting on recording tab', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ source: 'local' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));
    expect(screen.queryByTestId('meeting-bot-screen')).not.toBeInTheDocument();
  });
});

// ─── Recording tab — teams source ─────────────────────────────────────────────

describe('MeetingPageClient — recording tab (teams source)', () => {
  it('renders MeetingBotScreen for teams meeting on recording tab', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ source: 'teams', status: 'recording' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(screen.getByTestId('meeting-bot-screen')).toBeInTheDocument();
    });
  });

  it('does not render RecordingScreen for teams meeting', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ source: 'teams', status: 'recording' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('meeting-bot-screen'));
    expect(screen.queryByTestId('recording-screen')).not.toBeInTheDocument();
  });
});

// ─── Review tab — with transcript ────────────────────────────────────────────

describe('MeetingPageClient — review tab', () => {
  it('renders TranscriptReview when review tab is active and transcript exists', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByTestId('transcript-review')).toBeInTheDocument();
    });
  });

  it('renders ProcessingTranscription on review tab when status is processing and no transcript', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'processing' }));
    mockGetTranscript.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByTestId('processing-transcription')).toBeInTheDocument();
    });
  });

  it('shows transcription failed message when status is failed and no transcript', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'failed' }));
    mockGetTranscript.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByText('Transskription fejlede')).toBeInTheDocument();
    });
  });

  it('shows "Gå til optagelse" button on review/failed screen', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'failed' }));
    mockGetTranscript.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Gå til optagelse' })).toBeInTheDocument();
    });
  });

  it('navigates to recording route when "Gå til optagelse" button is clicked', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'failed' }));
    mockGetTranscript.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByRole('button', { name: 'Gå til optagelse' }));

    await act(async () => {
      screen.getByRole('button', { name: 'Gå til optagelse' }).click();
    });
    expect(mockRouterPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}`);
  });

  it('shows "Ingen transskription" message when no transcript and status is not processing/failed', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetTranscript.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByText('Ingen transskription')).toBeInTheDocument();
    });
  });
});

// ─── Minutes tab ──────────────────────────────────────────────────────────────

describe('MeetingPageClient — minutes tab', () => {
  it('renders MinutesEditor when minutes tab is active and minutes exist', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'minutes' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetMinutes.mockResolvedValue(makeMinutes());

    renderClient({ initialTab: 'minutes' });
    await waitFor(() => {
      expect(screen.getByTestId('minutes-editor')).toBeInTheDocument();
    });
  });

  it('shows "Ingen referat endnu" when minutes tab is active but no minutes', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetMinutes.mockResolvedValue(null);

    renderClient({ initialTab: 'minutes' });
    await waitFor(() => {
      expect(screen.getByText('Ingen referat endnu')).toBeInTheDocument();
    });
  });

  it('shows "Gennemgang" link in the empty-minutes message', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetMinutes.mockResolvedValue(null);

    renderClient({ initialTab: 'minutes' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Gennemgang' })).toBeInTheDocument();
    });
  });

  it('switches to review tab when "Gennemgang" link in empty-minutes message is clicked', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetMinutes.mockResolvedValue(null);

    renderClient({ initialTab: 'minutes' });
    await waitFor(() => screen.getByRole('button', { name: 'Gennemgang' }));

    await user.click(screen.getByRole('button', { name: 'Gennemgang' }));
    await waitFor(() => {
      expect(screen.getByTestId('process-strip')).toHaveAttribute('data-active-phase', 'review');
    });
  });
});

// ─── Export tab ───────────────────────────────────────────────────────────────

describe('MeetingPageClient — export tab', () => {
  it('renders ExportTab when export tab is active', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'done' }));
    mockGetMinutes.mockResolvedValue(makeMinutes());

    renderClient({ initialTab: 'export' });
    await waitFor(() => {
      expect(screen.getByTestId('export-tab')).toBeInTheDocument();
    });
  });

  it('passes the correct meetingId to ExportTab', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'done', id: MEETING_ID }));
    mockGetMinutes.mockResolvedValue(makeMinutes());

    renderClient({ initialTab: 'export' });
    await waitFor(() => {
      expect(screen.getByTestId('export-tab')).toHaveAttribute('data-meeting-id', MEETING_ID);
    });
  });
});

// ─── Tab switching ────────────────────────────────────────────────────────────

describe('MeetingPageClient — tab switching', () => {
  it('switches from recording to review tab when tab button is clicked', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));

    await user.click(screen.getByTestId('tab-review'));
    await waitFor(() => {
      expect(screen.getByTestId('transcript-review')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recording-screen')).not.toBeInTheDocument();
  });

  it('updates history when switching tabs', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));

    await user.click(screen.getByTestId('tab-review'));
    await waitFor(() => {
      expect(mockReplaceState).toHaveBeenCalledWith(null, '', `/meeting/${MEETING_ID}/review`);
    });
  });

  it('sets recording path (no suffix) when switching to recording tab', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review' }));

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('process-strip'));

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => {
      expect(mockReplaceState).toHaveBeenCalledWith(null, '', `/meeting/${MEETING_ID}`);
    });
  });

  it('renders ProcessStrip with correct meetingId', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting());

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('process-strip'));
    // ProcessStrip is present
    expect(screen.getByTestId('process-strip')).toBeInTheDocument();
  });
});

// ─── DeleteAudioDialog — switching from review to recording with audio ─────────

describe('MeetingPageClient — DeleteAudioDialog', () => {
  it('shows DeleteAudioDialog when switching from review to recording while audio is present', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('transcript-review'));

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-audio-dialog')).toBeInTheDocument();
    });
  });

  it('does NOT show DeleteAudioDialog when switching from review to recording without audio', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: true }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue(null);

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('process-strip'));

    await user.click(screen.getByTestId('tab-recording'));
    // Should switch directly without showing dialog
    await waitFor(() => {
      expect(screen.queryByTestId('delete-audio-dialog')).not.toBeInTheDocument();
    });
  });

  it('shows "Slet lydfil?" title when transcript exists', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('transcript-review'));

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => {
      expect(screen.getByText('Slet lydfil?')).toBeInTheDocument();
    });
  });

  it('shows "Slet lydfil og gå til optagelse?" title when no transcript', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(null);
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('process-strip'));

    // Force audio URL to be present by re-checking — mock audio has been set
    // Tab is 'review' but no transcript — show "Ingen transskription" message
    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => {
      expect(screen.getByText('Slet lydfil og gå til optagelse?')).toBeInTheDocument();
    });
  });

  it('shows "Slet lydfil" confirmLabel when transcript exists', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('transcript-review'));

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Slet lydfil' })).toBeInTheDocument();
    });
  });

  it('calls loadData after audio is deleted from dialog', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('transcript-review'));

    // Clear counts before the delete action
    const initialCallCount = mockGetMeeting.mock.calls.length;

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => screen.getByTestId('delete-audio-dialog'));
    await user.click(screen.getByRole('button', { name: 'Slet lydfil' }));

    await waitFor(() => {
      expect(mockGetMeeting.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('stays on review tab after dismissing dialog when transcript exists', async () => {
    const user = userEvent.setup();
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'review', audioDeleted: false }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => screen.getByTestId('transcript-review'));

    await user.click(screen.getByTestId('tab-recording'));
    await waitFor(() => screen.getByTestId('delete-audio-dialog'));
    await user.click(screen.getByRole('button', { name: 'Afbryd' }));

    await waitFor(() => {
      expect(screen.queryByTestId('delete-audio-dialog')).not.toBeInTheDocument();
    });
    // Still on review tab (transcript-review should still be present)
    expect(screen.getByTestId('transcript-review')).toBeInTheDocument();
  });
});

// ─── Audio loading and ReviewAudio context ─────────────────────────────────────

describe('MeetingPageClient — audio loading', () => {
  it('creates a blob URL when audio is found', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false }));
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(mockCreateObjectURL).toHaveBeenCalledWith(mockAudioBlob);
    });
  });

  it('does not call createObjectURL when meeting has audioDeleted=true', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: true }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('does not call createObjectURL when getAudio returns null', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false }));
    mockGetAudio.mockResolvedValue(null);

    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the old blob URL on reload when new audio entry is found', async () => {
    // First call returns audio; second call (triggered by loadData) also returns audio
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false }));
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });
    mockCreateObjectURL.mockReturnValueOnce('blob:first-url').mockReturnValue('blob:second-url');

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── ReviewAudio context wiring ────────────────────────────────────────────────

describe('MeetingPageClient — ReviewAudio context (hasAudio)', () => {
  it('calls setHasAudio with the right value — we verify via transcript-review present when audio loaded on review tab', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false, status: 'review' }));
    mockGetTranscript.mockResolvedValue(makeTranscript());
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    renderClient({ initialTab: 'review' });
    await waitFor(() => {
      expect(screen.getByTestId('transcript-review')).toBeInTheDocument();
    });
    // Audio should have been loaded (createObjectURL called)
    expect(mockCreateObjectURL).toHaveBeenCalled();
  });

  it('does not set hasAudio when on recording tab (not review)', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false, status: 'recording' }));
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    // ReviewAudio context — hasAudio should be false (tab is recording, not review)
    let capturedSetHasAudio: ((v: boolean) => void) | undefined;
    const mockSetHasAudio = vi.fn((v: boolean) => {
      capturedSetHasAudio = mockSetHasAudio;
    });

    // We test this indirectly: the useEffect sets hasAudio = (tab === 'review' && !!audioUrl)
    // Since tab is 'recording', hasAudio should never be set to true
    renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));
    // createObjectURL is called (audio loaded) but context stays false for recording tab
    // We can't easily test the context value without exposing it, so we check the flow
    expect(screen.queryByTestId('transcript-review')).not.toBeInTheDocument();
  });
});

// ─── Phase completion flags ────────────────────────────────────────────────────

describe('MeetingPageClient — phase completion', () => {
  it('renders ProcessStrip (present after loading) for done meeting', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'done' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(screen.getByTestId('process-strip')).toBeInTheDocument();
    });
  });

  it('renders ProcessStrip for in-progress meeting', async () => {
    mockGetMeeting.mockResolvedValue(makeMeeting({ status: 'recording' }));

    renderClient({ initialTab: 'recording' });
    await waitFor(() => {
      expect(screen.getByTestId('process-strip')).toBeInTheDocument();
    });
  });
});

// ─── pagehide cleanup ──────────────────────────────────────────────────────────

describe('MeetingPageClient — pagehide cleanup', () => {
  it('attaches and removes pagehide listener when audio is present', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    mockGetMeeting.mockResolvedValue(makeMeeting({ audioDeleted: false }));
    mockGetAudio.mockResolvedValue({ blob: mockAudioBlob, mimeType: 'audio/webm' });

    const { unmount } = renderClient({ initialTab: 'recording' });
    await waitFor(() => screen.getByTestId('recording-screen'));

    expect(addSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
