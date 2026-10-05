'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  baseId: string;
  value: string | undefined;
  setValue: (value: string) => void;
  registerTrigger: (value: string, el: HTMLButtonElement | null) => void;
  triggers: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`${component} skal bruges inde i <Tabs>`);
  return ctx;
}

// Ids must be valid in aria-controls/aria-labelledby, so strip anything unsafe.
const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_');

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Controlled value. When set, the component does not keep its own state. */
  value?: string;
  /** Initial value for uncontrolled use. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

function Tabs({ value, defaultValue, onValueChange, className, children, ...props }: TabsProps) {
  const baseId = React.useId();
  const [inner, setInner] = React.useState<string | undefined>(defaultValue);
  const isControlled = value !== undefined;
  const current = isControlled ? value : inner;
  const triggers = React.useRef(new Map<string, HTMLButtonElement>());

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setInner(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const registerTrigger = React.useCallback((v: string, el: HTMLButtonElement | null) => {
    if (el) triggers.current.set(v, el);
    else triggers.current.delete(v);
  }, []);

  const ctx = React.useMemo(
    () => ({ baseId, value: current, setValue, registerTrigger, triggers }),
    [baseId, current, setValue, registerTrigger],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onKeyDown, ...props }, ref) => {
    const { setValue, triggers } = useTabsContext('TabsList');

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;

      // DOM order, not registration order, defines the tab sequence.
      const enabled = Array.from(
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
      );
      if (enabled.length === 0) return;
      const idx = enabled.findIndex((el) => el === document.activeElement);
      let nextIdx: number;
      if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = enabled.length - 1;
      else if (e.key === 'ArrowRight') nextIdx = idx < 0 ? 0 : (idx + 1) % enabled.length;
      else nextIdx = idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length;

      e.preventDefault();
      const target = enabled[nextIdx];
      target.focus();
      for (const [v, el] of triggers.current) {
        if (el === target) {
          setValue(v);
          break;
        }
      }
    };

    return (
      <div
        ref={ref}
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        className={cn('flex items-center gap-1 border-b border-[var(--line)]', className)}
        {...props}
      />
    );
  },
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, onClick, disabled, ...props }, ref) => {
    const ctx = useTabsContext('TabsTrigger');
    const selected = ctx.value === value;
    const { registerTrigger } = ctx;

    const setRefs = React.useCallback(
      (el: HTMLButtonElement | null) => {
        registerTrigger(value, el);
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      },
      [registerTrigger, value, ref],
    );

    return (
      <button
        ref={setRefs}
        type="button"
        role="tab"
        id={`${ctx.baseId}-tab-${safe(value)}`}
        aria-selected={selected}
        aria-controls={`${ctx.baseId}-panel-${safe(value)}`}
        // Roving tabindex: only the active tab is in the page tab order.
        tabIndex={selected ? 0 : -1}
        data-state={selected ? 'active' : 'inactive'}
        disabled={disabled}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) ctx.setValue(value);
        }}
        className={cn(
          '-mb-px inline-flex min-h-[40px] items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-[var(--muted)] transition-colors',
          'hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
          'disabled:pointer-events-none disabled:opacity-50',
          'data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--ink)]',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = useTabsContext('TabsContent');
    const selected = ctx.value === value;
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`${ctx.baseId}-panel-${safe(value)}`}
        aria-labelledby={`${ctx.baseId}-tab-${safe(value)}`}
        hidden={!selected}
        tabIndex={0}
        className={cn(
          'pt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
