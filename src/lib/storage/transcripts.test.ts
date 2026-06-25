import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredTranscript } from './db';
import type { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

// ─── Fake in-memory DB ────────────────────────────────────────────────────────

type TranscriptStore = Map<string, StoredTranscript>;

function makeFakeDb(store: TranscriptStore) {
  return {
    getAllFromIndex: vi.fn(
      async (_storeName: string, _indexName: string, meetingId: string) => {
        const rows: StoredTranscript[] = [];
        for (const row of store.values()) {
          if (row.meetingId === meetingId) rows.push(row);
        }
        return rows;
      },
    ),
    put: vi.fn(async (_storeName: string, value: StoredTranscript) => {
      store.set(value.id, value);
    }),
  };
}

// Module-level store so each test can inspect what was written.
let store: TranscriptStore = new Map();

// The mock must be declared at module scope (before any imports that reference it).
vi.mock('./db', () => ({
  getDB: vi.fn(),
}));

// Import the mock handle once; re-configure it per test.
import { getDB } from './db';

beforeEach(() => {
  store = new Map();
  const fakeDb = makeFakeDb(store);
  vi.mocked(getDB).mockResolvedValue(fakeDb as any);
});

// Re-import the functions under test after mocking.
import {
  getTranscript,
  saveTranscript,
  saveTranscriptChapters,
  saveTranscriptSegments,
} from './transcripts';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MEETING_ID = 'meeting-abc';

const SEG1: TranscriptSegment = { speaker: 'Taler 1', start: 0, end: 5, text: 'Hello' };
const SEG2: TranscriptSegment = { speaker: 'Taler 2', start: 5, end: 10, text: 'World' };

const CHAPTER1: TranscriptChapter = {
  id: 'ch-0',
  title: 'Intro',
  summary: 'Opening remarks.',
  startTime: 0,
  endTime: 5,
  segmentIndices: [0],
};

const PII1: PiiReplacement = {
  original: 'Anders Hansen',
  replacement: '[NAVN]',
  type: 'NAVN',
};

// ─── saveTranscript ───────────────────────────────────────────────────────────

describe('saveTranscript', () => {
  it('creates a new row keyed by meetingId in the by-meeting index', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'Hello World',
      segments: [SEG1, SEG2],
      chapters: [CHAPTER1],
      piiReplacements: [PII1],
    });

    expect(result.meetingId).toBe(MEETING_ID);
    expect(result.rawText).toBe('Hello World');
    expect(result.segments).toEqual([SEG1, SEG2]);
    expect(result.chapters).toEqual([CHAPTER1]);
    expect(result.piiReplacements).toEqual([PII1]);
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);

    // Verify the row landed in the store under the generated id.
    expect(store.get(result.id)).toEqual(result);
  });

  it('assigns a stable id on first save', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    expect(result.id).toBeTruthy();
  });

  it('preserves the existing id when updating an existing transcript', async () => {
    const first = await saveTranscript(MEETING_ID, {
      rawText: 'v1',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
    });

    const second = await saveTranscript(MEETING_ID, {
      rawText: 'v2',
      segments: [SEG2],
      chapters: [CHAPTER1],
      piiReplacements: [PII1],
    });

    expect(second.id).toBe(first.id);
    expect(second.rawText).toBe('v2');
    expect(second.segments).toEqual([SEG2]);
    expect(second.chapters).toEqual([CHAPTER1]);
  });

  it('defaults piiRemovedAt to null when not provided', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    expect(result.piiRemovedAt).toBeNull();
  });

  it('stores an explicit piiRemovedAt timestamp', async () => {
    const ts = '2024-06-01T12:00:00Z';

    const result = await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [],
      piiReplacements: [],
      piiRemovedAt: ts,
    });

    expect(result.piiRemovedAt).toBe(ts);
  });

  it('preserves existing piiRemovedAt when update omits the field', async () => {
    const ts = '2024-06-01T12:00:00Z';

    await saveTranscript(MEETING_ID, {
      rawText: 'v1',
      segments: [],
      chapters: [],
      piiReplacements: [],
      piiRemovedAt: ts,
    });

    const second = await saveTranscript(MEETING_ID, {
      rawText: 'v2',
      segments: [],
      chapters: [],
      piiReplacements: [],
      // piiRemovedAt omitted — should fall back to existing value
    });

    expect(second.piiRemovedAt).toBe(ts);
  });

  it('stores diarizationStatus "pending" when provided', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'pending',
    });

    expect(result.diarizationStatus).toBe('pending');
  });

  it('stores diarizationStatus "done" when provided', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'done',
    });

    expect(result.diarizationStatus).toBe('done');
  });

  it('preserves existing diarizationStatus when update omits the field', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'v1',
      segments: [],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'done',
    });

    const second = await saveTranscript(MEETING_ID, {
      rawText: 'v2',
      segments: [],
      chapters: [],
      piiReplacements: [],
      // diarizationStatus omitted
    });

    expect(second.diarizationStatus).toBe('done');
  });

  it('overwrites diarizationStatus from pending to done on re-save', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'v1',
      segments: [],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'pending',
    });

    const second = await saveTranscript(MEETING_ID, {
      rawText: 'v2',
      segments: [],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'done',
    });

    expect(second.diarizationStatus).toBe('done');
  });

  it('returns the saved transcript object (matches what was stored)', async () => {
    const result = await saveTranscript(MEETING_ID, {
      rawText: 'Hello',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
    });

    expect(store.get(result.id)).toEqual(result);
  });

  it('gives independent ids to different meetings', async () => {
    const a = await saveTranscript('meeting-A', {
      rawText: 'A',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    const b = await saveTranscript('meeting-B', {
      rawText: 'B',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    expect(a.id).not.toBe(b.id);
  });
});

// ─── getTranscript ────────────────────────────────────────────────────────────

describe('getTranscript', () => {
  it('returns null when no transcript exists for the meeting', async () => {
    const result = await getTranscript('nonexistent-meeting');

    expect(result).toBeNull();
  });

  it('returns the stored transcript for a known meeting', async () => {
    const saved = await saveTranscript(MEETING_ID, {
      rawText: 'Hello',
      segments: [SEG1],
      chapters: [CHAPTER1],
      piiReplacements: [PII1],
    });

    const fetched = await getTranscript(MEETING_ID);

    expect(fetched).toEqual(saved);
  });

  it('returns the first row when the by-meeting index has multiple entries', async () => {
    // Manually insert two rows with the same meetingId to simulate the edge case.
    const transcript1: StoredTranscript = {
      id: 'id-first',
      meetingId: MEETING_ID,
      rawText: 'first',
      segments: [],
      chapters: [],
      piiReplacements: [],
      piiRemovedAt: null,
    };
    const transcript2: StoredTranscript = {
      id: 'id-second',
      meetingId: MEETING_ID,
      rawText: 'second',
      segments: [],
      chapters: [],
      piiReplacements: [],
      piiRemovedAt: null,
    };
    store.set(transcript1.id, transcript1);
    store.set(transcript2.id, transcript2);

    const result = await getTranscript(MEETING_ID);

    // Must return something — not null — and it should be one of the two rows.
    expect(result).not.toBeNull();
    expect(['id-first', 'id-second']).toContain(result!.id);
  });

  it('does not return a transcript for a different meetingId', async () => {
    await saveTranscript('other-meeting', {
      rawText: 'other',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    const result = await getTranscript(MEETING_ID);

    expect(result).toBeNull();
  });
});

// ─── saveTranscriptChapters ───────────────────────────────────────────────────

describe('saveTranscriptChapters', () => {
  it('is a no-op when no transcript exists for the meeting', async () => {
    // Should not throw and store should remain empty.
    await expect(saveTranscriptChapters(MEETING_ID, [CHAPTER1])).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('patches only the chapters field without clobbering segments or rawText', async () => {
    const piiTs = '2024-05-01T00:00:00Z';
    await saveTranscript(MEETING_ID, {
      rawText: 'Hello World',
      segments: [SEG1, SEG2],
      chapters: [],
      piiReplacements: [PII1],
      piiRemovedAt: piiTs,
      diarizationStatus: 'done',
    });

    const newChapters: TranscriptChapter[] = [
      { id: 'ch-0', title: 'New', summary: 'New chapter', startTime: 0, endTime: 10, segmentIndices: [0, 1] },
    ];
    await saveTranscriptChapters(MEETING_ID, newChapters);

    const updated = await getTranscript(MEETING_ID);
    expect(updated!.chapters).toEqual(newChapters);

    // Other fields must be untouched.
    expect(updated!.segments).toEqual([SEG1, SEG2]);
    expect(updated!.rawText).toBe('Hello World');
    expect(updated!.piiReplacements).toEqual([PII1]);
    expect(updated!.piiRemovedAt).toBe(piiTs);
    expect(updated!.diarizationStatus).toBe('done');
  });

  it('replaces existing chapters with the new set', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [],
      chapters: [CHAPTER1],
      piiReplacements: [],
    });

    const updated: TranscriptChapter[] = [
      { id: 'ch-new', title: 'Updated', summary: 'New', startTime: 0, endTime: 20, segmentIndices: [] },
    ];
    await saveTranscriptChapters(MEETING_ID, updated);

    const result = await getTranscript(MEETING_ID);
    expect(result!.chapters).toEqual(updated);
    expect(result!.chapters).not.toEqual([CHAPTER1]);
  });

  it('accepts an empty chapters array', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [SEG1],
      chapters: [CHAPTER1],
      piiReplacements: [],
    });

    await saveTranscriptChapters(MEETING_ID, []);

    const result = await getTranscript(MEETING_ID);
    expect(result!.chapters).toEqual([]);
  });
});

// ─── saveTranscriptSegments ───────────────────────────────────────────────────

describe('saveTranscriptSegments', () => {
  it('is a no-op when no transcript exists for the meeting', async () => {
    await expect(saveTranscriptSegments(MEETING_ID, [SEG1])).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('patches only segments and rawText without clobbering chapters or piiReplacements', async () => {
    const piiTs = '2024-05-01T00:00:00Z';
    await saveTranscript(MEETING_ID, {
      rawText: 'old text',
      segments: [SEG1],
      chapters: [CHAPTER1],
      piiReplacements: [PII1],
      piiRemovedAt: piiTs,
    });

    const newSegments: TranscriptSegment[] = [
      { speaker: 'Taler 1', start: 0, end: 3, text: 'Hej' },
      { speaker: 'Taler 2', start: 3, end: 8, text: 'Verden' },
    ];
    await saveTranscriptSegments(MEETING_ID, newSegments);

    const updated = await getTranscript(MEETING_ID);
    expect(updated!.segments).toEqual(newSegments);

    // rawText is recomputed from segments joined by spaces.
    expect(updated!.rawText).toBe('Hej Verden');

    // Untouched fields.
    expect(updated!.chapters).toEqual([CHAPTER1]);
    expect(updated!.piiReplacements).toEqual([PII1]);
    expect(updated!.piiRemovedAt).toBe(piiTs);
  });

  it('rebuilds rawText as segments joined by a single space', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: '',
      segments: [],
      chapters: [],
      piiReplacements: [],
    });

    const segs: TranscriptSegment[] = [
      { speaker: 'A', start: 0, end: 1, text: 'one' },
      { speaker: 'B', start: 1, end: 2, text: 'two' },
      { speaker: 'C', start: 2, end: 3, text: 'three' },
    ];
    await saveTranscriptSegments(MEETING_ID, segs);

    const result = await getTranscript(MEETING_ID);
    expect(result!.rawText).toBe('one two three');
  });

  it('sets diarizationStatus when explicitly provided', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'pending',
    });

    await saveTranscriptSegments(MEETING_ID, [SEG2], 'done');

    const result = await getTranscript(MEETING_ID);
    expect(result!.diarizationStatus).toBe('done');
  });

  it('does not overwrite diarizationStatus when argument is omitted', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'text',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
      diarizationStatus: 'done',
    });

    await saveTranscriptSegments(MEETING_ID, [SEG2]);

    const result = await getTranscript(MEETING_ID);
    // diarizationStatus should be preserved from the existing row because
    // the conditional spread only applies when diarizationStatus is truthy.
    expect(result!.diarizationStatus).toBe('done');
  });

  it('produces an empty rawText when given an empty segments array', async () => {
    await saveTranscript(MEETING_ID, {
      rawText: 'old text',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
    });

    await saveTranscriptSegments(MEETING_ID, []);

    const result = await getTranscript(MEETING_ID);
    expect(result!.rawText).toBe('');
    expect(result!.segments).toEqual([]);
  });
});

// ─── Cross-function interaction ───────────────────────────────────────────────

describe('cross-function interactions', () => {
  it('saveTranscript → saveTranscriptSegments → saveTranscriptChapters preserves all fields', async () => {
    const saved = await saveTranscript(MEETING_ID, {
      rawText: 'initial',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [PII1],
      piiRemovedAt: '2024-01-01T00:00:00Z',
      diarizationStatus: 'pending',
    });

    const newSegs: TranscriptSegment[] = [SEG1, SEG2];
    await saveTranscriptSegments(MEETING_ID, newSegs, 'done');

    const newChapters: TranscriptChapter[] = [CHAPTER1];
    await saveTranscriptChapters(MEETING_ID, newChapters);

    const final = await getTranscript(MEETING_ID);
    expect(final!.id).toBe(saved.id);
    expect(final!.segments).toEqual(newSegs);
    expect(final!.chapters).toEqual(newChapters);
    expect(final!.rawText).toBe('Hello World');
    expect(final!.piiReplacements).toEqual([PII1]);
    expect(final!.piiRemovedAt).toBe('2024-01-01T00:00:00Z');
    expect(final!.diarizationStatus).toBe('done');
  });

  it('a second saveTranscript call for the same meeting updates in-place (same id)', async () => {
    const first = await saveTranscript(MEETING_ID, {
      rawText: 'v1',
      segments: [SEG1],
      chapters: [],
      piiReplacements: [],
    });

    await saveTranscript(MEETING_ID, {
      rawText: 'v2',
      segments: [SEG2],
      chapters: [CHAPTER1],
      piiReplacements: [PII1],
    });

    const fetched = await getTranscript(MEETING_ID);
    expect(fetched!.id).toBe(first.id);
    expect(fetched!.rawText).toBe('v2');
  });
});
