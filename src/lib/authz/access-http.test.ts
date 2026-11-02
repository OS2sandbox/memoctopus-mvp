import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from './access-errors';
import { toErrorResponse } from './access-http';

describe('toErrorResponse', () => {
  it('maps typed errors to their status with error and code', async () => {
    const res = toErrorResponse(new NotFoundError('Skabelonen findes ikke'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Skabelonen findes ikke', code: 'not_found' });
    expect(toErrorResponse(new ValidationError('x')).status).toBe(400);
    expect(toErrorResponse(new ConflictError('x')).status).toBe(409);
  });

  it('adds the current version to a version conflict only (409)', async () => {
    const res = toErrorResponse(new VersionConflictError(7));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_conflict', currentVersion: 7 });
    expect(await toErrorResponse(new ConflictError('x')).json()).not.toHaveProperty('currentVersion');
  });

  it('rethrows anything that is not a typed access error', () => {
    expect(() => toErrorResponse(new Error('boom'))).toThrow('boom');
  });
});
