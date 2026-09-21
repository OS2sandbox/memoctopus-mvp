// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingProvider } from '@/lib/onboarding/context';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/skabeloner/SkabelonerList', () => ({ SkabelonerList: () => null }));

const mockGetAllMeetings = vi.fn();
vi.mock('@/lib/storage', () => ({
  getAllMeetings: (...args: unknown[]) => mockGetAllMeetings(...args),
}));

// Bulk delete goes through the shared helper; @/lib/storage has no deleteMeeting
// here, so a page that called it directly would fail.
const mockDelete = vi.fn();
vi.mock('@/lib/teams/client-delete', () => ({
  deleteMeetingAndUnregister: (...args: unknown[]) => mockDelete(...args),
}));

import ArkivPage from './page';

// The page mounts under the app-level OnboardingProvider. Mark its hint as seen so the
// popover doesn't cover the "Rediger arkiv" button the tests click.
function render(ui: React.ReactElement) {
  return rtlRender(
    <OnboardingProvider
      initial={{
        tourSkipped: true,
        tourCompleted: true,
        seen: [{ stepId: 'arkiv.bulk-edit-button', meetingId: null }],
      }}
    >
      {ui}
    </OnboardingProvider>,
  );
}

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
