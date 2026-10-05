// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLog } from './AuditLog';
import { ADMIN_ME, READER_ME, calls, installFetch, json } from './test-helpers';

afterEach(() => vi.unstubAllGlobals());

const ENTITY = '11111111-1111-4111-8111-111111111111';

const ev = (over: Record<string, unknown> = {}) => ({
  id: '10',
  occurredAt: '2026-10-05T09:30:00.000Z',
  source: 'server',
  eventType: 'export.download',
  outcome: 'success',
  actorUserId: 'user-1',
  actorName: 'Anne Admin',
  actorOrgUnitUuid: null,
  entityType: 'meeting',
  entityId: ENTITY,
  secondaryEntityType: null,
  secondaryEntityId: null,
  requestId: 'req-1',
  details: { format: 'pdf' },
  clientOccurredAt: null,
  ...over,
});

const LOG_READER_ME = {
  ...READER_ME,
  roles: ['tt-bruger', 'tt-logleser'] as typeof ADMIN_ME.roles,
  capabilities: ['template.use', 'audit.read', 'directory.read'] as typeof ADMIN_ME.capabilities,
  scopes: { 'audit.read': { global: false, roots: [] } },
};

function setup(me = ADMIN_ME, list: Parameters<typeof installFetch>[0]['GET /x'] = () => json({ events: [ev()], nextCursor: null })) {
  return installFetch({ 'GET /api/me': () => json(me), 'GET /api/admin/audit': list });
}

const auditCalls = (m: ReturnType<typeof vi.fn>) => calls(m, 'GET', '/api/admin/audit');
const lastParams = (m: ReturnType<typeof vi.fn>) => new URL(`http://x${auditCalls(m).at(-1)![0]}`).searchParams;

describe('AuditLog', () => {
  it('shows events with Danish labels, outcome, actor, object and details', async () => {
    setup();
    render(<AuditLog />);
    const row = (await screen.findByText('Anne Admin')).closest('tr')!;
    expect(within(row).getByText('Eksport hentet')).toBeInTheDocument();
    expect(within(row).getByText('Gennemført')).toBeInTheDocument();
    expect(within(row).getByText(ENTITY)).toBeInTheDocument();
    expect(within(row).getByText('format: pdf')).toBeInTheDocument();
    expect(within(row).getByText('server')).toBeInTheDocument();
  });

  it('marks client events as selvrapporteret', async () => {
    setup(ADMIN_ME, () => json({ events: [ev({ source: 'client', eventType: 'meeting.delete' })], nextCursor: null }));
    render(<AuditLog />);
    // The label also exists as a filter option, so find the row through the actor.
    const row = (await screen.findByText('Anne Admin')).closest('tr')!;
    expect(within(row).getByText('Møde slettet')).toBeInTheDocument();
    expect(within(row).getByText('selvrapporteret')).toBeInTheDocument();
  });

  it('shows the IP column only when the API returned addresses', async () => {
    setup(ADMIN_ME, () => json({ events: [ev({ ipAddress: '10.0.0.7' })], nextCursor: null }));
    const { unmount } = render(<AuditLog />);
    expect(await screen.findByText('10.0.0.7')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'IP-adresse' })).toBeInTheDocument();
    unmount();

    setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    expect(screen.queryByRole('columnheader', { name: 'IP-adresse' })).toBeNull();
  });

  it('shows an empty state', async () => {
    setup(ADMIN_ME, () => json({ events: [], nextCursor: null }));
    render(<AuditLog />);
    expect(await screen.findByText('Ingen hændelser fundet')).toBeInTheDocument();
  });

  it('shows an error banner with retry when loading fails', async () => {
    let fail = true;
    const m = setup(ADMIN_ME, () => (fail ? json({ error: 'x' }, 500) : json({ events: [ev()], nextCursor: null })));
    render(<AuditLog />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Noget gik galt');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Prøv igen' }));
    expect(await screen.findByText('Anne Admin')).toBeInTheDocument();
    expect(auditCalls(m)).toHaveLength(2);
  });

  it('loads more with the cursor and appends', async () => {
    const m = setup(ADMIN_ME, (url) =>
      url.includes('cursor=10')
        ? json({ events: [ev({ id: '9', actorName: 'Bo Bruger' })], nextCursor: null })
        : json({ events: [ev()], nextCursor: '10' }),
    );
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    await userEvent.click(screen.getByRole('button', { name: 'Indlæs flere' }));
    expect(await screen.findByText('Bo Bruger')).toBeInTheDocument();
    expect(screen.getByText('Anne Admin')).toBeInTheDocument();
    expect(lastParams(m).get('cursor')).toBe('10');
    expect(screen.queryByRole('button', { name: 'Indlæs flere' })).toBeNull();
  });

  it('sends the chosen filters to the API', async () => {
    const m = setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    await userEvent.selectOptions(screen.getByLabelText('Hændelse'), 'meeting.delete');
    await userEvent.selectOptions(screen.getByLabelText('Resultat'), 'denied');
    await userEvent.selectOptions(screen.getByLabelText('Kilde'), 'client');
    await userEvent.type(screen.getByLabelText('Bruger-id'), 'user-9');
    await userEvent.type(screen.getByLabelText('Objekt-id'), ENTITY.toUpperCase());
    await userEvent.type(screen.getByLabelText('Fra dato'), '2026-10-01');
    await userEvent.type(screen.getByLabelText('Til dato'), '2026-10-05');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrér' }));
    await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
    const p = lastParams(m);
    expect(p.getAll('eventType')).toEqual(['meeting.delete']);
    expect(p.get('outcome')).toBe('denied');
    expect(p.get('source')).toBe('client');
    expect(p.get('actorUserId')).toBe('user-9');
    expect(p.get('entityId')).toBe(ENTITY);
    expect(new Date(p.get('from')!).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
    expect(new Date(p.get('to')!).getTime()).toBe(new Date('2026-10-05T23:59:59.999').getTime());
  });

  it('rejects a malformed object id without calling the API', async () => {
    const m = setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    await userEvent.type(screen.getByLabelText('Objekt-id'), 'not-a-uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrér' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('gyldigt id');
    expect(auditCalls(m)).toHaveLength(1);
  });

  it('rejects a reversed date range without calling the API', async () => {
    const m = setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    await userEvent.type(screen.getByLabelText('Fra dato'), '2026-10-05');
    await userEvent.type(screen.getByLabelText('Til dato'), '2026-10-01');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrér' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fra-datoen');
    expect(auditCalls(m)).toHaveLength(1);
  });

  it('offers CSV export (carrying the applied filters) only with audit.export', async () => {
    setup();
    const { unmount } = render(<AuditLog />);
    const link = await screen.findByRole('link', { name: 'Eksportér som CSV' });
    expect(link.getAttribute('href')).toMatch(/^\/api\/admin\/audit\/export\?/);
    unmount();

    setup(LOG_READER_ME);
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    expect(screen.queryByRole('link', { name: 'Eksportér som CSV' })).toBeNull();
  });

  it('tells a scoped reader that they only see their own units', async () => {
    setup(LOG_READER_ME);
    render(<AuditLog />);
    expect(await screen.findByText(/kun hændelser fra de enheder/)).toBeInTheDocument();
  });

  it('does not show that notice to a global reader', async () => {
    setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin');
    expect(screen.queryByText(/kun hændelser fra de enheder/)).toBeNull();
  });

  it('explains that self-reported events are not confirmed by the server', async () => {
    setup();
    render(<AuditLog />);
    expect(await screen.findByText(/selvrapporteret.*indberettet af brugerens egen browser/)).toBeInTheDocument();
  });

  it('ignores a slow old response that arrives after a newer filter', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let n = 0;
    setup(ADMIN_ME, () => {
      n += 1;
      if (n === 1) return new Promise<Response>((r) => (releaseFirst = r));
      return json({ events: [ev({ id: '2', actorName: 'Ny Filter' })], nextCursor: null });
    });
    render(<AuditLog />);
    await userEvent.selectOptions(await screen.findByLabelText('Resultat'), 'error');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrér' }));
    await screen.findByText('Ny Filter');
    releaseFirst(new Response(JSON.stringify({ events: [ev({ actorName: 'Gammel' })], nextCursor: null }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Gammel')).toBeNull();
    expect(screen.getByText('Ny Filter')).toBeInTheDocument();
  });
});
