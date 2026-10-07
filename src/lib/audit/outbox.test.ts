import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal in-memory stand-in for the idb calls outbox.ts uses (no IndexedDB in node).
const h = vi.hoisted(() => ({
  dbs: new Map<string, Map<string, Record<string, unknown>>>(),
  opened: [] as Array<{ name: string; version: number }>,
  failOpen: false,
  callbacks: new Map<string, { blocking?: () => void; terminated?: () => void }>(),
  closed: [] as string[],
}));

vi.mock('idb', () => ({
  openDB: vi.fn(async (name: string, version: number, opts?: { upgrade?: (db: unknown) => void; blocking?: () => void; terminated?: () => void }) => {
    if (h.failOpen) throw new Error('blocked');
    h.opened.push({ name, version });
    h.callbacks.set(name, { blocking: opts?.blocking, terminated: opts?.terminated });
    const isNew = !h.dbs.has(name);
    if (isNew) h.dbs.set(name, new Map());
    const rows = h.dbs.get(name)!;
    if (isNew) opts?.upgrade?.({ createObjectStore: () => ({ createIndex: () => {} }) });
    const byQueued = () => [...rows.values()].sort((a, b) => (a.queuedAt as number) - (b.queuedAt as number));
    return {
      close: () => void h.closed.push(name),
      put: async (_s: string, v: Record<string, unknown>) => void rows.set(v.clientEventId as string, { ...v }),
      get: async (_s: string, k: string) => rows.get(k),
      delete: async (_s: string, k: string) => void rows.delete(k),
      count: async () => rows.size,
      getAllFromIndex: async () => byQueued().map((r) => ({ ...r })),
      getAllKeysFromIndex: async (_s: string, _i: string, _q: unknown, n: number) =>
        byQueued().slice(0, n).map((r) => r.clientEventId),
    };
  }),
}));

import {
  addDroppedLocally,
  addToOutbox,
  clearDroppedLocally,
  getDroppedLocally,
  backoffMs,
  markFailed,
  outboxAvailable,
  outboxDbName,
  OUTBOX_MAX_EVENTS,
  OUTBOX_TTL_MS,
  removeFromOutbox,
  takeDue,
  __resetOutbox,
} from './outbox';

const ev = (n: number) => ({
  clientEventId: `id-${n}`,
  type: 'meeting.delete',
  entityId: '11111111-2222-4333-8444-555555555555',
  details: {},
  occurredAt: '2026-10-05T12:00:00.000Z',
});

beforeEach(() => {
  h.dbs.clear();
  h.opened.length = 0;
  h.failOpen = false;
  h.callbacks.clear();
  h.closed.length = 0;
  __resetOutbox();
  vi.stubGlobal('indexedDB', {});
});

describe('outbox', () => {
  it('uses its own per-user database, separate from the meetings database', async () => {
    await addToOutbox('u1', ev(1));
    await addToOutbox('u2', ev(2));
    expect(outboxDbName('u1')).toBe('referat-audit-outbox-u-u1');
    expect(h.opened.map((o) => o.name).sort()).toEqual(['referat-audit-outbox-u-u1', 'referat-audit-outbox-u-u2']);
    expect(h.opened.every((o) => !o.name.startsWith('referat-db'))).toBe(true);
    expect((await takeDue('u1', 10)).map((e) => e.clientEventId)).toEqual(['id-1']);
    expect((await takeDue('u2', 10)).map((e) => e.clientEventId)).toEqual(['id-2']);
  });

  it('returns events oldest first, limited, and only the due ones', async () => {
    await addToOutbox('u', ev(1), 1000);
    await addToOutbox('u', ev(2), 2000);
    await addToOutbox('u', ev(3), 3000);
    expect((await takeDue('u', 2, 4000)).map((e) => e.clientEventId)).toEqual(['id-1', 'id-2']);
    await markFailed('u', ['id-1'], 4000);
    expect((await takeDue('u', 10, 4000)).map((e) => e.clientEventId)).toEqual(['id-2', 'id-3']);
    expect((await takeDue('u', 10, 4000 + backoffMs(1))).map((e) => e.clientEventId)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('opens a fresh connection after the browser terminated the cached one', async () => {
    await addToOutbox('u', ev(1));
    await addToOutbox('u', ev(2));
    expect(h.opened).toHaveLength(1); // cached
    h.callbacks.get(outboxDbName('u'))!.terminated!();
    await addToOutbox('u', ev(3));
    expect(h.opened).toHaveLength(2);
  });

  it('closes and forgets the connection when another tab needs to upgrade or delete the database', async () => {
    await addToOutbox('u', ev(1));
    h.callbacks.get(outboxDbName('u'))!.blocking!();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.closed).toEqual([outboxDbName('u')]);
    await addToOutbox('u', ev(2));
    expect(h.opened).toHaveLength(2);
    expect((await takeDue('u', 10)).map((e) => e.clientEventId)).toEqual(['id-1', 'id-2']);
  });

  it('removes events', async () => {
    await addToOutbox('u', ev(1));
    await addToOutbox('u', ev(2));
    await removeFromOutbox('u', ['id-1']);
    expect((await takeDue('u', 10)).map((e) => e.clientEventId)).toEqual(['id-2']);
  });

  it('drops events older than 7 days when reading', async () => {
    await addToOutbox('u', ev(1), 1000);
    await addToOutbox('u', ev(2), 1000 + OUTBOX_TTL_MS);
    const due = await takeDue('u', 10, 1000 + OUTBOX_TTL_MS + 1);
    expect(due.map((e) => e.clientEventId)).toEqual(['id-2']);
  });

  it('is bounded: the oldest events are evicted beyond 1000', async () => {
    for (let i = 0; i < OUTBOX_MAX_EVENTS + 5; i++) await addToOutbox('u', ev(i), i);
    const all = await takeDue('u', 2000, OUTBOX_MAX_EVENTS + 10);
    expect(all).toHaveLength(OUTBOX_MAX_EVENTS);
    expect(all[0].clientEventId).toBe('id-5');
  });

  it('backs off exponentially up to 15 minutes', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10000, 20000, 40000]);
    expect(backoffMs(30)).toBe(15 * 60 * 1000);
  });

  it('counts attempts', async () => {
    await addToOutbox('u', ev(1), 1000);
    await markFailed('u', ['id-1'], 2000);
    await markFailed('u', ['id-1'], 3000);
    const [row] = await takeDue('u', 1, 3000 + backoffMs(2));
    expect(row.attempts).toBe(2);
  });

  it('never throws: a blocked IndexedDB just stores nothing', async () => {
    h.failOpen = true;
    expect(await addToOutbox('u', ev(1))).toBe(false);
    expect(await takeDue('u', 10)).toEqual([]);
    await expect(removeFromOutbox('u', ['x'])).resolves.toBeUndefined();
    await expect(markFailed('u', ['x'])).resolves.toBeUndefined();
    h.failOpen = false;
    expect(await addToOutbox('u', ev(1))).toBe(true); // a failed open is not cached
  });

  it('is a no-op without IndexedDB (server, tests)', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(outboxAvailable()).toBe(false);
    expect(await addToOutbox('u', ev(1))).toBe(false);
    expect(h.opened).toHaveLength(0);
  });
});

describe('events lost before delivery are counted', () => {
  it('eviction beyond 1000, expiry after 7 days and nothing else add to the count', async () => {
    expect(getDroppedLocally('u')).toBeNull();
    for (let i = 0; i < OUTBOX_MAX_EVENTS + 5; i++) await addToOutbox('u', ev(i), i);
    expect(getDroppedLocally('u')?.count).toBe(5);
    await takeDue('u', 10, OUTBOX_MAX_EVENTS + 10); // nothing expired yet
    expect(getDroppedLocally('u')?.count).toBe(5);
    await takeDue('u', 10, OUTBOX_TTL_MS + OUTBOX_MAX_EVENTS + 100); // everything is older than 7 days now
    expect(getDroppedLocally('u')?.count).toBe(5 + OUTBOX_MAX_EVENTS);
  });

  it('is kept per user, with a new id whenever the count changes (a retry of the same count is idempotent)', () => {
    addDroppedLocally('a', 2);
    const first = getDroppedLocally('a')!;
    expect(getDroppedLocally('a')).toEqual(first);
    addDroppedLocally('a', 1);
    const second = getDroppedLocally('a')!;
    expect(second.count).toBe(3);
    expect(second.clientEventId).not.toBe(first.clientEventId);
    expect(getDroppedLocally('b')).toBeNull();
  });

  it('subtracts what was reported and forgets the count at zero', () => {
    addDroppedLocally('a', 5);
    clearDroppedLocally('a', 2);
    expect(getDroppedLocally('a')?.count).toBe(3);
    clearDroppedLocally('a', 3);
    expect(getDroppedLocally('a')).toBeNull();
    clearDroppedLocally('a', 1); // nothing there: no error
  });

  it('ignores zero and negative counts and never throws', () => {
    addDroppedLocally('a', 0);
    addDroppedLocally('a', -3);
    expect(getDroppedLocally('a')).toBeNull();
  });
});

