import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-[var(--radius)] px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent-soft)] text-[var(--accent)]',
        secondary: 'bg-[var(--surface-2)] text-[var(--text-2)]',
        success: 'bg-green-50 text-[var(--success)]',
        warning: 'bg-amber-50 text-[var(--warning)]',
        destructive: 'bg-red-50 text-[var(--danger)]',
        outline: 'border border-[var(--border-strong)] text-[var(--text-2)] bg-transparent',
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
