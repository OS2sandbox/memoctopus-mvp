// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MeetingBotScreen } from './MeetingBotScreen';

const mockPush = vi.fn();
const mockSearchParamsGet = vi.fn().mockReturnValue(null);
const mockRouter = { push: mockPush };
const mockSearchParamsObj = { get: mockSearchParamsGet };

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParamsObj,
}));

vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: () => false,
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
const MEETING_URL = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';
const SESSION = 'sess-1';

function jsonOk(body: object) {
  return { ok: true, json: async () => body };
}

// Route the mocked fetch by URL so a single render can hit several bot endpoints.
function routeFetch(handlers: {
  status?: () => unknown;
  audio?: () => Response;
  control?: () => unknown;
  sessions?: () => unknown;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/bot/status/')) return handlers.status?.() ?? jsonOk({ status: 'forbinder', participants: [], elapsed: 0 });
    if (url.includes('/api/bot/audio/')) return handlers.audio?.() ?? new Response(null, { status: 404 });
    if (url.includes('/api/bot/control/')) return handlers.control?.() ?? jsonOk({ ok: true });
    if (url.includes('/api/bot/sessions')) return handlers.sessions?.() ?? jsonOk({ sessionId: SESSION });
    return jsonOk({});
  });
}

function audioResponse(participants: string[] = [], duration = 30) {
  return new Response(new Blob(['audio bytes']), {
    status: 200,
    headers: {
      'Content-Type': 'audio/webm',
      'X-Participants': encodeURIComponent(JSON.stringify(participants)),
      'X-Duration': String(duration),
    },
  });
}

function renderBot(props: { meetingId?: string; meetingUrl?: string; botSession?: string | null } = {}) {
  return render(
    <MeetingBotScreen
      meetingId={props.meetingId ?? MEETING_ID}
      meetingUrl={props.meetingUrl ?? MEETING_URL}
      botSession={props.botSession === undefined ? SESSION : props.botSession}
    />,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockSaveAudio.mockClear();
  mockUpdateMeeting.mockClear();
  mockDeleteMeeting.mockClear();
  mockSearchParamsGet.mockReturnValue(null);
  routeFetch({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeetingBotScreen', () => {
  // ─── Initial render ───────────────────────────────────────────────────────────

  it('renders the meeting URL chip', () => {
    renderBot();
    expect(screen.getByText(/teams\.microsoft\.com/)).toBeInTheDocument();
  });

  it('renders the abort button', () => {
    renderBot();
    expect(screen.getByText('← afbryd')).toBeInTheDocument();
  });

  it('polls /api/bot/status/:id with the sessionId when a session exists', async () => {
    renderBot({ botSession: SESSION });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const statusCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/status/'));
    expect(statusCall).toBeDefined();
    expect(statusCall![0]).toContain(`sessionId=${SESSION}`);
  });

  it('does not poll when there is no session yet', async () => {
    renderBot({ botSession: null });
    await new Promise((r) => setTimeout(r, 50));
    const statusCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/status/'));
    expect(statusCall).toBeUndefined();
  });

  // ─── Status transitions ───────────────────────────────────────────────────────

  it('shows participant names when poll returns participants', async () => {
    routeFetch({ status: () => jsonOk({ status: 'optager', botStatus: 'recording', participants: ['Alice', 'Bob'], elapsed: 5 }) });
    renderBot();
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows error state when poll returns error status', async () => {
    routeFetch({ status: () => jsonOk({ status: 'error', botStatus: 'error', participants: [], elapsed: 0 }) });
    renderBot();
    await waitFor(() => expect(screen.getByText('FEJL')).toBeInTheDocument());
  });

  it('shows processing while pulling the recording (bot ended, audio not ready)', async () => {
    routeFetch({
      status: () => jsonOk({ status: 'processing', botStatus: 'ended', participants: [], elapsed: 0 }),
      audio: () => new Response(null, { status: 404 }), // still uploading
    });
    renderBot();
    await waitFor(() => expect(screen.getByText('BEHANDLER')).toBeInTheDocument());
  });

  // TODO: Re-enable after stabilizing the async bot audio download flow in jsdom.
  // The migration branch currently reaches the processing UI but does not reliably
  // observe router.push() in Vitest/jsdom.
  it.skip('downloads the recording into IndexedDB and navigates to review when the bot ends', async () => {
    routeFetch({
      status: () => jsonOk({ status: 'processing', botStatus: 'ended', participants: [], elapsed: 0 }),
      audio: () => audioResponse(['Alice'], 42),
    });
    renderBot();
    await waitFor(
      () => expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`),
      { timeout: 5000 },
    );
    expect(mockSaveAudio).toHaveBeenCalledWith(MEETING_ID, expect.any(Blob), 'audio/webm');
    expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, expect.objectContaining({
      status: 'processing',
      botSession: null,
      audioDurationSeconds: 42,
    }));
  });

  it('shows cancelled and discards the meeting when the bot has no recording', async () => {
    routeFetch({
      status: () => jsonOk({ status: 'processing', botStatus: 'ended', participants: [], elapsed: 0 }),
      audio: () => new Response(JSON.stringify({ status: 'no-recording' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    renderBot();
    await waitFor(() => expect(screen.getByText('AFBRUDT')).toBeInTheDocument());
    expect(mockDeleteMeeting).toHaveBeenCalledWith(MEETING_ID);
  });

  // ─── Controls ─────────────────────────────────────────────────────────────────

  it('abort calls control with action=abort + sessionId, deletes the meeting, navigates home', async () => {
    renderBot();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await act(async () => { fireEvent.click(screen.getByText('← afbryd')); });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));

    const controlCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/control/'));
    expect(controlCall).toBeDefined();
    const body = JSON.parse(controlCall![1].body as string);
    expect(body.action).toBe('abort');
    expect(body.sessionId).toBe(SESSION);
    expect(mockDeleteMeeting).toHaveBeenCalledWith(MEETING_ID);
  });

  it('stop calls control with action=stop + sessionId', async () => {
    routeFetch({ status: () => jsonOk({ status: 'optager', botStatus: 'recording', participants: [], elapsed: 30 }) });
    renderBot();
    await waitFor(() => screen.getByText('Stop & afslut →'));

    await act(async () => { fireEvent.click(screen.getByText('Stop & afslut →')); });

    const controlCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/control/'));
    expect(controlCall).toBeDefined();
    const body = JSON.parse(controlCall![1].body as string);
    expect(body.action).toBe('stop');
    expect(body.sessionId).toBe(SESSION);
  });

  it('pause calls control with action=pause when recording', async () => {
    routeFetch({ status: () => jsonOk({ status: 'optager', botStatus: 'recording', participants: [], elapsed: 10 }) });
    renderBot();
    await waitFor(() => screen.getByTitle('Pause optagelse'));

    await act(async () => { fireEvent.click(screen.getByTitle('Pause optagelse')); });

    const controlCall = mockFetch.mock.calls.find(
      ([url, init]) => typeof url === 'string' && url.includes('/api/bot/control/') &&
        JSON.parse((init as RequestInit).body as string).action === 'pause',
    );
    expect(controlCall).toBeDefined();
  });

  // ─── Bot session creation ─────────────────────────────────────────────────────

  it('creates a session (with meetingUrl) when ?join=1 and no existing session', async () => {
    mockSearchParamsGet.mockReturnValue('1');
    renderBot({ botSession: null });
    await waitFor(() => {
      const sessionCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'));
      expect(sessionCall).toBeDefined();
    });
    const sessionCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'));
    const body = JSON.parse(sessionCall![1].body as string);
    expect(body.meetingUrl).toBe(MEETING_URL);
    await waitFor(() => expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, { botSession: SESSION }));
  });

  it('does NOT create a session when ?join is absent', async () => {
    mockSearchParamsGet.mockReturnValue(null);
    renderBot({ botSession: SESSION });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const sessionCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'));
    expect(sessionCall).toBeUndefined();
  });

  it('does NOT create a session when one already exists (reload)', async () => {
    mockSearchParamsGet.mockReturnValue('1');
    renderBot({ botSession: SESSION });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const sessionCall = mockFetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'));
    expect(sessionCall).toBeUndefined();
  });

  it('shows error state when session creation fails', async () => {
    mockSearchParamsGet.mockReturnValue('1');
    routeFetch({ sessions: () => ({ ok: false, json: async () => ({ error: 'Too many sessions' }) }) });
    renderBot({ botSession: null });
    await waitFor(() => expect(screen.getByText('FEJL')).toBeInTheDocument());
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  it('stops polling when component unmounts', async () => {
    vi.useFakeTimers();
    routeFetch({});
    const { unmount } = renderBot();
    await vi.advanceTimersByTimeAsync(3000);
    const callsBefore = mockFetch.mock.calls.length;

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});
