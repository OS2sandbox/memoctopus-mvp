import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ listVersions: vi.fn() }));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: vi.fn() }));

import { GET } from './route';
import { recordServerEvent } from '@/lib/audit/record';
import { promptReadCoalescer } from '../../audit-read';
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
  promptReadCoalescer.clear();
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

  describe('prompt read audit (central_template.read)', () => {
    it('records the same coalesced read event as the detail, with the newest version and no prompt text', async () => {
      await get();
      await get();
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit.mock.calls[0][1]).toEqual({
        type: 'central_template.read',
        actorUserId: manager.userId,
        entityId: T1,
        details: { version: 3 },
      });
      expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('HEMMELIG PROMPT');
    });

    it('shares the slot with the detail endpoint (one event per actor and template)', async () => {
      const { auditPromptRead } = await import('../../audit-read');
      await auditPromptRead(makeJsonReq('http://localhost/x', 'GET'), manager.userId, { id: T1, version: 3 });
      await get();
      expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('emits nothing for a 404 or 403', async () => {
      mockVersions.mockRejectedValue(new NotFoundError());
      expect((await get()).status).toBe(404);
      mockResolve.mockResolvedValue({ ...manager, capabilities: ['template.use'] });
      expect((await get()).status).toBe(403);
      expect(mockAudit).not.toHaveBeenCalled();
    });

    it('an audit failure never breaks the response', async () => {
      mockAudit.mockRejectedValue(new Error('audit down'));
      const res = await get();
      expect(res.status).toBe(200);
      expect((await res.json()).versions).toHaveLength(2);
    });
  });
});
