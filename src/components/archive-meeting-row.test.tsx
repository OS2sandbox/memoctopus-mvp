// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ArchiveMeetingRow } from './archive-meeting-row';

// Mock next/link to render a simple anchor so we can inspect href
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// Mock @/lib/storage so tests never touch IndexedDB
const mockDeleteMeeting = vi.fn();
vi.mock('@/lib/storage', () => ({
  deleteMeeting: (...args: unknown[]) => mockDeleteMeeting(...args),
}));

// ---------------------------------------------------------------------------
// Factories / helpers
// ---------------------------------------------------------------------------

type ArchiveMeeting = {
  id: string;
  title: string;
  participants: string[];
  status: string;
  createdAt: Date;
  durationSeconds: number | null;
};

function makeRow(overrides: Partial<ArchiveMeeting> = {}): ArchiveMeeting {
  return {
    id: 'meeting-1',
    title: 'Ugentligt statusmøde',
    participants: [],
    status: 'done',
    createdAt: new Date('2024-03-15T10:00:00Z'),
    durationSeconds: null,
    ...overrides,
  };
}

function renderRow(
  meeting: ArchiveMeeting,
  props: {
    onDeleted?: () => void;
    selectionMode?: boolean;
    selected?: boolean;
    onToggleSelect?: () => void;
  } = {},
) {
  return render(
    <ArchiveMeetingRow meeting={meeting as never} {...props} />,
  );
}

beforeEach(() => {
  mockDeleteMeeting.mockReset();
});

// ---------------------------------------------------------------------------
// Rendering — basic content
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — basic rendering', () => {
  it('renders the meeting title', () => {
    renderRow(makeRow({ title: 'Mit vigtige møde' }));
    expect(screen.getByText('Mit vigtige møde')).toBeInTheDocument();
  });

  it('renders the formatted date', () => {
    renderRow(makeRow({ createdAt: new Date('2024-03-15T10:00:00Z') }));
    // formatDate uses da-DK locale: "15. marts 2024"
    expect(screen.getByText(/marts 2024/)).toBeInTheDocument();
  });

  it('renders formatted duration when durationSeconds is provided', () => {
    renderRow(makeRow({ durationSeconds: 3661 }));
    // 3661s = 1:01:01
    expect(screen.getByText(/1:01:01/)).toBeInTheDocument();
  });

  it('renders mm:ss duration when less than one hour', () => {
    renderRow(makeRow({ durationSeconds: 125 }));
    // 125s = 02:05
    expect(screen.getByText(/02:05/)).toBeInTheDocument();
  });

  it('does not render duration separator when durationSeconds is null', () => {
    const { container } = renderRow(makeRow({ durationSeconds: null }));
    // The · separator only appears between date and duration
    const meta = container.querySelector('p.mt-0\\.5, p[style*="mono"]');
    // durationSeconds is null so no duration text at all — just check absence of time pattern
    expect(screen.queryByText(/\d{2}:\d{2}/)).toBeNull();
  });

  it('renders participant count when participants are present', () => {
    renderRow(makeRow({ participants: ['Alice', 'Bob', 'Charlie'] }));
    expect(screen.getByText(/3 deltagere/)).toBeInTheDocument();
  });

  it('renders singular "deltager" for one participant', () => {
    renderRow(makeRow({ participants: ['Alice'] }));
    // The text is rendered as separate text nodes: "1" + " deltager" (without the "e" plural suffix)
    // Use a custom matcher to check the full text content of the paragraph
    const meta = screen.getByText((content, element) => {
      return element?.tagName === 'P' && !!element.textContent?.includes('1 deltager') && !element.textContent?.includes('deltagere');
    });
    expect(meta).toBeInTheDocument();
  });

  it('does not render participant count when participants list is empty', () => {
    renderRow(makeRow({ participants: [] }));
    expect(screen.queryByText(/deltager/)).toBeNull();
  });

  it('renders the delete button (aria-label "Slet møde")', () => {
    renderRow(makeRow());
    expect(screen.getByRole('button', { name: 'Slet møde' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Status badge — statusLabel / statusVariant
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — status badge', () => {
  it('shows "Optager" badge for recording status', () => {
    renderRow(makeRow({ status: 'recording' }));
    expect(screen.getByText('Optager')).toBeInTheDocument();
  });

  it('shows "Behandler" badge for processing status', () => {
    renderRow(makeRow({ status: 'processing' }));
    expect(screen.getByText('Behandler')).toBeInTheDocument();
  });

  it('shows "Til gennemsyn" badge for review status', () => {
    renderRow(makeRow({ status: 'review' }));
    expect(screen.getByText('Til gennemsyn')).toBeInTheDocument();
  });

  it('shows "Referat" badge for minutes status', () => {
    renderRow(makeRow({ status: 'minutes' }));
    expect(screen.getByText('Referat')).toBeInTheDocument();
  });

  it('shows "Afsluttet" badge for done status', () => {
    renderRow(makeRow({ status: 'done' }));
    expect(screen.getByText('Afsluttet')).toBeInTheDocument();
  });

  it('shows "Anonymiseret" badge for redacted status', () => {
    renderRow(makeRow({ status: 'redacted' }));
    expect(screen.getByText('Anonymiseret')).toBeInTheDocument();
  });

  it('shows the raw status string for an unknown status', () => {
    renderRow(makeRow({ status: 'custom-status' }));
    expect(screen.getByText('custom-status')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// statusHref routing
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — link routing (statusHref)', () => {
  it('links to /meeting/:id for recording status', () => {
    renderRow(makeRow({ id: 'abc', status: 'recording' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc');
  });

  it('links to /meeting/:id for processing status', () => {
    renderRow(makeRow({ id: 'abc', status: 'processing' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc');
  });

  it('links to /meeting/:id/review for review status', () => {
    renderRow(makeRow({ id: 'abc', status: 'review' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc/review');
  });

  it('links to /meeting/:id/minutes for minutes status', () => {
    renderRow(makeRow({ id: 'abc', status: 'minutes' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc/minutes');
  });

  it('links to /meeting/:id/minutes for done status', () => {
    renderRow(makeRow({ id: 'abc', status: 'done' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc/minutes');
  });

  it('links to /meeting/:id/minutes for redacted status', () => {
    renderRow(makeRow({ id: 'abc', status: 'redacted' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc/minutes');
  });

  it('links to /meeting/:id/minutes for an unknown status', () => {
    renderRow(makeRow({ id: 'abc', status: 'unknown-status' }));
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/meeting/abc/minutes');
  });
});

// ---------------------------------------------------------------------------
// Selection mode
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — selection mode', () => {
  it('renders a checkbox when selectionMode is true', () => {
    const { container } = renderRow(makeRow(), { selectionMode: true });
    // The component renders both a div[role=checkbox] (the outer wrapper) and an input[type=checkbox]
    expect(container.querySelector('[role="checkbox"]')).toBeInTheDocument();
    expect(container.querySelector('input[type="checkbox"]')).toBeInTheDocument();
  });

  it('does not render a navigation link in selection mode', () => {
    renderRow(makeRow(), { selectionMode: true });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('checkbox is checked when selected is true', () => {
    const { container } = renderRow(makeRow(), { selectionMode: true, selected: true });
    // The outer div has role=checkbox and aria-checked
    const checkboxDiv = container.querySelector('[role="checkbox"]');
    expect(checkboxDiv).toHaveAttribute('aria-checked', 'true');
    // The inner input also reflects checked state
    const inputEl = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(inputEl.checked).toBe(true);
  });

  it('checkbox is unchecked when selected is false', () => {
    const { container } = renderRow(makeRow(), { selectionMode: true, selected: false });
    const checkboxDiv = container.querySelector('[role="checkbox"]');
    expect(checkboxDiv).toHaveAttribute('aria-checked', 'false');
    const inputEl = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(inputEl.checked).toBe(false);
  });

  it('checkbox defaults to unchecked when selected is not provided', () => {
    const { container } = renderRow(makeRow(), { selectionMode: true });
    const checkboxDiv = container.querySelector('[role="checkbox"]');
    expect(checkboxDiv).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onToggleSelect when the row is clicked in selection mode', () => {
    const onToggleSelect = vi.fn();
    const { container } = renderRow(makeRow({ title: 'Testmøde' }), { selectionMode: true, onToggleSelect });
    // click the outer div (role=checkbox)
    const checkboxDiv = container.querySelector('[role="checkbox"]') as HTMLElement;
    fireEvent.click(checkboxDiv);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('has the correct aria-label with the meeting title in selection mode', () => {
    const { container } = renderRow(makeRow({ title: 'Planmøde' }), { selectionMode: true });
    const checkboxDiv = container.querySelector('[role="checkbox"]');
    expect(checkboxDiv).toHaveAttribute('aria-label', 'Vælg Planmøde');
  });

  it('renders title and status badge in selection mode', () => {
    renderRow(makeRow({ title: 'Budgetmøde', status: 'done' }), { selectionMode: true });
    expect(screen.getByText('Budgetmøde')).toBeInTheDocument();
    expect(screen.getByText('Afsluttet')).toBeInTheDocument();
  });

  it('does not render the delete button in selection mode', () => {
    renderRow(makeRow(), { selectionMode: true });
    expect(screen.queryByRole('button', { name: 'Slet møde' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete flow — dialog
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — delete dialog', () => {
  it('delete dialog is not visible initially', () => {
    renderRow(makeRow());
    // Dialog content should not be in the DOM before opening
    expect(screen.queryByText('Slet dette møde?')).toBeNull();
  });

  it('opens the delete dialog when the delete button is clicked', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => {
      expect(screen.getByText('Slet dette møde?')).toBeInTheDocument();
    });
  });

  it('shows the destructive consequence text in the dialog', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => {
      expect(screen.getByText(/Alt indhold slettes permanent/)).toBeInTheDocument();
    });
  });

  it('shows "Annullér" and "Slet møde" buttons in the dialog', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Annullér' })).toBeInTheDocument();
      // There are now two "Slet møde" buttons: the icon btn (hidden) and the dialog confirm btn
      const deleteBtns = screen.getAllByRole('button', { name: 'Slet møde' });
      expect(deleteBtns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('closes the dialog without calling deleteMeeting when Annullér is clicked', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));

    await waitFor(() => {
      expect(screen.queryByText('Slet dette møde?')).toBeNull();
    });
    expect(mockDeleteMeeting).not.toHaveBeenCalled();
  });

  it('calls deleteMeeting with the meeting id when "Slet møde" is confirmed', async () => {
    mockDeleteMeeting.mockResolvedValueOnce(undefined);
    const onDeleted = vi.fn();

    renderRow(makeRow({ id: 'meeting-xyz' }), { onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    // The confirm button inside the dialog
    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mockDeleteMeeting).toHaveBeenCalledWith('meeting-xyz');
  });

  it('calls onDeleted after successful deletion', async () => {
    mockDeleteMeeting.mockResolvedValueOnce(undefined);
    const onDeleted = vi.fn();

    renderRow(makeRow({ id: 'meeting-xyz' }), { onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  it('closes the dialog after successful deletion', async () => {
    mockDeleteMeeting.mockResolvedValueOnce(undefined);

    renderRow(makeRow());

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText('Slet dette møde?')).toBeNull();
    });
  });

  it('does not call onDeleted if deleteMeeting throws', async () => {
    mockDeleteMeeting.mockRejectedValueOnce(new Error('network error'));
    const onDeleted = vi.fn();

    renderRow(makeRow(), { onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(onDeleted).not.toHaveBeenCalled();
    });
  });

  it('does not close the dialog when deleteMeeting throws', async () => {
    mockDeleteMeeting.mockRejectedValueOnce(new Error('network error'));

    renderRow(makeRow());

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Dialog should remain open on error
    await waitFor(() => {
      expect(screen.getByText('Slet dette møde?')).toBeInTheDocument();
    });
  });

  it('shows an inline error message inside the dialog when deleteMeeting throws', async () => {
    mockDeleteMeeting.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));

    renderRow(makeRow());

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Mødet kunne ikke slettes/)).toBeInTheDocument();
    });
  });

  it('clears the error message when the dialog is reopened via the delete button', async () => {
    // First attempt fails
    mockDeleteMeeting.mockRejectedValueOnce(new Error('network error'));

    renderRow(makeRow());

    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    // Trigger failure
    const getConfirmBtn = () =>
      screen.getAllByRole('button', { name: 'Slet møde' }).find(
        (btn) => btn.closest('[role="dialog"]') !== null,
      )!;

    await act(async () => {
      fireEvent.click(getConfirmBtn());
    });

    // Error is shown
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Close via Annullér
    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));

    // Reopen via the icon delete button — error must be cleared before the dialog opens
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    });

    await waitFor(() => screen.getByText('Slet dette møde?'));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call onDeleted when cancel is clicked (no deleteMeeting call)', async () => {
    const onDeleted = vi.fn();
    renderRow(makeRow(), { onDeleted });

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));

    await waitFor(() => {
      expect(screen.queryByText('Slet dette møde?')).toBeNull();
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mockDeleteMeeting).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-selection mode — normal render without selection props
// ---------------------------------------------------------------------------

describe('ArchiveMeetingRow — normal mode (no selection)', () => {
  it('renders a link to the meeting', () => {
    renderRow(makeRow({ id: 'abc', status: 'done' }));
    expect(screen.getByRole('link')).toBeInTheDocument();
  });

  it('does not render a checkbox in normal mode', () => {
    renderRow(makeRow());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('omits onDeleted without crashing when it is undefined', async () => {
    mockDeleteMeeting.mockResolvedValueOnce(undefined);

    renderRow(makeRow()); // no onDeleted prop

    fireEvent.click(screen.getByRole('button', { name: 'Slet møde' }));
    await waitFor(() => screen.getByText('Slet dette møde?'));

    const confirmBtn = screen.getAllByRole('button', { name: 'Slet møde' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null,
    )!;

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Should not throw; dialog closes
    await waitFor(() => {
      expect(screen.queryByText('Slet dette møde?')).toBeNull();
    });
  });
});
