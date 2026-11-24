import type { VadInterval } from '@/lib/audio/vad-batch';
import type { TranscriptSegment } from '@/types';
import {
  putBatch,
  completeBatch,
  markAttempt,
  listBatches,
  getPendingAudio,
} from '@/lib/storage/recording';
import { transcribeBatch } from './transcribe-batch';
import { connectivity } from './connectivity';

// Sends a recording's sealed batches to transcription and keeps every one of them
// until it has its text. A batch is written to the ledger (with its audio) before it
// is sent; a failed send keeps it and tries again with backoff, for as long as the
// audio is kept (the ledger expires it after 24 h). One queue per meeting, held in a
// module registry so it outlives the screen that recorded it.

export type SealedBatch = {
  seq: number;
  session: number;
  // 16 kHz PCM16 WAV.
  wav: ArrayBuffer;
  intervals: VadInterval[];
  totalWavDuration: number;
};

type QueueState = {
  // Batches this queue holds that have no text yet, in flight or waiting to retry.
  waiting: number;
  // The last send got a 401. Sending stops until adoptPersisted() is called again.
  authRequired: boolean;
  // IndexedDB refused a write (quota, private mode): some audio exists only in
  // memory, and closing the tab before it is sent loses it.
  persistFailed: boolean;
};

// Leaves room on the connection and on the hviske server for live captions.
const MAX_IN_FLIGHT = 2;
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

type Entry = Omit<SealedBatch, 'wav'> & {
  // Only when the ledger write failed; otherwise the audio is read back from the
  // ledger at send time, so a long offline stretch does not pile up in memory.
  wav: ArrayBuffer | null;
  // The text, once transcribed, until the ledger has stored it. A failed store is
  // retried from here rather than by transcribing the audio again.
  segments: TranscriptSegment[] | null;
  failures: number;
  inFlight: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

type BatchQueue = ReturnType<typeof createQueue>;

function createQueue(meetingId: string) {
  const entries = new Map<number, Entry>();
  // Seqs that got their text or have no audio left; a later ledger read must not
  // send them again.
  const settled = new Set<number>();
  // Seqs sealed in this tab; a checkpoint of one arriving late must not reopen it.
  const sealed = new Set<number>();
  // The batch still being recorded in this tab, checkpointed but not sealed.
  let openSeq: number | null = null;
  let authRequired = false;
  let persistFailed = false;
  let state: QueueState = { waiting: 0, authRequired, persistFailed };
  const listeners = new Set<() => void>();
  // Ledger writes run one after another, so a checkpoint cannot land after the
  // write that sealed the same batch.
  let writes: Promise<unknown> = Promise.resolve();

  function serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = writes.then(write);
    writes = run.catch(() => undefined);
    return run;
  }

  // getState() returns the same object until something changes, as
  // useSyncExternalStore requires.
  function publish(): void {
    const next: QueueState = { waiting: entries.size, authRequired, persistFailed };
    if (
      next.waiting === state.waiting &&
      next.authRequired === state.authRequired &&
      next.persistFailed === state.persistFailed
    ) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function add(entry: Entry): void {
    entries.set(entry.seq, entry);
    publish();
    pump();
  }

  function pump(): void {
    if (authRequired) return;
    let inFlight = [...entries.values()].filter((e) => e.inFlight).length;
    const ready = [...entries.values()]
      .filter((e) => !e.inFlight && e.retryTimer === null)
      .sort((a, b) => a.seq - b.seq);
    for (const entry of ready) {
      if (inFlight >= MAX_IN_FLIGHT) break;
      inFlight++;
      void send(entry);
    }
  }

  function scheduleRetry(entry: Entry): void {
    entry.inFlight = false;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      pump();
    }, BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length - 1)]);
    entry.failures++;
  }

  async function readAudio(entry: Entry): Promise<ArrayBuffer | null | 'unreadable'> {
    if (entry.wav) return entry.wav;
    try {
      return await getPendingAudio(meetingId, entry.seq);
    } catch (err) {
      console.error('[batch-queue] reading a batch\'s audio failed, retrying:', err);
      return 'unreadable';
    }
  }

  // Writes the text and deletes the audio. Until that commits the batch stays
  // waiting (so `waiting: 0` means every text is in the ledger) and keeps its audio.
  async function store(entry: Entry, segments: TranscriptSegment[]): Promise<void> {
    try {
      await serialized(() => completeBatch({ ...entry, meetingId }, segments));
    } catch (err) {
      console.error('[batch-queue] storing a transcribed batch failed, retrying:', err);
      entry.segments = segments;
      persistFailed = true;
      scheduleRetry(entry);
      return;
    }
    settled.add(entry.seq);
    entries.delete(entry.seq);
  }

  async function send(entry: Entry): Promise<void> {
    entry.inFlight = true;
    if (entry.segments) {
      await store(entry, entry.segments);
      publish();
      pump();
      return;
    }
    const wav = await readAudio(entry);
    if (wav === 'unreadable') {
      scheduleRetry(entry);
      return;
    }
    if (!wav) {
      // The audio is gone: expired into a `lost` row, or the meeting was deleted.
      // There is nothing left to send; finalising the ledger shows the gap. Counted as
      // settled so adoptPersisted() does not queue it again on every call.
      settled.add(entry.seq);
      entries.delete(entry.seq);
      publish();
      pump();
      return;
    }

    const result = await transcribeBatch(meetingId, { ...entry, wav });
    switch (result.kind) {
      case 'text':
        await store(entry, result.segments);
        break;
      case 'auth':
        entry.inFlight = false;
        authRequired = true;
        break;
      case 'retry':
        scheduleRetry(entry);
        // A refused write here means IndexedDB is refusing writes, which the
        // screen must hear about; the count itself is only informational.
        void serialized(() => markAttempt(meetingId, entry.seq)).catch((err: unknown) => {
          console.error('[batch-queue] counting an attempt failed:', err);
          persistFailed = true;
          publish();
        });
        break;
    }
    publish();
    pump();
  }

  // Tries every waiting batch now, with the backoff started over.
  function retryNow(): void {
    for (const entry of entries.values()) {
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      entry.failures = 0;
    }
    pump();
  }

  // One small object and one listener per meeting per tab, kept until the page reloads.
  // shortcut: the queue and this subscription are never released, revisit if one tab handles many recordings without a reload
  connectivity.subscribe(() => {
    if (connectivity.isOnline()) retryNow();
  });

  return {
    /** Writes the batch still being recorded, so a closed tab loses at most the utterance in progress. */
    async checkpoint(batch: SealedBatch): Promise<void> {
      if (sealed.has(batch.seq)) return;
      openSeq = batch.seq;
      await serialized(() => putBatch({ ...batch, meetingId, status: 'open' }, batch.wav)).catch((err: unknown) => {
        console.error('[batch-queue] checkpoint failed:', err);
        persistFailed = true;
        publish();
      });
    },

    /** Persists a sealed batch and queues it for transcription. Resolves once the write is done or has failed. */
    async enqueue(batch: SealedBatch): Promise<void> {
      sealed.add(batch.seq);
      if (openSeq === batch.seq) openSeq = null;
      let wav: ArrayBuffer | null = null;
      await serialized(() => putBatch({ ...batch, meetingId, status: 'pending' }, batch.wav)).catch((err: unknown) => {
        console.error('[batch-queue] storing a batch failed, sending it from memory:', err);
        persistFailed = true;
        wav = batch.wav;
      });
      add({ ...batch, wav, segments: null, failures: 0, inFlight: false, retryTimer: null });
    },

    /**
     * Queues the open and pending batches the ledger holds for this meeting (left by
     * a closed tab or an earlier session), clears authRequired and retries at once.
     */
    async adoptPersisted(): Promise<void> {
      authRequired = false;
      const rows = await listBatches(meetingId);
      for (const row of rows) {
        if (row.status !== 'open' && row.status !== 'pending') continue;
        if (row.seq === openSeq || entries.has(row.seq) || settled.has(row.seq)) continue;
        entries.set(row.seq, {
          seq: row.seq,
          session: row.session,
          intervals: row.intervals,
          totalWavDuration: row.totalWavDuration,
          wav: null,
          segments: null,
          failures: 0,
          inFlight: false,
          retryTimer: null,
        });
      }
      publish();
      retryNow();
    },

    getState(): QueueState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const queues = new Map<string, BatchQueue>();

export function getBatchQueue(meetingId: string): BatchQueue {
  let queue = queues.get(meetingId);
  if (!queue) {
    queue = createQueue(meetingId);
    queues.set(meetingId, queue);
  }
  return queue;
}
