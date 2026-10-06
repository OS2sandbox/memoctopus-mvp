// Central templates are locked: the personal-template routes operate on the
// per-user `skabeloner` table only, so a central id must simply not exist there
// (404), must never be copied out (share/import) and must never be reachable
// through the central modules from those routes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));

// The per-user table has no row with a central template's id.
const mockQueryOne = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/user-schema', () => ({ queryUserSchema: mockQuery, queryUserSchemaOne: mockQueryOne }));

const dbInsert = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ pool: {}, db: { insert: dbInsert } }));
vi.mock('@/lib/skabeloner/share-config', () => ({ getShareConfig: () => ({ link: true, code: true }) }));
vi.mock('@/lib/skabeloner/shared-table', () => ({ ensureSharedSkabelonerTable: vi.fn() }));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

const centralCalls = vi.hoisted(() => ({ resolve: vi.fn(), central: vi.fn() }));
vi.mock('@/lib/skabeloner/resolve', () => ({
  listCentralForUser: centralCalls.resolve,
  resolveCentralTemplate: centralCalls.resolve,
}));
vi.mock('@/lib/skabeloner/central', () => ({
  getManageableTemplate: centralCalls.central,
  updateCentralTemplate: centralCalls.central,
  archiveCentralTemplate: centralCalls.central,
}));

import { GET as getOne, PUT as putOne, DELETE as deleteOne } from './[id]/route';
import { POST as setDefault } from './[id]/default/route';
import { POST as share } from './[id]/share/route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const CENTRAL_ID = '99999999-2222-4333-8444-555555555555';
const CTX = { params: Promise.resolve({ id: CENTRAL_ID }) };
const URL_ = `http://localhost/api/skabeloner/${CENTRAL_ID}`;

beforeEach(() => {
  vi.mocked(auth.api.getSession).mockReset();
  vi.mocked(auth.api.getSession).mockResolvedValue(FAKE_SESSION as never);
  mockQueryOne.mockReset();
  mockQueryOne.mockResolvedValue(null);
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
  dbInsert.mockReset();
  mockRecord.mockReset();
  centralCalls.resolve.mockReset();
  centralCalls.central.mockReset();
});

describe('personal skabelon routes and central ids', () => {
  // Whatever a test does, these routes never touch the central modules.
  afterEach(() => {
    expect(centralCalls.resolve).not.toHaveBeenCalled();
    expect(centralCalls.central).not.toHaveBeenCalled();
  });

  it('GET [id] -> 404', async () => {
    const res = await getOne(makeJsonReq(URL_, 'GET'), CTX);
    expect(res.status).toBe(404);
  });

  it('PUT [id] -> 404 and nothing is written or audited', async () => {
    const res = await putOne(makeJsonReq(URL_, 'PUT', { name: 'Omdøbt', prompt: 'Ny prompt' }), CTX);
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
    // Only reads (the lookup of the previous version); no UPDATE reached the table.
    for (const [sql] of [...mockQueryOne.mock.calls, ...mockQuery.mock.calls]) {
      expect(String(sql)).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/i);
    }
  });

  it('DELETE [id] -> 404 and no audit event', async () => {
    const res = await deleteOne(makeJsonReq(URL_, 'DELETE'), CTX);
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('POST [id]/default -> 404 and no audit event', async () => {
    const res = await setDefault(makeJsonReq(`${URL_}/default`, 'POST'), CTX);
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('POST [id]/share -> 404: a central prompt is never copied into the shared table', async () => {
    const res = await share(makeJsonReq(`${URL_}/share`, 'POST'), CTX);
    expect(res.status).toBe(404);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

});

describe('personal skabelon route sources', () => {
  const ROOT = path.resolve(__dirname);
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) return routeFiles(p);
      return f === 'route.ts' ? [p] : [];
    });

  const files = routeFiles(ROOT);

  it('finds the personal route files', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('only the list route (GET, summaries without prompt) may import the central resolver; nothing imports the manager service', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      expect(src, rel).not.toMatch(/skabeloner\/central['"]/);
      expect(src, rel).not.toMatch(/central-schemas/);
      if (rel !== 'route.ts') expect(src, rel).not.toMatch(/skabeloner\/resolve['"]/);
    }
  });

  it('the list route imports only listCentralForUser, never resolveCentralTemplate (the prompt-carrying read)', () => {
    const src = readFileSync(path.join(ROOT, 'route.ts'), 'utf8');
    expect(src).toMatch(/listCentralForUser/);
    expect(src).not.toMatch(/resolveCentralTemplate/);
  });
});
