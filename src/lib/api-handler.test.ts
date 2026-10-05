import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from './api-handler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('withHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through the handler response on success', async () => {
    const handler = withHandler('test', async () => NextResponse.json({ ok: true }));
    const res = await handler();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  it('forwards arguments to the wrapped handler', async () => {
    const inner = vi.fn(async (_req: string, n: number) => NextResponse.json({ n }));
    const handler = withHandler('test', inner);
    const res = await handler('req', 42);
    expect(inner).toHaveBeenCalledWith('req', 42);
    expect(await res.json()).toEqual({ n: 42 });
  });

  it('returns a JSON 500 and logs only name/status/code with the label when the handler throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withHandler('minutes', async () => {
      throw new Error('db down');
    });

    const res = await handler();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toMatch(/^\[minutes\] name=Error requestId=[0-9a-f-]{36}$/);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('db down');
  });

  it('never logs the error message, body, cause or stack (LLM errors can echo transcript text)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leak = 'Vi skal tale om sagen om Jensens barn';
    const err = Object.assign(new Error(leak), {
      name: 'APIError',
      status: 429,
      code: 'rate_limit_exceeded',
      error: { message: leak },
      cause: new Error(leak),
    });
    const handler = withHandler('minutes', async () => {
      throw err;
    });
    await handler();
    const printed = JSON.stringify(spy.mock.calls);
    expect(printed).not.toContain('Jensens');
    expect(String(spy.mock.calls[0][0])).toContain('[minutes] name=APIError status=429 code=rate_limit_exceeded');
  });

  it('catches synchronous throws too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withHandler('sync', (() => {
      throw new Error('sync boom');
    }) as () => Response);
    const res = await handler();
    expect(res.status).toBe(500);
  });

  it('echoes a valid x-request-id from the request in the log and response header on errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withHandler('r', async (_req: NextRequest) => {
      throw new Error('x');
    });
    const id = '3f2b8c1e-5a47-4d9b-9c3e-0a1b2c3d4e5f';
    const res = await handler(new NextRequest('http://localhost/api/x', { headers: { 'x-request-id': id } }));
    expect(res.headers.get('x-request-id')).toBe(id);
    expect(String(spy.mock.calls[0][0])).toContain(`requestId=${id}`);
  });

  it('generates a request id when the request has none or an unsafe one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withHandler('r', async (_req: NextRequest) => {
      throw new Error('x');
    });
    const none = await handler(new NextRequest('http://localhost/api/x'));
    expect(none.headers.get('x-request-id')).toMatch(UUID_RE);
    const unsafe = await handler(
      new NextRequest('http://localhost/api/x', { headers: { 'x-request-id': 'has spaces and prose' } }),
    );
    expect(unsafe.headers.get('x-request-id')).toMatch(UUID_RE);
  });

  it('generates a request id even when the handler takes no request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withHandler('t', async () => {
      throw new Error('x');
    })();
    expect(res.headers.get('x-request-id')).toMatch(UUID_RE);
  });
});
