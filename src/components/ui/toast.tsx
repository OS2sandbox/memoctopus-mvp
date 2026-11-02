'use client';

import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. 0 keeps the toast until dismissed. */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (options: ToastOptions | string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5000;

const toastVariants = cva(
  'pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius)] border px-3 py-2.5 text-[13px] leading-snug shadow-lg bg-[var(--surface)]',
  {
    variants: {
      variant: {
        info: 'border-[var(--line-strong)] text-[var(--ink)]',
        success: 'border-[var(--ok)] text-[var(--ok)]',
        error: 'border-[var(--danger)] bg-[var(--danger-wash)] text-[var(--danger)]',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

interface ToastProviderProps {
  children?: React.ReactNode;
  dismissLabel?: string;
}

export function ToastProvider({ children, dismissLabel = 'Luk besked' }: ToastProviderProps) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions | string) => {
      const opts: ToastOptions = typeof options === 'string' ? { message: options } : options;
      const id = nextId.current++;
      const variant = opts.variant ?? 'info';
      setItems((prev) => [...prev, { id, message: opts.message, variant }]);
      const duration = opts.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  // Pending timers must not fire after unmount (state update on an unmounted tree).
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Beskeder"
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2"
      >
        {items.map((item) => (
          <div key={item.id} data-variant={item.variant} className={cn(toastVariants({ variant: item.variant }))}>
            <span className="flex-1">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label={dismissLabel}
              className="shrink-0 rounded-[var(--radius-sm)] px-1 leading-none opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span aria-hidden>×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast skal bruges inde i <ToastProvider>');
  return ctx;
}
