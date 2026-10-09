import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiRequest } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('apiRequest', () => {
  it('keeps code and currentVersion of a 409 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'x', code: 'version_conflict', currentVersion: 4 }), { status: 409 }),
        ),
      ),
    );
    expect(await apiRequest('/x')).toEqual({
      ok: false,
      status: 409,
      message: 'x',
      code: 'version_conflict',
      currentVersion: 4,
    });
  });

  it('turns a network failure into a Danish message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('down'))),
    );
    expect(await apiRequest('/x')).toMatchObject({ ok: false, status: 0, message: 'Netværksfejl. Prøv igen.' });
  });
});
