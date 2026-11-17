// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithOnboarding } from '@/test/onboarding';

// "Rediger arkiv" is wrapped in an OnboardingHint, whose useOnboarding() throws
// outside a provider — the real page mounts under the app-level one. Marking the
// tour finished keeps the popover closed so queries hit the button itself.
const render = (ui: React.ReactElement) =>
  renderWithOnboarding(ui, { tourSkipped: true, tourCompleted: true, seen: [] });

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/skabeloner/SkabelonerList', () => ({ SkabelonerList: () => null }));

const mockGetAllMeetings = vi.fn();
const mockGetMeeting = vi.fn();
const mockCreateMeeting = vi.fn();
vi.mock('@/lib/storage', () => ({
  getAllMeetings: (...args: unknown[]) => mockGetAllMeetings(...args),
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  createMeeting: (...args: unknown[]) => mockCreateMeeting(...args),
}));

// Bulk delete goes through the shared helper; @/lib/storage has no deleteMeeting
// here, so a page that called it directly would fail.
const mockDelete = vi.fn();
vi.mock('@/lib/teams/client-delete', () => ({
  deleteMeetingAndUnregister: (...args: unknown[]) => mockDelete(...args),
}));

import ArkivPage from './page';

function stored(id: string, title: string) {
  return {
    id,
    title,
    participants: [],
    status: 'done',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
    audioDurationSeconds: 60,
    audioSizeBytes: 10,
  };
}

async function selectAllAndDelete() {
  fireEvent.click(await screen.findByText('Rediger arkiv'));
  fireEvent.click(screen.getByText('Vælg alle'));
  fireEvent.click(screen.getByText(/Slet valgte/));
  fireEvent.click(await screen.findByRole('button', { name: /^Slet 2 møder$/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllMeetings.mockResolvedValue([stored('a', 'Teams-møde A'), stored('b', 'Lokalt møde B')]);
  mockDelete.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ArkivPage — bulk delete', () => {
  it('deletes every selected meeting through the shared helper', async () => {
    render(<ArkivPage />);
    await selectAllAndDelete();

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(2));
    expect(mockDelete).toHaveBeenCalledWith('a');
    expect(mockDelete).toHaveBeenCalledWith('b');
    await waitFor(() => expect(screen.queryByText('Teams-møde A')).toBeNull());
  });

  it('names the meetings that failed, keeps them in the list and selected', async () => {
    mockDelete.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('offline');
    });
    render(<ArkivPage />);
    await selectAllAndDelete();

    const message = await screen.findByText(/Kunne ikke slette 1 møde/);
    expect(message).toHaveTextContent('Teams-møde A');
    expect(message).not.toHaveTextContent('Lokalt møde B');
    expect(screen.getByText('Teams-møde A')).toBeInTheDocument();
    expect(screen.queryByText('Lokalt møde B')).toBeNull();
    // Still selected, so "Slet valgte" can retry exactly the failed ones.
    expect(screen.getByText('Slet valgte (1)')).toBeInTheDocument();
  });
});

describe('ArkivPage — Teams status', () => {
  function awaiting(id: string, title: string) {
    return { ...stored(id, title), status: 'awaiting_teams' };
  }

  it('shows "Intet referat" for a Teams meeting the server has given up on', async () => {
    mockGetAllMeetings.mockResolvedValue([awaiting('a', 'Teams-møde A'), awaiting('b', 'Teams-møde B')]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        meetings: [{ id: 'a', state: 'failed' }, { id: 'b', state: 'awaiting_teams' }],
      })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ArkivPage />);

    expect(await screen.findByText('Intet referat')).toBeInTheDocument();
    expect(screen.getByText('Afventer Teams')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/teams/meetings');
    vi.unstubAllGlobals();
  });

  it('keeps the local status when the server cannot be asked', async () => {
    mockGetAllMeetings.mockResolvedValue([awaiting('a', 'Teams-møde A')]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<ArkivPage />);

    expect(await screen.findByText('Afventer Teams')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('says "Åbn for at hente" for an Outlook meeting that is over but never opened', async () => {
    mockGetAllMeetings.mockResolvedValue([awaiting('ol-1', 'Styregruppe')]);
    mockGetMeeting.mockResolvedValue({ id: 'ol-1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        meetings: [{
          id: 'ol-1', state: 'awaiting_teams', origin: 'outlook', deferred: true,
          subject: 'Styregruppe', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
          scheduledStart: '2026-01-01T09:00:00.000Z', createdAt: '2025-12-31T09:00:00.000Z',
        }],
      })),
    ));

    render(<ArkivPage />);

    expect(await screen.findByText('Åbn for at hente')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('imports an Outlook meeting this browser has not seen, under the server id', async () => {
    mockGetMeeting.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        meetings: [
          {
            id: 'ol-2', state: 'awaiting_teams', origin: 'outlook', deferred: true,
            subject: 'Budgetmøde', joinUrl: 'https://teams.microsoft.com/l/meetup-join/y',
            scheduledStart: '2026-11-03T09:00:00.000Z', createdAt: '2026-10-26T09:00:00.000Z',
          },
          // Collected in another browser: nothing left to show here.
          { id: 'ol-3', state: 'ready', origin: 'outlook', joinUrl: 'https://teams.microsoft.com/l/meetup-join/z' },
          // A dashboard meeting lives in its own browser already.
          { id: 'd-1', state: 'awaiting_teams' },
        ],
      })),
    ));

    render(<ArkivPage />);

    await waitFor(() => expect(mockCreateMeeting).toHaveBeenCalledTimes(1));
    expect(mockCreateMeeting).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ol-2',
      title: 'Budgetmøde',
      source: 'teams',
      graphManaged: true,
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/y',
      status: 'awaiting_teams',
    }));
    // Listed after the import, so the new meeting is on the page.
    await waitFor(() => expect(mockGetAllMeetings).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
