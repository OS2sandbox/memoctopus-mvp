import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', async () => {
  const { FAKE_SESSION } = await import('@/test/helpers');
  return { auth: { api: { getSession: vi.fn().mockResolvedValue(FAKE_SESSION) } } };
});

import { GET as getStateRoute } from '@/app/api/onboarding/state/route';
import { ensureUserSchema, getUserSchemaName } from '@/lib/db/user-schema';
import { FAKE_SESSION } from '@/test/helpers';
import { pgliteSql, resetPgliteDb, usePgliteDb } from '@/test/pglite';
import { ONBOARDING_STEPS } from './steps';
import { getOnboardingState, getSeenSteps, markStepSeen, resetHints, skipTour, type SeenStep } from './store';

// store.test.ts checks the SQL text against a mocked pool. This file runs the same
// statements against a real Postgres (PGlite): the '' sentinel, the ON CONFLICT
// target, the one-statement CTEs, and the migrations a branch-era database went
// through on its way to the current onboarding_progress shape.

usePgliteDb();

/** The signed-in user of GET /api/onboarding/state. */
const USER: string = FAKE_SESSION.user.id;
const OTHER = 'user-2';

// Computed from the registry here rather than taken from ONE_TIME_HINT_IDS, so a
// wrong filter in steps.ts shows up as a difference instead of being mirrored.
const STEPS = Object.values(ONBOARDING_STEPS);
const ONE_TIME_HINTS = STEPS.filter((s) => s.engine === 'popover' && s.scope === 'global').map((s) => s.id);
const TOOLTIPS = STEPS.filter((s) => s.engine === 'tooltip').map((s) => s.id);
const PER_MEETING_WARNING = 'topbar.unsaved-audio';

const byStepThenMeeting = (a: SeenStep, b: SeenStep) =>
  a.stepId.localeCompare(b.stepId) || (a.meetingId ?? '').localeCompare(b.meetingId ?? '');

/** getSeenSteps has no ORDER BY; sort before comparing. */
async function seen(userId = USER): Promise<SeenStep[]> {
  return (await getSeenSteps(userId)).sort(byStepThenMeeting);
}

/** onboarding_progress as stored, sentinel and all. */
async function storedProgress(userId = USER) {
  return pgliteSql<{ id: string; step_id: string; meeting_id: string | null; status: string; seen_at: Date }>(
    `SELECT id, step_id, meeting_id, status, seen_at
       FROM "${getUserSchemaName(userId)}".onboarding_progress
      ORDER BY step_id, meeting_id NULLS FIRST, id`,
  );
}

async function storedState(userId = USER) {
  return pgliteSql(`SELECT * FROM "${getUserSchemaName(userId)}".onboarding_state ORDER BY id`);
}

/** What the client gets from GET /api/onboarding/state, `seen` sorted. */
async function stateFromApi() {
  const res = await getStateRoute();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tourSkipped: boolean; tourCompleted: boolean; seen: SeenStep[] };
  return { ...body, seen: [...body.seen].sort(byStepThenMeeting) };
}

describe('the registry this file leans on', () => {
  it('has one-time hints, tooltips and the per-meeting warning, so the skipTour tests below mean something', () => {
    expect(ONE_TIME_HINTS.length).toBeGreaterThan(0);
    expect(TOOLTIPS.length).toBeGreaterThan(0);
    expect(ONBOARDING_STEPS[PER_MEETING_WARNING]).toMatchObject({ engine: 'popover', scope: 'per-meeting' });
  });
});

describe('markStepSeen', () => {
  it('stores a global step once, however often it is marked seen', async () => {
    await markStepSeen(USER, 'dashboard.record-button', null);
    await markStepSeen(USER, 'dashboard.record-button', null);

    expect(await storedProgress()).toEqual([
      expect.objectContaining({ step_id: 'dashboard.record-button', meeting_id: '', status: 'seen' }),
    ]);
  });

  it('stores a per-meeting step once for each meeting', async () => {
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-1');
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-2');
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-1');

    expect((await storedProgress()).map((r) => [r.step_id, r.meeting_id])).toEqual([
      [PER_MEETING_WARNING, 'm-1'],
      [PER_MEETING_WARNING, 'm-2'],
    ]);
  });

  it('comes back through GET /api/onboarding/state with null for a global step and the id for a meeting', async () => {
    await markStepSeen(USER, 'dashboard.record-button', null);
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-1');

    expect(await stateFromApi()).toEqual({
      tourSkipped: false,
      tourCompleted: false,
      seen: [
        { stepId: 'dashboard.record-button', meetingId: null },
        { stepId: PER_MEETING_WARNING, meetingId: 'm-1' },
      ],
    });
  });
});

describe('skipTour', () => {
  it('marks every global popover hint seen and the tour skipped, in one call', async () => {
    await skipTour(USER);

    expect(await stateFromApi()).toEqual({
      tourSkipped: true,
      tourCompleted: false,
      seen: ONE_TIME_HINTS.map((stepId) => ({ stepId, meetingId: null })).sort(byStepThenMeeting),
    });
    expect((await storedProgress()).every((r) => r.meeting_id === '')).toBe(true);
  });

  it('leaves the tooltips and the per-meeting data-loss warning unmarked', async () => {
    await skipTour(USER);

    const stepIds = (await seen()).map((s) => s.stepId);
    for (const tooltip of TOOLTIPS) expect(stepIds).not.toContain(tooltip);
    expect(stepIds).not.toContain(PER_MEETING_WARNING);
  });

  it('keeps a per-meeting warning the user had already seen, as it was', async () => {
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-1');
    await skipTour(USER);

    expect((await seen()).filter((s) => s.stepId === PER_MEETING_WARNING)).toEqual([
      { stepId: PER_MEETING_WARNING, meetingId: 'm-1' },
    ]);
  });

  it('is idempotent, and does not duplicate or rewrite a hint already seen', async () => {
    await markStepSeen(USER, 'review.generate-button', null);
    const firstSeen = new Date('2026-09-01T08:00:00Z');
    await pgliteSql(
      `UPDATE "${getUserSchemaName(USER)}".onboarding_progress SET seen_at = $1 WHERE step_id = 'review.generate-button'`,
      [firstSeen],
    );

    await skipTour(USER);
    await skipTour(USER);

    const rows = await storedProgress();
    expect(rows).toHaveLength(ONE_TIME_HINTS.length);
    expect(rows.filter((r) => r.step_id === 'review.generate-button')).toEqual([
      expect.objectContaining({ meeting_id: '', seen_at: firstSeen }),
    ]);
    expect(await storedState()).toHaveLength(1);
    expect(await getOnboardingState(USER)).toEqual({ tourSkipped: true, tourCompleted: false });
  });
});

describe('resetHints', () => {
  it('forgets every seen hint, global and per-meeting, and turns a skipped tour into a completed one', async () => {
    await skipTour(USER);
    await markStepSeen(USER, PER_MEETING_WARNING, 'm-1');

    await resetHints(USER);

    // tourCompleted is what stops the empty seen list from reading as a first-time
    // user, which would reopen the welcome dialog on the next page load.
    expect(await stateFromApi()).toEqual({ tourSkipped: false, tourCompleted: true, seen: [] });
  });

  it('works for a user who has seen hints but never had a state row', async () => {
    await markStepSeen(USER, 'dashboard.record-button', null);
    expect(await storedState()).toEqual([]);

    await resetHints(USER);

    expect(await seen()).toEqual([]);
    expect(await getOnboardingState(USER)).toEqual({ tourSkipped: false, tourCompleted: true });
  });

  it('lets the hints be marked seen again afterwards', async () => {
    await markStepSeen(USER, 'dashboard.record-button', null);
    await resetHints(USER);
    await markStepSeen(USER, 'dashboard.record-button', null);

    expect(await seen()).toEqual([{ stepId: 'dashboard.record-button', meetingId: null }]);
  });

  it("leaves another user's hints and tour state alone", async () => {
    await skipTour(OTHER);
    await markStepSeen(OTHER, PER_MEETING_WARNING, 'm-9');
    await skipTour(USER);
    const before = { progress: await storedProgress(OTHER), state: await storedState(OTHER) };

    await resetHints(USER);

    expect({ progress: await storedProgress(OTHER), state: await storedState(OTHER) }).toEqual(before);
    expect(await getOnboardingState(OTHER)).toEqual({ tourSkipped: true, tourCompleted: false });
  });
});

describe('a brand-new user', () => {
  it('gets the first-time defaults from GET /api/onboarding/state, its schema created on the way', async () => {
    await resetPgliteDb({ dropSchemas: true });
    const schemaExists = async () =>
      (await pgliteSql(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [getUserSchemaName(USER)])).length > 0;
    expect(await schemaExists()).toBe(false);

    expect(await stateFromApi()).toEqual({ tourSkipped: false, tourCompleted: false, seen: [] });
    expect(await schemaExists()).toBe(true);
  });
});

// ─── Migrating a branch-era onboarding_progress ──────────────────────────────

describe('ensureUserSchema upgrading onboarding_progress from an earlier shape', () => {
  const LEGACY = 'legacy-user';
  const S = getUserSchemaName(LEGACY);
  const t = (iso: string) => new Date(iso);

  /** The table's shape as the catalog sees it, with the schema name taken out so two users compare. */
  async function shape(schema: string) {
    const constraints = await pgliteSql(
      `SELECT c.conname, c.contype::text AS contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = $1 AND cl.relname = 'onboarding_progress'
        ORDER BY c.conname`,
      [schema],
    );
    const indexes = (
      await pgliteSql<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1 AND tablename = 'onboarding_progress' ORDER BY indexname`,
        [schema],
      )
    ).map((i) => ({ ...i, indexdef: i.indexdef.replaceAll(schema, '<schema>') }));
    const columns = await pgliteSql(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'onboarding_progress' ORDER BY ordinal_position`,
      [schema],
    );
    return { constraints, indexes, columns };
  }

  async function snapshot() {
    return { progress: await storedProgress(LEGACY), state: await storedState(LEGACY), shape: await shape(S) };
  }

  /** The rest of the schema as it is today; onboarding_progress replaced by an older version of itself. */
  async function legacySchema(statements: string[]) {
    await resetPgliteDb({ dropSchemas: true });
    await ensureUserSchema(LEGACY);
    await pgliteSql(`DROP TABLE "${S}".onboarding_progress`);
    for (const sql of statements) await pgliteSql(sql);
  }

  async function insertProgress(rows: Array<[id: string, stepId: string, meetingId: string | null, seenAt: Date]>) {
    for (const [id, stepId, meetingId, seenAt] of rows) {
      await pgliteSql(
        `INSERT INTO "${S}".onboarding_progress (id, step_id, meeting_id, seen_at) VALUES ($1, $2, $3, $4)`,
        [id, stepId, meetingId, seenAt],
      );
    }
  }

  async function expectASecondRunToChangeNothing() {
    const before = await snapshot();
    await ensureUserSchema(LEGACY);
    expect(await snapshot()).toEqual(before);
  }

  it('the first shape (FK to meetings, nullable meeting_id, partial index for global steps) ends up as a new schema has it, data kept', async () => {
    // As b13cd2e created it.
    await legacySchema([
      `CREATE TABLE "${S}".onboarding_progress (
         id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
         step_id     TEXT NOT NULL,
         meeting_id  TEXT REFERENCES "${S}".meetings(id) ON DELETE CASCADE,
         status      TEXT NOT NULL DEFAULT 'seen',
         seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `ALTER TABLE "${S}".onboarding_progress
         ADD CONSTRAINT onboarding_progress_step_meeting_unique UNIQUE (step_id, meeting_id)`,
      `CREATE UNIQUE INDEX onboarding_progress_global_step_unique
         ON "${S}".onboarding_progress (step_id) WHERE meeting_id IS NULL`,
      `INSERT INTO "${S}".meetings (id, title) VALUES ('m-1', 'Ugentligt møde')`,
      `INSERT INTO "${S}".onboarding_state (id, tour_completed_at, last_step_id, updated_at)
         VALUES ('singleton', '2026-09-18T09:00:00Z', 'review.generate-button', '2026-09-18T09:00:00Z')`,
    ]);
    await insertProgress([
      ['p-1', 'dashboard.record-button', null, t('2026-09-15T10:00:00Z')],
      ['p-2', 'review.generate-button', null, t('2026-09-16T10:00:00Z')],
      ['p-3', PER_MEETING_WARNING, 'm-1', t('2026-09-17T10:00:00Z')],
    ]);
    // The fixture really is the old shape.
    const old = await shape(S);
    expect(old.constraints).toContainEqual(expect.objectContaining({ conname: 'onboarding_progress_meeting_id_fkey' }));
    expect(old.indexes).toContainEqual(expect.objectContaining({ indexname: 'onboarding_progress_global_step_unique' }));
    expect(old.columns).toContainEqual(expect.objectContaining({ column_name: 'meeting_id', is_nullable: 'YES' }));

    await ensureUserSchema(LEGACY);

    expect(await storedProgress(LEGACY)).toEqual([
      { id: 'p-1', step_id: 'dashboard.record-button', meeting_id: '', status: 'seen', seen_at: t('2026-09-15T10:00:00Z') },
      { id: 'p-2', step_id: 'review.generate-button', meeting_id: '', status: 'seen', seen_at: t('2026-09-16T10:00:00Z') },
      { id: 'p-3', step_id: PER_MEETING_WARNING, meeting_id: 'm-1', status: 'seen', seen_at: t('2026-09-17T10:00:00Z') },
    ]);
    const upgraded = await shape(S);
    expect(upgraded.constraints.map((c) => c.conname)).not.toContain('onboarding_progress_meeting_id_fkey');
    expect(upgraded.constraints).toContainEqual({
      conname: 'onboarding_progress_step_meeting_unique',
      contype: 'u',
      def: 'UNIQUE (step_id, meeting_id)',
    });
    expect(upgraded.indexes.map((i) => i.indexname)).not.toContain('onboarding_progress_global_step_unique');
    expect(upgraded.columns).toContainEqual({
      column_name: 'meeting_id',
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "''::text",
    });
    // Same constraints, indexes and columns as a schema created today.
    await ensureUserSchema('fresh-user');
    expect(upgraded).toEqual(await shape(getUserSchemaName('fresh-user')));
    expect(await getOnboardingState(LEGACY)).toEqual({ tourSkipped: false, tourCompleted: true });

    await expectASecondRunToChangeNothing();

    // And the store works on it: a global step already seen is not stored twice, and a
    // per-meeting hint for a meeting that exists only in the browser is no longer
    // rejected by the foreign key.
    await markStepSeen(LEGACY, 'dashboard.record-button', null);
    await markStepSeen(LEGACY, PER_MEETING_WARNING, 'only-in-the-browser');
    expect(await seen(LEGACY)).toEqual([
      { stepId: 'dashboard.record-button', meetingId: null },
      { stepId: 'review.generate-button', meetingId: null },
      { stepId: PER_MEETING_WARNING, meetingId: 'm-1' },
      { stepId: PER_MEETING_WARNING, meetingId: 'only-in-the-browser' },
    ]);
  });

  it('collapses duplicate rows to the most recently seen one before folding NULLs into the sentinel', async () => {
    // Nullable meeting_id, no FK (8146e5f), the unique constraint, but no partial index:
    // NULL beside '' gets past both, and duplicate NULLs only past the constraint.
    await legacySchema([
      `CREATE TABLE "${S}".onboarding_progress (
         id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
         step_id     TEXT NOT NULL,
         meeting_id  TEXT,
         status      TEXT NOT NULL DEFAULT 'seen',
         seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `ALTER TABLE "${S}".onboarding_progress
         ADD CONSTRAINT onboarding_progress_step_meeting_unique UNIQUE (step_id, meeting_id)`,
    ]);
    await insertProgress([
      // NULL, NULL and '' for one step: the '' row is newest and stays.
      ['a-null-old', 'dashboard.record-button', null, t('2026-09-15T10:00:00Z')],
      ['a-null', 'dashboard.record-button', null, t('2026-09-16T10:00:00Z')],
      ['a-sentinel', 'dashboard.record-button', '', t('2026-09-17T10:00:00Z')],
      // NULL newer than '': the NULL row stays, as ''.
      ['b-sentinel', 'review.generate-button', '', t('2026-09-15T10:00:00Z')],
      ['b-null', 'review.generate-button', null, t('2026-09-17T10:00:00Z')],
      // Two NULLs.
      ['c-null-old', 'recording.audio-lifecycle', null, t('2026-09-15T10:00:00Z')],
      ['c-null', 'recording.audio-lifecycle', null, t('2026-09-16T10:00:00Z')],
      // The same step for two meetings is not a duplicate.
      ['d-m1', PER_MEETING_WARNING, 'm-1', t('2026-09-15T10:00:00Z')],
      ['d-m2', PER_MEETING_WARNING, 'm-2', t('2026-09-15T10:00:00Z')],
    ]);

    await ensureUserSchema(LEGACY);

    expect(await storedProgress(LEGACY)).toEqual([
      { id: 'a-sentinel', step_id: 'dashboard.record-button', meeting_id: '', status: 'seen', seen_at: t('2026-09-17T10:00:00Z') },
      { id: 'c-null', step_id: 'recording.audio-lifecycle', meeting_id: '', status: 'seen', seen_at: t('2026-09-16T10:00:00Z') },
      { id: 'b-null', step_id: 'review.generate-button', meeting_id: '', status: 'seen', seen_at: t('2026-09-17T10:00:00Z') },
      { id: 'd-m1', step_id: PER_MEETING_WARNING, meeting_id: 'm-1', status: 'seen', seen_at: t('2026-09-15T10:00:00Z') },
      { id: 'd-m2', step_id: PER_MEETING_WARNING, meeting_id: 'm-2', status: 'seen', seen_at: t('2026-09-15T10:00:00Z') },
    ]);
    await ensureUserSchema('fresh-user');
    expect(await shape(S)).toEqual(await shape(getUserSchemaName('fresh-user')));

    await expectASecondRunToChangeNothing();
  });
});
