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
}));

vi.mock('@/lib/teams/client-delete', () => ({
  deleteMeetingAndUnregister: vi.fn().mockResolvedValue(undefined),
}));

import { saveAudio, updateMeeting } from '@/lib/storage';
import { deleteMeetingAndUnregister } from '@/lib/teams/client-delete';
const mockSaveAudio = vi.mocked(saveAudio);
const mockUpdateMeeting = vi.mocked(updateMeeting);
const mockDeleteMeeting = vi.mocked(deleteMeetingAndUnregister);

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

/** What GET /api/meetings/<id>/pending-meta answers with; overridden per test. */
let metaResponse: unknown = null;
/** What GET /api/meetings/<id>/pending-transcript answers with (the "is it still there" probe). */
let transcriptResponse: unknown = null;
/** What POST /api/teams/meetings/<id> (re-collect) answers with. */
let recollectResponse: unknown = null;

function jsonMeta(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function respondWith(bodies: Status[] | Status) {
  const queue = Array.isArray(bodies) ? [...bodies] : null;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/pending-transcript')) {
      // Default: the server copy is still there.
      return transcriptResponse ?? jsonMeta({ status: 'ready', segments: [], diarized: true });
    }
    if (String(url).startsWith('/api/meetings/')) {
      // Default: nothing to collect, so the screen continues straight on.
      return metaResponse ?? jsonMeta({ status: 'no-recording' });
    }
    if (init?.method === 'POST') return recollectResponse ?? jsonMeta(statusBody({ state: 'awaiting_teams' }));
    const body = queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : (bodies as Status);
    return { ok: true, status: 200, json: async () => body };
  });
}

function renderScreen(url = MEETING_URL) {
  return render(<TeamsMeetingScreen meetingId={MEETING_ID} meetingUrl={url} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  metaResponse = null;
  transcriptResponse = null;
  recollectResponse = null;
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
    // Before the scheduled end: the promise of automatic recording still stands.
    respondWith(statusBody({ scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString() }));
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
  // The state the screen used to hide: Teams has published, and the recording is
  // being downloaded and transcribed. Saying "Teams har ikke frigivet noget endnu"
  // for that was both wrong and indistinguishable from being stuck.
  it('says the meeting is being processed right now', async () => {
    respondWith(statusBody({ state: 'fetching' }));
    renderScreen();

    expect(await screen.findByText(/Teams har frigivet mødet/)).toBeInTheDocument();
    expect(screen.getByText(/optagelsen hentes/)).toBeInTheDocument();
    expect(screen.getByTestId('working-indicator')).toBeInTheDocument();
  });

  it('tells the user the tab can be closed', async () => {
    respondWith(statusBody({ state: 'fetching' }));
    renderScreen();
    expect(await screen.findByText(/Du behøver ikke blive på siden/)).toBeInTheDocument();
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

  // A Graph meeting publishes nothing until it has ended, so the recording is
  // transcribed server-side and dropped. The client collects the speaker names and
  // duration, never the audio, and must not write any into IndexedDB.
  it('collects the names and duration without saving any audio', async () => {
    metaResponse = jsonMeta({
      status: 'no-recording',
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
    });
    respondWith(statusBody({ state: 'ready' }));

    renderScreen();

    await waitFor(() =>
      expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, expect.objectContaining({
        status: 'processing',
        participants: ['Mette Hansen', 'Jens Poulsen'],
        audioDurationSeconds: 540,
      })),
    );
    expect(mockSaveAudio).not.toHaveBeenCalled();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`));
  });

  it('keeps the Teams speaker names in transcript-only mode, with no audio', async () => {
    metaResponse = jsonMeta({
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

describe('TeamsMeetingScreen — waiting copy before vs after the scheduled end', () => {
  it('waits for the meeting while its end is still ahead', async () => {
    respondWith(statusBody({
      armed: true,
      scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));
    renderScreen();

    expect(await screen.findByText(/Venter på mødet/)).toBeInTheDocument();
    expect(screen.queryByText(/Spørger Teams/)).not.toBeInTheDocument();
  });

  it('waits for Microsoft once the meeting has ended', async () => {
    // "Venter på mødet…" after the meeting finished read as though it had never
    // started, which is what the transcript wait actually looks like from here.
    respondWith(statusBody({
      armed: true,
      scheduledEnd: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    renderScreen();

    expect(await screen.findByText(/Spørger Teams/)).toBeInTheDocument();
    expect(screen.getByText(/Mødet er slut/)).toBeInTheDocument();
    expect(screen.queryByText(/Venter på mødet/)).not.toBeInTheDocument();
  });
});

describe('TeamsMeetingScreen — pressing the button is never silent', () => {
  it('answers a hand-pressed check that found nothing', async () => {
    // The button used only to grey itself out, so a check that found nothing
    // looked identical to a button that did not work.
    respondWith(statusBody({
      armed: true,
      scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));
    renderScreen();

    const button = await screen.findByRole('button', { name: /Mødet er slut – hent nu/ });
    fireEvent.click(button);

    expect(await screen.findByTestId('last-check')).toHaveTextContent(
      /Teams har ikke frigivet transskriptionen endnu/,
    );
  });
});

describe('TeamsMeetingScreen — ending a meeting before its booked end', () => {
  it('offers to fetch now, and says why, while the booked end is still ahead', async () => {
    respondWith(statusBody({
      armed: true,
      scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));
    renderScreen();

    expect(await screen.findByRole('button', { name: /Mødet er slut – hent nu/ })).toBeInTheDocument();
    expect(screen.getByText(/Sluttede I før tid/)).toBeInTheDocument();
  });

  it('goes back to plain "Tjek nu" once the booked end has passed', async () => {
    respondWith(statusBody({
      armed: true,
      scheduledEnd: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Tjek nu' })).toBeInTheDocument();
    expect(screen.queryByText(/Sluttede I før tid/)).not.toBeInTheDocument();
  });
});

describe('TeamsMeetingScreen — a meeting Graph gives no window for', () => {
  // `armed_in_progress` means only that: the meeting has no scheduled window, so
  // we cannot see whether it has begun. The link to an instant meeting is often
  // pasted here BEFORE anyone joins, and the screen used to tell that user their
  // meeting was "allerede i gang" and demand they start what we had just armed.
  it('leads with the fact that Memoctopus is on', async () => {
    respondWith(statusBody({ armed: true, armResult: 'armed_in_progress' }));
    renderScreen();

    expect(await screen.findByText(/Memoctopus er slået til for mødet/)).toBeInTheDocument();
    expect(screen.queryByText(/Mødet er allerede i gang/)).not.toBeInTheDocument();
  });

  // Still says it, because we genuinely cannot tell — but as a condition, not a fact.
  it('offers the manual start only for the case where the meeting had already begun', async () => {
    respondWith(statusBody({ armed: true, armResult: 'armed_in_progress' }));
    renderScreen();

    expect(await screen.findByText(/vi kan ikke se i Teams, om I allerede er gået/)).toBeInTheDocument();
    expect(
      screen.getByText(/Flere handlinger → Optag og transskriber → Start transskription/),
    ).toBeInTheDocument();
  });

  it('does not put an action in the badge for something already switched on', async () => {
    respondWith(statusBody({ armed: true, armResult: 'armed_in_progress' }));
    renderScreen();

    expect(await screen.findByTestId('armed-badge')).toHaveTextContent('Memoctopus er slået til');
  });

  it('says how to collect the referat when the meeting ends', async () => {
    respondWith(statusBody({ armed: true, armResult: 'armed_in_progress' }));
    renderScreen();

    expect(await screen.findByText(/når I er færdige/)).toBeInTheDocument();
  });

  it('does not show the invitee copy — the user is the organizer', async () => {
    respondWith(statusBody({ armed: true, armResult: 'armed_in_progress' }));
    renderScreen();

    expect(await screen.findByText(/Memoctopus er slået til for mødet/)).toBeInTheDocument();
    expect(screen.queryByText(/ikke organisator/)).not.toBeInTheDocument();
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

describe('TeamsMeetingScreen — integration switched off', () => {
  // TEAMS_GRAPH_ENABLED is off on the server. Nothing here can change any more,
  // and above all the user must not be told to sign in again for scopes that
  // were never requested.
  const NOTICE = /Teams-integrationen er ikke slået til/;

  it.each(['awaiting_teams', 'fetching', 'needs_reauth', 'failed'] as const)(
    'shows a neutral notice instead of the %s state',
    async (state) => {
      respondWith(statusBody({ state, enabled: false }));
      renderScreen();
      expect(await screen.findByText(NOTICE)).toBeInTheDocument();
      expect(screen.queryByText('Log ind med Microsoft igen')).toBeNull();
      expect(screen.queryByText(/Venter på mødet/)).toBeNull();
      expect(screen.queryByText('Der kom intet referat ud af mødet')).toBeNull();
      expect(screen.queryByTestId('armed-badge')).toBeNull();
    },
  );

  it('offers no "Tjek nu" button, but still lets the user drop the meeting', async () => {
    respondWith(statusBody({ enabled: false }));
    renderScreen();
    await screen.findByText(NOTICE);
    expect(screen.queryByText('Tjek nu')).toBeNull();
    expect(screen.getByText('Slå Memoctopus fra')).toBeInTheDocument();
  });

  it('stops polling', async () => {
    vi.useFakeTimers();
    respondWith(statusBody({ enabled: false }));
    renderScreen();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    mockFetch.mockClear();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still opens the review for a meeting that was already collected', async () => {
    respondWith(statusBody({ state: 'ready', enabled: false }));
    renderScreen();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`));
    expect(screen.queryByText(NOTICE)).toBeNull();
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

  it('"Slå Memoctopus fra" deletes through the shared helper, then returns to the dashboard', async () => {
    renderScreen();
    const btn = await screen.findByText('Slå Memoctopus fra');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockDeleteMeeting).toHaveBeenCalledWith(MEETING_ID);
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('stays on the screen with an error when the meeting could not be unregistered', async () => {
    mockDeleteMeeting.mockRejectedValueOnce(new Error('offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderScreen();
    const btn = await screen.findByText('Slå Memoctopus fra');
    await act(async () => { fireEvent.click(btn); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Kunne ikke slå Memoctopus fra');
    expect(mockPush).not.toHaveBeenCalled();
    spy.mockRestore();
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


describe('TeamsMeetingScreen — the hand-off of the collected transcript', () => {
  const failing = (status: number) => ({ ok: false, status, headers: new Headers(), json: async () => ({}) });
  const calls = (pred: (url: string, init?: RequestInit) => boolean) =>
    mockFetch.mock.calls.filter(([u, i]) => pred(String(u), i as RequestInit | undefined));

  // Used to be swallowed: a 401 or a 500 was read as "no names" and the screen
  // carried on to a review with an empty participant list.
  it.each([401, 500])('shows an error for a %s from pending-meta instead of carrying on', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    metaResponse = failing(status);
    respondWith(statusBody({ state: 'ready' }));

    renderScreen();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Kunne ikke hente transskriptionen fra serveren/);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockUpdateMeeting).not.toHaveBeenCalled();
  });

  it('lets the user try again after such an error, and then continues to the review', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    metaResponse = failing(500);
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await screen.findByRole('alert');

    metaResponse = jsonMeta({ status: 'no-recording', participants: ['Mette Hansen'], durationSeconds: 60 });
    await act(async () => { fireEvent.click(screen.getByText('Tjek nu')); });

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still keeps asking on a 404 from pending-meta (the run has not finished)', async () => {
    vi.useFakeTimers();
    metaResponse = failing(404);
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(calls((u) => u.endsWith('/pending-meta')).length).toBeGreaterThan(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('leaves the server copy alone: acknowledging it is the job of whoever saves it', async () => {
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(calls((_u, init) => init?.method === 'DELETE')).toHaveLength(0);
  });

  describe('when the ready meeting has lost its transcript on the server', () => {
    beforeEach(() => {
      transcriptResponse = jsonMeta({ status: 'none' });
      respondWith(statusBody({ state: 'ready' }));
    });

    it('offers "Hent igen" instead of opening an empty review', async () => {
      renderScreen();

      expect(await screen.findByText('Hent igen')).toBeInTheDocument();
      expect(screen.getByText(/ikke længere på serveren/)).toBeInTheDocument();
      expect(screen.queryByText(/Åbner gennemgangen/)).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockUpdateMeeting).not.toHaveBeenCalled();
    });

    it('asks the server to re-collect, then forces a poll and continues from there', async () => {
      renderScreen();
      const btn = await screen.findByText('Hent igen');
      mockFetch.mockClear();

      await act(async () => { fireEvent.click(btn); });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'recollect' }),
        });
        expect(mockFetch).toHaveBeenCalledWith(`/api/teams/meetings/${MEETING_ID}?poll=1`);
      });
      const order = mockFetch.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`);
      expect(order.indexOf(`POST /api/teams/meetings/${MEETING_ID}`))
        .toBeLessThan(order.indexOf(`GET /api/teams/meetings/${MEETING_ID}?poll=1`));
    });

    it('goes on to the review once the transcript is back', async () => {
      renderScreen();
      const btn = await screen.findByText('Hent igen');
      transcriptResponse = null; // the re-run has stashed it again
      await act(async () => { fireEvent.click(btn); });
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`));
    });

    it('shows an error and stays put when the server refuses (the window has closed)', async () => {
      renderScreen();
      const btn = await screen.findByText('Hent igen');
      recollectResponse = { ok: false, status: 409, headers: new Headers(), json: async () => ({ error: 'window_closed' }) };

      await act(async () => { fireEvent.click(btn); });

      expect(await screen.findByRole('alert')).toHaveTextContent(/kan ikke længere hentes/);
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  it('does not offer "Hent igen" while the server copy is there', async () => {
    respondWith(statusBody({ state: 'ready' }));
    renderScreen();
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(screen.queryByText('Hent igen')).toBeNull();
  });
});
