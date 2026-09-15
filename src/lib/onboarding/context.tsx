'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

type SeenStep = { stepId: string; meetingId: string | null };

type OnboardingContextValue = {
  isStepSeen: (stepId: string, meetingId?: string | null) => boolean;
  markSeen: (stepId: string, meetingId?: string | null) => void;
  isFirstTimeUser: boolean;
  showWelcome: boolean;
  openWelcome: () => void;
  closeWelcome: (skip?: boolean) => void;
  /**
   * One hint at a time, app-wide, so a page never shows several onboarding
   * bubbles at once. `claim` registers a step as pending (FIFO — first
   * mounted, first shown) and returns whether THIS instance owns the slot:
   * the same step id can wrap several DOM elements (e.g. a "Del" button
   * repeated once per card in a list), but only the first mounted instance
   * ever claims ownership, so only one bubble renders for that step no
   * matter how many elements reference it.
   */
  claim: (key: string, instanceId: string) => boolean;
  release: (key: string, instanceId: string) => void;
  isActive: (key: string, instanceId: string) => boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function seenKey(stepId: string, meetingId: string | null): string {
  return `${stepId}:${meetingId ?? ''}`;
}

export type OnboardingInitialState = {
  tourSkipped: boolean;
  tourCompleted: boolean;
  seen: SeenStep[];
};

export function OnboardingProvider({
  initial,
  children,
}: {
  initial: OnboardingInitialState;
  children: React.ReactNode;
}) {
  const [seen, setSeen] = useState<Set<string>>(
    () => new Set(initial.seen.map((s) => seenKey(s.stepId, s.meetingId))),
  );
  const isFirstTimeUser = !initial.tourSkipped && !initial.tourCompleted && initial.seen.length === 0;
  const [showWelcome, setShowWelcome] = useState(isFirstTimeUser);

  // FIFO queue of pending (unseen, mounted) hint keys and which component
  // instance owns each one. Not reactive state on its own — `queueVersion`
  // is bumped to force a re-render whenever the queue changes, since the
  // queue/owners themselves live in refs to avoid tearing between the many
  // OnboardingHint instances that read and mutate them during render/effects.
  const queueRef = useRef<string[]>([]);
  const ownersRef = useRef<Map<string, string>>(new Map());
  const [queueVersion, setQueueVersion] = useState(0);

  const isStepSeen = useCallback(
    (stepId: string, meetingId: string | null = null) => seen.has(seenKey(stepId, meetingId)),
    [seen],
  );

  const claim = useCallback((key: string, instanceId: string): boolean => {
    const owners = ownersRef.current;
    if (!owners.has(key)) {
      owners.set(key, instanceId);
      queueRef.current = [...queueRef.current, key];
      setQueueVersion((v) => v + 1);
      return true;
    }
    return owners.get(key) === instanceId;
  }, []);

  const release = useCallback((key: string, instanceId: string) => {
    const owners = ownersRef.current;
    if (owners.get(key) !== instanceId) return;
    owners.delete(key);
    queueRef.current = queueRef.current.filter((k) => k !== key);
    setQueueVersion((v) => v + 1);
  }, []);

  const isActive = useCallback(
    (key: string, instanceId: string): boolean => {
      void queueVersion; // subscribe to queue changes
      if (ownersRef.current.get(key) !== instanceId) return false;
      return queueRef.current[0] === key;
    },
    [queueVersion],
  );

  const markSeen = useCallback((stepId: string, meetingId: string | null = null) => {
    const key = seenKey(stepId, meetingId);
    setSeen((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    if (ownersRef.current.has(key)) {
      ownersRef.current.delete(key);
      queueRef.current = queueRef.current.filter((k) => k !== key);
      setQueueVersion((v) => v + 1);
    }
    // Fire-and-forget: a lost write just means this hint reshows once next visit,
    // which is an acceptable cost for onboarding copy.
    fetch('/api/onboarding/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepId, meetingId }),
    }).catch(() => {});
  }, []);

  const openWelcome = useCallback(() => setShowWelcome(true), []);

  const closeWelcome = useCallback((skip?: boolean) => {
    setShowWelcome(false);
    if (skip) {
      fetch('/api/onboarding/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip-tour' }),
      }).catch(() => {});
    }
  }, []);

  const value = useMemo(
    () => ({
      isStepSeen,
      markSeen,
      isFirstTimeUser,
      showWelcome,
      openWelcome,
      closeWelcome,
      claim,
      release,
      isActive,
    }),
    [isStepSeen, markSeen, isFirstTimeUser, showWelcome, openWelcome, closeWelcome, claim, release, isActive],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within an OnboardingProvider');
  return ctx;
}
