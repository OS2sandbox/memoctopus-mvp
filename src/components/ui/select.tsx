import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
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
          <label htmlFor={selectId} className="text-sm font-medium text-[var(--ink)]">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          className={cn(
            'flex h-11 w-full rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-[var(--danger)] focus:ring-[var(--danger)] focus:border-[var(--danger)]',
            className,
          )}
          {...props}
        >
          {children}
        </select>
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
