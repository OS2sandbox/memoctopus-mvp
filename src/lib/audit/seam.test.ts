import { describe, expect, it } from 'vitest';
import { recordAdminAction, recordAuthzDenied } from './seam';

describe('audit seam (phase 1 no-op)', () => {
  it('recordAdminAction resolves and does not touch the transaction', async () => {
    const tx = new Proxy({}, { get: () => { throw new Error('tx must not be used'); } });
    await expect(
      recordAdminAction(tx, {
        type: 'access.role_assign',
        actorUserId: 'u1',
        entityType: 'role_assignment',
        entityId: 'r1',
      }),
    ).resolves.toBeUndefined();
  });

  it('recordAuthzDenied returns synchronously without throwing', () => {
    expect(
      recordAuthzDenied({ actorUserId: null, required: 'access.manage', reason: 'missing_capability' }),
    ).toBeUndefined();
  });
});
