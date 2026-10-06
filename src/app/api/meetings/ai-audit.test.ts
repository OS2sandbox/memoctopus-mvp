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
  it('maps a numeric HTTP status to http_<status>', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { status: 429 }))).toBe('http_429');
    expect(outcomeCodeOf({ response: { status: 503 } })).toBe('http_503');
  });

  it('prefers the status over a code the upstream chose', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { status: 502, code: 'ECONNRESET' }))).toBe('http_502');
  });

  it.each(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'])('maps the timeout code %s to timeout', (code) => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code }))).toBe('timeout');
  });

  it('maps timeout-like and abort error names to timeout', () => {
    class TimeoutError extends Error {
      name = 'TimeoutError';
    }
    class AbortError extends Error {
      name = 'AbortError';
    }
    expect(outcomeCodeOf(new TimeoutError('the secret transcript text'))).toBe('timeout');
    expect(outcomeCodeOf(new AbortError('x'))).toBe('timeout');
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])('maps the connection code %s to network', (code) => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code }))).toBe('network');
  });

  it('never forwards a string chosen by the upstream: unknown codes, free text, class names and non-Errors give unknown', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code: 'rate_limit_exceeded' }))).toBe('unknown');
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code: 'attacker-chosen:1234' }))).toBe('unknown');
    expect(outcomeCodeOf(Object.assign(new Error('x'), { code: 'has spaces in it' }))).toBe('unknown');
    class SecretLeakError extends Error {
      name = 'SecretLeakError';
    }
    expect(outcomeCodeOf(new SecretLeakError('the secret transcript text'))).toBe('unknown');
    expect(outcomeCodeOf('plain string with content')).toBe('unknown');
    expect(outcomeCodeOf(null)).toBe('unknown');
  });

  it('ignores an out-of-range or non-integer status', () => {
    expect(outcomeCodeOf(Object.assign(new Error('x'), { status: 99999 }))).toBe('unknown');
    expect(outcomeCodeOf(Object.assign(new Error('x'), { status: 'oops' }))).toBe('unknown');
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

  it('drops events beyond a per-actor budget, per actor, without touching the client-event bucket', async () => {
    const { RATE_LIMIT_EVENTS, takeClientEventBudget } = await import('@/lib/audit/client-ingest');
    const event = (u: string) => ({ type: 'export.download' as const, actorUserId: u, details: { format: 'pdf' as const } });
    for (let i = 0; i < RATE_LIMIT_EVENTS; i++) await emitAudit(req, event('flooder'));
    expect(mockRecord).toHaveBeenCalledTimes(RATE_LIMIT_EVENTS);
    expect(await emitAudit(req, event('flooder'))).toEqual({ status: 'dropped', code: 'actor_rate_limited' });
    expect(mockRecord).toHaveBeenCalledTimes(RATE_LIMIT_EVENTS);
    // Another actor, and the same actor's client-event budget, are unaffected.
    await emitAudit(req, event('other'));
    expect(mockRecord).toHaveBeenCalledTimes(RATE_LIMIT_EVENTS + 1);
    expect(takeClientEventBudget('flooder', 1)).toBeNull();
  });
});
