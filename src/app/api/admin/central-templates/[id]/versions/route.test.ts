import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ listVersions: vi.fn() }));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: vi.fn() }));

import { GET } from './route';
import { recordServerEvent } from '@/lib/audit/record';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { listVersions } from '@/lib/skabeloner/central';
import { NotFoundError } from '@/lib/authz/access-errors';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';
import { manager, T1, VERSION } from '@/test/central-fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockVersions = vi.mocked(listVersions);
const mockAudit = vi.mocked(recordServerEvent);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = T1) =>
  GET(makeJsonReq(`http://localhost/api/admin/central-templates/${id}/versions`, 'GET'), ctx(id));

beforeEach(() => {
  mockAudit.mockReset().mockResolvedValue({ status: 'stored' } as never);
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(manager);
  mockVersions.mockReset().mockResolvedValue([VERSION, { ...VERSION, version: 2 }]);
});

describe('GET /api/admin/central-templates/[id]/versions', () => {
  it('returns the changelog in the order the service gives (newest first), uncached', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const { versions } = await res.json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    expect(versions[0]).toEqual(VERSION);
    expect(mockVersions).toHaveBeenCalledWith(manager, T1);
  });

  it('whitelists the version fields', async () => {
    mockVersions.mockResolvedValue([{ ...VERSION, changedByUserId: 'u1' } as never]);
    const { versions } = await (await get()).json();
    expect(versions[0]).not.toHaveProperty('changedByUserId');
  });

  it('404 for an out-of-scope template', async () => {
    mockVersions.mockRejectedValue(new NotFoundError());
    expect((await get()).status).toBe(404);
  });

  it('400 for a malformed id', async () => {
    expect((await get('nope')).status).toBe(400);
    expect(mockVersions).not.toHaveBeenCalled();
  });

  it('writes no audit event for a read (success, 403 or 404)', async () => {
    expect((await get()).status).toBe(200);
    mockVersions.mockRejectedValue(new NotFoundError());
    expect((await get()).status).toBe(404);
    mockResolve.mockResolvedValue({ ...manager, capabilities: ['template.use'] });
    expect((await get()).status).toBe(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
