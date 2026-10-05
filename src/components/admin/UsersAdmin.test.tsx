// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersAdmin } from './UsersAdmin';
import { ADMIN_ME, READER_ME, ROLLEKATALOG_ME, calls, installFetch, json, renderWithToasts } from './test-helpers';

const UNIT = '11111111-1111-4111-8111-111111111111';

const assignment = (over: Record<string, unknown> = {}) => ({
  id: 'a-1',
  roleKey: 'tt-skabelonansvarlig',
  scopeOrgUnitUuid: UNIT,
  scopeOrgUnitName: 'Børn',
  includeDescendants: true,
  startDate: null,
  stopDate: null,
  source: 'local',
  active: true,
  ...over,
});

const USERS = {
  users: [
    {
      id: 'u-1',
      name: 'Bo Bruger',
      email: 'bo@example.dk',
      directoryUserUuid: null,
      disabled: false,
      roles: [assignment(), assignment({ id: 'a-2', roleKey: 'tt-logleser', scopeOrgUnitUuid: null, scopeOrgUnitName: null, source: 'rollekatalog' })],
    },
    { id: 'u-2', name: 'Carla Ny', email: 'carla@example.dk', directoryUserUuid: null, disabled: false, roles: [] },
    { id: 'u-3', name: 'Dan Deaktiv', email: 'dan@example.dk', directoryUserUuid: 'x', disabled: true, roles: [] },
  ],
};
const UNITS = { orgUnits: [{ uuid: UNIT, name: 'Børn', parentUuid: null, source: 'local', memberCount: 1 }] };

afterEach(() => vi.unstubAllGlobals());

function setup(me = ADMIN_ME, extra: Parameters<typeof installFetch>[0] = {}) {
  return installFetch({
    'GET /api/me': () => json(me),
    'GET /api/admin/access/users': () => json(USERS),
    'GET /api/admin/access/org-units': () => json(UNITS),
    ...extra,
  });
}

describe('UsersAdmin — rendering', () => {
  it('lists users with Danish role labels, scope wording and source badges', async () => {
    setup();
    renderWithToasts(<UsersAdmin />);
    const row = (await screen.findByText('Bo Bruger')).closest('tr')!;
    expect(within(row).getByText('Skabelonansvarlig')).toBeInTheDocument();
    expect(within(row).getByText('Børn – Denne enhed og alle underenheder')).toBeInTheDocument();
    expect(within(row).getByText('Logleser')).toBeInTheDocument();
    expect(within(row).getByText('Hele organisationen')).toBeInTheDocument();
    expect(within(row).getByText('Lokal')).toBeInTheDocument();
    expect(within(row).getByText('Rollekatalog')).toBeInTheDocument();
    const carla = screen.getByText('Carla Ny').closest('tr')!;
    expect(within(carla).getByText('Ingen roller (standardrettighed)')).toBeInTheDocument();
    expect(screen.getByText('Deaktiveret')).toBeInTheDocument();
  });

  it('flags an expired assignment', async () => {
    setup(ADMIN_ME, {
      'GET /api/admin/access/users': () =>
        json({
          users: [
            {
              ...USERS.users[1],
              roles: [assignment({ active: false, stopDate: '2020-01-01T00:00:00.000Z' })],
            },
          ],
        }),
    });
    renderWithToasts(<UsersAdmin />);
    expect(await screen.findByText('Udløbet')).toBeInTheDocument();
  });

  it('words the exclusive end date as "indtil", not "til" (the grant is over when that day begins)', async () => {
    setup(ADMIN_ME, {
      'GET /api/admin/access/users': () =>
        json({ users: [{ ...USERS.users[1], roles: [assignment({ stopDate: '2099-12-31T00:00:00.000Z' })] }] }),
    });
    renderWithToasts(<UsersAdmin />);
    expect(await screen.findByText(/indtil 2099-12-31/)).toBeInTheDocument();
    expect(screen.queryByText(/ til 2099-12-31/)).toBeNull();
  });

  it('shows an empty state', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/access/users': () => json({ users: [] }) });
    renderWithToasts(<UsersAdmin />);
    expect(await screen.findByText('Ingen brugere fundet')).toBeInTheDocument();
  });

  it('shows an error with retry when the user list fails', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/access/users': () => json({ error: 'x' }, 500) });
    renderWithToasts(<UsersAdmin />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Noget gik galt');
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
  });

  it('searches via the q parameter', async () => {
    const mock = setup();
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    await userEvent.type(screen.getByLabelText('Søg i brugere'), 'carla');
    await userEvent.click(screen.getByRole('button', { name: 'Søg' }));
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/users?q=carla')).toHaveLength(1));
  });
});

describe('UsersAdmin — write controls by mode and role', () => {
  it('shows grant and revoke controls to a local-mode access manager, only on local rows', async () => {
    setup();
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    expect(screen.getByRole('button', { name: 'Tildel rolle til Bo Bruger' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fjern Skabelonansvarlig fra Bo Bruger' })).toBeInTheDocument();
    // The synced (rollekatalog) row is never editable here.
    expect(screen.queryByRole('button', { name: 'Fjern Logleser fra Bo Bruger' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tildel rolle til Dan Deaktiv' })).toBeDisabled();
  });

  it('hides every write control and shows the banner in rollekatalog mode', async () => {
    setup(ROLLEKATALOG_ME);
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    expect(screen.getByRole('status')).toHaveTextContent('Skrivebeskyttet');
    expect(screen.queryByRole('button', { name: /Tildel rolle/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Fjern/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Handlinger' })).toBeNull();
  });

  it('hides write controls and explains why for a viewer without access.manage', async () => {
    setup(READER_ME);
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    expect(screen.queryByRole('button', { name: /Tildel rolle/ })).toBeNull();
    expect(screen.getByText(/Du har ikke rettigheden »Administrere brugere og roller«/)).toBeInTheDocument();
  });

  it('shows no write controls while /api/me is still unknown', async () => {
    setup(ADMIN_ME, { 'GET /api/me': () => json({ error: 'x' }, 403) });
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    expect(screen.queryByRole('button', { name: /Tildel rolle/ })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Kunne ikke hente dine rettigheder.');
  });
});

describe('UsersAdmin — grant dialog', () => {
  it('opens for the chosen user and reloads the list after granting', async () => {
    let created = false;
    const mock = setup(ADMIN_ME, {
      'POST /api/admin/access/assignments': () => {
        created = true;
        return json({ assignment: assignment() }, 201);
      },
    });
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Carla Ny');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle til Carla Ny' }));
    expect(await screen.findByText('Tildel en rolle til Carla Ny.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'tt-bruger');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tildel rolle' }));
    await waitFor(() => expect(created).toBe(true));
    const body = JSON.parse(calls(mock, 'POST', '/api/admin/access/assignments')[0][1].body);
    expect(body).toMatchObject({ appUserId: 'u-2', roleKey: 'tt-bruger' });
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/users').length).toBeGreaterThan(1));
  });
});

describe('UsersAdmin — revoke', () => {
  async function openRevoke() {
    renderWithToasts(<UsersAdmin />);
    await screen.findByText('Bo Bruger');
    await userEvent.click(screen.getByRole('button', { name: 'Fjern Skabelonansvarlig fra Bo Bruger' }));
    return screen.findByRole('dialog');
  }

  it('asks for confirmation and does not delete before confirming', async () => {
    const mock = setup();
    const dialog = await openRevoke();
    expect(dialog).toHaveTextContent('Vil du fjerne rollen »Skabelonansvarlig« fra Bo Bruger?');
    expect(calls(mock, 'DELETE', '/api/admin/access/assignments')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annuller' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(mock, 'DELETE', '/api/admin/access/assignments')).toHaveLength(0);
  });

  it('deletes the assignment on confirm, toasts and reloads', async () => {
    const mock = setup(ADMIN_ME, { 'DELETE /api/admin/access/assignments/a-1': () => json({ ok: true }) });
    const dialog = await openRevoke();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bekræft fjernelse' }));
    await waitFor(() => expect(calls(mock, 'DELETE', '/api/admin/access/assignments/a-1')).toHaveLength(1));
    expect(await screen.findByText(/er fjernet fra Bo Bruger/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/users').length).toBeGreaterThan(1));
  });

  it('shows the server message for the last-administrator guard and keeps the dialog open', async () => {
    setup(ADMIN_ME, {
      'DELETE /api/admin/access/assignments/a-1': () =>
        json({ error: 'Den sidste administrator kan ikke fjernes', code: 'last_admin' }, 409),
    });
    const dialog = await openRevoke();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bekræft fjernelse' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Den sidste administrator kan ikke fjernes');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the read-only 409 message if the mode flipped under the page', async () => {
    setup(ADMIN_ME, {
      'DELETE /api/admin/access/assignments/a-1': () =>
        json({ error: 'Skrivebeskyttet: roller og organisation styres af Rollekatalog', code: 'read_only' }, 409),
    });
    const dialog = await openRevoke();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bekræft fjernelse' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Skrivebeskyttet');
  });
});
