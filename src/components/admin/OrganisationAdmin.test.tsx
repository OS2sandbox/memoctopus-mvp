// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrganisationAdmin } from './OrganisationAdmin';
import { ADMIN_ME, READER_ME, ROLLEKATALOG_ME, calls, installFetch, json, renderWithToasts } from './test-helpers';

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
  it('renders units depth-first with indentation and source badges', async () => {
    setup();
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    const names = screen.getAllByText(/^(Kommune|Børn|Synkroniseret)$/);
    expect(names.map((n) => n.textContent)).toEqual(['Kommune', 'Børn', 'Synkroniseret']);
    expect(names.map((n) => n.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
    expect(screen.getAllByText('Lokal')).toHaveLength(2);
    expect(screen.getByText('Rollekatalog')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Vis medlemmer i Synkroniseret' })).toBeInTheDocument();
    expect(screen.getByText('Styres af Rollekatalog')).toBeInTheDocument();
  });

  it('is read-only in rollekatalog mode: banner, no create/edit/delete, members only viewable', async () => {
    setup(ROLLEKATALOG_ME);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByRole('status')).toHaveTextContent('Skrivebeskyttet');
    expect(screen.queryByRole('button', { name: 'Opret enhed' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rediger / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Slet / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Vis medlemmer i Børn' })).toBeInTheDocument();
  });

  it('is view-only for a directory reader without access.manage, with the reason', async () => {
    setup(READER_ME);
    renderWithToasts(<OrganisationAdmin />);
    await screen.findByText('Kommune');
    expect(screen.getByText(/Kun visning\. Du har ikke rettigheden »Administrere brugere og roller«/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Handlinger' })).toBeNull();
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
