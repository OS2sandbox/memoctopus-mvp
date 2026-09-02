// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MinutesEditor } from './MinutesEditor';
import type { MinutesContent } from '@/types';

// ---------------------------------------------------------------------------
// Mock @/lib/storage — every storage function is replaced with vi.fn()
// ---------------------------------------------------------------------------
const mockSaveMinutes = vi.fn();
const mockSnapshotMinutes = vi.fn();
const mockSetActiveMinutesVersion = vi.fn();
const mockUpdateMeeting = vi.fn();

vi.mock('@/lib/storage', () => ({
  saveMinutes: (...args: unknown[]) => mockSaveMinutes(...args),
  snapshotMinutes: (...args: unknown[]) => mockSnapshotMinutes(...args),
  setActiveMinutesVersion: (...args: unknown[]) => mockSetActiveMinutesVersion(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
}));

// ---------------------------------------------------------------------------
// Mock the heavy TipTap-based RichEditor with a simple textarea
// ---------------------------------------------------------------------------
vi.mock('./RichEditor', () => ({
  RichEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="rich-editor"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MEETING_ID = 'meeting-1';
const MEETING_TITLE = 'Ugentligt møde';

function makeContent(
  body = 'Mødereferat',
  title = 'Min titel',
  date: string | null = '2024-01-15',
): MinutesContent {
  return { body, header: { title, date } };
}

function makeVersion(
  id: string,
  label: number,
  body = 'Version body',
  title = 'Version titel',
  date: string | null = null,
) {
  const content = makeContent(body, title, date);
  return { id, label, content, baseline: content };
}

/** Build the default props for a single-version editor. */
function defaultProps(
  overrides: Partial<React.ComponentProps<typeof MinutesEditor>> = {},
) {
  const v1 = makeVersion('v1', 1, 'Original body', 'Original titel');
  return {
    meetingId: MEETING_ID,
    meetingTitle: MEETING_TITLE,
    initialContent: v1.content,
    version: 1,
    activeVersionId: 'v1',
    versions: [v1],
    ...overrides,
  };
}

/** Return value matching StoredMinutes shape that saveMinutes resolves to */
function storedMinutes(versions: ReturnType<typeof makeVersion>[]) {
  return { versions };
}

/** Return value matching shape that snapshotMinutes resolves to */
function snapshotResult(
  version: number,
  activeVersionId: string,
  versions: ReturnType<typeof makeVersion>[],
) {
  return { version, activeVersionId, versions };
}

// Use fake timers with shouldAdvanceTime so real async waits (waitFor) still
// tick while we also control setTimeout manually.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockSaveMinutes.mockResolvedValue(storedMinutes([makeVersion('v1', 1)]));
  mockSnapshotMinutes.mockResolvedValue(
    snapshotResult(2, 'v2', [makeVersion('v1', 1), makeVersion('v2', 2)]),
  );
  mockSetActiveMinutesVersion.mockResolvedValue(storedMinutes([makeVersion('v1', 1)]));
  mockUpdateMeeting.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Flush any pending autosave timer before unmounting so the unmount-flush
  // doesn't bleed into the next test's mock state.
  vi.clearAllTimers();
  cleanup();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
describe('MinutesEditor — rendering', () => {
  it('renders the "Referat" heading', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByText('Referat')).toBeInTheDocument();
  });

  it('renders the title input with the initial title value', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByRole('textbox', { name: 'Titel' })).toHaveValue('Original titel');
  });

  it('renders the date input when date is a non-null string', () => {
    const v = makeVersion('v1', 1, 'Body', 'Titel', '2024-01-01');
    render(
      <MinutesEditor
        {...defaultProps({ initialContent: v.content, versions: [v] })}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Dato' })).toHaveValue('2024-01-01');
  });

  it('does NOT render the date input when date is null', () => {
    const content: MinutesContent = { body: 'Body', header: { title: 'T', date: null } };
    const v = { id: 'v1', label: 1, content, baseline: content };
    render(
      <MinutesEditor
        {...defaultProps({ initialContent: content, versions: [v] })}
      />,
    );
    expect(screen.queryByRole('textbox', { name: 'Dato' })).toBeNull();
  });

  it('renders the RichEditor with the initial body', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByTestId('rich-editor')).toHaveValue('Original body');
  });

  it('renders "Gem version" button', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByRole('button', { name: 'Gem version' })).toBeInTheDocument();
  });

  it('renders "Eksportér" button', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByRole('button', { name: 'Eksportér' })).toBeInTheDocument();
  });

  it('"Gem version" is disabled when content matches the baseline (not dirty)', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByRole('button', { name: 'Gem version' })).toBeDisabled();
  });

  it('shows a single version label as plain text when there is only one version', () => {
    render(<MinutesEditor {...defaultProps()} />);
    // Single version renders as a <p> with "Version 1" — no dropdown trigger
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    // The VersionDropdown renders a <p>, not a <button>, for single versions.
    // There must be no button with that exact text (the "Gem version" button has
    // its own title attribute, not the version text in its accessible name).
    const versionButtons = screen.queryAllByRole('button', { name: /^Version \d+$/ });
    expect(versionButtons).toHaveLength(0);
  });

  it('renders a dropdown trigger button when there are multiple versions', () => {
    const v1 = makeVersion('v1', 1, 'Body v1', 'Titel v1');
    const v2 = makeVersion('v2', 2, 'Body v2', 'Titel v2');
    render(
      <MinutesEditor
        {...defaultProps({
          versions: [v1, v2],
          version: 2,
          activeVersionId: 'v2',
          initialContent: v2.content,
        })}
      />,
    );
    // Multi-version: a <button> that contains the version text is rendered
    expect(
      screen.getByRole('button', { name: /Version 2/ }),
    ).toBeInTheDocument();
  });

  it('shows the hint text about automatic saving', () => {
    render(<MinutesEditor {...defaultProps()} />);
    expect(screen.getByText(/gemmes automatisk/i)).toBeInTheDocument();
  });

  it('uses meetingTitle as fallback when header.title is absent', () => {
    const content: MinutesContent = { body: 'Body', header: undefined };
    render(<MinutesEditor {...defaultProps({ initialContent: content })} />);
    expect(screen.getByRole('textbox', { name: 'Titel' })).toHaveValue(MEETING_TITLE);
  });
});

// ---------------------------------------------------------------------------
// Dirty state / "Gem version" enablement
// ---------------------------------------------------------------------------
describe('MinutesEditor — dirty state', () => {
  it('"Gem version" becomes enabled after editing the body', () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');
    fireEvent.change(editor, { target: { value: 'Changed body' } });
    expect(screen.getByRole('button', { name: 'Gem version' })).not.toBeDisabled();
  });

  it('"Gem version" becomes enabled after editing the title', () => {
    render(<MinutesEditor {...defaultProps()} />);
    const titleInput = screen.getByRole('textbox', { name: 'Titel' });
    fireEvent.change(titleInput, { target: { value: 'New title' } });
    expect(screen.getByRole('button', { name: 'Gem version' })).not.toBeDisabled();
  });

  it('"Gem version" becomes enabled after editing the date', () => {
    const v = makeVersion('v1', 1, 'Body', 'Titel', '2024-01-01');
    render(
      <MinutesEditor {...defaultProps({ initialContent: v.content, versions: [v] })} />,
    );
    const dateInput = screen.getByRole('textbox', { name: 'Dato' });
    fireEvent.change(dateInput, { target: { value: '2024-06-01' } });
    expect(screen.getByRole('button', { name: 'Gem version' })).not.toBeDisabled();
  });

  it('"Gem version" stays disabled when body is reverted to the original value', () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');
    fireEvent.change(editor, { target: { value: 'Changed body' } });
    // Revert back to original
    fireEvent.change(editor, { target: { value: 'Original body' } });
    expect(screen.getByRole('button', { name: 'Gem version' })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Autosave (debounced) — AUTOSAVE_DELAY = 1500 ms
// ---------------------------------------------------------------------------
describe('MinutesEditor — autosave (AUTOSAVE_DELAY)', () => {
  it('does NOT call saveMinutes before the delay elapses', () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'A' } });
      // Advance 1499 ms — just under the threshold
      vi.advanceTimersByTime(1499);
    });

    expect(mockSaveMinutes).not.toHaveBeenCalled();
  });

  it('calls saveMinutes after AUTOSAVE_DELAY (1500 ms)', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'Ny tekst' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(mockSaveMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ body: 'Ny tekst' }),
      ),
    );
  });

  it('debounces: multiple rapid edits only call saveMinutes once', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'A' } });
      vi.advanceTimersByTime(500);
      fireEvent.change(editor, { target: { value: 'AB' } });
      vi.advanceTimersByTime(500);
      fireEvent.change(editor, { target: { value: 'ABC' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(mockSaveMinutes).toHaveBeenCalledTimes(1));
    expect(mockSaveMinutes).toHaveBeenCalledWith(
      MEETING_ID,
      expect.objectContaining({ body: 'ABC' }),
    );
  });

  it('shows "Gemmer…" SaveStatus while saveMinutes is in progress', async () => {
    let resolve!: (v: unknown) => void;
    mockSaveMinutes.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'Tekst' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(screen.getByText('Gemmer…')).toBeInTheDocument());

    // Resolve so the component can clean up
    await act(async () => {
      resolve(storedMinutes([makeVersion('v1', 1)]));
    });
  });

  it('shows "Gemt" SaveStatus after a successful autosave', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'Tekst' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(screen.getByText('Gemt')).toBeInTheDocument());
  });

  it('shows "Fejl ved gemning" SaveStatus when saveMinutes rejects', async () => {
    mockSaveMinutes.mockRejectedValueOnce(new Error('Network error'));

    render(<MinutesEditor {...defaultProps()} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'Tekst' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(screen.getByText('Fejl ved gemning')).toBeInTheDocument(),
    );
  });

  it('calls onSaved callback after a successful autosave', async () => {
    const onSaved = vi.fn();
    render(<MinutesEditor {...defaultProps({ onSaved })} />);
    const editor = screen.getByTestId('rich-editor');

    act(() => {
      fireEvent.change(editor, { target: { value: 'Ny tekst' } });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('passes the full content (body + header) to saveMinutes', async () => {
    const v = makeVersion('v1', 1, 'Initial body', 'Titel', '2024-05-01');
    render(
      <MinutesEditor {...defaultProps({ initialContent: v.content, versions: [v] })} />,
    );

    act(() => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Titel' }), {
        target: { value: 'Ny titel' },
      });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(mockSaveMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({
          header: expect.objectContaining({ title: 'Ny titel' }),
        }),
      ),
    );
  });

  it('calls updateMeeting when the title changes and differs from the saved title', async () => {
    render(<MinutesEditor {...defaultProps()} />);

    act(() => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Titel' }), {
        target: { value: 'Ny mødetitel' },
      });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(mockUpdateMeeting).toHaveBeenCalledWith(MEETING_ID, { title: 'Ny mødetitel' }),
    );
  });

  it('does NOT call updateMeeting when the title is unchanged', async () => {
    // The initial title is 'Original titel' — edit body only
    render(<MinutesEditor {...defaultProps()} />);

    act(() => {
      fireEvent.change(screen.getByTestId('rich-editor'), {
        target: { value: 'Changed body only' },
      });
      vi.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(mockSaveMinutes).toHaveBeenCalledTimes(1));
    expect(mockUpdateMeeting).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// "Gem version" (snapshot) — fingerprint prevents duplicates
// ---------------------------------------------------------------------------
describe('MinutesEditor — Gem version (snapshot)', () => {
  it('does NOT call snapshotMinutes when content is identical to baseline', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    // Click without making any changes
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    expect(mockSnapshotMinutes).not.toHaveBeenCalled();
  });

  it('calls snapshotMinutes after editing content and clicking "Gem version"', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() =>
      expect(mockSnapshotMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ body: 'Changed body' }),
      ),
    );
  });

  it('calls snapshotMinutes with the current title in content', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Titel' }), {
      target: { value: 'Ny version titel' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() =>
      expect(mockSnapshotMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({
          header: expect.objectContaining({ title: 'Ny version titel' }),
        }),
      ),
    );
  });

  it('updates the displayed version number after snapshotMinutes resolves', async () => {
    mockSnapshotMinutes.mockResolvedValueOnce(
      snapshotResult(2, 'v2', [
        makeVersion('v1', 1),
        makeVersion('v2', 2, 'Changed body'),
      ]),
    );

    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() =>
      expect(screen.getAllByText(/Version 2/).length).toBeGreaterThan(0),
    );
  });

  it('calls onSaved after a successful snapshot', async () => {
    const onSaved = vi.fn();
    render(<MinutesEditor {...defaultProps({ onSaved })} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows "Fejl ved gemning" when snapshotMinutes rejects', async () => {
    mockSnapshotMinutes.mockRejectedValueOnce(new Error('fail'));

    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() =>
      expect(screen.getByText('Fejl ved gemning')).toBeInTheDocument(),
    );
  });

  it('"Gem version" cancels the pending autosave timer before snapshotting', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });
    // Click before the autosave timer fires (< 1500 ms)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });

    await waitFor(() => expect(mockSnapshotMinutes).toHaveBeenCalledTimes(1));

    // Now advance past autosave delay — it should NOT trigger saveMinutes
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // saveMinutes should not have been called (snapshot cancelled the autosave)
    expect(mockSaveMinutes).not.toHaveBeenCalled();
  });

  it('fingerprint: repeated "Gem version" on unchanged content after first snapshot is a no-op', async () => {
    const v1 = makeVersion('v1', 1, 'Original body', 'Original titel', null);
    const v2 = makeVersion('v2', 2, 'Changed body', 'Original titel', null);
    mockSnapshotMinutes.mockResolvedValueOnce(
      snapshotResult(2, 'v2', [v1, v2]),
    );

    render(
      <MinutesEditor {...defaultProps({ initialContent: v1.content, versions: [v1] })} />,
    );
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Changed body' },
    });

    // First snapshot
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });
    await waitFor(() => expect(mockSnapshotMinutes).toHaveBeenCalledTimes(1));

    // After snapshot the baseline is updated to 'Changed body'. Clicking again
    // without further changes must not trigger a second snapshot.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem version' }));
    });
    expect(mockSnapshotMinutes).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Version dropdown — restoring / selecting a version
// ---------------------------------------------------------------------------
describe('MinutesEditor — version dropdown and version restore', () => {
  function multiVersionProps() {
    const v1 = makeVersion('v1', 1, 'Body v1', 'Titel v1');
    const v2 = makeVersion('v2', 2, 'Body v2', 'Titel v2');
    mockSaveMinutes.mockResolvedValue(storedMinutes([v1, v2]));
    mockSetActiveMinutesVersion.mockResolvedValue(storedMinutes([v1, v2]));
    return {
      props: defaultProps({
        versions: [v1, v2],
        version: 2,
        activeVersionId: 'v2',
        initialContent: v2.content,
      }),
      v1,
      v2,
    };
  }

  it('shows a dropdown with both versions when the trigger is clicked', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    expect(screen.getByText('Version 1')).toBeInTheDocument();
    // "Version 2" appears in both the trigger and the dropdown
    expect(screen.getAllByText('Version 2').length).toBeGreaterThanOrEqual(1);
  });

  it('marks the active version with "nuværende" in the dropdown', () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    expect(screen.getByText('nuværende')).toBeInTheDocument();
  });

  it('calls setActiveMinutesVersion when a different version is selected', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    // Find "Version 1" item inside the dropdown (not the trigger)
    const allV1Buttons = screen.getAllByRole('button');
    const v1ItemBtn = allV1Buttons.find(
      (b) => b.textContent?.trim() === 'Version 1',
    )!;

    await act(async () => {
      fireEvent.click(v1ItemBtn);
    });

    await waitFor(() =>
      expect(mockSetActiveMinutesVersion).toHaveBeenCalledWith(MEETING_ID, 'v1'),
    );
  });

  it('updates the editor body after selecting a different version', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    const allButtons = screen.getAllByRole('button');
    const v1ItemBtn = allButtons.find(
      (b) => b.textContent?.trim() === 'Version 1',
    )!;

    await act(async () => {
      fireEvent.click(v1ItemBtn);
    });

    await waitFor(() =>
      expect(screen.getByTestId('rich-editor')).toHaveValue('Body v1'),
    );
  });

  it('updates the title input after restoring a version', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    const allButtons = screen.getAllByRole('button');
    const v1ItemBtn = allButtons.find(
      (b) => b.textContent?.trim() === 'Version 1',
    )!;

    await act(async () => {
      fireEvent.click(v1ItemBtn);
    });

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Titel' })).toHaveValue('Titel v1'),
    );
  });

  it('does NOT call setActiveMinutesVersion when clicking the already-active version', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    // The "nuværende" badge is inside the active version's button
    const currentVersionBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('nuværende'))!;

    await act(async () => {
      fireEvent.click(currentVersionBtn);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockSetActiveMinutesVersion).not.toHaveBeenCalled();
  });

  it('closes the dropdown after selecting a version', async () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));
    expect(screen.getByText('nuværende')).toBeInTheDocument();

    const allButtons = screen.getAllByRole('button');
    const v1ItemBtn = allButtons.find(
      (b) => b.textContent?.trim() === 'Version 1',
    )!;

    await act(async () => {
      fireEvent.click(v1ItemBtn);
    });

    await waitFor(() => expect(screen.queryByText('nuværende')).toBeNull());
  });

  it('closes the dropdown when clicking outside', () => {
    const { props } = multiVersionProps();
    render(<MinutesEditor {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));
    expect(screen.getByText('nuværende')).toBeInTheDocument();

    // Simulate a mousedown outside the dropdown
    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('nuværende')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flush on visibility change / page hide
// ---------------------------------------------------------------------------
describe('MinutesEditor — flush on page hide', () => {
  it('calls saveMinutes when the document becomes hidden (visibilitychange)', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Unsaved body' },
    });

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockSaveMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ body: 'Unsaved body' }),
      ),
    );

    // Restore
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('calls saveMinutes on pagehide event', async () => {
    render(<MinutesEditor {...defaultProps()} />);
    fireEvent.change(screen.getByTestId('rich-editor'), {
      target: { value: 'Pagehide body' },
    });

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockSaveMinutes).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ body: 'Pagehide body' }),
      ),
    );
  });
});
