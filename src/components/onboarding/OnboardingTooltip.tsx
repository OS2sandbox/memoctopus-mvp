'use client';

import React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { findStep } from '@/lib/onboarding/steps';

/**
 * Always-available explainer for a UI element whose meaning isn't obvious
 * (an icon, a marker, a shortcut) — shown on every hover/focus, never
 * persisted. Use OnboardingHint instead for one-time onboarding copy about
 * non-obvious or destructive actions.
 */
// Relies on a single TooltipPrimitive.Provider mounted once in OnboardingProvider
// (src/lib/onboarding/context.tsx) — every page that can render an OnboardingTooltip
// is already wrapped in OnboardingProvider (see (app)/layout.tsx), so this needs no
// Provider of its own. That used to mount a fresh one per instance, which mattered
// here specifically: this is used inside a live-growing transcript list during
// recording, remounting on every new segment.
export function OnboardingTooltip({ stepId, children }: { stepId: string; children: React.ReactNode }) {
  const step = findStep(stepId);
  // An unknown stepId must not take the wrapped real content down with it.
  if (!step) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={step.placement}
          sideOffset={6}
          style={{
            zIndex: 60,
            maxWidth: 260,
            background: 'var(--ink)',
            color: 'var(--bg)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: '0 4px 14px rgba(0,0,0,0.16)',
          }}
        >
          {step.copy}
          <TooltipPrimitive.Arrow width={8} height={4} style={{ fill: 'var(--ink)' }} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
