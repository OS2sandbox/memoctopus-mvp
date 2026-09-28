import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/teams/poller', () => ({ startPoller: vi.fn() }));
vi.mock('@/lib/pending-sweeper', () => ({ startPendingSweeper: vi.fn() }));

import { register } from './instrumentation';
import { startPoller } from '@/lib/teams/poller';
import { startPendingSweeper } from '@/lib/pending-sweeper';

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

  it('starts nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startPoller).not.toHaveBeenCalled();
    expect(startPendingSweeper).not.toHaveBeenCalled();
  });
});
