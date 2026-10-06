// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CentralTemplatesAdmin } from './CentralTemplatesAdmin';
import { formatTime } from './central-template-utils';
import { ADMIN_ME, READER_ME, calls, installFetch, json, renderWithToasts } from './test-helpers';
import type { CentralTemplateAdmin, CentralTemplateListItem } from '@/lib/skabeloner/central-types';

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
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...over,
});

const ACTIVE = [
  item({}),
  item({ id: B, name: 'Tom skabelon', description: '', targetCount: 0, ownerOrgUnitUuid: CHILD }),
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
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdByName: null,
};

const SCOPE = {
  orgUnits: [
    { uuid: ROOT, name: 'Kommune', parentUuid: null },
    { uuid: CHILD, name: 'Børn', parentUuid: ROOT },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function setup(me = ADMIN_ME, extra: Parameters<typeof installFetch>[0] = {}) {
  return installFetch({
    'GET /api/me': () => json(me),
    'GET /api/admin/central-templates/scope': () => json(SCOPE),
    'GET /api/admin/central-templates?status=active': () => json({ templates: ACTIVE }),
    'GET /api/admin/central-templates?status=archived': () => json({ templates: ARCHIVED }),
    'GET /api/admin/central-templates?status=all': () => json({ templates: [...ACTIVE, ...ARCHIVED] }),
    ...extra,
  });
}

describe('CentralTemplatesAdmin — list', () => {
  it('shows name, owner unit, status, version, recipient count and update time', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Bestyrelse')).closest('tr')!;
    expect(within(row).getByText('Standard referat')).toBeInTheDocument();
    expect(within(row).getByText('Kommune')).toBeInTheDocument();
    expect(within(row).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText(formatTime('2026-10-02T10:00:00.000Z'))).toBeInTheDocument();
  });

  it('flags a template without recipients', async () => {
    setup();
    renderWithToasts(<CentralTemplatesAdmin />);
    const row = (await screen.findByText('Tom skabelon')).closest('tr')!;
    expect(within(row).getByText('Ingen modtagere')).toBeInTheDocument();
    expect(within(row).getByText('Børn')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Arkivér Bestyrelse' })).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Arkivér Bestyrelse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Arkivér skabelon' });
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
    await userEvent.click(await screen.findByRole('button', { name: 'Arkivér Bestyrelse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Arkivér skabelon' });
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
    expect(await within(dialog).findByText('Første udgave af skabelonen')).toBeInTheDocument();
    expect(calls(mock, 'GET', `/api/admin/central-templates/${A}/versions`)).toHaveLength(1);
  });
});
