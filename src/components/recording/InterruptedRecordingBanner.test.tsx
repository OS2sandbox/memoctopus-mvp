// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const mockListRecordingIds = vi.fn();
const mockGetMeeting = vi.fn();
vi.mock('@/lib/storage', () => ({
  listMeetingIdsWithRecordingState: (...args: unknown[]) => mockListRecordingIds(...args),
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
}));

import { InterruptedRecordingBanner } from './InterruptedRecordingBanner';

const meetings: Record<string, { id: string; title: string; status: string }> = {
  r1: { id: 'r1', title: 'Budgetmøde', status: 'recording' },
  r2: { id: 'r2', title: 'Styregruppe', status: 'recording' },
  // Stopped and waiting for its last batches to be transcribed: not interrupted.
  p1: { id: 'p1', title: 'Teammøde', status: 'processing' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMeeting.mockImplementation(async (id: string) => meetings[id] ?? null);
});

describe('InterruptedRecordingBanner', () => {
  it('lists each interrupted recording with a link to continue it', async () => {
    mockListRecordingIds.mockResolvedValue(['r1', 'r2']);

    render(<InterruptedRecordingBanner />);

    expect(await screen.findByRole('link', { name: 'Fortsæt optagelsen af Budgetmøde' })).toHaveAttribute('href', '/meeting/r1');
    expect(screen.getByRole('link', { name: 'Fortsæt optagelsen af Styregruppe' })).toHaveAttribute('href', '/meeting/r2');
  });

  it.each([
    ['a stopped recording waiting for transcription', ['p1']],
    ['a ledger whose meeting is gone', ['gone']],
    ['no ledger at all', []],
  ])('shows nothing for %s', async (_case, ids) => {
    mockListRecordingIds.mockResolvedValue(ids);

    const { container } = render(<InterruptedRecordingBanner />);

    await waitFor(() => expect(mockListRecordingIds).toHaveBeenCalled());
    await waitFor(() => expect(mockGetMeeting).toHaveBeenCalledTimes(ids.length));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});
