// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LastSyncLine, SyncStatus, type SyncRunView } from './SyncStatus';
import { ADMIN_ME, READER_ME, ROLLEKATALOG_ME, calls, installFetch, json } from './test-helpers';
import { emptySyncCounts } from '@/lib/rollekatalog/types';
import { syncErrorMessage } from '@/lib/rollekatalog/labels.da';

afterEach(() => vi.unstubAllGlobals());

const SYNC = '/api/admin/access/sync';
const counts = { ...emptySyncCounts(), usersUpserted: 12, orgUnitsUpserted: 5, assignmentsRemoved: 2 };
const run = (over: Partial<SyncRunView> = {}): SyncRunView => ({
  id: 'r1',
  startedAt: '2026-10-05T10:00:00.000Z',
  finishedAt: '2026-10-05T10:00:03.000Z',
  status: 'success',
  counts,
  errorCode: null,
  ...over,
});
const latest = (r: SyncRunView | null, configIssue: string | null = null) => () => json({ run: r, source: 'rollekatalog', configIssue });
const failure = (status: number, code: string) => () =>
  json({ status: 'aborted', counts: emptySyncCounts(), errorCode: code, error: syncErrorMessage(code), code }, status);

describe('SyncStatus visibility', () => {
  it('renders nothing in local mode, even for a sync.run holder, and does not fetch', () => {
    const mock = installFetch({});
    const { container } = render(<SyncStatus me={ADMIN_ME} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock).not.toHaveBeenCalled();
  });

  it('renders nothing in local mode without sync.run', () => {
    const mock = installFetch({});
    const { container } = render(<SyncStatus me={{ ...READER_ME }} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock).not.toHaveBeenCalled();
  });

  it('renders nothing without sync.run (a read-only viewer) and does not fetch', () => {
    const mock = installFetch({});
    const { container } = render(<SyncStatus me={{ ...READER_ME, source: 'rollekatalog', readOnly: true }} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('SyncStatus last run', () => {
  it('shows the status, time and every counter in Danish', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run()) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText('Gennemført')).toBeInTheDocument();
    expect(screen.getByText(/Seneste synkronisering/)).toHaveTextContent(/2026/);
    const users = screen.getByText('Brugere opdateret').closest('div')!;
    expect(within(users).getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Roller fjernet').closest('div')).toHaveTextContent('2');
    expect(screen.getByText('Roller uden område (ikke tildelt)')).toBeInTheDocument();
  });

  it('tolerates stored counts without the newer keys', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run({ counts: { usersUpserted: 1 } })) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText('Kredsløb i organisationen brudt')).toBeInTheDocument();
  });

  it('says so when nothing has run yet', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(null) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText('Der er ikke kørt nogen synkronisering endnu.')).toBeInTheDocument();
  });

  it('shows a failed run with the Danish error and never the raw code', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run({ status: 'failed', errorCode: 'timeout', counts: null })) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rollekatalog svarede ikke i tide.');
    expect(screen.getByText('Mislykkedes')).toBeInTheDocument();
    expect(screen.queryByText('timeout')).toBeNull();
  });

  it('shows an error with retry when the status cannot be loaded', async () => {
    installFetch({ [`GET ${SYNC}`]: () => json({ error: 'Forbidden' }, 403) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Du har ikke adgang til denne handling.');
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
  });

  it('disables Synkroniser nu when Rollekatalog is not configured', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(null, 'not_configured') });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText(/ikke konfigureret/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synkroniser nu' })).toBeDisabled();
  });
});

describe('Synkroniser nu', () => {
  it('asks for confirmation first, without a Gennemtving option', async () => {
    const mock = installFetch({ [`GET ${SYNC}`]: latest(run()) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(calls(mock, 'POST', SYNC)).toHaveLength(0);
  });

  it('cancel does not start a sync', async () => {
    const mock = installFetch({ [`GET ${SYNC}`]: latest(run()) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Annuller' }));
    expect(calls(mock, 'POST', SYNC)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('confirming POSTs without force, closes, reports success and reloads the run', async () => {
    let gets = 0;
    const mock = installFetch({
      [`GET ${SYNC}`]: () => {
        gets += 1;
        return json({ run: run({ counts: { ...counts, usersUpserted: gets === 1 ? 12 : 99 } }), source: 'rollekatalog', configIssue: null });
      },
      [`POST ${SYNC}`]: () => json({ status: 'success', counts, errorCode: null }),
    });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start synkronisering' }));
    expect(await screen.findByText('Synkroniseringen er gennemført.')).toBeInTheDocument();
    expect(JSON.parse(calls(mock, 'POST', SYNC)[0][1]!.body as string)).toEqual({});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByText('Brugere opdateret').closest('div')).toHaveTextContent('99'));
  });

  it('shows the server Danish message when a run is already in progress, and keeps the dialog open', async () => {
    installFetch({
      [`GET ${SYNC}`]: latest(run()),
      [`POST ${SYNC}`]: () =>
        json({ status: 'already_running', counts: emptySyncCounts(), errorCode: 'already_running', error: 'En synkronisering kører allerede.', code: 'already_running' }, 409),
    });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start synkronisering' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('En synkronisering kører allerede.');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('after a removal_threshold abort the Gennemtving checkbox appears, and force is sent only when ticked', async () => {
    const mock = installFetch({
      [`GET ${SYNC}`]: latest(run()),
      [`POST ${SYNC}`]: (_u, init) => {
        const body = JSON.parse(init!.body as string);
        return body.force ? json({ status: 'success', counts, errorCode: null }) : failure(502, 'removal_threshold')();
      },
    });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start synkronisering' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('usædvanligt mange');
    const box = await within(dialog).findByRole('checkbox', { name: /Gennemtving/ });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gennemtving synkronisering' }));
    expect(await screen.findByText('Synkroniseringen er gennemført.')).toBeInTheDocument();
    const bodies = calls(mock, 'POST', SYNC).map((c) => JSON.parse(c[1]!.body as string));
    expect(bodies).toEqual([{}, { force: true }]);
  });

  it('offers Gennemtving straight away when the last stored run was stopped by the threshold', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run({ status: 'failed', errorCode: 'removal_threshold' })) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    expect(await screen.findByRole('checkbox', { name: /Gennemtving/ })).toBeInTheDocument();
  });

  it("lets the Gennemtving checkbox follow the server's last stored run, not the latest local error", async () => {
    installFetch({
      [`GET ${SYNC}`]: latest(run({ status: 'failed', errorCode: 'removal_threshold' })),
      [`POST ${SYNC}`]: failure(502, 'empty_response'),
    });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start synkronisering' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ingen brugere eller enheder');
    // The stored run is still the threshold one in this fake, so the checkbox stays: it follows the server's last run.
    expect(within(dialog).queryByRole('checkbox')).not.toBeNull();
  });

  it('shows a network error from the server call', async () => {
    const mock = installFetch({ [`GET ${SYNC}`]: latest(run()) });
    render(<SyncStatus me={ROLLEKATALOG_ME} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Synkroniser nu' }));
    mock.mockImplementationOnce(() => Promise.reject(new TypeError('offline')));
    await userEvent.click(await screen.findByRole('button', { name: 'Start synkronisering' }));
    expect(await within(await screen.findByRole('dialog')).findByRole('alert')).toHaveTextContent('Netværksfejl. Prøv igen.');
  });
});

describe('LastSyncLine', () => {
  it('renders nothing in local mode', () => {
    const mock = installFetch({});
    const { container } = render(<LastSyncLine me={ADMIN_ME} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock).not.toHaveBeenCalled();
  });

  it('renders nothing while the viewer is unknown', () => {
    const { container } = render(<LastSyncLine me={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels the data Rollekatalog and shows the last sync time (access.manage / sync.run)', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run()) });
    render(<LastSyncLine me={ROLLEKATALOG_ME} />);
    expect(screen.getByText('Rollekatalog')).toBeInTheDocument();
    expect(await screen.findByText(/Sidst synkroniseret .*2026/)).toBeInTheDocument();
  });

  it('warns that data may be stale after a failed run', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(run({ status: 'failed', errorCode: 'network' })) });
    render(<LastSyncLine me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText(/mislykkedes .*Data kan være forældede/)).toBeInTheDocument();
  });

  it('says when nothing has been synchronised yet', async () => {
    installFetch({ [`GET ${SYNC}`]: latest(null) });
    render(<LastSyncLine me={ROLLEKATALOG_ME} />);
    expect(await screen.findByText(/Ikke synkroniseret endnu/)).toBeInTheDocument();
  });

  it('does not ask for the run without sync.run/access.manage (a denied read would be audited), but still labels the source', () => {
    const mock = installFetch({});
    render(<LastSyncLine me={{ ...READER_ME, source: 'rollekatalog', readOnly: true }} />);
    expect(screen.getByText('Rollekatalog')).toBeInTheDocument();
    expect(screen.getByText('Data hentes fra Rollekatalog.')).toBeInTheDocument();
    expect(mock).not.toHaveBeenCalled();
  });

  it('degrades to just the source label when the run cannot be read', async () => {
    const mock = installFetch({ [`GET ${SYNC}`]: () => json({ error: 'x' }, 500) });
    render(<LastSyncLine me={ROLLEKATALOG_ME} />);
    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(screen.getByText('Data hentes fra Rollekatalog.')).toBeInTheDocument();
  });
});
