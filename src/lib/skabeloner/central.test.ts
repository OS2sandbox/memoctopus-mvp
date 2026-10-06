// Unit tests with a fake runner: statement order, what is written, how errors
// map. What only a database can prove (atomicity, the row lock, the trigger,
// the RESTRICT FK) is in central.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner, type Responder } from '@/test/fake-runner';
import { makePrincipal } from '@/test/helpers';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
const recordEvent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ status: 'stored' })));
vi.mock('@/lib/audit/record', () => ({ recordEvent }));
const scope = vi.hoisted(() => ({
  isOrgUnitWithinScope: vi.fn(),
  orgSubtreeUuids: vi.fn(),
  orgUnitsInScope: vi.fn(),
}));
vi.mock('@/lib/authz/scope', () => scope);

import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '@/lib/authz/access-errors';
import {
  archiveCentralTemplate,
  createCentralTemplate,
  getManageableTemplate,
  listManageableTemplates,
  listScopeOrgUnits,
  listVersions,
  restoreCentralTemplate,
  updateCentralTemplate,
  type CentralEnv,
} from './central';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TPL = '11111111-2222-4333-8444-555555555555';
const NOTE = 'Præciseret formuleringen af prompten';

const manager = makePrincipal({
  userId: 'mgr-1',
  roles: ['tt-skabelonansvarlig'],
  capabilities: ['template.use', 'template.manage'],
  scopes: { 'template.manage': { global: false, roots: [{ orgUnitUuid: OWNER, includeDescendants: true }] } },
});

const row = (over: Record<string, unknown> = {}) => ({
  id: TPL,
  owner_org_unit_uuid: OWNER,
  name: 'Dialogmøde',
  description: 'Til dialogmøder',
  prompt: 'Skriv et kort referat.',
  include_deltagere: false,
  include_beslutningspunkter: true,
  include_dagsorden: false,
  include_dato: false,
  allow_user_instruction: false,
  allow_toggle_overrides: false,
  status: 'active',
  current_version: 3,
  created_at: new Date('2026-01-01T10:00:00Z'),
  updated_at: new Date('2026-02-01T10:00:00Z'),
  created_by_name: 'Anne Ansvarlig',
  last_edited_by_name: 'Bo Beslutter',
  last_edited_at: new Date('2026-02-01T10:00:00Z'),
  ...over,
});

type Rows = Array<Record<string, unknown>>;
interface World {
  template?: Rows;
  targets?: Rows;
  unit?: Rows;
  updated?: Rows;
  actorName?: string;
  inserted?: Rows;
}

function world(w: World = {}): Responder {
  return (sql) => {
    if (sql.includes('FROM "public".org_units') && sql.includes('FOR SHARE')) return w.unit ?? [{ '?column?': 1 }];
    if (sql.includes('INSERT INTO "public".central_templates')) return w.inserted ?? [{ id: TPL }];
    if (sql.includes('UPDATE "public".central_templates')) return w.updated ?? [{ current_version: 4 }];
    if (sql.includes('FROM "public".central_template_targets') && sql.startsWith('SELECT org_unit_uuid')) return w.targets ?? [];
    if (sql.includes('FROM "public".central_templates ct') && sql.includes('WHERE ct.id')) return w.template ?? [row()];
    if (sql.includes('FROM "public".users')) return [{ name: w.actorName ?? 'Mikkel Manager' }];
    return [];
  };
}

function setup(w: World = {}) {
  const fake = makeFakeRunner(world(w));
  const env: CentralEnv = { schema: 'public', runner: fake.runner };
  return { ...fake, env };
}

const writes = (calls: Array<{ sql: string }>) =>
  calls.filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql)).map((c) => c.sql.split('\n')[0].trim());

beforeEach(() => {
  recordEvent.mockClear();
  recordEvent.mockResolvedValue({ status: 'stored' });
  scope.isOrgUnitWithinScope.mockReset().mockResolvedValue(true);
  scope.orgSubtreeUuids.mockReset().mockResolvedValue(new Set([OWNER, CHILD]));
  scope.orgUnitsInScope.mockReset().mockResolvedValue({ all: false, uuids: [OWNER, CHILD] });
});

describe('createCentralTemplate', () => {
  const input = {
    ownerOrgUnitUuid: OWNER,
    name: '  Dialogmøde ',
    description: 'Til dialogmøder',
    prompt: 'Skriv et kort referat.',
    includeBeslutningspunkter: true,
    targets: [{ orgUnitUuid: CHILD }],
    changeNote: '  Første version til dialogmøder  ',
  };

  it('writes template, targets, version 1 and the audit event on one transaction, in that order', async () => {
    const { env, calls } = setup();
    const out = await createCentralTemplate(manager, input, env);

    const tx = calls.filter((c) => c.tx).map((c) => c.sql.split('\n')[0].trim());
    expect(tx[0]).toBe('BEGIN');
    expect(tx.at(-1)).toBe('COMMIT');
    expect(writes(calls)).toEqual([
      'INSERT INTO "public".central_templates',
      'DELETE FROM "public".central_template_targets WHERE template_id = $1::uuid',
      'INSERT INTO "public".central_template_targets (template_id, org_unit_uuid, include_descendants)',
      'INSERT INTO "public".central_template_versions',
    ]);
    expect(calls.filter((c) => /^(INSERT|UPDATE|DELETE|SELECT)/.test(c.sql)).every((c) => c.tx)).toBe(true);

    const versionInsert = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
    expect(versionInsert.params.slice(0, 6)).toEqual([TPL, 1, 'create', 'Første version til dialogmøder', 'mgr-1', 'Mikkel Manager']);
    expect(JSON.parse(String(versionInsert.params[6]))).toEqual({
      name: 'Dialogmøde',
      description: 'Til dialogmøder',
      prompt: 'Skriv et kort referat.',
      includeDeltagere: false,
      includeBeslutningspunkter: true,
      includeDagsorden: false,
      includeDato: false,
      allowUserInstruction: false,
      allowToggleOverrides: false,
    });
    expect(JSON.parse(String(versionInsert.params[7]))).toEqual([{ orgUnitUuid: CHILD, includeDescendants: true }]);
    expect(out).toMatchObject({ id: TPL, currentVersion: 3, createdByName: 'Anne Ansvarlig', lastEditedByName: 'Bo Beslutter', lastEditedAt: '2026-02-01T10:00:00.000Z' });
  });

  it('audits with ids and counts only, on the same tx and against the configured schema', async () => {
    const { env } = setup();
    await createCentralTemplate(manager, input, env);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [event, opts] = recordEvent.mock.calls[0] as [Record<string, unknown>, { tx: unknown; table: string }];
    expect(event).toEqual({
      type: 'central_template.create',
      actorUserId: 'mgr-1',
      entityId: TPL,
      secondaryEntityId: OWNER,
      details: { version: 1, targetCount: 1 },
    });
    expect(opts.tx).toBeDefined();
    expect(opts.table).toBe('"public".audit_events');
    expect(JSON.stringify(event)).not.toMatch(/Dialogmøde|Skriv et kort|Første version/);
  });

  it('rolls back when the audit write fails: nothing is committed', async () => {
    recordEvent.mockRejectedValueOnce(new Error('audit down'));
    const { env, sqls } = setup();
    await expect(createCentralTemplate(manager, input, env)).rejects.toThrow('audit down');
    expect(sqls().at(-1)).toBe('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });

  it.each([
    ['too short', 'for kort'],
    ['whitespace only', '              '],
    ['empty', ''],
  ])('refuses a change note that is %s, before touching the database', async (_n, changeNote) => {
    const { env, calls } = setup();
    await expect(createCentralTemplate(manager, { ...input, changeNote }, env)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'change_note_invalid',
      message: 'Beskriv ændringen (mindst 10 tegn)',
    });
    expect(calls).toHaveLength(0);
  });

  it('404 when the owner unit is outside the caller scope, and writes nothing', async () => {
    scope.isOrgUnitWithinScope.mockResolvedValue(false);
    const { env, calls } = setup();
    await expect(createCentralTemplate(manager, { ...input, ownerOrgUnitUuid: OTHER }, env)).rejects.toBeInstanceOf(NotFoundError);
    expect(writes(calls)).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('404 when the owner unit does not exist, even for a global manager', async () => {
    const { env, calls } = setup({ unit: [] });
    await expect(createCentralTemplate(manager, input, env)).rejects.toBeInstanceOf(NotFoundError);
    expect(writes(calls)).toEqual([]);
  });

  it('400 when a target lies outside the owner subtree, and writes nothing', async () => {
    scope.orgSubtreeUuids.mockResolvedValue(new Set([OWNER]));
    const { env, calls } = setup();
    await expect(
      createCentralTemplate(manager, { ...input, targets: [{ orgUnitUuid: CHILD }, { orgUnitUuid: OTHER }] }, env),
    ).rejects.toMatchObject({ name: 'ValidationError', code: 'target_outside_owner' });
    expect(writes(calls)).toEqual([]);
    // The walk starts at the OWNER, never at the caller's roots.
    expect(scope.orgSubtreeUuids.mock.calls[0][0]).toEqual([{ orgUnitUuid: OWNER, includeDescendants: true }]);
  });

  it('accepts zero targets (the UI warns "Ingen modtagere")', async () => {
    const { env, calls } = setup();
    await createCentralTemplate(manager, { ...input, targets: [] }, env);
    expect(writes(calls)).toContain('INSERT INTO "public".central_templates');
    expect(scope.orgSubtreeUuids).not.toHaveBeenCalled();
  });

  it('maps a constraint failure that races the checks to a typed error', async () => {
    const { env } = setup();
    const err = Object.assign(new Error('fk'), { code: '23503' });
    recordEvent.mockRejectedValueOnce(err);
    await expect(createCentralTemplate(manager, input, env)).rejects.toMatchObject({ code: 'concurrent_change' });
  });

  it('maps a NUL or lone surrogate rejected by Postgres (22021 / 22P05 / 22P02) to a ValidationError, not a 500', async () => {
    for (const code of ['22021', '22P05', '22P02']) {
      const { env } = setup();
      recordEvent.mockRejectedValueOnce(Object.assign(new Error('nul'), { code }));
      await expect(createCentralTemplate(manager, input, env)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('rejects a lone surrogate as a ValidationError before touching the database', async () => {
    const { env, calls } = setup();
    await expect(createCentralTemplate(manager, { ...input, prompt: 'Skriv \ud800 kort.' }, env)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(writes(calls)).toEqual([]);
  });

  it('rejects an invalid schema name (the seam is a trusted constant, not request input)', async () => {
    const { runner } = makeFakeRunner(world());
    await expect(createCentralTemplate(manager, input, { schema: 'x"; drop', runner })).rejects.toThrow('invalid schema name');
  });
});

describe('updateCentralTemplate', () => {
  const base = { baseVersion: 3, changeNote: NOTE };

  it('bumps the version, writes only the changed columns and a full snapshot, and audits field names only', async () => {
    const { env, calls } = setup();
    await updateCentralTemplate(manager, TPL, { ...base, prompt: 'Skriv et langt referat.', includeDato: true }, env);

    const update = calls.find((c) => c.sql.startsWith('UPDATE "public".central_templates'))!;
    expect(update.sql).toContain('prompt = $3, include_dato = $4, current_version = current_version + 1');
    expect(update.sql).toContain('WHERE id = $1::uuid AND current_version = $2');
    expect(update.params).toEqual([TPL, 3, 'Skriv et langt referat.', true]);

    const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
    expect(version.params.slice(0, 4)).toEqual([TPL, 4, 'update', NOTE]);
    expect(JSON.parse(String(version.params[6]))).toMatchObject({ prompt: 'Skriv et langt referat.', includeDato: true, name: 'Dialogmøde' });

    expect(recordEvent.mock.calls[0][0]).toEqual({
      type: 'central_template.update',
      actorUserId: 'mgr-1',
      entityId: TPL,
      secondaryEntityId: OWNER,
      details: { version: 4, changedFields: ['prompt', 'includeDato'] },
    });
  });

  it('ignores fields that are sent but unchanged', async () => {
    const { env, calls } = setup();
    await updateCentralTemplate(manager, TPL, { ...base, name: 'Dialogmøde', includeDato: true }, env);
    expect((recordEvent.mock.calls[0][0] as { details: unknown }).details).toEqual({ version: 4, changedFields: ['includeDato'] });
    expect(calls.find((c) => c.sql.startsWith('UPDATE'))!.sql).not.toContain('name =');
  });

  it('classifies a targets-only change as retarget', async () => {
    const { env, calls } = setup({ targets: [{ org_unit_uuid: OWNER, include_descendants: true }] });
    await updateCentralTemplate(manager, TPL, { ...base, targets: [{ orgUnitUuid: CHILD, includeDescendants: false }] }, env);
    const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
    expect(version.params[2]).toBe('retarget');
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.retarget', details: { version: 4, targetCount: 1 } });
    expect(writes(calls)).toContain('DELETE FROM "public".central_template_targets WHERE template_id = $1::uuid');
  });

  it('classifies content plus targets as update and names targets among the changed fields', async () => {
    const { env } = setup({ targets: [] });
    await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt navn', targets: [{ orgUnitUuid: CHILD }] }, env);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({
      type: 'central_template.update',
      details: { version: 4, changedFields: ['name', 'targets'] },
    });
  });

  it('treats the same targets in another order as unchanged', async () => {
    const { env } = setup({
      targets: [
        { org_unit_uuid: OWNER, include_descendants: true },
        { org_unit_uuid: CHILD, include_descendants: true },
      ],
    });
    await expect(
      updateCentralTemplate(manager, TPL, { ...base, targets: [{ orgUnitUuid: CHILD }, { orgUnitUuid: OWNER }] }, env),
    ).rejects.toMatchObject({ code: 'no_changes' });
  });

  it('400 when nothing changed, and writes nothing', async () => {
    const { env, calls } = setup();
    await expect(updateCentralTemplate(manager, TPL, { ...base, name: 'Dialogmøde' }, env)).rejects.toBeInstanceOf(ValidationError);
    expect(writes(calls)).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('409 with the current version on a stale baseVersion, and writes nothing', async () => {
    const { env, calls } = setup();
    const err = await updateCentralTemplate(manager, TPL, { ...base, baseVersion: 2, name: 'Nyt' }, env).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err).toMatchObject({ code: 'version_conflict', currentVersion: 3 });
    expect(writes(calls)).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('409 when the version-filtered UPDATE hits no row (lost race), carrying the version now current', async () => {
    let selects = 0;
    const fake = makeFakeRunner((sql) => {
      if (sql.startsWith('UPDATE')) return [];
      if (sql.includes('WHERE ct.id')) return [row({ current_version: selects++ === 0 ? 3 : 5 })];
      return [];
    });
    const err = await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, { schema: 'public', runner: fake.runner }).catch((e) => e);
    expect(err).toMatchObject({ code: 'version_conflict', currentVersion: 5 });
    expect(fake.sqls().at(-1)).toBe('ROLLBACK');
  });

  it('locks the row first (FOR UPDATE) so concurrent writers are serialised', async () => {
    const { env, calls } = setup();
    await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, env);
    const firstSelect = calls.find((c) => c.sql.startsWith('SELECT ct.id'))!;
    expect(firstSelect.sql).toContain('FOR UPDATE OF ct');
  });

  it('404 for a template owned by a unit outside the scope, before the version is compared', async () => {
    scope.isOrgUnitWithinScope.mockResolvedValue(false);
    const { env, calls } = setup({ template: [row({ owner_org_unit_uuid: OTHER })] });
    await expect(updateCentralTemplate(manager, TPL, { ...base, baseVersion: 99, name: 'Nyt' }, env)).rejects.toBeInstanceOf(NotFoundError);
    expect(scope.isOrgUnitWithinScope).toHaveBeenCalledWith(manager, 'template.manage', OTHER, expect.anything());
    expect(writes(calls)).toEqual([]);
  });

  it('404 for an unknown or ill-formed id', async () => {
    const a = setup({ template: [] });
    await expect(updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, a.env)).rejects.toBeInstanceOf(NotFoundError);
    const b = setup();
    await expect(updateCentralTemplate(manager, 'nope', { ...base, name: 'Nyt' }, b.env)).rejects.toBeInstanceOf(NotFoundError);
    expect(b.calls.filter((c) => c.sql.startsWith('SELECT'))).toHaveLength(0);
  });

  it('refuses to edit an archived template (restore it first)', async () => {
    const { env, calls } = setup({ template: [row({ status: 'archived' })] });
    await expect(updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, env)).rejects.toMatchObject({ code: 'template_archived' });
    expect(writes(calls)).toEqual([]);
  });

  it('400 when a new target is outside the OWNER subtree (not the caller scope)', async () => {
    scope.orgSubtreeUuids.mockResolvedValue(new Set([OWNER]));
    const { env, calls } = setup();
    await expect(updateCentralTemplate(manager, TPL, { ...base, targets: [{ orgUnitUuid: OTHER }] }, env)).rejects.toMatchObject({
      code: 'target_outside_owner',
    });
    expect(scope.orgSubtreeUuids.mock.calls[0][0]).toEqual([{ orgUnitUuid: OWNER, includeDescendants: true }]);
    expect(writes(calls)).toEqual([]);
  });

  it('requires the change note on every update', async () => {
    const { env, calls } = setup();
    await expect(updateCentralTemplate(manager, TPL, { baseVersion: 3, name: 'Nyt' } as never, env)).rejects.toMatchObject({ code: 'change_note_invalid' });
    await expect(updateCentralTemplate(manager, TPL, { baseVersion: 3, name: 'Nyt', changeNote: ' kort ' }, env)).rejects.toMatchObject({ code: 'change_note_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown fields such as status or owner (strict)', async () => {
    const { env } = setup();
    await expect(updateCentralTemplate(manager, TPL, { ...base, ownerOrgUnitUuid: OTHER } as never, env)).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCentralTemplate(manager, TPL, { ...base, status: 'archived' } as never, env)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('archive and restore', () => {
  const input = { baseVersion: 3, changeNote: 'Skabelonen bruges ikke længere' };

  it('archive: status flips, version +1, version row of type archive, audit', async () => {
    const { env, calls } = setup({ targets: [{ org_unit_uuid: CHILD, include_descendants: true }] });
    await archiveCentralTemplate(manager, TPL, input, env);
    const update = calls.find((c) => c.sql.startsWith('UPDATE'))!;
    expect(update.params).toEqual([TPL, 3, 'archived']);
    const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
    expect(version.params.slice(0, 4)).toEqual([TPL, 4, 'archive', input.changeNote]);
    expect(JSON.parse(String(version.params[7]))).toEqual([{ orgUnitUuid: CHILD, includeDescendants: true }]);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.archive', details: { version: 4 } });
  });

  it('restore: only an archived template can be restored', async () => {
    const ok = setup({ template: [row({ status: 'archived' })] });
    await restoreCentralTemplate(manager, TPL, input, ok.env);
    expect(ok.calls.find((c) => c.sql.startsWith('UPDATE'))!.params).toEqual([TPL, 3, 'active']);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.restore' });

    const bad = setup();
    await expect(restoreCentralTemplate(manager, TPL, input, bad.env)).rejects.toMatchObject({ code: 'not_archived' });
  });

  it('archive twice is a conflict, a stale baseVersion is a version conflict, out of scope is 404', async () => {
    await expect(archiveCentralTemplate(manager, TPL, input, setup({ template: [row({ status: 'archived' })] }).env)).rejects.toMatchObject({ code: 'already_archived' });
    await expect(archiveCentralTemplate(manager, TPL, { ...input, baseVersion: 1 }, setup().env)).rejects.toMatchObject({ currentVersion: 3 });
    scope.isOrgUnitWithinScope.mockResolvedValue(false);
    await expect(archiveCentralTemplate(manager, TPL, input, setup().env)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('both need a change note', async () => {
    const { env, calls } = setup();
    await expect(archiveCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: '   ' }, env)).rejects.toMatchObject({ code: 'change_note_invalid' });
    await expect(restoreCentralTemplate(manager, TPL, { baseVersion: 3 } as never, env)).rejects.toMatchObject({ code: 'change_note_invalid' });
    expect(calls).toHaveLength(0);
  });
});

describe('reads', () => {
  it('list: no scope means no query at all', async () => {
    scope.orgUnitsInScope.mockResolvedValue({ all: false, uuids: [] });
    const { env, calls } = setup();
    expect(await listManageableTemplates(makePrincipal(), {}, env)).toEqual([]);
    expect(calls.filter((c) => c.sql.includes('central_templates'))).toHaveLength(0);
  });

  it('list: filters on the scoped owner units; a global scope passes NULL; default is active only', async () => {
    const item = { id: TPL, name: 'A', description: '', owner_org_unit_uuid: OWNER, status: 'active', current_version: 2, target_count: 4, updated_at: new Date('2026-03-01T00:00:00Z'), created_by_name: 'Anne Ansvarlig', last_edited_by_name: 'Bo Beslutter', last_edited_at: new Date('2026-03-01T00:00:00Z') };
    const scoped = makeFakeRunner(() => [item]);
    const out = await listManageableTemplates(manager, {}, { schema: 'public', runner: scoped.runner });
    expect(out).toEqual([{ id: TPL, name: 'A', description: '', ownerOrgUnitUuid: OWNER, status: 'active', currentVersion: 2, targetCount: 4, updatedAt: '2026-03-01T00:00:00.000Z', createdByName: 'Anne Ansvarlig', lastEditedByName: 'Bo Beslutter', lastEditedAt: '2026-03-01T00:00:00.000Z' }]);
    expect(scoped.calls[0].params).toEqual(['active', [OWNER, CHILD]]);

    scope.orgUnitsInScope.mockResolvedValue({ all: true });
    const global = makeFakeRunner(() => []);
    await listManageableTemplates(manager, { status: 'all' }, { schema: 'public', runner: global.runner });
    expect(global.calls[0].params).toEqual([null, null]);
  });

  it('list: creator and last editor come from the same single query (joined version rows, no N+1)', async () => {
    const item = { id: TPL, name: 'A', description: '', owner_org_unit_uuid: OWNER, status: 'active', current_version: 2, target_count: 0, updated_at: new Date('2026-03-01T00:00:00Z'), created_by_name: null, last_edited_by_name: null, last_edited_at: null };
    const fake = makeFakeRunner(() => [item, { ...item, id: '99999999-9999-4999-8999-999999999999' }]);
    const out = await listManageableTemplates(manager, {}, { schema: 'public', runner: fake.runner });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].sql).toMatch(/JOIN "public".central_template_versions v1 ON .*v1\.version = 1/);
    expect(fake.calls[0].sql).toMatch(/JOIN "public".central_template_versions vc ON .*vc\.version = ct\.current_version/);
    // Missing snapshots stay null; the edit time falls back to updated_at.
    expect(out[0]).toMatchObject({ createdByName: null, lastEditedByName: null, lastEditedAt: '2026-03-01T00:00:00.000Z' });
  });

  it('get: returns the prompt to a manager in scope, 404 otherwise', async () => {
    const { env } = setup({ targets: [{ org_unit_uuid: CHILD, include_descendants: false }] });
    expect(await getManageableTemplate(manager, TPL, env)).toMatchObject({
      id: TPL,
      prompt: 'Skriv et kort referat.',
      ownerOrgUnitUuid: OWNER,
      targets: [{ orgUnitUuid: CHILD, includeDescendants: false }],
      createdAt: '2026-01-01T10:00:00.000Z',
    });
    scope.isOrgUnitWithinScope.mockResolvedValue(false);
    await expect(getManageableTemplate(manager, TPL, env)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getManageableTemplate(manager, 'x', env)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('versions: newest first, scope-checked like the template', async () => {
    const v = (version: number) => ({ version, change_type: 'update', change_note: NOTE, changed_by_name: 'M', changed_at: new Date('2026-03-01T00:00:00Z'), content: { name: 'x' }, targets: [] });
    const fake = makeFakeRunner((sql) => (sql.startsWith('SELECT version') ? [v(3), v(2)] : [row()]));
    const env = { schema: 'public', runner: fake.runner };
    const out = await listVersions(manager, TPL, env);
    expect(out.map((x) => x.version)).toEqual([3, 2]);
    expect(fake.calls.find((c) => c.sql.startsWith('SELECT version'))!.sql).toContain('ORDER BY version DESC');
    scope.isOrgUnitWithinScope.mockResolvedValue(false);
    await expect(listVersions(manager, TPL, env)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('scope org units: hides a parent outside the set, nothing without scope', async () => {
    const fake = makeFakeRunner(() => [
      { uuid: OWNER, name: 'Afdeling', parent_uuid: OTHER },
      { uuid: CHILD, name: 'Team', parent_uuid: OWNER },
    ]);
    const env = { schema: 'public', runner: fake.runner };
    expect(await listScopeOrgUnits(manager, env)).toEqual([
      { uuid: OWNER, name: 'Afdeling', parentUuid: null },
      { uuid: CHILD, name: 'Team', parentUuid: OWNER },
    ]);
    scope.orgUnitsInScope.mockResolvedValue({ all: false, uuids: [] });
    const none = makeFakeRunner();
    expect(await listScopeOrgUnits(makePrincipal(), { schema: 'public', runner: none.runner })).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});
