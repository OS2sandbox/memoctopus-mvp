// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ExportTab } from './ExportTab';

// ─── Mock next/link (used for "tilbage til referat" and "nyt møde →") ──────────
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// ─── Mock @/lib/use-is-mobile ─────────────────────────────────────────────────
const mockUseIsMobile = vi.fn<() => boolean>().mockReturnValue(false);
vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

// ─── Mock @/lib/storage ───────────────────────────────────────────────────────
const mockGetMeeting = vi.fn();
const mockGetMinutes = vi.fn();
vi.mock('@/lib/storage', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  getMinutes: (...args: unknown[]) => mockGetMinutes(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MEETING_ID = 'mtg-abc';

function renderTab() {
  return render(<ExportTab meetingId={MEETING_ID} />);
}

function makeMeeting(overrides = {}) {
  return { id: MEETING_ID, title: 'Test møde', ...overrides };
}

function makeMinutes(overrides = {}) {
  return {
    id: 'min-1',
    meetingId: MEETING_ID,
    content: { sections: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseIsMobile.mockReturnValue(false);
  mockGetMeeting.mockResolvedValue(makeMeeting());
  mockGetMinutes.mockResolvedValue(makeMinutes());

  // Default fetch: success returning a blob
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(['pdf-bytes'], { type: 'application/pdf' })),
    json: () => Promise.resolve({}),
  });

  // Stub URL methods so the DOM click doesn't blow up
  global.URL.createObjectURL = vi.fn().mockReturnValue('blob:fake-url');
  global.URL.revokeObjectURL = vi.fn();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — initial render', () => {
  it('renders the section header "04 · eksport"', () => {
    renderTab();
    expect(screen.getByText('04 · eksport')).toBeInTheDocument();
  });

  it('renders the headline', () => {
    renderTab();
    expect(screen.getByText(/Klar til/)).toBeInTheDocument();
    expect(screen.getByText('aflevering')).toBeInTheDocument();
  });

  it('renders both format radio buttons', () => {
    renderTab();
    expect(screen.getByRole('radio', { name: /PDF/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Markdown/ })).toBeInTheDocument();
  });

  it('PDF is selected by default (aria-checked=true)', () => {
    renderTab();
    expect(screen.getByRole('radio', { name: /PDF/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Markdown/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows PDF file name in the download button by default', () => {
    renderTab();
    expect(screen.getByRole('button', { name: /download referat\.pdf/ })).toBeInTheDocument();
  });

  it('shows the compliance note', () => {
    renderTab();
    expect(screen.getByText('indeholder ingen rå tale, lyd eller personoplysninger')).toBeInTheDocument();
  });

  it('renders the "tilbage til referat" link pointing at /meeting/:id/review', () => {
    renderTab();
    const link = screen.getByRole('link', { name: /tilbage til referat/ });
    expect(link).toHaveAttribute('href', `/meeting/${MEETING_ID}/review`);
  });

  it('does not show an error banner initially', () => {
    renderTab();
    expect(screen.queryByText(/Ingen referat fundet/)).toBeNull();
  });

  it('does not show the post-download confirmation initially', () => {
    renderTab();
    expect(screen.queryByText(/downloadet/)).toBeNull();
    expect(screen.queryByText(/nyt møde/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — format selection', () => {
  it('clicking Markdown selects it (aria-checked=true)', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown/ }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Markdown/ })).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('clicking Markdown deselects PDF', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown/ }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /PDF/ })).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('clicking Markdown updates the download button to show referat.md', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download referat\.md/ })).toBeInTheDocument();
    });
  });

  it('shows referat.pdf filename in the format card for PDF', () => {
    renderTab();
    expect(screen.getByText('referat.pdf')).toBeInTheDocument();
  });

  it('shows referat.md filename in the format card for Markdown', () => {
    renderTab();
    expect(screen.getByText('referat.md')).toBeInTheDocument();
  });

  it('shows PDF meta info "2 sider · A4"', () => {
    renderTab();
    expect(screen.getByText('2 sider · A4')).toBeInTheDocument();
  });

  it('shows Markdown meta info "~3 KB · UTF-8"', () => {
    renderTab();
    expect(screen.getByText('~3 KB · UTF-8')).toBeInTheDocument();
  });

  it('shows PDF description text', () => {
    renderTab();
    expect(screen.getByText('Til arkivering og distribution. Kan ikke redigeres.')).toBeInTheDocument();
  });

  it('shows Markdown description text', () => {
    renderTab();
    expect(screen.getByText('Ren tekst — egnet til Notion, Obsidian og andre.')).toBeInTheDocument();
  });

  it('can switch back from Markdown to PDF', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown/ }));
    await waitFor(() => screen.getByRole('button', { name: /download referat\.md/ }));

    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download referat\.pdf/ })).toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — export with missing minutes', () => {
  it('shows "Ingen referat fundet" error when getMinutes returns null', async () => {
    mockGetMinutes.mockResolvedValueOnce(null);

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ingen referat fundet')).toBeInTheDocument();
    });
  });

  it('does not call fetch when minutes are missing', async () => {
    mockGetMinutes.mockResolvedValueOnce(null);

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => screen.getByText('Ingen referat fundet'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not set downloaded state when minutes are missing', async () => {
    mockGetMinutes.mockResolvedValueOnce(null);

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => screen.getByText('Ingen referat fundet'));
    expect(screen.queryByText(/downloadet/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — successful export', () => {
  it('POSTs to /api/export/:id', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/export/${MEETING_ID}`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('sends the correct JSON body with format=pdf by default', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            title: 'Test møde',
            content: { sections: [] },
            format: 'pdf',
          }),
        }),
      );
    });
  });

  it('sends format=md when Markdown is selected', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.md/ }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            title: 'Test møde',
            content: { sections: [] },
            format: 'md',
          }),
        }),
      );
    });
  });

  it('falls back to title "Referat" when meeting has no title', async () => {
    mockGetMeeting.mockResolvedValueOnce(null);

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Referat');
    });
  });

  it('sets downloaded state after a successful export', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText(/referat\.pdf downloadet/)).toBeInTheDocument();
    });
  });

  it('shows the "nyt møde →" link after a successful export', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /nyt møde/ })).toHaveAttribute('href', '/dashboard');
    });
  });

  it('creates a download anchor and calls click on it', async () => {
    const mockAnchorClick = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(mockAnchorClick);
      }
      return el;
    });

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(mockAnchorClick).toHaveBeenCalled();
    });

    vi.restoreAllMocks();
  });

  it('calls URL.createObjectURL and URL.revokeObjectURL', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(global.URL.createObjectURL).toHaveBeenCalled();
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    });
  });

  it('does not show an error banner on successful export', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => screen.getByText(/referat\.pdf downloadet/));
    expect(screen.queryByText(/Eksport fejlede/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — failed fetch', () => {
  it('shows the server error message when fetch returns !ok with JSON error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Server fejl ved eksport' }),
    });

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('Server fejl ved eksport')).toBeInTheDocument();
    });
  });

  it('shows "Eksport fejlede" when fetch returns !ok with no error field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('Eksport fejlede')).toBeInTheDocument();
    });
  });

  it('shows "Noget gik galt" when fetch throws a non-Error', async () => {
    global.fetch = vi.fn().mockRejectedValue('network gone');

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
    });
  });

  it('shows a custom error message when fetch throws an Error instance', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });

  it('does not set downloaded state when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'oops' }),
    });

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => screen.getByText('oops'));
    expect(screen.queryByText(/downloadet/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — loading (exporting) state', () => {
  it('shows "genererer…" on the button while export is in progress', async () => {
    let resolveBlob!: (b: Blob) => void;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => new Promise<Blob>((r) => { resolveBlob = r; }),
      json: () => Promise.resolve({}),
    });

    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'genererer…' })).toBeDisabled();
    });

    await act(async () => {
      resolveBlob(new Blob(['bytes']));
    });
  });

  it('re-enables the download button after export completes', async () => {
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });

    await waitFor(() => {
      // Button label reverts to download once finished
      expect(screen.queryByRole('button', { name: 'genererer…' })).toBeNull();
    });
  });

  it('clears a previous error on a new export attempt', async () => {
    // First export fails
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'first error' }),
    });

    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });
    await waitFor(() => screen.getByText('first error'));

    // Second export succeeds
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['bytes'])),
      json: () => Promise.resolve({}),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download referat\.pdf/ }));
    });
    await waitFor(() => screen.getByText(/referat\.pdf downloadet/));

    expect(screen.queryByText('first error')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — mobile layout branch', () => {
  it('renders with mobile padding when useIsMobile returns true', () => {
    mockUseIsMobile.mockReturnValue(true);
    const { container } = renderTab();
    const root = container.firstChild as HTMLElement;
    expect(root.style.padding).toBe('40px 20px');
  });

  it('renders with desktop padding when useIsMobile returns false', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { container } = renderTab();
    const root = container.firstChild as HTMLElement;
    expect(root.style.padding).toBe('64px 32px');
  });

  it('uses smaller font size for headline on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    renderTab();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.style.fontSize).toBe('32px');
  });

  it('uses larger font size for headline on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    renderTab();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.style.fontSize).toBe('42px');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ExportTab — radiogroup accessibility', () => {
  it('the format section has role="radiogroup" with an accessible label', () => {
    renderTab();
    const group = screen.getByRole('radiogroup', { name: 'Eksportformat' });
    expect(group).toBeInTheDocument();
  });

  it('each format button has role="radio"', () => {
    renderTab();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
  });
});
