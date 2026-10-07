import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));

vi.mock('./index', () => ({ pool: { connect: mockConnect } }));

import { queryUserSchema, queryUserSchemaOne, getUserSchemaName } from './user-schema';

const USER = '1234-abcd';
const SCHEMA = 'u_1234_abcd';

type Handler = (sql: string, params?: unknown[]) => unknown;

// Fake pooled client. Every call is recorded in `events` so ordering relative
// to release() can be asserted; `handler` can override the result per statement.
function makeClient(handler: Handler = () => ({ rows: [] })) {
  const events: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      events.push(`query:${sql.trim().split('\n')[0]}`);
      return handler(sql, params);
    }),
    release: vi.fn((arg?: unknown) => {
      events.push(`release:${String(arg)}`);
    }),
  };
  return { client, events };
}

function markInitialized(userId = USER) {
  (globalThis as unknown as { initializedSchemas: Set<string> }).initializedSchemas.add(userId);
}

beforeEach(() => {
  mockConnect.mockReset();
  (globalThis as unknown as { initializedSchemas: Set<string> }).initializedSchemas.clear();
});

describe('getUserSchemaName', () => {
  it('prefixes with u_ and replaces dashes', () => {
    expect(getUserSchemaName(USER)).toBe(SCHEMA);
  });
});

describe('queryUserSchema', () => {
  it('sets a quoted search_path and runs the query with its params', async () => {
    markInitialized();
    const { client } = makeClient((sql) =>
      sql.startsWith('SELECT') ? { rows: [{ id: 'm1' }] } : { rows: [] },
    );
    mockConnect.mockResolvedValue(client);

    const rows = await queryUserSchema(USER, 'SELECT * FROM meetings WHERE id = $1', ['m1']);

    expect(rows).toEqual([{ id: 'm1' }]);
    expect(client.query).toHaveBeenNthCalledWith(1, `SET search_path TO "${SCHEMA}", public`);
    expect(client.query).toHaveBeenNthCalledWith(2, 'SELECT * FROM meetings WHERE id = $1', ['m1']);
  });

  it('resets search_path after a successful query and before release', async () => {
    markInitialized();
    const { client, events } = makeClient();
    mockConnect.mockResolvedValue(client);

    await queryUserSchema(USER, 'SELECT 1');

    expect(events).toEqual([
      `query:SET search_path TO "${SCHEMA}", public`,
      'query:SELECT 1',
      'query:RESET search_path',
      'release:false',
    ]);
  });

  it('resets and releases even when the query throws, and the original error propagates', async () => {
    markInitialized();
    const boom = new Error('query failed');
    const { client, events } = makeClient((sql) => {
      if (sql === 'SELECT broken') throw boom;
      return { rows: [] };
    });
    mockConnect.mockResolvedValue(client);

    await expect(queryUserSchema(USER, 'SELECT broken')).rejects.toBe(boom);

    expect(events.slice(-2)).toEqual(['query:RESET search_path', 'release:false']);
  });

  it('destroys the connection when RESET fails, without masking the result', async () => {
    markInitialized();
    const { client } = makeClient((sql) => {
      if (sql === 'RESET search_path') throw new Error('reset failed');
      return { rows: [{ ok: true }] };
    });
    mockConnect.mockResolvedValue(client);

    await expect(queryUserSchema(USER, 'SELECT 1')).resolves.toEqual([{ ok: true }]);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeTruthy();
  });

  it('destroys the connection when RESET fails, without masking the original query error', async () => {
    markInitialized();
    const queryErr = new Error('query failed');
    const { client } = makeClient((sql) => {
      if (sql === 'SELECT broken') throw queryErr;
      if (sql === 'RESET search_path') throw new Error('reset failed');
      return { rows: [] };
    });
    mockConnect.mockResolvedValue(client);

    await expect(queryUserSchema(USER, 'SELECT broken')).rejects.toBe(queryErr);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeTruthy();
  });

  it('runs ensureUserSchema only once per user per process', async () => {
    const clients: ReturnType<typeof makeClient>[] = [];
    mockConnect.mockImplementation(async () => {
      const c = makeClient(); // accepts any SQL, including all the DDL
      clients.push(c);
      return c.client;
    });

    await queryUserSchema(USER, 'SELECT 1');
    const connectsAfterFirst = mockConnect.mock.calls.length;
    const createSchemaCalls = () =>
      clients.flatMap((c) => c.client.query.mock.calls).filter(([sql]) =>
        String(sql).includes('CREATE SCHEMA IF NOT EXISTS'),
      );
    expect(createSchemaCalls()).toHaveLength(1);
    // one connection for ensureUserSchema, one for the query itself
    expect(connectsAfterFirst).toBe(2);

    await queryUserSchema(USER, 'SELECT 2');
    expect(createSchemaCalls()).toHaveLength(1);
    expect(mockConnect.mock.calls.length).toBe(connectsAfterFirst + 1);

    // A different user still gets their own schema created.
    await queryUserSchema('other-user', 'SELECT 3');
    expect(createSchemaCalls()).toHaveLength(2);
  });

  it("ensureUserSchema creates the person's own template changelog, idempotently, after the skabeloner it references", async () => {
    const { client } = makeClient();
    mockConnect.mockResolvedValue(client);
    await queryUserSchema(USER, 'SELECT 1');

    const ddl = client.query.mock.calls.map(([sql]) => String(sql));
    const at = (needle: string) => ddl.findIndex((q) => q.includes(needle));
    const versions = ddl[at(`"${SCHEMA}".skabelon_versions (`)];
    expect(versions).toContain('CREATE TABLE IF NOT EXISTS');
    expect(versions).toContain(`REFERENCES "${SCHEMA}".skabeloner(id) ON DELETE CASCADE`);
    expect(versions).toContain('UNIQUE (skabelon_id, version)');
    expect(versions).toMatch(/change_note\s+TEXT,/); // nullable: the note is optional
    expect(at(`"${SCHEMA}".skabelon_versions (`)).toBeGreaterThan(at(`"${SCHEMA}".skabeloner (`));
  });

  it('ensureUserSchema does not set search_path on its pooled client', async () => {
    const { client } = makeClient();
    mockConnect.mockResolvedValue(client);

    await queryUserSchema(USER, 'SELECT 1');

    // Only the query phase (SET + RESET) touches search_path; the DDL phase is
    // schema-qualified, so nothing there can leak.
    const searchPathStatements = client.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /search_path/i.test(sql));
    expect(searchPathStatements).toEqual([
      `SET search_path TO "${SCHEMA}", public`,
      'RESET search_path',
    ]);
  });
});

describe('queryUserSchemaOne', () => {
  it('returns the first row, or null when there are none', async () => {
    markInitialized();
    const { client } = makeClient((sql) =>
      sql === 'SELECT some' ? { rows: [{ a: 1 }, { a: 2 }] } : { rows: [] },
    );
    mockConnect.mockResolvedValue(client);

    await expect(queryUserSchemaOne(USER, 'SELECT some')).resolves.toEqual({ a: 1 });
    await expect(queryUserSchemaOne(USER, 'SELECT none')).resolves.toBeNull();
  });
});
