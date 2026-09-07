// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkabelonerList } from './SkabelonerList';
import type { Skabelon } from '@/types';

// ---------------------------------------------------------------------------
// Mock SkabelonEditor — it's a complex dialog; we only care that SkabelonerList
// opens it with the right props and calls onSaved when the editor fires it.
// ---------------------------------------------------------------------------
const mockEditorOnSaved = vi.fn<(s: Skabelon) => void>();
const mockEditorOnOpenChange = vi.fn<(o: boolean) => void>();

vi.mock('./SkabelonEditor', () => ({
  SkabelonEditor: ({
    open,
    onOpenChange,
    skabelon,
    onSaved,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    skabelon: Skabelon | null;
    onSaved: (s: Skabelon) => void;
  }) => {
    // Keep refs accessible for assertions.
    mockEditorOnSaved.mockImplementation(onSaved);
    mockEditorOnOpenChange.mockImplementation(onOpenChange);
    if (!open) return null;
    return (
      <div data-testid="skabelon-editor" data-editing-id={skabelon?.id ?? 'new'}>
        <button
          onClick={() => {
            const saved: Skabelon = skabelon ?? {
              id: 'new-id',
              name: 'Ny skabelon',
              description: '',
              prompt: '',
              includeDeltagere: false,
              includeBeslutningspunkter: false,
              includeDagsorden: false,
              includeDato: false,
              isDefault: false,
              createdAt: '',
              updatedAt: '',
            };
            onSaved(saved);
            onOpenChange(false);
          }}
        >
          Gem (mock)
        </button>
        <button onClick={() => onOpenChange(false)}>Luk editor</button>
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Mock encodeSkabelonCode so we get a predictable code value in tests.
// ---------------------------------------------------------------------------
vi.mock('@/lib/skabeloner/share-code', () => ({
  encodeSkabelonCode: (s: Skabelon) => `MOCK_CODE_${s.id}`,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSkabelon(overrides: Partial<Skabelon> = {}): Skabelon {
  return {
    id: 'skel-1',
    name: 'Test skabelon',
    description: 'En beskrivelse',
    prompt: 'Skriv et referat',
    includeDeltagere: false,
    includeBeslutningspunkter: false,
    includeDagsorden: false,
    includeDato: false,
    isDefault: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// Default fetch mock: empty template list and default share-config.
function setupFetch(
  skabeloner: Skabelon[] = [],
  shareConfig = { code: true, link: false },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/skabeloner' && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ skabeloner }),
        } as Response);
      }
      if (typeof url === 'string' && url === '/api/skabeloner/share-config') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ share: shareConfig }),
        } as Response);
      }
      // DELETE
      if (typeof url === 'string' && url.startsWith('/api/skabeloner/') && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true } as Response);
      }
      // POST default
      if (typeof url === 'string' && url.includes('/default') && init?.method === 'POST') {
        return Promise.resolve({ ok: true } as Response);
      }
      // POST share
      if (typeof url === 'string' && url.includes('/share') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: 'abc123' }),
        } as Response);
      }
      return Promise.resolve({ ok: false } as Response);
    }),
  );
}

beforeEach(() => {
  mockEditorOnSaved.mockReset();
  mockEditorOnOpenChange.mockReset();
  // Stub window.confirm to return true by default
  vi.stubGlobal('confirm', vi.fn(() => true));
  // Stub clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkabelonerList — initial loading state', () => {
  it('shows skeleton placeholders while loading', async () => {
    // Never resolves during the test — stays in loading state
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    render(<SkabelonerList />);

    // The pulsing skeleton divs are rendered (2 of them)
    const pulses = document.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThanOrEqual(1);
  });

  it('removes loading state and shows empty state when no templates returned', async () => {
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Ingen skabeloner endnu.')).toBeInTheDocument();
    });
  });

  it('renders the header description text', async () => {
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(
        screen.getByText(/Skabeloner er genbrugelige prompts/),
      ).toBeInTheDocument();
    });
  });

  it('renders the "+ Ny skabelon" button', async () => {
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ Ny skabelon' })).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — renders template list', () => {
  it('renders template name and description after loading', async () => {
    const s = makeSkabelon({ name: 'Bestyrelsesmøde', description: 'Til bestyrelsen' });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Bestyrelsesmøde')).toBeInTheDocument();
      expect(screen.getByText('Til bestyrelsen')).toBeInTheDocument();
    });
  });

  it('shows "Ingen beskrivelse" when description is empty', async () => {
    const s = makeSkabelon({ description: '' });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Ingen beskrivelse')).toBeInTheDocument();
    });
  });

  it('renders multiple templates', async () => {
    const s1 = makeSkabelon({ id: 'a', name: 'Skabelon A' });
    const s2 = makeSkabelon({ id: 'b', name: 'Skabelon B' });
    setupFetch([s1, s2]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Skabelon A')).toBeInTheDocument();
      expect(screen.getByText('Skabelon B')).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — category labels', () => {
  it('renders Deltagere label when includeDeltagere is true', async () => {
    const s = makeSkabelon({ includeDeltagere: true });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Deltagere')).toBeInTheDocument();
    });
  });

  it('renders Beslutningspunkter label when includeBeslutningspunkter is true', async () => {
    const s = makeSkabelon({ includeBeslutningspunkter: true });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Beslutningspunkter')).toBeInTheDocument();
    });
  });

  it('renders Dagsorden label when includeDagsorden is true', async () => {
    const s = makeSkabelon({ includeDagsorden: true });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Dagsorden')).toBeInTheDocument();
    });
  });

  it('renders Dato label when includeDato is true', async () => {
    const s = makeSkabelon({ includeDato: true });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Dato')).toBeInTheDocument();
    });
  });

  it('renders all four category labels when all flags are true', async () => {
    const s = makeSkabelon({
      includeDeltagere: true,
      includeBeslutningspunkter: true,
      includeDagsorden: true,
      includeDato: true,
    });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Deltagere')).toBeInTheDocument();
      expect(screen.getByText('Beslutningspunkter')).toBeInTheDocument();
      expect(screen.getByText('Dagsorden')).toBeInTheDocument();
      expect(screen.getByText('Dato')).toBeInTheDocument();
    });
  });

  it('renders no category labels when all flags are false', async () => {
    const s = makeSkabelon({
      includeDeltagere: false,
      includeBeslutningspunkter: false,
      includeDagsorden: false,
      includeDato: false,
    });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.queryByText('Deltagere')).not.toBeInTheDocument();
      expect(screen.queryByText('Beslutningspunkter')).not.toBeInTheDocument();
      expect(screen.queryByText('Dagsorden')).not.toBeInTheDocument();
      expect(screen.queryByText('Dato')).not.toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — open editor for create', () => {
  it('opens the SkabelonEditor when "+ Ny skabelon" is clicked', async () => {
    const user = userEvent.setup();
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: '+ Ny skabelon' }));
    await user.click(screen.getByRole('button', { name: '+ Ny skabelon' }));

    expect(screen.getByTestId('skabelon-editor')).toBeInTheDocument();
    expect(screen.getByTestId('skabelon-editor')).toHaveAttribute('data-editing-id', 'new');
  });

  it('opens SkabelonEditor from empty-state "+ Opret din første skabelon" button', async () => {
    const user = userEvent.setup();
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: '+ Opret din første skabelon' }));
    await user.click(screen.getByRole('button', { name: '+ Opret din første skabelon' }));

    expect(screen.getByTestId('skabelon-editor')).toBeInTheDocument();
  });

  it('adds newly created template to the list after onSaved', async () => {
    const user = userEvent.setup();
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: '+ Ny skabelon' }));
    await user.click(screen.getByRole('button', { name: '+ Ny skabelon' }));
    await user.click(screen.getByRole('button', { name: 'Gem (mock)' }));

    await waitFor(() => {
      expect(screen.getByText('Ny skabelon')).toBeInTheDocument();
    });
  });

  it('closes the editor after saving', async () => {
    const user = userEvent.setup();
    setupFetch([]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: '+ Ny skabelon' }));
    await user.click(screen.getByRole('button', { name: '+ Ny skabelon' }));
    await user.click(screen.getByRole('button', { name: 'Gem (mock)' }));

    await waitFor(() => {
      expect(screen.queryByTestId('skabelon-editor')).not.toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — open editor for edit', () => {
  it('opens the SkabelonEditor with the correct skabelon when "Rediger" is clicked', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'edit-me', name: 'Original' });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByText('Original'));
    await user.click(screen.getByRole('button', { name: 'Rediger' }));

    expect(screen.getByTestId('skabelon-editor')).toHaveAttribute('data-editing-id', 'edit-me');
  });

  it('updates the template in the list after editing and saving', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'edit-me', name: 'Original' });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByText('Original'));
    await user.click(screen.getByRole('button', { name: 'Rediger' }));

    // Trigger onSaved with an updated version of the same template
    await act(async () => {
      mockEditorOnSaved({ ...s, name: 'Updated name' });
    });

    await waitFor(() => {
      expect(screen.getByText('Updated name')).toBeInTheDocument();
      expect(screen.queryByText('Original')).not.toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — delete flow', () => {
  it('shows confirm dialog before deleting', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ name: 'Slet mig' });
    setupFetch([s]);
    const confirmMock = vi.fn(() => false); // cancel
    vi.stubGlobal('confirm', confirmMock);

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Slet mig'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    expect(confirmMock).toHaveBeenCalledWith('Slet skabelonen "Slet mig"?');
  });

  it('does not delete the template when confirm is cancelled', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ name: 'Bevar mig' });
    setupFetch([s]);
    vi.stubGlobal('confirm', vi.fn(() => false));

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Bevar mig'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    // Template still present
    expect(screen.getByText('Bevar mig')).toBeInTheDocument();
  });

  it('removes the template from the list after confirmed delete', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'del-1', name: 'Fjern mig' });
    setupFetch([s]);
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Fjern mig'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => {
      expect(screen.queryByText('Fjern mig')).not.toBeInTheDocument();
    });
  });

  it('calls DELETE /api/skabeloner/:id on confirmed delete', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'del-id-99', name: 'Del target' });
    setupFetch([s]);
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Del target'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const deleteCalls = fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/skabeloner/del-id-99' && (init as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  it('does not remove template from list if DELETE response is not ok', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'fail-del', name: 'Bevar ved fejl' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [s] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: true, link: false } }),
          } as Response);
        }
        if (url === '/api/skabeloner/fail-del' && init?.method === 'DELETE') {
          return Promise.resolve({ ok: false } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Bevar ved fejl'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    // Template should still be in the list because DELETE failed
    await waitFor(() => {
      expect(screen.getByText('Bevar ved fejl')).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — share (code-only mode)', () => {
  it('shows "Del" button when share is enabled', async () => {
    setupFetch([makeSkabelon()], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Del' })).toBeInTheDocument();
    });
  });

  it('does not show "Del" button when share is fully disabled', async () => {
    setupFetch([makeSkabelon()], { code: false, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByText('Test skabelon'));
    expect(screen.queryByRole('button', { name: 'Del' })).not.toBeInTheDocument();
  });

  it('copies template code to clipboard when "Del" is clicked (code-only, clipboard available)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    // Use fireEvent (not userEvent) to bypass userEvent's built-in clipboard interception
    const { fireEvent: fe } = await import('@testing-library/react');
    const s = makeSkabelon({ id: 'share-id' });
    setupFetch([s], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    fe.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('MOCK_CODE_share-id');
    });
  });

  it('shows inline copy confirmation after sharing code via clipboard', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'share-toast' });
    setupFetch([s], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    await user.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      expect(screen.getByText('Kode kopieret til udklipsholder')).toBeInTheDocument();
    });
  });

  it('opens share dialog with code when clipboard is unavailable (code-only)', async () => {
    const user = userEvent.setup();
    // Make clipboard throw
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
      writable: true,
      configurable: true,
    });
    const s = makeSkabelon({ id: 'no-clip' });
    setupFetch([s], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    await user.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      expect(screen.getByText('Del skabelon')).toBeInTheDocument();
    });
  });

  it('share dialog contains the encoded code value', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
      writable: true,
      configurable: true,
    });
    const s = makeSkabelon({ id: 'dialog-code' });
    setupFetch([s], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    await user.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      // The code textarea should contain the mock-encoded value
      expect(screen.getByDisplayValue('MOCK_CODE_dialog-code')).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — share (both code and link)', () => {
  it('opens share dialog immediately when both code and link are enabled', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'both-share' });
    setupFetch([s], { code: true, link: true });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    await user.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      expect(screen.getByText('Del skabelon')).toBeInTheDocument();
    });
  });

  it('shows both Kode and Link sections when both are enabled', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'both-share-2' });
    setupFetch([s], { code: true, link: true });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Del' }));
    await user.click(screen.getByRole('button', { name: 'Del' }));

    await waitFor(() => {
      expect(screen.getByText('Kode')).toBeInTheDocument();
      expect(screen.getByText('Link')).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — default template indicator', () => {
  it('shows "Skabelon valgt som standard" badge for the default template', async () => {
    const s = makeSkabelon({ isDefault: true });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText('Skabelon valgt som standard')).toBeInTheDocument();
    });
  });

  it('does not show default badge for non-default templates', async () => {
    const s = makeSkabelon({ isDefault: false });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByText('Test skabelon'));
    expect(screen.queryByText('Skabelon valgt som standard')).not.toBeInTheDocument();
  });

  it('calls POST /api/skabeloner/:id/default when the heart button is clicked on a non-default template', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'set-default-id', isDefault: false });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Gør til standard' }));
    await user.click(screen.getByRole('button', { name: 'Gør til standard' }));

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const defaultCalls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/skabeloner/set-default-id/default' && (init as RequestInit)?.method === 'POST',
      );
      expect(defaultCalls.length).toBe(1);
    });
  });

  it('marks the template as default in the UI after setting it', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'promote-id', isDefault: false });
    setupFetch([s]);
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('button', { name: 'Gør til standard' }));
    await user.click(screen.getByRole('button', { name: 'Gør til standard' }));

    await waitFor(() => {
      expect(screen.getByText('Skabelon valgt som standard')).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — share config hint text', () => {
  it('shows the share hint text when share is enabled', async () => {
    setupFetch([], { code: true, link: false });
    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByText(/Tryk Del for at dele en skabelon med andre\./)).toBeInTheDocument();
    });
  });

  it('does not show share hint text when share is disabled', async () => {
    setupFetch([], { code: false, link: false });
    render(<SkabelonerList />);

    await waitFor(() => screen.getByText(/Skabeloner er genbrugelige prompts/));
    expect(screen.queryByText(/Tryk Del/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Error-handling paths (new)
// ---------------------------------------------------------------------------

describe('SkabelonerList — load error', () => {
  it('shows an error banner when the skabeloner fetch returns a non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: true, link: false } }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Kunne ikke indlæse skabeloner/)).toBeInTheDocument();
    });
  });

  it('shows an error banner when the skabeloner fetch throws a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.reject(new Error('Network error'));
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: true, link: false } }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Kunne ikke indlæse skabeloner/)).toBeInTheDocument();
    });
  });

  it('does NOT show the "Ingen skabeloner endnu" empty-state when a load error occurred', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({ ok: false, status: 503 } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: true, link: false } }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('alert'));
    expect(screen.queryByText('Ingen skabeloner endnu.')).not.toBeInTheDocument();
  });

  it('retries the load when the retry button in the error banner is clicked', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/skabeloner') {
          callCount += 1;
          if (callCount === 1) {
            return Promise.resolve({ ok: false, status: 500 } as Response);
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [makeSkabelon({ name: 'Na gik det' })] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: true, link: false } }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    const user = userEvent.setup();
    render(<SkabelonerList />);

    await waitFor(() => screen.getByRole('alert'));
    await user.click(screen.getByRole('button', { name: 'Prøv igen' }));

    await waitFor(() => {
      expect(screen.getByText('Na gik det')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SkabelonerList — delete action error', () => {
  it('shows an error banner when DELETE returns a non-ok status', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'err-del', name: 'Fejl ved slet' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [s] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: false, link: false } }),
          } as Response);
        }
        if (url === `/api/skabeloner/${s.id}` && init?.method === 'DELETE') {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Fejl ved slet'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Kunne ikke slette skabelonen/)).toBeInTheDocument();
    });
  });

  it('shows an error banner when DELETE throws a network error', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'net-del', name: 'Netværksfejl slet' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [s] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: false, link: false } }),
          } as Response);
        }
        if (url === `/api/skabeloner/${s.id}` && init?.method === 'DELETE') {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);
    await waitFor(() => screen.getByText('Netværksfejl slet'));
    await user.click(screen.getByRole('button', { name: 'Slet' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Kunne ikke slette skabelonen/)).toBeInTheDocument();
    });
  });
});

describe('SkabelonerList — set-default action error', () => {
  it('shows an error banner when set-default returns a non-ok status', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'err-def', isDefault: false, name: 'Fejl ved standard' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [s] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: false, link: false } }),
          } as Response);
        }
        if (url === `/api/skabeloner/${s.id}/default` && init?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);
    await waitFor(() => screen.getByRole('button', { name: 'Gør til standard' }));
    await user.click(screen.getByRole('button', { name: 'Gør til standard' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Kunne ikke sætte standardskabelon/)).toBeInTheDocument();
    });
  });

  it('does not mark template as default in the UI when set-default returns non-ok', async () => {
    const user = userEvent.setup();
    const s = makeSkabelon({ id: 'no-def', isDefault: false, name: 'Ikke standard' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/skabeloner') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skabeloner: [s] }),
          } as Response);
        }
        if (url === '/api/skabeloner/share-config') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ share: { code: false, link: false } }),
          } as Response);
        }
        if (url === `/api/skabeloner/${s.id}/default` && init?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      }),
    );

    render(<SkabelonerList />);
    await waitFor(() => screen.getByRole('button', { name: 'Gør til standard' }));
    await user.click(screen.getByRole('button', { name: 'Gør til standard' }));

    await waitFor(() => screen.getByRole('alert'));
    expect(screen.queryByText('Skabelon valgt som standard')).not.toBeInTheDocument();
  });
});
