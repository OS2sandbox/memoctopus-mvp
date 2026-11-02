// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast, type ToastOptions } from './toast';

let api: ReturnType<typeof useToast>;
function Capture() {
  api = useToast();
  return null;
}

function setup() {
  return render(
    <ToastProvider>
      <Capture />
    </ToastProvider>,
  );
}

const show = (o: ToastOptions | string) => {
  let id = -1;
  act(() => {
    id = api.toast(o);
  });
  return id;
};

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a polite live region', () => {
    setup();
    const region = screen.getByRole('region', { name: 'Beskeder' });
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a toast from a plain string with info variant', () => {
    setup();
    show('Gemt');
    const msg = screen.getByText('Gemt');
    expect(msg.parentElement).toHaveAttribute('data-variant', 'info');
    expect(screen.getByRole('region')).toContainElement(msg);
  });

  it.each(['info', 'success', 'error'] as const)('supports the %s variant', (variant) => {
    setup();
    show({ message: 'Hej', variant });
    expect(screen.getByText('Hej').parentElement).toHaveAttribute('data-variant', variant);
  });

  it('auto-dismisses after the default duration', () => {
    setup();
    show('Forsvinder');
    expect(screen.getByText('Forsvinder')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText('Forsvinder')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Forsvinder')).not.toBeInTheDocument();
  });

  it('honours a custom duration and keeps each toast on its own timer', () => {
    setup();
    show({ message: 'Kort', duration: 1000 });
    show({ message: 'Lang', duration: 3000 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Kort')).not.toBeInTheDocument();
    expect(screen.getByText('Lang')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('Lang')).not.toBeInTheDocument();
  });

  it('keeps a toast with duration 0 until dismissed', () => {
    setup();
    show({ message: 'Bliver', duration: 0 });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Bliver')).toBeInTheDocument();
  });

  it('dismisses via the Danish-labelled button and clears its timer', () => {
    setup();
    show('Luk mig');
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Luk besked' }));
    expect(screen.queryByText('Luk mig')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dismiss(id) removes only that toast', () => {
    setup();
    const a = show({ message: 'A', duration: 0 });
    show({ message: 'B', duration: 0 });
    act(() => api.dismiss(a));
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('clears pending timers on unmount', () => {
    const { unmount } = setup();
    show('A');
    show('B');
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not warn about state updates after unmount when timers would fire', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = setup();
    show('A');
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('useToast throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Capture />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
