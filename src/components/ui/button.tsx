'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:bg-[var(--accent-hover)]',
        secondary:
          'bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--border-strong)] border border-[var(--border)]',
        outline:
          'border border-[var(--border-strong)] bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)]',
        ghost: 'bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)]',
        destructive:
          'bg-[var(--danger)] text-white hover:bg-red-700',
        link: 'bg-transparent text-[var(--accent)] underline-offset-4 hover:underline p-0 h-auto min-h-0',
      },
      size: {
        default: 'h-11 min-h-[44px] px-4 py-2 text-sm rounded-[var(--radius)]',
        sm: 'h-9 min-h-[36px] px-3 text-xs rounded-[var(--radius)]',
        lg: 'h-12 min-h-[48px] px-6 text-base rounded-[var(--radius)]',
        icon: 'h-10 w-10 min-h-[40px] rounded-[var(--radius)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
