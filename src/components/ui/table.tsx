import * as React from 'react';
import { cn } from '@/lib/utils';

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    // Wrapper scrolls on narrow screens so wide admin tables never break the page layout.
    <div className="relative w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm text-[var(--ink)]', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('border-b border-[var(--line-strong)]', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b border-[var(--line)] transition-colors hover:bg-[var(--surface-2)] data-[state=selected]:bg-[var(--accent-wash)]',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, scope = 'col', ...props }, ref) => (
  <th
    ref={ref}
    scope={scope}
    className={cn(
      'h-10 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-2.5 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn('mt-3 text-xs text-[var(--muted)]', className)} {...props} />
));
TableCaption.displayName = 'TableCaption';

interface TableEmptyRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Number of columns in the table so the message spans the full width. */
  colSpan: number;
  children?: React.ReactNode;
}

/** Placeholder row shown when a table has no data. */
function TableEmptyRow({ colSpan, children = 'Ingen data', className, ...props }: TableEmptyRowProps) {
  return (
    <tr className={cn('border-b border-[var(--line)]', className)} {...props}>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-[var(--muted)]">
        {children}
      </td>
    </tr>
  );
}
TableEmptyRow.displayName = 'TableEmptyRow';

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  TableEmptyRow,
};
