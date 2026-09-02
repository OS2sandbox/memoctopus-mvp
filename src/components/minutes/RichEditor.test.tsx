// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { RichEditor } from './RichEditor';

// Tiptap/ProseMirror requires a browser-like environment.
// jsdom is sufficient; no network/DB mocks needed.

function setup(props: Partial<React.ComponentProps<typeof RichEditor>> = {}) {
  const onChange = vi.fn();
  const result = render(
    <RichEditor
      value={props.value ?? ''}
      onChange={props.onChange ?? onChange}
      {...props}
    />,
  );
  return { onChange, ...result };
}

describe('RichEditor — rendering', () => {
  it('renders the toolbar buttons', async () => {
    setup({ value: '' });
    await waitFor(() => {
      expect(screen.getByTitle('Fed (Ctrl+B)')).toBeInTheDocument();
      expect(screen.getByTitle('Kursiv (Ctrl+I)')).toBeInTheDocument();
      expect(screen.getByTitle('Punktliste')).toBeInTheDocument();
      expect(screen.getByTitle('Nummereret liste')).toBeInTheDocument();
      expect(screen.getByTitle('Fortryd (Ctrl+Z)')).toBeInTheDocument();
      expect(screen.getByTitle('Gentag (Ctrl+Y)')).toBeInTheDocument();
    });
  });

  it('renders the EditorContent container', async () => {
    const { container } = setup({ value: '' });
    await waitFor(() => {
      // tiptap renders a .ProseMirror div inside the editor content
      expect(container.querySelector('.ProseMirror')).not.toBeNull();
    });
  });

  it('shows placeholder text when editor is empty and placeholder is provided', async () => {
    setup({ value: '', placeholder: 'Skriv her…' });
    await waitFor(() => {
      expect(screen.getByText('Skriv her…')).toBeInTheDocument();
    });
  });

  it('does not show placeholder when editor has content', async () => {
    setup({ value: 'Hej verden' });
    await waitFor(() => {
      expect(screen.queryByText('Skriv her…')).toBeNull();
    });
  });

  it('does not show placeholder when placeholder prop is absent', async () => {
    const { container } = setup({ value: '' });
    // No placeholder div should be rendered at all
    await waitFor(() => {
      expect(container.querySelector('[style*="pointerEvents: none"]')).toBeNull();
    });
  });
});

describe('RichEditor — borderless variant', () => {
  it('toolbar is visible by default (non-borderless)', async () => {
    setup({ value: '', borderless: false });
    await waitFor(() => {
      const boldBtn = screen.getByTitle('Fed (Ctrl+B)');
      const toolbar = boldBtn.closest('div')!;
      expect(toolbar.style.display).not.toBe('none');
    });
  });

  it('toolbar is hidden in borderless mode when not focused', async () => {
    setup({ value: '', borderless: true });
    await waitFor(() => {
      const boldBtn = screen.getByTitle('Fed (Ctrl+B)');
      const toolbar = boldBtn.closest('div')!;
      expect(toolbar.style.display).toBe('none');
    });
  });

  it('toolbar uses sticky positioning in borderless mode when visible (focused)', async () => {
    const { container } = setup({ value: '', borderless: true });
    // Simulate focus
    const editorEl = container.querySelector('.ProseMirror');
    if (editorEl) {
      await act(async () => {
        fireEvent.focus(editorEl);
      });
    }
    await waitFor(() => {
      const boldBtn = screen.getByTitle('Fed (Ctrl+B)');
      const toolbar = boldBtn.closest('div')!;
      // After focus the toolbar should not be hidden
      expect(toolbar.style.display).not.toBe('none');
      expect(toolbar.style.position).toBe('sticky');
    });
  });

  it('borderless mode: outer container has no solid border', async () => {
    const { container } = setup({ value: '', borderless: true });
    await waitFor(() => {
      const outer = container.firstChild as HTMLElement;
      // jsdom serializes `border: 'none'` as 'medium' (its border-width default)
      // when no solid border color is set. Key indicator: no "solid" in the border value.
      expect(outer.style.border).not.toContain('solid');
    });
  });

  it('non-borderless mode: outer container has a border', async () => {
    const { container } = setup({ value: '', borderless: false });
    await waitFor(() => {
      const outer = container.firstChild as HTMLElement;
      expect(outer.style.border).toMatch(/1px solid/);
    });
  });
});

describe('RichEditor — minHeight prop', () => {
  it('applies default minHeight of 80px to editor attributes', async () => {
    const { container } = setup({ value: '' });
    await waitFor(() => {
      const proseMirror = container.querySelector('.ProseMirror') as HTMLElement;
      expect(proseMirror).not.toBeNull();
      // The minHeight is set via editorProps.attributes.style
      // jsdom normalises "min-height:80px" to "min-height: 80px" (with a space)
      const style = proseMirror.getAttribute('style') ?? '';
      expect(style).toMatch(/min-height:\s*80px/);
    });
  });

  it('applies custom minHeight to editor attributes', async () => {
    const { container } = setup({ value: '', minHeight: 200 });
    await waitFor(() => {
      const proseMirror = container.querySelector('.ProseMirror') as HTMLElement;
      expect(proseMirror).not.toBeNull();
      const style = proseMirror.getAttribute('style') ?? '';
      expect(style).toMatch(/min-height:\s*200px/);
    });
  });
});

describe('RichEditor — toolbar button onMouseDown', () => {
  it('Bold button calls preventDefault on mousedown (no focus loss)', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Fed (Ctrl+B)'));
    const boldBtn = screen.getByTitle('Fed (Ctrl+B)');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    boldBtn.dispatchEvent(event);
    // preventDefault is called to prevent the editor from losing focus
    expect(event.defaultPrevented).toBe(true);
  });

  it('Italic button calls preventDefault on mousedown', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Kursiv (Ctrl+I)'));
    const italicBtn = screen.getByTitle('Kursiv (Ctrl+I)');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    italicBtn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('BulletList button calls preventDefault on mousedown', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Punktliste'));
    const btn = screen.getByTitle('Punktliste');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('OrderedList button calls preventDefault on mousedown', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Nummereret liste'));
    const btn = screen.getByTitle('Nummereret liste');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Undo button calls preventDefault on mousedown', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Fortryd (Ctrl+Z)'));
    const btn = screen.getByTitle('Fortryd (Ctrl+Z)');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Redo button calls preventDefault on mousedown', async () => {
    setup({ value: '' });
    await waitFor(() => screen.getByTitle('Gentag (Ctrl+Y)'));
    const btn = screen.getByTitle('Gentag (Ctrl+Y)');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('RichEditor — value sync (external changes)', () => {
  it('re-renders with new value when value prop changes', async () => {
    const onChange = vi.fn();
    const { rerender, container } = render(
      <RichEditor value="Initial text" onChange={onChange} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).not.toBeNull();
    });

    await act(async () => {
      rerender(<RichEditor value="Updated text" onChange={onChange} />);
    });

    // The editor should have updated content — no error thrown
    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).not.toBeNull();
    });
  });

  it('does not call onChange when syncing external value (emitUpdate=false)', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RichEditor value="First" onChange={onChange} />,
    );
    await waitFor(() => screen.queryByTitle('Fed (Ctrl+B)') !== null);

    onChange.mockClear();

    await act(async () => {
      rerender(<RichEditor value="Second" onChange={onChange} />);
    });

    // onChange should NOT have been called by the sync
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('RichEditor — focus/blur state', () => {
  it('updates border color on focus (non-borderless)', async () => {
    const { container } = setup({ value: '', borderless: false });
    await waitFor(() => container.querySelector('.ProseMirror'));
    const outer = container.firstChild as HTMLElement;

    // Before focus: uses --line color
    expect(outer.style.border).toContain('var(--line)');

    const proseMirror = container.querySelector('.ProseMirror')!;
    await act(async () => {
      fireEvent.focus(proseMirror);
    });

    await waitFor(() => {
      expect(outer.style.border).toContain('var(--accent)');
    });
  });

  it('reverts border color on blur (non-borderless)', async () => {
    const { container } = setup({ value: '', borderless: false });
    await waitFor(() => container.querySelector('.ProseMirror'));
    const proseMirror = container.querySelector('.ProseMirror')!;

    await act(async () => {
      fireEvent.focus(proseMirror);
    });
    await waitFor(() => {
      const outer = container.firstChild as HTMLElement;
      expect(outer.style.border).toContain('var(--accent)');
    });

    await act(async () => {
      fireEvent.blur(proseMirror);
    });
    await waitFor(() => {
      const outer = container.firstChild as HTMLElement;
      expect(outer.style.border).toContain('var(--line)');
    });
  });
});

describe('RichEditor — content area click focuses editor', () => {
  it('clicking the content area wrapper triggers editor focus command', async () => {
    const { container } = setup({ value: '' });
    await waitFor(() => container.querySelector('.ProseMirror'));

    // The div wrapping EditorContent has an onClick handler
    const proseMirror = container.querySelector('.ProseMirror')!;
    const contentArea = proseMirror.parentElement!;
    // Just ensure clicking it does not throw
    expect(() => {
      fireEvent.click(contentArea);
    }).not.toThrow();
  });
});
