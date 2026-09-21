import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));
vi.mock('@/lib/db/user-schema', () => db);

import { resetHints } from './store';

beforeEach(() => {
  db.queryUserSchema.mockReset();
  db.queryUserSchema.mockResolvedValue([]);
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
