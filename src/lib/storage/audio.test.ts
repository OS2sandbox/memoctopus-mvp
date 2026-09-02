import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveAudio, getAudio, deleteAudio } from './audio';

// In-memory store that mimics the 'audio' object store keyed by meetingId.
const store = new Map<string, { meetingId: string; blob: Blob; mimeType: string }>();

const mockDb = {
  put: vi.fn((_store: string, value: { meetingId: string; blob: Blob; mimeType: string }) => {
    store.set(value.meetingId, value);
    return Promise.resolve();
  }),
  get: vi.fn((_store: string, key: string) => {
    return Promise.resolve(store.get(key) ?? undefined);
  }),
  delete: vi.fn((_store: string, key: string) => {
    store.delete(key);
    return Promise.resolve();
  }),
};

vi.mock('./db', () => ({
  getDB: vi.fn(() => Promise.resolve(mockDb)),
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeBlob(content = 'audio-bytes', type = 'audio/webm'): Blob {
  return new Blob([content], { type });
}

// ─── saveAudio ────────────────────────────────────────────────────────────────

describe('saveAudio', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('stores the blob and mimeType keyed by meetingId', async () => {
    const blob = makeBlob();
    await saveAudio('meeting-1', blob, 'audio/webm');

    expect(store.size).toBe(1);
    const record = store.get('meeting-1');
    expect(record).toBeDefined();
    expect(record!.meetingId).toBe('meeting-1');
    expect(record!.blob).toBe(blob);
    expect(record!.mimeType).toBe('audio/webm');
  });

  it('calls db.put with the correct store name and value', async () => {
    const blob = makeBlob('hello', 'audio/ogg');
    await saveAudio('meeting-2', blob, 'audio/ogg');

    expect(mockDb.put).toHaveBeenCalledOnce();
    expect(mockDb.put).toHaveBeenCalledWith('audio', {
      meetingId: 'meeting-2',
      blob,
      mimeType: 'audio/ogg',
    });
  });

  it('overwrites an existing record for the same meetingId', async () => {
    const blob1 = makeBlob('first');
    const blob2 = makeBlob('second');

    await saveAudio('meeting-3', blob1, 'audio/webm');
    await saveAudio('meeting-3', blob2, 'audio/mp4');

    const record = store.get('meeting-3');
    expect(record!.blob).toBe(blob2);
    expect(record!.mimeType).toBe('audio/mp4');
  });

  it('stores multiple independent meetings', async () => {
    await saveAudio('m-a', makeBlob('a'), 'audio/webm');
    await saveAudio('m-b', makeBlob('b'), 'audio/ogg');

    expect(store.size).toBe(2);
    expect(store.get('m-a')!.mimeType).toBe('audio/webm');
    expect(store.get('m-b')!.mimeType).toBe('audio/ogg');
  });

  it('returns undefined (void) on success', async () => {
    const result = await saveAudio('meeting-x', makeBlob(), 'audio/webm');
    expect(result).toBeUndefined();
  });

  it('accepts various mimeType strings', async () => {
    const types = ['audio/webm', 'audio/ogg', 'audio/mp4', 'video/webm'];
    for (const mimeType of types) {
      store.clear();
      await saveAudio('m', makeBlob(), mimeType);
      expect(store.get('m')!.mimeType).toBe(mimeType);
    }
  });
});

// ─── getAudio ─────────────────────────────────────────────────────────────────

describe('getAudio', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('returns the stored record when it exists', async () => {
    const blob = makeBlob();
    store.set('meeting-1', { meetingId: 'meeting-1', blob, mimeType: 'audio/webm' });

    const result = await getAudio('meeting-1');

    expect(result).not.toBeNull();
    expect(result!.meetingId).toBe('meeting-1');
    expect(result!.blob).toBe(blob);
    expect(result!.mimeType).toBe('audio/webm');
  });

  it('returns null when meetingId is absent', async () => {
    const result = await getAudio('does-not-exist');
    expect(result).toBeNull();
  });

  it('calls db.get with the correct store name and key', async () => {
    await getAudio('meeting-check');
    expect(mockDb.get).toHaveBeenCalledOnce();
    expect(mockDb.get).toHaveBeenCalledWith('audio', 'meeting-check');
  });

  it('returns null for an empty store', async () => {
    expect(store.size).toBe(0);
    const result = await getAudio('anything');
    expect(result).toBeNull();
  });

  it('returns null after a record for a different meetingId was saved', async () => {
    store.set('other', { meetingId: 'other', blob: makeBlob(), mimeType: 'audio/webm' });
    const result = await getAudio('not-other');
    expect(result).toBeNull();
  });

  it('retrieves the correct record when multiple meetings are stored', async () => {
    const blobA = makeBlob('data-a');
    const blobB = makeBlob('data-b');
    store.set('m-a', { meetingId: 'm-a', blob: blobA, mimeType: 'audio/ogg' });
    store.set('m-b', { meetingId: 'm-b', blob: blobB, mimeType: 'audio/mp4' });

    const resultA = await getAudio('m-a');
    const resultB = await getAudio('m-b');

    expect(resultA!.blob).toBe(blobA);
    expect(resultB!.blob).toBe(blobB);
  });

  it('returns a record with the correct StoredAudio shape', async () => {
    const blob = makeBlob();
    store.set('shape-test', { meetingId: 'shape-test', blob, mimeType: 'audio/webm' });

    const result = await getAudio('shape-test');

    expect(result).toEqual({ meetingId: 'shape-test', blob, mimeType: 'audio/webm' });
  });
});

// ─── deleteAudio ──────────────────────────────────────────────────────────────

describe('deleteAudio', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('removes the stored record', async () => {
    store.set('meeting-1', { meetingId: 'meeting-1', blob: makeBlob(), mimeType: 'audio/webm' });
    expect(store.has('meeting-1')).toBe(true);

    await deleteAudio('meeting-1');

    expect(store.has('meeting-1')).toBe(false);
  });

  it('calls db.delete with the correct store name and key', async () => {
    await deleteAudio('meeting-del');
    expect(mockDb.delete).toHaveBeenCalledOnce();
    expect(mockDb.delete).toHaveBeenCalledWith('audio', 'meeting-del');
  });

  it('is a no-op when the meetingId does not exist', async () => {
    await expect(deleteAudio('ghost')).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('returns undefined (void) on success', async () => {
    store.set('m', { meetingId: 'm', blob: makeBlob(), mimeType: 'audio/webm' });
    const result = await deleteAudio('m');
    expect(result).toBeUndefined();
  });

  it('does not remove other records', async () => {
    store.set('keep', { meetingId: 'keep', blob: makeBlob(), mimeType: 'audio/webm' });
    store.set('remove', { meetingId: 'remove', blob: makeBlob(), mimeType: 'audio/webm' });

    await deleteAudio('remove');

    expect(store.has('keep')).toBe(true);
    expect(store.has('remove')).toBe(false);
  });

  it('leaves the store empty after deleting the only record', async () => {
    store.set('solo', { meetingId: 'solo', blob: makeBlob(), mimeType: 'audio/webm' });
    await deleteAudio('solo');
    expect(store.size).toBe(0);
  });
});

// ─── round-trip ───────────────────────────────────────────────────────────────

describe('saveAudio → getAudio → deleteAudio round-trip', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('save then get returns the same record', async () => {
    const blob = makeBlob('round-trip');
    await saveAudio('rt-1', blob, 'audio/webm');

    const result = await getAudio('rt-1');

    expect(result).not.toBeNull();
    expect(result!.meetingId).toBe('rt-1');
    expect(result!.blob).toBe(blob);
    expect(result!.mimeType).toBe('audio/webm');
  });

  it('save then delete then get returns null', async () => {
    await saveAudio('rt-2', makeBlob(), 'audio/webm');
    await deleteAudio('rt-2');

    const result = await getAudio('rt-2');
    expect(result).toBeNull();
  });

  it('save multiple, delete one, the other still resolves', async () => {
    const blobA = makeBlob('a');
    await saveAudio('rt-a', blobA, 'audio/ogg');
    await saveAudio('rt-b', makeBlob('b'), 'audio/mp4');

    await deleteAudio('rt-b');

    expect(await getAudio('rt-a')).not.toBeNull();
    expect(await getAudio('rt-b')).toBeNull();
  });
});
