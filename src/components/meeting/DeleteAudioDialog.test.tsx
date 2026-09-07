// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAudioDialog } from './DeleteAudioDialog';

vi.mock('@/lib/storage', () => ({
  deleteAudio: vi.fn().mockResolvedValue(undefined),
  updateMeeting: vi.fn().mockResolvedValue(undefined),
}));

import { deleteAudio, updateMeeting } from '@/lib/storage';

const mockDeleteAudio = vi.mocked(deleteAudio);
const mockUpdateMeeting = vi.mocked(updateMeeting);

const MEETING_ID = 'meet-abc';

function renderDialog(overrides: Partial<React.ComponentProps<typeof DeleteAudioDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();

  render(
    <DeleteAudioDialog
      open={true}
      onOpenChange={onOpenChange}
      meetingId={MEETING_ID}
      title="Slet lydfil"
      confirmLabel="Slet"
      onDeleted={onDeleted}
      {...overrides}
    />,
  );

  return { onOpenChange, onDeleted };
}

beforeEach(() => {
  mockDeleteAudio.mockClear();
  mockUpdateMeeting.mockClear();
  mockDeleteAudio.mockResolvedValue(undefined);
  mockUpdateMeeting.mockResolvedValue(undefined);
});

describe('DeleteAudioDialog', () => {
  // ─── Rendering ──────────────────────────────────────────────────────────────

  it('renders the provided title', () => {
    renderDialog({ title: 'Min titel' });
    expect(screen.getByRole('heading', { name: 'Min titel' })).toBeInTheDocument();
  });

  it('renders the provided confirmLabel on the confirm button', () => {
    renderDialog({ confirmLabel: 'Bekræft sletning' });
    expect(screen.getByRole('button', { name: 'Bekræft sletning' })).toBeInTheDocument();
  });

  it('renders the provided description', () => {
    renderDialog({ description: 'Denne handling kan ikke fortrydes.' });
    expect(screen.getByText('Denne handling kan ikke fortrydes.')).toBeInTheDocument();
  });

  it('falls back to default description when description prop is omitted', () => {
    renderDialog();
    expect(
      screen.getByText('Lydfilen slettes, og mødet nulstilles til optagelse.'),
    ).toBeInTheDocument();
  });

  it('renders the cancel button', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Afbryd' })).toBeInTheDocument();
  });

  it('does not render the dialog when open is false', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('heading', { name: 'Slet lydfil' })).not.toBeInTheDocument();
  });

  // ─── Cancel button ──────────────────────────────────────────────────────────

  it('calls onOpenChange(false) when the cancel button is clicked', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Afbryd' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDeleteAudio).not.toHaveBeenCalled();
    expect(mockUpdateMeeting).not.toHaveBeenCalled();
  });

  // ─── Confirm button happy-path ───────────────────────────────────────────────

  it('calls deleteAudio with the meetingId on confirm', async () => {
    const user = userEvent.setup();
    renderDialog({ meetingId: 'xyz-999' });

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => expect(mockDeleteAudio).toHaveBeenCalledWith('xyz-999'));
  });

  it('calls updateMeeting with audioDeleted:true on confirm', async () => {
    const user = userEvent.setup();
    renderDialog({ meetingId: 'xyz-999' });

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() =>
      expect(mockUpdateMeeting).toHaveBeenCalledWith('xyz-999', { audioDeleted: true }),
    );
  });

  it('calls onDeleted after successful confirm', async () => {
    const user = userEvent.setup();
    const { onDeleted } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('calls onOpenChange(false) after successful confirm', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('calls deleteAudio before updateMeeting (correct sequence)', async () => {
    const calls: string[] = [];
    mockDeleteAudio.mockImplementation(async () => { calls.push('deleteAudio'); });
    mockUpdateMeeting.mockImplementation(async () => { calls.push('updateMeeting'); });

    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => expect(calls).toEqual(['deleteAudio', 'updateMeeting']));
  });

  // ─── Deleting (loading) state ────────────────────────────────────────────────

  it('shows "Sletter…" on the confirm button while async work is running', async () => {
    let resolveDelete!: () => void;
    mockDeleteAudio.mockReturnValue(new Promise<void>((r) => { resolveDelete = r; }));

    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    expect(screen.getByRole('button', { name: 'Sletter…' })).toBeInTheDocument();

    resolveDelete();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sletter…' })).not.toBeInTheDocument(),
    );
  });

  it('disables the confirm button while deleting', async () => {
    let resolveDelete!: () => void;
    mockDeleteAudio.mockReturnValue(new Promise<void>((r) => { resolveDelete = r; }));

    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    expect(screen.getByRole('button', { name: 'Sletter…' })).toBeDisabled();

    resolveDelete();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sletter…' })).not.toBeInTheDocument(),
    );
  });

  it('disables the cancel button while deleting', async () => {
    let resolveDelete!: () => void;
    mockDeleteAudio.mockReturnValue(new Promise<void>((r) => { resolveDelete = r; }));

    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Slet' }));

    expect(screen.getByRole('button', { name: 'Afbryd' })).toBeDisabled();

    resolveDelete();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Afbryd' })).not.toBeDisabled(),
    );
  });

  // ─── Error path ──────────────────────────────────────────────────────────────
  // The component's handleConfirm uses try/finally with no explicit catch — when
  // deleteAudio rejects, the error propagates from the unawaited onClick handler as
  // an unhandled promise rejection. We suppress that at the process level per-test.

  it('closes the dialog (onOpenChange(false)) even when deleteAudio throws', async () => {
    const error = new Error('Network error');
    mockDeleteAudio.mockImplementation(() => Promise.reject(error));

    const suppress = (reason: unknown) => { if (reason === error) { /* swallow */ } };
    process.on('unhandledRejection', suppress);

    try {
      const user = userEvent.setup();
      const { onOpenChange } = renderDialog();

      await user.click(screen.getByRole('button', { name: 'Slet' }));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    } finally {
      process.off('unhandledRejection', suppress);
    }
  });

  it('does NOT call onDeleted when deleteAudio throws', async () => {
    const error = new Error('Network error 2');
    mockDeleteAudio.mockImplementation(() => Promise.reject(error));

    const suppress = (reason: unknown) => { if (reason === error) { /* swallow */ } };
    process.on('unhandledRejection', suppress);

    try {
      const user = userEvent.setup();
      const { onDeleted, onOpenChange } = renderDialog();

      await user.click(screen.getByRole('button', { name: 'Slet' }));

      // Wait for the finally block to execute (onOpenChange(false) is called in finally)
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      // onDeleted should not be called because deleteAudio threw before it
      expect(onDeleted).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', suppress);
    }
  });

  it('re-enables the confirm button after deleteAudio throws (deleting state resets)', async () => {
    const error = new Error('oops');
    mockDeleteAudio.mockImplementation(() => Promise.reject(error));

    const suppress = (reason: unknown) => { if (reason === error) { /* swallow */ } };
    process.on('unhandledRejection', suppress);

    try {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('button', { name: 'Slet' }));

      // After error: deleting state resets (finally block)
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Sletter…' })).not.toBeInTheDocument(),
      );
    } finally {
      process.off('unhandledRejection', suppress);
    }
  });
});
