'use client';

import { useEffect } from 'react';
import { getMeeting, updateMeeting } from '@/lib/storage/meetings';
import { getAudio } from '@/lib/storage/audio';
import {
  finalizeRecordingToTranscript,
  listMeetingIdsWithRecordingState,
  sweepExpiredPendingAudio,
} from '@/lib/storage/recording';
import { getBatchQueue } from '@/lib/recording/batch-queue';
import { connectivity } from '@/lib/recording/connectivity';

// Finishes recordings that were stopped before all their audio was transcribed,
// wherever the user is in the app and whether or not the tab that recorded them is
// still open. Each run gives up on audio older than the ledger keeps it, sends what
// still waits, and turns a meeting's ledger into its transcript once nothing waits.
// A meeting still `recording` with ledger rows was interrupted, not stopped: it is
// left for the user to resume or finish.

const RUN_EVERY_MS = 60 * 60 * 1000;

/** Mounted once in the app layout; renders nothing. */
export function RecordingRecovery(): null {
  useEffect(() => {
    // One drain watcher per meeting, however many runs find it.
    const watchers = new Map<string, () => void>();
    let runs: Promise<void> = Promise.resolve();
    // A run still going at unmount (React's dev double mount) must not leave a watcher behind.
    let unmounted = false;

    async function finalise(meetingId: string): Promise<void> {
      watchers.get(meetingId)?.();
      watchers.delete(meetingId);
      // A recording finished in an open tab may have stored its audio; that one
      // keeps its playback and gets the review's diarization. Otherwise there is no
      // audio to play or diarize, and the speakers stay as transcribed. audioDeleted
      // is written before the status, so the meeting never reaches `review` without it.
      const hasAudio = (await getAudio(meetingId)) !== null;
      if (!hasAudio) await updateMeeting(meetingId, { audioDeleted: true });
      await finalizeRecordingToTranscript(meetingId, {
        diarizationStatus: hasAudio ? 'pending' : 'done',
      });
    }

    function finaliseLogged(meetingId: string): void {
      finalise(meetingId).catch((err: unknown) => {
        console.error(`[RecordingRecovery] finalising ${meetingId} failed, retrying on the next run:`, err);
      });
    }

    async function drain(meetingId: string): Promise<void> {
      const queue = getBatchQueue(meetingId);
      await queue.adoptPersisted();
      if (queue.getState().waiting === 0) return finalise(meetingId);
      if (unmounted || watchers.has(meetingId)) return;
      watchers.set(meetingId, queue.subscribe(() => {
        if (queue.getState().waiting === 0) finaliseLogged(meetingId);
      }));
    }

    async function recover(): Promise<void> {
      await sweepExpiredPendingAudio();
      for (const meetingId of await listMeetingIdsWithRecordingState()) {
        if ((await getMeeting(meetingId))?.status !== 'processing') continue;
        await drain(meetingId);
      }
    }

    // Runs one after another, so two runs never work on the same meeting at once.
    // A watcher may finalise beside a run; finalizeRecordingToTranscript is idempotent.
    function run(): void {
      runs = runs.then(recover).catch((err: unknown) => {
        console.error('[RecordingRecovery] recovering recordings failed, retrying on the next run:', err);
      });
    }

    run();
    const unsubscribe = connectivity.subscribe(() => {
      if (connectivity.isOnline()) run();
    });
    const timer = setInterval(run, RUN_EVERY_MS);
    return () => {
      unmounted = true;
      unsubscribe();
      clearInterval(timer);
      for (const stop of watchers.values()) stop();
      watchers.clear();
    };
  }, []);
  return null;
}
