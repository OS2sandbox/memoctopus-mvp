'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type {
  CentralCatalogueEntry,
  CentralPrincipalTarget,
  CentralPrincipalTargetView,
} from '@/lib/skabeloner/central-types';
import { principalKey } from '@/lib/skabeloner/central-types';
import { FLAG_TEXT, NO_HOLDERS_TEXT, holdersLabel, principalKindLabels } from './central-template-utils';

interface Props {
  /** The role/group catalogue (both sources merged). Only active entries are offered for picking. */
  catalogue: readonly CentralCatalogueEntry[];
  value: readonly CentralPrincipalTargetView[];
  onChange: (targets: CentralPrincipalTargetView[]) => void;
  /** false: the list is shown but cannot be changed (see `lockedReason`). */
  canEdit: boolean;
  /** Why it cannot be changed: 'needs_claims' = roles only come from login claims in ACCESS_SOURCE=claims; anything else = not a global manager. */
  lockedReason?: 'needs_claims' | 'needs_global' | null;
  /** Units are chosen too, so no roles is not "nobody". */
  hasOtherAudience?: boolean;
  /** Show the "nobody gets it" warning for an empty choice (the unit picker shows its own when it is on screen). */
  warnWhenEmpty?: boolean;
  disabled?: boolean;
}

// Rendering thousands of checkboxes would stall the dialog; a search narrows the list instead.
const MAX_ROWS = 100;

/**
 * Availability by role or group ("who has the template at their disposal", beside the unit picker).
 * A choice is a catalogue entry (names shown, the identifier small); one that is no longer in the
 * catalogue stays visible, flagged, and removable, so it cannot get stuck on a template.
 */
export function PrincipalTargetPicker({
  catalogue,
  value,
  onChange,
  canEdit,
  lockedReason = null,
  hasOtherAudience = false,
  warnWhenEmpty = false,
  disabled,
}: Props) {
  const [query, setQuery] = useState('');
  const chosen = useMemo(() => new Set(value.map(principalKey)), [value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalogue.filter(
      (e) => e.active && (q === '' || e.name.toLowerCase().includes(q) || e.identifier.toLowerCase().includes(q)),
    );
  }, [catalogue, query]);
  const rows = matches.slice(0, MAX_ROWS);

  function toggle(e: CentralCatalogueEntry, on: boolean) {
    if (on) onChange([...value, { kind: e.kind, identifier: e.identifier, name: e.name, status: 'active', holders: e.holders }]);
    else onChange(value.filter((t) => principalKey(t) !== principalKey(e)));
  }
  const remove = (t: CentralPrincipalTarget) => onChange(value.filter((x) => principalKey(x) !== principalKey(t)));

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium text-[var(--ink)]">Hvilke roller og grupper skal have skabelonen til rådighed?</legend>
      <p className="text-[13px] text-[var(--muted)]">
        Medarbejdere med en af de valgte roller eller grupper får automatisk skabelonen til rådighed, og ændringer i
        skabelonen når dem uden videre.
      </p>

      {value.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Valgte roller og grupper">
          {value.map((t) => (
            <li key={principalKey(t)} className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
              <Badge variant="outline">{principalKindLabels[t.kind]}</Badge>
              <span>{t.name}</span>
              <span className="font-mono text-[11px] text-[var(--muted)]">{t.identifier}</span>
              {t.status !== 'active' && <Badge variant="warning">{FLAG_TEXT}</Badge>}
              {t.status === 'active' && t.holders === 0 && <HoldersNote n={0} />}
              {canEdit && (
                <button
                  type="button"
                  className="text-[13px] underline underline-offset-2"
                  aria-label={`Fjern ${principalKindLabels[t.kind].toLowerCase()}: ${t.name}`}
                  onClick={() => remove(t)}
                >
                  Fjern
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!canEdit ? (
        <p className="text-[13px] text-[var(--muted)]">
          {lockedReason === 'needs_claims'
            ? 'Roller og grupper kan kun vælges, når rollerne kommer fra brugernes login (ACCESS_SOURCE=claims). Uden login-claims har ingen en rolle, som skabelonen kan matche.'
            : 'Kun en skabelonansvarlig med tilladelse for hele organisationen kan vælge roller og grupper.'}
        </p>
      ) : catalogue.length === 0 ? (
        <p className="text-[13px] text-[var(--muted)]">
          Rollekataloget er tomt. Roller og grupper kommer fra Rollekatalog eller fra opsætningen af identitetsudbyderen.
        </p>
      ) : (
        <>
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Søg i roller og grupper"
            aria-label="Søg i roller og grupper"
          />
          <ul
            className="max-h-56 overflow-y-auto rounded-[var(--radius)] border border-[var(--line)] py-1"
            aria-label="Roller og grupper"
          >
            {rows.map((e) => (
              <li key={principalKey(e)} className="flex items-center gap-2 px-3 py-1.5">
                <label className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={chosen.has(principalKey(e))}
                    onChange={(ev) => toggle(e, ev.target.checked)}
                    aria-label={`Til rådighed for ${principalKindLabels[e.kind].toLowerCase()}: ${e.name}`}
                  />
                  <span>{e.name}</span>
                  <Badge variant="outline">{principalKindLabels[e.kind]}</Badge>
                  <span className="font-mono text-[11px] text-[var(--muted)]">{e.identifier}</span>
                  <HoldersNote n={e.holders} />
                </label>
              </li>
            ))}
            {rows.length === 0 && <li className="px-3 py-1.5 text-[13px] text-[var(--muted)]">Ingen roller eller grupper matcher</li>}
          </ul>
          {matches.length > rows.length && (
            <p className="text-[13px] text-[var(--muted)]">
              Viser de første {MAX_ROWS} af {matches.length}. Søg for at indsnævre.
            </p>
          )}
        </>
      )}

      {warnWhenEmpty && value.length === 0 && !hasOtherAudience && (
        <p role="status" className="text-[13px]" style={{ color: 'var(--warn)' }}>
          Ingen roller, grupper eller enheder er valgt. Ingen får skabelonen til rådighed, før du vælger mindst én.
        </p>
      )}
    </fieldset>
  );
}

/**
 * How many people hold the role from their latest login. Zero is flagged: targeting it cannot match
 * anybody yet, and the usual cause is an identifier that differs from what the IdP sends.
 */
function HoldersNote({ n }: { n: number }) {
  return n === 0 ? (
    <span className="text-[12px]" style={{ color: 'var(--warn)' }}>
      {NO_HOLDERS_TEXT}
    </span>
  ) : (
    <span className="text-[12px] text-[var(--muted)]">{holdersLabel(n)}</span>
  );
}
