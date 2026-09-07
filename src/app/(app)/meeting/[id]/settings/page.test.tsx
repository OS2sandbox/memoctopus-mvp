// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── next/navigation ──────────────────────────────────────────────────────────
const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useParams: () => ({ id: 'meeting-abc' }),
}));

// ─── @/lib/storage ────────────────────────────────────────────────────────────
const mockGetMeeting = vi.fn();
const mockUpdateMeeting = vi.fn();
const mockDeleteMeeting = vi.fn();
const mockDeleteAudio = vi.fn();
const mockGetTranscript = vi.fn();
const mockSaveTranscript = vi.fn();

vi.mock('@/lib/storage', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
  deleteMeeting: (...args: unknown[]) => mockDeleteMeeting(...args),
  deleteAudio: (...args: unknown[]) => mockDeleteAudio(...args),
  getTranscript: (...args: unknown[]) => mockGetTranscript(...args),
  saveTranscript: (...args: unknown[]) => mockSaveTranscript(...args),
}));

// ─── Heavy child components ────────────────────────────────────────────────────
vi.mock('@/components/layout/ProcessStrip', () => ({
  ProcessStrip: () => <div data-testid="process-strip" />,
}));

vi.mock('@/components/compliance/RedactDialog', () => ({
  RedactDialog: ({ open, meetingTitle }: { open: boolean; meetingTitle: string }) =>
    open ? <div data-testid="redact-dialog">title={meetingTitle}</div> : null,
}));

import MeetingSettingsPage from './page';

describe('MeetingSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterPush.mockReset();
  });

  // ── getMeeting error ─────────────────────────────────────────────────────────

  it('logs but does not throw when getMeeting rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetMeeting.mockRejectedValue(new Error('IndexedDB quota exceeded'));

    render(<MeetingSettingsPage />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[settings]'),
        expect.any(Error),
      );
    });
    consoleSpy.mockRestore();
  });

  it('disables the "Slet følsomt indhold" button when title has not loaded', async () => {
    // Never resolves → titleLoaded stays false
    mockGetMeeting.mockReturnValue(new Promise(() => {}));

    render(<MeetingSettingsPage />);

    // Button should be disabled while title hasn't loaded
    const redactBtn = screen.getByRole('button', { name: 'Slet følsomt indhold' });
    expect(redactBtn).toBeDisabled();
  });

  it('enables the "Slet følsomt indhold" button once title has loaded', async () => {
    mockGetMeeting.mockResolvedValue({ id: 'meeting-abc', title: 'Møde #1' });

    render(<MeetingSettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Slet følsomt indhold' })).not.toBeDisabled();
    });
  });

  // ── commitRename error ───────────────────────────────────────────────────────

  it('shows an error banner when rename fails', async () => {
    mockGetMeeting.mockResolvedValue({ id: 'meeting-abc', title: 'Gammelt navn' });
    mockUpdateMeeting.mockRejectedValue(new Error('storage error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<MeetingSettingsPage />);

    // Wait for title to load
    await waitFor(() => expect(screen.getByRole('button', { name: 'Omdøb' })).toBeInTheDocument());

    // Enter rename mode
    await userEvent.click(screen.getByRole('button', { name: 'Omdøb' }));
    const input = screen.getByRole('textbox');

    // Clear and type a new name
    await userEvent.clear(input);
    await userEvent.type(input, 'Nyt navn');

    // Submit via Enter
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Kunne ikke gemme det nye navn');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[settings]'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  // ── handleDelete error ───────────────────────────────────────────────────────

  it('shows an error banner when delete fails and keeps dialog open', async () => {
    mockGetMeeting.mockResolvedValue({ id: 'meeting-abc', title: 'Møde' });
    mockDeleteMeeting.mockRejectedValue(new Error('disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<MeetingSettingsPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Slet mødet' })).toBeInTheDocument());

    // Open delete dialog
    await userEvent.click(screen.getByRole('button', { name: 'Slet mødet' }));

    // Confirm deletion
    const confirmBtn = screen.getByRole('button', { name: 'Slet møde' });
    await userEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Kunne ikke slette mødet');
    // Dialog should still be open (confirm button still visible)
    expect(screen.getByRole('button', { name: 'Slet møde' })).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[settings]'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('navigates to /arkiv when delete succeeds', async () => {
    mockGetMeeting.mockResolvedValue({ id: 'meeting-abc', title: 'Møde' });
    mockDeleteMeeting.mockResolvedValue(undefined);

    render(<MeetingSettingsPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Slet mødet' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Slet mødet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Slet møde' }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/arkiv');
    });
  });
});
