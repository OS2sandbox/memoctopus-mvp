// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgUnitMembersDialog } from './OrgUnitMembersDialog';
import { calls, installFetch, json, renderWithToasts } from './test-helpers';

const UNIT = { uuid: '11111111-1111-4111-8111-111111111111', name: 'Børn' };
const MEMBERS = {
  members: [
    { directoryUserUuid: 'd1', appUserId: 'u-1', name: 'Bo Bruger' },
    { directoryUserUuid: 'd9', appUserId: null, name: 'Synk Person' },
  ],
};
const USERS = {
  users: [
    { id: 'u-1', name: 'Bo Bruger', email: 'bo@example.dk' },
    { id: 'u-2', name: 'Carla Ny', email: 'carla@example.dk' },
  ],
};
const onSaved = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  onSaved.mockReset();
  onOpenChange.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function setup(extra: Parameters<typeof installFetch>[0] = {}) {
  const mock = installFetch({
    [`GET /api/admin/access/org-units/${UNIT.uuid}/members`]: () => json(MEMBERS),
    'GET /api/admin/access/users': () => json(USERS),
    ...extra,
  });
  renderWithToasts(<OrgUnitMembersDialog open onOpenChange={onOpenChange} unit={UNIT} onSaved={onSaved} />);
  return mock;
}

describe('OrgUnitMembersDialog', () => {
  it('pre-selects current members and warns about unlinked ones that will be dropped', async () => {
    setup();
    expect(await screen.findByLabelText(/Bo Bruger/)).toBeChecked();
    expect(screen.getByLabelText(/Carla Ny/)).not.toBeChecked();
    expect(screen.getByRole('note')).toHaveTextContent('1 medlem er ikke knyttet til en bruger og fjernes');
  });

  it('filters on the server with q (so users beyond the first page can be found)', async () => {
    const mock = setup({
      'GET /api/admin/access/users': (url) =>
        json(url.includes('q=carla') ? { users: [USERS.users[1]] } : USERS),
    });
    await screen.findByLabelText(/Bo Bruger/);
    await userEvent.type(screen.getByLabelText('Filtrer brugere'), 'carla');
    await waitFor(() => expect(screen.queryByLabelText(/Bo Bruger/)).toBeNull());
    expect(screen.getByLabelText(/Carla Ny/)).toBeInTheDocument();
    expect(calls(mock, 'GET', '/api/admin/access/users').some(([u]) => String(u).includes('q=carla'))).toBe(true);
  });

  it('tells the admin when the user list was cut off', async () => {
    setup({ 'GET /api/admin/access/users': () => json({ ...USERS, truncated: true }) });
    expect(await screen.findByText('Viser de første 2. Brug søgefeltet for at finde flere.')).toBeInTheDocument();
  });

  it('shows no cut-off notice when every user was returned', async () => {
    setup();
    await screen.findByLabelText(/Bo Bruger/);
    expect(screen.queryByText(/Viser de første/)).toBeNull();
  });

  it('does not send a request per keystroke', async () => {
    const mock = setup();
    await screen.findByLabelText(/Bo Bruger/);
    const before = calls(mock, 'GET', '/api/admin/access/users').length;
    await userEvent.type(screen.getByLabelText('Filtrer brugere'), 'carla');
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/access/users').length).toBe(before + 1));
  });

  it('puts the whole selection in one PUT, even members hidden by the filter', async () => {
    const mock = setup({
      'GET /api/admin/access/users': (url) =>
        json(url.includes('q=carla') ? { users: [USERS.users[1]] } : USERS),
      [`PUT /api/admin/access/org-units/${UNIT.uuid}/members`]: () => json({ members: [] }),
    });
    await screen.findByLabelText(/Bo Bruger/);
    await userEvent.type(screen.getByLabelText('Filtrer brugere'), 'carla');
    await waitFor(() => expect(screen.queryByLabelText(/Bo Bruger/)).toBeNull());
    await userEvent.click(screen.getByLabelText(/Carla Ny/));
    await userEvent.click(screen.getByRole('button', { name: 'Gem medlemmer' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = JSON.parse(calls(mock, 'PUT', `/api/admin/access/org-units/${UNIT.uuid}/members`)[0][1].body);
    expect(body.appUserIds.sort()).toEqual(['u-1', 'u-2']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the server message when saving fails', async () => {
    setup({
      [`PUT /api/admin/access/org-units/${UNIT.uuid}/members`]: () =>
        json({ error: 'Enheden styres af Rollekatalog og kan ikke ændres her', code: 'not_local' }, 409),
    });
    await screen.findByLabelText(/Bo Bruger/);
    await userEvent.click(screen.getByRole('button', { name: 'Gem medlemmer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('styres af Rollekatalog');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a load error', async () => {
    installFetch({ [`GET /api/admin/access/org-units/${UNIT.uuid}/members`]: () => json({ error: 'x' }, 404) });
    renderWithToasts(<OrgUnitMembersDialog open onOpenChange={onOpenChange} unit={UNIT} onSaved={onSaved} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Ikke fundet.')).toBeInTheDocument();
  });
});
