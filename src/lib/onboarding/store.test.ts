import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));
vi.mock('@/lib/db/user-schema', () => db);

import { getSeenSteps, markStepSeen, resetHints } from './store';

beforeEach(() => {
  db.queryUserSchema.mockReset();
  db.queryUserSchema.mockResolvedValue([]);
});

describe('markStepSeen', () => {
  it('runs as a single statement so an in-flight resetHints cannot interleave', async () => {
    await markStepSeen('user-1', 'some.step', null);

    // Two statements on two pooled connections were not atomic with resetHints.
    expect(db.queryUserSchema).toHaveBeenCalledTimes(1);
    const [userId, sql] = db.queryUserSchema.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(sql).toMatch(/INSERT INTO onboarding_progress/);
    expect(sql).toMatch(/INSERT INTO onboarding_state/);
    expect(sql).toMatch(/last_step_id = EXCLUDED\.last_step_id/);
  });

  it('stores the sentinel (not a literal NULL) for a global step', async () => {
    await markStepSeen('user-1', 'some.step', null);

    const progressCall = db.queryUserSchema.mock.calls.find((call: unknown[]) =>
      /INSERT INTO onboarding_progress/.test(call[1] as string),
    );
    expect(progressCall![2]).toEqual(['some.step', '']);
  });

  it('stores a real meeting id unchanged', async () => {
    await markStepSeen('user-1', 'some.step', 'm-1');

    const progressCall = db.queryUserSchema.mock.calls.find((call: unknown[]) =>
      /INSERT INTO onboarding_progress/.test(call[1] as string),
    );
    expect(progressCall![2]).toEqual(['some.step', 'm-1']);
  });
});

describe('getSeenSteps', () => {
  it('converts the sentinel back to null, and leaves a real meeting id alone', async () => {
    db.queryUserSchema.mockResolvedValueOnce([
      { step_id: 'global.step', meeting_id: '' },
      { step_id: 'per-meeting.step', meeting_id: 'm-1' },
    ]);

    expect(await getSeenSteps('user-1')).toEqual([
      { stepId: 'global.step', meetingId: null },
      { stepId: 'per-meeting.step', meetingId: 'm-1' },
    ]);
  });
});

describe('resetHints', () => {
  it('runs as a single statement so an in-flight write cannot interleave', async () => {
    await resetHints('user-1');

    // Two statements on two pooled connections were not atomic.
    expect(db.queryUserSchema).toHaveBeenCalledTimes(1);
    const [userId, sql] = db.queryUserSchema.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(sql).toMatch(/DELETE FROM onboarding_progress/);
    expect(sql).toMatch(/INSERT INTO onboarding_state/);
    expect(sql).toMatch(/tour_completed_at = NOW\(\)/);
    expect(sql).toMatch(/tour_skipped_at = NULL/);
    expect(sql).toMatch(/last_step_id = NULL/);
  });
});
