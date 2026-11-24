// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyToClipboard } from './use-copy';

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCopyToClipboard', () => {
  it('writes the text and reports copied, which clears after a moment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(() => result.current.copy('hej'));

    expect(writeText).toHaveBeenCalledWith('hej');
    expect(result.current).toMatchObject({ copied: true, failed: false });

    act(() => { vi.advanceTimersByTime(2500); });
    expect(result.current.copied).toBe(false);
  });

  it.each([
    ['the write is refused', vi.fn().mockRejectedValue(new Error('denied'))],
    ['there is no clipboard', undefined],
  ])('reports failed when %s', async (_name, writeText) => {
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(() => result.current.copy('hej'));

    expect(result.current).toMatchObject({ copied: false, failed: true });
  });

  it('clears an earlier failure when a later copy succeeds', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(() => result.current.copy('hej'));
    await act(() => result.current.copy('hej'));

    expect(result.current).toMatchObject({ copied: true, failed: false });
  });
});
