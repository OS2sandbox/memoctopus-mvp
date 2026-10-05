// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AdminOverview } from './AdminOverview';
import type { MeResponse } from '@/lib/authz/me';

const me = (over: Partial<MeResponse> = {}): MeResponse => ({
  user: { id: 'u1', name: 'Anne Admin', email: 'anne@example.dk' },
  roles: ['tt-bruger'],
  capabilities: ['template.use'],
  scopes: {},
  source: 'local',
  readOnly: false,
  ...over,
});

const UNIT = '11111111-1111-4111-8111-111111111111';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

let routes: Record<string, () => Promise<Response>>;
const fetchMock = vi.fn((url: string) => (routes[url] ?? (() => json({}, 404)))());

beforeEach(() => {
  fetchMock.mockClear();
  routes = {};
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('AdminOverview', () => {
  it('shows who you are with the Lokal source badge and Danish role labels', async () => {
    routes['/api/me'] = () =>
      json(
        me({
          roles: ['tt-bruger', 'tt-administrator'],
          capabilities: ['template.use', 'access.manage'],
        }),
      );
    routes['/api/admin/access/org-units'] = () => json({ orgUnits: [] });
    render(<AdminOverview />);
    expect(await screen.findByText('Anne Admin')).toBeInTheDocument();
    expect(screen.getByText('anne@example.dk')).toBeInTheDocument();
    expect(screen.getByText('Lokal')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    expect(screen.getByText('Bruger')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the Rollekatalog badge and the read-only banner in rollekatalog mode', async () => {
    routes['/api/me'] = () => json(me({ source: 'rollekatalog', readOnly: true }));
    render(<AdminOverview />);
    expect(await screen.findByText('Rollekatalog')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Skrivebeskyttet');
  });

  it('describes global and subtree scope, resolving unit names', async () => {
    routes['/api/me'] = () =>
      json(
        me({
          roles: ['tt-skabelonansvarlig', 'tt-logleser'],
          capabilities: ['template.use', 'template.manage', 'directory.read', 'audit.read'],
          scopes: {
            'template.manage': { global: false, roots: [{ orgUnitUuid: UNIT, includeDescendants: true }] },
            'directory.read': { global: false, roots: [{ orgUnitUuid: UNIT, includeDescendants: true }] },
            'audit.read': { global: true, roots: [] },
          },
        }),
      );
    routes['/api/admin/access/org-units'] = () =>
      json({ orgUnits: [{ uuid: UNIT, name: 'Børn og Unge', parentUuid: null, source: 'local', memberCount: 0 }] });
    render(<AdminOverview />);
    const row = (await screen.findByText('Administrere skabeloner')).closest('tr')!;
    await waitFor(() => expect(within(row).getByText('Børn og Unge (inkl. underenheder)')).toBeInTheDocument());
    const auditRow = screen.getByText('Læse loggen').closest('tr')!;
    expect(within(auditRow).getByText('Hele organisationen')).toBeInTheDocument();
    const useRow = screen.getByText('Bruge skabeloner').closest('tr')!;
    expect(within(useRow).getByText('Hele løsningen')).toBeInTheDocument();
  });

  it('says "Ingen enheder" for a scoped capability without roots (fail closed)', async () => {
    routes['/api/me'] = () =>
      json(
        me({
          roles: ['tt-skabelonansvarlig'],
          capabilities: ['template.use', 'template.manage'],
          scopes: { 'template.manage': { global: false, roots: [] } },
        }),
      );
    render(<AdminOverview />);
    const row = (await screen.findByText('Administrere skabeloner')).closest('tr')!;
    expect(within(row).getByText('Ingen enheder')).toBeInTheDocument();
  });

  it('does not ask for unit names without a directory right', async () => {
    routes['/api/me'] = () => json(me());
    render(<AdminOverview />);
    await screen.findByText('Anne Admin');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/me']);
  });

  it('shows an error with retry when /api/me fails', async () => {
    routes['/api/me'] = () => json({ error: 'Forbidden' }, 403);
    render(<AdminOverview />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Kunne ikke hente dine rettigheder.');
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
  });

  describe('sync status panel', () => {
    const SYNC_RUN = {
      run: {
        id: 'r1',
        startedAt: '2026-10-05T10:00:00.000Z',
        finishedAt: '2026-10-05T10:00:03.000Z',
        status: 'success',
        counts: { usersUpserted: 7 },
        errorCode: null,
      },
      source: 'rollekatalog',
      configIssue: null,
    };

    it('is shown to a sync.run holder in rollekatalog mode, with the last run and the buttons', async () => {
      routes['/api/me'] = () => json(me({ source: 'rollekatalog', readOnly: true, capabilities: ['template.use', 'sync.run'] }));
      routes['/api/admin/access/sync'] = () => json(SYNC_RUN);
      render(<AdminOverview />);
      expect(await screen.findByRole('heading', { name: 'Synkronisering med Rollekatalog' })).toBeInTheDocument();
      expect(await screen.findByText('Gennemført')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Synkroniser nu' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Test forbindelse' })).toBeInTheDocument();
    });

    it('in local mode a sync.run holder gets only Test forbindelse, and no sync data is fetched', async () => {
      routes['/api/me'] = () => json(me({ capabilities: ['template.use', 'sync.run'] }));
      render(<AdminOverview />);
      await screen.findByText('Anne Admin');
      expect(screen.queryByRole('heading', { name: 'Synkronisering med Rollekatalog' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Test forbindelse' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Synkroniser nu' })).toBeNull();
      expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('/api/admin/access/sync');
    });

    it('is hidden for a viewer without sync.run in rollekatalog mode', async () => {
      routes['/api/me'] = () => json(me({ source: 'rollekatalog', readOnly: true, capabilities: ['template.use', 'access.manage'] }));
      routes['/api/admin/access/org-units'] = () => json({ orgUnits: [] });
      render(<AdminOverview />);
      await screen.findByText('Anne Admin');
      expect(screen.queryByRole('button', { name: 'Synkroniser nu' })).toBeNull();
      expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('/api/admin/access/sync');
    });
  });
});
