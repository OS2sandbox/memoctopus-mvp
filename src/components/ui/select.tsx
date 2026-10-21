import * as React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Visible label, associated with the select via htmlFor/id. */
  label?: string;
  /** Error message; marks the select invalid and is announced via aria-describedby. */
  error?: string | null;
  /** Helper text shown below the select when there is no error. */
  hint?: string;
  /** Class for the outer wrapper (className goes on the select itself). */
  wrapperClassName?: string;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, label, error, hint, id, children, disabled, ...props }, ref) => {
    const autoId = React.useId();
    const selectId = id ?? autoId;
    const messageId = error || hint ? `${selectId}-msg` : undefined;
    return (
      <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
        {label && (
          <Label htmlFor={selectId}>{label}</Label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={messageId}
            className={cn(
              // appearance-none drops the browser's own arrow, whose position cannot be set; the chevron below replaces it.
              'peer flex h-11 w-full appearance-none rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface)] py-2 pl-3 pr-10 text-sm text-[var(--ink)] transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              error && 'border-[var(--danger)] focus:ring-[var(--danger)] focus:border-[var(--danger)]',
              className,
            )}
            {...props}
          >
            {children}
          </select>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-2)] peer-disabled:opacity-50"
          >
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </div>
        {error ? (
          <p id={messageId} className="text-[13px] text-[var(--danger)]">
            {error}
          </p>
        ) : hint ? (
          <p id={messageId} className="text-[13px] text-[var(--muted)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
Select.displayName = 'Select';

export { Select };
