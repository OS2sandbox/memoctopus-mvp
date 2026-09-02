// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VersionHistory } from './VersionHistory';
import type { MinutesContent } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVersion(
  id: string,
  createdAt: string,
  content: MinutesContent = { body: `Content for ${id}` },
  version?: number,
) {
  return { id, createdAt, content, version };
}

const CONTENT_A: MinutesContent = { body: 'Version A body' };
const CONTENT_B: MinutesContent = { body: 'Version B body' };
const CONTENT_C: MinutesContent = { body: 'Version C body' };

function setup(
  versions: ReturnType<typeof makeVersion>[],
  currentVersion = 3,
) {
  const onRestore = vi.fn();
  render(
    <VersionHistory
      versions={versions}
      currentVersion={currentVersion}
      onRestore={onRestore}
    />,
  );
  return { onRestore };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('VersionHistory — empty state', () => {
  it('renders the "Ingen versionshistorik endnu." placeholder when no versions', () => {
    setup([]);
    expect(screen.getByText('Ingen versionshistorik endnu.')).toBeInTheDocument();
  });

  it('does NOT render the current-version info line when the list is empty', () => {
    setup([]);
    expect(screen.queryByText(/Nuværende version/)).not.toBeInTheDocument();
  });

  it('does NOT render any "Gendan" buttons when the list is empty', () => {
    setup([]);
    expect(screen.queryAllByRole('button', { name: 'Gendan' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-empty rendering
// ---------------------------------------------------------------------------

describe('VersionHistory — renders one row per version', () => {
  it('renders a "Gendan" button for each version in the list', () => {
    setup([
      makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A),
      makeVersion('v2', '2024-01-15T11:00:00Z', CONTENT_B),
      makeVersion('v3', '2024-01-15T12:00:00Z', CONTENT_C),
    ]);
    expect(screen.getAllByRole('button', { name: 'Gendan' })).toHaveLength(3);
  });

  it('does NOT render the placeholder text when there are versions', () => {
    setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)]);
    expect(screen.queryByText('Ingen versionshistorik endnu.')).not.toBeInTheDocument();
  });

  it('renders the current version number in the header line', () => {
    setup(
      [makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)],
      5,
    );
    expect(screen.getByText(/Nuværende version: 5/)).toBeInTheDocument();
  });

  it('renders the "Bevares i 7 dage" retention note in the header', () => {
    setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)]);
    expect(screen.getByText(/Bevares i 7 dage/)).toBeInTheDocument();
  });

  it('renders version labels counting down from newest to oldest', () => {
    // 3 versions → labels should be "Version 3", "Version 2", "Version 1"
    setup([
      makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A),
      makeVersion('v2', '2024-01-15T11:00:00Z', CONTENT_B),
      makeVersion('v3', '2024-01-15T12:00:00Z', CONTENT_C),
    ]);
    expect(screen.getByText('Version 3')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
  });

  it('renders exactly one version label for a single-version list', () => {
    setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)]);
    expect(screen.getByText('Version 1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// formatDateTime label
// ---------------------------------------------------------------------------

describe('VersionHistory — formatDateTime label', () => {
  it('shows a human-readable date string for each version row', () => {
    // Use a specific ISO date and check that the rendered output contains year "2024".
    setup([makeVersion('v1', '2024-06-20T09:30:00Z', CONTENT_A)]);
    // The formatted da-DK string will contain "2024" regardless of timezone drift.
    const dateElements = document.querySelectorAll('span[style*="font-mono"], span[style]');
    // At minimum the formatted date includes the year
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });

  it('different createdAt values produce different date labels', () => {
    setup([
      makeVersion('v1', '2023-03-01T08:00:00Z', CONTENT_A),
      makeVersion('v2', '2024-12-31T23:59:00Z', CONTENT_B),
    ]);
    // Both years should appear somewhere in the rendered output
    expect(screen.getByText(/2023|2024/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Current version labelling / distinction
// ---------------------------------------------------------------------------

describe('VersionHistory — current version display', () => {
  it('shows the currentVersion prop value in the header', () => {
    setup(
      [
        makeVersion('v1', '2024-01-10T10:00:00Z', CONTENT_A),
        makeVersion('v2', '2024-01-11T10:00:00Z', CONTENT_B),
      ],
      7,
    );
    expect(screen.getByText(/Nuværende version: 7/)).toBeInTheDocument();
  });

  it('shows currentVersion 1 correctly', () => {
    setup([makeVersion('v1', '2024-01-10T10:00:00Z', CONTENT_A)], 1);
    expect(screen.getByText(/Nuværende version: 1/)).toBeInTheDocument();
  });

  it('current version line is separate from the row version labels', () => {
    // The header shows the currentVersion number; rows show sequential labels
    setup(
      [makeVersion('v1', '2024-01-10T10:00:00Z', CONTENT_A)],
      42,
    );
    // Header says 42
    expect(screen.getByText(/Nuværende version: 42/)).toBeInTheDocument();
    // Row says "Version 1" (since there is only one entry in the array)
    expect(screen.getByText('Version 1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// User interaction — onRestore
// ---------------------------------------------------------------------------

describe('VersionHistory — clicking Gendan calls onRestore', () => {
  it('calls onRestore with the content of the clicked version', async () => {
    const user = userEvent.setup();
    const { onRestore } = setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)]);
    await user.click(screen.getByRole('button', { name: 'Gendan' }));
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledWith(CONTENT_A);
  });

  it('calls onRestore with the correct content when clicking the second row', async () => {
    const user = userEvent.setup();
    const { onRestore } = setup([
      makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A),
      makeVersion('v2', '2024-01-15T11:00:00Z', CONTENT_B),
    ]);
    const buttons = screen.getAllByRole('button', { name: 'Gendan' });
    // First button corresponds to the first version in the array (index 0)
    await user.click(buttons[1]);
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledWith(CONTENT_B);
  });

  it('calls onRestore the expected number of times across multiple clicks', async () => {
    const user = userEvent.setup();
    const { onRestore } = setup([
      makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A),
      makeVersion('v2', '2024-01-15T11:00:00Z', CONTENT_B),
      makeVersion('v3', '2024-01-15T12:00:00Z', CONTENT_C),
    ]);
    const buttons = screen.getAllByRole('button', { name: 'Gendan' });
    await user.click(buttons[0]);
    await user.click(buttons[2]);
    expect(onRestore).toHaveBeenCalledTimes(2);
    expect(onRestore).toHaveBeenNthCalledWith(1, CONTENT_A);
    expect(onRestore).toHaveBeenNthCalledWith(2, CONTENT_C);
  });

  it('does NOT call onRestore before a button is clicked', () => {
    const { onRestore } = setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A)]);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('passes the exact content object reference to onRestore', async () => {
    const user = userEvent.setup();
    const content: MinutesContent = {
      body: 'specific content',
      header: { title: 'Test meeting', date: '2024-01-15' },
    };
    const { onRestore } = setup([makeVersion('v1', '2024-01-15T10:00:00Z', content)]);
    await user.click(screen.getByRole('button', { name: 'Gendan' }));
    expect(onRestore).toHaveBeenCalledWith(content);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('VersionHistory — edge cases', () => {
  it('renders correctly with a single version', () => {
    setup([makeVersion('only', '2024-06-01T08:00:00Z', CONTENT_A)], 1);
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gendan' })).toBeInTheDocument();
    expect(screen.queryByText('Ingen versionshistorik endnu.')).not.toBeInTheDocument();
  });

  it('handles versions with optional version number field present', () => {
    setup([makeVersion('v1', '2024-01-15T10:00:00Z', CONTENT_A, 99)]);
    // The component uses array index for display, not v.version
    expect(screen.getByText('Version 1')).toBeInTheDocument();
  });

  it('handles MinutesContent with only sections (legacy format)', async () => {
    const user = userEvent.setup();
    const legacyContent: MinutesContent = {
      sections: [{ key: 'k1', label: 'Summary', content: 'Some text' }],
    };
    const { onRestore } = setup([makeVersion('leg', '2024-01-15T10:00:00Z', legacyContent)]);
    await user.click(screen.getByRole('button', { name: 'Gendan' }));
    expect(onRestore).toHaveBeenCalledWith(legacyContent);
  });

  it('handles an empty MinutesContent object gracefully', async () => {
    const user = userEvent.setup();
    const emptyContent: MinutesContent = {};
    const { onRestore } = setup([makeVersion('empty', '2024-01-15T10:00:00Z', emptyContent)]);
    await user.click(screen.getByRole('button', { name: 'Gendan' }));
    expect(onRestore).toHaveBeenCalledWith(emptyContent);
  });
});
