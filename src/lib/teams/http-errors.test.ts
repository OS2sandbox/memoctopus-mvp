import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));

import { GraphError } from './graph-client';
import { isTeamsKnownError, teamsErrorResponse } from './http-errors';
import { ResolveError } from './meeting-resolver';

describe('teamsErrorResponse', () => {
  it.each([
    ['invalid-url', 400],
    ['wrong-host', 400],
    ['not_invited', 404],
  ] as const)('maps ResolveError %s to %i', async (code, status) => {
    const res = teamsErrorResponse(new ResolveError(code));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });

  it.each([
    ['consent_required', 403],
    ['reauth_required', 403],
    ['transcripts_disabled', 403],
    ['disabled', 403],
    ['forbidden', 403],
    ['not_found', 404],
    ['unavailable', 503],
    ['http', 502],
  ] as const)('maps GraphError %s to %i', async (code, status) => {
    const res = teamsErrorResponse(new GraphError(code, 'Fejl.'));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code === 'http' ? 'graph' : code);
  });

  it('returns an empty missing list when the GraphError carries none', async () => {
    const res = teamsErrorResponse(new GraphError('consent_required', 'Fejl.'));
    expect((await res.json()).missing).toEqual([]);
  });

  it('turns anything else into a 500 with a Danish message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = teamsErrorResponse(new Error('boom'));
    expect(res.status).toBe(500);
    expect((await res.json()).message).toMatch(/uventet fejl/i);
    spy.mockRestore();
  });

  it('recognises the errors it can map', () => {
    expect(isTeamsKnownError(new GraphError('http', 'x'))).toBe(true);
    expect(isTeamsKnownError(new ResolveError('invalid-url'))).toBe(true);
    expect(isTeamsKnownError(new Error('x'))).toBe(false);
  });
});
