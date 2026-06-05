// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MeetingBotScreen } from './MeetingBotScreen';

const mockPush = vi.fn();
const mockSearchParamsGet = vi.fn().mockReturnValue(null);
// Stable object references prevent useCallback deps from changing on every render,
// which would otherwise cause an infinite polling restart loop in tests.
const mockRouter = { push: mockPush };
const mockSearchParamsObj = { get: mockSearchParamsGet };

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParamsObj,
}));

vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MEETING_ID = 'meet-1';
const MEETING_URL = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';

function forbinderResponse(overrides: object = {}) {
  return {
    ok: true,
    json: async () => ({ status: 'forbinder', participants: [], elapsed: 0, ...overrides }),
  };
}

function renderBot(props: { meetingId?: string; meetingUrl?: string } = {}) {
  return render(
    <MeetingBotScreen
      meetingId={props.meetingId ?? MEETING_ID}
      meetingUrl={props.meetingUrl ?? MEETING_URL}
    />,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockSearchParamsGet.mockReturnValue(null);
  // Default: every poll returns 'forbinder'
  mockFetch.mockResolvedValue(forbinderResponse());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeetingBotScreen', () => {
  // ─── Initial render ───────────────────────────────────────────────────────────

  it('shows 00:00 timer in connecting state', async () => {
    renderBot();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.getByText('00:00')).toBeInTheDocument();
  });

  it('renders the meeting URL chip', () => {
    renderBot();
    expect(screen.getByText(/teams\.microsoft\.com/)).toBeInTheDocument();
  });

  it('renders the abort button', () => {
    renderBot();
    expect(screen.getByText('← afbryd')).toBeInTheDocument();
  });

  it('starts polling /api/bot/status/:id on mount', async () => {
    renderBot();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [[url]] = mockFetch.mock.calls;
    expect(url).toContain(`/api/bot/status/${MEETING_ID}`);
  });

  // ─── Status transitions ───────────────────────────────────────────────────────

  it('navigates to review when meetingStatus becomes review', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', meetingStatus: 'review', participants: [], elapsed: 0 }),
    });
    renderBot();
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/meeting/${MEETING_ID}/review`);
    });
  });

  it('shows cancelled state when meetingStatus is cancelled', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'forbinder', meetingStatus: 'cancelled', participants: [], elapsed: 0 }),
    });
    renderBot();
    await waitFor(() => {
      expect(screen.getByText('AFBRUDT')).toBeInTheDocument();
    });
  });

  it('shows error state when poll returns error status', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error', participants: [], elapsed: 0 }),
    });
    renderBot();
    await waitFor(() => {
      expect(screen.getByText('FEJL')).toBeInTheDocument();
    });
  });

  it('shows participant names when poll returns participants', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'optager', participants: ['Alice', 'Bob'], elapsed: 5 }),
    });
    renderBot();
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows processing state when bot reports ended', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', participants: [], elapsed: 0 }),
    });
    renderBot();
    await waitFor(() => {
      expect(screen.getByText('BEHANDLER')).toBeInTheDocument();
    });
  });

  // ─── Timer behaviour ──────────────────────────────────────────────────────────

  it('starts elapsed timer when transitioning from forbinder to optager', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce(forbinderResponse()); // first poll: forbinder
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'optager', participants: [], elapsed: 10 }),
    });

    renderBot();
    // Wrap in act() so React flushes state updates from timer callbacks before we assert.
    // waitFor doesn't work with fake timers because its own 50ms retry is also fake.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    // elapsed is seeded from server value on transition; timer should now be ticking
    const timer = screen.getByText(/\d{2}:\d{2}/);
    expect(timer).not.toHaveTextContent('00:00');
  });

  // ─── Controls ─────────────────────────────────────────────────────────────────

  it('abort button calls /api/bot/control with action=abort and navigates home', async () => {
    mockFetch
      .mockResolvedValueOnce(forbinderResponse()) // poll
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // control

    renderBot();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const abortBtn = screen.getByText('← afbryd');
    await act(async () => { fireEvent.click(abortBtn); });

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));

    const controlCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/bot/control/'),
    );
    expect(controlCall).toBeDefined();
    const body = JSON.parse(controlCall![1].body as string);
    expect(body.action).toBe('abort');
  });

  it('stop button calls /api/bot/control with action=stop', async () => {
    // Start in optager (recording) so stop button is visible
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'optager', participants: [], elapsed: 30 }),
    });

    renderBot();
    await waitFor(() => screen.getByText('Stop & afslut →'));

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await act(async () => { fireEvent.click(screen.getByText('Stop & afslut →')); });

    const controlCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/bot/control/'),
    );
    expect(controlCall).toBeDefined();
    const body = JSON.parse(controlCall![1].body as string);
    expect(body.action).toBe('stop');
  });

  it('pause button calls /api/bot/control with action=pause when recording', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'optager', participants: [], elapsed: 10 }),
    });

    renderBot();
    await waitFor(() => screen.getByTitle('Pause optagelse'));

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await act(async () => { fireEvent.click(screen.getByTitle('Pause optagelse')); });

    const controlCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/api/bot/control/') &&
        JSON.parse((init as RequestInit).body as string).action === 'pause',
    );
    expect(controlCall).toBeDefined();
  });

  it('resume button calls /api/bot/control with action=resume when paused', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pause', participants: [], elapsed: 20 }),
    });

    renderBot();
    await waitFor(() => screen.getByTitle('Fortsæt optagelse'));

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await act(async () => { fireEvent.click(screen.getByTitle('Fortsæt optagelse')); });

    const controlCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/api/bot/control/') &&
        JSON.parse((init as RequestInit).body as string).action === 'resume',
    );
    expect(controlCall).toBeDefined();
  });

  // ─── Bot session creation ─────────────────────────────────────────────────────

  it('calls /api/bot/sessions when ?join=1 is present', async () => {
    mockSearchParamsGet.mockReturnValue('1');
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-1' }) }) // sessions
      .mockResolvedValue(forbinderResponse()); // polls

    renderBot();
    await waitFor(() => {
      const sessionCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'),
      );
      expect(sessionCall).toBeDefined();
    });
  });

  it('does NOT call /api/bot/sessions when ?join param is absent', async () => {
    mockSearchParamsGet.mockReturnValue(null);
    renderBot();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const sessionCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/bot/sessions'),
    );
    expect(sessionCall).toBeUndefined();
  });

  it('shows error state when session creation fails', async () => {
    mockSearchParamsGet.mockReturnValue('1');
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Too many sessions' }) }) // sessions fails
      .mockResolvedValue({ ok: false, status: 503 }); // polls return error → no status override

    renderBot();
    await waitFor(() => {
      expect(screen.getByText('FEJL')).toBeInTheDocument();
    });
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  it('stops polling when component unmounts', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(forbinderResponse());

    const { unmount } = renderBot();
    await vi.advanceTimersByTimeAsync(3000); // advance past one poll interval without infinite loop
    const callsBefore = mockFetch.mock.calls.length;

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});
