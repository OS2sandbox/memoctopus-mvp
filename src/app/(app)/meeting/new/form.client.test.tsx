// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock @/lib/storage — createMeeting returns a fake meeting with a given id
const mockCreateMeeting = vi.fn();
vi.mock('@/lib/storage', () => ({
  createMeeting: (...args: unknown[]) => mockCreateMeeting(...args),
}));

// Mock @/lib/pending-upload — takePendingUploadFile returns null by default
const mockTakePendingUploadFile = vi.fn<() => File | null>().mockReturnValue(null);
vi.mock('@/lib/pending-upload', () => ({
  takePendingUploadFile: () => mockTakePendingUploadFile(),
}));

// Mock UploadConfirmScreen so we can assert it receives the file prop
vi.mock('./upload-confirm.client', () => ({
  UploadConfirmScreen: ({ file, onCancel }: { file: File; onCancel: () => void }) => (
    <div data-testid="upload-confirm-screen">
      <span data-testid="upload-confirm-filename">{file.name}</span>
      <button type="button" onClick={onCancel}>
        cancel-upload
      </button>
    </div>
  ),
}));

// Import component AFTER mocks
import NewMeetingPage from './form.client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  return render(<NewMeetingPage />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockCreateMeeting.mockReset();
  mockTakePendingUploadFile.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Initial rendering
// ---------------------------------------------------------------------------

describe('NewMeetingPage — initial rendering', () => {
  it('renders the page heading "Nyt møde"', () => {
    renderPage();
    expect(screen.getByText('Nyt møde')).toBeInTheDocument();
  });

  it('renders the subtitle description text', () => {
    renderPage();
    expect(
      screen.getByText(/Udfyld oplysningerne og vælg om du vil optage nu/),
    ).toBeInTheDocument();
  });

  it('renders the title input field', () => {
    renderPage();
    expect(screen.getByLabelText('Mødets titel')).toBeInTheDocument();
  });

  it('renders the participants input field', () => {
    renderPage();
    // The label contains inline children; query by id instead
    expect(screen.getByPlaceholderText(/Formand, Næstformand/)).toBeInTheDocument();
  });

  it('renders the "Optag nu" mode button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Optag nu/ })).toBeInTheDocument();
  });

  it('renders the "Upload lydfil" mode button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Upload lydfil/ })).toBeInTheDocument();
  });

  it('renders the "Annullér" button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Annullér' })).toBeInTheDocument();
  });

  it('renders the "Start optagelse" submit button in record mode (default)', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Start optagelse' })).toBeInTheDocument();
  });

  it('does not show an error banner initially', () => {
    renderPage();
    expect(screen.queryByText('Noget gik galt')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AUDIO_MODES toggle — description text switches when mode changes
// ---------------------------------------------------------------------------

describe('NewMeetingPage — AUDIO_MODES toggle', () => {
  it('shows "Start optagelse med mikrofon" description in record mode', () => {
    renderPage();
    expect(screen.getByText('Start optagelse med mikrofon')).toBeInTheDocument();
  });

  it('shows "MP3, WAV, M4A, WebM" description in upload mode', () => {
    renderPage();
    expect(screen.getByText('MP3, WAV, M4A, WebM')).toBeInTheDocument();
  });

  it('submit button shows "Upload og transskribér" after switching to upload mode', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));
    expect(screen.getByRole('button', { name: 'Upload og transskribér' })).toBeInTheDocument();
  });

  it('submit button is disabled in upload mode (upload is handled by file picker)', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));
    expect(screen.getByRole('button', { name: 'Upload og transskribér' })).toBeDisabled();
  });

  it('switches back to record mode on second click', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));
    fireEvent.click(screen.getByRole('button', { name: /Optag nu/ }));
    expect(screen.getByRole('button', { name: 'Start optagelse' })).toBeInTheDocument();
  });

  it('shows the audio file input when upload mode is active', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));
    expect(screen.getByLabelText('Lydfil')).toBeInTheDocument();
  });

  it('hides the audio file input in record mode (default)', () => {
    renderPage();
    // No "Lydfil" label in record mode
    expect(screen.queryByLabelText('Lydfil')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zod validation — title field
// ---------------------------------------------------------------------------

describe('NewMeetingPage — Zod validation', () => {
  it('shows Danish error message when title is under 2 chars after submit', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), { target: { value: 'A' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(screen.getByText('Titel skal have mindst 2 tegn')).toBeInTheDocument();
    });
  });

  it('blocks createMeeting when title is under 2 chars', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), { target: { value: 'X' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(screen.getByText('Titel skal have mindst 2 tegn')).toBeInTheDocument();
    });
    expect(mockCreateMeeting).not.toHaveBeenCalled();
  });

  it('shows the error when title is completely empty', async () => {
    renderPage();
    // Leave title empty, attempt submit
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(screen.getByText('Titel skal have mindst 2 tegn')).toBeInTheDocument();
    });
    expect(mockCreateMeeting).not.toHaveBeenCalled();
  });

  it('does not show validation error when title is exactly 2 chars', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-ok' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), { target: { value: 'AB' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalled();
    });
    expect(screen.queryByText('Titel skal have mindst 2 tegn')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Record mode submit — creates meeting and routes to recording page
// ---------------------------------------------------------------------------

describe('NewMeetingPage — Record mode submit', () => {
  it('calls createMeeting with the correct arguments', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-123' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Bestyrelsesmøde' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith({
        title: 'Bestyrelsesmøde',
        participants: undefined,
        source: 'local',
        status: 'recording',
      });
    });
  });

  it('routes to /meeting/:id?autostart=1 after successful meeting creation', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-abc' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Ugentligt møde' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/meeting/mtg-abc?autostart=1');
    });
  });

  it('shows error message when createMeeting throws', async () => {
    mockCreateMeeting.mockRejectedValueOnce(new Error('DB fejl'));
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Fejlmøde' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(screen.getByText('DB fejl')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('calls console.error with context when createMeeting throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('IndexedDB quota exceeded');
    mockCreateMeeting.mockRejectedValueOnce(err);
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Fejlmøde' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[new-meeting] createMeeting failed:',
        err,
      );
    });
    consoleSpy.mockRestore();
  });

  it('shows generic fallback error when thrown value is not an Error instance', async () => {
    mockCreateMeeting.mockRejectedValueOnce('oops');
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Fejlmøde' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
    });
  });

  it('disables submit button while submitting', async () => {
    let resolveCreate!: (v: unknown) => void;
    mockCreateMeeting.mockReturnValueOnce(new Promise((r) => { resolveCreate = r; }));

    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Langsomt møde' },
    });

    fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Opretter...' })).toBeDisabled();
    });

    await act(async () => { resolveCreate({ id: 'mtg-slow' }); });
  });
});

// ---------------------------------------------------------------------------
// Participants parsing — comma-separated string into participant list
// ---------------------------------------------------------------------------

describe('NewMeetingPage — Participants parsing', () => {
  it('passes participants array to createMeeting when comma-separated names are entered', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-p1' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Møde med deltagere' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Formand, Næstformand/), {
      target: { value: 'Alice, Bob, Charlie' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: ['Alice', 'Bob', 'Charlie'],
        }),
      );
    });
  });

  it('trims whitespace from each participant name', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-p2' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Møde' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Formand, Næstformand/), {
      target: { value: '  Alice  ,  Bob  ' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: ['Alice', 'Bob'],
        }),
      );
    });
  });

  it('filters out empty entries from participants', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-p3' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Møde' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Formand, Næstformand/), {
      target: { value: 'Alice,,Bob,' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: ['Alice', 'Bob'],
        }),
      );
    });
  });

  it('passes undefined for participants when participants field is empty', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-p4' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Møde uden deltagere' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: undefined,
        }),
      );
    });
  });

  it('passes undefined for participants when participants field has only spaces/commas', async () => {
    mockCreateMeeting.mockResolvedValueOnce({ id: 'mtg-p5' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Mødets titel'), {
      target: { value: 'Møde' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Formand, Næstformand/), {
      target: { value: '  ,  ,  ' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Mødets titel').closest('form')!);
    });
    await waitFor(() => {
      expect(mockCreateMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: undefined,
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Upload mode — renders UploadConfirmScreen when a pending file is present
// ---------------------------------------------------------------------------

describe('NewMeetingPage — UploadConfirmScreen via takePendingUploadFile', () => {
  it('renders UploadConfirmScreen instead of the form when a pending file exists', () => {
    const fakeFile = new File(['hello'], 'meeting.mp3', { type: 'audio/mpeg' });
    mockTakePendingUploadFile.mockReturnValue(fakeFile);

    renderPage();
    expect(screen.getByTestId('upload-confirm-screen')).toBeInTheDocument();
    expect(screen.queryByText('Nyt møde')).toBeNull();
  });

  it('passes the pending file to UploadConfirmScreen', () => {
    const fakeFile = new File(['data'], 'audio.wav', { type: 'audio/wav' });
    mockTakePendingUploadFile.mockReturnValue(fakeFile);

    renderPage();
    expect(screen.getByTestId('upload-confirm-filename')).toHaveTextContent('audio.wav');
  });

  it('navigates to /dashboard when UploadConfirmScreen onCancel is called', () => {
    const fakeFile = new File(['x'], 'clip.m4a', { type: 'audio/m4a' });
    mockTakePendingUploadFile.mockReturnValue(fakeFile);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-upload' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('returns to the form after onCancel is called (uploadFile set to null)', () => {
    const fakeFile = new File(['y'], 'sound.webm', { type: 'audio/webm' });
    mockTakePendingUploadFile.mockReturnValue(fakeFile);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-upload' }));
    // After cancelling, the upload confirm screen should be gone and form shown
    expect(screen.queryByTestId('upload-confirm-screen')).toBeNull();
    expect(screen.getByText('Nyt møde')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Upload mode — file picker in form switches to UploadConfirmScreen
// ---------------------------------------------------------------------------

describe('NewMeetingPage — file picker in upload mode', () => {
  it('renders UploadConfirmScreen when a file is selected via the file input', async () => {
    renderPage();
    // Switch to upload mode
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));

    const fileInput = screen.getByLabelText('Lydfil');
    const testFile = new File(['audio data'], 'selected.mp3', { type: 'audio/mpeg' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('upload-confirm-screen')).toBeInTheDocument();
    });
  });

  it('passes the selected file to UploadConfirmScreen', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Upload lydfil/ }));

    const fileInput = screen.getByLabelText('Lydfil');
    const testFile = new File(['x'], 'track.wav', { type: 'audio/wav' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('upload-confirm-filename')).toHaveTextContent('track.wav');
    });
  });
});

// ---------------------------------------------------------------------------
// Annullér button — navigates to /dashboard
// ---------------------------------------------------------------------------

describe('NewMeetingPage — Annullér button', () => {
  it('navigates to /dashboard when Annullér is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });
});
