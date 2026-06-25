import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default:    'bg-[var(--accent-wash)] text-[var(--accent-ink)]',
        secondary:  'bg-[var(--surface-2)] text-[var(--ink-2)]',
        success:    'bg-[color-mix(in_oklch,var(--ok)_12%,white)] text-[var(--ok)]',
        warning:    'bg-[color-mix(in_oklch,var(--warn)_12%,white)] text-[var(--warn)]',
        destructive:'bg-[var(--danger-wash)] text-[var(--danger)]',
        outline:    'border border-[var(--line-strong)] text-[var(--ink-2)] bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
