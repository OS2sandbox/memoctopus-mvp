// Unit tests with a fake runner: statement order, what is written, how errors
// map. What only a database can prove (atomicity, the row lock, the trigger,
// the RESTRICT FK) is in central.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { makeFakeRunner, type Responder } from '@/test/fake-runner';
import { makePrincipal } from '@/test/helpers';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
const recordEvent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ status: 'stored' })));
vi.mock('@/lib/audit/record', () => ({ recordEvent }));
const recordAuthzDenied = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied }));
import { ForbiddenError, NotFoundError, ValidationError, VersionConflictError } from '@/lib/authz/access-errors';
import type { Principal } from '@/lib/authz/types';
import * as service from './central';
import {
  getManageableTemplate,
  listCatalogue,
  listAudienceOrgUnits,
  listManageableTemplates,
  listVersions,
  type CentralEnv,
} from './central';
import { centralStateChangeSchema, createCentralTemplateSchema, updateCentralTemplateSchema } from './central-schemas';

// The routes parse every body once, at the edge (http.ts parseBody), and the service takes the
// parsed output; these tests parse their raw objects the same way first.
const createCentralTemplate = async (p: Principal, raw: z.input<typeof createCentralTemplateSchema>, env?: CentralEnv) =>
  service.createCentralTemplate(p, createCentralTemplateSchema.parse(raw), env);
const updateCentralTemplate = async (p: Principal, id: string, raw: z.input<typeof updateCentralTemplateSchema>, env?: CentralEnv) =>
  service.updateCentralTemplate(p, id, updateCentralTemplateSchema.parse(raw), env);
const archiveCentralTemplate = async (p: Principal, id: string, raw: z.input<typeof centralStateChangeSchema>, env?: CentralEnv) =>
  service.archiveCentralTemplate(p, id, centralStateChangeSchema.parse(raw), env);
const restoreCentralTemplate = async (p: Principal, id: string, raw: z.input<typeof centralStateChangeSchema>, env?: CentralEnv) =>
  service.restoreCentralTemplate(p, id, centralStateChangeSchema.parse(raw), env);

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TPL = '11111111-2222-4333-8444-555555555555';
const NOTE = 'Præciseret formuleringen af prompten';

/** A bygger: manages the templates they created themselves. */
const manager = makePrincipal({
  userId: 'mgr-1',
  roles: ['bygger'],
  capabilities: ['template.use', 'template.manage'],
});

/** An administrator: template.manage_all, so every template. */
const admin = makePrincipal({
  userId: 'adm-1',
  roles: ['admin'],
  capabilities: ['template.use', 'template.manage', 'template.manage_all'],
});

/** Created by another bygger. */
const OTHERS = { created_by_user_id: 'mgr-2' };

const row = (over: Record<string, unknown> = {}) => ({
  id: TPL,
  created_by_user_id: 'mgr-1',
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
  /** The template's current role/group targets (joined with the catalogue). */
  principals?: Rows;
  /** How many of the role/group targets being added are active catalogue entries (default: all). */
  catalogueHits?: number;
  /** How many of the target units exist (default: all). */
  orgUnitsFound?: number;
  updated?: Rows;
  actorName?: string;
  inserted?: Rows;
  /** The access mode (default: claims, the only mode in which role/group targets can be added). */
  accessSource?: 'local' | 'rollekatalog' | 'claims';
}

function world(w: World = {}): Responder {
  return (sql, params) => {
    if (sql.includes('INSERT INTO "public".central_templates')) return w.inserted ?? [{ id: TPL }];
    if (sql.includes('UPDATE "public".central_templates')) return w.updated ?? [{ current_version: 4 }];
    if (sql.includes('FROM "public".central_template_targets') && sql.startsWith('SELECT org_unit_uuid')) return w.targets ?? [];
    if (sql.startsWith('SELECT 1 FROM "public".central_template_principal_targets WHERE')) return (w.principals ?? []).length > 0 ? [{ '?column?': 1 }] : [];
    if (sql.includes('FROM "public".central_template_principal_targets pt')) return w.principals ?? [];
    if (sql.includes('FROM "public".external_roles e') && sql.includes('JOIN unnest')) {
      const added = (params[0] as unknown[]).length;
      return Array.from({ length: w.catalogueHits ?? added }, () => ({ '?column?': 1 }));
    }
    if (sql.startsWith('SELECT uuid FROM "public".org_units WHERE uuid = ANY')) {
      return Array.from({ length: w.orgUnitsFound ?? (params[0] as unknown[]).length }, () => ({ uuid: 'x' }));
    }
    if (sql.includes('FROM "public".central_templates ct') && sql.includes('WHERE ct.id')) return w.template ?? [row()];
    if (sql.includes('FROM "public".users')) return [{ name: w.actorName ?? 'Mikkel Manager' }];
    return [];
  };
}

function setup(w: World = {}) {
  const fake = makeFakeRunner(world(w));
  const env: CentralEnv = { schema: 'public', runner: fake.runner, accessSource: w.accessSource ?? 'claims', claimsMaxSeconds: 28_800 };
  return { ...fake, env };
}

const writes = (calls: Array<{ sql: string }>) =>
  calls.filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql)).map((c) => c.sql.split('\n')[0].trim());

beforeEach(() => {
  recordEvent.mockClear();
  recordEvent.mockResolvedValue({ status: 'stored' });
  recordAuthzDenied.mockClear();
});

describe('createCentralTemplate', () => {
  const input = {
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
      'DELETE FROM "public".central_template_principal_targets WHERE template_id = $1::uuid',
      'INSERT INTO "public".central_template_versions',
    ]);
    expect(calls.filter((c) => /^(INSERT|UPDATE|DELETE|SELECT)/.test(c.sql)).every((c) => c.tx)).toBe(true);

    // The creator owns the template.
    expect(calls.find((c) => c.sql.includes('INSERT INTO "public".central_templates'))!.params[0]).toBe('mgr-1');
    // The target unit is looked up FOR SHARE, so a concurrent unit delete waits.
    expect(calls.find((c) => c.sql.startsWith('SELECT uuid FROM "public".org_units'))!.sql).toContain('FOR SHARE');

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
    expect(JSON.parse(String(versionInsert.params[8]))).toEqual([]);
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
      details: { version: 1, targetCount: 1, principalTargetCount: 0 },
    });
    expect(opts.tx).toBeDefined();
    expect(opts.table).toBe('"public".audit_events');
    expect(JSON.stringify(event)).not.toMatch(/Dialogmøde|Skriv et kort|Første version/);
  });

  describe('audience: any existing unit, and roles/groups in claims mode', () => {
    const ROLE = { kind: 'role' as const, identifier: 'sagsbehandler' };
    const GROUP = { kind: 'group' as const, identifier: 'socialforvaltningen' };
    const rolesOnly = { ...input, targets: [] };

    it('a bygger makes a template available to roles and groups; the audit event carries counts only', async () => {
      const { env, calls } = setup({
        principals: [
          { kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler', active: true },
          { kind: 'group', identifier: 'socialforvaltningen', name: 'Socialforvaltningen', active: true },
        ],
      });
      await createCentralTemplate(manager, { ...rolesOnly, principalTargets: [GROUP, ROLE, ROLE] }, env);

      // No unit to look up when there are no unit targets.
      expect(calls.some((c) => c.sql.includes('FROM "public".org_units'))).toBe(false);

      const rolesInsert = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_principal_targets'))!;
      expect(rolesInsert.params).toEqual([TPL, ['group', 'role'], ['socialforvaltningen', 'sagsbehandler']]);
      const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
      expect(JSON.parse(String(version.params[8]))).toEqual([
        { kind: 'group', identifier: 'socialforvaltningen', name: 'Socialforvaltningen' },
        { kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler' },
      ]);

      const event = recordEvent.mock.calls[0][0] as Record<string, unknown>;
      expect(event).toEqual({
        type: 'central_template.create',
        actorUserId: 'mgr-1',
        entityId: TPL,
        details: { version: 1, targetCount: 0, principalTargetCount: 2 },
      });
      expect(JSON.stringify(event)).not.toMatch(/sagsbehandler|socialforvaltningen|Sagsbehandler/);
    });

    it('400 when a role or group is not an active catalogue entry', async () => {
      const { env, calls } = setup({ catalogueHits: 1 });
      await expect(createCentralTemplate(manager, { ...rolesOnly, principalTargets: [ROLE, GROUP] }, env)).rejects.toMatchObject({
        code: 'principal_target_unknown',
      });
      expect(writes(calls)).toEqual([]);
    });

    it('any existing unit may be targeted; an unknown one is 400 target_unknown and nothing is written', async () => {
      const ok = setup();
      await createCentralTemplate(manager, { ...input, targets: [{ orgUnitUuid: PARENT }, { orgUnitUuid: OTHER }] }, ok.env);
      expect(writes(ok.calls)).toContain('INSERT INTO "public".central_template_targets (template_id, org_unit_uuid, include_descendants)');
      const bad = setup({ orgUnitsFound: 1 });
      await expect(
        createCentralTemplate(manager, { ...input, targets: [{ orgUnitUuid: PARENT }, { orgUnitUuid: OTHER }] }, bad.env),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'target_unknown' });
      expect(writes(bad.calls)).toEqual([]);
    });
  });

  it('403 without template.manage (the route guard is not the only check), and nothing is written', async () => {
    const { env, calls } = setup();
    await expect(createCentralTemplate(makePrincipal(), input, env)).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes(calls)).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rolls back when the audit write fails: nothing is committed', async () => {
    recordEvent.mockRejectedValueOnce(new Error('audit down'));
    const { env, sqls } = setup();
    await expect(createCentralTemplate(manager, input, env)).rejects.toThrow('audit down');
    expect(sqls().at(-1)).toBe('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });

  it('accepts zero targets (the UI warns "Ingen modtagere")', async () => {
    const { env, calls } = setup();
    await createCentralTemplate(manager, { ...input, targets: [] }, env);
    expect(writes(calls)).toContain('INSERT INTO "public".central_templates');
    expect(calls.some((c) => c.sql.includes('FROM "public".org_units'))).toBe(false);
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
      details: { version: 4, changedFields: ['prompt', 'includeDato'] },
    });
  });

  describe('role/group targets and who may change a template', () => {
    const ROLE = { kind: 'role' as const, identifier: 'sagsbehandler' };
    const current = [{ kind: 'group', identifier: 'gammel', name: 'Gammel gruppe', active: false }];

    it('a role/group-only change is a retarget; the audit event has counts only', async () => {
      const { env, calls } = setup({ principals: current });
      await updateCentralTemplate(manager, TPL, { ...base, principalTargets: [ROLE] }, env);
      const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
      expect(version.params[2]).toBe('retarget');
      expect(writes(calls)).toContain('DELETE FROM "public".central_template_principal_targets WHERE template_id = $1::uuid');
      const event = recordEvent.mock.calls[0][0] as Record<string, unknown>;
      expect(event).toMatchObject({ type: 'central_template.retarget', details: { version: 4, targetCount: 0, principalTargetCount: 1 } });
      expect(JSON.stringify(event)).not.toMatch(/sagsbehandler|gammel/i);
    });

    it('names principalTargets among the changed fields of an update', async () => {
      const { env } = setup();
      await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt navn', principalTargets: [ROLE] }, env);
      expect(recordEvent.mock.calls[0][0]).toMatchObject({
        type: 'central_template.update',
        details: { version: 4, changedFields: ['name', 'principalTargets'] },
      });
    });

    it('only NEWLY added targets are checked against the catalogue: an existing, now inactive one may stay', async () => {
      const keep = setup({ principals: current });
      await updateCentralTemplate(
        manager,
        TPL,
        { ...base, name: 'Nyt navn', principalTargets: [{ kind: 'group', identifier: 'gammel' }] },
        keep.env,
      );
      expect(keep.calls.some((c) => c.sql.includes('FROM "public".external_roles e'))).toBe(false);
    });

    it('the same targets in another order are unchanged', async () => {
      const { env } = setup({
        principals: [
          { kind: 'group', identifier: 'b', name: 'B', active: true },
          { kind: 'role', identifier: 'a', name: 'A', active: true },
        ],
      });
      await expect(
        updateCentralTemplate(
          manager,
          TPL,
          { ...base, principalTargets: [{ kind: 'role', identifier: 'a' }, { kind: 'group', identifier: 'b' }] },
          env,
        ),
      ).rejects.toMatchObject({ code: 'no_changes' });
    });

    it('a bygger adds role/group targets to their own template in claims mode', async () => {
      const { env } = setup();
      await updateCentralTemplate(manager, TPL, { ...base, principalTargets: [ROLE] }, env);
      expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.retarget', details: { principalTargetCount: 1 } });
    });

    it('removing targets needs no catalogue lookup', async () => {
      const { env, calls } = setup({ principals: current });
      await updateCentralTemplate(manager, TPL, { ...base, principalTargets: [] }, env);
      expect(calls.some((c) => c.sql.includes('FROM "public".external_roles e'))).toBe(false);
      expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.retarget', details: { principalTargetCount: 0 } });
    });

    it('principal targets can only be ADDED in claims mode: 409 elsewhere, nothing written, whoever asks', async () => {
      for (const accessSource of ['local', 'rollekatalog'] as const) {
        const { env, calls } = setup({ accessSource });
        await expect(updateCentralTemplate(manager, TPL, { ...base, principalTargets: [ROLE] }, env)).rejects.toMatchObject({
          name: 'ConflictError',
          code: 'principal_targets_need_claims',
        });
        expect(writes(calls)).toEqual([]);
      }
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('outside claims mode an existing audience may still be kept, narrowed or cleared', async () => {
      const { env } = setup({ accessSource: 'local', principals: current });
      await updateCentralTemplate(manager, TPL, { ...base, principalTargets: [] }, env);
      expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'central_template.retarget' });
    });

    it('a bygger updates, archives and restores their own template, role/group targets or not', async () => {
      await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt navn' }, setup({ principals: current }).env);
      await archiveCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: NOTE }, setup({ principals: current }).env);
      await restoreCentralTemplate(
        manager,
        TPL,
        { baseVersion: 3, changeNote: NOTE },
        setup({ principals: current, template: [row({ status: 'archived' })] }).env,
      );
      expect(recordEvent).toHaveBeenCalledTimes(3);
    });

    it("another bygger's template is 404 for update, archive, restore, get and versions; nothing written", async () => {
      const { env, calls } = setup({ template: [row(OTHERS)] });
      await expect(updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, env)).rejects.toBeInstanceOf(NotFoundError);
      await expect(archiveCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: NOTE }, env)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        restoreCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: NOTE }, setup({ template: [row({ ...OTHERS, status: 'archived' })] }).env),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(getManageableTemplate(manager, TPL, env)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listVersions(manager, TPL, env)).rejects.toBeInstanceOf(NotFoundError);
      expect(writes(calls)).toEqual([]);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('a template without a recorded creator is managed by administrators only', async () => {
      const { env } = setup({ template: [row({ created_by_user_id: null })] });
      await expect(getManageableTemplate(manager, TPL, env)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getManageableTemplate(admin, TPL, env)).resolves.toMatchObject({ id: TPL });
    });

    it('an administrator (template.manage_all) updates, archives and restores anybody\'s template; no secondary entity in the audit', async () => {
      const others = { template: [row(OTHERS)] };
      await updateCentralTemplate(admin, TPL, { ...base, name: 'Nyt' }, setup(others).env);
      await archiveCentralTemplate(admin, TPL, { baseVersion: 3, changeNote: NOTE }, setup(others).env);
      await restoreCentralTemplate(admin, TPL, { baseVersion: 3, changeNote: NOTE }, setup({ template: [row({ ...OTHERS, status: 'archived' })] }).env);
      for (const [event] of recordEvent.mock.calls as Array<[Record<string, unknown>]>) {
        expect(event).not.toHaveProperty('secondaryEntityId');
        expect(event.actorUserId).toBe('adm-1');
      }
      expect(recordEvent).toHaveBeenCalledTimes(3);
    });
  });

  it('ignores fields that are sent but unchanged', async () => {
    const { env, calls } = setup();
    await updateCentralTemplate(manager, TPL, { ...base, name: 'Dialogmøde', includeDato: true }, env);
    expect((recordEvent.mock.calls[0][0] as { details: unknown }).details).toEqual({ version: 4, changedFields: ['includeDato'] });
    expect(calls.find((c) => c.sql.startsWith('UPDATE'))!.sql).not.toContain('name =');
  });

  it('classifies a targets-only change as retarget', async () => {
    const { env, calls } = setup({ targets: [{ org_unit_uuid: PARENT, include_descendants: true }] });
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
        { org_unit_uuid: PARENT, include_descendants: true },
        { org_unit_uuid: CHILD, include_descendants: true },
      ],
    });
    await expect(
      updateCentralTemplate(manager, TPL, { ...base, targets: [{ orgUnitUuid: CHILD }, { orgUnitUuid: PARENT }] }, env),
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

  it('fails loudly (not a 409) when the version-filtered UPDATE hits no row under the row lock', async () => {
    const lost = setup({ updated: [] });
    const err = await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, lost.env).catch((e) => e);
    expect(err).not.toBeInstanceOf(VersionConflictError);
    expect(err).toMatchObject({ message: 'central template row lock violated' });
    expect(lost.sqls().at(-1)).toBe('ROLLBACK');
    const archived = setup({ updated: [] });
    await expect(archiveCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: NOTE }, archived.env)).rejects.toThrow('central template row lock violated');
    expect(archived.sqls().at(-1)).toBe('ROLLBACK');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('locks the row first (FOR UPDATE) so concurrent writers are serialised', async () => {
    const { env, calls } = setup();
    await updateCentralTemplate(manager, TPL, { ...base, name: 'Nyt' }, env);
    const firstSelect = calls.find((c) => c.sql.startsWith('SELECT ct.id'))!;
    expect(firstSelect.sql).toContain('FOR UPDATE OF ct');
  });

  it("404 for another bygger's template, before the version is compared", async () => {
    const { env, calls } = setup({ template: [row(OTHERS)] });
    await expect(updateCentralTemplate(manager, TPL, { ...base, baseVersion: 99, name: 'Nyt' }, env)).rejects.toBeInstanceOf(NotFoundError);
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

  it('400 when a new target unit does not exist, and writes nothing', async () => {
    const { env, calls } = setup({ orgUnitsFound: 0 });
    await expect(updateCentralTemplate(manager, TPL, { ...base, targets: [{ orgUnitUuid: OTHER }] }, env)).rejects.toMatchObject({
      code: 'target_unknown',
    });
    expect(writes(calls)).toEqual([]);
  });
});

describe('archive and restore', () => {
  const input = { baseVersion: 3, changeNote: 'Skabelonen bruges ikke længere' };

  it('archive: status flips, version +1, version row of type archive, audit', async () => {
    const { env, calls } = setup({
      targets: [{ org_unit_uuid: CHILD, include_descendants: true }],
      principals: [{ kind: 'role', identifier: 'r', name: 'Rolle R', active: true }],
    });
    await archiveCentralTemplate(manager, TPL, input, env);
    const update = calls.find((c) => c.sql.startsWith('UPDATE'))!;
    expect(update.params).toEqual([TPL, 3, 'archived']);
    const version = calls.find((c) => c.sql.includes('INSERT INTO "public".central_template_versions'))!;
    expect(version.params.slice(0, 4)).toEqual([TPL, 4, 'archive', input.changeNote]);
    expect(JSON.parse(String(version.params[7]))).toEqual([{ orgUnitUuid: CHILD, includeDescendants: true }]);
    // The snapshot of an archive keeps the role/group audience, so a restore is known to bring it back.
    expect(JSON.parse(String(version.params[8]))).toEqual([{ kind: 'role', identifier: 'r', name: 'Rolle R' }]);
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

  it("archive twice is a conflict, a stale baseVersion is a version conflict, another bygger's template is 404", async () => {
    await expect(archiveCentralTemplate(manager, TPL, input, setup({ template: [row({ status: 'archived' })] }).env)).rejects.toMatchObject({ code: 'already_archived' });
    await expect(archiveCentralTemplate(manager, TPL, { ...input, baseVersion: 1 }, setup().env)).rejects.toMatchObject({ currentVersion: 3 });
    await expect(archiveCentralTemplate(manager, TPL, input, setup({ template: [row(OTHERS)] }).env)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('reads', () => {
  it('list: without template.manage there is no query at all', async () => {
    const { env, calls } = setup();
    expect(await listManageableTemplates(makePrincipal(), {}, env)).toEqual([]);
    expect(calls.filter((c) => c.sql.includes('central_templates'))).toHaveLength(0);
  });

  it("list: a bygger's own templates only; an administrator passes NULL (all); default is active only", async () => {
    const item = { id: TPL, name: 'A', description: '', status: 'active', current_version: 2, updated_at: new Date('2026-03-01T00:00:00Z'), created_by_name: 'Anne Ansvarlig', last_edited_by_name: 'Bo Beslutter', last_edited_at: new Date('2026-03-01T00:00:00Z') };
    const scoped = makeFakeRunner((sql) => {
      if (sql.startsWith('SELECT template_id')) return [{ template_id: TPL, org_unit_uuid: CHILD, include_descendants: true }];
      if (sql.startsWith('SELECT pt.template_id')) {
        return [{ template_id: TPL, kind: 'role', identifier: 'r', name: 'Rolle R', active: false, holders: 0 }];
      }
      return [item];
    });
    const out = await listManageableTemplates(manager, {}, { schema: 'public', runner: scoped.runner });
    expect(out).toEqual([{
      id: TPL, name: 'A', description: '', status: 'active', currentVersion: 2,
      // The audience, named: units by uuid (the client resolves names), roles/groups with the catalogue's name and state.
      targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
      principalTargets: [{ kind: 'role', identifier: 'r', name: 'Rolle R', status: 'inactive', holders: 0 }],
      updatedAt: '2026-03-01T00:00:00.000Z', createdByName: 'Anne Ansvarlig', lastEditedByName: 'Bo Beslutter', lastEditedAt: '2026-03-01T00:00:00.000Z',
    }]);
    expect(scoped.calls[0].params).toEqual(['active', 'mgr-1']);
    expect(scoped.calls[0].sql).toContain('ct.created_by_user_id = $2');

    const all = makeFakeRunner(() => []);
    await listManageableTemplates(admin, { status: 'all' }, { schema: 'public', runner: all.runner });
    expect(all.calls[0].params).toEqual([null, null]);
  });

  it('list: creator and last editor come from the same single query (joined version rows, no N+1)', async () => {
    const item = { id: TPL, name: 'A', description: '', status: 'active', current_version: 2, updated_at: new Date('2026-03-01T00:00:00Z'), created_by_name: null, last_edited_by_name: null, last_edited_at: null };
    const fake = makeFakeRunner((sql) => (sql.startsWith('SELECT template_id') || sql.startsWith('SELECT pt.template_id') ? [] : [item, { ...item, id: '99999999-9999-4999-8999-999999999999' }]));
    const out = await listManageableTemplates(manager, {}, { schema: 'public', runner: fake.runner });
    // One query for the page plus ONE each for the org-unit and the role/group audience: no N+1.
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0].sql).toMatch(/JOIN "public".central_template_versions v1 ON .*v1\.version = 1/);
    expect(fake.calls[0].sql).toMatch(/JOIN "public".central_template_versions vc ON .*vc\.version = ct\.current_version/);
    // Missing snapshots stay null; the edit time falls back to updated_at.
    expect(out[0]).toMatchObject({ createdByName: null, lastEditedByName: null, lastEditedAt: '2026-03-01T00:00:00.000Z' });
  });

  it('catalogue: both sources merged, withdrawn entries included, names and identifiers only', async () => {
    const fake = makeFakeRunner(() => [
      { kind: 'role', identifier: 'a', name: 'A', source: 'rollekatalog', active: true, holders: 5, synced_at: new Date('2026-03-02T00:00:00Z') },
      { kind: 'group', identifier: 'b', name: 'B', source: 'config', active: true, holders: 0, synced_at: new Date('2026-03-05T00:00:00Z') },
      { kind: 'role', identifier: 'c', name: 'C', source: 'rollekatalog', active: false, holders: 0, synced_at: new Date('2026-03-01T00:00:00Z') },
    ]);
    const out = await listCatalogue({ schema: 'public', runner: fake.runner, accessSource: 'claims', claimsMaxSeconds: 3600 });
    // `holders` is a COUNT of fresh logins holding the entry, never who.
    expect(out.entries).toEqual([
      { kind: 'role', identifier: 'a', name: 'A', source: 'rollekatalog', active: true, holders: 5 },
      { kind: 'group', identifier: 'b', name: 'B', source: 'config', active: true, holders: 0 },
      { kind: 'role', identifier: 'c', name: 'C', source: 'rollekatalog', active: false, holders: 0 },
    ]);
    expect(fake.calls[0].params).toEqual([3600]);
    expect(fake.calls[0].sql).toContain('ur.seen_at > now() - make_interval');
    expect(fake.calls[0].sql).not.toMatch(/user_id AS|ur\.user_id,/);
    // "Last refreshed" is the newest ROLLEKATALOG row, not the config one.
    expect(out.lastRefreshedAt).toBe('2026-03-02T00:00:00.000Z');
    expect(fake.calls[0].sql).toContain('FROM "public".external_roles');
  });

  it("get: returns the prompt to the creator and to an administrator, 404 to another bygger", async () => {
    const { env } = setup({ targets: [{ org_unit_uuid: CHILD, include_descendants: false }] });
    expect(await getManageableTemplate(manager, TPL, env)).toMatchObject({
      id: TPL,
      prompt: 'Skriv et kort referat.',
      targets: [{ orgUnitUuid: CHILD, includeDescendants: false }],
      createdAt: '2026-01-01T10:00:00.000Z',
    });
    await expect(getManageableTemplate(manager, 'x', env)).rejects.toBeInstanceOf(NotFoundError);
    const others = setup({ template: [row(OTHERS)] });
    await expect(getManageableTemplate(manager, TPL, others.env)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getManageableTemplate(admin, TPL, others.env)).resolves.toMatchObject({ prompt: 'Skriv et kort referat.' });
    await expect(getManageableTemplate(makePrincipal(), TPL, env)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('versions: newest first, checked like the template', async () => {
    const v = (version: number) => ({ version, change_type: 'update', change_note: NOTE, changed_by_name: 'M', changed_at: new Date('2026-03-01T00:00:00Z'), content: { name: 'x' }, targets: [], principal_targets: version === 3 ? [{ kind: 'role', identifier: 'r', name: 'R' }] : null });
    const fake = makeFakeRunner((sql) => (sql.startsWith('SELECT version') ? [v(3), v(2)] : [row()]));
    const env = { schema: 'public', runner: fake.runner };
    const out = await listVersions(manager, TPL, env);
    expect(out.map((x) => x.version)).toEqual([3, 2]);
    // A version written before role/group targets existed has none.
    expect(out.map((x) => x.principalTargets)).toEqual([[{ kind: 'role', identifier: 'r', name: 'R' }], []]);
    expect(fake.calls.find((c) => c.sql.startsWith('SELECT version'))!.sql).toContain('ORDER BY version DESC');
    const others = makeFakeRunner(() => [row(OTHERS)]);
    await expect(listVersions(manager, TPL, { schema: 'public', runner: others.runner })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('audience org units: every unit for any bygger (a dangling parent reference is cut), nothing without template.manage', async () => {
    const fake = makeFakeRunner(() => [
      { uuid: PARENT, name: 'Afdeling', parent_uuid: OTHER },
      { uuid: CHILD, name: 'Team', parent_uuid: PARENT },
    ]);
    const env = { schema: 'public', runner: fake.runner };
    expect(await listAudienceOrgUnits(manager, env)).toEqual([
      { uuid: PARENT, name: 'Afdeling', parentUuid: null },
      { uuid: CHILD, name: 'Team', parentUuid: PARENT },
    ]);
    // No filter: the whole tree.
    expect(fake.calls[0].params).toEqual([]);
    const none = makeFakeRunner();
    expect(await listAudienceOrgUnits(makePrincipal(), { schema: 'public', runner: none.runner })).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});

// A refusal is an authz.denied row, written after the transaction rolled back, with the template as the
// only entity (no name, prompt or note) and a closed reason; the answer to the caller does not change.
describe('refusals are audited (authz.denied)', () => {
  const ROLE = { kind: 'role' as const, identifier: 'sagsbehandler' };
  const edit = { baseVersion: 3, changeNote: NOTE, name: 'Nyt navn' };
  const state = { baseVersion: 3, changeNote: NOTE };
  const denied = (reason: string, withEntity = true) => ({
    actorUserId: 'mgr-1',
    required: 'template.manage',
    reason,
    ...(withEntity ? { entityType: 'central_template', entityId: TPL } : {}),
  });

  it("a bygger touching another bygger's template: reason not_owner, and the answer is the plain 404", async () => {
    const others = () => setup({ template: [row(OTHERS)] });
    const err = await updateCentralTemplate(manager, TPL, edit, others().env).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: 'not_found', message: 'Skabelonen findes ikke' });
    expect(recordAuthzDenied).toHaveBeenCalledTimes(1);
    expect(recordAuthzDenied).toHaveBeenCalledWith(denied('not_owner'));
    await archiveCentralTemplate(manager, TPL, state, others().env).catch(() => {});
    await restoreCentralTemplate(manager, TPL, state, setup({ template: [row({ ...OTHERS, status: 'archived' })] }).env).catch(() => {});
    expect(recordAuthzDenied.mock.calls.map((c) => c[0])).toEqual([denied('not_owner'), denied('not_owner'), denied('not_owner')]);
  });

  it('a template that does not exist (or an ill-formed id) is NOT a refusal: the 404 is identical and nothing is logged', async () => {
    await expect(updateCentralTemplate(manager, TPL, edit, setup({ template: [] }).env)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCentralTemplate(manager, 'nope', edit, setup().env)).rejects.toBeInstanceOf(NotFoundError);
    expect(recordAuthzDenied).not.toHaveBeenCalled();
  });

  it('principal_targets_need_claims: adding role targets outside claims mode', async () => {
    await expect(updateCentralTemplate(manager, TPL, { ...edit, principalTargets: [ROLE] }, setup({ accessSource: 'local' }).env)).rejects.toMatchObject({
      code: 'principal_targets_need_claims',
    });
    expect(recordAuthzDenied.mock.calls.map((c) => c[0])).toEqual([denied('principal_targets_need_claims')]);
  });

  it('version_conflict: a stale baseVersion; a violated row lock is a bug, not a refusal', async () => {
    await expect(updateCentralTemplate(manager, TPL, { ...edit, baseVersion: 1 }, setup().env)).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(archiveCentralTemplate(manager, TPL, { ...state, baseVersion: 1 }, setup().env)).rejects.toMatchObject({ code: 'version_conflict' });
    const lost = setup({ updated: [] });
    await expect(updateCentralTemplate(manager, TPL, edit, lost.env)).rejects.toThrow('central template row lock violated');
    expect(recordAuthzDenied.mock.calls.map((c) => c[0])).toEqual([denied('version_conflict'), denied('version_conflict')]);
  });

  it('validation and state conflicts are not refusals (no_changes, template_archived, already_archived, target_unknown)', async () => {
    await expect(updateCentralTemplate(manager, TPL, { baseVersion: 3, changeNote: NOTE, name: 'Dialogmøde' }, setup().env)).rejects.toMatchObject({ code: 'no_changes' });
    await expect(updateCentralTemplate(manager, TPL, edit, setup({ template: [row({ status: 'archived' })] }).env)).rejects.toMatchObject({ code: 'template_archived' });
    await expect(archiveCentralTemplate(manager, TPL, state, setup({ template: [row({ status: 'archived' })] }).env)).rejects.toMatchObject({ code: 'already_archived' });
    await expect(updateCentralTemplate(manager, TPL, { ...edit, targets: [{ orgUnitUuid: OTHER }] }, setup({ orgUnitsFound: 0 }).env)).rejects.toMatchObject({
      code: 'target_unknown',
    });
    expect(recordAuthzDenied).not.toHaveBeenCalled();
  });

  it('is written after the rollback and carries ids and codes only; a denial that cannot be recorded does not change the answer', async () => {
    const { env, sqls } = setup({ template: [row(OTHERS)] });
    recordAuthzDenied.mockImplementationOnce(async () => {
      // At this point the transaction is already over.
      expect(sqls().at(-1)).toBe('ROLLBACK');
    });
    await updateCentralTemplate(manager, TPL, edit, env).catch(() => {});
    expect(JSON.stringify(recordAuthzDenied.mock.calls)).not.toMatch(/Dialogmøde|Nyt navn|Skriv et kort|Præciseret/);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
