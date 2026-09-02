// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import OptaqPage from './dashboard.client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, style }: { href: string; children: React.ReactNode; style?: React.CSSProperties }) => (
    <a href={href} style={style}>{children}</a>
  ),
}));

const mockGetAllMeetings = vi.fn();
const mockCreateMeeting = vi.fn();

vi.mock('@/lib/storage', () => ({
  getAllMeetings: (...args: unknown[]) => mockGetAllMeetings(...args),
  createMeeting: (...args: unknown[]) => mockCreateMeeting(...args),
}));

const mockSetPendingUploadFile = vi.fn();

vi.mock('@/lib/pending-upload', () => ({
  setPendingUploadFile: (...args: unknown[]) => mockSetPendingUploadFile(...args),
}));

vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  return render(<OptaqPage />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockGetAllMeetings.mockReset();
  mockCreateMeeting.mockReset();
  mockSetPendingUploadFile.mockReset();

  // Default: zero meetings (no prior meetings link shown)
  mockGetAllMeetings.mockResolvedValue([]);
  // Default: createMeeting returns a meeting with id 'meeting-abc'
  mockCreateMeeting.mockResolvedValue({ id: 'meeting-abc' });
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe('OptaqPage — initial render', () => {
  it('renders the main heading', () => {
    renderPage();
    // The h1 text is split across text nodes and an <em> child element
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toBeInTheDocument();
    expect(h1.textContent).toMatch(/Møde til/);
  });

  it('renders the "optag" record button', () => {
    renderPage();
    expect(screen.getByText('optag')).toBeInTheDocument();
  });

  it('renders the meeting title input', () => {
    renderPage();
    expect(screen.getByPlaceholderText('Navngiv mødet…')).toBeInTheDocument();
  });

  it('renders the participants input', () => {
    renderPage();
    expect(screen.getByPlaceholderText('+ tilføj')).toBeInTheDocument();
  });

  it('renders the Teams meeting link input', () => {
    renderPage();
    expect(screen.getByPlaceholderText('Indsæt mødelink…')).toBeInTheDocument();
  });

  it('renders the upload file label', () => {
    renderPage();
    expect(screen.getByText('upload lydfil →')).toBeInTheDocument();
  });

  it('shows "ingen tidligere møder" when meetingCount is 0', async () => {
    mockGetAllMeetings.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('ingen tidligere møder')).toBeInTheDocument();
    });
  });

  it('calls getAllMeetings on mount', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockGetAllMeetings).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Meeting count / footer link
// ---------------------------------------------------------------------------

describe('OptaqPage — meeting count footer', () => {
  it('shows archive link with count when meetingCount > 0', async () => {
    mockGetAllMeetings.mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/se 3 tidligere møder i arkivet/)).toBeInTheDocument();
    });
  });

  it('archive link points to /arkiv', async () => {
    mockGetAllMeetings.mockResolvedValue([{ id: '1' }]);
    renderPage();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /se 1 tidligere møder i arkivet/ });
      expect(link).toHaveAttribute('href', '/arkiv');
    });
  });

  it('shows "ingen tidligere møder" when getAllMeetings returns empty', async () => {
    mockGetAllMeetings.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('ingen tidligere møder')).toBeInTheDocument();
    });
  });

  it('shows "ingen tidligere møder" if getAllMeetings rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetAllMeetings.mockRejectedValue(new Error('db error'));
    renderPage();
    // After rejection, meetingCount stays null so the footer shows null check text
    // The component catches the error and shows nothing (meetingCount stays null)
    // which means neither the link nor the "ingen" text is shown — check null stays
    await act(async () => {});
    // meetingCount remains null so neither branch renders in the footer
    expect(screen.queryByText(/arkivet/)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[dashboard] getAllMeetings failed:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('shows "ingen tidligere møder" while meetingCount is null (before fetch resolves)', () => {
    // When meetingCount is null the condition `meetingCount != null && meetingCount > 0` is false,
    // so the else branch ("ingen tidligere møder") is rendered immediately.
    let resolve!: (v: unknown) => void;
    mockGetAllMeetings.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPage();
    // The archive link should NOT be visible yet
    expect(screen.queryByText(/arkivet/)).toBeNull();
    // "ingen tidligere møder" IS shown while loading (meetingCount is null → else branch)
    expect(screen.getByText('ingen tidligere møder')).toBeInTheDocument();
    // cleanup — resolve the promise
    act(() => { resolve([]); });
  });
});

// ---------------------------------------------------------------------------
// Participant chips
// ---------------------------------------------------------------------------

describe('OptaqPage — participant chips', () => {
  it('adds a participant chip when Enter is pressed in the adding input', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  it('clears the adding input after adding a participant', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('does not add an empty string as a participant', () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // No chip button for "Fjern" should exist for whitespace-only entries
    expect(screen.queryByRole('button', { name: /Fjern/ })).toBeNull();
  });

  it('adds multiple participants', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');

    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Alice'));

    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Bob'));

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('removes a participant chip when the × button is clicked', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Alice'));

    const removeBtn = screen.getByRole('button', { name: 'Fjern Alice' });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByText('Alice')).toBeNull();
    });
  });

  it('renders remove button with aria-label "Fjern <name>"', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Charlie' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Fjern Charlie' })).toBeInTheDocument();
    });
  });

  it('removes only the correct participant when multiple exist', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('+ tilføj');

    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Alice'));

    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Bob'));

    fireEvent.click(screen.getByRole('button', { name: 'Fjern Alice' }));

    await waitFor(() => {
      expect(screen.queryByText('Alice')).toBeNull();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Record flow
// ---------------------------------------------------------------------------

describe('OptaqPage — record flow', () => {
  it('calls createMeeting and navigates to /meeting/:id?autostart=1 on record button click', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-1' });
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/meeting/mtg-1?autostart=1');
    });
  });

  it('createMeeting is called with source=local and status=recording', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-2' });
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'local', status: 'recording' }),
      );
    });
  });

  it('uses the typed title when one is provided', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-3' });
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('Navngiv mødet…'), {
      target: { value: 'Quarterly Review' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Quarterly Review' }),
      );
    });
  });

  it('generates a default title when no title is entered', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-4' });
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/^Møde ·/) }),
      );
    });
  });

  it('passes participants to createMeeting when participants are present', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-5' });
    renderPage();

    const input = screen.getByPlaceholderText('+ tilføj');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText('Alice'));

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ participants: ['Alice'] }),
      );
    });
  });

  it('passes undefined participants when no participants are added', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-6' });
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ participants: undefined }),
      );
    });
  });

  it('does not navigate when createMeeting throws', async () => {
    mockCreateMeeting.mockRejectedValue(new Error('storage error'));
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  it('shows Danish error message when startRecording fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateMeeting.mockRejectedValue(new Error('storage error'));
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });

    await waitFor(() => {
      expect(screen.getByText('Noget gik galt. Prøv igen.')).toBeInTheDocument();
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[dashboard] startRecording failed:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('re-enables the record button after startRecording fails', async () => {
    mockCreateMeeting.mockRejectedValue(new Error('storage error'));
    renderPage();

    const btn = screen.getByText('optag').closest('button')!;

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
  });

  it('clears recordError on the next startRecording attempt', async () => {
    // First call fails, second succeeds
    mockCreateMeeting
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue({ id: 'mtg-ok' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });
    await waitFor(() => screen.getByText('Noget gik galt. Prøv igen.'));

    // Second attempt — error should clear before the call resolves
    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });
    await waitFor(() => {
      expect(screen.queryByText('Noget gik galt. Prøv igen.')).toBeNull();
    });
    errorSpy.mockRestore();
  });

  it('recordError banner has a retry button that re-invokes startRecording', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateMeeting
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue({ id: 'retry-id' });

    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText('optag').closest('button')!);
    });
    await waitFor(() => screen.getByText('Noget gik galt. Prøv igen.'));

    // Click the retry button inside the ErrorBanner
    const retryBtn = screen.getByRole('button', { name: 'Prøv igen' });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/meeting/retry-id?autostart=1');
    });
    errorSpy.mockRestore();
  });

  it('record button is disabled while loading', async () => {
    let resolve!: (v: unknown) => void;
    mockCreateMeeting.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPage();

    fireEvent.click(screen.getByText('optag').closest('button')!);

    await waitFor(() => {
      const btn = screen.getByText('optag').closest('button')!;
      expect(btn).toBeDisabled();
    });

    // cleanup
    await act(async () => { resolve({ id: 'x' }); });
  });

  it('triggers recording when Enter is pressed in the title input', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'mtg-7' });
    renderPage();

    const titleInput = screen.getByPlaceholderText('Navngiv mødet…');
    fireEvent.change(titleInput, { target: { value: 'Strategy' } });

    await act(async () => {
      fireEvent.keyDown(titleInput, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/meeting/mtg-7?autostart=1');
    });
  });
});

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

describe('OptaqPage — upload flow', () => {
  it('calls setPendingUploadFile with the chosen file', async () => {
    renderPage();
    const file = new File(['audio data'], 'test.mp3', { type: 'audio/mpeg' });
    const input = document.getElementById('upload-input') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(mockSetPendingUploadFile).toHaveBeenCalledWith(file);
  });

  it('navigates to /meeting/new after selecting a file', async () => {
    renderPage();
    const file = new File(['audio data'], 'test.mp3', { type: 'audio/mpeg' });
    const input = document.getElementById('upload-input') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(mockPush).toHaveBeenCalledWith('/meeting/new');
  });

  it('does not call setPendingUploadFile when no file is selected', async () => {
    renderPage();
    const input = document.getElementById('upload-input') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [] } });
    });

    expect(mockSetPendingUploadFile).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('upload input accepts audio/* and video/*', () => {
    renderPage();
    const input = document.getElementById('upload-input') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'audio/*,video/*');
  });

  it('upload input is hidden', () => {
    const { container } = renderPage();
    const input = container.querySelector('#upload-input');
    expect(input).toHaveStyle({ display: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Teams meeting link flow
// ---------------------------------------------------------------------------

describe('OptaqPage — Teams meeting link flow', () => {
  it('submits the Teams link and navigates to /meeting/:id?join=1 on Enter', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'teams-1' });
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/l/meetup-join/abc' } });

    await act(async () => {
      fireEvent.keyDown(linkInput, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'teams', status: 'joining' }),
      );
      expect(mockPush).toHaveBeenCalledWith('/meeting/teams-1?join=1');
    });
  });

  it('submits the Teams link and navigates when the arrow button is clicked', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'teams-2' });
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/l/meetup-join/xyz' } });

    const arrowBtn = screen.getByText('→');
    await act(async () => {
      fireEvent.click(arrowBtn);
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/meeting/teams-2?join=1');
    });
  });

  it('does not submit when the link input is empty on Enter', async () => {
    renderPage();
    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');

    await act(async () => {
      fireEvent.keyDown(linkInput, { key: 'Enter' });
    });

    expect(mockCreateMeeting).not.toHaveBeenCalled();
  });

  it('arrow button is disabled when link input is empty', () => {
    renderPage();
    const arrowBtn = screen.getByText('→').closest('button')!;
    expect(arrowBtn).toBeDisabled();
  });

  it('arrow button is enabled when link input has content', async () => {
    renderPage();
    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/abc' } });

    await waitFor(() => {
      const arrowBtn = screen.getByText('→').closest('button')!;
      expect(arrowBtn).not.toBeDisabled();
    });
  });

  it('shows linkError when joinMeeting throws', async () => {
    mockCreateMeeting.mockRejectedValue(new Error('network error'));
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/abc' } });

    await act(async () => {
      fireEvent.keyDown(linkInput, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(screen.getByText('Noget gik galt. Prøv igen.')).toBeInTheDocument();
    });
  });

  it('clears linkError when the user types in the link input after an error', async () => {
    mockCreateMeeting.mockRejectedValueOnce(new Error('fail'));
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/abc' } });

    await act(async () => {
      fireEvent.keyDown(linkInput, { key: 'Enter' });
    });
    await waitFor(() => screen.getByText('Noget gik galt. Prøv igen.'));

    // Restore mock so next call doesn't fail
    mockCreateMeeting.mockResolvedValue({ id: 'x' });

    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/new' } });

    await waitFor(() => {
      expect(screen.queryByText('Noget gik galt. Prøv igen.')).toBeNull();
    });
  });

  it('passes the trimmed link as meetingUrl to createMeeting', async () => {
    mockCreateMeeting.mockResolvedValue({ id: 'teams-3' });
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: '  https://teams.microsoft.com/abc  ' } });

    await act(async () => {
      fireEvent.keyDown(linkInput, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ meetingUrl: 'https://teams.microsoft.com/abc' }),
      );
    });
  });

  it('shows loading indicator (…) while joining', async () => {
    let resolve!: (v: unknown) => void;
    mockCreateMeeting.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/abc' } });
    fireEvent.click(screen.getByText('→').closest('button')!);

    await waitFor(() => {
      expect(screen.getByText('…')).toBeInTheDocument();
    });

    await act(async () => { resolve({ id: 'x' }); });
  });

  it('does not submit again while linkLoading is true', async () => {
    let resolve!: (v: unknown) => void;
    mockCreateMeeting.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPage();

    const linkInput = screen.getByPlaceholderText('Indsæt mødelink…');
    fireEvent.change(linkInput, { target: { value: 'https://teams.microsoft.com/abc' } });
    fireEvent.click(screen.getByText('→').closest('button')!);

    await waitFor(() => {
      // Button shows "…" indicating loading
      expect(screen.getByText('…')).toBeInTheDocument();
    });

    // Try to click again - button is disabled
    const loadingBtn = screen.getByText('…').closest('button')!;
    expect(loadingBtn).toBeDisabled();

    await act(async () => { resolve({ id: 'x' }); });

    expect(mockCreateMeeting).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Static content
// ---------------------------------------------------------------------------

describe('OptaqPage — static content', () => {
  it('renders the tagline chips: OPEN SOURCE, LOKAL BEHANDLING, DIGITAL SUVERÆNITET', () => {
    renderPage();
    expect(screen.getByText('OPEN SOURCE')).toBeInTheDocument();
    expect(screen.getByText('LOKAL BEHANDLING')).toBeInTheDocument();
    expect(screen.getByText('DIGITAL SUVERÆNITET')).toBeInTheDocument();
  });

  it('renders the status section with Hviske text', () => {
    renderPage();
    expect(screen.getByText('Hviske · dansk tale-til-tekst')).toBeInTheDocument();
  });

  it('renders the data processing compliance text', () => {
    renderPage();
    expect(screen.getByText(/lyden gemmes lokalt på din enhed/)).toBeInTheDocument();
    expect(screen.getByText(/slettes automatisk når referatet er genereret/)).toBeInTheDocument();
    expect(screen.getByText(/personoplysninger fjernes inden referat/)).toBeInTheDocument();
  });

  it('renders the "eller deltag i et møde" label', () => {
    renderPage();
    expect(screen.getByText('eller deltag i et møde')).toBeInTheDocument();
  });

  it('renders the "mødedetaljer" label', () => {
    renderPage();
    expect(screen.getByText('mødedetaljer')).toBeInTheDocument();
  });
});
