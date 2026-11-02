// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/ui/toast';
import { RoleGrantDialog } from './RoleGrantDialog';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const units = [
  { uuid: CHILD, name: 'Børn', parentUuid: ROOT },
  { uuid: ROOT, name: 'Kommune', parentUuid: null },
];

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const fetchMock = vi.fn();
const onGranted = vi.fn();
const onOpenChange = vi.fn();

function setup(props: Partial<React.ComponentProps<typeof RoleGrantDialog>> = {}) {
  return render(
    <ToastProvider>
      <RoleGrantDialog
        open
        onOpenChange={onOpenChange}
        user={{ id: 'user-9', name: 'Bo Bruger' }}
        orgUnits={units}
        onGranted={onGranted}
        {...props}
      />
    </ToastProvider>,
  );
}

const body = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

beforeEach(() => {
  fetchMock.mockReset();
  onGranted.mockReset();
  onOpenChange.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('RoleGrantDialog — scope rules per role', () => {
  it('hides the scope field until a scoped role is chosen', async () => {
    setup();
    expect(screen.queryByLabelText(/Organisationsenhed/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    expect(screen.queryByLabelText(/Organisationsenhed/)).toBeNull();
  });

  it('makes the unit optional for Bygger too: no unit means the global superuser', async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    const select = screen.getByLabelText('Organisationsenhed (valgfri)');
    expect(within(select).getByRole('option', { name: 'Hele organisationen' })).toBeInTheDocument();
  });

  it('hides the unit for Admin (global only) and for Bruger, but offers it for Bygger', async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    expect(screen.getByLabelText('Organisationsenhed (valgfri)')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'admin');
    expect(screen.queryByLabelText(/Organisationsenhed/)).toBeNull();
  });

  it('shows units as an indented hierarchy', async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    const options = within(screen.getByLabelText('Organisationsenhed (valgfri)')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Hele organisationen', 'Kommune', '\u2003└ Børn']);
  });

  it('clears the chosen unit when the role changes to one without scope', async () => {
    fetchMock.mockReturnValue(json({ assignment: {} }, 201));
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    await userEvent.selectOptions(screen.getByLabelText('Organisationsenhed (valgfri)'), ROOT);
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(body()).toMatchObject({ roleKey: 'bruger', scopeOrgUnitUuid: null });
    expect(body()).not.toHaveProperty('includeDescendants');
  });

  it('only offers "inkl. underenheder" once a unit is chosen', async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    expect(screen.queryByLabelText('Gælder også underenheder')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Organisationsenhed (valgfri)'), ROOT);
    expect(screen.getByLabelText('Gælder også underenheder')).toBeChecked();
  });
});

describe('RoleGrantDialog — validation', () => {
  it('requires a role', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    expect(screen.getByText('Vælg en rolle')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a stop date that is not after the start date', async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    await userEvent.type(screen.getByLabelText('Startdato (valgfri)'), '2026-05-02');
    await userEvent.type(screen.getByLabelText('Gælder indtil (valgfri)'), '2026-05-02');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    expect(screen.getByText('Slutdato skal ligge efter startdato')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a load error for the unit list on the scope field', async () => {
    setup({ orgUnits: [], orgUnitsError: 'Kunne ikke hente organisationsenheder.' });
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    expect(screen.getByText('Kunne ikke hente organisationsenheder.')).toBeInTheDocument();
  });
});

describe('RoleGrantDialog — end date wording', () => {
  it('says the end date is not itself covered', () => {
    setup();
    expect(screen.getByLabelText('Gælder indtil (valgfri)')).toHaveAccessibleDescription(/gælder ikke selve datoen/);
  });
});

describe('RoleGrantDialog — submit', () => {
  it('posts the grant, toasts, reloads and closes', async () => {
    fetchMock.mockReturnValue(json({ assignment: { id: 'a1' } }, 201));
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bygger');
    await userEvent.selectOptions(screen.getByLabelText('Organisationsenhed (valgfri)'), CHILD);
    await userEvent.click(screen.getByLabelText('Gælder også underenheder'));
    await userEvent.type(screen.getByLabelText('Startdato (valgfri)'), '2026-01-01');
    await userEvent.type(screen.getByLabelText('Gælder indtil (valgfri)'), '2026-12-31');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));

    await waitFor(() => expect(onGranted).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/access/assignments');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(body()).toEqual({
      appUserId: 'user-9',
      roleKey: 'bygger',
      scopeOrgUnitUuid: CHILD,
      includeDescendants: false,
      startDate: '2026-01-01',
      stopDate: '2026-12-31',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText(/er tildelt Bo Bruger/)).toBeInTheDocument();
  });

  it('shows the server message and stays open on 409', async () => {
    fetchMock.mockReturnValue(json({ error: 'Rollen er allerede tildelt', code: 'already_assigned' }, 409));
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rollen er allerede tildelt');
    expect(onGranted).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows a Danish message on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Netværksfejl');
  });

  it('does not show English server text for a 403', async () => {
    fetchMock.mockReturnValue(json({ error: 'Forbidden' }, 403));
    setup();
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'bruger');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Du har ikke adgang');
    expect(alert).not.toHaveTextContent('Forbidden');
  });
});
