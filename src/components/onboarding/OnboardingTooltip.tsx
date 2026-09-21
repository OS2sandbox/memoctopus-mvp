'use client';

import React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { getStep } from '@/lib/onboarding/steps';

/**
 * Always-available explainer for a UI element whose meaning isn't obvious
 * (an icon, a marker, a shortcut) — shown on every hover/focus, never
 * persisted. Use OnboardingHint instead for one-time onboarding copy about
 * non-obvious or destructive actions.
 */
export function OnboardingTooltip({ stepId, children }: { stepId: string; children: React.ReactNode }) {
  const step = getStep(stepId);
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
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
    </TooltipPrimitive.Provider>
  );
}
