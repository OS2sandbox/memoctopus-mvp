import { beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({ queryUserSchema: vi.fn(), queryUserSchemaOne: vi.fn() }));
vi.mock('@/lib/db/user-schema', () => q);

import { createSkabelon, listSkabelonVersions, recordSkabelonVersion } from './server';

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
});

describe('personal template changelog (own schema)', () => {
  it('creating a template writes version 1 without a note', async () => {
    q.queryUserSchemaOne.mockResolvedValueOnce(row);
    await createSkabelon(USER, { name: 'Mit navn', prompt: 'Min prompt' });
    const [, sql, params] = q.queryUserSchema.mock.calls[0];
    expect(sql).toContain('INSERT INTO skabelon_versions');
    expect(params.slice(0, 3)).toEqual(['sk-1', null, []]);
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
});
