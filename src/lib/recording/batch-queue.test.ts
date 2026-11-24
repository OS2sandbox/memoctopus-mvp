// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setStorageUserId } from '@/lib/storage/scope';
import { putBatch, completeBatch, listBatches, getPendingAudio } from '@/lib/storage/recording';
import { getBatchQueue, type SealedBatch } from './batch-queue';

// Each test gets its own user's database and its own meeting (and so its own queue).
let meetingId: string;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setStorageUserId(crypto.randomUUID());
  meetingId = crypto.randomUUID();
  // Only the backoff timers are faked: fake-indexeddb schedules its work with setImmediate.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = (text = 'Hej.') => new Response(JSON.stringify({ text }), { status: 200 });
const serverError = () => new Response(JSON.stringify({ error: 'Transcription failed' }), { status: 502 });

function sealed(seq: number, session = 0): SealedBatch {
  return {
    seq,
    session,
    wav: new Uint8Array(16).fill(seq + 1).buffer,
    intervals: [{ originalStart: seq * 27, originalEnd: seq * 27 + 27, wavOffset: 0, wavDuration: 27 }],
    totalWavDuration: 27,
  };
}

// Lets IndexedDB and the queue's promise chains run without moving the faked clock.
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never held');
}

async function rowStatus(seq: number) {
  return (await listBatches(meetingId)).find((r) => r.seq === seq)?.status;
}

async function attempts(seq: number) {
  return (await listBatches(meetingId)).find((r) => r.seq === seq)?.attempts ?? 0;
}

describe('batch queue', () => {
  it('persists a batch and its audio before sending it, and deletes the audio once transcribed', async () => {
    let audioAtSend: ArrayBuffer | null = null;
    let statusAtSend: string | undefined;
    fetchMock.mockImplementation(async () => {
      audioAtSend = await getPendingAudio(meetingId, 0);
      statusAtSend = await rowStatus(0);
      return ok();
    });

    await getBatchQueue(meetingId).enqueue(sealed(0));
    await until(async () => (await rowStatus(0)) === 'done');

    expect(audioAtSend).not.toBeNull();
    expect(statusAtSend).toBe('pending');
    expect(await getPendingAudio(meetingId, 0)).toBeNull();
    expect((await listBatches(meetingId))[0].segments).toEqual([
      { speaker: 'Taler 1', start: 0, end: 27, text: 'Hej.' },
    ]);
    expect(getBatchQueue(meetingId).getState().waiting).toBe(0);
  });

  it('keeps a failing batch and retries it after 2 s, then 4 s, until it is transcribed', async () => {
    fetchMock
      .mockResolvedValueOnce(serverError())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(ok());
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    await until(async () => (await attempts(0)) === 1);
    expect(queue.getState().waiting).toBe(1);

    vi.advanceTimersByTime(1999);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await until(async () => (await attempts(0)) === 2);

    vi.advanceTimersByTime(3999);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await until(async () => (await rowStatus(0)) === 'done');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await getPendingAudio(meetingId, 0)).toBeNull();
    expect(queue.getState().waiting).toBe(0);
  });

  it('retries at once when the browser comes back online', async () => {
    fetchMock.mockResolvedValueOnce(serverError()).mockResolvedValue(ok());

    await getBatchQueue(meetingId).enqueue(sealed(0));
    await until(async () => (await attempts(0)) === 1);

    window.dispatchEvent(new Event('online'));
    await until(async () => (await rowStatus(0)) === 'done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adoptPersisted sends the open and pending batches a closed tab left behind', async () => {
    await putBatch({ ...sealed(0), meetingId, status: 'pending' }, sealed(0).wav);
    await putBatch({ ...sealed(1), meetingId, status: 'open' }, sealed(1).wav);
    await putBatch({ ...sealed(2), meetingId, status: 'pending' }, sealed(2).wav);
    await completeBatch(meetingId, 2, []);
    fetchMock.mockImplementation(async () => ok());

    const queue = getBatchQueue(meetingId);
    await queue.adoptPersisted();
    await until(async () => (await rowStatus(0)) === 'done' && (await rowStatus(1)) === 'done');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queue.getState().waiting).toBe(0);

    await queue.adoptPersisted();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never sends the checkpoint of the batch still being recorded', async () => {
    fetchMock.mockImplementation(async () => ok());
    const queue = getBatchQueue(meetingId);

    await queue.checkpoint(sealed(0));
    await queue.adoptPersisted();

    expect(await rowStatus(0)).toBe('open');
    expect(await getPendingAudio(meetingId, 0)).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a late checkpoint does not reopen a batch that was already sealed', async () => {
    fetchMock.mockImplementation(async () => ok());
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    await until(async () => (await rowStatus(0)) === 'done');
    await queue.checkpoint(sealed(0));

    expect(await rowStatus(0)).toBe('done');
  });

  it('still sends the batch from memory when IndexedDB refuses the write', async () => {
    fetchMock.mockImplementation(async () => ok());
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    put.mockRestore();
    await until(() => queue.getState().waiting === 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = (fetchMock.mock.calls[0][1].body as FormData).get('audio') as Blob;
    expect(sent.size).toBe(16);
    expect(queue.getState().persistFailed).toBe(true);
  });

  it('keeps the text and stores it again when writing it to the ledger fails', async () => {
    fetchMock.mockImplementation(async () => ok());
    const originalPut = IDBObjectStore.prototype.put;
    let refusals = 0;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if ((value as { status?: string }).status === 'done' && refusals === 0) {
        refusals++;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return originalPut.call(this, value, key);
    });
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    await until(() => refusals === 1 && queue.getState().persistFailed);
    await settle();

    // Not handled yet: still waiting, the row still pending and its audio still kept.
    expect(queue.getState().waiting).toBe(1);
    expect(await rowStatus(0)).toBe('pending');
    expect(await getPendingAudio(meetingId, 0)).not.toBeNull();

    vi.advanceTimersByTime(2_000);
    await until(async () => (await rowStatus(0)) === 'done');
    put.mockRestore();

    // Stored from the text it already had, without transcribing the audio again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await listBatches(meetingId))[0].segments).toEqual([
      { speaker: 'Taler 1', start: 0, end: 27, text: 'Hej.' },
    ]);
    expect(await getPendingAudio(meetingId, 0)).toBeNull();
    await until(() => queue.getState().waiting === 0);
  });

  it('reports persistFailed when counting a failed attempt cannot be written', async () => {
    fetchMock.mockResolvedValueOnce(serverError()).mockResolvedValue(ok());
    const queue = getBatchQueue(meetingId);
    await queue.enqueue(sealed(0));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    await until(() => queue.getState().persistFailed);
    put.mockRestore();
    expect(queue.getState().waiting).toBe(1);
  });

  it('has at most two requests in flight', async () => {
    const replies: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => replies.push(() => resolve(ok()))));
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    await queue.enqueue(sealed(1));
    await queue.enqueue(sealed(2));
    await until(() => fetchMock.mock.calls.length === 2);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    replies[0]();
    await until(() => fetchMock.mock.calls.length === 3);
    replies[1]();
    replies[2]();
    await until(() => queue.getState().waiting === 0);
  });

  it('stops on a 401 with authRequired set, and adoptPersisted resumes it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValue(ok());
    const queue = getBatchQueue(meetingId);

    await queue.enqueue(sealed(0));
    await until(() => queue.getState().authRequired);
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await queue.adoptPersisted();
    await until(async () => (await rowStatus(0)) === 'done');
    expect(queue.getState().authRequired).toBe(false);
  });

  it('notifies subscribers as the state changes', async () => {
    fetchMock.mockImplementation(async () => ok());
    const queue = getBatchQueue(meetingId);
    const seen: number[] = [];
    queue.subscribe(() => seen.push(queue.getState().waiting));

    await queue.enqueue(sealed(0));
    await until(() => queue.getState().waiting === 0);

    expect(seen).toContain(1);
    expect(seen.at(-1)).toBe(0);
  });
});
