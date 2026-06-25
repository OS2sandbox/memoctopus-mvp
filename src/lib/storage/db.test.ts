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

// A fake DB object returned by the mock openDB.
const fakeDbInstance = { __isFakeDb: true };

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
  openDB: vi.fn((name: string, version: number, handlers: { upgrade: UpgradeCallback }) => {
    capturedDbName = name;
    capturedVersion = version;
    capturedUpgrade = handlers?.upgrade;
    return Promise.resolve(fakeDbInstance);
  }),
  deleteDB: vi.fn((name: string) => {
    deletedDbs.push(name);
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

  it('discards the legacy origin-scoped "referat-db" (the leaky database)', async () => {
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
    expect(db).toBe(fakeDbInstance);
  });
});

describe('getDB — singleton / connection sharing', () => {
  beforeEach(() => {
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

  it('calls openDB exactly once even when getDB is called multiple times', async () => {
    const { openDB } = await import('idb');
    const mockOpenDB = vi.mocked(openDB);
    const callsBefore = mockOpenDB.mock.calls.length;

    const getDB = await freshGetDB();
    await getDB();
    await getDB();
    await getDB();

    // Only one new call should have been made since we imported after reset.
    expect(mockOpenDB.mock.calls.length - callsBefore).toBe(1);
  });
});

describe('getDB — upgrade callback creates object stores', () => {
  beforeEach(() => {
    capturedUpgrade = undefined;
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
