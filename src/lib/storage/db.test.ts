import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Fake idb ─────────────────────────────────────────────────────────────────

// We capture the upgrade callback and the openDB arguments so tests can
// drive the behaviour without a real IndexedDB implementation.

type UpgradeCallback = (db: FakeUpgradeDb) => void;

interface CreateObjectStoreOptions {
  keyPath?: string;
}

interface FakeIndex {
  keyPath: string;
}

interface FakeObjectStore {
  name: string;
  keyPath: string | undefined;
  indexes: Map<string, FakeIndex>;
  createIndex: (name: string, keyPath: string) => FakeIndex;
}

interface FakeUpgradeDb {
  createObjectStore: (name: string, opts?: CreateObjectStoreOptions) => FakeObjectStore;
  objectStoreNames: Set<string>;
  stores: Map<string, FakeObjectStore>;
}

// Holds the captured openDB arguments and the upgrade callback from the most
// recent openDB call (reset per test via module re-import).
let capturedDbName: string | undefined;
let capturedVersion: number | undefined;
let capturedUpgrade: UpgradeCallback | undefined;
let deletedDbs: string[] = [];

// A fake DB object returned by the mock openDB. Backed by in-memory stores so the
// legacy-adoption pass can actually read and write records.
interface FakeDb {
  __isFakeDb: true;
  name: string;
  data: Map<string, Map<string, unknown>>;
  objectStoreNames: { contains(name: string): boolean };
  getAll(store: string): Promise<unknown[]>;
  get(store: string, key: string): Promise<unknown>;
  put(store: string, value: unknown): Promise<unknown>;
  close(): void;
  closed: boolean;
}

// Databases the fake openDB has handed out, keyed by name, so a test can seed the
// legacy database before the module under test opens it.
let fakeDbs: Map<string, FakeDb>;

function makeFakeDb(name: string): FakeDb {
  const data = new Map<string, Map<string, unknown>>();
  const keyOf = (store: string, value: unknown) =>
    String((value as Record<string, unknown>)[store === 'audio' ? 'meetingId' : 'id']);
  return {
    __isFakeDb: true,
    name,
    data,
    closed: false,
    objectStoreNames: { contains: (s: string) => data.has(s) },
    getAll: (store: string) => Promise.resolve([...(data.get(store)?.values() ?? [])]),
    get: (store: string, key: string) => Promise.resolve(data.get(store)?.get(key)),
    put: (store: string, value: unknown) => {
      if (!data.has(store)) data.set(store, new Map());
      data.get(store)!.set(keyOf(store, value), value);
      return Promise.resolve(undefined);
    },
    close() { this.closed = true; },
  };
}

// Seed a store in a (not yet opened) database.
function seed(dbName: string, store: string, records: unknown[]) {
  const db = fakeDbs.get(dbName) ?? makeFakeDb(dbName);
  fakeDbs.set(dbName, db);
  if (!db.data.has(store)) db.data.set(store, new Map());
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    db.data.get(store)!.set(String(rec[store === 'audio' ? 'meetingId' : 'id']), r);
  }
  return db;
}

// `indexedDB.databases()` drives the legacy existence check.
function setExistingDatabases(names: string[] | null) {
  const idb = names === null
    ? {}
    : { databases: () => Promise.resolve(names.map((name) => ({ name }))) };
  vi.stubGlobal('indexedDB', idb);
}

function makeFakeUpgradeDb(): FakeUpgradeDb {
  const stores = new Map<string, FakeObjectStore>();
  const db: FakeUpgradeDb = {
    stores,
    objectStoreNames: new Set(),
    createObjectStore(name: string, opts?: CreateObjectStoreOptions): FakeObjectStore {
      const store: FakeObjectStore = {
        name,
        keyPath: opts?.keyPath,
        indexes: new Map(),
        createIndex(indexName: string, keyPath: string) {
          const idx: FakeIndex = { keyPath };
          this.indexes.set(indexName, idx);
          return idx;
        },
      };
      stores.set(name, store);
      db.objectStoreNames.add(name);
      return store;
    },
  };
  return db;
}

vi.mock('idb', () => ({
  openDB: vi.fn((name: string, version: number, handlers?: { upgrade: UpgradeCallback }) => {
    // Only the scoped open passes an upgrade handler; the legacy-adoption open does
    // not, and must not clobber what the assertions below inspect.
    if (handlers?.upgrade) {
      capturedDbName = name;
      capturedVersion = version;
      capturedUpgrade = handlers.upgrade;
    }
    let db = fakeDbs.get(name);
    if (!db) { db = makeFakeDb(name); fakeDbs.set(name, db); }
    return Promise.resolve(db);
  }),
  deleteDB: vi.fn((name: string) => {
    deletedDbs.push(name);
    fakeDbs.delete(name);
    return Promise.resolve();
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Re-import the module under test fresh each time so the module-level
// `dbPromise` singleton is reset between tests. Sets a storage user so getDB()
// resolves (it waits for a user otherwise — never opens an unscoped database).
async function freshGetDB(userId = 'user-test') {
  // Clear the module cache so the `dbPromise` variable is re-initialised.
  vi.resetModules();
  const scope = await import('./scope');
  scope.setStorageUserId(userId);
  const mod = await import('./db');
  return mod.getDB;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getDB — database name and version', () => {
  beforeEach(() => {
    capturedDbName = undefined;
    capturedVersion = undefined;
    capturedUpgrade = undefined;
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  it('opens a database namespaced by the active user id', async () => {
    const getDB = await freshGetDB('user-abc');
    await getDB();
    expect(capturedDbName).toBe('referat-db-u-user-abc');
  });

  it('opens a DIFFERENT database for a different user (isolation)', async () => {
    const getA = await freshGetDB('user-A');
    await getA();
    const nameA = capturedDbName;

    // A different user signing in on the same browser must hit a separate database.
    const getB = await freshGetDB('user-B');
    await getB();
    const nameB = capturedDbName;

    expect(nameA).toBe('referat-db-u-user-A');
    expect(nameB).toBe('referat-db-u-user-B');
    expect(nameA).not.toBe(nameB);
  });

  it('removes the legacy origin-scoped "referat-db" once its records are adopted', async () => {
    const getDB = await freshGetDB('user-abc');
    await getDB();
    expect(deletedDbs).toContain('referat-db');
  });

  it('opens the database at version 1', async () => {
    const getDB = await freshGetDB();
    await getDB();
    expect(capturedVersion).toBe(1);
  });

  it('returns the DB instance resolved by idb', async () => {
    const getDB = await freshGetDB();
    const db = await getDB();
    expect((db as unknown as FakeDb).__isFakeDb).toBe(true);
  });
});

describe('getDB — singleton / connection sharing', () => {
  beforeEach(() => {
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  it('returns the same promise on repeated calls (single connection)', async () => {
    const getDB = await freshGetDB();
    const p1 = getDB();
    const p2 = getDB();
    expect(p1).toBe(p2);
  });

  it('resolves to the same DB instance on every call', async () => {
    const getDB = await freshGetDB();
    const db1 = await getDB();
    const db2 = await getDB();
    expect(db1).toBe(db2);
  });

  it('opens the scoped database exactly once even when getDB is called multiple times', async () => {
    const { openDB } = await import('idb');
    const mockOpenDB = vi.mocked(openDB);
    const callsBefore = mockOpenDB.mock.calls.length;

    const getDB = await freshGetDB();
    await getDB();
    await getDB();
    await getDB();

    const newCalls = mockOpenDB.mock.calls.slice(callsBefore);
    // The scoped open is the one carrying an upgrade handler; the legacy-adoption
    // open is separate and asserted below.
    const scopedOpens = newCalls.filter((c) => Boolean(c[2]));
    expect(scopedOpens).toHaveLength(1);
  });

  it('opens the legacy database at most once, regardless of getDB() calls', async () => {
    const { openDB } = await import('idb');
    const mockOpenDB = vi.mocked(openDB);
    const callsBefore = mockOpenDB.mock.calls.length;

    const getDB = await freshGetDB();
    await getDB();
    await getDB();

    const legacyOpens = mockOpenDB.mock.calls
      .slice(callsBefore)
      .filter((c) => c[0] === 'referat-db');
    expect(legacyOpens.length).toBeLessThanOrEqual(1);
  });
});

describe('getDB — upgrade callback creates object stores', () => {
  beforeEach(() => {
    capturedUpgrade = undefined;
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  async function runUpgrade() {
    const getDB = await freshGetDB();
    await getDB();
    const upgradeDb = makeFakeUpgradeDb();
    capturedUpgrade!(upgradeDb);
    return upgradeDb;
  }

  it('creates the "meetings" object store', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.has('meetings')).toBe(true);
  });

  it('creates the "transcripts" object store', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.has('transcripts')).toBe(true);
  });

  it('creates the "minutes" object store', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.has('minutes')).toBe(true);
  });

  it('creates the "audio" object store', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.has('audio')).toBe(true);
  });

  it('creates exactly four object stores', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.size).toBe(4);
  });
});

describe('getDB — upgrade callback: keyPaths', () => {
  beforeEach(() => {
    capturedUpgrade = undefined;
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  async function runUpgrade() {
    const getDB = await freshGetDB();
    await getDB();
    const upgradeDb = makeFakeUpgradeDb();
    capturedUpgrade!(upgradeDb);
    return upgradeDb;
  }

  it('"meetings" store uses keyPath "id"', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.get('meetings')?.keyPath).toBe('id');
  });

  it('"transcripts" store uses keyPath "id"', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.get('transcripts')?.keyPath).toBe('id');
  });

  it('"minutes" store uses keyPath "id"', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.get('minutes')?.keyPath).toBe('id');
  });

  it('"audio" store uses keyPath "meetingId"', async () => {
    const upgradeDb = await runUpgrade();
    expect(upgradeDb.stores.get('audio')?.keyPath).toBe('meetingId');
  });
});

describe('getDB — upgrade callback: by-meeting indexes', () => {
  beforeEach(() => {
    capturedUpgrade = undefined;
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  async function runUpgrade() {
    const getDB = await freshGetDB();
    await getDB();
    const upgradeDb = makeFakeUpgradeDb();
    capturedUpgrade!(upgradeDb);
    return upgradeDb;
  }

  it('"transcripts" store has a "by-meeting" index', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('transcripts')!;
    expect(store.indexes.has('by-meeting')).toBe(true);
  });

  it('"transcripts" "by-meeting" index is keyed on "meetingId"', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('transcripts')!;
    expect(store.indexes.get('by-meeting')?.keyPath).toBe('meetingId');
  });

  it('"minutes" store has a "by-meeting" index', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('minutes')!;
    expect(store.indexes.has('by-meeting')).toBe(true);
  });

  it('"minutes" "by-meeting" index is keyed on "meetingId"', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('minutes')!;
    expect(store.indexes.get('by-meeting')?.keyPath).toBe('meetingId');
  });

  it('"meetings" store has no indexes', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('meetings')!;
    expect(store.indexes.size).toBe(0);
  });

  it('"audio" store has no indexes', async () => {
    const upgradeDb = await runUpgrade();
    const store = upgradeDb.stores.get('audio')!;
    expect(store.indexes.size).toBe(0);
  });
});

describe('getDB — upgrade callback idempotency (simulated re-run)', () => {
  beforeEach(() => {
    capturedUpgrade = undefined;
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  it('running the upgrade callback twice on the same db does not throw', async () => {
    const getDB = await freshGetDB();
    await getDB();

    // The actual idb library protects against double-create by throwing
    // "IDBObjectStore already exists". In the real upgrade path the callback
    // is invoked only once per version bump, so our fake just verifies the
    // callback itself is callable twice without internal errors.
    const upgradeDb = makeFakeUpgradeDb();
    expect(() => {
      capturedUpgrade!(upgradeDb);
      // Simulate a second independent invocation with a fresh db (no state).
      const upgradeDb2 = makeFakeUpgradeDb();
      capturedUpgrade!(upgradeDb2);
    }).not.toThrow();
  });

  it('each invocation of the upgrade callback produces the same set of stores', async () => {
    const getDB = await freshGetDB();
    await getDB();

    const upgradeDb1 = makeFakeUpgradeDb();
    capturedUpgrade!(upgradeDb1);

    const upgradeDb2 = makeFakeUpgradeDb();
    capturedUpgrade!(upgradeDb2);

    expect([...upgradeDb1.stores.keys()].sort()).toEqual([...upgradeDb2.stores.keys()].sort());
  });
});

// ─── Legacy adoption ──────────────────────────────────────────────────────────

// Deployments are single-user-per-device, so the first user to sign in after the
// upgrade adopts whatever the pre-scoping database held. Without this their
// meetings would be unreachable — IndexedDB is the only place they live.
describe('getDB — adopting the legacy origin-scoped database', () => {
  beforeEach(() => {
    deletedDbs = [];
    fakeDbs = new Map();
    setExistingDatabases(['referat-db']);
    vi.resetModules();
  });

  it('copies legacy records into the signed-in user’s database', async () => {
    seed('referat-db', 'meetings', [{ id: 'm1', title: 'Gammelt møde' }]);
    seed('referat-db', 'audio', [{ meetingId: 'm1', blob: 'audio-bytes' }]);

    const getDB = await freshGetDB('user-abc');
    const db = await getDB() as unknown as FakeDb;

    expect(await db.get('meetings', 'm1')).toEqual({ id: 'm1', title: 'Gammelt møde' });
    expect(await db.get('audio', 'm1')).toEqual({ meetingId: 'm1', blob: 'audio-bytes' });
  });

  it('carries over transcripts and minutes too, not just meetings', async () => {
    seed('referat-db', 'transcripts', [{ id: 't1', meetingId: 'm1', rawText: 'hej' }]);
    seed('referat-db', 'minutes', [{ id: 'n1', meetingId: 'm1' }]);

    const getDB = await freshGetDB('user-abc');
    const db = await getDB() as unknown as FakeDb;

    expect(await db.get('transcripts', 't1')).toBeDefined();
    expect(await db.get('minutes', 'n1')).toBeDefined();
  });

  it('deletes the legacy database once the copy succeeds', async () => {
    seed('referat-db', 'meetings', [{ id: 'm1', title: 'Gammelt møde' }]);
    const getDB = await freshGetDB('user-abc');
    await getDB();
    expect(deletedDbs).toContain('referat-db');
  });

  it('never overwrites a record the user already has', async () => {
    seed('referat-db', 'meetings', [{ id: 'm1', title: 'Gammel titel' }]);
    seed('referat-db-u-user-abc', 'meetings', [{ id: 'm1', title: 'Min titel' }]);

    const getDB = await freshGetDB('user-abc');
    const db = await getDB() as unknown as FakeDb;

    expect(await db.get('meetings', 'm1')).toEqual({ id: 'm1', title: 'Min titel' });
  });

  it('resolves getDB() only after adoption, so the archive never renders empty', async () => {
    seed('referat-db', 'meetings', [{ id: 'm1', title: 'Gammelt møde' }]);
    const getDB = await freshGetDB('user-abc');
    // The very first resolution must already contain the adopted record.
    const db = await getDB() as unknown as FakeDb;
    expect(await db.getAll('meetings')).toHaveLength(1);
  });

  it('does nothing when no legacy database exists', async () => {
    setExistingDatabases(['referat-db-u-user-abc']);
    const getDB = await freshGetDB('user-abc');
    await getDB();
    expect(deletedDbs).not.toContain('referat-db');
  });

  it('keeps the legacy database when the copy fails, so nothing is lost', async () => {
    const legacy = seed('referat-db', 'meetings', [{ id: 'm1' }]);
    legacy.getAll = () => Promise.reject(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const getDB = await freshGetDB('user-abc');
    await getDB();

    expect(deletedDbs).not.toContain('referat-db');
  });

  it('runs adoption once per page load, not on every getDB() call', async () => {
    seed('referat-db', 'meetings', [{ id: 'm1' }]);
    const getDB = await freshGetDB('user-abc');
    await getDB();
    await getDB();
    await getDB();
    expect(deletedDbs.filter((n) => n === 'referat-db')).toHaveLength(1);
  });

  it('still adopts when indexedDB.databases() is unavailable (older browsers)', async () => {
    setExistingDatabases(null);
    seed('referat-db', 'meetings', [{ id: 'm1', title: 'Gammelt møde' }]);

    const getDB = await freshGetDB('user-abc');
    const db = await getDB() as unknown as FakeDb;

    expect(await db.get('meetings', 'm1')).toBeDefined();
  });

  it('closes the legacy connection instead of leaking it', async () => {
    const legacy = seed('referat-db', 'meetings', [{ id: 'm1' }]);
    const getDB = await freshGetDB('user-abc');
    await getDB();
    expect(legacy.closed).toBe(true);
  });
});
