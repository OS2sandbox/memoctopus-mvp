// Pure helpers shared by the central template admin UI.
import { CHANGE_NOTE_MESSAGE, changeNoteLength, stripInvisible } from '@/lib/skabeloner/change-note';
import { CENTRAL_LIMITS } from '@/lib/skabeloner/central-types';
import type {
  CentralCatalogueEntry,
  CentralChangeType,
  CentralContentField,
  CentralPrincipalTarget,
  CentralPrincipalTargetView,
  CentralTarget,
  CentralTemplateContent,
} from '@/lib/skabeloner/central-types';
import { CENTRAL_CONTENT_FIELDS } from '@/lib/skabeloner/central-types';
import { formatDateTime } from './format';
import { selfAndDescendants, type TreeUnit } from './org-tree';

export const FLAG_TEXT = 'ukendt/inaktiv';

export const changeTypeLabels: Record<CentralChangeType, string> = {
  create: 'Oprettet',
  update: 'Ændret',
  retarget: 'Tilgængelighed ændret',
  archive: 'Arkiveret',
  restore: 'Gendannet',
};

export const contentFieldLabels: Record<CentralContentField, string> = {
  name: 'Navn',
  description: 'Beskrivelse',
  prompt: 'Prompt',
  includeDeltagere: 'Kategori: Deltagere',
  includeBeslutningspunkter: 'Kategori: Beslutningspunkter',
  includeDagsorden: 'Kategori: Dagsorden',
  includeDato: 'Kategori: Dato',
  allowUserInstruction: 'Tillad brugerens egen instruktion',
  allowToggleOverrides: 'Tillad brugeren at ændre kategorier',
};

/**
 * The number the server enforces (src/lib/skabeloner/change-note.ts, shared): invisible
 * characters stripped, whitespace not counted, counted in code points.
 */
export const noteLength = changeNoteLength;

export function noteProblem(note: string): string | null {
  if (noteLength(note) < CENTRAL_LIMITS.changeNoteMin) return CHANGE_NOTE_MESSAGE;
  // The server caps the stripped note, measured in UTF-16 units.
  if (stripInvisible(note).length > CENTRAL_LIMITS.changeNoteMax)
    return `Ændringsbeskrivelsen er for lang (højst ${CENTRAL_LIMITS.changeNoteMax} tegn)`;
  return null;
}

/** Names of the content fields whose value differs. */
export function changedContentFields(a: CentralTemplateContent, b: CentralTemplateContent): CentralContentField[] {
  return CENTRAL_CONTENT_FIELDS.filter((f) => a[f] !== b[f]);
}

interface TargetChanges {
  added: CentralTarget[];
  removed: CentralTarget[];
  /** Same unit, different include_descendants. */
  changed: CentralTarget[];
}

export function diffTargets(before: readonly CentralTarget[], after: readonly CentralTarget[]): TargetChanges {
  const prev = new Map(before.map((t) => [t.orgUnitUuid, t]));
  const next = new Map(after.map((t) => [t.orgUnitUuid, t]));
  return {
    added: after.filter((t) => !prev.has(t.orgUnitUuid)),
    removed: before.filter((t) => !next.has(t.orgUnitUuid)),
    changed: after.filter((t) => {
      const p = prev.get(t.orgUnitUuid);
      return p !== undefined && p.includeDescendants !== t.includeDescendants;
    }),
  };
}

export function targetsEqual(a: readonly CentralTarget[], b: readonly CentralTarget[]): boolean {
  const d = diffTargets(a, b);
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

// ─── Role/group targets ────────────────────────────────────────────────────

export const principalKindLabels: Record<CentralPrincipalTarget['kind'], string> = { role: 'Rolle', group: 'Gruppe' };

/** `kind:identifier`; the kind never contains a colon, so the key is unambiguous. */
export const principalKey = (t: CentralPrincipalTarget): string => `${t.kind}:${t.identifier}`;

export function diffPrincipals<T extends CentralPrincipalTarget>(
  before: readonly T[],
  after: readonly T[],
): { added: T[]; removed: T[] } {
  const prev = new Set(before.map(principalKey));
  const next = new Set(after.map(principalKey));
  return {
    added: after.filter((t) => !prev.has(principalKey(t))),
    removed: before.filter((t) => !next.has(principalKey(t))),
  };
}

export function principalsEqual(a: readonly CentralPrincipalTarget[], b: readonly CentralPrincipalTarget[]): boolean {
  const d = diffPrincipals(a, b);
  return d.added.length === 0 && d.removed.length === 0;
}

/**
 * Re-reads a target against the current catalogue: the catalogue's name wins, a target that
 * is not in it is `unknown`, one that was withdrawn is `inactive`.
 */
export function viewAgainstCatalogue(
  t: CentralPrincipalTarget & { name?: string },
  catalogue: ReadonlyMap<string, CentralCatalogueEntry>,
): CentralPrincipalTargetView {
  const hit = catalogue.get(principalKey(t));
  if (!hit) return { kind: t.kind, identifier: t.identifier, name: t.name ?? t.identifier, status: 'unknown', holders: 0 };
  return { kind: t.kind, identifier: t.identifier, name: hit.name, status: hit.active ? 'active' : 'inactive', holders: hit.holders };
}

/** "0 personer har den ved seneste login": the zero-match feedback for a role or group. */
export const NO_HOLDERS_TEXT = '0 personer har den ved seneste login';

/** How many people hold a role/group from their latest login, as a short Danish phrase (a count, never who). */
export const holdersLabel = (n: number): string => (n === 0 ? NO_HOLDERS_TEXT : n === 1 ? '1 person har den' : `${n} personer har den`);

export interface AudienceEntry {
  key: string;
  label: string;
  /** A role/group that is withdrawn from or missing in the catalogue: it reaches nobody. */
  flagged: boolean;
  /** An active role/group that nobody holds from their latest login: it cannot match yet (often an identifier that differs from the IdP's claim value). */
  empty: boolean;
}

/** Every role, group and unit a template is made available to, named; roles and groups first. */
export function audienceEntries(
  t: { targets: readonly CentralTarget[]; principalTargets: readonly CentralPrincipalTargetView[] },
  unitName: (uuid: string) => string,
): AudienceEntry[] {
  return [
    ...t.principalTargets.map((p) => ({
      key: principalKey(p),
      label: `${principalKindLabels[p.kind]}: ${p.name}`,
      flagged: p.status !== 'active',
      empty: p.status === 'active' && p.holders === 0,
    })),
    ...t.targets.map((u) => ({
      key: `unit:${u.orgUnitUuid}`,
      label: `Enhed: ${unitName(u.orgUnitUuid)}${u.includeDescendants ? ' (inkl. underenheder)' : ''}`,
      flagged: false,
      empty: false,
    })),
  ];
}

/** At most `max` entries, flagged (and zero-holder) ones first (a manager must see those), and how many were left out. */
export function truncateAudience(entries: readonly AudienceEntry[], max = 3): { shown: AudienceEntry[]; more: AudienceEntry[] } {
  const warn = (e: AudienceEntry) => e.flagged || e.empty;
  const ordered = [...entries.filter(warn), ...entries.filter((e) => !warn(e))];
  return { shown: ordered.slice(0, max), more: ordered.slice(max) };
}

/** Keeps only targets inside the owner's subtree (the server refuses anything else). */
export function targetsWithinOwner(units: readonly TreeUnit[], ownerUuid: string, targets: readonly CentralTarget[]) {
  if (!ownerUuid) return [];
  const allowed = selfAndDescendants(units, ownerUuid);
  return targets.filter((t) => allowed.has(t.orgUnitUuid));
}

export function unitNameLookup(units: readonly TreeUnit[]): (uuid: string) => string {
  const names = new Map(units.map((u) => [u.uuid, u.name]));
  return (uuid) => names.get(uuid) ?? 'Ukendt enhed';
}

export const formatTime = (iso: string): string => formatDateTime(iso, { dateStyle: 'short', timeStyle: 'short' });

export const conflictMessage = (version: number) =>
  `Skabelonen er ændret af en anden (version ${version}). Genindlæs for at se ændringerne.`;
