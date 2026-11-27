import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
const recordEvent = vi.fn();
const recordServerEvent = vi.fn();
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
  recordServerEvent: (...a: unknown[]) => recordServerEvent(...a),
}));

import { validateEvent } from '@/lib/audit/record';
import { emptyCatalogueCounts } from './catalogue-sync';
import { CATALOGUE_COUNT_KEYS, INTEGRATION_COUNT_KEYS } from '@/lib/audit/events/integration';
import { recordIntegrationRun } from './run-audit';
import { emptySyncCounts } from './types';

beforeEach(() => {
  recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
  recordServerEvent.mockReset().mockResolvedValue({ status: 'stored' });
});

describe('integration.sync_run counters', () => {
  it('cover exactly the counters the two runs report', () => {
    expect([...CATALOGUE_COUNT_KEYS].sort()).toEqual(Object.keys(emptyCatalogueCounts()).sort());
    expect(INTEGRATION_COUNT_KEYS).toEqual(expect.arrayContaining(Object.keys(emptySyncCounts())));
  });
});

describe('recordIntegrationRun', () => {
  it('a cron run is a system event without actor, with the counts of the applied run', async () => {
    await recordIntegrationRun({
      kind: 'org_sync',
      trigger: 'cron',
      result: { status: 'success', counts: { ...emptySyncCounts(), usersUpserted: 12, assignmentsRemoved: 2 }, errorCode: null },
    });
    expect(recordServerEvent).not.toHaveBeenCalled();
    const event = recordEvent.mock.calls[0][0];
    expect(event).toMatchObject({ type: 'integration.sync_run', source: 'system', details: { kind: 'org_sync', trigger: 'cron', status: 'success', usersUpserted: 12, assignmentsRemoved: 2, sessionsRevoked: 0 } });
    expect(event).not.toHaveProperty('actorUserId');
    expect(event).not.toHaveProperty('outcome');
    expect(validateEvent(event)).toMatchObject({ ok: true });
  });

  it('a manual run is a server event for the administrator, on that request', async () => {
    const req = { headers: new Headers() };
    await recordIntegrationRun({
      kind: 'role_catalogue',
      trigger: 'manual',
      actorUserId: 'admin-1',
      req,
      result: { status: 'success', counts: { fetched: 5, added: 1, updated: 4, deactivated: 0, skipped: 0 }, errorCode: null },
    });
    expect(recordEvent).not.toHaveBeenCalled();
    const [, event] = recordServerEvent.mock.calls[0];
    expect(event).toMatchObject({ source: 'server', actorUserId: 'admin-1', details: { kind: 'role_catalogue', trigger: 'manual', status: 'success', fetched: 5, added: 1, updated: 4 } });
    expect(validateEvent(event)).toMatchObject({ ok: true });
  });

  it.each([
    ['aborted', 'removal_threshold'],
    ['aborted', 'empty_response'],
    ['error', 'timeout'],
    ['error', 'db_error'],
  ] as const)('a %s run (%s) is outcome error with its code and no counts', async (status, errorCode) => {
    await recordIntegrationRun({ kind: 'org_sync', trigger: 'cron', result: { status, counts: { ...emptySyncCounts(), usersUpserted: 9 }, errorCode } });
    const event = recordEvent.mock.calls[0][0];
    expect(event).toMatchObject({ outcome: 'error', details: { kind: 'org_sync', trigger: 'cron', status, code: errorCode } });
    expect(event.details).not.toHaveProperty('usersUpserted');
    expect(validateEvent(event)).toMatchObject({ ok: true });
  });

  it('a code that is not a closed short code becomes "unknown" (never free text)', async () => {
    await recordIntegrationRun({ kind: 'org_sync', trigger: 'cron', result: { status: 'error', counts: null, errorCode: 'Noget gik galt hos Jens' } });
    expect(recordEvent.mock.calls[0][0].details.code).toBe('unknown');
  });

  it('only known numeric counters enter the event: extra keys and non-numbers are dropped', async () => {
    await recordIntegrationRun({
      kind: 'role_catalogue',
      trigger: 'cron',
      result: { status: 'success', counts: { fetched: 3, names: ['Sagsbehandler'], added: 'x', updated: -1, skipped: 1.5 }, errorCode: null },
    });
    expect(recordEvent.mock.calls[0][0].details).toEqual({ kind: 'role_catalogue', trigger: 'cron', status: 'success', fetched: 3 });
  });

  it('records nothing when another run held the lock (nothing ran)', async () => {
    await recordIntegrationRun({ kind: 'org_sync', trigger: 'cron', result: { status: 'already_running', counts: {}, errorCode: 'already_running' } });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('never throws, even when the audit layer does', async () => {
    recordEvent.mockRejectedValue(new Error('audit down'));
    await expect(recordIntegrationRun({ kind: 'org_sync', trigger: 'cron', result: { status: 'success', counts: {}, errorCode: null } })).resolves.toBeUndefined();
  });
});
