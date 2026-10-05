import { describe, expect, it } from 'vitest';
import { syncHttpStatus, syncResultResponse } from './sync-http';
import { emptySyncCounts, type SyncResult } from './types';

const result = (over: Partial<SyncResult>): SyncResult => ({
  status: 'success',
  runId: 'run-1',
  counts: emptySyncCounts(),
  errorCode: null,
  ...over,
});

describe('syncHttpStatus', () => {
  it.each([
    [{ status: 'success' }, 200],
    [{ status: 'already_running', runId: null }, 409],
    [{ status: 'aborted', errorCode: 'removal_threshold' }, 502],
    [{ status: 'aborted', errorCode: 'empty_response' }, 502],
    [{ status: 'error', errorCode: 'timeout' }, 502],
    [{ status: 'error', errorCode: 'insecure_url' }, 502],
    [{ status: 'error', errorCode: 'unexpected' }, 500],
    [{ status: 'error', errorCode: null }, 500],
  ] as const)('%j gives %i', (over, status) => {
    expect(syncHttpStatus(result(over as Partial<SyncResult>))).toBe(status);
  });
});

describe('syncResultResponse', () => {
  it('is no-store and, without friendly, carries only status, counts and errorCode', async () => {
    const res = syncResultResponse(result({ status: 'error', errorCode: 'network' }), false);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(await res.json()).sort()).toEqual(['counts', 'errorCode', 'status']);
  });

  it('friendly adds the Danish error and code only on failure', async () => {
    const ok = await syncResultResponse(result({}), true).json();
    expect(ok.error).toBeUndefined();
    const bad = await syncResultResponse(result({ status: 'aborted', errorCode: 'empty_response' }), true).json();
    expect(bad).toMatchObject({ code: 'empty_response' });
    expect(bad.error).toMatch(/ingen brugere/);
  });

  it('already_running without a code is reported as already_running', async () => {
    const body = await syncResultResponse(result({ status: 'already_running', runId: null }), true).json();
    expect(body).toMatchObject({ errorCode: 'already_running', code: 'already_running' });
  });
});
