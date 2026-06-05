import { describe, it, expect } from 'vitest';
import { GET } from './route';

describe('GET /api/health', () => {
  it('returns 200', async () => {
    const res = GET();
    expect(res.status).toBe(200);
  });

  it('returns { status: "ok" }', async () => {
    const res = GET();
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
