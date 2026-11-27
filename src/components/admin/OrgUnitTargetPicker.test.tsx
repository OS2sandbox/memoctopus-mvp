// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgUnitTargetPicker } from './OrgUnitTargetPicker';
import type { CentralTarget } from '@/lib/skabeloner/central-types';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRAND = '33333333-3333-4333-8333-333333333333';
const SIBLING = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const GONE = '66666666-6666-4666-8666-666666666666';

const UNITS = [
  { uuid: GRAND, name: 'Vuggestue', parentUuid: CHILD },
  { uuid: CHILD, name: 'Børn', parentUuid: ROOT },
  { uuid: ROOT, name: 'Kommune', parentUuid: null },
  { uuid: SIBLING, name: 'Ældre', parentUuid: ROOT },
  { uuid: OTHER, name: 'Andet', parentUuid: null },
];

function setup(value: CentralTarget[] = []) {
  const onChange = vi.fn();
  render(<OrgUnitTargetPicker units={UNITS} value={value} onChange={onChange} />);
  return onChange;
}

describe('OrgUnitTargetPicker', () => {
  it('offers every unit of the organisation, across separate trees', () => {
    setup();
    for (const name of ['Kommune', 'Børn', 'Vuggestue', 'Ældre', 'Andet']) {
      expect(screen.getByLabelText(`Til rådighed for: ${name}`)).toBeInTheDocument();
    }
  });

  it('indents the tree by depth', () => {
    setup();
    const depths = screen.getAllByRole('listitem').map((li) => li.getAttribute('data-depth'));
    expect(depths).toEqual(['0', '0', '1', '2', '1']);
  });

  it('adds a target with descendants included by default', async () => {
    const onChange = setup();
    await userEvent.click(screen.getByLabelText('Til rådighed for: Børn'));
    expect(onChange).toHaveBeenCalledWith([{ orgUnitUuid: CHILD, includeDescendants: true }]);
  });

  it('toggles inkl. underenheder per target and removes a target', async () => {
    const onChange = setup([{ orgUnitUuid: CHILD, includeDescendants: true }]);
    expect(screen.queryByLabelText('Inkl. underenheder: Ældre')).toBeNull();
    await userEvent.click(screen.getByLabelText('Inkl. underenheder: Børn'));
    expect(onChange).toHaveBeenLastCalledWith([{ orgUnitUuid: CHILD, includeDescendants: false }]);
    await userEvent.click(screen.getByLabelText('Til rådighed for: Børn'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('warns that nobody has the template with zero targets and not otherwise', () => {
    const { unmount } = render(<OrgUnitTargetPicker units={UNITS} value={[]} onChange={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Skabelonen er ikke til rådighed for nogen');
    unmount();
    render(
      <OrgUnitTargetPicker
        units={UNITS}
        value={[{ orgUnitUuid: ROOT, includeDescendants: true }]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a target whose unit no longer exists removable', async () => {
    const onChange = setup([{ orgUnitUuid: GONE, includeDescendants: true }]);
    expect(screen.getByText('Enhed, der ikke findes længere')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fjern' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('is a labelled group', () => {
    setup();
    expect(screen.getByRole('group', { name: 'Hvem skal have skabelonen til rådighed?' })).toBeInTheDocument();
  });

  it('explains the choice in terms of who may use the template, without the word recipient', () => {
    const { container } = render(<OrgUnitTargetPicker units={UNITS} value={[]} onChange={() => {}} />);
    expect(container).toHaveTextContent(
      'Vælg de enheder, hvis medarbejdere kan bruge skabelonen. Underenheder kan vælges med.',
    );
    expect(container.textContent ?? '').not.toMatch(/modtag/i);
  });
});
