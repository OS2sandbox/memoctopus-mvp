'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

type SeenStep = { stepId: string; meetingId: string | null };

type OnboardingContextValue = {
  isStepSeen: (stepId: string, meetingId?: string | null) => boolean;
  markSeen: (stepId: string, meetingId?: string | null) => void;
  isFirstTimeUser: boolean;
  showWelcome: boolean;
  openWelcome: () => void;
  closeWelcome: (skip?: boolean) => void;
  /** "kom i gang": closes the welcome dialog and makes every hint show again. */
  startTour: () => void;
  /**
   * One hint at a time, app-wide, so a page never shows several onboarding
   * bubbles at once. `claim` registers a step as pending (FIFO — first
   * mounted, first shown) and returns whether THIS instance owns the slot:
   * the same step id can wrap several DOM elements (e.g. a "Del" button
   * repeated once per card in a list), but only one instance owns the slot
   * at a time, so only one bubble renders for that step no matter how many
   * elements reference it. The other instances wait behind the owner and the
   * next one takes over (keeping the step's place in the queue) when the
   * owner releases.
   */
  claim: (key: string, instanceId: string) => boolean;
  release: (key: string, instanceId: string) => void;
  isActive: (key: string, instanceId: string) => boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function seenKey(stepId: string, meetingId: string | null): string {
  return `${stepId}:${meetingId ?? ''}`;
}

export type OnboardingInitialState = {
  tourSkipped: boolean;
  tourCompleted: boolean;
  seen: SeenStep[];
  /**
   * The server could not load this user's onboarding state (for example a database
   * error). Show nothing rather than everything: an empty `seen` list would otherwise
   * look like a brand-new user and open the welcome dialog and every hint.
   */
  unavailable?: boolean;
};

// Fire-and-forget save. A lost write only means a hint shows once more next visit, which
// is fine for onboarding copy, but a server-side rejection should be visible in the console
// instead of being swallowed. Offline (fetch rejects) is expected and stays quiet.
async function postStep(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch('/api/onboarding/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[onboarding] could not save (HTTP ${res.status})`, body);
  } catch {
    // offline or aborted
  }
}

// While the client fetch below is in flight, behave exactly like "the server could not
// load state" (see OnboardingInitialState.unavailable) — show nothing rather than
// flashing the welcome dialog and every hint open before we actually know.
const LOADING_STATE: OnboardingInitialState = {
  tourSkipped: false,
  tourCompleted: false,
  seen: [],
  unavailable: true,
};

/**
 * `initial` is optional: pass it (tests, or a caller that already has the state) to skip
 * the fetch entirely and behave synchronously, exactly as before. Omit it — the real
 * app does — and this fetches `/api/onboarding/state` itself on mount instead of the
 * server component that renders this having to await a DB round trip on every
 * authenticated page load just for a client-interactive nicety.
 */
export function OnboardingProvider({
  initial,
  children,
}: {
  initial?: OnboardingInitialState;
  children: React.ReactNode;
}) {
  const [fetched, setFetched] = useState<OnboardingInitialState | null>(null);
  const current = initial ?? fetched ?? LOADING_STATE;

  useEffect(() => {
    if (initial !== undefined) return; // caller already has the state
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/onboarding/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as OnboardingInitialState;
        if (!cancelled) setFetched(data);
      } catch (err) {
        console.error('[onboarding] could not load state; continuing without onboarding', err);
        if (!cancelled) setFetched({ tourSkipped: false, tourCompleted: false, seen: [], unavailable: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seeded from `initial` when the caller has it synchronously (tests, or a caller
  // that already fetched); otherwise starts empty and is re-seeded once by the effect
  // below when the fetch resolves. Independent state from then on — markSeen/startTour
  // mutate it locally, ahead of the save reaching the server.
  const [seen, setSeen] = useState<Set<string>>(
    () => new Set((initial ?? LOADING_STATE).seen.map((s) => seenKey(s.stepId, s.meetingId))),
  );
  // Mirrors `seen`, but as a ref: markSeen reads this synchronously to decide whether to
  // POST, and React 18 batches setState updaters (their timing relative to the rest of
  // the call is not guaranteed), so that decision cannot be made inside setSeen's updater.
  const postedRef = useRef<Set<string>>(new Set(seen));
  useEffect(() => {
    if (fetched) {
      const keys = new Set(fetched.seen.map((s) => seenKey(s.stepId, s.meetingId)));
      setSeen(keys);
      postedRef.current = new Set(keys);
    }
  }, [fetched]);

  const unavailable = current.unavailable === true;
  const isFirstTimeUser =
    !unavailable && !current.tourSkipped && !current.tourCompleted && current.seen.length === 0;
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => {
    if (isFirstTimeUser) setShowWelcome(true);
  }, [isFirstTimeUser]);

  // FIFO queue of pending (unseen, mounted) hint keys and the component
  // instances waiting on each one (the first is the owner). Not reactive
  // state on its own — `queueVersion` is bumped to force a re-render whenever
  // the queue changes, since the queue/claimants themselves live in refs to
  // avoid tearing between the many OnboardingHint instances that read and
  // mutate them during render/effects.
  const queueRef = useRef<string[]>([]);
  const claimantsRef = useRef<Map<string, string[]>>(new Map());
  const [queueVersion, setQueueVersion] = useState(0);

  const isStepSeen = useCallback(
    (stepId: string, meetingId: string | null = null) =>
      unavailable || seen.has(seenKey(stepId, meetingId)),
    [seen, unavailable],
  );

  const claim = useCallback((key: string, instanceId: string): boolean => {
    const claimants = claimantsRef.current;
    const waiting = claimants.get(key);
    if (!waiting) {
      claimants.set(key, [instanceId]);
      queueRef.current = [...queueRef.current, key];
      setQueueVersion((v) => v + 1);
      return true;
    }
    if (!waiting.includes(instanceId)) waiting.push(instanceId);
    return waiting[0] === instanceId;
  }, []);

  const release = useCallback((key: string, instanceId: string) => {
    const claimants = claimantsRef.current;
    const waiting = claimants.get(key);
    if (!waiting?.includes(instanceId)) return;
    const rest = waiting.filter((id) => id !== instanceId);
    if (rest.length > 0) {
      // Another instance of the same step is still mounted: it inherits the slot
      // (and the step's place in the queue) instead of the hint silently vanishing.
      claimants.set(key, rest);
    } else {
      claimants.delete(key);
      queueRef.current = queueRef.current.filter((k) => k !== key);
    }
    setQueueVersion((v) => v + 1);
  }, []);

  const isActive = useCallback(
    (key: string, instanceId: string): boolean => {
      void queueVersion; // subscribe to queue changes
      if (claimantsRef.current.get(key)?.[0] !== instanceId) return false;
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
    if (claimantsRef.current.has(key)) {
      claimantsRef.current.delete(key);
      queueRef.current = queueRef.current.filter((k) => k !== key);
      setQueueVersion((v) => v + 1);
    }
    // postedRef, not `seen`/the updater above: an already-seen step (from `initial`,
    // a prior call this session, or a duplicate call arriving before the matching
    // setSeen has committed) must not re-POST.
    if (!postedRef.current.has(key)) {
      postedRef.current.add(key);
      void postStep({ stepId, meetingId });
    }
  }, []);

  const openWelcome = useCallback(() => setShowWelcome(true), []);

  const closeWelcome = useCallback((skip?: boolean) => {
    setShowWelcome(false);
    if (skip) void postStep({ action: 'skip-tour' });
  }, []);

  const startTour = useCallback(() => {
    setShowWelcome(false);
    setSeen(new Set());
    postedRef.current = new Set();
    void postStep({ action: 'reset-hints' });
  }, []);

  const value = useMemo(
    () => ({
      isStepSeen,
      markSeen,
      isFirstTimeUser,
      showWelcome,
      openWelcome,
      closeWelcome,
      startTour,
      claim,
      release,
      isActive,
    }),
    [isStepSeen, markSeen, isFirstTimeUser, showWelcome, openWelcome, closeWelcome, startTour, claim, release, isActive],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {/*
        One Provider for every OnboardingTooltip in the tree — including the ones
        that remount on every new live-transcript segment during recording — instead
        of each mounting its own. Radix's Tooltip.Root reads this via context; the
        delay here is the shared default.
      */}
      <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within an OnboardingProvider');
  return ctx;
}
