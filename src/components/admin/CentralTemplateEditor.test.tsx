// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CentralTemplateEditor } from './CentralTemplateEditor';
import { formatTime } from './central-template-utils';
import { calls, installFetch, json, renderWithToasts } from './test-helpers';
import type { CentralCatalogueEntry, CentralScopeOrgUnit, CentralTemplateAdmin } from '@/lib/skabeloner/central-types';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const UNITS: CentralScopeOrgUnit[] = [
  { uuid: CHILD, name: 'Børn', parentUuid: ROOT },
  { uuid: ROOT, name: 'Kommune', parentUuid: null },
  { uuid: OTHER, name: 'Andet', parentUuid: null },
];

const TEMPLATE: CentralTemplateAdmin = {
  id: ID,
  name: 'Bestyrelse',
  description: 'Standard',
  prompt: 'Linje A\nLinje B',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
  allowUserInstruction: false,
  allowToggleOverrides: false,
  status: 'active',
  currentVersion: 3,
  targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
  principalTargets: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdByName: 'Anne Admin',
  lastEditedByName: 'Bo Beslutter',
  lastEditedAt: '2026-10-02T11:30:00.000Z',
};

const NOTE = 'Rettede formuleringen i prompten';

afterEach(() => vi.unstubAllGlobals());

function setup(
  template: CentralTemplateAdmin | null,
  routes: Parameters<typeof installFetch>[0] = {},
  extra: Partial<React.ComponentProps<typeof CentralTemplateEditor>> = {},
) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  const mock = installFetch(routes);
  renderWithToasts(
    <CentralTemplateEditor open onOpenChange={onOpenChange} template={template} units={UNITS} onSaved={onSaved} {...extra} />,
  );
  return { mock, onSaved, onOpenChange };
}

const saveButton = (name: RegExp | string) => screen.getByRole('button', { name });
const body = (mock: ReturnType<typeof installFetch>, method: string, prefix: string) =>
  JSON.parse(calls(mock, method, prefix)[0][1]!.body as string);

describe('CentralTemplateEditor — create', () => {
  it('disables save and states the reason until everything is valid', async () => {
    setup(null);
    const save = saveButton('Opret skabelon');
    expect(save).toBeDisabled();
    expect(screen.getByText('Angiv et navn')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Navn'), 'Ny skabelon');
    expect(screen.getByText('Angiv en prompt')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Prompt'), 'Skriv kort');
    expect(screen.getByText('Beskriv ændringen (mindst 10 tegn)')).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('Beskriv ændringen (mindst 10 tegn)');

    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), 'kort');
    expect(screen.getByText('4 / 10 tegn mindst')).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), ' og klar');
    expect(save).toBeEnabled();
    expect(screen.queryByText('Beskriv ændringen (mindst 10 tegn)')).toBeNull();
  });

  it('does not count surrounding whitespace towards the note', async () => {
    setup(null);
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), '     abc      ');
    expect(screen.getByText('3 / 10 tegn mindst')).toBeInTheDocument();
  });

  it('posts content, targets and the trimmed note, then reports success', async () => {
    const { mock, onSaved, onOpenChange } = setup(null, {
      'POST /api/admin/central-templates': () => json({ template: TEMPLATE }, 201),
    });
    await userEvent.type(screen.getByLabelText('Navn'), 'Ny skabelon');
    await userEvent.type(screen.getByLabelText('Prompt'), 'Skriv kort');
    await userEvent.click(screen.getByLabelText('Til rådighed for: Børn'));
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), `  ${NOTE}  `);
    await userEvent.click(saveButton('Opret skabelon'));

    expect(body(mock, 'POST', '/api/admin/central-templates')).toEqual({
      name: 'Ny skabelon',
      description: '',
      prompt: 'Skriv kort',
      includeDeltagere: false,
      includeBeslutningspunkter: false,
      includeDagsorden: false,
      includeDato: false,
      allowUserInstruction: false,
      allowToggleOverrides: false,
      targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
      principalTargets: [],
      changeNote: NOTE,
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns about zero recipients and keeps both user permissions off by default', () => {
    setup(null);
    expect(screen.getByRole('status')).toHaveTextContent('Skabelonen er ikke til rådighed for nogen');
    expect(screen.getByRole('switch', { name: /egen instruktion/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /slå kategorier til og fra/ })).not.toBeChecked();
    expect(screen.getByText(/Slået fra: prompten bruges uændret/)).toBeInTheDocument();
    expect(screen.getByText(/Slået fra: kategorierne ovenfor er faste/)).toBeInTheDocument();
  });

  it('has no Ejerenhed and offers every unit of the organisation as audience', () => {
    setup(null);
    expect(screen.queryByLabelText('Ejerenhed')).toBeNull();
    expect(screen.queryByText(/ejerenhed/i)).toBeNull();
    for (const name of ['Kommune', 'Børn', 'Andet']) {
      expect(screen.getByLabelText(`Til rådighed for: ${name}`)).toBeInTheDocument();
    }
  });

  it('sends units from separate trees in one audience, and never an owner', async () => {
    const { mock } = setup(null, { 'POST /api/admin/central-templates': () => json({ template: TEMPLATE }, 201) });
    await userEvent.click(screen.getByLabelText('Til rådighed for: Børn'));
    await userEvent.click(screen.getByLabelText('Til rådighed for: Andet'));
    await userEvent.type(screen.getByLabelText('Navn'), 'N');
    await userEvent.type(screen.getByLabelText('Prompt'), 'P');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Opret skabelon'));
    const sent = body(mock, 'POST', '/api/admin/central-templates');
    expect(sent.targets).toEqual([
      { orgUnitUuid: CHILD, includeDescendants: true },
      { orgUnitUuid: OTHER, includeDescendants: true },
    ]);
    expect(sent).not.toHaveProperty('ownerOrgUnitUuid');
  });

  it('shows the server message when the API refuses', async () => {
    setup(null, {
      'POST /api/admin/central-templates': () =>
        json({ error: 'En valgt enhed findes ikke', code: 'target_unknown' }, 400),
    });
    await userEvent.type(screen.getByLabelText('Navn'), 'N');
    await userEvent.type(screen.getByLabelText('Prompt'), 'P');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Opret skabelon'));
    expect(await screen.findByRole('alert')).toHaveTextContent('En valgt enhed findes ikke');
  });
});

describe('CentralTemplateEditor — edit', () => {
  it('requires a real change and shows the version', () => {
    setup(TEMPLATE);
    expect(screen.getByText('Version 3')).toBeInTheDocument();
    expect(screen.queryByText(/Ejerenhed/)).toBeNull();
    expect(saveButton('Gem ændringer')).toBeDisabled();
    expect(screen.getByText('Ingen ændringer at gemme')).toBeInTheDocument();
  });

  it('shows who last edited the template and when', () => {
    setup(TEMPLATE);
    const line = screen.getByText('Version 3').closest('p')!;
    expect(line).toHaveTextContent(`Senest ændret af Bo Beslutter, ${formatTime('2026-10-02T11:30:00.000Z')}`);
  });

  it('says ukendt when the last editor has no name snapshot', () => {
    setup({ ...TEMPLATE, lastEditedByName: null });
    expect(screen.getByText('Version 3').closest('p')).toHaveTextContent('Senest ændret af ukendt,');
  });

  it('sends baseVersion, the note and only what changed', async () => {
    const { mock, onSaved } = setup(TEMPLATE, {
      [`PUT /api/admin/central-templates/${ID}`]: () => json({ template: { ...TEMPLATE, currentVersion: 4 } }),
    });
    await userEvent.clear(screen.getByLabelText('Navn'));
    await userEvent.type(screen.getByLabelText('Navn'), 'Nyt navn');
    await userEvent.click(screen.getByRole('switch', { name: /egen instruktion/ }));
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    expect(screen.getByRole('region', { name: 'Dette gemmer du' })).toHaveTextContent('Navn ændres');
    await userEvent.click(saveButton('Gem ændringer'));
    expect(body(mock, 'PUT', `/api/admin/central-templates/${ID}`)).toEqual({
      baseVersion: 3,
      changeNote: NOTE,
      name: 'Nyt navn',
      allowUserInstruction: true,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends targets only when the recipients changed', async () => {
    const { mock } = setup(TEMPLATE, {
      [`PUT /api/admin/central-templates/${ID}`]: () => json({ template: TEMPLATE }),
    });
    await userEvent.click(screen.getByLabelText('Inkl. underenheder: Børn'));
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Gem ændringer'));
    expect(body(mock, 'PUT', `/api/admin/central-templates/${ID}`)).toEqual({
      baseVersion: 3,
      changeNote: NOTE,
      targets: [{ orgUnitUuid: CHILD, includeDescendants: false }],
    });
  });
});

describe('CentralTemplateEditor — concurrent edit', () => {
  const LATEST: CentralTemplateAdmin = {
    ...TEMPLATE,
    currentVersion: 5,
    prompt: 'Linje A\nLinje fra kollega',
    includeDato: true,
  };

  async function conflict(routes: Parameters<typeof installFetch>[0] = {}) {
    const put = vi.fn(() => json({ error: 'x', code: 'version_conflict', currentVersion: 5 }, 409));
    const view = setup(TEMPLATE, {
      [`PUT /api/admin/central-templates/${ID}`]: put,
      [`GET /api/admin/central-templates/${ID}`]: () => json({ template: LATEST }),
      ...routes,
    });
    await userEvent.clear(screen.getByLabelText('Prompt'));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Min egen tekst');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Gem ændringer'));
    return { ...view, put };
  }

  it('shows the Danish conflict message, blocks saving and does not close', async () => {
    const { onOpenChange, onSaved } = await conflict();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skabelonen er ændret af en anden (version 5). Genindlæs for at se ændringerne.',
    );
    expect(saveButton('Gem ændringer')).toBeDisabled();
    expect(screen.getByText('Genindlæs den gemte version, før du gemmer')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('reload keeps the unsaved text and shows the saved version against it', async () => {
    await conflict();
    await userEvent.click(await screen.findByRole('button', { name: 'Genindlæs' }));
    const panel = await screen.findByRole('region', { name: 'Seneste gemte version' });
    expect(within(panel).getByText(/version 5/)).toBeInTheDocument();
    expect(within(panel).getByText('Linje fra kollega')).toBeInTheDocument(); // removed from mine
    expect(within(panel).getByText('Min egen tekst')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('Min egen tekst');
    expect(screen.getByLabelText('Ændringsbeskrivelse')).toHaveValue(NOTE);
  });

  it('then saves against the new version only after an explicit second save', async () => {
    const { put } = await conflict();
    await userEvent.click(await screen.findByRole('button', { name: 'Genindlæs' }));
    await screen.findByRole('region', { name: 'Seneste gemte version' });
    put.mockImplementation(() => json({ template: { ...LATEST, currentVersion: 6 } }));
    expect(put).toHaveBeenCalledTimes(1);
    await userEvent.click(saveButton('Gem ændringer'));
    expect(put).toHaveBeenCalledTimes(2);
    const sent = JSON.parse((put.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.baseVersion).toBe(5);
  });

  it('can discard the user changes and adopt the saved version', async () => {
    await conflict();
    await userEvent.click(await screen.findByRole('button', { name: 'Genindlæs' }));
    await userEvent.click(await screen.findByRole('button', { name: /Kassér mine ændringer/ }));
    expect(screen.getByLabelText('Prompt')).toHaveValue(LATEST.prompt);
    expect(screen.queryByRole('region', { name: 'Seneste gemte version' })).toBeNull();
    expect(screen.getByText('Version 5')).toBeInTheDocument();
  });

  it('blocks saving when the other person archived it meanwhile', async () => {
    await conflict({
      [`GET /api/admin/central-templates/${ID}`]: () => json({ template: { ...LATEST, status: 'archived' } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Genindlæs' }));
    await screen.findByRole('region', { name: 'Seneste gemte version' });
    expect(saveButton('Gem ændringer')).toBeDisabled();
    expect(screen.getByText('Skabelonen er arkiveret. Gendan den, før du ændrer den')).toBeInTheDocument();
  });
});

describe('CentralTemplateEditor — a11y', () => {
  it('exposes the form as a labelled dialog with labelled required fields', () => {
    setup(TEMPLATE);
    expect(screen.getByRole('dialog', { name: 'Rediger central skabelon' })).toBeInTheDocument();
    expect(screen.getByLabelText('Navn')).toBeRequired();
    expect(screen.getByLabelText('Prompt')).toBeRequired();
    expect(screen.getByLabelText('Ændringsbeskrivelse')).toBeRequired();
    expect(screen.getByRole('group', { name: 'Hvem skal have skabelonen til rådighed?' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Kategorier' })).toBeInTheDocument();
  });
});

describe('CentralTemplateEditor — closing with unsaved text', () => {
  const confirmDialog = () => screen.queryByRole('dialog', { name: 'Kassér ændringer?' });

  it('closes at once on Escape and Annuller while nothing has been typed', async () => {
    const { onOpenChange } = setup(null);
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(confirmDialog()).toBeNull();
  });

  it('closes at once on Annuller for an unchanged existing template', async () => {
    const { onOpenChange } = setup(TEMPLATE);
    await userEvent.click(screen.getByRole('button', { name: 'Annuller' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks before Escape discards typed text, keeps the text on "Fortsæt redigering"', async () => {
    const { onOpenChange } = setup(null);
    await userEvent.type(screen.getByLabelText('Prompt'), 'En lang prompt jeg ikke vil miste');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Kassér ændringer?' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Fortsæt redigering' }));
    expect(confirmDialog()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Prompt')).toHaveValue('En lang prompt jeg ikke vil miste');
  });

  it('closes only after "Kassér og luk"', async () => {
    const { onOpenChange } = setup(null);
    await userEvent.type(screen.getByLabelText('Navn'), 'X');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: 'Kassér og luk' }));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks before Annuller discards, and a started change note counts as unsaved', async () => {
    const { onOpenChange } = setup(TEMPLATE);
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), 'halvt skrevet');
    await userEvent.click(screen.getByRole('button', { name: 'Annuller' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Kassér ændringer?' })).toBeInTheDocument();
  });

  it('asks before a click outside the dialog discards a changed existing template', async () => {
    const { onOpenChange } = setup(TEMPLATE);
    await userEvent.type(screen.getByLabelText('Prompt'), ' ekstra');
    const overlay = document.querySelector('.bg-black\\/40') as HTMLElement;
    expect(overlay).not.toBeNull();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Kassér ændringer?' })).toBeInTheDocument();
  });

  it('cannot be closed by Escape while a save is in flight', async () => {
    let finish!: () => void;
    const pending = new Promise<Response>((resolve) => {
      finish = () =>
        resolve(new Response(JSON.stringify({ template: TEMPLATE }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    const { onOpenChange, onSaved } = setup(TEMPLATE, { [`PUT /api/admin/central-templates/${ID}`]: () => pending });
    await userEvent.type(screen.getByLabelText('Prompt'), ' ekstra');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Gem ændringer'));
    expect(await screen.findByRole('button', { name: 'Gemmer …' })).toBeDisabled();

    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull(); // no prompt either: the request is in flight

    finish();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false); // a successful save closes without asking
  });
});

const CATALOGUE: CentralCatalogueEntry[] = [
  { kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler', source: 'rollekatalog', active: true, holders: 4 },
  { kind: 'group', identifier: 'social', name: 'Socialforvaltningen', source: 'config', active: true, holders: 2 },
  { kind: 'role', identifier: 'gammel', name: 'Gammel rolle', source: 'rollekatalog', active: false, holders: 0 },
];

describe('CentralTemplateEditor — role/group targets', () => {
  // Claims mode: roles and groups can be targeted (the roles route says canTarget).
  const GLOBAL = { catalogue: CATALOGUE, canTargetPrincipals: true };

  it('without org units (claims mode) there is no unit picker, just the roles and groups', () => {
    setup(null, {}, { ...GLOBAL, units: [] });
    expect(screen.queryByText(/ejerenhed/i)).toBeNull();
    expect(screen.queryByText('Hvem skal have skabelonen til rådighed?')).toBeNull();
    expect(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler')).toBeInTheDocument();
  });

  it('creates a template targeted at a role and a group: only kind and identifier are sent, never an owner', async () => {
    const { mock } = setup(null, { 'POST /api/admin/central-templates': () => json({ template: TEMPLATE }, 201) }, { ...GLOBAL, units: [] });
    await userEvent.type(screen.getByLabelText('Navn'), 'Ny skabelon');
    await userEvent.type(screen.getByLabelText('Prompt'), 'Skriv kort');
    await userEvent.click(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler'));
    await userEvent.click(screen.getByLabelText('Til rådighed for gruppe: Socialforvaltningen'));
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Opret skabelon'));
    const sent = body(mock, 'POST', '/api/admin/central-templates');
    expect(sent).not.toHaveProperty('ownerOrgUnitUuid');
    expect(sent.targets).toEqual([]);
    expect(sent.principalTargets).toEqual([
      { kind: 'role', identifier: 'sagsbehandler' },
      { kind: 'group', identifier: 'social' },
    ]);
  });

  it('role/group targets alone are an audience: no "ikke til rådighed for nogen" warning', async () => {
    setup(null, {}, GLOBAL);
    expect(screen.getByRole('status')).toHaveTextContent('ikke til rådighed for nogen');
    await userEvent.click(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('editing: shows the chosen roles with name, kind and identifier, flags a withdrawn one and sends the change as a diff', async () => {
    const withTargets = {
      ...TEMPLATE,
      principalTargets: [
        { kind: 'role' as const, identifier: 'sagsbehandler', name: 'Sagsbehandler', status: 'active' as const, holders: 4 },
        { kind: 'role' as const, identifier: 'gammel', name: 'Gammel rolle', status: 'inactive' as const, holders: 0 },
        { kind: 'group' as const, identifier: 'findes-ikke', name: 'Slettet gruppe', status: 'active' as const, holders: 1 },
      ],
    };
    const { mock } = setup(withTargets, { [`PUT /api/admin/central-templates/${ID}`]: () => json({ template: withTargets }) }, GLOBAL);

    const chosen = screen.getByRole('list', { name: 'Valgte roller og grupper' });
    expect(within(chosen).getByText('Sagsbehandler')).toBeInTheDocument();
    expect(within(chosen).getByText('sagsbehandler')).toBeInTheDocument(); // identifier, small
    // The withdrawn one and the one the catalogue no longer knows are flagged; the healthy one is not.
    const flagged = within(chosen).getAllByText('ukendt/inaktiv');
    expect(flagged).toHaveLength(2);
    expect(saveButton('Gem ændringer')).toBeDisabled();

    await userEvent.click(within(chosen).getByRole('button', { name: 'Fjern rolle: Gammel rolle' }));
    expect(screen.getByRole('region', { name: 'Dette gemmer du' })).toHaveTextContent('Ikke længere tilgængelig for: Gammel rolle (rolle)');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Gem ændringer'));
    expect(body(mock, 'PUT', `/api/admin/central-templates/${ID}`)).toEqual({
      baseVersion: 3,
      changeNote: NOTE,
      principalTargets: [
        { kind: 'role', identifier: 'sagsbehandler' },
        { kind: 'group', identifier: 'findes-ikke' },
      ],
    });
  });

  it('shows a chosen target as an unknown one when the catalogue does not list it any more', () => {
    setup({ ...TEMPLATE, principalTargets: [{ kind: 'role', identifier: 'x', name: 'Borte', status: 'active', holders: 1 }] }, {}, GLOBAL);
    const chosen = screen.getByRole('list', { name: 'Valgte roller og grupper' });
    expect(within(chosen).getByText('ukendt/inaktiv')).toBeInTheDocument();
  });

  it('outside claims mode the roles of a template are read-only (no remove button) and a save does not send them', async () => {
    const t = { ...TEMPLATE, principalTargets: [{ kind: 'role' as const, identifier: 'sagsbehandler', name: 'Sagsbehandler', status: 'active' as const, holders: 4 }] };
    const { mock } = setup(t, { [`PUT /api/admin/central-templates/${ID}`]: () => json({ template: t }) }, { catalogue: CATALOGUE, canTargetPrincipals: false, targetLockedReason: 'needs_claims' });
    expect(within(screen.getByRole('list', { name: 'Valgte roller og grupper' })).getByText('Sagsbehandler')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fjern rolle/ })).toBeNull();
    await userEvent.clear(screen.getByLabelText('Navn'));
    await userEvent.type(screen.getByLabelText('Navn'), 'Nyt');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Gem ændringer'));
    expect(body(mock, 'PUT', `/api/admin/central-templates/${ID}`)).not.toHaveProperty('principalTargets');
  });

  it('the picker offers only active entries, searches by name and identifier, and says when the catalogue is empty', async () => {
    setup(null, {}, GLOBAL);
    expect(screen.queryByLabelText('Til rådighed for rolle: Gammel rolle')).toBeNull();
    await userEvent.type(screen.getByLabelText('Søg i roller og grupper'), 'soc');
    expect(screen.getByLabelText('Til rådighed for gruppe: Socialforvaltningen')).toBeInTheDocument();
    expect(screen.queryByLabelText('Til rådighed for rolle: Sagsbehandler')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Søg i roller og grupper'));
    await userEvent.type(screen.getByLabelText('Søg i roller og grupper'), 'sagsb');
    expect(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Søg i roller og grupper'), 'zzz');
    expect(screen.getByText('Ingen roller eller grupper matcher')).toBeInTheDocument();
    cleanup();

    setup(null, {}, { catalogue: [], canTargetPrincipals: true });
    expect(screen.getByText(/Rollekataloget er tomt/)).toBeInTheDocument();
  });

  it('a started role choice counts as unsaved text', async () => {
    setup(null, {}, GLOBAL);
    await userEvent.click(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler'));
    await userEvent.click(screen.getByRole('button', { name: 'Annuller' }));
    expect(await screen.findByText('Kassér ændringer?')).toBeInTheDocument();
  });

  it('without org units, an empty audience is warned about by the role picker (the unit picker is not on screen)', async () => {
    setup(null, {}, { ...GLOBAL, units: [] });
    expect(screen.getByRole('status')).toHaveTextContent('Ingen roller, grupper eller enheder er valgt');
    await userEvent.click(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('zero-match feedback: a role nobody holds from their latest login is flagged in the list and once chosen', async () => {
    const quiet = [{ ...CATALOGUE[0], holders: 0 }, { ...CATALOGUE[1], holders: 12 }];
    setup(null, {}, { catalogue: quiet, canTargetPrincipals: true });
    const list = screen.getByRole('list', { name: 'Roller og grupper' });
    expect(within(list).getByText('0 personer har den ved seneste login')).toBeInTheDocument();
    expect(within(list).getByText('12 personer har den')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Til rådighed for rolle: Sagsbehandler'));
    const chosen = screen.getByRole('list', { name: 'Valgte roller og grupper' });
    expect(within(chosen).getByText('0 personer har den ved seneste login')).toBeInTheDocument();
  });

  it('outside claims mode the picker is replaced by the reason (roles come from login claims), and units stay available', () => {
    setup(null, {}, { catalogue: CATALOGUE, canTargetPrincipals: false, targetLockedReason: 'needs_claims' });
    expect(screen.getByText(/kun vælges, når rollerne kommer fra brugernes login/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Søg i roller og grupper')).toBeNull();
    expect(screen.getByLabelText('Til rådighed for: Kommune')).toBeInTheDocument();
  });

  it('by default (no canTargetPrincipals) roles and groups cannot be picked', () => {
    setup(null, {}, { catalogue: CATALOGUE, targetLockedReason: 'needs_claims' });
    expect(screen.queryByLabelText('Søg i roller og grupper')).toBeNull();
  });

  it('the locked picker says which route applies in local and Rollekatalog mode', () => {
    setup(null, {}, { catalogue: CATALOGUE, canTargetPrincipals: false, targetLockedReason: 'needs_claims', accessSource: 'local' });
    expect(screen.getByText(/mens rollerne styres i appen/)).toBeInTheDocument();
    expect(screen.getByText(/Her deles en skabelon med enheder/)).toBeInTheDocument();
    expect(screen.getByText(/appen sættes til ACCESS_SOURCE=claims/)).toBeInTheDocument();
  });

  it('when the catalogue failed to load, targets keep the status the server gave them (not everything "ukendt/inaktiv")', () => {
    const t = {
      ...TEMPLATE,
      principalTargets: [
        { kind: 'role' as const, identifier: 'sagsbehandler', name: 'Sagsbehandler', status: 'active' as const, holders: 4 },
        { kind: 'role' as const, identifier: 'gammel', name: 'Gammel rolle', status: 'inactive' as const, holders: 0 },
      ],
    };
    setup(t, {}, { catalogue: [], catalogueLoaded: false, canTargetPrincipals: true });
    const chosen = screen.getByRole('list', { name: 'Valgte roller og grupper' });
    expect(within(chosen).getAllByText('ukendt/inaktiv')).toHaveLength(1); // only the one the server itself calls inactive
    expect(within(chosen).getByText('Sagsbehandler')).toBeInTheDocument();
    // Without a catalogue nothing can be added, so the picker is locked rather than claiming it is empty.
    expect(screen.queryByLabelText('Søg i roller og grupper')).toBeNull();
  });
});
