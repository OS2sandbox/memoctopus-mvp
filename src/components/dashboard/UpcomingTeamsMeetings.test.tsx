// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UpcomingTeamsMeetings, ORGANIZER_REQUEST, armErrorMessage } from './UpcomingTeamsMeetings';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const mockCreateMeeting = vi.fn();
const mockUpdateMeeting = vi.fn();
const mockDeleteMeeting = vi.fn();

vi.mock('@/lib/storage', () => ({
  createMeeting: (...a: unknown[]) => mockCreateMeeting(...a),
  updateMeeting: (...a: unknown[]) => mockUpdateMeeting(...a),
  deleteMeeting: (...a: unknown[]) => mockDeleteMeeting(...a),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function calendarMeeting(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'ev-1',
    subject: 'Statusmøde',
    start: '2026-09-10T09:00:00.000Z',
    end: '2026-09-10T10:00:00.000Z',
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/19:abc@thread.v2/0',
    isOrganizer: true,
    isRecurring: false,
    armedMeetingId: null,
    ...overrides,
  };
}

/** Route the mocked fetch: calendar GET first, then the arm POST. */
function routeFetch(opts: {
  calendar?: () => unknown;
  arm?: () => unknown;
} = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/teams/calendar')) {
      return opts.calendar?.() ?? { ok: true, status: 200, json: async () => ({ meetings: [calendarMeeting()] }) };
    }
    return opts.arm?.() ?? {
      ok: true, status: 200,
      json: async () => ({ armed: true, armResult: 'armed', isOrganizer: true }),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateMeeting.mockResolvedValue({ id: 'local-1' });
  mockUpdateMeeting.mockResolvedValue(undefined);
  mockDeleteMeeting.mockResolvedValue(undefined);
  routeFetch();
});

describe('UpcomingTeamsMeetings — listing', () => {
  it('fetches the next 7 days of meetings', async () => {
    render(<UpcomingTeamsMeetings />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/teams/calendar?days=7'));
  });

  it('lists subject and time', async () => {
    render(<UpcomingTeamsMeetings />);
    expect(await screen.findByText('Statusmøde')).toBeInTheDocument();
    const expected = new Intl.DateTimeFormat('da', { hour: '2-digit', minute: '2-digit' })
      .format(new Date('2026-09-10T09:00:00.000Z'));
    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no meetings', async () => {
    routeFetch({ calendar: () => ({ ok: true, status: 200, json: async () => ({ meetings: [] }) }) });
    render(<UpcomingTeamsMeetings />);
    expect(await screen.findByText('Ingen Teams-møder i de næste 7 dage.')).toBeInTheDocument();
  });

  it('shows a Danish error when the calendar needs re-consent', async () => {
    routeFetch({ calendar: () => ({ ok: false, status: 403, json: async () => ({ error: 'consent_required' }) }) });
    render(<UpcomingTeamsMeetings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/mangler adgang til dine Teams-møder/);
  });

  it('shows a Danish error when the calendar request throws', async () => {
    routeFetch({ calendar: () => { throw new Error('offline'); } });
    render(<UpcomingTeamsMeetings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Kunne ikke hente dine kommende Teams-møder/);
  });

  it('renders an already-armed meeting as a badge with a link to the meeting', async () => {
    routeFetch({
      calendar: () => ({
        ok: true, status: 200,
        json: async () => ({ meetings: [calendarMeeting({ armedMeetingId: 'local-9' })] }),
      }),
    });
    render(<UpcomingTeamsMeetings />);
    expect(await screen.findByTestId('armed-ev-1')).toHaveTextContent('Referat slået til');
    expect(screen.getByText('Åbn')).toHaveAttribute('href', '/meeting/local-9');
    expect(screen.queryByText('Tag referat')).toBeNull();
  });

  it('disables the toggle for a meeting without a join link', async () => {
    routeFetch({
      calendar: () => ({
        ok: true, status: 200,
        json: async () => ({ meetings: [calendarMeeting({ joinUrl: null })] }),
      }),
    });
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    expect(btn.closest('button')).toBeDisabled();
    expect(screen.getByText('Mødet har ikke noget Teams-link.')).toBeInTheDocument();
  });
});

describe('UpcomingTeamsMeetings — "Tag referat"', () => {
  it('creates the local meeting with source teams and awaiting_teams', async () => {
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Statusmøde',
          source: 'teams',
          status: 'awaiting_teams',
          meetingUrl: calendarMeeting().joinUrl,
          scheduledStart: '2026-09-10T09:00:00.000Z',
          scheduledEnd: '2026-09-10T10:00:00.000Z',
        }),
      );
    });
  });

  it('registers the meeting with the Teams API using the new local id', async () => {
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      const post = mockFetch.mock.calls.find((c) => c[0] === '/api/teams/meetings');
      expect(post).toBeTruthy();
      // The occurrence window and event id travel with the registration, so a
      // recurring series' second occurrence is not looked for in the first's window.
      expect(JSON.parse(post![1].body)).toEqual({
        meetingId: 'local-1',
        joinUrl: calendarMeeting().joinUrl,
        eventId: 'ev-1',
        scheduledStart: '2026-09-10T09:00:00.000Z',
        scheduledEnd: '2026-09-10T10:00:00.000Z',
      });
    });
  });

  it('shows the armed badge and stores the arm result locally', async () => {
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByTestId('armed-ev-1')).toBeInTheDocument();
    expect(mockUpdateMeeting).toHaveBeenCalledWith('local-1', { teamsArmed: true, teamsIsOrganizer: true });
  });

  it('shows "Hele serien optages" for an armed recurring meeting', async () => {
    routeFetch({
      calendar: () => ({
        ok: true, status: 200,
        json: async () => ({ meetings: [calendarMeeting({ isRecurring: true })] }),
      }),
    });
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText('Hele serien optages.')).toBeInTheDocument();
  });

  it('does not show "Hele serien optages" for a single meeting', async () => {
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    await screen.findByTestId('armed-ev-1');
    expect(screen.queryByText('Hele serien optages.')).toBeNull();
  });

  it('shows the copy-paste sentence when the user is not the organizer', async () => {
    routeFetch({
      arm: () => ({ ok: true, status: 200, json: async () => ({ armed: false, armResult: 'not_organizer', isOrganizer: false }) }),
    });
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(ORGANIZER_REQUEST)).toBeInTheDocument();
  });

  it('shows the admin-guide hint when tenant policy blocks recording', async () => {
    routeFetch({
      arm: () => ({ ok: true, status: 200, json: async () => ({ armed: false, armResult: 'policy_blocked', isOrganizer: true }) }),
    });
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/Teams-politik blokerer automatisk optagelse/)).toBeInTheDocument();
    expect(screen.getByText('opsætningsguiden')).toHaveAttribute('href', '/docs/setup-microsoft-teams.md');
  });

  it('removes the orphan local meeting and shows an error when the API rejects the link', async () => {
    routeFetch({
      arm: () => ({ ok: false, status: 404, json: async () => ({ error: 'not_invited' }) }),
    });
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Du skal være inviteret til mødet for at kunne tage referat.');
    expect(mockDeleteMeeting).toHaveBeenCalledWith('local-1');
    expect(screen.queryByTestId('armed-ev-1')).toBeNull();
  });

  it('shows a generic Danish error when createMeeting throws', async () => {
    mockCreateMeeting.mockRejectedValue(new Error('idb dead'));
    render(<UpcomingTeamsMeetings />);
    const btn = await screen.findByText('Tag referat');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Kunne ikke slå referat til for mødet. Prøv igen.');
  });
});

describe('armErrorMessage', () => {
  it('maps every known error code to Danish copy', () => {
    expect(armErrorMessage(400, 'invalid-url')).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(400, 'wrong-host')).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(404, 'not_invited')).toMatch(/inviteret til mødet/);
    expect(armErrorMessage(403, 'reauth_required')).toMatch(/udløbet/);
    expect(armErrorMessage(403, 'transcripts_disabled')).toMatch(/IT-administrator/);
  });

  it('falls back on an unknown error and distinguishes 401', () => {
    expect(armErrorMessage(502, 'graph')).toMatch(/Prøv igen/);
    expect(armErrorMessage(401)).toMatch(/ikke logget ind/);
  });
});
