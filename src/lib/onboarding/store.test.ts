import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));
vi.mock('@/lib/db/user-schema', () => db);

import { getSeenSteps, markStepSeen, resetHints, skipTour } from './store';
import { ONBOARDING_STEPS } from './steps';

beforeEach(() => {
  db.queryUserSchema.mockReset();
  db.queryUserSchema.mockResolvedValue([]);
});

describe('markStepSeen', () => {
  it('is a single insert into onboarding_progress and nothing else', async () => {
    await markStepSeen('user-1', 'some.step', null);

    expect(db.queryUserSchema).toHaveBeenCalledTimes(1);
    const [userId, sql] = db.queryUserSchema.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(sql).toMatch(/INSERT INTO onboarding_progress/);
    // last_step_id was written on every save and never read anywhere.
    expect(sql).not.toMatch(/onboarding_state|last_step_id/);
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
    expect(sql).not.toMatch(/last_step_id/);
  });
});

describe('skipTour', () => {
  it('marks every one-time hint seen and the tour skipped, in one statement', async () => {
    await skipTour('user-1');

    // "spring over" means no hints: one statement, so the hints and the flag land together.
    expect(db.queryUserSchema).toHaveBeenCalledTimes(1);
    const [userId, sql, params] = db.queryUserSchema.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(sql).toMatch(/INSERT INTO onboarding_progress/);
    expect(sql).toMatch(/ON CONFLICT ON CONSTRAINT onboarding_progress_step_meeting_unique DO NOTHING/);
    expect(sql).toMatch(/tour_skipped_at = NOW\(\)/);

    const expected = Object.values(ONBOARDING_STEPS)
      .filter((s) => s.engine === 'popover' && s.scope === 'global')
      .map((s) => s.id);
    expect(expected.length).toBeGreaterThan(0);
    expect([...params[0]].sort()).toEqual([...expected].sort());
  });

  it('leaves tooltips and the per-meeting data-loss warning alone', async () => {
    await skipTour('user-1');

    const ids: string[] = db.queryUserSchema.mock.calls[0][2][0];
    expect(ids).not.toContain('dashboard.keyboard-shortcuts'); // tooltip
    expect(ids).not.toContain('topbar.unsaved-audio'); // per-meeting
  });
});
