// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within, cleanup, render as rtlRender } from '@testing-library/react';
import { TopBar } from './TopBar';
import { renderWithOnboarding } from '@/test/onboarding';
import { OnboardingProvider } from '@/lib/onboarding/context';
import { getStep } from '@/lib/onboarding/steps';
import { WelcomeTour } from '@/components/onboarding/WelcomeTour';

// Onboarding hints wrap the Arkiv nav link and, on a review page with unsaved
// audio, the nav links themselves; mark them already-seen (for every meeting
// id this suite's mockPathname uses) so the popovers don't render and DOM
// queries keep targeting the underlying nav links/dialog (mirrors the real
// app, which mounts TopBar under the app-level OnboardingProvider).
function render(ui: React.ReactElement) {
  return renderWithOnboarding(ui, {
    tourSkipped: true,
    tourCompleted: true,
    seen: [
      { stepId: 'topbar.arkiv-explainer', meetingId: null },
      { stepId: 'topbar.unsaved-audio', meetingId: 'abc-123' },
      { stepId: 'topbar.unsaved-audio', meetingId: 'abc' },
      { stepId: 'topbar.unsaved-audio', meetingId: 'meeting-id-42' },
    ],
  });
}

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
let mockPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

// next/link renders a plain <a> in jsdom
vi.mock('next/link', () => ({
  default: ({ href, onClick, children, style }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) => (
    <a href={href} onClick={onClick} style={style as React.CSSProperties}>
      {children}
    </a>
  ),
}));

const mockSignOut = vi.fn();
let mockSessionData: { data: { user: { email: string; id: string } } | null } = { data: null };

vi.mock('@/lib/auth-client', () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
  useSession: () => mockSessionData,
}));

let mockHasAudio = false;

vi.mock('@/lib/review-audio-context', () => ({
  useReviewAudio: () => ({ hasAudio: mockHasAudio }),
}));

// Mock DeleteAudioDialog so we can control what it renders and inspect props
const mockDeleteAudioDialogOnDeleted = vi.fn();
const mockDeleteAudioDialogOnOpenChange = vi.fn();

vi.mock('@/components/meeting/DeleteAudioDialog', () => ({
  DeleteAudioDialog: ({
    open,
    onOpenChange,
    meetingId,
    title,
    confirmLabel,
    onDeleted,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    meetingId: string;
    title: string;
    confirmLabel: string;
    onDeleted: () => void;
  }) => {
    // Store callbacks so tests can invoke them
    mockDeleteAudioDialogOnDeleted.mockImplementation(onDeleted);
    mockDeleteAudioDialogOnOpenChange.mockImplementation(onOpenChange);
    if (!open) return null;
    return (
      <div data-testid="delete-audio-dialog" data-meeting-id={meetingId} data-title={title} data-confirm-label={confirmLabel}>
        <button onClick={() => onDeleted()}>confirm-delete</button>
        <button onClick={() => onOpenChange(false)}>cancel-dialog</button>
      </div>
    );
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function renderTopBar() {
  return render(<TopBar />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockSignOut.mockReset().mockResolvedValue(undefined);
  mockSessionData = { data: null };
  mockHasAudio = false;
  mockPathname = '/dashboard';
  mockDeleteAudioDialogOnDeleted.mockReset();
  mockDeleteAudioDialogOnOpenChange.mockReset();
});

// ── Rendering ──────────────────────────────────────────────────────────────

describe('TopBar — basic rendering', () => {
  it('renders the wordmark', () => {
    renderTopBar();
    // The wordmark is the official SVG lockup on its own — no type beside it —
    // so it reaches the accessible name through the image's alt text.
    const wordmarkLink = screen.getByRole('link', { name: /OS2taletiltekst/ });
    expect(wordmarkLink).toBeInTheDocument();
    expect(wordmarkLink.textContent).toBe('');

    const logo = within(wordmarkLink).getByAltText('OS2taletiltekst');
    expect(logo).toHaveAttribute('src', '/brand/os2taletiltekst.svg');
  });

  it('renders both nav items', () => {
    renderTopBar();
    expect(screen.getByRole('link', { name: 'Optag' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arkiv' })).toBeInTheDocument();
  });

  it('does not render user info when there is no session', () => {
    mockSessionData = { data: null };
    renderTopBar();
    expect(screen.queryByRole('button', { name: 'log ud' })).toBeNull();
  });

  it('renders the sign-out button when a session is present', () => {
    mockSessionData = { data: { user: { email: 'alice@example.com', id: 'u1' } } };
    renderTopBar();
    expect(screen.getByRole('button', { name: 'log ud' })).toBeInTheDocument();
  });

  it('renders the user email when a session is present (desktop default)', () => {
    mockSessionData = { data: { user: { email: 'alice@example.com', id: 'u1' } } };
    renderTopBar();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('renders a sticky header element', () => {
    renderTopBar();
    const header = screen.getByRole('banner');
    expect(header).toBeInTheDocument();
  });
});

// ── isActive — nav highlight ───────────────────────────────────────────────

describe('TopBar — isActive nav highlight', () => {
  it('Optag link is highlighted on exact /dashboard match', () => {
    mockPathname = '/dashboard';
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    expect(optagLink).toHaveStyle({ fontWeight: 500 });
  });

  it('Optag link is NOT highlighted for /dashboard/sub (exact match only)', () => {
    mockPathname = '/dashboard/sub';
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    expect(optagLink).toHaveStyle({ fontWeight: 400 });
  });

  it('Optag link is NOT highlighted when on /arkiv', () => {
    mockPathname = '/arkiv';
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    expect(optagLink).toHaveStyle({ fontWeight: 400 });
  });

  it('Arkiv link is highlighted when pathname starts with /arkiv', () => {
    mockPathname = '/arkiv';
    renderTopBar();
    const arkivLink = screen.getByRole('link', { name: 'Arkiv' });
    expect(arkivLink).toHaveStyle({ fontWeight: 500 });
  });

  it('Arkiv link is highlighted for /arkiv/some-sub-path (prefix match)', () => {
    mockPathname = '/arkiv/some-sub-path';
    renderTopBar();
    const arkivLink = screen.getByRole('link', { name: 'Arkiv' });
    expect(arkivLink).toHaveStyle({ fontWeight: 500 });
  });

  it('Arkiv link is NOT highlighted on /dashboard', () => {
    mockPathname = '/dashboard';
    renderTopBar();
    const arkivLink = screen.getByRole('link', { name: 'Arkiv' });
    expect(arkivLink).toHaveStyle({ fontWeight: 400 });
  });

  it('active link uses var(--ink) color', () => {
    mockPathname = '/dashboard';
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    expect(optagLink).toHaveStyle({ color: 'var(--ink)' });
  });

  it('inactive link uses var(--muted) color', () => {
    mockPathname = '/arkiv';
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    expect(optagLink).toHaveStyle({ color: 'var(--muted)' });
  });
});

// ── reviewMeetingId extraction ─────────────────────────────────────────────

describe('TopBar — reviewMeetingId extraction', () => {
  it('extracts the meeting id on /meeting/:id/review', () => {
    mockPathname = '/meeting/abc-123/review';
    mockHasAudio = true;
    renderTopBar();
    // DeleteAudioDialog is rendered when reviewMeetingId is set and hasAudio is true
    const dialog = screen.queryByTestId('delete-audio-dialog');
    // Dialog is not visible yet (showConfirm=false), but clicking a nav item should open it
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    fireEvent.click(optagLink);
    expect(screen.getByTestId('delete-audio-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('delete-audio-dialog')).toHaveAttribute('data-meeting-id', 'abc-123');
  });

  it('does NOT set reviewMeetingId for /meeting/:id (no /review suffix)', () => {
    mockPathname = '/meeting/abc-123';
    mockHasAudio = true;
    renderTopBar();
    // Even with hasAudio, no dialog should render on nav click when not in review
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    fireEvent.click(optagLink);
    expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('does NOT set reviewMeetingId for /meeting/:id/review/extra (too many segments)', () => {
    mockPathname = '/meeting/abc-123/review/extra';
    mockHasAudio = true;
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    fireEvent.click(optagLink);
    expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('does NOT set reviewMeetingId on /arkiv', () => {
    mockPathname = '/arkiv';
    mockHasAudio = true;
    renderTopBar();
    const optagLink = screen.getByRole('link', { name: 'Optag' });
    fireEvent.click(optagLink);
    expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });
});

// ── Navigation without pending audio ──────────────────────────────────────

describe('TopBar — navigation without pending audio', () => {
  it('calls router.push when no audio is pending', () => {
    mockPathname = '/dashboard';
    mockHasAudio = false;
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Arkiv' }));
    expect(mockPush).toHaveBeenCalledWith('/arkiv');
  });

  it('does NOT open the dialog when hasAudio is false', () => {
    mockPathname = '/meeting/abc/review';
    mockHasAudio = false;
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('navigates immediately on wordmark click without audio', () => {
    mockPathname = '/arkiv';
    mockHasAudio = false;
    renderTopBar();
    const wordmarkLink = screen.getByRole('link', { name: /OS2taletiltekst/ });
    fireEvent.click(wordmarkLink);
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });
});

// ── Leave review WITH audio — prompts DeleteAudioDialog ───────────────────

describe('TopBar — leaving review with audio prompts DeleteAudioDialog', () => {
  function setupReview() {
    mockPathname = '/meeting/meeting-id-42/review';
    mockHasAudio = true;
  }

  it('opens the dialog instead of navigating when hasAudio=true on review page', () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.getByTestId('delete-audio-dialog')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('passes the correct meetingId to the dialog', () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.getByTestId('delete-audio-dialog')).toHaveAttribute('data-meeting-id', 'meeting-id-42');
  });

  it('passes the correct title to the dialog', () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.getByTestId('delete-audio-dialog')).toHaveAttribute('data-title', 'Slet lydfil og forlad mødet?');
  });

  it('passes the correct confirmLabel to the dialog', () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.getByTestId('delete-audio-dialog')).toHaveAttribute('data-confirm-label', 'Slet og forlad');
  });

  it('navigates to the pending href after onDeleted is called', async () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Arkiv' }));
    // Click confirm inside the mock dialog
    await act(async () => {
      fireEvent.click(screen.getByText('confirm-delete'));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/arkiv');
    });
  });

  it('navigates to /dashboard as fallback when pendingHref is null and onDeleted fires', async () => {
    // This tests the `pendingHref ?? '/dashboard'` fallback.
    // The dialog renders (open=false) initially — we invoke onDeleted directly.
    setupReview();
    renderTopBar();
    // Render without clicking nav so showConfirm stays false, but dialog is mounted.
    // We invoke onDeleted via the stored mock to simulate external call.
    await act(async () => {
      mockDeleteAudioDialogOnDeleted();
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('closes dialog and clears pendingHref when onOpenChange(false) is called', async () => {
    setupReview();
    renderTopBar();
    fireEvent.click(screen.getByRole('link', { name: 'Optag' }));
    expect(screen.getByTestId('delete-audio-dialog')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('cancel-dialog'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
    });
  });

  it('does not render the dialog at all when hasAudio is false on a review page', () => {
    mockPathname = '/meeting/meeting-id-42/review';
    mockHasAudio = false;
    renderTopBar();
    // Dialog component is not mounted at all since condition is reviewMeetingId && hasAudio
    expect(screen.queryByTestId('delete-audio-dialog')).toBeNull();
  });
});

// ── Sign-out ───────────────────────────────────────────────────────────────

describe('TopBar — sign-out action', () => {
  beforeEach(() => {
    mockSessionData = { data: { user: { email: 'bob@example.com', id: 'u2' } } };
  });

  it('calls signOut when the "log ud" button is clicked', async () => {
    mockSignOut.mockResolvedValue(undefined);
    renderTopBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log ud' }));
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('redirects to / after sign-out', async () => {
    mockSignOut.mockResolvedValue(undefined);
    renderTopBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log ud' }));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/');
    });
  });

  it('renders session user email in the toolbar', () => {
    renderTopBar();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('renders user info area with sign-out button', () => {
    renderTopBar();
    const btn = screen.getByRole('button', { name: 'log ud' });
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('still redirects to / when signOut rejects (network failure)', async () => {
    mockSignOut.mockRejectedValue(new Error('network error'));
    renderTopBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log ud' }));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/');
    });
  });

  it('logs an error when signOut rejects', async () => {
    const networkErr = new Error('network error');
    mockSignOut.mockRejectedValue(networkErr);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTopBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log ud' }));
    });
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('signOut failed', networkErr);
    });
    consoleErrorSpy.mockRestore();
  });
});

// ── Wordmark link ──────────────────────────────────────────────────────────

describe('TopBar — wordmark link', () => {
  it('wordmark link points to /dashboard', () => {
    renderTopBar();
    const link = screen.getByRole('link', { name: /OS2taletiltekst/ });
    expect(link).toHaveAttribute('href', '/dashboard');
  });
});

// ── Onboarding ─────────────────────────────────────────────────────────────

describe('TopBar — onboarding', () => {
  const EXPLAINER = 'topbar.arkiv-explainer';
  const UNSAVED = 'topbar.unsaved-audio';
  const copyOf = (id: string) => getStep(id).copy.replace(/\s+/g, ' ');
  const fetchMock = vi.fn();
  const savedStepIds = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).stepId);

  // Every hint unseen, welcome dialog already dealt with.
  const noneSeen = { tourSkipped: true, tourCompleted: true, seen: [] };
  const withProvider = (ui: React.ReactElement) => (
    <OnboardingProvider initial={noneSeen}>{ui}</OnboardingProvider>
  );

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    // Radix Popper measures its content with ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('"?" opens the welcome dialog', () => {
    mockSessionData = { data: { user: { email: 'alice@example.com', id: 'u1' } } };
    rtlRender(
      withProvider(
        <>
          <TopBar />
          <WelcomeTour />
        </>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Se en hurtig gennemgang af OS2taletiltekst' }));

    expect(screen.getByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeInTheDocument();
  });

  it('shows the Arkiv explainer away from a review page', () => {
    rtlRender(withProvider(<TopBar />));
    expect(screen.getByText(copyOf(EXPLAINER))).toBeInTheDocument();
  });

  // The review page's audio loads from IndexedDB a moment after the first render.
  // The explainer used to open in that moment, get swapped for the unsaved-audio
  // warning in the same bubble, and be saved as seen without having been read.
  it('never opens the Arkiv explainer on a review page, so the audio warning cannot use it up', () => {
    mockPathname = '/meeting/abc/review';
    mockHasAudio = false;
    const { rerender, unmount } = rtlRender(withProvider(<TopBar />));
    expect(screen.queryByText(copyOf(EXPLAINER))).toBeNull();

    mockHasAudio = true;
    rerender(withProvider(<TopBar />));
    expect(screen.getByText(copyOf(UNSAVED))).toBeInTheDocument();

    unmount();
    expect(savedStepIds()).toEqual([UNSAVED]);
  });
});
