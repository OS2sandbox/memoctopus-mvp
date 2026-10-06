// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CentralTemplateEditor } from './CentralTemplateEditor';
import { formatTime } from './central-template-utils';
import { calls, installFetch, json, renderWithToasts } from './test-helpers';
import type { CentralScopeOrgUnit, CentralTemplateAdmin } from '@/lib/skabeloner/central-types';

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
  ownerOrgUnitUuid: ROOT,
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
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdByName: 'Anne Admin',
  lastEditedByName: 'Bo Beslutter',
  lastEditedAt: '2026-10-02T11:30:00.000Z',
};

const NOTE = 'Rettede formuleringen i prompten';

afterEach(() => vi.unstubAllGlobals());

function setup(template: CentralTemplateAdmin | null, routes: Parameters<typeof installFetch>[0] = {}) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  const mock = installFetch(routes);
  renderWithToasts(
    <CentralTemplateEditor open onOpenChange={onOpenChange} template={template} units={UNITS} onSaved={onSaved} />,
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
    expect(screen.getByText('Vælg en ejerenhed')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), ROOT);
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
    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), ROOT);
    await userEvent.type(screen.getByLabelText('Navn'), 'Ny skabelon');
    await userEvent.type(screen.getByLabelText('Prompt'), 'Skriv kort');
    await userEvent.click(screen.getByLabelText('Modtager: Børn'));
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), `  ${NOTE}  `);
    await userEvent.click(saveButton('Opret skabelon'));

    expect(body(mock, 'POST', '/api/admin/central-templates')).toEqual({
      ownerOrgUnitUuid: ROOT,
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
      changeNote: NOTE,
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns about zero recipients and keeps both user permissions off by default', () => {
    setup(null);
    expect(screen.queryByText(/Ingen modtagere/)).toBeNull(); // only once an owner is chosen
    expect(screen.getByRole('switch', { name: /egen instruktion/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /slå kategorier til og fra/ })).not.toBeChecked();
    expect(screen.getByText(/Slået fra: prompten bruges uændret/)).toBeInTheDocument();
    expect(screen.getByText(/Slået fra: kategorierne ovenfor er faste/)).toBeInTheDocument();
  });

  it('shows Ingen modtagere once an owner is chosen, and offers only that subtree', async () => {
    setup(null);
    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), CHILD);
    expect(screen.getByRole('status')).toHaveTextContent('Ingen modtagere');
    expect(screen.getByLabelText('Modtager: Børn')).toBeInTheDocument();
    expect(screen.queryByLabelText('Modtager: Kommune')).toBeNull();
    expect(screen.queryByLabelText('Modtager: Andet')).toBeNull();
  });

  it('drops targets that fall outside the subtree when the owner changes', async () => {
    const { mock } = setup(null, { 'POST /api/admin/central-templates': () => json({ template: TEMPLATE }, 201) });
    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), ROOT);
    await userEvent.click(screen.getByLabelText('Modtager: Børn'));
    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), OTHER);
    expect(screen.queryByLabelText('Modtager: Børn')).toBeNull();
    await userEvent.type(screen.getByLabelText('Navn'), 'N');
    await userEvent.type(screen.getByLabelText('Prompt'), 'P');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Opret skabelon'));
    expect(body(mock, 'POST', '/api/admin/central-templates').targets).toEqual([]);
  });

  it('shows the server message when the API refuses', async () => {
    setup(null, {
      'POST /api/admin/central-templates': () =>
        json({ error: 'Enheden findes ikke', code: 'org_unit_not_found' }, 404),
    });
    await userEvent.selectOptions(screen.getByLabelText('Ejerenhed'), ROOT);
    await userEvent.type(screen.getByLabelText('Navn'), 'N');
    await userEvent.type(screen.getByLabelText('Prompt'), 'P');
    await userEvent.type(screen.getByLabelText('Ændringsbeskrivelse'), NOTE);
    await userEvent.click(saveButton('Opret skabelon'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enheden findes ikke');
  });
});

describe('CentralTemplateEditor — edit', () => {
  it('requires a real change and shows the version', () => {
    setup(TEMPLATE);
    expect(screen.getByText('Version 3')).toBeInTheDocument();
    expect(screen.getByText('Ejerenhed:').closest('p')).toHaveTextContent('Ejerenhed: Kommune');
    expect(screen.queryByLabelText('Ejerenhed')).toBeNull();
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
    expect(screen.getByRole('group', { name: 'Modtagere' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Kategorier' })).toBeInTheDocument();
  });
});
