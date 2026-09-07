import { describe, it, expect, beforeEach } from 'vitest';
import type { MinutesContent } from '@/types';
import type { StoredMinutes, StoredMinutesVersion } from './db';

// ─── In-memory fake DB ─────────────────────────────────────────────────────────

type StoreMap = {
  meetings: Map<string, Record<string, unknown>>;
  transcripts: Map<string, Record<string, unknown>>;
  minutes: Map<string, Record<string, unknown>>;
  audio: Map<string, Record<string, unknown>>;
};

function makeStore(data: Map<string, Record<string, unknown>>) {
  return {
    getAllFromIndex: (indexName: string, query: string) => {
      const results = [...data.values()].filter((v) => {
        if (indexName === 'by-meeting') return v.meetingId === query;
        return false;
      });
      return Promise.resolve(results);
    },
    get: (key: string) => Promise.resolve(data.get(key)),
    put: (_storeName: unknown, value: Record<string, unknown>) => {
      const key = (value.id ?? value.meetingId) as string;
      data.set(key, { ...value });
      return Promise.resolve(key);
    },
    delete: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

let stores: StoreMap;

function resetStores() {
  stores = {
    meetings: new Map(),
    transcripts: new Map(),
    minutes: new Map(),
    audio: new Map(),
  };
}

function makeFakeDB() {
  const minutesStore = makeStore(stores.minutes);
  return {
    getAllFromIndex: (storeName: 'minutes', indexName: string, query: string) => {
      if (storeName === 'minutes') {
        return minutesStore.getAllFromIndex(indexName, query);
      }
      return Promise.resolve([]);
    },
    get: (storeName: 'minutes', key: string) => {
      if (storeName === 'minutes') return minutesStore.get(key);
      return Promise.resolve(undefined);
    },
    put: (storeName: 'minutes', value: Record<string, unknown>) => {
      if (storeName === 'minutes') {
        const key = value.id as string;
        stores.minutes.set(key, { ...value });
        return Promise.resolve(key);
      }
      return Promise.resolve('');
    },
    delete: (storeName: 'minutes', key: string) => {
      if (storeName === 'minutes') {
        stores.minutes.delete(key);
        return Promise.resolve();
      }
      return Promise.resolve();
    },
  };
}

import { vi } from 'vitest';

vi.mock('./db', () => ({
  getDB: () => Promise.resolve(makeFakeDB()),
}));

// ─── Import after mock ─────────────────────────────────────────────────────────

import {
  getMinutes,
  saveMinutes,
  snapshotMinutes,
  appendMinutesVersion,
  setActiveMinutesVersion,
} from './minutes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContent(body: string): MinutesContent {
  return { body };
}

function seedMinutesRow(row: StoredMinutes) {
  stores.minutes.set(row.id, row as unknown as Record<string, unknown>);
}

// Build a minimal StoredMinutes row with one version already labelled.
function makeStoredMinutes(override: Partial<StoredMinutes> = {}): StoredMinutes {
  const now = new Date().toISOString();
  const v: StoredMinutesVersion = {
    id: 'v1',
    label: 1,
    content: makeContent('initial'),
    baseline: makeContent('initial'),
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: 'min-1',
    meetingId: 'meet-1',
    templateId: null,
    content: makeContent('initial'),
    version: 1,
    createdAt: now,
    activeVersionId: 'v1',
    versions: [v],
    ...override,
  };
}

// ─── getMinutes ────────────────────────────────────────────────────────────────

describe('getMinutes', () => {
  beforeEach(resetStores);

  it('returns null for a meeting that has no row', async () => {
    const result = await getMinutes('no-such-meeting');
    expect(result).toBeNull();
  });

  it('returns the row when it exists', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);
    const result = await getMinutes('meet-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('min-1');
  });

  it('normalises a legacy row that has no activeVersionId or labels', async () => {
    const now = '2024-01-01T00:00:00.000Z';
    const legacy = {
      id: 'legacy-1',
      meetingId: 'meet-legacy',
      templateId: null,
      content: makeContent('live content'),
      version: 2,
      createdAt: now,
      // No activeVersionId
      versions: [
        // Legacy: no label / updatedAt
        { id: 'old-v', content: makeContent('old'), createdAt: now },
      ],
    };
    stores.minutes.set('legacy-1', legacy as unknown as Record<string, unknown>);

    const result = await getMinutes('meet-legacy');
    expect(result).not.toBeNull();
    // Should have received stable labels
    expect(result!.versions.every((v) => v.label != null)).toBe(true);
    // Should have an activeVersionId now
    expect(result!.activeVersionId).toBeTruthy();
    // All versions should have updatedAt
    expect(result!.versions.every((v) => v.updatedAt != null)).toBe(true);
  });

  it('normalises a legacy row that has zero archived versions', async () => {
    const now = '2024-02-01T00:00:00.000Z';
    const legacy = {
      id: 'legacy-2',
      meetingId: 'meet-legacy-2',
      templateId: null,
      content: makeContent('only content'),
      version: 1,
      createdAt: now,
      versions: [], // No archived versions at all
    };
    stores.minutes.set('legacy-2', legacy as unknown as Record<string, unknown>);

    const result = await getMinutes('meet-legacy-2');
    expect(result).not.toBeNull();
    // The live content should become version 1
    expect(result!.versions).toHaveLength(1);
    expect(result!.versions[0].label).toBe(1);
    expect(result!.versions[0].content).toEqual(makeContent('only content'));
    expect(result!.activeVersionId).toBe(result!.versions[0].id);
  });

  it('normalises a partially-labelled row by backfilling baseline', async () => {
    // A row that already has labels + activeVersionId but lacks baseline on one version
    const now = '2024-03-01T00:00:00.000Z';
    const v: StoredMinutesVersion = {
      id: 'v-no-baseline',
      label: 1,
      content: makeContent('body'),
      // baseline intentionally omitted — simulates old row without baseline
      baseline: undefined as unknown as MinutesContent,
      createdAt: now,
      updatedAt: now,
    };
    const row = {
      id: 'partial-1',
      meetingId: 'meet-partial',
      templateId: null,
      content: makeContent('body'),
      version: 1,
      createdAt: now,
      activeVersionId: 'v-no-baseline',
      versions: [v],
    };
    stores.minutes.set('partial-1', row as unknown as Record<string, unknown>);

    const result = await getMinutes('meet-partial');
    expect(result).not.toBeNull();
    expect(result!.versions[0].baseline).toBeDefined();
    // baseline should fall back to the version's own content
    expect(result!.versions[0].baseline).toEqual(makeContent('body'));
  });
});

// ─── saveMinutes ───────────────────────────────────────────────────────────────

describe('saveMinutes', () => {
  beforeEach(resetStores);

  it('creates a new row with version 1 when none exists', async () => {
    const result = await saveMinutes('new-meeting', makeContent('hello'));
    expect(result.meetingId).toBe('new-meeting');
    expect(result.version).toBe(1);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].label).toBe(1);
    expect(result.content).toEqual(makeContent('hello'));
  });

  it('assigns a UUID id to the new row', async () => {
    const result = await saveMinutes('new-meeting', makeContent('x'));
    expect(result.id).toBeTruthy();
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('sets activeVersionId pointing to the single created version', async () => {
    const result = await saveMinutes('new-meeting', makeContent('x'));
    expect(result.activeVersionId).toBe(result.versions[0].id);
  });

  it('stores the templateId on first save', async () => {
    const result = await saveMinutes('new-meeting', makeContent('x'), 'tmpl-abc');
    expect(result.templateId).toBe('tmpl-abc');
  });

  it('defaults templateId to null when not provided', async () => {
    const result = await saveMinutes('new-meeting', makeContent('x'));
    expect(result.templateId).toBeNull();
  });

  it('updates existing row content without adding a new version', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await saveMinutes('meet-1', makeContent('updated'));
    expect(result.meetingId).toBe('meet-1');
    expect(result.versions).toHaveLength(1); // Still only 1 version
    expect(result.content).toEqual(makeContent('updated'));
    expect(result.version).toBe(1); // Label unchanged
  });

  it('updates the active version content in place', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    await saveMinutes('meet-1', makeContent('edited'));
    const fetched = await getMinutes('meet-1');
    expect(fetched!.versions[0].content).toEqual(makeContent('edited'));
  });

  it('does not change the version label after update', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await saveMinutes('meet-1', makeContent('new content'));
    expect(result.version).toBe(1);
    expect(result.versions[0].label).toBe(1);
  });

  it('updates templateId when explicitly passed on update', async () => {
    const row = makeStoredMinutes({ templateId: 'old-tmpl' });
    seedMinutesRow(row);

    const result = await saveMinutes('meet-1', makeContent('x'), 'new-tmpl');
    expect(result.templateId).toBe('new-tmpl');
  });

  it('preserves existing templateId when templateId arg is omitted', async () => {
    const row = makeStoredMinutes({ templateId: 'existing-tmpl' });
    seedMinutesRow(row);

    const result = await saveMinutes('meet-1', makeContent('x'));
    expect(result.templateId).toBe('existing-tmpl');
  });

  it('sets templateId to null when null is explicitly passed', async () => {
    const row = makeStoredMinutes({ templateId: 'old-tmpl' });
    seedMinutesRow(row);

    const result = await saveMinutes('meet-1', makeContent('x'), null);
    expect(result.templateId).toBeNull();
  });

  it('persists so a subsequent getMinutes returns the updated content', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    await saveMinutes('meet-1', makeContent('persisted'));
    const fetched = await getMinutes('meet-1');
    expect(fetched!.content).toEqual(makeContent('persisted'));
  });

  it('only updates the active version when multiple versions exist', async () => {
    const now = new Date().toISOString();
    const v2: StoredMinutesVersion = {
      id: 'v2',
      label: 2,
      content: makeContent('v2 content'),
      baseline: makeContent('v2 content'),
      createdAt: now,
      updatedAt: now,
    };
    const row = makeStoredMinutes({
      versions: [
        {
          id: 'v1',
          label: 1,
          content: makeContent('v1 content'),
          baseline: makeContent('v1 content'),
          createdAt: now,
          updatedAt: now,
        },
        v2,
      ],
      activeVersionId: 'v2',
      content: makeContent('v2 content'),
      version: 2,
    });
    seedMinutesRow(row);

    await saveMinutes('meet-1', makeContent('v2 edited'));
    const fetched = await getMinutes('meet-1');

    const v1 = fetched!.versions.find((v) => v.id === 'v1')!;
    const v2found = fetched!.versions.find((v) => v.id === 'v2')!;

    expect(v1.content).toEqual(makeContent('v1 content')); // untouched
    expect(v2found.content).toEqual(makeContent('v2 edited')); // updated
    expect(fetched!.content).toEqual(makeContent('v2 edited'));
  });
});

// ─── snapshotMinutes ──────────────────────────────────────────────────────────

describe('snapshotMinutes', () => {
  beforeEach(resetStores);

  it('returns null when no row exists for the meeting', async () => {
    const result = await snapshotMinutes('no-meeting', makeContent('x'));
    expect(result).toBeNull();
  });

  it('creates a new version with the next label', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-1', makeContent('snapshot'));
    expect(result).not.toBeNull();
    expect(result!.versions).toHaveLength(2);
    const newVersion = result!.versions.find((v) => v.label === 2)!;
    expect(newVersion).toBeDefined();
    expect(newVersion.content).toEqual(makeContent('snapshot'));
  });

  it('makes the new version active', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-1', makeContent('new snapshot'));
    const newV = result!.versions.find((v) => v.label === 2)!;
    expect(result!.activeVersionId).toBe(newV.id);
    expect(result!.content).toEqual(makeContent('new snapshot'));
    expect(result!.version).toBe(2);
  });

  it('reverts the previously-active version to its baseline', async () => {
    // Setup: v1 has baseline 'baseline content' but current content is 'edited'
    const now = new Date().toISOString();
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('edited'),
      version: 1,
      createdAt: now,
      activeVersionId: 'v1',
      versions: [
        {
          id: 'v1',
          label: 1,
          content: makeContent('edited'), // unsaved working edits
          baseline: makeContent('baseline content'),
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-1', makeContent('new snapshot'));
    const v1 = result!.versions.find((v) => v.id === 'v1')!;
    // The old version should be reverted to its baseline
    expect(v1.content).toEqual(makeContent('baseline content'));
  });

  it('new snapshot version has content === baseline (committed checkpoint)', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-1', makeContent('checkpoint'));
    const newV = result!.versions.find((v) => v.label === 2)!;
    expect(newV.content).toEqual(newV.baseline);
    expect(newV.baseline).toEqual(makeContent('checkpoint'));
  });

  it('increments label monotonically across multiple snapshots', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    await snapshotMinutes('meet-1', makeContent('v2'));
    const r2 = await getMinutes('meet-1');
    seedMinutesRow(r2!); // re-seed updated state

    const result3 = await snapshotMinutes('meet-1', makeContent('v3'));
    expect(result3!.version).toBe(3);
    const labels = result3!.versions.map((v) => v.label).sort((a, b) => a - b);
    expect(labels).toEqual([1, 2, 3]);
  });

  it('enforces MAX_VERSIONS=50 cap by dropping lowest labels', async () => {
    // Build a row that already has 50 versions
    const now = new Date().toISOString();
    const versions: StoredMinutesVersion[] = Array.from({ length: 50 }, (_, i) => ({
      id: `v${i + 1}`,
      label: i + 1,
      content: makeContent(`version ${i + 1}`),
      baseline: makeContent(`version ${i + 1}`),
      createdAt: now,
      updatedAt: now,
    }));
    const row: StoredMinutes = {
      id: 'min-cap',
      meetingId: 'meet-cap',
      templateId: null,
      content: makeContent('version 50'),
      version: 50,
      createdAt: now,
      activeVersionId: 'v50',
      versions,
    };
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-cap', makeContent('v51'));
    expect(result).not.toBeNull();
    // Should still be at MAX=50 versions
    expect(result!.versions).toHaveLength(50);
    // The lowest label (1) should have been dropped
    const labels = result!.versions.map((v) => v.label).sort((a, b) => a - b);
    expect(labels[0]).toBe(2); // label 1 was dropped
    expect(labels[labels.length - 1]).toBe(51); // new version present
  });

  it('never renumbers surviving versions when capping', async () => {
    const now = new Date().toISOString();
    const versions: StoredMinutesVersion[] = Array.from({ length: 50 }, (_, i) => ({
      id: `v${i + 1}`,
      label: i + 1,
      content: makeContent(`v${i + 1}`),
      baseline: makeContent(`v${i + 1}`),
      createdAt: now,
      updatedAt: now,
    }));
    const row: StoredMinutes = {
      id: 'min-renumber',
      meetingId: 'meet-renumber',
      templateId: null,
      content: makeContent('v50'),
      version: 50,
      createdAt: now,
      activeVersionId: 'v50',
      versions,
    };
    seedMinutesRow(row);

    const result = await snapshotMinutes('meet-renumber', makeContent('v51'));
    // Labels 2..51 should exist unchanged (no renumbering)
    const surviving = result!.versions.map((v) => v.label).sort((a, b) => a - b);
    expect(surviving).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
  });
});

// ─── appendMinutesVersion ─────────────────────────────────────────────────────

describe('appendMinutesVersion', () => {
  beforeEach(resetStores);

  it('creates a new row with version 1 when none exists', async () => {
    const result = await appendMinutesVersion('brand-new', makeContent('first gen'));
    expect(result.meetingId).toBe('brand-new');
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].label).toBe(1);
    expect(result.content).toEqual(makeContent('first gen'));
  });

  it('sets activeVersionId on first creation', async () => {
    const result = await appendMinutesVersion('brand-new', makeContent('x'));
    expect(result.activeVersionId).toBe(result.versions[0].id);
  });

  it('stores templateId on first creation', async () => {
    const result = await appendMinutesVersion('brand-new', makeContent('x'), 'tmpl-1');
    expect(result.templateId).toBe('tmpl-1');
  });

  it('appends a new version when a row already exists', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('second gen'));
    expect(result.versions).toHaveLength(2);
    const newV = result.versions.find((v) => v.label === 2)!;
    expect(newV).toBeDefined();
    expect(newV.content).toEqual(makeContent('second gen'));
  });

  it('makes the new appended version active', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('second gen'));
    const newV = result.versions.find((v) => v.label === 2)!;
    expect(result.activeVersionId).toBe(newV.id);
    expect(result.content).toEqual(makeContent('second gen'));
    expect(result.version).toBe(2);
  });

  it('assigns a stable incrementing label', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const r2 = await appendMinutesVersion('meet-1', makeContent('gen 2'));
    expect(r2.versions.map((v) => v.label).sort((a, b) => a - b)).toEqual([1, 2]);

    seedMinutesRow(r2);
    const r3 = await appendMinutesVersion('meet-1', makeContent('gen 3'));
    expect(r3.versions.map((v) => v.label).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('does NOT revert the previously-active version (unlike snapshotMinutes)', async () => {
    const now = new Date().toISOString();
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('edited'),
      version: 1,
      createdAt: now,
      activeVersionId: 'v1',
      versions: [
        {
          id: 'v1',
          label: 1,
          content: makeContent('edited'),
          baseline: makeContent('original'),
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('fresh gen'));
    const v1 = result.versions.find((v) => v.id === 'v1')!;
    // Content should remain 'edited' — appendMinutesVersion doesn't revert
    expect(v1.content).toEqual(makeContent('edited'));
  });

  it('new version has content === baseline (committed checkpoint)', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('gen content'));
    const newV = result.versions.find((v) => v.label === 2)!;
    expect(newV.content).toEqual(newV.baseline);
  });

  it('enforces MAX_VERSIONS=50 cap by dropping lowest labels', async () => {
    const now = new Date().toISOString();
    const versions: StoredMinutesVersion[] = Array.from({ length: 50 }, (_, i) => ({
      id: `v${i + 1}`,
      label: i + 1,
      content: makeContent(`v${i + 1}`),
      baseline: makeContent(`v${i + 1}`),
      createdAt: now,
      updatedAt: now,
    }));
    const row: StoredMinutes = {
      id: 'min-append-cap',
      meetingId: 'meet-append-cap',
      templateId: null,
      content: makeContent('v50'),
      version: 50,
      createdAt: now,
      activeVersionId: 'v50',
      versions,
    };
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-append-cap', makeContent('v51'));
    expect(result.versions).toHaveLength(50);
    const labels = result.versions.map((v) => v.label).sort((a, b) => a - b);
    expect(labels[0]).toBe(2); // label 1 was evicted
    expect(labels[labels.length - 1]).toBe(51); // new version is present
  });

  it('updates templateId when explicitly provided on append', async () => {
    const row = makeStoredMinutes({ templateId: 'old-tmpl' });
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('x'), 'new-tmpl');
    expect(result.templateId).toBe('new-tmpl');
  });

  it('preserves templateId when omitted on append', async () => {
    const row = makeStoredMinutes({ templateId: 'keep-tmpl' });
    seedMinutesRow(row);

    const result = await appendMinutesVersion('meet-1', makeContent('x'));
    expect(result.templateId).toBe('keep-tmpl');
  });
});

// ─── setActiveMinutesVersion ──────────────────────────────────────────────────

describe('setActiveMinutesVersion', () => {
  beforeEach(resetStores);

  it('returns null when no row exists', async () => {
    const result = await setActiveMinutesVersion('ghost-meeting', 'some-version-id');
    expect(result).toBeNull();
  });

  it('returns the row unchanged when the versionId does not resolve', async () => {
    const row = makeStoredMinutes();
    seedMinutesRow(row);

    const result = await setActiveMinutesVersion('meet-1', 'non-existent-version');
    expect(result).not.toBeNull();
    // Should be the same as the original — activeVersionId unchanged
    expect(result!.activeVersionId).toBe(row.activeVersionId);
    expect(result!.content).toEqual(row.content);
  });

  it('switches the active version to the specified id', async () => {
    const now = new Date().toISOString();
    const v1: StoredMinutesVersion = {
      id: 'v1',
      label: 1,
      content: makeContent('v1 content'),
      baseline: makeContent('v1 content'),
      createdAt: now,
      updatedAt: now,
    };
    const v2: StoredMinutesVersion = {
      id: 'v2',
      label: 2,
      content: makeContent('v2 content'),
      baseline: makeContent('v2 content'),
      createdAt: now,
      updatedAt: now,
    };
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('v2 content'),
      version: 2,
      createdAt: now,
      activeVersionId: 'v2',
      versions: [v1, v2],
    };
    seedMinutesRow(row);

    const result = await setActiveMinutesVersion('meet-1', 'v1');
    expect(result).not.toBeNull();
    expect(result!.activeVersionId).toBe('v1');
    // Top-level mirror should reflect v1
    expect(result!.content).toEqual(makeContent('v1 content'));
    expect(result!.version).toBe(1);
  });

  it('mirrors the new active version content to the top level', async () => {
    const now = new Date().toISOString();
    const v1: StoredMinutesVersion = {
      id: 'v1',
      label: 1,
      content: makeContent('old content'),
      baseline: makeContent('old content'),
      createdAt: now,
      updatedAt: now,
    };
    const v2: StoredMinutesVersion = {
      id: 'v2',
      label: 2,
      content: makeContent('current content'),
      baseline: makeContent('current content'),
      createdAt: now,
      updatedAt: now,
    };
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('current content'),
      version: 2,
      createdAt: now,
      activeVersionId: 'v2',
      versions: [v1, v2],
    };
    seedMinutesRow(row);

    const result = await setActiveMinutesVersion('meet-1', 'v1');
    expect(result!.content).toEqual(makeContent('old content'));
    expect(result!.version).toBe(1);
  });

  it('persists the active version switch', async () => {
    const now = new Date().toISOString();
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('v2'),
      version: 2,
      createdAt: now,
      activeVersionId: 'v2',
      versions: [
        { id: 'v1', label: 1, content: makeContent('v1'), baseline: makeContent('v1'), createdAt: now, updatedAt: now },
        { id: 'v2', label: 2, content: makeContent('v2'), baseline: makeContent('v2'), createdAt: now, updatedAt: now },
      ],
    };
    seedMinutesRow(row);

    await setActiveMinutesVersion('meet-1', 'v1');
    const fetched = await getMinutes('meet-1');
    expect(fetched!.activeVersionId).toBe('v1');
    expect(fetched!.content).toEqual(makeContent('v1'));
  });

  it('does not modify versions array when switching active', async () => {
    const now = new Date().toISOString();
    const row: StoredMinutes = {
      id: 'min-1',
      meetingId: 'meet-1',
      templateId: null,
      content: makeContent('v2'),
      version: 2,
      createdAt: now,
      activeVersionId: 'v2',
      versions: [
        { id: 'v1', label: 1, content: makeContent('v1'), baseline: makeContent('v1'), createdAt: now, updatedAt: now },
        { id: 'v2', label: 2, content: makeContent('v2'), baseline: makeContent('v2'), createdAt: now, updatedAt: now },
      ],
    };
    seedMinutesRow(row);

    const result = await setActiveMinutesVersion('meet-1', 'v1');
    // Still 2 versions, unchanged content
    expect(result!.versions).toHaveLength(2);
    expect(result!.versions[0].content).toEqual(makeContent('v1'));
    expect(result!.versions[1].content).toEqual(makeContent('v2'));
  });
});
