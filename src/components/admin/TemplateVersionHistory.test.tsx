// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemplateVersionHistory } from './TemplateVersionHistory';
import { installFetch, json } from './test-helpers';
import type { CentralTemplateContent, CentralTemplateVersion } from '@/lib/skabeloner/central-types';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT = '11111111-1111-4111-8111-111111111111';
const UNIT2 = '22222222-2222-4222-8222-222222222222';

const content = (over: Partial<CentralTemplateContent> = {}): CentralTemplateContent => ({
  name: 'Bestyrelse',
  description: '',
  prompt: 'Linje A\nLinje B',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
  allowUserInstruction: false,
  allowToggleOverrides: false,
  ...over,
});

const v = (over: Partial<CentralTemplateVersion>): CentralTemplateVersion => ({
  version: 1,
  changeType: 'create',
  changeNote: 'Første udgave af skabelonen',
  changedByName: 'Anne Admin',
  changedAt: '2026-10-01T10:00:00.000Z',
  content: content(),
  targets: [{ orgUnitUuid: UNIT, includeDescendants: true }],
  principalTargets: [],
  ...over,
});

// Newest first, as the route returns them.
const VERSIONS = [
  v({
    version: 3,
    changeType: 'retarget',
    changeNote: 'Gav ældreplejen adgang til skabelonen',
    changedByName: null,
    content: content({ prompt: 'Linje A\nLinje C', includeDato: true }),
    targets: [
      { orgUnitUuid: UNIT, includeDescendants: true },
      { orgUnitUuid: UNIT2, includeDescendants: false },
    ],
  }),
  v({
    version: 2,
    changeType: 'update',
    changeNote: 'Rettede anden linje og slog kategori til',
    content: content({ prompt: 'Linje A\nLinje C', includeDato: true }),
  }),
  v({ version: 1 }),
];

afterEach(() => vi.unstubAllGlobals());

const names = (uuid: string) => ({ [UNIT]: 'Børn', [UNIT2]: 'Ældre' })[uuid] ?? 'Ukendt enhed';

function setup(versions = VERSIONS) {
  installFetch({ [`GET /api/admin/central-templates/${ID}/versions`]: () => json({ versions }) });
  return render(<TemplateVersionHistory templateId={ID} unitName={names} />);
}

describe('TemplateVersionHistory', () => {
  it('lists versions newest first with type label, note, author and time', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Versioner' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => within(li).getByText(/^Version \d$/).textContent)).toEqual([
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    expect(within(items[0]).getByText('Tilgængelighed ændret')).toBeInTheDocument();
    expect(within(items[0]).getByText('Gav ældreplejen adgang til skabelonen')).toBeInTheDocument();
    expect(within(items[0]).getByText(/Ukendt ·/)).toBeInTheDocument();
    expect(within(items[1]).getByText('Ændret')).toBeInTheDocument();
    expect(within(items[1]).getByText(/Anne Admin ·/)).toBeInTheDocument();
    expect(within(items[2]).getByText('Oprettet')).toBeInTheDocument();
  });

  it('selects the newest version first; an unchanged prompt says so', async () => {
    setup();
    expect(await screen.findByText('Prompten er uændret.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Version 3 sammenlignet med version 2' })).toBeInTheDocument();
  });

  it('shows a unified diff when selecting a version whose prompt changed', async () => {
    setup();
    await screen.findByRole('list', { name: 'Versioner' });
    await userEvent.click(screen.getByRole('button', { name: /Version 2/ }));
    const diff = screen.getByRole('group', { name: 'Forskel i prompt' });
    const lines = [...diff.querySelectorAll('[data-diff]')].map((n) => [n.getAttribute('data-diff'), n.textContent]);
    expect(lines.map(([k]) => k)).toEqual(['equal', 'delete', 'insert']);
    expect(within(diff).getByText('Linje B')).toBeInTheDocument();
    expect(within(diff).getByText('Linje C')).toBeInTheDocument();
    expect(within(diff).getByText('Fjernet:')).toBeInTheDocument();
    expect(within(diff).getByText('Tilføjet:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Version 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('list', { name: 'Øvrige ændringer' })).toHaveTextContent('Kategori: Dato ændret');
  });

  it('lists target changes for a retarget', async () => {
    setup();
    const other = await screen.findByRole('list', { name: 'Øvrige ændringer' });
    expect(other).toHaveTextContent('Gjort tilgængelig for: Ældre');
    expect(other).not.toHaveTextContent('inkl. underenheder: Ældre');
    expect(other).not.toHaveTextContent(/modtager/i);
  });

  it('words availability changes: added (with subunits), removed and changed', async () => {
    const before = v({ version: 1, targets: [{ orgUnitUuid: UNIT, includeDescendants: true }] });
    const after = v({
      version: 2,
      changeType: 'retarget',
      changeNote: 'Flyttede adgangen',
      targets: [{ orgUnitUuid: UNIT2, includeDescendants: true }],
    });
    setup([after, before]);
    const other = await screen.findByRole('list', { name: 'Øvrige ændringer' });
    expect(other).toHaveTextContent('Gjort tilgængelig for: Ældre (inkl. underenheder)');
    expect(other).toHaveTextContent('Ikke længere tilgængelig for: Børn');
  });

  it('words a changed subunit setting', async () => {
    const wide = v({ version: 1, targets: [{ orgUnitUuid: UNIT2, includeDescendants: true }] });
    const narrow = v({ version: 2, changeType: 'retarget', changeNote: 'Kun enheden selv', targets: [{ orgUnitUuid: UNIT2, includeDescendants: false }] });
    setup([narrow, wide]);
    expect(await screen.findByRole('list', { name: 'Øvrige ændringer' })).toHaveTextContent('Tilgængelig for Ældre: kun enheden selv');
  });

  it('shows the change note first and prominently, then the changes', async () => {
    setup();
    const section = await screen.findByRole('region', { name: 'Version 3' });
    const text = section.textContent ?? '';
    expect(within(section).getByText('Ændringsbeskrivelse')).toBeInTheDocument();
    expect(within(section).getByText('Gav ældreplejen adgang til skabelonen')).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Ændringer' })).toBeInTheDocument();
    expect(text.indexOf('Gav ældreplejen adgang til skabelonen')).toBeLessThan(text.indexOf('Ændringer'));
    expect(text.indexOf('Ændringer')).toBeLessThan(text.indexOf('Prompten er uændret.'));
    expect(text.indexOf('Prompten er uændret.')).toBeLessThan(text.indexOf('Gjort tilgængelig for'));
  });

  it('shows the first version as all additions, with its note and initial availability', async () => {
    setup();
    await screen.findByRole('list', { name: 'Versioner' });
    await userEvent.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(screen.getByRole('heading', { name: /første version/ })).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Version 1' });
    expect(within(section).getByText('Første udgave af skabelonen', { selector: 'p' })).toBeInTheDocument();
    expect(within(section).getByText('Prompt (første version, alt er nyt)')).toBeInTheDocument();
    expect(within(section).getByRole('list', { name: 'Øvrige ændringer' })).toHaveTextContent(
      'Gjort tilgængelig for: Børn (inkl. underenheder)',
    );
    const diff = screen.getByRole('group', { name: 'Forskel i prompt' });
    expect([...diff.querySelectorAll('[data-diff]')].every((n) => n.getAttribute('data-diff') === 'insert')).toBe(true);
  });

  it('shows an error with retry', async () => {
    installFetch({ [`GET /api/admin/central-templates/${ID}/versions`]: () => json({ error: 'x' }, 404) });
    render(<TemplateVersionHistory templateId={ID} unitName={names} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ikke fundet.');
  });

  it('words role and group changes with the names they had in each version ("Gjort tilgængelig for: …")', async () => {
    const before = v({ version: 1, principalTargets: [{ kind: 'role', identifier: 'a', name: 'Sagsbehandler' }] });
    const after = v({
      version: 2,
      changeType: 'retarget',
      changeNote: 'Skiftede målgruppe',
      principalTargets: [
        { kind: 'group', identifier: 'g', name: 'Socialforvaltningen' },
        { kind: 'role', identifier: 'b', name: 'Leder' },
      ],
    });
    setup([after, before]);
    const other = await screen.findByRole('list', { name: 'Øvrige ændringer' });
    expect(other).toHaveTextContent('Gjort tilgængelig for: Socialforvaltningen (gruppe)');
    expect(other).toHaveTextContent('Gjort tilgængelig for: Leder (rolle)');
    expect(other).toHaveTextContent('Ikke længere tilgængelig for: Sagsbehandler (rolle)');
  });

  it('copes with a version written before role/group targets existed', async () => {
    const same = [{ kind: 'role' as const, identifier: 'a', name: 'Sagsbehandler' }];
    const old = { ...v({ version: 1 }), principalTargets: undefined } as unknown as CentralTemplateVersion;
    const next = v({ version: 2, changeType: 'update', changeNote: 'Rettet teksten lidt', content: content({ includeDato: true }), principalTargets: same });
    setup([next, old]);
    const other = await screen.findByRole('list', { name: 'Øvrige ændringer' });
    // From "none" to "one role" is a change; the old version simply had none.
    expect(other).toHaveTextContent('Gjort tilgængelig for: Sagsbehandler (rolle)');
  });

  it('says nothing about roles when they did not change between two versions', async () => {
    const same = [{ kind: 'role' as const, identifier: 'a', name: 'Sagsbehandler' }];
    const first = v({ version: 1, principalTargets: same });
    const second = v({ version: 2, changeType: 'update', changeNote: 'Slog kategorien til', content: content({ includeDato: true }), principalTargets: same });
    setup([second, first]);
    const other = await screen.findByRole('list', { name: 'Øvrige ændringer' });
    expect(other).toHaveTextContent('Kategori: Dato ændret');
    expect(other).not.toHaveTextContent('Sagsbehandler');
  });
});
