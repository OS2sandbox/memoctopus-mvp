import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory fake DB ─────────────────────────────────────────────────────────

type StoreMap = {
  meetings: Map<string, Record<string, unknown>>;
  transcripts: Map<string, Record<string, unknown>>;
  minutes: Map<string, Record<string, unknown>>;
  audio: Map<string, Record<string, unknown>>;
};

function makeStore(data: Map<string, Record<string, unknown>>) {
  return {
    getAll: () => Promise.resolve([...data.values()]),
    get: (key: string) => Promise.resolve(data.get(key)),
    put: (value: Record<string, unknown>) => {
      // For meetings: key is value.id; for audio: key is value.meetingId
      const key = (value.id ?? value.meetingId) as string;
      data.set(key, value);
      return Promise.resolve(key);
    },
    delete: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
    index: (indexName: string) => ({
      getAll: (query: string) => {
        const results = [...data.values()].filter((v) => {
          if (indexName === 'by-meeting') return v.meetingId === query;
          return false;
        });
        return Promise.resolve(results);
      },
    }),
  };
}

// Holds fresh store maps per test
let stores: StoreMap;

function resetStores() {
  stores = {
    meetings: new Map(),
    transcripts: new Map(),
    minutes: new Map(),
    audio: new Map(),
  };
}

// The fake transaction collects objectStore proxies and resolves `.done`
function makeFakeDB() {
  return {
    getAll: (storeName: keyof StoreMap) => {
      return Promise.resolve([...stores[storeName].values()]);
    },
    get: (storeName: keyof StoreMap, key: string) => {
      return Promise.resolve(stores[storeName].get(key));
    },
    put: (storeName: keyof StoreMap, value: Record<string, unknown>) => {
      const key = (value.id ?? value.meetingId) as string;
      stores[storeName].set(key, { ...value });
      return Promise.resolve(key);
    },
    delete: (storeName: keyof StoreMap, key: string) => {
      stores[storeName].delete(key);
      return Promise.resolve();
    },
    transaction: (storeNames: (keyof StoreMap)[], _mode: string) => {
      const txStores: Partial<Record<keyof StoreMap, ReturnType<typeof makeStore>>> = {};
      for (const name of storeNames) {
        txStores[name] = makeStore(stores[name]);
      }
      return {
        objectStore: (name: keyof StoreMap) => txStores[name]!,
        done: Promise.resolve(),
      };
    },
  };
}

vi.mock('./db', () => ({
  getDB: () => Promise.resolve(makeFakeDB()),
}));

// ─── Import after mock ─────────────────────────────────────────────────────────

import {
  createMeeting,
  getAllMeetings,
  getMeeting,
  updateMeeting,
  deleteMeeting,
} from './meetings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedAudio(meetingId: string) {
  stores.audio.set(meetingId, {
    meetingId,
    blob: new Blob(['audio'], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
  });
}

function seedTranscript(id: string, meetingId: string) {
  stores.transcripts.set(id, { id, meetingId, rawText: 'hello' });
}

function seedMinutes(id: string, meetingId: string) {
  stores.minutes.set(id, { id, meetingId, content: {} });
}

// ─── createMeeting ─────────────────────────────────────────────────────────────

describe('createMeeting', () => {
  beforeEach(resetStores);

  it('generates a unique id', async () => {
    const m1 = await createMeeting({ title: 'Meeting A' });
    const m2 = await createMeeting({ title: 'Meeting B' });
    expect(m1.id).toBeTruthy();
    expect(m2.id).toBeTruthy();
    expect(m1.id).not.toBe(m2.id);
  });

  it('stores the provided title', async () => {
    const m = await createMeeting({ title: 'Stand-up' });
    expect(m.title).toBe('Stand-up');
  });

  it('defaults status to "recording"', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.status).toBe('recording');
  });

  it('accepts a custom status', async () => {
    const m = await createMeeting({ title: 'Test', status: 'processing' });
    expect(m.status).toBe('processing');
  });

  it('defaults source to "local"', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.source).toBe('local');
  });

  it('accepts source "teams"', async () => {
    const m = await createMeeting({ title: 'Test', source: 'teams' });
    expect(m.source).toBe('teams');
  });

  it('defaults participants to an empty array', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.participants).toEqual([]);
  });

  it('stores provided participants', async () => {
    const m = await createMeeting({ title: 'Test', participants: ['Alice', 'Bob'] });
    expect(m.participants).toEqual(['Alice', 'Bob']);
  });

  it('defaults meetingUrl to null', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.meetingUrl).toBeNull();
  });

  it('stores provided meetingUrl', async () => {
    const m = await createMeeting({ title: 'Test', meetingUrl: 'https://teams.example.com/meet' });
    expect(m.meetingUrl).toBe('https://teams.example.com/meet');
  });

  it('sets createdAt, updatedAt, and recordedAt as ISO strings', async () => {
    const before = new Date().toISOString();
    const m = await createMeeting({ title: 'Test' });
    const after = new Date().toISOString();

    expect(m.createdAt >= before).toBe(true);
    expect(m.createdAt <= after).toBe(true);
    expect(m.updatedAt >= before).toBe(true);
    expect(m.updatedAt <= after).toBe(true);
    expect(m.recordedAt! >= before).toBe(true);
    expect(m.recordedAt! <= after).toBe(true);
  });

  it('accepts a custom recordedAt date', async () => {
    const past = '2023-01-15T10:00:00.000Z';
    const m = await createMeeting({ title: 'Test', recordedAt: past });
    expect(m.recordedAt).toBe(past);
  });

  it('initialises audioDurationSeconds to null', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.audioDurationSeconds).toBeNull();
  });

  it('initialises audioSizeBytes to 0', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.audioSizeBytes).toBe(0);
  });

  it('initialises audioDeleted to false', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.audioDeleted).toBe(false);
  });

  it('initialises botSession to null', async () => {
    const m = await createMeeting({ title: 'Test' });
    expect(m.botSession).toBeNull();
  });

  it('persists the meeting so getMeeting can retrieve it', async () => {
    const m = await createMeeting({ title: 'Persisted' });
    const fetched = await getMeeting(m.id);
    expect(fetched).toMatchObject({ id: m.id, title: 'Persisted' });
  });
});

// ─── getAllMeetings ────────────────────────────────────────────────────────────

describe('getAllMeetings', () => {
  beforeEach(resetStores);

  it('returns an empty array when no meetings exist', async () => {
    const all = await getAllMeetings();
    expect(all).toEqual([]);
  });

  it('returns all meetings', async () => {
    await createMeeting({ title: 'A' });
    await createMeeting({ title: 'B' });
    const all = await getAllMeetings();
    expect(all).toHaveLength(2);
  });

  it('returns meetings sorted by createdAt descending (newest first)', async () => {
    // Seed meetings with explicit, distinguishable createdAt values
    stores.meetings.set('old', {
      id: 'old',
      title: 'Old',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    stores.meetings.set('new', {
      id: 'new',
      title: 'New',
      createdAt: '2024-06-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });
    stores.meetings.set('mid', {
      id: 'mid',
      title: 'Mid',
      createdAt: '2024-03-01T00:00:00.000Z',
      updatedAt: '2024-03-01T00:00:00.000Z',
    });

    const all = await getAllMeetings();
    expect(all.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });

  it('returns a single meeting in a list', async () => {
    await createMeeting({ title: 'Solo' });
    const all = await getAllMeetings();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Solo');
  });
});

// ─── getMeeting ────────────────────────────────────────────────────────────────

describe('getMeeting', () => {
  beforeEach(resetStores);

  it('returns null for a missing id', async () => {
    const result = await getMeeting('does-not-exist');
    expect(result).toBeNull();
  });

  it('returns the meeting for a known id', async () => {
    const m = await createMeeting({ title: 'Known' });
    const fetched = await getMeeting(m.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Known');
  });

  it('returns null after the meeting has been deleted', async () => {
    const m = await createMeeting({ title: 'Temp' });
    await deleteMeeting(m.id);
    const fetched = await getMeeting(m.id);
    expect(fetched).toBeNull();
  });
});

// ─── updateMeeting ─────────────────────────────────────────────────────────────

describe('updateMeeting', () => {
  beforeEach(resetStores);

  it('merges patch fields into the existing meeting', async () => {
    const m = await createMeeting({ title: 'Original' });
    await updateMeeting(m.id, { title: 'Updated' });

    const fetched = await getMeeting(m.id);
    expect(fetched!.title).toBe('Updated');
  });

  it('bumps updatedAt after update', async () => {
    const m = await createMeeting({ title: 'Test' });
    const originalUpdatedAt = m.updatedAt;

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    await updateMeeting(m.id, { status: 'processing' });

    const fetched = await getMeeting(m.id);
    expect(fetched!.updatedAt > originalUpdatedAt).toBe(true);
  });

  it('preserves unchanged fields', async () => {
    const m = await createMeeting({ title: 'Stable', participants: ['Alice'] });
    await updateMeeting(m.id, { status: 'done' });

    const fetched = await getMeeting(m.id);
    expect(fetched!.title).toBe('Stable');
    expect(fetched!.participants).toEqual(['Alice']);
    expect(fetched!.status).toBe('done');
  });

  it('does not throw when id does not exist (no-op)', async () => {
    await expect(
      updateMeeting('ghost-id', { title: 'Ghost' }),
    ).resolves.not.toThrow();
  });

  it('can update multiple fields at once', async () => {
    const m = await createMeeting({ title: 'Multi' });
    await updateMeeting(m.id, {
      title: 'New Title',
      status: 'review',
      audioDurationSeconds: 120,
      audioSizeBytes: 2048,
    });

    const fetched = await getMeeting(m.id);
    expect(fetched!.title).toBe('New Title');
    expect(fetched!.status).toBe('review');
    expect(fetched!.audioDurationSeconds).toBe(120);
    expect(fetched!.audioSizeBytes).toBe(2048);
  });

  it('can set audioDeleted to true', async () => {
    const m = await createMeeting({ title: 'Audio' });
    await updateMeeting(m.id, { audioDeleted: true });

    const fetched = await getMeeting(m.id);
    expect(fetched!.audioDeleted).toBe(true);
  });
});

// ─── deleteMeeting ─────────────────────────────────────────────────────────────

describe('deleteMeeting', () => {
  beforeEach(resetStores);

  it('removes the meeting record', async () => {
    const m = await createMeeting({ title: 'To Delete' });
    await deleteMeeting(m.id);
    expect(await getMeeting(m.id)).toBeNull();
  });

  it('also deletes the associated audio entry', async () => {
    const m = await createMeeting({ title: 'With Audio' });
    seedAudio(m.id);
    expect(stores.audio.has(m.id)).toBe(true);

    await deleteMeeting(m.id);

    expect(stores.audio.has(m.id)).toBe(false);
  });

  it('removes associated transcripts', async () => {
    const m = await createMeeting({ title: 'With Transcript' });
    seedTranscript('t1', m.id);
    seedTranscript('t2', m.id);

    await deleteMeeting(m.id);

    expect(stores.transcripts.has('t1')).toBe(false);
    expect(stores.transcripts.has('t2')).toBe(false);
  });

  it('removes associated minutes', async () => {
    const m = await createMeeting({ title: 'With Minutes' });
    seedMinutes('min1', m.id);

    await deleteMeeting(m.id);

    expect(stores.minutes.has('min1')).toBe(false);
  });

  it('does not throw when deleting a non-existent meeting', async () => {
    await expect(deleteMeeting('does-not-exist')).resolves.not.toThrow();
  });

  it('does not affect other meetings', async () => {
    const m1 = await createMeeting({ title: 'Keep' });
    const m2 = await createMeeting({ title: 'Delete' });

    await deleteMeeting(m2.id);

    expect(await getMeeting(m1.id)).not.toBeNull();
    expect(await getMeeting(m2.id)).toBeNull();
  });

  it('leaves transcripts belonging to other meetings intact', async () => {
    const m1 = await createMeeting({ title: 'Keep' });
    const m2 = await createMeeting({ title: 'Delete' });
    seedTranscript('keep-t', m1.id);
    seedTranscript('del-t', m2.id);

    await deleteMeeting(m2.id);

    expect(stores.transcripts.has('keep-t')).toBe(true);
    expect(stores.transcripts.has('del-t')).toBe(false);
  });
});
