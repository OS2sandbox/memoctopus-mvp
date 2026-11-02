import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/teams/poller', () => ({ startPoller: vi.fn() }));
vi.mock('@/lib/pending-sweeper', () => ({ startPendingSweeper: vi.fn() }));
vi.mock('@/lib/system/config-fingerprint', () => ({ checkConfigOnce: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/authz/external-roles', () => ({ syncConfigCatalogueOnce: vi.fn().mockResolvedValue(undefined) }));

import { register } from './instrumentation';
import { startPoller } from '@/lib/teams/poller';
import { startPendingSweeper } from '@/lib/pending-sweeper';
import { checkConfigOnce } from '@/lib/system/config-fingerprint';
import { syncConfigCatalogueOnce } from '@/lib/authz/external-roles';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('register()', () => {
  it('starts the Graph poller and the sweep of the pending hand-off files on the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    expect(startPoller).toHaveBeenCalledTimes(1);
    expect(startPendingSweeper).toHaveBeenCalledTimes(1);
  });

  it('records the configuration fingerprint and loads the role catalogue on the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    expect(checkConfigOnce).toHaveBeenCalledTimes(1);
    expect(syncConfigCatalogueOnce).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing audit/catalogue step stop start-up', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.mocked(checkConfigOnce).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(register()).resolves.toBeUndefined();
    expect(startPoller).toHaveBeenCalledTimes(1);
  });

  it('starts nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startPoller).not.toHaveBeenCalled();
    expect(startPendingSweeper).not.toHaveBeenCalled();
    expect(checkConfigOnce).not.toHaveBeenCalled();
    expect(syncConfigCatalogueOnce).not.toHaveBeenCalled();
  });
});
