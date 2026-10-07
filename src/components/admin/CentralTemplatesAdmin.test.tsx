// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CentralTemplatesAdmin } from './CentralTemplatesAdmin';
import { formatTime } from './central-template-utils';
import { ADMIN_ME, READER_ME, calls, installFetch, json, renderWithToasts } from './test-helpers';
import type {
  CentralCatalogueEntry,
  CentralTemplateAdmin,
  CentralTemplateListItem,
} from '@/lib/skabeloner/central-types';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const item = (over: Partial<CentralTemplateListItem>): CentralTemplateListItem => ({
  id: A,
  name: 'Bestyrelse',
  description: 'Standard referat',
  ownerOrgUnitUuid: ROOT,
  status: 'active',
  currentVersion: 3,
  targetCount: 2,
  targets: [
    { orgUnitUuid: ROOT, includeDescendants: true },
    { orgUnitUuid: CHILD, includeDescendants: false },
  ],
  principalTargets: [],
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdByName: 'Anne Admin',
  lastEditedByName: 'Bo Beslutter',
  lastEditedAt: '2026-10-02T10:00:00.000Z',
  ...over,
});

const ACTIVE = [
  item({}),
  item({ id: B, name: 'Tom skabelon', description: '', targetCount: 1, targets: [{ orgUnitUuid: CHILD, includeDescendants: false }], ownerOrgUnitUuid: CHILD }),
];
const ARCHIVED = [item({ id: B, name: 'Gammel', status: 'archived', currentVersion: 7 })];

const DETAIL: CentralTemplateAdmin = {
  id: A,
  ownerOrgUnitUuid: ROOT,
  name: 'Bestyrelse',
  description: 'Standard referat',
  prompt: 'Hemmelig prompt',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
  allowUserInstruction: false,
  allowToggleOverrides: false,
  status: 'active',
  currentVersion: 3,
  targets: [],
  principalTargets: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdByName: null,
  lastEditedByName: null,
  lastEditedAt: '2026-10-02T10:00:00.000Z',
};

const SCOPE = {
  orgUnits: [
    { uuid: ROOT, name: 'Kommune', parentUuid: null },
    { uuid: CHILD, name: 'Børn', parentUuid: ROOT },
  ],
};

const CATALOGUE: CentralCatalogueEntry[] = [
  { kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler', source: 'rollekatalog', active: true, holders: 4 },
  { kind: 'group', identifier: 'social', name: 'Socialforvaltningen', source: 'config', active: true, holders: 2 },
  { kind: 'role', identifier: 'gammel', name: 'Gammel rolle', source: 'rollekatalog', active: false, holders: 0 },
];
const ROLES = { roles: CATALOGUE, canTarget: true, canRefresh: false, lastRefreshedAt: null };

afterEach(() => vi.unstubAllGlobals());

function setup(me = ADMIN_ME, extra: Parameters<typeof installFetch>[0] = {}) {
  return installFetch({
    'GET /api/me': () => json(me),
    'GET /api/admin/central-templates/scope': () => json(SCOPE),
    'GET /api/admin/central-templates/roles': () => json(ROLES),
    'GET /api/admin/central-templates?status=active': () => json({ templates: ACTIVE }),
    'GET /api/admin/central-templates?status=archived': () => json({ templates: ARCHIVED }),
    'GET /api/admin/central-templates?status=all': () => json({ templates: [...ACTIVE, ...ARCHIVED] }),
    ...extra,
  });
}

describe('CentralTemplatesAdmin — list', () => {
  it('shows name, owner unit, status, version, availability count and update time', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Bestyrelse')).closest('tr')!;
    expect(within(row).getByText('Standard referat')).toBeInTheDocument();
    expect(within(row).getByText('Kommune')).toBeInTheDocument();
    expect(within(row).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    // The audience is named, not counted.
    expect(within(row).getByText('Enhed: Kommune (inkl. underenheder)')).toBeInTheDocument();
    expect(within(row).getByText('Enhed: Børn')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Til rådighed for' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Modtagere' })).toBeNull();
    expect(within(row).getByText(formatTime('2026-10-02T10:00:00.000Z'))).toBeInTheDocument();
  });

  it('shows who created and who last edited each template, with the time of the last edit', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Bestyrelse')).closest('tr')!;
    expect(screen.getByRole('columnheader', { name: 'Oprettet af' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Senest ændret' })).toBeInTheDocument();
    expect(within(row).getByText('Anne Admin')).toBeInTheDocument();
    expect(within(row).getByText('Bo Beslutter')).toBeInTheDocument();
    expect(within(row).getByText(formatTime('2026-10-02T10:00:00.000Z'))).toBeInTheDocument();
  });

  it('says Ukendt when a name snapshot is missing', async () => {
    setup(ADMIN_ME, {
      'GET /api/admin/central-templates?status=active': () =>
        json({ templates: [item({ createdByName: null, lastEditedByName: null })] }),
    });
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Bestyrelse')).closest('tr')!;
    expect(within(row).getAllByText('Ukendt')).toHaveLength(2);
  });

  it('flags a template that is available to nobody', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Tom skabelon')).closest('tr')!;
    expect(within(row).getByText('Enhed: Børn')).toBeInTheDocument();
  });

  it('never fetches or shows prompt text in the list', async () => {
    const mock = setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    expect(screen.queryByText('Hemmelig prompt')).toBeNull();
    expect(calls(mock, 'GET', '/api/admin/central-templates/' + A)).toHaveLength(0);
  });

  it('filters by status through the server', async () => {
    const mock = setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    await userEvent.selectOptions(screen.getByLabelText('Vis'), 'archived');
    expect(await screen.findByText('Gammel')).toBeInTheDocument();
    expect(screen.queryByText('Bestyrelse')).toBeNull();
    expect(screen.getByText('Arkiveret', { selector: 'span' })).toBeInTheDocument();
    expect(calls(mock, 'GET', '/api/admin/central-templates?status=archived')).toHaveLength(1);
  });

  it('keeps the newest filter when an older request answers last', async () => {
    let releaseActive!: () => void;
    const gate = new Promise<void>((r) => (releaseActive = r));
    setup(ADMIN_ME, {
      'GET /api/admin/central-templates?status=active': async () => {
        await gate;
        return json({ templates: ACTIVE });
      },
    });
    renderWithToasts(<CentralTemplatesAdmin />);
    expect(screen.getByRole('status')).toHaveTextContent('Indlæser');
    await userEvent.selectOptions(screen.getByLabelText('Vis'), 'archived');
    await screen.findByText('Gammel');
    expect(screen.getByRole('table', { name: 'Centrale skabeloner' })).toBeInTheDocument();
    releaseActive();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Gammel')).toBeInTheDocument();
    expect(screen.queryByText('Bestyrelse')).toBeNull();
  });

  it('shows an empty state and a load error with retry', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/central-templates?status=active': () => json({ templates: [] }) });
    renderWithToasts(<CentralTemplatesAdmin />);
    expect(await screen.findByText('Ingen centrale skabeloner')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/central-templates?status=active': () => json({ error: 'x' }, 500) });
    renderWithToasts(<CentralTemplatesAdmin />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Noget gik galt. Prøv igen.');
  });
});

describe('CentralTemplatesAdmin — gating and actions', () => {
  it('offers create, edit, archive and history to a manager', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    expect(screen.getByRole('button', { name: 'Ny central skabelon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rediger Bestyrelse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arkivér (fjerner for alle) Bestyrelse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Historik for Bestyrelse' })).toBeInTheDocument();
  });

  it('works the same for a scoped skabelonansvarlig', async () => {
    setup(READER_ME);
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    expect(screen.getByRole('button', { name: 'Ny central skabelon' })).toBeInTheDocument();
  });

  it('offers restore, not edit, for an archived template', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    await userEvent.selectOptions(screen.getByLabelText('Vis'), 'archived');
    await screen.findByText('Gammel');
    expect(screen.getByRole('button', { name: 'Gendan Gammel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rediger Gammel' })).toBeNull();
  });

  it('opens the editor with the full template fetched on demand', async () => {
    const mock = setup(ADMIN_ME, { [`GET /api/admin/central-templates/${A}`]: () => json({ template: DETAIL }) });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rediger Bestyrelse' }));
    expect(await screen.findByRole('dialog', { name: 'Rediger central skabelon' })).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('Hemmelig prompt');
    expect(calls(mock, 'GET', `/api/admin/central-templates/${A}`)).toHaveLength(1);
  });

  it('opens an empty editor for a new template', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ny central skabelon' }));
    expect(await screen.findByRole('dialog', { name: 'Ny central skabelon' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ejerenhed')).toHaveValue('');
  });

  it('shows the error when the template cannot be loaded for editing', async () => {
    setup(ADMIN_ME, { [`GET /api/admin/central-templates/${A}`]: () => json({ error: 'x' }, 404) });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rediger Bestyrelse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ikke fundet.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('CentralTemplatesAdmin — archive and restore', () => {
  const NOTE = 'Skabelonen er afløst af en ny';

  it('archive requires a change note and never calls the API without it', async () => {
    const post = vi.fn(() => json({ template: { ...DETAIL, status: 'archived' } }));
    const mock = setup(ADMIN_ME, { [`POST /api/admin/central-templates/${A}/archive`]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arkivér (fjerner for alle) Bestyrelse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Arkivér skabelon (fjerner for alle)' });
    const confirm = within(dialog).getByRole('button', { name: 'Arkivér' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText('Beskriv ændringen (mindst 10 tegn)')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Ændringsbeskrivelse'), 'for kort');
    expect(confirm).toBeDisabled();
    expect(calls(mock, 'POST', '/api/admin/central-templates')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText('Ændringsbeskrivelse'), ' og nu lang nok');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const sent = JSON.parse((post.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).toEqual({ baseVersion: 3, changeNote: 'for kort og nu lang nok' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('restore needs a note too and posts to the restore route', async () => {
    const post = vi.fn(() => json({ template: DETAIL }));
    setup(ADMIN_ME, { [`POST /api/admin/central-templates/${B}/restore`]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    await userEvent.selectOptions(screen.getByLabelText('Vis'), 'archived');
    await userEvent.click(await screen.findByRole('button', { name: 'Gendan Gammel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gendan skabelon' });
    expect(within(dialog).getByRole('button', { name: 'Gendan' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gendan' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(JSON.parse((post.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).baseVersion).toBe(7);
  });

  it('shows the conflict message and does not retry on its own', async () => {
    const post = vi.fn(() => json({ error: 'x', code: 'version_conflict', currentVersion: 4 }, 409));
    setup(ADMIN_ME, { [`POST /api/admin/central-templates/${A}/archive`]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arkivér (fjerner for alle) Bestyrelse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Arkivér skabelon (fjerner for alle)' });
    await userEvent.type(within(dialog).getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Arkivér' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Skabelonen er ændret af en anden (version 4). Genindlæs for at se ændringerne.',
    );
    expect(within(dialog).getByRole('button', { name: 'Arkivér' })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('CentralTemplatesAdmin — history', () => {
  it('opens the changelog of the chosen template', async () => {
    const mock = setup(ADMIN_ME, {
      [`GET /api/admin/central-templates/${A}/versions`]: () =>
        json({
          versions: [
            {
              version: 1,
              changeType: 'create',
              changeNote: 'Første udgave af skabelonen',
              changedByName: 'Anne Admin',
              changedAt: '2026-10-01T10:00:00.000Z',
              content: { ...DETAIL },
              targets: [],
            },
          ],
        }),
    });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Historik for Bestyrelse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ændringshistorik' });
    expect(await within(dialog).findAllByText('Første udgave af skabelonen')).toHaveLength(2); // list row and detail
    expect(calls(mock, 'GET', `/api/admin/central-templates/${A}/versions`)).toHaveLength(1);
  });
});

describe('CentralTemplatesAdmin — audience by role, group and unit', () => {
  const P = (kind: 'role' | 'group', identifier: string, name: string, status: 'active' | 'inactive' | 'unknown' = 'active', holders = 3) => ({ kind, identifier, name, status, holders });
  const rowOf = async (list: CentralTemplateListItem[]) => {
    setup(ADMIN_ME, { 'GET /api/admin/central-templates?status=active': () => json({ templates: list }) });
    renderWithToasts(<CentralTemplatesAdmin />);
    return (await screen.findByText(list[0].name)).closest('tr')!;
  };

  it('names the roles, groups and units a template is available to', async () => {
    const row = await rowOf([
      item({ ownerOrgUnitUuid: null, targets: [{ orgUnitUuid: CHILD, includeDescendants: true }], targetCount: 1, principalTargets: [P('role', 'a', 'Sagsbehandler'), P('group', 'g', 'Socialforvaltningen')] }),
    ]);
    const audience = within(row).getByRole('list', { name: 'Til rådighed for, Bestyrelse' });
    expect(within(audience).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Rolle: Sagsbehandler',
      'Gruppe: Socialforvaltningen',
      'Enhed: Børn (inkl. underenheder)',
    ]);
  });

  it('shows an org-wide template as "Hele organisationen", not as a missing unit', async () => {
    const row = await rowOf([item({ ownerOrgUnitUuid: null })]);
    expect(within(row).getByText('Hele organisationen')).toBeInTheDocument();
    expect(within(row).queryByText('Ukendt enhed')).toBeNull();
  });

  it('truncates a long audience with a "+N flere" disclosure (keyboard and touch), never hiding a flagged one', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((x) => P('role', x, `Rolle ${x.toUpperCase()}`));
    const row = await rowOf([
      item({ targets: [], targetCount: 0, principalTargets: [...many, P('role', 'x', 'Udgået', 'inactive')] }),
    ]);
    const audience = within(row).getByRole('list', { name: 'Til rådighed for, Bestyrelse' });
    // The flagged one is shown first, not folded away.
    expect(within(audience).getByText('Rolle: Udgået (ukendt/inaktiv)')).toBeInTheDocument();
    const summary = within(audience).getByText('+3 flere');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary).not.toHaveAttribute('title');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    // The rest is a real list inside the disclosure, reachable without hovering.
    const rest = within(details).getByRole('list', { name: 'Flere, Bestyrelse' });
    expect(within(rest).getAllByRole('listitem')).toHaveLength(3);
    expect(within(rest).getByText('Rolle: Rolle D')).toBeInTheDocument();
    await userEvent.click(summary);
    expect(details).toHaveAttribute('open');
  });

  it('flags a target that was withdrawn from the catalogue or is not in it', async () => {
    const row = await rowOf([
      item({ targets: [], targetCount: 0, principalTargets: [P('role', 'a', 'Gammel', 'inactive'), P('group', 'g', 'Ukendt gruppe', 'unknown'), P('role', 'b', 'Sund')] }),
    ]);
    expect(within(row).getByText('Rolle: Gammel (ukendt/inaktiv)')).toBeInTheDocument();
    expect(within(row).getByText('Gruppe: Ukendt gruppe (ukendt/inaktiv)')).toBeInTheDocument();
    expect(within(row).getByText('Rolle: Sund')).toBeInTheDocument();
  });

  it('says so on a role nobody holds from their latest login (zero holders), never who holds it', async () => {
    const row = await rowOf([
      item({ targets: [], targetCount: 0, principalTargets: [P('role', 'a', 'Sagsbehandler', 'active', 0), P('role', 'b', 'Leder', 'active', 7)] }),
    ]);
    expect(within(row).getByText('Rolle: Sagsbehandler (0 personer har den ved seneste login)')).toBeInTheDocument();
    expect(within(row).getByText('Rolle: Leder')).toBeInTheDocument();
  });

  it('still warns that nobody has it when there is no unit, role or group', async () => {
    const row = await rowOf([item({ targets: [], targetCount: 0, principalTargets: [] })]);
    expect(within(row).getByText('Ikke til rådighed for nogen')).toBeInTheDocument();
  });
});

describe('CentralTemplatesAdmin — role catalogue refresh', () => {
  const THRESHOLD = {
    error: 'Opdateringen ville fjerne usædvanligt mange roller eller grupper fra kataloget og er afbrudt. Intet er ændret. Kontrollér Rollekatalog, eller gennemtving opdateringen.',
    code: 'removal_threshold',
  };
  const REFRESH = 'POST /api/admin/central-templates/roles/refresh';
  const withRefresh = { 'GET /api/admin/central-templates/roles': () => json({ ...ROLES, canRefresh: true, lastRefreshedAt: '2026-10-02T10:00:00.000Z' }) };

  it('offers the button only when the server says the caller may refresh (sync.run and a configured Rollekatalog)', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await screen.findByText('Bestyrelse');
    expect(screen.queryByRole('button', { name: 'Opdatér rollekatalog' })).toBeNull();
  });

  it('refreshes, reports what changed, and reloads the list and the catalogue', async () => {
    const post = vi.fn(() => json({ status: 'success', counts: { fetched: 12, added: 3, updated: 9, deactivated: 1, skipped: 0 }, errorCode: null }));
    const mock = setup(ADMIN_ME, { ...withRefresh, [REFRESH]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Opdatér rollekatalog' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Rollekataloget er opdateret: 12 roller og grupper, 3 nye, 1 fjernet.');
    expect(post).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls(mock, 'GET', '/api/admin/central-templates/roles').length).toBeGreaterThan(1));
  });

  it('shows the Danish reason when the refresh fails, and does not claim success', async () => {
    setup(ADMIN_ME, {
      ...withRefresh,
      [REFRESH]: () => json({ error: 'Rollekatalog afviste API-nøglen.', code: 'unauthorized' }, 502),
    });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Opdatér rollekatalog' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rollekatalog afviste API-nøglen.');
    expect(screen.queryByText(/Rollekataloget er opdateret/)).toBeNull();
  });

  it('offers a confirm-then-force step after the removal threshold aborted, and only then sends force', async () => {
    const post = vi.fn((_url?: string, _init?: RequestInit) => json(THRESHOLD, 502));
    setup(ADMIN_ME, { ...withRefresh, [REFRESH]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Opdatér rollekatalog' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gennemtving opdateringen?' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(post.mock.calls[0][1]?.body ?? '{}'))).toEqual({}); // the first attempt is never forced
    expect(dialog).toHaveTextContent('usædvanligt mange');

    post.mockImplementation(() => json({ status: 'success', counts: { fetched: 5, added: 0, updated: 5, deactivated: 9, skipped: 0 }, errorCode: null }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gennemtving opdateringen' }));
    expect(await screen.findByText(/Rollekataloget er opdateret: 5 roller og grupper, 0 nye, 9 fjernet/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(post.mock.calls[1][1]?.body))).toEqual({ force: true });
    expect(screen.queryByRole('dialog', { name: 'Gennemtving opdateringen?' })).toBeNull();
  });

  it('cancelling the confirmation sends nothing more and shows no error', async () => {
    const post = vi.fn(() => json(THRESHOLD, 502));
    setup(ADMIN_ME, { ...withRefresh, [REFRESH]: post });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Opdatér rollekatalog' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gennemtving opdateringen?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annuller' }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('other failures (also empty_response) are plain errors: no force is offered', async () => {
    setup(ADMIN_ME, { ...withRefresh, [REFRESH]: () => json({ error: 'Rollekatalog returnerede ingen roller eller grupper.', code: 'empty_response' }, 502) });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Opdatér rollekatalog' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ingen roller eller grupper');
    expect(screen.queryByRole('dialog', { name: 'Gennemtving opdateringen?' })).toBeNull();
  });

  it('outside claims mode the picker is explained instead of offered, but a global manager still gets org-wide templates', async () => {
    setup(ADMIN_ME, { 'GET /api/admin/central-templates/roles': () => json({ ...ROLES, canTarget: false, isGlobalManager: true, reason: 'needs_claims' }) });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ny central skabelon' }));
    await screen.findByRole('dialog', { name: 'Ny central skabelon' });
    expect(screen.queryByLabelText('Søg i roller og grupper')).toBeNull();
    expect(screen.getByText(/kun vælges, når rollerne kommer fra brugernes login/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Hele organisationen (ingen ejerenhed)' })).toBeInTheDocument();
  });

  it('passes the catalogue and the global-manager flag on to the editor, so a global manager can pick roles', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ny central skabelon' }));
    await screen.findByRole('dialog', { name: 'Ny central skabelon' });
    expect(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Hele organisationen (ingen ejerenhed)' })).toBeInTheDocument();
  });

  it('a scoped manager gets no role picker and must pick an owner', async () => {
    setup(READER_ME, { 'GET /api/admin/central-templates/roles': () => json({ ...ROLES, canTarget: false }) });
    renderWithToasts(<CentralTemplatesAdmin />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ny central skabelon' }));
    await screen.findByRole('dialog', { name: 'Ny central skabelon' });
    expect(screen.queryByLabelText('Søg i roller og grupper')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Hele organisationen (ingen ejerenhed)' })).toBeNull();
  });
});
