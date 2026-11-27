import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/db', () => ({
  pool: { connect: async () => fake.client },
}));
vi.mock('@/lib/audit/safe-log', () => ({ safeLogError: vi.fn() }));

import { safeLogError } from '@/lib/audit/safe-log';
import { defaultSyncEnv } from './sync-run';

function makeClient() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  });
  fake.client = client;
  return client;
}

describe('defaultSyncEnv().connect()', () => {
  it('survives an error on the checked-out connection (logged, not thrown)', async () => {
    const client = makeClient();
    const conn = await defaultSyncEnv().connect();
    const err = Object.assign(new Error('secret detail'), { code: 'ECONNRESET' });
    expect(() => client.emit('error', err)).not.toThrow();
    expect(safeLogError).toHaveBeenCalledTimes(1);
    conn.release(true);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('destroys a connection that errored while held, even when released normally', async () => {
    const client = makeClient();
    const conn = await defaultSyncEnv().connect();
    client.emit('error', new Error('x'));
    conn.release();
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('removes its listener on release so reused pooled clients do not accumulate them', async () => {
    const client = makeClient();
    const conn = await defaultSyncEnv().connect();
    expect(client.listenerCount('error')).toBe(1);
    conn.release();
    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });
});
