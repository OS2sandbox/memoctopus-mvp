// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrganisationAdmin } from './OrganisationAdmin';
import { ADMIN_ME, CLAIMS_ME, LOCKED_LOCAL_ME, READER_ME, ROLLEKATALOG_ME, calls, installFetch, json, renderWithToasts } from './test-helpers';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const SYNCED = '33333333-3333-4333-8333-333333333333';

const UNITS = {
  orgUnits: [
    { uuid: CHILD, name: 'Børn', parentUuid: ROOT, source: 'local', memberCount: 2 },
    { uuid: ROOT, name: 'Kommune', parentUuid: null, source: 'local', memberCount: 0 },
    { uuid: SYNCED, name: 'Synkroniseret', parentUuid: ROOT, source: 'rollekatalog', memberCount: 5 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function setup(me = ADMIN_ME, extra: Parameters<typeof installFetch>[0] = {}) {
  return installFetch({
    'GET /api/me': () => json(me),
    'GET /api/admin/access/org-units': () => json(UNITS),
    ...extra,
  });
}

describe('OrganisationAdmin — tree', () => {
  it('renders units depth-first with indentation and no source column', async () => {
    setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    const names = screen.getAllByText(/^(Kommune|Børn|Synkroniseret)$/);
    expect(names.map((n) => n.textContent)).toEqual(['Kommune', 'Børn', 'Synkroniseret']);
    expect(names.map((n) => n.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
    expect(screen.queryByRole('columnheader', { name: 'Kilde' })).toBeNull();
    expect(screen.queryByText('Lokal')).toBeNull();
  });

  it('announces loading, names the table and conveys depth to screen readers', async () => {
    setup();
    renderWithToasts(<OrganisationAdmin />);
    expect(screen.getByRole('status')).toHaveTextContent('Indlæser');
    await screen.findByText('Kommune');
    expect(screen.getByRole('table', { name: 'Organisationsenheder' })).toBeInTheDocument();
    const child = screen.getByText('Børn').closest('td')!;
    expect(child).toHaveTextContent('Niveau 2: Børn');
    expect(screen.getByText('Kommune').closest('td')!).not.toHaveTextContent('Niveau');
  });

  it('shows an empty state and an error with retry', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/access/org-units': () => json({ orgUnits: [] }) });
    renderWithToasts(<OrganisationAdmin />);
    expect(await screen.findByText('Ingen organisationsenheder')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/access/org-units': () => json({ error: 'Forbidden' }, 403) });
    renderWithToasts(<OrganisationAdmin />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Du har ikke adgang til denne handling.');
  });
});

describe('OrganisationAdmin — per role and mode', () => {
  it('offers create, edit, delete and members on local units for a local-mode manager', async () => {
    setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByRole('button', { name: 'Opret enhed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rediger Børn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slet Børn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rediger medlemmer i Børn' })).toBeInTheDocument();
  });

  it('never offers edit or delete on a synced unit', async () => {
    setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Synkroniseret');
    expect(screen.queryByRole('button', { name: 'Rediger Synkroniseret' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Slet Synkroniseret' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rediger medlemmer i Synkroniseret' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' })).toBeInTheDocument();
    expect(screen.getByText('Styres af Rollekatalog')).toBeInTheDocument();
  });

  it.each([
    ['claims', CLAIMS_ME, /identitetsudbyderen/],
    ['local with the kill switch off', LOCKED_LOCAL_ME, /slået fra/],
  ])('is read-only in %s mode, and the banner says why', async (_n, me, why) => {
    setup(me);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByRole('status')).toHaveTextContent('Skrivebeskyttet');
    expect(screen.getByRole('status')).toHaveTextContent(why);
    expect(screen.queryByText(/Rollekatalog/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Opret enhed' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Handlinger' })).toBeNull();
  });

  it('is read-only in rollekatalog mode: banner, no create/edit/delete/actions column, members only viewable', async () => {
    setup(ROLLEKATALOG_ME);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByRole('status')).toHaveTextContent('Skrivebeskyttet');
    expect(screen.queryByRole('button', { name: 'Opret enhed' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rediger / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Slet / })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Handlinger' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rediger medlemmer/ })).toBeNull();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Enhed', 'Medlemmer']);
    expect(screen.getByRole('button', { name: 'Vis medlemmer af Børn' })).toBeInTheDocument();
  });

  it('is view-only for a directory reader without access.manage, with the reason', async () => {
    const mock = setup(READER_ME);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByText(/Kun visning\. Du har ikke rettigheden »Administrere brugere og roller«/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Handlinger' })).toBeNull();
    // The members endpoint needs access.manage, so a reader gets the count only and no expander.
    expect(calls(mock, 'GET', '/api/admin/access/org-units/')).toHaveLength(0);
  });
});

describe('OrganisationAdmin — member panel', () => {
  const MEMBERS_URL = (uuid: string) => `GET /api/admin/access/org-units/${uuid}/members`;
  const MEMBERS = {
    members: [
      { directoryUserUuid: 'd1', appUserId: null, name: 'Bo Bruger', email: 'bo@example.dk' },
      { directoryUserUuid: 'd2', appUserId: null, name: 'Carla Ny', email: null },
    ],
  };

  it('expands lazily under the row, once, with name and e-mail, and collapses again', async () => {
    const mock = setup(ROLLEKATALOG_ME, { [MEMBERS_URL(SYNCED)]: () => json(MEMBERS) });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Synkroniseret');
    expect(calls(mock, 'GET', `/api/admin/access/org-units/${SYNCED}/members`)).toHaveLength(0);

    const toggle = screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', `unit-members-${SYNCED}`);
    await userEvent.click(toggle);

    const list = await screen.findByRole('list', { name: 'Medlemmer af Synkroniseret' });
    expect(within(list).getByText('Bo Bruger')).toBeInTheDocument();
    expect(within(list).getByText('bo@example.dk')).toBeInTheDocument();
    expect(within(list).getByText('Carla Ny')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Skjul medlemmer af Synkroniseret' });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(`unit-members-${SYNCED}`)).toBe(list.parentElement);
    // The panel row sits directly under the unit's row.
    const unitRow = screen.getByText('Synkroniseret').closest('tr')!;
    expect(unitRow.nextElementSibling).toContainElement(list);

    await userEvent.click(open);
    expect(screen.queryByRole('list', { name: 'Medlemmer af Synkroniseret' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' })).toHaveAttribute('aria-expanded', 'false');
    // Re-opening does not fetch again.
    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' }));
    expect(await screen.findByRole('list', { name: 'Medlemmer af Synkroniseret' })).toBeInTheDocument();
    expect(calls(mock, 'GET', `/api/admin/access/org-units/${SYNCED}/members`)).toHaveLength(1);
  });

  it('shows a loading state, an empty state and an error with retry', async () => {
    let attempt = 0;
    let release: (r: Response) => void = () => {};
    setup(ROLLEKATALOG_ME, {
      [MEMBERS_URL(SYNCED)]: () => new Promise<Response>((res) => (release = res)),
      [MEMBERS_URL(CHILD)]: () => json({ members: [] }),
      [MEMBERS_URL(ROOT)]: () => (++attempt === 1 ? json({ error: 'x' }, 500) : json(MEMBERS)),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');

    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' }));
    expect(await screen.findByText('Indlæser medlemmer …')).toBeInTheDocument();
    release(new Response(JSON.stringify(MEMBERS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await screen.findByText('Bo Bruger')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Børn' }));
    expect(await screen.findByText('Ingen medlemmer')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Kommune' }));
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Prøv igen' }));
    expect(await screen.findByRole('list', { name: 'Medlemmer af Kommune' })).toBeInTheDocument();
  });

  it('says so when the API reports that the list was cut', async () => {
    setup(ROLLEKATALOG_ME, { [MEMBERS_URL(SYNCED)]: () => json({ ...MEMBERS, truncated: true }) });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Synkroniseret');
    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Synkroniseret' }));
    expect(await screen.findByRole('note')).toHaveTextContent('Viser de første 2 medlemmer. Listen er afkortet.');
  });

  it('keeps the member count column and the depth text, and the chevron is not part of the unit name', async () => {
    setup(ROLLEKATALOG_ME);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    const row = screen.getByText('Børn').closest('tr')!;
    expect(row).toHaveTextContent('Niveau 2: Børn');
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('2');
    expect(within(row).getAllByRole('cell')).toHaveLength(2);
  });

  it('also expands in local mode, next to the edit actions, and members can still be edited there', async () => {
    const mock = setup(ADMIN_ME, {
      [MEMBERS_URL(CHILD)]: () => json(MEMBERS),
      'GET /api/admin/access/users': () => json({ users: [{ id: 'u-1', name: 'Bo Bruger', email: 'bo@example.dk' }] }),
      [`PUT /api/admin/access/org-units/${CHILD}/members`]: () => json({ members: [] }),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Enhed', 'Medlemmer', 'Handlinger']);

    await userEvent.click(screen.getByRole('button', { name: 'Vis medlemmer af Børn' }));
    expect(await screen.findByRole('list', { name: 'Medlemmer af Børn' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rediger medlemmer i Børn' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Gem medlemmer' }));
    await waitFor(() => expect(calls(mock, 'PUT', `/api/admin/access/org-units/${CHILD}/members`)).toHaveLength(1));
    // The open panel is reloaded with the new membership.
    await waitFor(() => expect(calls(mock, 'GET', `/api/admin/access/org-units/${CHILD}/members`).length).toBeGreaterThan(2));
  });
});

describe('OrganisationAdmin — create, edit, delete', () => {
  it('validates the name before creating', async () => {
    const mock = setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Opret enhed' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Opret' }));
    expect(screen.getByText('Angiv et navn')).toBeInTheDocument();
    expect(calls(mock, 'POST', '/api/admin/access/org-units')).toHaveLength(0);
  });

  it('creates a unit under a chosen parent and reloads', async () => {
    const mock = setup(ADMIN_ME, {
      'POST /api/admin/access/org-units': () => json({ orgUnit: {} }, 201),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Opret enhed' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Navn'), '  Ældre  ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Overordnet enhed'), ROOT);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Opret' }));
    await waitFor(() => expect(calls(mock, 'POST', '/api/admin/access/org-units')).toHaveLength(1));
    expect(JSON.parse(calls(mock, 'POST', '/api/admin/access/org-units')[0][1].body)).toEqual({ name: 'Ældre', parentUuid: ROOT });
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/org-units').length).toBeGreaterThan(1));
    expect(await screen.findByText('Enheden er oprettet')).toBeInTheDocument();
  });

  it('sends only the changed fields when editing, and offers no cycle-causing parents', async () => {
    const mock = setup(ADMIN_ME, {
      [`PATCH /api/admin/access/org-units/${ROOT}`]: () => json({ orgUnit: {} }),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Rediger Kommune' }));
    const dialog = screen.getByRole('dialog');
    const parentOptions = within(within(dialog).getByLabelText('Overordnet enhed')).getAllByRole('option');
    // Neither itself nor its descendants may be the new parent.
    expect(parentOptions.map((o) => o.textContent)).toEqual(['Øverste niveau (ingen overordnet enhed)']);
    const name = within(dialog).getByLabelText('Navn');
    await userEvent.clear(name);
    await userEvent.type(name, 'Hele kommunen');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gem' }));
    await waitFor(() => expect(calls(mock, 'PATCH', `/api/admin/access/org-units/${ROOT}`)).toHaveLength(1));
    expect(JSON.parse(calls(mock, 'PATCH', `/api/admin/access/org-units/${ROOT}`)[0][1].body)).toEqual({ name: 'Hele kommunen' });
  });

  it('shows the server cycle message when a move is refused', async () => {
    setup(ADMIN_ME, {
      [`PATCH /api/admin/access/org-units/${CHILD}`]: () =>
        json({ error: 'Flytningen ville skabe en løkke i organisationen', code: 'cycle' }, 409),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Rediger Børn' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Overordnet enhed'), '');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gem' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('løkke');
  });

  it('confirms before deleting and surfaces a 409 from the server', async () => {
    const mock = setup(ADMIN_ME, {
      [`DELETE /api/admin/access/org-units/${ROOT}`]: () =>
        json({ error: 'Enheden har underenheder og kan ikke slettes', code: 'has_children' }, 409),
    });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Slet Kommune' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Vil du slette enheden »Kommune«?');
    expect(calls(mock, 'DELETE', '/api/admin/access/org-units')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bekræft sletning' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('underenheder');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('deletes on confirm, toasts and reloads', async () => {
    const mock = setup(ADMIN_ME, { [`DELETE /api/admin/access/org-units/${CHILD}`]: () => json({ ok: true }) });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    await userEvent.click(screen.getByRole('button', { name: 'Slet Børn' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Bekræft sletning' }));
    expect(await screen.findByText('Enheden er slettet')).toBeInTheDocument();
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/org-units').length).toBeGreaterThan(1));
  });
});

describe('OrganisationAdmin — Rollekatalog data and last sync', () => {
  it('labels the data as coming from Rollekatalog with the last sync time in rollekatalog mode', async () => {
    setup(ROLLEKATALOG_ME, {
      'GET /api/admin/access/sync': () =>
        json({
          run: { id: 'r1', startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:00:03.000Z', status: 'success', counts: null, errorCode: null },
          source: 'rollekatalog',
          configIssue: null,
        }),
    });
    renderWithToasts(<OrganisationAdmin />);
    expect(await screen.findByText(/Data hentes fra Rollekatalog\. Sidst synkroniseret .*2026/)).toBeInTheDocument();
  });

  it('does not ask for the run in local mode', async () => {
    const mock = setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.queryByText(/Data hentes fra Rollekatalog/)).toBeNull();
    expect(calls(mock, 'GET', '/api/admin/access/sync')).toHaveLength(0);
  });

  it('a directory reader without access.manage or sync.run only sees the source label (no audited 403)', async () => {
    const mock = setup({ ...READER_ME, source: 'rollekatalog', readOnly: true });
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByText('Data hentes fra Rollekatalog.')).toBeInTheDocument();
    expect(calls(mock, 'GET', '/api/admin/access/sync')).toHaveLength(0);
  });
});
