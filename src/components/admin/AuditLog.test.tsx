// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLog } from './AuditLog';
import { ADMIN_ME, READER_ME, calls, installFetch, json } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

describe('AuditLog', () => {
  it('shows one sentence per event with the time, not a table', async () => {
    setup();
    render(<AuditLog />);
    const row = (await screen.findByText('Anne Admin hentede en eksport (pdf)')).closest('li')!;
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-10-05T09:30:00.000Z');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('columnheader')).toBeNull();
    // Success has no badge; raw codes and ids are not in the visible row text.
    expect(within(row.querySelector('p')!).queryByText('Gennemført')).toBeNull();
    expect(within(row.querySelector('p')!).queryByText('selvrapporteret')).toBeNull();
    expect(within(row.querySelector('p')!).queryByText(/export\.download|meeting/)).toBeNull();
  });

  it('keeps the technical information in a collapsed Tekniske detaljer block', async () => {
    setup(ADMIN_ME, () => json({ events: [ev({ ipAddress: '10.0.0.7' })], nextCursor: null }));
    render(<AuditLog />);
    const row = (await screen.findByText('Anne Admin hentede en eksport (pdf)')).closest('li')!;
    const details = row.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('Tekniske detaljer').tagName).toBe('SUMMARY');
    await userEvent.click(within(details).getByText('Tekniske detaljer'));
    expect(details).toHaveAttribute('open');
    for (const text of ['Eksport hentet (export.download)', `meeting ${ENTITY}`, 'user-1', 'req-1', '10.0.0.7', 'format: pdf']) {
      expect(within(details).getByText(text)).toBeInTheDocument();
    }
  });

  it('omits the IP line when the API returned none (scoped reader)', async () => {
    setup();
    render(<AuditLog />);
    const row = (await screen.findByText('Anne Admin hentede en eksport (pdf)')).closest('li')!;
    expect(within(row).queryByText('IP-adresse')).toBeNull();
  });

  it('shows the change note of a central template change prominently, under the sentence', async () => {
    const NOTE = 'Tonen er gjort mere formel efter ønske fra afdelingen.\nBrug "mødet besluttede".';
    setup(ADMIN_ME, () =>
      json({
        events: [
          ev({ id: '12', eventType: 'central_template.update', entityType: 'central_template', details: { version: 3, changedFields: ['prompt'] }, changeNote: NOTE, templateName: 'Standardreferat' }),
          ev({ id: '11', eventType: 'central_template.archive', entityType: 'central_template', details: { version: 2 }, templateName: 'Standardreferat' }),
        ],
        nextCursor: null,
      }),
    );
    render(<AuditLog />);
    const heading = await screen.findByText(/Ændringsbeskrivelse/);
    expect(heading).toHaveTextContent('version 3');
    const block = heading.parentElement!;
    // Whitespace and line breaks of the note are kept (pre-wrap) and the full text is shown.
    expect(block.querySelector('p')!.textContent).toBe(NOTE);
    expect(block.querySelector('p')!.className).toContain('whitespace-pre-wrap');
    expect(block.className).toContain('bg-[var(--accent-wash)]');
    // The sentence names the template and version, and comes before the note in the same row.
    const row = block.closest('li')!;
    const sentence = within(row).getByText('Anne Admin ændrede den centrale skabelon »Standardreferat« (version 3)');
    expect(sentence.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Only the event that has a note gets a note block.
    expect(screen.getAllByText(/Ændringsbeskrivelse/)).toHaveLength(1);
    expect(screen.getByText('Anne Admin arkiverede den centrale skabelon »Standardreferat« (version 2)')).toBeInTheDocument();
  });

  it('shows an outcome badge only for denied and failed events', async () => {
    setup(ADMIN_ME, () =>
      json({
        events: [
          ev({ id: '3', eventType: 'authz.denied', outcome: 'denied', details: { required: 'audit.read', reason: 'missing_capability' } }),
          ev({ id: '2', eventType: 'auth.login_failed', outcome: 'error', actorUserId: null, actorName: null, details: { reason: 'invalid_credentials' } }),
          ev({ id: '1' }),
        ],
        nextCursor: null,
      }),
    );
    render(<AuditLog />);
    const denied = (await screen.findByText(/fik adgang nægtet til »Læse loggen«/)).closest('li')!;
    expect(within(denied.querySelector('p')!).getByText('Nægtet')).toBeInTheDocument();
    const failed = screen.getByText(/Mislykket login-forsøg/).closest('li')!;
    expect(within(failed.querySelector('p')!).getByText('Fejlet')).toBeInTheDocument();
    const ok = screen.getByText('Anne Admin hentede en eksport (pdf)').closest('li')!;
    const okLine = ok.querySelector('p')!;
    expect(within(okLine).queryByText('Gennemført')).toBeNull();
    expect(within(okLine).queryByText('Nægtet')).toBeNull();
    expect(within(okLine).queryByText('Fejlet')).toBeNull();
  });

  it('marks client events as selvrapporteret', async () => {
    setup(ADMIN_ME, () => json({ events: [ev({ source: 'client', eventType: 'meeting.delete', details: {} })], nextCursor: null }));
    render(<AuditLog />);
    const row = (await screen.findByText('Anne Admin slettede et møde med transskription og alle referatversioner')).closest('li')!;
    expect(within(row).getByText('selvrapporteret')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    setup(ADMIN_ME, () => json({ events: [], nextCursor: null }));
    render(<AuditLog />);
    expect(await screen.findByText('Ingen hændelser fundet')).toBeInTheDocument();
  });

  it('announces loading with role=status', async () => {
    let release: (r: Response) => void = () => {};
    setup(ADMIN_ME, () => new Promise<Response>((r) => (release = r)));
    render(<AuditLog />);
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Indlæser');
    release(new Response(JSON.stringify({ events: [], nextCursor: null }), { status: 200 }));
    await screen.findByText('Ingen hændelser fundet');
  });

  it('shows an error banner with retry when loading fails', async () => {
    let fail = true;
    const m = setup(ADMIN_ME, () => (fail ? json({ error: 'x' }, 500) : json({ events: [ev()], nextCursor: null })));
    render(<AuditLog />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Noget gik galt');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Prøv igen' }));
    expect(await screen.findByText('Anne Admin hentede en eksport (pdf)')).toBeInTheDocument();
    expect(auditCalls(m)).toHaveLength(2);
  });

  it('loads more with the cursor and appends', async () => {
    const m = setup(ADMIN_ME, (url) =>
      url.includes('cursor=10')
        ? json({ events: [ev({ id: '9', actorName: 'Bo Bruger' })], nextCursor: null })
        : json({ events: [ev()], nextCursor: '10' }),
    );
    render(<AuditLog />);
    await screen.findByText('Anne Admin hentede en eksport (pdf)');
    await userEvent.click(screen.getByRole('button', { name: 'Indlæs flere' }));
    expect(await screen.findByText('Bo Bruger hentede en eksport (pdf)')).toBeInTheDocument();
    expect(screen.getByText('Anne Admin hentede en eksport (pdf)')).toBeInTheDocument();
    expect(lastParams(m).get('cursor')).toBe('10');
    expect(screen.queryByRole('button', { name: 'Indlæs flere' })).toBeNull();
  });

  describe('filters', () => {
    const loaded = async (m = setup()) => {
      render(<AuditLog />);
      await screen.findByText('Anne Admin hentede en eksport (pdf)');
      return m;
    };

    it('starts with the last 7 days and no other filter', async () => {
      const m = await loaded();
      const p = lastParams(m);
      expect(Math.abs(Date.now() - SEVEN_DAYS - new Date(p.get('from')!).getTime())).toBeLessThan(60_000);
      expect([...p.keys()].sort()).toEqual(['from', 'limit']);
      expect(screen.getByLabelText('Periode')).toHaveValue('7d');
      expect(screen.getByLabelText('Kategori')).toHaveValue('');
      expect(screen.getByRole('searchbox', { name: 'Søg efter bruger' })).toHaveAttribute('placeholder', 'Navn på bruger');
      expect(screen.queryByRole('button', { name: 'Nulstil' })).toBeNull();
    });

    it('searches by user name with q on Enter', async () => {
      const m = await loaded();
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), '  Mette  {Enter}');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      expect(lastParams(m).get('q')).toBe('Mette');
      expect(lastParams(m).has('actorUserId')).toBe(false);
    });

    it('searches with the Søg button, and an empty search sends no q', async () => {
      const m = await loaded();
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), 'Bo');
      await userEvent.click(screen.getByRole('button', { name: 'Søg' }));
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      expect(lastParams(m).get('q')).toBe('Bo');
      await userEvent.clear(screen.getByLabelText('Søg efter bruger'));
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), '   {Enter}');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      expect(lastParams(m).has('q')).toBe(false);
    });

    it('a category sends the event types of that category on change', async () => {
      const m = await loaded();
      await userEvent.selectOptions(screen.getByLabelText('Kategori'), 'Login og adgang');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      expect(lastParams(m).getAll('eventType').sort()).toEqual(['auth.login', 'auth.login_failed', 'auth.logout', 'authz.denied']);
      await userEvent.selectOptions(screen.getByLabelText('Kategori'), 'Alle hændelser');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      expect(lastParams(m).has('eventType')).toBe(false);
    });

    it('offers the six categories', async () => {
      await loaded();
      const options = within(screen.getByLabelText('Kategori')).getAllByRole('option').map((o) => o.textContent);
      expect(options).toEqual(['Alle hændelser', 'Login og adgang', 'Skabeloner', 'Møder og optagelser', 'Visning og afspilning', 'Redigering af møder', 'Loggen og systemet']);
    });

    it('offers the periods and applies them on change', async () => {
      const m = await loaded();
      const options = within(screen.getByLabelText('Periode')).getAllByRole('option').map((o) => o.textContent);
      expect(options).toEqual(['I dag', 'Seneste 7 dage', 'Seneste 30 dage', 'Alle']);
      await userEvent.selectOptions(screen.getByLabelText('Periode'), 'I dag');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      expect(new Date(lastParams(m).get('from')!).getTime()).toBe(start.getTime());
      await userEvent.selectOptions(screen.getByLabelText('Periode'), 'Alle');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      expect(lastParams(m).has('from')).toBe(false);
      await userEvent.selectOptions(screen.getByLabelText('Periode'), 'Seneste 30 dage');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(4));
      expect(Math.abs(Date.now() - 30 * 24 * 3600_000 - new Date(lastParams(m).get('from')!).getTime())).toBeLessThan(60_000);
    });

    it('keeps resultat, kilde, objekt-id and dates under Flere filtre', async () => {
      const m = await loaded();
      const disclosure = screen.getByText(/Flere filtre/).closest('details')!;
      expect(disclosure).not.toHaveAttribute('open');
      await userEvent.click(screen.getByText(/Flere filtre/));
      expect(disclosure).toHaveAttribute('open');
      await userEvent.selectOptions(screen.getByLabelText('Resultat'), 'Nægtet');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      expect(lastParams(m).get('outcome')).toBe('denied');
      await userEvent.selectOptions(screen.getByLabelText('Kilde'), 'Selvrapporteret af klienten');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      expect(lastParams(m).get('source')).toBe('client');
      await userEvent.type(screen.getByLabelText('Objekt-id'), `${ENTITY.toUpperCase()}{Enter}`);
      await waitFor(() => expect(auditCalls(m)).toHaveLength(4));
      expect(lastParams(m).get('entityId')).toBe(ENTITY);
      expect(lastParams(m).get('outcome')).toBe('denied');
      expect(screen.getByText(/Flere filtre \(3 valgt\)/)).toBeInTheDocument();
    });

    it('custom dates override the period', async () => {
      const m = await loaded();
      await userEvent.click(screen.getByText(/Flere filtre/));
      await userEvent.type(screen.getByLabelText('Fra dato'), '2026-10-01');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      await userEvent.type(screen.getByLabelText('Til dato'), '2026-10-05');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      const p = lastParams(m);
      expect(new Date(p.get('from')!).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
      expect(new Date(p.get('to')!).getTime()).toBe(new Date('2026-10-05T23:59:59.999').getTime());
      expect(screen.getByLabelText('Periode')).toHaveValue('custom');
      // Picking a period again replaces the custom dates.
      await userEvent.selectOptions(screen.getByLabelText('Periode'), 'Seneste 30 dage');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(4));
      expect(lastParams(m).has('to')).toBe(false);
      expect(screen.getByLabelText('Fra dato')).toHaveValue('');
      expect(screen.getByLabelText('Periode')).toHaveValue('30d');
    });

    it('rejects a malformed object id without calling the API', async () => {
      const m = await loaded();
      await userEvent.click(screen.getByText(/Flere filtre/));
      await userEvent.type(screen.getByLabelText('Objekt-id'), 'not-a-uuid{Enter}');
      expect(await screen.findByRole('alert')).toHaveTextContent('gyldigt id');
      expect(auditCalls(m)).toHaveLength(1);
    });

    it('rejects a reversed date range without calling the API', async () => {
      const m = await loaded();
      await userEvent.click(screen.getByText(/Flere filtre/));
      await userEvent.type(screen.getByLabelText('Fra dato'), '2026-10-05');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(2));
      await userEvent.type(screen.getByLabelText('Til dato'), '2026-10-01');
      expect(await screen.findByRole('alert')).toHaveTextContent('Fra-datoen');
      expect(auditCalls(m)).toHaveLength(2);
    });

    it('Nulstil clears everything back to the defaults', async () => {
      const m = await loaded();
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), 'Mette{Enter}');
      await userEvent.selectOptions(screen.getByLabelText('Kategori'), 'Skabeloner');
      await waitFor(() => expect(auditCalls(m)).toHaveLength(3));
      await userEvent.click(screen.getByRole('button', { name: 'Nulstil' }));
      await waitFor(() => expect(auditCalls(m)).toHaveLength(4));
      expect([...lastParams(m).keys()].sort()).toEqual(['from', 'limit']);
      expect(screen.getByLabelText('Søg efter bruger')).toHaveValue('');
      expect(screen.getByLabelText('Kategori')).toHaveValue('');
      expect(screen.queryByRole('button', { name: 'Nulstil' })).toBeNull();
    });

    it('a filtered empty result suggests widening the search', async () => {
      setup(ADMIN_ME, () => json({ events: [], nextCursor: null }));
      render(<AuditLog />);
      await screen.findByText('Ingen hændelser fundet');
      expect(screen.queryByText(/Prøv et andet navn/)).toBeNull();
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), 'Nobody{Enter}');
      expect(await screen.findByText(/Prøv et andet navn/)).toBeInTheDocument();
    });
  });

  it('offers CSV export only with audit.export', async () => {
    setup();
    const { unmount } = render(<AuditLog />);
    expect(await screen.findByRole('button', { name: 'Eksportér som CSV' })).toBeInTheDocument();
    unmount();

    setup(LOG_READER_ME);
    render(<AuditLog />);
    await screen.findByText('Anne Admin hentede en eksport (pdf)');
    expect(screen.queryByRole('button', { name: 'Eksportér som CSV' })).toBeNull();
  });

  describe('CSV export', () => {
    const EXPORT = '/api/admin/audit/export';
    const exportCalls = (m: ReturnType<typeof vi.fn>) => calls(m, 'GET', EXPORT);
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let downloads: { href: string; download: string }[];

    const csvResponse = (headers: Record<string, string> = {}) =>
      Promise.resolve(
        new Response('\uFEFFTidspunkt\r\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="log-2026-10-06.csv"', ...headers },
        }),
      );

    function setupExport(handler: () => Promise<Response>) {
      return installFetch({
        'GET /api/me': () => json(ADMIN_ME),
        'GET /api/admin/audit': () => json({ events: [ev()], nextCursor: null }),
        [`GET ${EXPORT}`]: handler,
      });
    }

    beforeEach(() => {
      createObjectURL = vi.fn(() => 'blob:fake-1');
      revokeObjectURL = vi.fn();
      downloads = [];
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push({ href: this.href, download: this.download });
      });
    });

    afterEach(() => {
      // jsdom has neither; remove the stubs so no other test sees them.
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    });

    async function clickExport() {
      await userEvent.click(await screen.findByRole('button', { name: 'Eksportér som CSV' }));
    }

    it('downloads the file under the server filename, revokes the URL and shows no warning', async () => {
      const m = setupExport(() => csvResponse({ 'X-Audit-Truncated': 'false' }));
      render(<AuditLog />);
      await clickExport();
      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]).toEqual({ href: 'blob:fake-1', download: 'log-2026-10-06.csv' });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.size).toBeGreaterThan(0);
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-1'));
      expect(m.mock.calls.find(([u]) => String(u).startsWith(EXPORT))![1]).toMatchObject({ credentials: 'same-origin' });
      expect(screen.queryByText(/afkortet/)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      // The anchor is cleaned up again.
      expect(document.querySelector('a[download]')).toBeNull();
    });

    it('warns persistently, and dismissibly, when the export is truncated', async () => {
      setupExport(() =>
        csvResponse({ 'X-Audit-Truncated': 'true', 'Content-Disposition': 'attachment; filename="log-2026-10-06-afkortet.csv"' }),
      );
      render(<AuditLog />);
      await clickExport();
      expect(await screen.findByText('Eksporten er afkortet til de første 50.000 rækker. Indsnævr filteret (fx datointerval) og eksportér igen.')).toBeInTheDocument();
      expect(downloads[0].download).toBe('log-2026-10-06-afkortet.csv');
      await userEvent.click(screen.getByRole('button', { name: 'Luk' }));
      expect(screen.queryByText(/afkortet til/)).toBeNull();
    });

    it('falls back to the old filename without Content-Disposition', async () => {
      setupExport(() => Promise.resolve(new Response('x', { status: 200 })));
      render(<AuditLog />);
      await clickExport();
      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0].download).toMatch(/^log-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it('shows the server error for a 500 and downloads nothing', async () => {
      setupExport(() => json({ error: 'Eksporten kunne ikke logges og er derfor afvist' }, 500));
      render(<AuditLog />);
      await clickExport();
      expect(await screen.findByRole('alert')).toHaveTextContent('Eksporten kunne ikke logges og er derfor afvist');
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(downloads).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Eksportér som CSV' })).toBeEnabled();
    });

    it('shows a Danish error for a 403 and downloads nothing', async () => {
      setupExport(() => json({ error: 'Forbidden' }, 403));
      render(<AuditLog />);
      await clickExport();
      expect(await screen.findByRole('alert')).toHaveTextContent('Du har ikke adgang til denne handling.');
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(downloads).toHaveLength(0);
    });

    it('falls back to a generic error for a non-JSON failure or a network error', async () => {
      setupExport(() => Promise.resolve(new Response('<html>', { status: 502 })));
      const { unmount } = render(<AuditLog />);
      await clickExport();
      expect(await screen.findByRole('alert')).toHaveTextContent('Eksport mislykkedes');
      unmount();

      setupExport(() => Promise.reject(new TypeError('offline')));
      render(<AuditLog />);
      await clickExport();
      expect(await screen.findByRole('alert')).toHaveTextContent('Eksport mislykkedes');
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('is busy while exporting and sends one request for a double click', async () => {
      let release: (r: Response) => void = () => {};
      const m = setupExport(() => new Promise<Response>((r) => (release = r)));
      render(<AuditLog />);
      const button = await screen.findByRole('button', { name: 'Eksportér som CSV' });
      await userEvent.dblClick(button);
      expect(await screen.findByRole('button', { name: 'Eksporterer …' })).toBeDisabled();
      expect(exportCalls(m)).toHaveLength(1);
      release(new Response('x', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="log-2026-10-06.csv"' } }));
      expect(await screen.findByRole('button', { name: 'Eksportér som CSV' })).toBeEnabled();
      expect(exportCalls(m)).toHaveLength(1);
      expect(downloads).toHaveLength(1);
    });

    it('exports with the applied filters', async () => {
      const m = setupExport(() => csvResponse());
      render(<AuditLog />);
      await screen.findByText('Anne Admin hentede en eksport (pdf)');
      await userEvent.click(screen.getByText(/Flere filtre/));
      await userEvent.selectOptions(screen.getByLabelText('Resultat'), 'Nægtet');
      await userEvent.type(screen.getByLabelText('Fra dato'), '2026-10-01');
      await userEvent.type(screen.getByLabelText('Søg efter bruger'), 'Mette{Enter}');
      await userEvent.selectOptions(screen.getByLabelText('Kategori'), 'Møder og optagelser');
      await waitFor(() => expect(lastParams(m).getAll('eventType').length).toBeGreaterThan(0));
      await clickExport();
      await waitFor(() => expect(exportCalls(m)).toHaveLength(1));
      const p = new URL(`http://x${exportCalls(m)[0][0]}`).searchParams;
      expect(p.get('outcome')).toBe('denied');
      expect(p.get('q')).toBe('Mette');
      expect(p.getAll('eventType')).toContain('meeting.delete');
      expect(new Date(p.get('from')!).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
      expect(p.has('limit')).toBe(false);
    });
  });

  it('tells a scoped reader that they only see their own units', async () => {
    setup(LOG_READER_ME);
    render(<AuditLog />);
    expect(await screen.findByText(/kun hændelser fra de enheder/)).toBeInTheDocument();
  });

  it('does not show that notice to a global reader', async () => {
    setup();
    render(<AuditLog />);
    await screen.findByText('Anne Admin hentede en eksport (pdf)');
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
    await userEvent.selectOptions(await screen.findByLabelText('Kategori'), 'Skabeloner');
    await screen.findByText('Ny Filter hentede en eksport (pdf)');
    releaseFirst(new Response(JSON.stringify({ events: [ev({ actorName: 'Gammel' })], nextCursor: null }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Gammel')).toBeNull();
    expect(screen.getByText('Ny Filter hentede en eksport (pdf)')).toBeInTheDocument();
  });
});
