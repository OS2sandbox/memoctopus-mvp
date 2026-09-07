import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { withHandler } from './api-handler';

describe('withHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through the handler response on success', async () => {
    const handler = withHandler('test', async () => NextResponse.json({ ok: true }));
    const res = await handler();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('forwards arguments to the wrapped handler', async () => {
    const inner = vi.fn(async (_req: string, n: number) => NextResponse.json({ n }));
    const handler = withHandler('test', inner);
    const res = await handler('req', 42);
    expect(inner).toHaveBeenCalledWith('req', 42);
    expect(await res.json()).toEqual({ n: 42 });
  });

  it('returns a JSON 500 and logs with the label when the handler throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('db down');
    const handler = withHandler('minutes', async () => {
      throw boom;
    });

    const res = await handler();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(spy).toHaveBeenCalledWith('[minutes]', boom);
  });

  it('catches synchronous throws too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withHandler('sync', (() => {
      throw new Error('sync boom');
    }) as () => Response);
    const res = await handler();
    expect(res.status).toBe(500);
  });
});
