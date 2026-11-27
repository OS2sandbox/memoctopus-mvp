// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/ui/toast';
import { RoleGrantDialog } from './RoleGrantDialog';

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

describe('RoleGrantDialog — no org unit', () => {
  it('never asks for an org unit, whatever the role (no role is tied to units)', async () => {
    setup();
    for (const role of ['bruger', 'bygger', 'admin']) {
      await userEvent.selectOptions(screen.getByLabelText('Rolle'), role);
      expect(screen.queryByLabelText(/Organisationsenhed/)).toBeNull();
      expect(screen.queryByLabelText('Gælder også underenheder')).toBeNull();
    }
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
    await userEvent.type(screen.getByLabelText('Startdato (valgfri)'), '2026-01-01');
    await userEvent.type(screen.getByLabelText('Gælder indtil (valgfri)'), '2026-12-31');
    await userEvent.click(screen.getByRole('button', { name: 'Tildel rolle' }));

    await waitFor(() => expect(onGranted).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/access/assignments');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(body()).toEqual({
      appUserId: 'user-9',
      roleKey: 'bygger',
      scopeOrgUnitUuid: null,
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
