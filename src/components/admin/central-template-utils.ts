// Pure helpers shared by the central template admin UI.
import { CHANGE_NOTE_MESSAGE, changeNoteLength, stripInvisible } from '@/lib/skabeloner/change-note';
import { CENTRAL_LIMITS, principalKey } from '@/lib/skabeloner/central-types';
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

/** The access mode the server runs in (from the role catalogue endpoint); the sharing route differs per mode. */
export type SharingSource = 'local' | 'rollekatalog' | 'claims';

/**
 * Why roles and groups cannot be picked as an audience, and which route applies instead. Roles and
 * groups only reach a person with the login (claims); the Rollekatalog sync knows org units, not the
 * role/group values of a login. Plain Danish for a manager, with the one step the municipality takes.
 */
export function rolesLockedText(source?: SharingSource | null): string {
  const how =
    'Vil I dele efter rolle eller gruppe, skal kommunens identitetsudbyder (login) sende rollerne med, og appen sættes til ACCESS_SOURCE=claims. ' +
    'OS2rollekatalog kan levere rollerne til identitetsudbyderen. Kontakt jeres driftsansvarlige.';
  if (source === 'rollekatalog')
    return `Roller og grupper kan ikke vælges, mens rollerne hentes med Rollekatalog-synkroniseringen: den kender enheder, men ikke de roller og grupper, der følger med et login. Her deles en skabelon med enheder. ${how}`;
  if (source === 'local')
    return `Roller og grupper kan ikke vælges, mens rollerne styres i appen: ingen har roller eller grupper fra et login. Her deles en skabelon med enheder. ${how}`;
  return `Roller og grupper kan kun vælges, når rollerne kommer fra brugernes login (ACCESS_SOURCE=claims). Uden login-claims har ingen en rolle, som skabelonen kan matche. ${how}`;
}

/** One line on the central templates screen: how a template is shared in the current mode. */
export function sharingModeNote(source?: SharingSource | null): string | null {
  if (source === 'claims')
    return 'Her deles skabeloner med roller og grupper, som følger med brugernes login fra kommunens identitetsudbyder.';
  if (source === 'rollekatalog' || source === 'local')
    return 'Her deles skabeloner med enheder. Deling efter rolle eller gruppe er først muligt, når rollerne følger med brugernes login fra kommunens identitetsudbyder (ACCESS_SOURCE=claims); OS2rollekatalog kan levere dem dertil.';
  return null;
}

/** The hint under "Ikke til rådighed for nogen": which route makes a template available in the current mode. */
export function emptyAudienceHint(source?: SharingSource | null): string | null {
  if (source === 'claims') return 'Vælg mindst én rolle eller gruppe i skabelonen.';
  if (source === 'rollekatalog' || source === 'local')
    return 'Vælg mindst én enhed i skabelonen. Deling efter rolle eller gruppe kræver, at rollerne kommer med login (ACCESS_SOURCE=claims).';
  return null;
}

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
