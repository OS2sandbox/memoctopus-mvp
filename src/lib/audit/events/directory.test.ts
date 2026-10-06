import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));

import { validateEvent } from '../record';
import { EVENT_CATALOGUE } from './index';
import { emptySyncCounts } from '@/lib/rollekatalog/types';

const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { type: 'directory.sync', actorUserId: null } as const;

describe('directory.sync', () => {
  it('is a system/server event on a sync_run entity with optional id', () => {
    const def = EVENT_CATALOGUE['directory.sync'];
    expect(def.sources).toEqual(['system', 'server']);
    expect(def.entityType).toBe('sync_run');
    expect(def.entityIdRequired).toBe(false);
  });

  it('accepts the sync counters as they come out of SyncCounts, with and without a run id', () => {
    const details = { trigger: 'cron', status: 'success', ...emptySyncCounts() } as const;
    expect(validateEvent({ ...base, source: 'system', details } as never).ok).toBe(true);
    expect(validateEvent({ ...base, source: 'system', entityId: RUN, details } as never).ok).toBe(true);
    expect(validateEvent({ ...base, source: 'server', actorUserId: 'admin-1', details: { ...details, trigger: 'manual' } } as never).ok).toBe(true);
  });

  it('accepts an aborted run with an error code', () => {
    const details = { trigger: 'manual', status: 'aborted', ...emptySyncCounts(), errorCode: 'removal_threshold' };
    expect(validateEvent({ ...base, source: 'server', outcome: 'error', details } as never).ok).toBe(true);
  });

  it('accepts the forced flag of a manual run and rejects a non-boolean', () => {
    const details = { trigger: 'manual', status: 'success', ...emptySyncCounts() };
    expect(validateEvent({ ...base, source: 'server', actorUserId: 'admin-1', details: { ...details, forced: true } } as never).ok).toBe(true);
    expect(validateEvent({ ...base, source: 'server', actorUserId: 'admin-1', details: { ...details, forced: 'yes' } } as never).ok).toBe(false);
  });

  it('accepts the sessionsRevoked count (and still without it), and rejects it negative or non-numeric', () => {
    const { sessionsRevoked: _omitted, ...without } = { trigger: 'cron', status: 'success', ...emptySyncCounts() };
    expect(validateEvent({ ...base, source: 'system', details: { ...without, sessionsRevoked: 3 } } as never).ok).toBe(true);
    expect(validateEvent({ ...base, source: 'system', details: without } as never).ok).toBe(true);
    expect(validateEvent({ ...base, source: 'system', details: { ...without, sessionsRevoked: -1 } } as never).ok).toBe(false);
    expect(validateEvent({ ...base, source: 'system', details: { ...without, sessionsRevoked: 'alle' } } as never).ok).toBe(false);
  });

  it('rejects free text, unknown keys, a client source and negative counts', () => {
    const ok = { trigger: 'cron', status: 'success', ...emptySyncCounts() };
    expect(validateEvent({ ...base, source: 'system', details: { ...ok, errorCode: 'Rollekatalog svarede ikke' } } as never).ok).toBe(false);
    expect(validateEvent({ ...base, source: 'system', details: { ...ok, userName: 'jens.t' } } as never).ok).toBe(false);
    expect(validateEvent({ ...base, source: 'client', details: ok } as never).ok).toBe(false);
    expect(validateEvent({ ...base, source: 'system', details: { ...ok, usersUpserted: -1 } } as never).ok).toBe(false);
  });
});
