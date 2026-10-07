import { beforeEach, describe, expect, it, vi } from 'vitest';

// withUserSchemaTx runs the callback with a scripted query function: `tx.script` answers by SQL text.
const q = vi.hoisted(() => {
  const tx = { log: [] as Array<{ sql: string; params: unknown[] }>, script: (_sql: string): unknown[] | Error => [] };
  return {
    queryUserSchema: vi.fn(),
    queryUserSchemaOne: vi.fn(),
    withUserSchemaTx: vi.fn(async (_u: string, fn: (query: (sql: string, params?: unknown[]) => Promise<unknown[]>) => Promise<unknown>) =>
      fn(async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        tx.log.push({ sql: flat, params });
        const r = tx.script(flat);
        if (r instanceof Error) throw r;
        return r;
      }),
    ),
    tx,
  };
});
vi.mock('@/lib/db/user-schema', () => q);
const mockSafeLog = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/safe-log', () => ({ safeLogError: mockSafeLog }));

import { SKABELON_VERSION_CAP, createSkabelon, listSkabelonVersions, recordSkabelonVersion, updateSkabelonWithHistory } from './server';

const USER = 'user-1';
const row = {
  id: 'sk-1',
  name: 'Mit navn',
  description: '',
  prompt: 'Min prompt',
  include_deltagere: false,
  include_beslutningspunkter: true,
  include_dagsorden: false,
  include_dato: false,
  is_default: false,
  created_at: '2026-06-01T08:00:00.000Z',
  updated_at: '2026-06-01T08:00:00.000Z',
};

beforeEach(() => {
  q.queryUserSchema.mockReset().mockResolvedValue([]);
  q.queryUserSchemaOne.mockReset();
  q.tx.log.length = 0;
  q.withUserSchemaTx.mockClear();
  q.tx.script = () => [];
  mockSafeLog.mockReset();
});

describe('personal template changelog (own schema)', () => {
  it('creating a template writes the row and version 1 (no note) in ONE transaction', async () => {
    q.tx.script = (sql) => (sql.startsWith('INSERT INTO skabeloner') ? [row] : []);
    const created = await createSkabelon(USER, { name: 'Mit navn', prompt: 'Min prompt' });
    expect(created.id).toBe('sk-1');
    expect(q.withUserSchemaTx).toHaveBeenCalledTimes(1);
    expect(q.queryUserSchema).not.toHaveBeenCalled();
    const version = q.tx.log.find((l) => l.sql.startsWith('INSERT INTO skabelon_versions'))!;
    expect(version.params.slice(0, 3)).toEqual(['sk-1', null, []]);
  });

  it('a failing changelog write is logged without content and never loses the created template', async () => {
    q.tx.script = (sql) => (sql.startsWith('INSERT INTO skabeloner') ? [row] : sql.startsWith('INSERT INTO skabelon_versions') ? new Error('boom Min prompt') : []);
    const created = await createSkabelon(USER, { name: 'Mit navn', prompt: 'Min prompt' });
    expect(created.id).toBe('sk-1');
    expect(mockSafeLog).toHaveBeenCalledTimes(1);
    const sqls = q.tx.log.map((l) => l.sql);
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT skabelon_version');
    expect(sqls).not.toContain('RELEASE SAVEPOINT skabelon_version');
  });

  it('retries a version number that collided with a concurrent writer (23505), but not forever', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    q.queryUserSchema.mockRejectedValueOnce(dup).mockResolvedValueOnce([]);
    await recordSkabelonVersion(USER, { ...row, id: 'sk-1' } as never, ['prompt'], null);
    expect(q.queryUserSchema).toHaveBeenCalledTimes(2);
    q.queryUserSchema.mockReset().mockRejectedValue(dup);
    await expect(recordSkabelonVersion(USER, { ...row, id: 'sk-1' } as never, ['prompt'], null)).rejects.toBe(dup);
    expect(q.queryUserSchema).toHaveBeenCalledTimes(3);
  });

  it('records the next version number in ONE statement, with the optional note and a snapshot', async () => {
    await recordSkabelonVersion(USER, { ...row, id: 'sk-1', isDefault: false, includeDeltagere: false, includeBeslutningspunkter: true, includeDagsorden: false, includeDato: false, createdAt: '', updatedAt: '' }, ['prompt'], 'Strammet op');
    expect(q.queryUserSchema).toHaveBeenCalledTimes(1);
    const [userId, sql, params] = q.queryUserSchema.mock.calls[0];
    expect(userId).toBe(USER);
    expect(sql).toMatch(/COALESCE\(MAX\(version\), 0\) \+ 1/);
    expect(sql).toContain('FROM skabelon_versions WHERE skabelon_id = $1');
    expect(params.slice(0, 3)).toEqual(['sk-1', 'Strammet op', ['prompt']]);
    expect(JSON.parse(String(params[3]))).toMatchObject({ name: 'Mit navn', prompt: 'Min prompt' });
  });

  it('lists newest first and maps rows; null for a template that is not in the schema', async () => {
    q.queryUserSchemaOne.mockResolvedValueOnce(row);
    q.queryUserSchema.mockResolvedValueOnce([
      { version: 2, change_note: 'Strammet op', changed_fields: ['prompt'], created_at: new Date('2026-06-02T08:00:00Z') },
      { version: 1, change_note: null, changed_fields: [], created_at: '2026-06-01T08:00:00.000Z' },
    ]);
    const out = await listSkabelonVersions(USER, 'sk-1');
    expect(q.queryUserSchema.mock.calls[0][1]).toContain('ORDER BY version DESC');
    expect(out).toEqual([
      { version: 2, changeNote: 'Strammet op', changedFields: ['prompt'], createdAt: '2026-06-02T08:00:00.000Z' },
      { version: 1, changeNote: null, changedFields: [], createdAt: '2026-06-01T08:00:00.000Z' },
    ]);
    // The snapshot is stored for the person but never listed.
    expect(q.queryUserSchema.mock.calls[0][1]).not.toContain('snapshot');

    q.queryUserSchemaOne.mockResolvedValueOnce(null);
    expect(await listSkabelonVersions(USER, 'nope')).toBeNull();
  });

  describe('updateSkabelonWithHistory', () => {
    const before = { ...row, prompt: 'Gammel' };
    const after = { ...row, prompt: 'Ny' };
    const script = (extra: (sql: string) => unknown[] | Error | undefined = () => undefined, seen = 1) => (sql: string): unknown[] | Error => {
      const o = extra(sql);
      if (o !== undefined) return o;
      if (sql.startsWith('SELECT * FROM skabeloner')) return [before];
      if (sql.startsWith('UPDATE skabeloner')) return [after];
      if (sql.startsWith('SELECT count(*)')) return [{ n: seen }];
      return [];
    };
    const input = { name: 'Mit navn', prompt: 'Ny' };

    it('locks the row first, updates, and writes the entry with the note, all in one transaction', async () => {
      q.tx.script = script();
      const r = await updateSkabelonWithHistory(USER, 'sk-1', input, 'Strammet op');
      expect(r?.changedFields).toEqual(['prompt']);
      expect(q.withUserSchemaTx).toHaveBeenCalledTimes(1);
      const sqls = q.tx.log.map((l) => l.sql);
      expect(sqls[0]).toMatch(/^SELECT \* FROM skabeloner WHERE id = \$1 FOR UPDATE$/);
      expect(sqls.findIndex((s) => s.startsWith('UPDATE skabeloner'))).toBeLessThan(sqls.findIndex((s) => s.startsWith('INSERT INTO skabelon_versions')));
      const ins = q.tx.log.filter((l) => l.sql.startsWith('INSERT INTO skabelon_versions'));
      expect(ins).toHaveLength(1);
      expect(ins[0].params.slice(0, 3)).toEqual(['sk-1', 'Strammet op', ['prompt']]);
      expect(q.queryUserSchema).not.toHaveBeenCalled();
    });

    it('returns null for a template that is not there, writing nothing', async () => {
      q.tx.script = script((s) => (s.startsWith('SELECT * FROM skabeloner') ? [] : undefined));
      expect(await updateSkabelonWithHistory(USER, 'nope', input, null)).toBeNull();
      expect(q.tx.log).toHaveLength(1);
    });

    it('keeps a note typed with no field change as a version row', async () => {
      q.tx.script = script((s) => (s.startsWith('UPDATE skabeloner') ? [before] : undefined));
      const r = await updateSkabelonWithHistory(USER, 'sk-1', input, 'Bare en note til mig selv');
      expect(r?.changedFields).toEqual([]);
      const ins = q.tx.log.filter((l) => l.sql.startsWith('INSERT INTO skabelon_versions'));
      expect(ins).toHaveLength(1);
      expect(ins[0].params.slice(0, 3)).toEqual(['sk-1', 'Bare en note til mig selv', []]);
    });

    it('writes no entry when nothing changed and there is no note', async () => {
      q.tx.script = script((s) => (s.startsWith('UPDATE skabeloner') ? [before] : undefined));
      await updateSkabelonWithHistory(USER, 'sk-1', input, null);
      expect(q.tx.log.some((l) => l.sql.startsWith('INSERT INTO skabelon_versions'))).toBe(false);
    });

    it('creates version 1 (the state before the edit, no note) lazily for a template that predates the changelog', async () => {
      q.tx.script = script(undefined, 0);
      await updateSkabelonWithHistory(USER, 'sk-1', input, 'Første ændring');
      const ins = q.tx.log.filter((l) => l.sql.startsWith('INSERT INTO skabelon_versions'));
      expect(ins).toHaveLength(2);
      expect(ins[0].params.slice(0, 3)).toEqual(['sk-1', null, []]);
      expect(JSON.parse(String(ins[0].params[3])).prompt).toBe('Gammel');
      expect(ins[1].params.slice(0, 3)).toEqual(['sk-1', 'Første ændring', ['prompt']]);
    });

    it(`prunes everything older than the newest ${SKABELON_VERSION_CAP} versions`, async () => {
      q.tx.script = script();
      await updateSkabelonWithHistory(USER, 'sk-1', input, null);
      const del = q.tx.log.find((l) => l.sql.startsWith('DELETE FROM skabelon_versions'))!;
      expect(del.sql).toContain('MAX(version)');
      expect(del.params).toEqual(['sk-1', SKABELON_VERSION_CAP]);
      expect(SKABELON_VERSION_CAP).toBe(100);
    });

    it('a failing changelog write is rolled back to its savepoint and logged, and the edit still commits', async () => {
      q.tx.script = script((s) => (s.startsWith('INSERT INTO skabelon_versions') ? new Error('boom') : undefined));
      const r = await updateSkabelonWithHistory(USER, 'sk-1', input, null);
      expect(r?.skabelon.prompt).toBe('Ny');
      expect(mockSafeLog).toHaveBeenCalledTimes(1);
      expect(q.tx.log.map((l) => l.sql)).toContain('ROLLBACK TO SAVEPOINT skabelon_version');
    });

    it('an error in the update itself propagates (the transaction rolls back, the route records an error event)', async () => {
      q.tx.script = script((s) => (s.startsWith('UPDATE skabeloner') ? new Error('db down') : undefined));
      await expect(updateSkabelonWithHistory(USER, 'sk-1', input, null)).rejects.toThrow('db down');
    });
  });
});
