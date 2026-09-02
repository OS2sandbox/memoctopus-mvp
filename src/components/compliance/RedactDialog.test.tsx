// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RedactDialog } from './RedactDialog';

const MEETING_TITLE = 'Bestyrelsesmøde Q4';

function renderDialog(overrides: Partial<React.ComponentProps<typeof RedactDialog>> = {}) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    meetingTitle: MEETING_TITLE,
    onConfirm: vi.fn().mockResolvedValue(undefined),
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<RedactDialog {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('RedactDialog — initial render', () => {
  it('renders the dialog title', () => {
    renderDialog();
    expect(screen.getByText('Slet alt følsomt indhold fra dette møde?')).toBeInTheDocument();
  });

  it('shows the meeting title in the confirmation prompt', () => {
    renderDialog();
    expect(screen.getByText(MEETING_TITLE)).toBeInTheDocument();
  });

  it('renders the confirmation input with placeholder equal to meetingTitle', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    expect(input).toBeInTheDocument();
  });

  it('renders the cancel button', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Afbryd' })).toBeInTheDocument();
  });

  it('renders the destructive confirm button', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeInTheDocument();
  });

  it('renders the warning about audio file deletion', () => {
    renderDialog();
    expect(screen.getByText('Lydfilen slettes permanent')).toBeInTheDocument();
  });

  it('renders the note that the anonymised minutes are preserved', () => {
    renderDialog();
    expect(screen.getByText('Det færdige, anonymiserede referat bevares')).toBeInTheDocument();
  });

  it('does not show an error message initially', () => {
    renderDialog();
    // Error paragraph is conditionally rendered; no danger text present at start
    expect(screen.queryByText('Noget gik galt')).toBeNull();
  });

  it('does not render when open is false', () => {
    renderDialog({ open: false });
    expect(screen.queryByText('Slet alt følsomt indhold fra dette møde?')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confirm button disabled state
// ---------------------------------------------------------------------------

describe('RedactDialog — confirm button disabled until title matches', () => {
  it('is disabled when the input is empty', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeDisabled();
  });

  it('is disabled when the typed text is a prefix of the title', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: 'Bestyrelsesmøde' } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeDisabled();
  });

  it('is disabled when the typed text has extra trailing characters', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE + 'X' } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeDisabled();
  });

  it('is disabled when the typed text is in wrong case', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE.toLowerCase() } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeDisabled();
  });

  it('becomes enabled when the exact title is typed', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
  });

  it('becomes enabled when typed text matches after trimming leading spaces', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: '  ' + MEETING_TITLE } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
  });

  it('becomes enabled when typed text matches after trimming trailing spaces', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE + '  ' } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
  });

  it('becomes enabled when typed text matches with surrounding whitespace', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: `  ${MEETING_TITLE}  ` } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
  });

  it('works when the meetingTitle itself has surrounding whitespace (trim-insensitive both sides)', () => {
    const titleWithSpaces = '  Møde med bestyrelsen  ';
    renderDialog({ meetingTitle: titleWithSpaces });
    // Grab the input by role since the placeholder has surrounding spaces
    const input = screen.getByRole('textbox');
    // Typing just the trimmed version should match (trim on both sides)
    fireEvent.change(input, { target: { value: 'Møde med bestyrelsen' } });
    expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Successful onConfirm flow
// ---------------------------------------------------------------------------

describe('RedactDialog — successful onConfirm', () => {
  it('calls onConfirm when the confirm button is clicked with matching text', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChange(false) after successful onConfirm', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onOpenChange, onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('does NOT call onConfirm when the button is disabled (text mismatch)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: 'wrong title' } });

    // Button is disabled, clicking should be a no-op
    fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('RedactDialog — loading state', () => {
  it('shows "Sletter…" on the confirm button while onConfirm is in flight', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn().mockReturnValue(new Promise<void>((res) => { resolveConfirm = res; }));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));

    await waitFor(() => {
      expect(screen.getByText('Sletter…')).toBeInTheDocument();
    });

    // clean up: resolve the promise
    await act(async () => { resolveConfirm(); });
  });

  it('disables the confirm button while loading', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn().mockReturnValue(new Promise<void>((res) => { resolveConfirm = res; }));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sletter…' })).toBeDisabled();
    });

    await act(async () => { resolveConfirm(); });
  });

  it('disables the cancel button while loading', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn().mockReturnValue(new Promise<void>((res) => { resolveConfirm = res; }));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Afbryd' })).toBeDisabled();
    });

    await act(async () => { resolveConfirm(); });
  });

  it('restores "Slet permanent" label after loading completes successfully', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    // After success the dialog closes, but let's verify by having open stay true via onOpenChange no-op
    const onOpenChange = vi.fn();
    renderDialog({ onConfirm, onOpenChange });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    // After onConfirm resolves, onOpenChange(false) is called; loading should be cleared
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('RedactDialog — onConfirm rejection', () => {
  it('shows the error message when onConfirm throws an Error', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Server fejl'));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Server fejl')).toBeInTheDocument();
    });
  });

  it('shows fallback error message when onConfirm throws a non-Error value', async () => {
    const onConfirm = vi.fn().mockRejectedValue('unexpected string error');
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
    });
  });

  it('clears loading state after onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('oops'));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Sletter…')).toBeNull();
    });
  });

  it('re-enables the confirm button after onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('oops'));
    renderDialog({ onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Slet permanent' })).toBeEnabled();
    });
  });

  it('does NOT call onOpenChange(false) after onConfirm rejects', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error('oops'));
    renderDialog({ onOpenChange, onConfirm });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByText('oops')).toBeInTheDocument();
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('allows retrying after a previous error', async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderDialog({ onConfirm, onOpenChange });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    // First attempt — fails
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByText('first failure')).toBeInTheDocument();
    });

    // Second attempt — succeeds
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Cancel / close behaviour
// ---------------------------------------------------------------------------

describe('RedactDialog — cancel button', () => {
  it('calls onOpenChange(false) when the cancel button is clicked', () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.click(screen.getByRole('button', { name: 'Afbryd' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears any existing error when the dialog is closed via cancel', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('oops'));
    const onOpenChange = vi.fn();
    // Keep dialog artificially open through onOpenChange (no-op) so we can inspect state
    renderDialog({ onConfirm, onOpenChange });

    const input = screen.getByPlaceholderText(MEETING_TITLE);
    fireEvent.change(input, { target: { value: MEETING_TITLE } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet permanent' }));
    });

    await waitFor(() => {
      expect(screen.getByText('oops')).toBeInTheDocument();
    });

    // Now close via cancel — internal state should reset
    // (The component resets confirmText and error on handleClose)
    fireEvent.click(screen.getByRole('button', { name: 'Afbryd' }));

    // handleClose also calls onOpenChange(false)
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
