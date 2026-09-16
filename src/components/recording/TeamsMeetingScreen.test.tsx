// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TeamsMeetingScreen, ORGANIZER_REQUEST } from './TeamsMeetingScreen';

const mockPush = vi.fn();
const mockRouter = { push: mockPush };
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

const mockSignInSocial = vi.fn();
vi.mock('@/lib/auth-client', () => ({
  signIn: { social: (...args: unknown[]) => mockSignInSocial(...args) },
}));

vi.mock('@/lib/storage', () => ({
  saveAudio: vi.fn().mockResolvedValue(undefined),
  updateMeeting: vi.fn().mockResolvedValue(undefined),
  deleteMeeting: vi.fn().mockResolvedValue(undefined),
}));

import { saveAudio, updateMeeting, deleteMeeting } from '@/lib/storage';
const mockSaveAudio = vi.mocked(saveAudio);
const mockUpdateMeeting = vi.mocked(updateMeeting);
const mockDeleteMeeting = vi.mocked(deleteMeeting);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MEETING_ID = 'meet-1';
const MEETING_URL = 'https://teams.microsoft.com/l/meetup-join/19:abc@thread.v2/0';

type Status = Record<string, unknown>;

function statusBody(overrides: Status = {}): Status {
  return {
    id: MEETING_ID,
    state: 'awaiting_teams',
    armed: true,
    isOrganizer: true,
    subject: 'Ugentligt teammøde',
    scheduledStart: '2026-09-10T09:00:00.000Z',
    scheduledEnd: '2026-09-10T10:00:00.000Z',
    failureReason: null,
    lastPolledAt: null,
    ...overrides,
  };
}

/** What GET /api/bot/audio/<id> answers with; overridden per test. */
let audioResponse: unknown = null;

function jsonAudio(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function respondWith(bodies: Status[] | Status) {
  const queue = Array.isArray(bodies) ? [...bodies] : null;
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/bot/audio/')) {
      // Default: nothing to collect, so the screen continues straight on.
      return audioResponse ?? jsonAudio({ status: 'no-recording' });
    }
    const body = queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : (bodies as Status);
    return { ok: true, status: 200, json: async () => body };
  });
}

function renderScreen(url = MEETING_URL) {
  return render(<TeamsMeetingScreen meetingId={MEETING_ID} meetingUrl={url} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  audioResponse = null;
  mockSaveAudio.mockResolvedValue(undefined);
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockDeleteMeeting.mockResolvedValue(undefined);
  respondWith(statusBody());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TeamsMeetingScreen — armed, awaiting', () => {
  it('polls the meeting status on mount without ?poll=1', async () => {
    renderScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0][0]).toBe(`/api/teams/meetings/${MEETING_ID}`);
  });

  it('shows subject, the armed badge and the automatic-recording copy', async () => {
    renderScreen();
    expect(await screen.findByText('Ugentligt teammøde')).toBeInTheDocument();
    expect(screen.getByTestId('armed-badge')).toHaveTextContent('Memoctopus er slået til');
    expect(
      screen.getByText(/Mødet optages og transskriberes automatisk/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Venter på mødet/)).toBeInTheDocument();
  });

  it('renders "Åbn i Teams" pointing at the meeting url in a new tab', async () => {
    renderScreen();
    const link = await screen.findByText('Åbn i Teams');
    expect(link).toHaveAttribute('href', MEETING_URL);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('omits the Teams link when no meeting url is known', async () => {
    renderScreen('');
    await screen.findByText('Ugentligt teammøde');
    expect(screen.queryByText('Åbn i Teams')).toBeNull();
  });
});

describe('TeamsMeetingScreen — invitee (not armed)', () => {
  beforeEach(() => {
    respondWith(statusBody({ armed: false, isOrganizer: false }));
  });

  it('shows the copy-paste sentence for the organizer', async () => {
    renderScreen();
    expect(await screen.findByText(ORGANIZER_REQUEST)).toBeInTheDocument();
    expect(screen.queryByTestId('armed-badge')).toBeNull();
  });

  it('notes that a manually started transcription is still picked up', async () => {
    renderScreen();
    expect(
      await screen.findByText(/hvis nogen starter transskription undervejs/),
    ).toBeInTheDocument();
  });

  it('copies the sentence to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderScreen();
    const btn = await screen.findByText('Kopiér beskeden');
    await act(async () => { fireEvent.click(btn); });
    expect(writeText).toHaveBeenCalledWith(ORGANIZER_REQUEST);
    await waitFor(() => expect(screen.getByText('Kopieret')).toBeInTheDocument());
  });
});

describe('TeamsMeetingScreen — fetching state', () => {
  it('shows the "henter transskription" line', async () => {
    respondWith(statusBody({ state: 'fetching' }));
    renderScreen();
    expect(await screen.findByText(/Henter transskription fra Teams/)).toBeInTheDocument();
  });
});

describe('TeamsMeetingScreen — ready', () => {
  it('marks the meeting as processing and routes to the review page', async () => {
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await waitFor(() => {
      expect(mockUpdateMeeting).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ status: 'processing' }),
      );
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`);
    });
  });

  it('downloads the stashed recording into IndexedDB before routing', async () => {
    // Without this the review screen opens on an empty IndexedDB and
    // ProcessingTranscription fails with "Lydfil ikke fundet".
    const blob = new Blob(['wav'], { type: 'audio/wav' });
    audioResponse = {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'audio/wav',
        'X-Participants': encodeURIComponent(JSON.stringify(['Mette Hansen', 'Jens Poulsen'])),
        'X-Duration': '540',
      }),
      blob: async () => blob,
    };
    respondWith(statusBody({ state: 'ready' }));

    renderScreen();

    await waitFor(() => expect(mockSaveAudio).toHaveBeenCalledWith(MEETING_ID, blob, 'audio/wav'));
    expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, expect.objectContaining({
      status: 'processing',
      participants: ['Mette Hansen', 'Jens Poulsen'],
      audioDurationSeconds: 540,
    }));
    expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`);
  });

  it('keeps the Teams speaker names in transcript-only mode, with no audio', async () => {
    audioResponse = jsonAudio({
      status: 'no-recording',
      participants: ['Mette Hansen'],
      durationSeconds: 300,
    });
    respondWith(statusBody({ state: 'ready' }));

    renderScreen();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`));
    expect(mockSaveAudio).not.toHaveBeenCalled();
    expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, expect.objectContaining({
      status: 'processing',
      participants: ['Mette Hansen'],
    }));
  });

  it('routes only once even if the poll runs again', async () => {
    vi.useFakeTimers();
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe('TeamsMeetingScreen — blocked by tenant policy', () => {
  it('explains the policy and links the admin guide instead of the invitee copy', async () => {
    // An organizer whose tenant blocks recording used to be told they were not
    // the organizer, which is simply untrue.
    respondWith(statusBody({ armed: false, armResult: 'policy_blocked' }));
    renderScreen();

    expect(await screen.findByText(/Teams-politik blokerer/)).toBeInTheDocument();
    expect(screen.getByText('opsætningsguiden')).toHaveAttribute(
      'href',
      '/docs/setup-microsoft-teams.md',
    );
    expect(screen.queryByText(/ikke organisator/)).not.toBeInTheDocument();
  });

  it('still shows the invitee copy for a plain non-organizer', async () => {
    respondWith(statusBody({ armed: false, armResult: 'not_organizer' }));
    renderScreen();
    expect(await screen.findByText(/ikke organisator/)).toBeInTheDocument();
  });
});

describe('TeamsMeetingScreen — failed', () => {
  beforeEach(() => {
    respondWith(statusBody({ state: 'failed', armed: false, failureReason: 'Transskriptionen blev aldrig startet i Teams.' }));
  });

  it('shows the failure reason from the server', async () => {
    renderScreen();
    expect(await screen.findByText('Transskriptionen blev aldrig startet i Teams.')).toBeInTheDocument();
  });

  it('offers "Prøv igen" and "Slet"', async () => {
    renderScreen();
    expect(await screen.findByText('Prøv igen')).toBeInTheDocument();
    expect(screen.getByText('Slet')).toBeInTheDocument();
  });

  it('"Prøv igen" forces a poll with ?poll=1', async () => {
    renderScreen();
    const btn = await screen.findByText('Prøv igen');
    mockFetch.mockClear();
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}?poll=1`);
    });
  });
});

describe('TeamsMeetingScreen — needs_reauth', () => {
  it('offers the Microsoft re-consent button', async () => {
    respondWith(statusBody({ state: 'needs_reauth', armed: false }));
    renderScreen();
    const btn = await screen.findByText('Log ind med Microsoft igen');
    await act(async () => { fireEvent.click(btn); });
    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'microsoft',
      callbackURL: `/meeting/${MEETING_ID}`,
    });
  });
});

describe('TeamsMeetingScreen — manual check and disarm', () => {
  it('"Tjek nu" polls with ?poll=1', async () => {
    renderScreen();
    const btn = await screen.findByText('Tjek nu');
    mockFetch.mockClear();
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}?poll=1`);
    });
  });

  it('"Slå Memoctopus fra" deletes server-side and locally, then returns to the dashboard', async () => {
    renderScreen();
    const btn = await screen.findByText('Slå Memoctopus fra');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}`, { method: 'DELETE' });
      expect(mockDeleteMeeting).toHaveBeenCalledWith(MEETING_ID);
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });
});

describe('TeamsMeetingScreen — polling behaviour', () => {
  it('re-polls every 15 seconds while awaiting', async () => {
    vi.useFakeTimers();
    renderScreen();
    await act(async () => { await Promise.resolve(); });
    const initial = mockFetch.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(initial);
  });

  it('forces ?poll=1 on the first tick after the scheduled end has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T10:30:00.000Z'));
    renderScreen();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(mockFetch.mock.calls[0][0]).toBe(`/api/teams/meetings/${MEETING_ID}`);
    mockFetch.mockClear();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}?poll=1`);
  });

  it('stops polling once the state is failed', async () => {
    vi.useFakeTimers();
    respondWith(statusBody({ state: 'failed' }));
    renderScreen();
    await act(async () => { await Promise.resolve(); });
    const initial = mockFetch.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(mockFetch.mock.calls.length).toBe(initial);
  });
});

describe('TeamsMeetingScreen — error handling', () => {
  it('shows a Danish message when the meeting is unknown server-side', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/ikke registreret hos Teams/);
  });

  it('shows a Danish message when the status request fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Kunne ikke hente status fra Teams/);
  });
});
