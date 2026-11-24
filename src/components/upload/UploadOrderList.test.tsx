// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { UploadOrderList } from './UploadOrderList';

function makeFile(name: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });
}

/** Renders the list with its files held in state, as the page that owns them does. */
function Harness({ initial, onConfirm = vi.fn(), onCancel = vi.fn() }: {
  initial: File[];
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const [files, setFiles] = useState(initial);
  return (
    <>
      <UploadOrderList files={files} onChange={setFiles} onConfirm={onConfirm} onCancel={onCancel} />
      <output data-testid="order">{files.map((f) => f.name).join(',')}</output>
    </>
  );
}

const order = () => screen.getByTestId('order').textContent;

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
  const MockAudio = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    Object.defineProperty(this, 'src', {
      set() {
        queueMicrotask(() => {
          this.duration = 75;
          (this.onloadedmetadata as (() => void) | null)?.();
        });
      },
      configurable: true,
    });
  });
  vi.stubGlobal('Audio', MockAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UploadOrderList', () => {
  const abc = () => [makeFile('a.mp3'), makeFile('b.mp3'), makeFile('c.mp3')];

  it('lists every file with its size and length, in the order given', async () => {
    render(<Harness initial={abc()} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getByText(/\.mp3$/).textContent)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(within(items[0]).getByText('2.0 KB')).toBeInTheDocument();
    expect(await within(items[0]).findByText('01:15')).toBeInTheDocument();
  });

  it.each([
    ['Flyt b.mp3 op', 'b.mp3,a.mp3,c.mp3'],
    ['Flyt b.mp3 ned', 'a.mp3,c.mp3,b.mp3'],
    ['Fjern b.mp3', 'a.mp3,c.mp3'],
  ])('%s changes the order', (label, expected) => {
    render(<Harness initial={abc()} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(order()).toBe(expected);
  });

  it('cannot move the first file up or the last file down', () => {
    render(<Harness initial={abc()} />);
    expect(screen.getByRole('button', { name: 'Flyt a.mp3 op' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Flyt c.mp3 ned' })).toBeDisabled();
  });

  it('keeps the last file: it cannot be removed', () => {
    render(<Harness initial={[makeFile('a.mp3'), makeFile('b.mp3')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern b.mp3' }));
    expect(screen.getByRole('button', { name: 'Fjern a.mp3' })).toBeDisabled();
  });

  it('confirms and cancels through its buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Harness initial={abc()} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /saml og transskribér/ }));
    fireEvent.click(screen.getByRole('button', { name: /annullér/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
