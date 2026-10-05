import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, safeLogError } from './safe-log';

afterEach(() => vi.restoreAllMocks());

const LEAK = 'Vi skal tale om sagen om Jensens barn.';

describe('describeError', () => {
  it('keeps name, numeric status and a short code', () => {
    const err = Object.assign(new Error(LEAK), { name: 'APIError', status: 429, code: 'rate_limit_exceeded' });
    expect(describeError(err)).toEqual({ name: 'APIError', status: 429, code: 'rate_limit_exceeded' });
  });
  it('reads statusCode and response.status too', () => {
    expect(describeError(Object.assign(new Error('x'), { statusCode: 502 })).status).toBe(502);
    expect(describeError(Object.assign(new Error('x'), { response: { status: 503 } })).status).toBe(503);
  });
  it('drops free-text codes, bad statuses and odd names', () => {
    const e = describeError(Object.assign(new Error('x'), { name: 'Bad name with spaces', status: '429', code: LEAK }));
    expect(e).toEqual({ name: 'Error', status: undefined, code: undefined });
    expect(describeError(Object.assign(new Error('x'), { status: 99 })).status).toBeUndefined();
  });
  it('describes non-errors by type only', () => {
    expect(describeError(LEAK)).toEqual({ name: 'string', status: undefined, code: undefined });
    expect(describeError(null).name).toBe('object');
    expect(describeError(undefined).name).toBe('undefined');
  });
});

describe('safeLogError', () => {
  it('logs one content-free line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error(LEAK), {
      name: 'BadRequestError',
      status: 400,
      code: 'context_length_exceeded',
      error: { message: LEAK },
      body: LEAK,
      cause: new Error(LEAK),
    });
    safeLogError('minutes', err, 'req-1');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]).toEqual(['[minutes] name=BadRequestError status=400 code=context_length_exceeded requestId=req-1']);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Jensens');
  });
  it('omits absent parts', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeLogError('x', new TypeError(LEAK));
    expect(spy.mock.calls[0]).toEqual(['[x] name=TypeError']);
  });
});
