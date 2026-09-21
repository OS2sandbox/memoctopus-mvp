'use client';

import React, { useEffect, useId, useRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useOnboarding } from '@/lib/onboarding/context';
import { getStep } from '@/lib/onboarding/steps';

function hintKey(stepId: string, meetingId: string | null): string {
  return `${stepId}:${meetingId ?? ''}`;
}

/**
 * Wraps a target element and, the first time this step hasn't been seen,
 * shows a small dismissible bubble with onboarding copy anchored to it.
 * It's visible at most once ever: being shown counts as "seen" even if the
 * user navigates away instead of clicking "forstået" (state lives in
 * onboarding_progress).
 *
 * Only one hint is ever open at a time, app-wide, so a page never shows
 * several bubbles at once — pending hints queue in mount order and are
 * revealed one by one as each is dismissed. A step id can also wrap more
 * than one DOM element (e.g. the same "Del" button repeated once per card
 * in a list); only one instance owns the slot at a time (the next mounted
 * one takes over if the owner unmounts), so the bubble renders exactly once
 * no matter how many elements reference it.
 *
 * Use for `engine: 'popover'` steps — one-time, high/medium-severity hints
 * about non-obvious or destructive behavior. For always-visible ambient
 * explainers (e.g. an icon's meaning), use OnboardingTooltip instead.
 */
export function OnboardingHint({
  stepId,
  meetingId = null,
  condition = true,
  children,
}: {
  stepId: string;
  meetingId?: string | null;
  /** Extra guard for steps that should only fire once app state satisfies a predicate. */
  condition?: boolean;
  children: React.ReactNode;
}) {
  const step = getStep(stepId);
  const { isStepSeen, markSeen, showWelcome, claim, release, isActive } = useOnboarding();
  const instanceId = useId();
  const key = hintKey(stepId, meetingId);
  const pending = condition && !isStepSeen(stepId, meetingId);

  // Never overlap the welcome dialog — it should be the only thing on screen
  // until the user closes/skips it, after which the hint queue can take over.
  const open = !showWelcome && pending && isActive(key, instanceId);

  // A hint should be visible at most once: if the user navigates away while
  // it's showing (instead of clicking "forstået"), the unmount below would
  // otherwise leave the step unseen, so it queues up again next time this
  // stepId/meetingId mounts (e.g. revisiting a page). Track WHICH key this
  // instance actually got shown for (one instance is reused when the key
  // changes) and, if so, mark it seen on unmount too. Dismissing already
  // saves, so it clears the ref to keep the cleanup from saving a second time.
  const shownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (open) shownKeyRef.current = key;
  }, [open, key]);

  const dismiss = () => {
    shownKeyRef.current = null;
    markSeen(stepId, meetingId);
  };

  useEffect(() => {
    if (!pending) return;
    claim(key, instanceId);
    return () => {
      release(key, instanceId);
      if (shownKeyRef.current === key) {
        shownKeyRef.current = null;
        markSeen(stepId, meetingId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, key, instanceId]);

  return (
    <PopoverPrimitive.Root open={open}>
      <PopoverPrimitive.Anchor asChild>{children}</PopoverPrimitive.Anchor>
      {open && (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side={step.placement}
            // 'center' (Radix's default) centers the bubble across the WHOLE
            // anchor rect, which looks fine for a small button but points at
            // empty space when the anchor is a wide block (a full-width row,
            // a caption that spans its container) — 'start' keeps the arrow
            // near the anchor's actual visible content in both cases.
            align="start"
            sideOffset={8}
            collisionPadding={12}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onEscapeKeyDown={dismiss}
            style={{
              zIndex: 60,
              maxWidth: 280,
              background: 'var(--accent-ink)',
              color: '#fff',
              borderRadius: 'var(--radius-lg)',
              padding: '10px 12px',
              fontSize: 12.5,
              lineHeight: 1.5,
              boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <span>{step.copy}</span>
            <button
              type="button"
              onClick={dismiss}
              style={{
                alignSelf: 'flex-end',
                background: 'rgba(255,255,255,0.16)',
                border: 'none',
                borderRadius: 'var(--radius)',
                color: '#fff',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                padding: '3px 9px',
                cursor: 'pointer',
              }}
            >
              forstået
            </button>
            <PopoverPrimitive.Arrow width={10} height={5} style={{ fill: 'var(--accent-ink)' }} />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  );
}
