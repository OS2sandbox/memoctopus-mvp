'use client';

import { useMemo } from 'react';
import type { CentralTarget } from '@/lib/skabeloner/central-types';
import { flattenOrgTree, selfAndDescendants, type TreeUnit } from './org-tree';

interface Props {
  /** All units the caller may see (scope route). Only the owner's subtree is offered. */
  units: readonly TreeUnit[];
  ownerUuid: string;
  value: readonly CentralTarget[];
  onChange: (targets: CentralTarget[]) => void;
  disabled?: boolean;
  /** An organisation-wide template (no owner): every unit in the list may be chosen. */
  orgWide?: boolean;
  /** Roles or groups are chosen too, so zero units is not "nobody". */
  hasOtherAudience?: boolean;
}

/**
 * Availability picker ("who has the template at their disposal"). The server only accepts targets inside the owner unit's
 * subtree (no sideways or upward delegation), so nothing else is offered here.
 */
export function OrgUnitTargetPicker({ units, ownerUuid, value, onChange, disabled, orgWide, hasOtherAudience }: Props) {
  const rows = useMemo(() => {
    if (!ownerUuid) return orgWide ? flattenOrgTree(units) : [];
    const inside = selfAndDescendants(units, ownerUuid);
    return flattenOrgTree(units.filter((u) => inside.has(u.uuid)));
  }, [units, ownerUuid, orgWide]);

  const byUuid = useMemo(() => new Map(value.map((t) => [t.orgUnitUuid, t])), [value]);
  const offered = new Set(rows.map((r) => r.unit.uuid));
  // Targets the list cannot show (unit hidden or gone): still removable so they cannot get stuck.
  const orphans = value.filter((t) => !offered.has(t.orgUnitUuid));

  function toggle(uuid: string, on: boolean) {
    if (on) onChange([...value, { orgUnitUuid: uuid, includeDescendants: true }]);
    else onChange(value.filter((t) => t.orgUnitUuid !== uuid));
  }
  function setDescendants(uuid: string, includeDescendants: boolean) {
    onChange(value.map((t) => (t.orgUnitUuid === uuid ? { ...t, includeDescendants } : t)));
  }

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium text-[var(--ink)]">Hvem skal have skabelonen til rådighed?</legend>
      <p className="text-[13px] text-[var(--muted)]">
        Vælg de enheder, hvis medarbejdere kan bruge skabelonen. Underenheder kan vælges med.{' '}
        {orgWide && !ownerUuid ? 'Skabelonen har ingen ejerenhed, så du kan vælge alle enheder.' : 'Du kan kun vælge ejerenheden og enheder under den.'}
      </p>

      {!ownerUuid && !orgWide ? (
        <p className="text-[13px] text-[var(--muted)]">Vælg først en ejerenhed.</p>
      ) : (
        <ul
          className="max-h-56 overflow-y-auto rounded-[var(--radius)] border border-[var(--line)] py-1"
          aria-label="Enheder"
        >
          {rows.map(({ unit, depth }) => {
            const target = byUuid.get(unit.uuid);
            const checked = target !== undefined;
            return (
              <li
                key={unit.uuid}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5"
                style={{ paddingLeft: 12 + depth * 20 }}
                data-depth={depth}
              >
                <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggle(unit.uuid, e.target.checked)}
                    aria-label={`Til rådighed for: ${unit.name}`}
                  />
                  {unit.name}
                </label>
                {checked && (
                  <label className="flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
                    <input
                      type="checkbox"
                      checked={target.includeDescendants}
                      onChange={(e) => setDescendants(unit.uuid, e.target.checked)}
                      aria-label={`Inkl. underenheder: ${unit.name}`}
                    />
                    inkl. underenheder
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {orphans.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Øvrige enheder">
          {orphans.map((t) => (
            <li key={t.orgUnitUuid} className="flex items-center gap-3 text-[13px] text-[var(--ink-2)]">
              <span>Enhed uden for den valgte ejer</span>
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => toggle(t.orgUnitUuid, false)}
              >
                Fjern
              </button>
            </li>
          ))}
        </ul>
      )}

      {(ownerUuid || orgWide) && value.length === 0 && !hasOtherAudience && (
        <p role="status" className="text-[13px]" style={{ color: 'var(--warn)' }}>
          Skabelonen er ikke til rådighed for nogen, før du vælger mindst én enhed.
        </p>
      )}
    </fieldset>
  );
}
