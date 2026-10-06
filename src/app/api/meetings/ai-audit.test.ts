import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from './ai-audit';

const UUID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mockRecord.mockReset();
  mockRecord.mockResolvedValue({ status: 'stored' });
});
afterEach(() => vi.restoreAllMocks());

describe('asEntityUuid', () => {
  it('accepts a well-formed UUID', () => {
    expect(asEntityUuid(UUID)).toBe(UUID);
  });

  it.each(['meet-1', '', ' ', UUID + 'x', `${UUID}\n`, '../../etc/passwd', 'Referat om sag 42'])(
    'rejects %j so arbitrary client strings never become an entity id',
    (v) => expect(asEntityUuid(v)).toBeUndefined(),
  );

  it('rejects non-strings', () => {
    expect(asEntityUuid(undefined)).toBeUndefined();
    expect(asEntityUuid(null)).toBeUndefined();
    expect(asEntityUuid(42)).toBeUndefined();
    expect(asEntityUuid({ toString: () => UUID })).toBeUndefined();
  });
});

describe('outcomeCodeOf', () => {
  it('prefers a short error code', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
  });

  it('falls back to the HTTP status', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { status: 429 }))).toBe('http_429');
  });

  it('falls back to the class name, never the message', () => {
    class TimeoutError extends Error {
      name = 'TimeoutError';
    }
    const code = outcomeCodeOf(new TimeoutError('the secret transcript text'));
    expect(code).toBe('TimeoutError');
    expect(code).not.toContain('secret');
  });

  it('drops a free-text code and non-Error values', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code: 'has spaces in it' }))).toBe('Error');
    expect(outcomeCodeOf('plain string with content')).toBe('string');
  });
});

describe('elapsedMs', () => {
  it('is never negative', () => {
    expect(elapsedMs(Date.now() + 10_000)).toBe(0);
  });
});

describe('emitAudit', () => {
  const req = { headers: new Headers() };

  it('forwards the request and the event to recordServerEvent', async () => {
    await emitAudit(req, { type: 'export.download', actorUserId: 'u', details: { format: 'pdf' } });
    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toBe(req);
  });
});
