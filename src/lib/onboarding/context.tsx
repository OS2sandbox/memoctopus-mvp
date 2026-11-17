'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ONE_TIME_HINT_IDS, type OnboardingStep } from './steps';

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
   * bubbles at once. `claim` registers a step as pending; the one shown next is
   * the highest-severity pending step, first claimed among equals, so a new
   * user meets "optag" before the Arkiv explainer. A bubble already on screen
   * (reported with `shown`) keeps the slot until it is dismissed or unmounted,
   * even if a more important step mounts meanwhile: it never jumps away mid-read.
   *
   * The same step id can wrap several DOM elements (e.g. a "Del" button
   * repeated once per card in a list), but only one instance owns the slot
   * at a time, so only one bubble renders for that step no matter how many
   * elements reference it. The other instances wait behind the owner and the
   * next one takes over (keeping the step's place in the queue) when the
   * owner releases.
   */
  claim: (key: string, instanceId: string, severity: OnboardingStep['severity']) => void;
  release: (key: string, instanceId: string) => void;
  isActive: (key: string, instanceId: string) => boolean;
  shown: (key: string) => void;
};

const SEVERITY_RANK: Record<OnboardingStep['severity'], number> = { high: 3, medium: 2, low: 1 };

type Pending = { key: string; rank: number };

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

  // Seeded from `initial` when the caller has it synchronously (tests, or a caller
  // that already fetched); otherwise starts empty and is seeded by the fetch below
  // when it resolves. Independent state from then on — markSeen/startTour mutate it
  // locally, ahead of the save reaching the server.
  const [seen, setSeen] = useState<Set<string>>(
    () => new Set((initial ?? LOADING_STATE).seen.map((s) => seenKey(s.stepId, s.meetingId))),
  );
  // Mirrors `seen`, but as a ref: markSeen reads this synchronously to decide whether to
  // POST, and React 18 batches setState updaters (their timing relative to the rest of
  // the call is not guaranteed), so that decision cannot be made inside setSeen's updater.
  const postedRef = useRef<Set<string>>(new Set(seen));

  useEffect(() => {
    if (initial !== undefined) return; // caller already has the state
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/onboarding/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as OnboardingInitialState;
        if (cancelled) return;
        // Seed `seen` in the same batch as `fetched`, so no render ever has the
        // loaded state with the still-empty seen set (every hint unseen).
        const keys = new Set(data.seen.map((s) => seenKey(s.stepId, s.meetingId)));
        postedRef.current = new Set(keys);
        setSeen(keys);
        setFetched(data);
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

  const unavailable = current.unavailable === true;
  const isFirstTimeUser =
    !unavailable && !current.tourSkipped && !current.tourCompleted && current.seen.length === 0;
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => {
    if (isFirstTimeUser) setShowWelcome(true);
  }, [isFirstTimeUser]);

  // Pending (unseen, mounted) hint keys in claim order, the component instances
  // waiting on each one (the first is the owner), and the key whose bubble is on
  // screen. Not reactive state on its own — `queueVersion` is bumped to force a
  // re-render whenever the queue changes, since these live in refs to avoid
  // tearing between the many OnboardingHint instances that read and mutate them
  // during render/effects.
  const queueRef = useRef<Pending[]>([]);
  const claimantsRef = useRef<Map<string, string[]>>(new Map());
  const shownRef = useRef<string | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);

  const isStepSeen = useCallback(
    (stepId: string, meetingId: string | null = null) =>
      unavailable || seen.has(seenKey(stepId, meetingId)),
    [seen, unavailable],
  );

  const dropFromQueue = useCallback((key: string) => {
    claimantsRef.current.delete(key);
    queueRef.current = queueRef.current.filter((p) => p.key !== key);
    if (shownRef.current === key) shownRef.current = null;
    setQueueVersion((v) => v + 1);
  }, []);

  const claim = useCallback((key: string, instanceId: string, severity: OnboardingStep['severity']) => {
    const waiting = claimantsRef.current.get(key);
    if (waiting) {
      if (!waiting.includes(instanceId)) waiting.push(instanceId);
      return;
    }
    claimantsRef.current.set(key, [instanceId]);
    queueRef.current = [...queueRef.current, { key, rank: SEVERITY_RANK[severity] }];
    setQueueVersion((v) => v + 1);
  }, []);

  const release = useCallback(
    (key: string, instanceId: string) => {
      const waiting = claimantsRef.current.get(key);
      if (!waiting?.includes(instanceId)) return;
      const rest = waiting.filter((id) => id !== instanceId);
      if (rest.length === 0) {
        dropFromQueue(key);
        return;
      }
      // Another instance of the same step is still mounted: it inherits the slot
      // (and the step's place in the queue) instead of the hint silently vanishing.
      claimantsRef.current.set(key, rest);
      setQueueVersion((v) => v + 1);
    },
    [dropFromQueue],
  );

  const isActive = useCallback(
    (key: string, instanceId: string): boolean => {
      void queueVersion; // subscribe to queue changes
      if (claimantsRef.current.get(key)?.[0] !== instanceId) return false;
      const queue = queueRef.current;
      const onScreen = shownRef.current;
      if (onScreen && queue.some((p) => p.key === onScreen)) return onScreen === key;
      // Highest severity first; `>` rather than `>=` keeps the first claimed among equals.
      let head: Pending | undefined;
      for (const p of queue) if (!head || p.rank > head.rank) head = p;
      return head?.key === key;
    },
    [queueVersion],
  );

  const shown = useCallback((key: string) => {
    shownRef.current = key;
  }, []);

  const markSeen = useCallback(
    (stepId: string, meetingId: string | null = null) => {
      const key = seenKey(stepId, meetingId);
      setSeen((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      if (claimantsRef.current.has(key)) dropFromQueue(key);
      // postedRef, not `seen`/the updater above: an already-seen step (from `initial`,
      // a prior call this session, or a duplicate call arriving before the matching
      // setSeen has committed) must not re-POST.
      if (!postedRef.current.has(key)) {
        postedRef.current.add(key);
        void postStep({ stepId, meetingId });
      }
    },
    [dropFromQueue],
  );

  const openWelcome = useCallback(() => setShowWelcome(true), []);

  const closeWelcome = useCallback((skip?: boolean) => {
    setShowWelcome(false);
    if (!skip) return;
    // Mirrors the server's skip-tour, which marks every one-time hint seen, so none
    // of them pops up for the rest of this visit either.
    const keys = ONE_TIME_HINT_IDS.map((id) => seenKey(id, null));
    setSeen((prev) => new Set([...prev, ...keys]));
    keys.forEach((k) => postedRef.current.add(k));
    void postStep({ action: 'skip-tour' });
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
      shown,
    }),
    [isStepSeen, markSeen, isFirstTimeUser, showWelcome, openWelcome, closeWelcome, startTour, claim, release, isActive, shown],
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
