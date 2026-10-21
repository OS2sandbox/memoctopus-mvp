// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LegacyBotMeetingScreen } from './LegacyBotMeetingScreen';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/lib/storage', () => ({
  deleteMeeting: vi.fn().mockResolvedValue(undefined),
}));

import { deleteMeeting } from '@/lib/storage';
const mockDeleteMeeting = vi.mocked(deleteMeeting);

const MEETING_ID = 'legacy-1';

function renderScreen(hasTranscript = false) {
  const onOpenReview = vi.fn();
  render(
    <LegacyBotMeetingScreen
      meetingId={MEETING_ID}
      hasTranscript={hasTranscript}
      onOpenReview={onOpenReview}
    />,
  );
  return { onOpenReview };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteMeeting.mockResolvedValue(undefined);
});

describe('LegacyBotMeetingScreen', () => {
  it('explains that the meeting cannot be resumed', () => {
    renderScreen();
    expect(screen.getByText(/startet med den gamle Teams-robot/)).toBeInTheDocument();
    expect(screen.getByText(/Mødet kan ikke genoptages/)).toBeInTheDocument();
  });

  // The point of the screen: whatever the bot produced is still in IndexedDB, so
  // the user is not told to delete data they may still want.
  it('offers the transcript when one was saved', () => {
    const { onOpenReview } = renderScreen(true);
    expect(screen.getByText(/ligger stadig under Gennemgang/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Åbn Gennemgang'));
    expect(onOpenReview).toHaveBeenCalledOnce();
  });

  it('says so when no transcript was saved, and offers no review button', () => {
    renderScreen(false);
    expect(screen.getByText(/blev ikke gemt nogen transskription/)).toBeInTheDocument();
    expect(screen.queryByText('Åbn Gennemgang')).not.toBeInTheDocument();
  });

  it('deletes the meeting and returns to the dashboard', async () => {
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByText('Slet mødet'));
    });

    expect(mockDeleteMeeting).toHaveBeenCalledWith(MEETING_ID);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
  });

  // A failed delete must not leave the button stuck in its pending state, or the
  // record becomes unremovable without a reload.
  it('re-enables the delete button when the delete fails', async () => {
    mockDeleteMeeting.mockRejectedValue(new Error('idb gone'));
    renderScreen();

    await act(async () => {
      fireEvent.click(screen.getByText('Slet mødet'));
    });

    expect(mockPush).not.toHaveBeenCalled();
    await waitFor(() => {
      const btn = screen.getByText('Slet mødet') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  it('points the user at the mødelink box for new meetings', () => {
    renderScreen();
    expect(screen.getByText(/indsætte mødelinket på forsiden/)).toBeInTheDocument();
  });
});
