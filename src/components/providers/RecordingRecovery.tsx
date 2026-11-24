'use client';

import { useEffect } from 'react';
import { getMeeting } from '@/lib/storage/meetings';
import { listMeetingIdsWithRecordingState, sweepExpiredPendingAudio } from '@/lib/storage/recording';
import { getBatchQueue } from '@/lib/recording/batch-queue';
import { finishRecording } from '@/lib/recording/finish';
import { connectivity } from '@/lib/recording/connectivity';

// Picks up recordings a closed tab left behind, wherever the user is in the app.
// Each run gives up on audio older than the ledger keeps it and sends what still
// waits. A stopped (`processing`) recording is settled by finishRecording, which
// also settles it later once its queue has sent everything. An interrupted
// (`recording`) one only has its waiting audio sent, so the audio is deleted as
// soon as it is transcribed; resuming or finishing it is left to the user.

const RUN_EVERY_MS = 60 * 60 * 1000;

/** Mounted once in the app layout; renders nothing. */
export function RecordingRecovery(): null {
  useEffect(() => {
    let runs: Promise<void> = Promise.resolve();

    async function recover(): Promise<void> {
      await sweepExpiredPendingAudio();
      for (const meetingId of await listMeetingIdsWithRecordingState()) {
        const status = (await getMeeting(meetingId))?.status;
        if (status === 'processing') await finishRecording(meetingId);
        else if (status === 'recording') await getBatchQueue(meetingId).adoptPersisted();
      }
    }

    // Runs one after another, so two runs never work on the same meeting at once.
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
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  return null;
}
