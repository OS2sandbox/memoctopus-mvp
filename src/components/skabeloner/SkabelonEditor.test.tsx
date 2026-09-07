// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SkabelonEditor } from './SkabelonEditor';
import type { Skabelon } from '@/types';
import { encodeSkabelonCode } from '@/lib/skabeloner/share-code';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDecodeSkabelonCode = vi.fn();
const mockExtractImportToken = vi.fn();

vi.mock('@/lib/skabeloner/share-code', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skabeloner/share-code')>();
  return {
    ...actual,
    decodeSkabelonCode: (...args: unknown[]) => mockDecodeSkabelonCode(...args),
    extractImportToken: (...args: unknown[]) => mockExtractImportToken(...args),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SKABELON: Skabelon = {
  id: 'sk-1',
  name: 'Bestyrelsesmøde',
  description: 'Til bestyrelsesmøder',
  prompt: 'Skriv et referat af bestyrelsesmødet',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: true,
  includeDato: false,
  isDefault: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const SAVED_SKABELON: Skabelon = {
  ...SAMPLE_SKABELON,
  id: 'sk-saved',
  name: 'Saved',
  description: '',
  prompt: '',
  includeDeltagere: false,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderEditor(
  props: Partial<React.ComponentProps<typeof SkabelonEditor>> = {},
) {
  const defaults: React.ComponentProps<typeof SkabelonEditor> = {
    open: true,
    onOpenChange: vi.fn(),
    skabelon: null,
    onSaved: vi.fn(),
    shareConfig: { code: true, link: false },
  };
  return render(<SkabelonEditor {...defaults} {...props} />);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockDecodeSkabelonCode.mockReturnValue(null);
  mockExtractImportToken.mockReturnValue(null);
  global.fetch = vi.fn();
});

// ---------------------------------------------------------------------------
// Rendering — create mode
// ---------------------------------------------------------------------------

describe('SkabelonEditor — create mode (skabelon=null)', () => {
  it('renders the "Ny skabelon" title', () => {
    renderEditor();
    expect(screen.getByText('Ny skabelon')).toBeInTheDocument();
  });

  it('renders name, description and prompt fields', () => {
    renderEditor();
    expect(screen.getByLabelText('Navn')).toBeInTheDocument();
    expect(screen.getByLabelText('Beskrivelse')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
  });

  it('starts with empty name, description, and prompt', () => {
    renderEditor();
    expect(screen.getByLabelText('Navn')).toHaveValue('');
    expect(screen.getByLabelText('Beskrivelse')).toHaveValue('');
    expect(screen.getByLabelText('Prompt')).toHaveValue('');
  });

  it('renders the four category toggle buttons', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Deltagere' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beslutningspunkter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dagsorden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dato' })).toBeInTheDocument();
  });

  it('renders Gem and Annullér buttons', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Gem' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annullér' })).toBeInTheDocument();
  });

  it('does not show an error message initially', () => {
    renderEditor();
    expect(screen.queryByText('Navn er påkrævet')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rendering — edit mode
// ---------------------------------------------------------------------------

describe('SkabelonEditor — edit mode (skabelon provided)', () => {
  it('renders the "Rediger skabelon" title', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON });
    expect(screen.getByText('Rediger skabelon')).toBeInTheDocument();
  });

  it('prefills name field with existing skabelon name', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON });
    expect(screen.getByLabelText('Navn')).toHaveValue('Bestyrelsesmøde');
  });

  it('prefills description field', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON });
    expect(screen.getByLabelText('Beskrivelse')).toHaveValue('Til bestyrelsesmøder');
  });

  it('prefills prompt field', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON });
    expect(screen.getByLabelText('Prompt')).toHaveValue('Skriv et referat af bestyrelsesmødet');
  });

  it('hides the paste-to-import affordance in edit mode', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON });
    expect(screen.queryByLabelText('Har du en kode?')).toBeNull();
    expect(screen.queryByPlaceholderText('Indsæt kode…')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rendering — dialog closed
// ---------------------------------------------------------------------------

describe('SkabelonEditor — dialog closed (open=false)', () => {
  it('does not render dialog content when closed', () => {
    renderEditor({ open: false });
    expect(screen.queryByText('Ny skabelon')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Form reset on open
// ---------------------------------------------------------------------------

describe('SkabelonEditor — form reset on open', () => {
  it('resets fields when re-opened in create mode after a previous session', () => {
    const { rerender } = renderEditor({ open: false, skabelon: null });
    // Open with a skabelon first
    rerender(
      <SkabelonEditor
        open={true}
        onOpenChange={vi.fn()}
        skabelon={SAMPLE_SKABELON}
        onSaved={vi.fn()}
        shareConfig={{ code: true, link: false }}
      />,
    );
    expect(screen.getByLabelText('Navn')).toHaveValue('Bestyrelsesmøde');

    // Close then reopen with null
    rerender(
      <SkabelonEditor
        open={false}
        onOpenChange={vi.fn()}
        skabelon={null}
        onSaved={vi.fn()}
        shareConfig={{ code: true, link: false }}
      />,
    );
    rerender(
      <SkabelonEditor
        open={true}
        onOpenChange={vi.fn()}
        skabelon={null}
        onSaved={vi.fn()}
        shareConfig={{ code: true, link: false }}
      />,
    );
    expect(screen.getByLabelText('Navn')).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('SkabelonEditor — validation', () => {
  it('shows "Navn er påkrævet" when saving without a name', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ skabelon: SAVED_SKABELON }) });
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    expect(screen.getByText('Navn er påkrævet')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not call fetch when name is whitespace only', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: '   ' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('clears validation error after a successful save attempt', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ skabelon: SAVED_SKABELON }) });
    renderEditor();

    // First, trigger the validation error
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });
    expect(screen.getByText('Navn er påkrævet')).toBeInTheDocument();

    // Then fill in a name and save successfully
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Navn er påkrævet')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Save — create mode
// ---------------------------------------------------------------------------

describe('SkabelonEditor — save (create mode)', () => {
  it('POSTs to /api/skabeloner with the assembled fields', async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor({ onSaved, onOpenChange });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'My Template' } });
    fireEvent.change(screen.getByLabelText('Beskrivelse'), { target: { value: 'Desc' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Do it' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/skabeloner',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'My Template',
            description: 'Desc',
            prompt: 'Do it',
            includeDeltagere: false,
            includeBeslutningspunkter: false,
            includeDagsorden: false,
            includeDato: false,
          }),
        }),
      );
    });
  });

  it('calls onSaved with the returned skabelon', async () => {
    const onSaved = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor({ onSaved });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(SAVED_SKABELON);
    });
  });

  it('calls onOpenChange(false) after successful save', async () => {
    const onOpenChange = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor({ onOpenChange });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('trims whitespace from name before sending', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: '  Trimmed  ' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.name).toBe('Trimmed');
    });
  });
});

// ---------------------------------------------------------------------------
// Save — edit mode
// ---------------------------------------------------------------------------

describe('SkabelonEditor — save (edit mode)', () => {
  it('PUTs to /api/skabeloner/:id when editing an existing skabelon', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAMPLE_SKABELON }),
    });

    renderEditor({ skabelon: SAMPLE_SKABELON });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/skabeloner/${SAMPLE_SKABELON.id}`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Save — error states
// ---------------------------------------------------------------------------

describe('SkabelonEditor — save errors', () => {
  it('shows error message when fetch returns non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Server fejl' }),
    });

    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Server fejl')).toBeInTheDocument();
    });
  });

  it('shows fallback error message when response has no error field', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });

    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Kunne ikke gemme skabelon')).toBeInTheDocument();
    });
  });

  it('shows loading state while saving', async () => {
    let resolveFetch!: (v: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveFetch = r; }),
    );

    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gem' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Gemmer…' })).toBeDisabled();
    });

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ skabelon: SAVED_SKABELON }) });
    });
  });

  it('disables Annullér during save', async () => {
    let resolveFetch!: (v: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveFetch = r; }),
    );

    renderEditor();
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gem' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Annullér' })).toBeDisabled();
    });

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ skabelon: SAVED_SKABELON }) });
    });
  });
});

// ---------------------------------------------------------------------------
// Annullér button
// ---------------------------------------------------------------------------

describe('SkabelonEditor — Annullér button', () => {
  it('calls onOpenChange(false) when Annullér is clicked', () => {
    const onOpenChange = vi.fn();
    renderEditor({ onOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Annullér' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// Category toggles
// ---------------------------------------------------------------------------

describe('SkabelonEditor — category toggles', () => {
  it('toggles Deltagere on click', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor();
    const deltagereBtn = screen.getByRole('button', { name: 'Deltagere' });

    // Click to enable
    fireEvent.click(deltagereBtn);

    // Save and verify
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.includeDeltagere).toBe(true);
    });
  });

  it('toggles Beslutningspunkter on click', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Beslutningspunkter' }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.includeBeslutningspunkter).toBe(true);
    });
  });

  it('toggles a category off when clicked twice', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAVED_SKABELON }),
    });

    renderEditor();
    const btn = screen.getByRole('button', { name: 'Dato' });
    fireEvent.click(btn); // on
    fireEvent.click(btn); // off

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.includeDato).toBe(false);
    });
  });

  it('starts with categories prefilled from existing skabelon', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SAMPLE_SKABELON }),
    });

    renderEditor({ skabelon: SAMPLE_SKABELON });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gem' }));
    });

    await waitFor(() => {
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.includeDeltagere).toBe(true);
      expect(body.includeDagsorden).toBe(true);
      expect(body.includeBeslutningspunkter).toBe(false);
      expect(body.includeDato).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Paste-to-import affordance — visibility
// ---------------------------------------------------------------------------

describe('SkabelonEditor — paste affordance visibility', () => {
  it('shows paste input when shareConfig.code=true', () => {
    renderEditor({ shareConfig: { code: true, link: false } });
    expect(screen.getByPlaceholderText('Indsæt kode…')).toBeInTheDocument();
  });

  it('shows paste input when shareConfig.link=true', () => {
    renderEditor({ shareConfig: { code: false, link: true } });
    expect(screen.getByPlaceholderText('Indsæt link…')).toBeInTheDocument();
  });

  it('shows paste input when both code and link are enabled', () => {
    renderEditor({ shareConfig: { code: true, link: true } });
    expect(screen.getByPlaceholderText('Indsæt kode eller link…')).toBeInTheDocument();
  });

  it('hides paste input when both code and link are disabled', () => {
    renderEditor({ shareConfig: { code: false, link: false } });
    expect(screen.queryByPlaceholderText('Indsæt kode…')).toBeNull();
    expect(screen.queryByPlaceholderText('Indsæt link…')).toBeNull();
    expect(screen.queryByPlaceholderText('Indsæt kode eller link…')).toBeNull();
  });

  it('shows "Har du en kode?" label when code-only', () => {
    renderEditor({ shareConfig: { code: true, link: false } });
    expect(screen.getByText('Har du en kode?')).toBeInTheDocument();
  });

  it('shows "Har du et link?" label when link-only', () => {
    renderEditor({ shareConfig: { code: false, link: true } });
    expect(screen.getByText('Har du et link?')).toBeInTheDocument();
  });

  it('shows "Har du en kode eller et link?" label when both are enabled', () => {
    renderEditor({ shareConfig: { code: true, link: true } });
    expect(screen.getByText('Har du en kode eller et link?')).toBeInTheDocument();
  });

  it('hides paste affordance in edit mode even when shareConfig enables it', () => {
    renderEditor({ skabelon: SAMPLE_SKABELON, shareConfig: { code: true, link: false } });
    expect(screen.queryByPlaceholderText('Indsæt kode…')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paste-to-import — code decoding
// ---------------------------------------------------------------------------

describe('SkabelonEditor — paste import (code)', () => {
  const SHAREABLE = {
    name: 'Imported Name',
    description: 'Imported Desc',
    prompt: 'Imported Prompt',
    includeDeltagere: true,
    includeBeslutningspunkter: false,
    includeDagsorden: true,
    includeDato: false,
  };

  it('populates fields when a valid code is pasted and Indsæt clicked', async () => {
    mockDecodeSkabelonCode.mockReturnValue(SHAREABLE);

    renderEditor({ shareConfig: { code: true, link: false } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'skab1_abc' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Navn')).toHaveValue('Imported Name');
      expect(screen.getByLabelText('Beskrivelse')).toHaveValue('Imported Desc');
      expect(screen.getByLabelText('Prompt')).toHaveValue('Imported Prompt');
    });
  });

  it('shows "Skabelon indlæst" confirmation after successful code import', async () => {
    mockDecodeSkabelonCode.mockReturnValue(SHAREABLE);

    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'skab1_abc' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Skabelon indlæst — gennemse og gem.')).toBeInTheDocument();
    });
  });

  it('clears the paste input after successful code import', async () => {
    mockDecodeSkabelonCode.mockReturnValue(SHAREABLE);

    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'skab1_abc' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      // The input should be cleared (paste area disappears or value is empty)
      const input = screen.queryByPlaceholderText('Indsæt kode…');
      if (input) {
        expect(input).toHaveValue('');
      }
    });
  });

  it('shows "Ugyldig kode" when decodeSkabelonCode returns null (code-only config)', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);

    renderEditor({ shareConfig: { code: true, link: false } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'not-a-valid-code' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ugyldig kode')).toBeInTheDocument();
    });
  });

  it('does not call fetch when code is decoded successfully', async () => {
    mockDecodeSkabelonCode.mockReturnValue(SHAREABLE);

    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'skab1_abc' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('Indsæt button is disabled when paste input is empty', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Indsæt' })).toBeDisabled();
  });

  it('Indsæt button is enabled when paste input has a value', () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'some-code' },
    });
    expect(screen.getByRole('button', { name: 'Indsæt' })).not.toBeDisabled();
  });

  it('triggers import on Enter key in paste input', async () => {
    mockDecodeSkabelonCode.mockReturnValue(SHAREABLE);

    renderEditor();
    const input = screen.getByPlaceholderText('Indsæt kode…');
    fireEvent.change(input, { target: { value: 'skab1_abc' } });

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Navn')).toHaveValue('Imported Name');
    });
  });

  it('does not trigger import on other keys', async () => {
    renderEditor();
    const input = screen.getByPlaceholderText('Indsæt kode…');
    fireEvent.change(input, { target: { value: 'skab1_abc' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(mockDecodeSkabelonCode).not.toHaveBeenCalled();
  });

  it('clears paste error when user starts typing', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);

    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'bad' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ugyldig kode')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'new' },
    });

    expect(screen.queryByText('Ugyldig kode')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paste-to-import — link fetching
// ---------------------------------------------------------------------------

describe('SkabelonEditor — paste import (link)', () => {
  const SHAREABLE = {
    name: 'Link Imported',
    description: '',
    prompt: 'Via link',
    includeDeltagere: false,
    includeBeslutningspunkter: true,
    includeDagsorden: false,
    includeDato: false,
  };

  it('fetches from the API when a valid link token is pasted', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SHAREABLE }),
    });

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/skabeloner/import/tok123');
    });
  });

  it('populates fields after successful link fetch', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SHAREABLE }),
    });

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Navn')).toHaveValue('Link Imported');
    });
  });

  it('shows "Henter…" while fetching', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');
    let resolveFetch!: (v: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveFetch = r; }),
    );

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Henter…' })).toBeDisabled();
    });

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ skabelon: SHAREABLE }) });
    });
  });

  it('shows error when link fetch fails', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Kunne ikke hente skabelon fra linket')).toBeInTheDocument();
    });
  });

  it('shows "Ugyldigt link" when link token is null (link-only config)', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue(null);

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'not-a-link' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ugyldigt link')).toBeInTheDocument();
    });
  });

  it('shows "Ugyldig kode eller link" when both methods fail with code+link config', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue(null);

    renderEditor({ shareConfig: { code: true, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode eller link…'), {
      target: { value: 'totally-invalid' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ugyldig kode eller link')).toBeInTheDocument();
    });
  });

  it('does not try link fetch when link config is disabled even if extractImportToken returns a token', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');

    renderEditor({ shareConfig: { code: true, link: false } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt kode…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    // Should NOT have called fetch for the import endpoint
    expect(global.fetch).not.toHaveBeenCalledWith('/api/skabeloner/import/tok123');
  });

  it('shows "Skabelon indlæst" confirmation after successful link import', async () => {
    mockDecodeSkabelonCode.mockReturnValue(null);
    mockExtractImportToken.mockReturnValue('tok123');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ skabelon: SHAREABLE }),
    });

    renderEditor({ shareConfig: { code: false, link: true } });
    fireEvent.change(screen.getByPlaceholderText('Indsæt link…'), {
      target: { value: 'https://example.com/skabeloner/import/tok123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Indsæt' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Skabelon indlæst — gennemse og gem.')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Default shareConfig
// ---------------------------------------------------------------------------

describe('SkabelonEditor — default shareConfig', () => {
  it('uses code=true by default (paste affordance is visible)', () => {
    render(
      <SkabelonEditor
        open={true}
        onOpenChange={vi.fn()}
        skabelon={null}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Indsæt kode…')).toBeInTheDocument();
  });
});
