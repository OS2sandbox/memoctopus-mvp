'use client';

import React, { useEffect, useId, useReducer, useRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { seenKey, useOnboarding } from '@/lib/onboarding/context';
import { findStep } from '@/lib/onboarding/steps';

// Below dialogs and their overlay (z-50 in components/ui/dialog.tsx), above the
// sticky top bar (40). Above a modal, the bubble could be read but not dismissed.
const HINT_Z_INDEX = 45;

/**
 * Whether a modal (a Radix Dialog or AlertDialog, a modal menu) has the rest of the
 * page blocked. Radix marks that by setting `pointer-events: none` on <body>, so a
 * hint underneath could not be dismissed and Escape meant for the modal would
 * dismiss the hint as well, unread. Read straight from the DOM on each render; the
 * observer only re-renders when it changes, and only runs while `watch` is set, so
 * just the one hint that is due to show pays for it.
 */
function usePageBlockedByModal(watch: boolean): boolean {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!watch) return;
    const observer = new MutationObserver(rerender);
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [watch]);
  return watch && typeof document !== 'undefined' && document.body.style.pointerEvents === 'none';
}

/**
 * Wraps a target element and, the first time this step hasn't been seen,
 * shows a small dismissible bubble with onboarding copy anchored to it.
 * Once seen, it stays hidden until the user replays the tour with the "?"
 * button (or, for a `per-meeting` step, until the next meeting): being shown
 * counts as "seen" even if the user navigates away instead of clicking
 * "forstået" (state lives in onboarding_progress).
 *
 * Only one hint is ever open at a time, app-wide, so a page never shows
 * several bubbles at once — pending hints queue by severity (mount order
 * among equals) and are revealed one by one as each is dismissed. A step id can also wrap more
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
  const step = findStep(stepId);
  const { isStepSeen, markSeen, showWelcome, claim, release, isActive, shown } = useOnboarding();

  // The registry decides whether a hint is remembered once or once per meeting —
  // not the call site. Passing meetingId at a `global` step used to scope its
  // seen-key to that meeting, so an explainer like "the recording is only stored
  // in your browser" came back for every new recording. The prop is now a
  // suggestion the step's own scope has to agree with, which keeps the two from
  // drifting apart: a step's behaviour is whatever steps.ts says it is.
  const scopedMeetingId = step?.scope === 'per-meeting' ? meetingId : null;
  const instanceId = useId();
  const key = seenKey(stepId, scopedMeetingId);
  // An unknown stepId must never show a hint — the wrapped real content below still
  // renders regardless, findStep already logged the mistake.
  const pending = !!step && condition && !isStepSeen(stepId, scopedMeetingId);

  // Never overlap the welcome dialog — it should be the only thing on screen
  // until the user closes/skips it, after which the hint queue can take over.
  const due = !showWelcome && pending && isActive(key, instanceId);
  // Nor any other modal: wait it out and come back when it closes.
  const blockedByModal = usePageBlockedByModal(due);
  const open = due && !blockedByModal;

  // A hint should be visible at most once: if the user navigates away while
  // it's showing (instead of clicking "forstået"), the unmount below would
  // otherwise leave the step unseen, so it queues up again next time this
  // stepId/meetingId mounts (e.g. revisiting a page). Track WHICH key this
  // instance actually got shown for (one instance is reused when the key
  // changes) and, if so, mark it seen on unmount too. Dismissing already
  // saves, so it clears the ref to keep the cleanup from saving a second time.
  const shownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    shownKeyRef.current = key;
    shown(key);
  }, [open, key, shown]);

  const dismiss = () => {
    shownKeyRef.current = null;
    markSeen(stepId, scopedMeetingId);
  };

  useEffect(() => {
    if (!pending || !step) return;
    claim(key, instanceId, step.severity);
    return () => {
      release(key, instanceId);
      if (shownKeyRef.current === key) {
        shownKeyRef.current = null;
        markSeen(stepId, scopedMeetingId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, key, instanceId]);

  // The bubble is portaled to the end of <body> and deliberately takes no focus,
  // so screen readers need telling: the copy is a polite live region, and the
  // anchor points at it while it is open.
  const copyId = `${instanceId}-copy`;

  return (
    <PopoverPrimitive.Root open={open}>
      <PopoverPrimitive.Anchor asChild aria-describedby={open ? copyId : undefined}>
        {children}
      </PopoverPrimitive.Anchor>
      {open && step && (
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
              zIndex: HINT_Z_INDEX,
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
            {/* pre-line: longer copy separates its paragraphs with blank lines */}
            <span id={copyId} role="status" aria-live="polite" style={{ whiteSpace: 'pre-line' }}>
              {step.copy}
            </span>
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
