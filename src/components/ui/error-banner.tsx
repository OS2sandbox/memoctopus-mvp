'use client';

import { cn } from '@/lib/utils';

interface ErrorBannerProps {
  /** The error message to show. When falsy, the banner renders nothing. */
  message?: string | null;
  /** Optional retry affordance — when provided, renders a button that calls it. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * Shared inline error banner. Standardises the ad-hoc `<p className="text-danger">`
 * pattern used across the app into one accessible (`role="alert"`) component so
 * failures are always visible to the user. Renders nothing when there is no message.
 */
export function ErrorBanner({ message, onRetry, retryLabel = 'Prøv igen', className }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2.5 rounded-[var(--radius)] px-3 py-2.5', className)}
      style={{
        background: 'var(--danger-wash)',
        border: '1px solid color-mix(in oklch, var(--danger) 22%, var(--line))',
      }}
    >
      <span className="font-mono text-[13px] leading-5" style={{ color: 'var(--danger)' }} aria-hidden>
        !
      </span>
      <span className="text-[13px] leading-snug flex-1" style={{ color: 'var(--danger)' }}>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-[13px] underline underline-offset-2"
          style={{ color: 'var(--danger)' }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
