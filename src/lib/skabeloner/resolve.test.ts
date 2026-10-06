import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() } }));

import { MAX_ORG_DEPTH } from '@/lib/authz/scope';
import { listCentralForUser, resolveCentralTemplate, type ResolveEnv } from './resolve';

const ID = '44444444-5555-4666-8777-888888888888';
const SECRET = 'HEMMELIG-PROMPT-TEKST';

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'Dialogmøde',
  description: 'Til dialogmøder',
  include_deltagere: true,
  include_beslutningspunkter: false,
  include_dagsorden: true,
  include_dato: false,
  allow_user_instruction: true,
  allow_toggle_overrides: false,
  current_version: 3,
  ...over,
});

function fakeEnv(rows: Array<Record<string, unknown>>, schema = 'public') {
  const query = vi.fn(async (_t: string, _p: unknown[]) => ({ rows }));
  const env: ResolveEnv = { schema, query };
  return { env, query };
}

describe('listCentralForUser', () => {
  it('maps rows to prompt-free summaries in ONE parameterised, schema-qualified query', async () => {
    const { env, query } = fakeEnv([row()]);
    const out = await listCentralForUser('user-1', env);

    expect(out).toEqual([
      {
        id: ID,
        source: 'central',
        name: 'Dialogmøde',
        description: 'Til dialogmøder',
        includeDeltagere: true,
        includeBeslutningspunkter: false,
        includeDagsorden: true,
        includeDato: false,
        locked: true,
        version: 3,
        allowUserInstruction: true,
        allowToggleOverrides: false,
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['user-1', MAX_ORG_DEPTH]);
    expect(sql).not.toContain('user-1');
    for (const t of ['directory_users', 'org_unit_members', 'org_units', 'central_templates', 'central_template_targets']) {
      expect(sql).toContain(`"public".${t}`);
    }
    expect(sql).not.toMatch(/\bprompt\b/);
    expect(sql).toMatch(/d\.disabled = false/);
    expect(sql).toMatch(/ct\.status = 'active'/);
    // Cycle safety: UNION (not UNION ALL) plus a depth cap.
    expect(sql).toMatch(/\bUNION\b(?!\s+ALL)/);
    expect(sql).toMatch(/depth < \$2::int/);
    // Owner-subtree re-check at read time: an upward walk from each candidate target to the owner unit.
    expect(sql).toMatch(/owner_org_unit_uuid/);
    expect(sql).toMatch(/walk\(template_id, target_uuid, owner_uuid, cur_uuid, depth\)/);
    expect(sql).toMatch(/w\.cur_uuid = w\.owner_uuid/);
    expect(sql).toMatch(/w\.depth < \$2::int/);
    // The walk starts only from targets the user matches, in the same single statement.
    expect(sql).toMatch(/cand\(template_id, target_uuid, owner_uuid\)/);
    expect(sql).not.toMatch(/ct\.id = \$3/);
  });

  it('never exposes the creator or last editor (manager-side data) even if a row carried them', async () => {
    const { env, query } = fakeEnv([
      row({ created_by_name: 'Anne Admin', last_edited_by_name: 'Bo Beslutter', last_edited_at: new Date() }),
    ]);
    const out = await listCentralForUser('user-1', env);
    for (const k of ['createdByName', 'lastEditedByName', 'lastEditedAt', 'createdAt', 'updatedAt', 'ownerOrgUnitUuid']) {
      expect(out[0]).not.toHaveProperty(k);
    }
    expect(JSON.stringify(out)).not.toMatch(/Anne Admin|Bo Beslutter/);
    // The user-facing query does not even read the changelog.
    expect(query.mock.calls[0][0]).not.toMatch(/central_template_versions|changed_by/);
  });

  it('never exposes a prompt even if a row somehow carried one', async () => {
    const { env } = fakeEnv([row({ prompt: SECRET })]);
    const out = await listCentralForUser('user-1', env);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out[0]).not.toHaveProperty('prompt');
  });

  it('returns an empty list without querying for an empty user id', async () => {
    const { env, query } = fakeEnv([row()]);
    expect(await listCentralForUser('', env)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the injected schema, quoted, and rejects a malformed schema name', async () => {
    const { env, query } = fakeEnv([], 't_abc');
    await listCentralForUser('u', env);
    expect(query.mock.calls[0][0]).toContain('"t_abc".central_templates');
    await expect(listCentralForUser('u', fakeEnv([], 'x"; DROP TABLE y; --').env)).rejects.toThrow('invalid schema name');
  });

  it('propagates a database error (the route decides how to degrade)', async () => {
    const env: ResolveEnv = { schema: 'public', query: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(listCentralForUser('u', env)).rejects.toThrow('boom');
  });
});

describe('resolveCentralTemplate', () => {
  it('returns the internal shape with the prompt, version and flags', async () => {
    const { env, query } = fakeEnv([row({ prompt: SECRET })]);
    const out = await resolveCentralTemplate('user-1', ID.toUpperCase(), env);
    expect(out).toEqual({
      id: ID,
      version: 3,
      prompt: SECRET,
      includeDeltagere: true,
      includeBeslutningspunkter: false,
      includeDagsorden: true,
      includeDato: false,
      allowUserInstruction: true,
      allowToggleOverrides: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['user-1', MAX_ORG_DEPTH, ID]);
    expect(sql).toContain('ct.id = $3::uuid');
    // The id filter is pushed into the candidate step so only this template's targets are walked.
    expect(sql).toMatch(/ct\.status = 'active' AND ct\.id = \$3::uuid/);
    expect(sql).toMatch(/w\.cur_uuid = w\.owner_uuid/);
    expect(sql).toMatch(/d\.disabled = false/);
    expect(sql).toMatch(/ct\.status = 'active'/);
  });

  it('returns null when nothing matches (unknown, archived, not a recipient look the same)', async () => {
    expect(await resolveCentralTemplate('user-1', ID, fakeEnv([]).env)).toBeNull();
  });

  it.each(['', 'not-a-uuid', "' OR 1=1 --", `${ID}x`, 42 as unknown as string])(
    'rejects %j before any query',
    async (bad) => {
      const { env, query } = fakeEnv([row({ prompt: SECRET })]);
      expect(await resolveCentralTemplate('user-1', bad, env)).toBeNull();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('returns null for an empty user id without querying', async () => {
    const { env, query } = fakeEnv([row({ prompt: SECRET })]);
    expect(await resolveCentralTemplate('', ID, env)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
