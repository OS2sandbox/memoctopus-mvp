// Shared contract for central (locked) templates. Everything that crosses the
// manager/user boundary lives here so the service, routes and UI cannot drift.
// The prompt text is ONLY ever part of the manager-side shapes: the user-facing
// CentralSkabelonSummary deliberately has no `prompt` field.

export type CentralStatus = 'active' | 'archived';

export type CentralChangeType = 'create' | 'update' | 'retarget' | 'archive' | 'restore';

/** Field names that may appear in an update's `changedFields` (names only, never values). */
export const CENTRAL_CONTENT_FIELDS = [
  'name',
  'description',
  'prompt',
  'includeDeltagere',
  'includeBeslutningspunkter',
  'includeDagsorden',
  'includeDato',
  'allowUserInstruction',
  'allowToggleOverrides',
] as const;
export type CentralContentField = (typeof CENTRAL_CONTENT_FIELDS)[number];

export const CENTRAL_LIMITS = {
  name: 120,
  description: 1000,
  prompt: 20000,
  changeNoteMin: 10,
  changeNoteMax: 2000,
  targets: 200,
  principalTargets: 200,
  principalIdentifier: 200,
} as const;

export interface CentralTarget {
  orgUnitUuid: string;
  includeDescendants: boolean;
}

/** What a role or group target points at: a value of the catalogue (public.external_roles). */
export type PrincipalKind = 'role' | 'group';
export const PRINCIPAL_KINDS = ['role', 'group'] as const;

export interface CentralPrincipalTarget {
  kind: PrincipalKind;
  identifier: string;
}

/**
 * A role/group target as the manager sees it: with the catalogue's current name. `inactive` = the
 * catalogue entry was withdrawn (nobody matches it any more); `unknown` = not in the catalogue
 * at all (only possible in an old snapshot).
 */
export interface CentralPrincipalTargetView extends CentralPrincipalTarget {
  name: string;
  status: 'active' | 'inactive' | 'unknown';
  /**
   * How many people hold this role/group from their latest login (fresh claims, linked and enabled
   * user). A count, never who. 0 means the target cannot reach anybody right now; the usual cause
   * is an identifier that differs from what the IdP sends.
   */
  holders: number;
}

/** A role/group target as frozen in a version row: the name is the one it had then. */
export interface CentralPrincipalTargetSnapshot extends CentralPrincipalTarget {
  name: string;
}

/** One entry of the role/group catalogue as offered to the target picker. */
export interface CentralCatalogueEntry extends CentralPrincipalTarget {
  name: string;
  source: 'rollekatalog' | 'config' | 'claims';
  active: boolean;
  /** Same count as CentralPrincipalTargetView.holders: people only as a number. */
  holders: number;
}

export interface CentralTemplateContent {
  name: string;
  description: string;
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
  includeDato: boolean;
  allowUserInstruction: boolean;
  allowToggleOverrides: boolean;
}

/** Manager-side view: includes the prompt. Never returned to ordinary users. */
export interface CentralTemplateAdmin extends CentralTemplateContent {
  id: string;
  /** null = an organisation-wide template: only a manager with a GLOBAL template.manage can touch it. */
  ownerOrgUnitUuid: string | null;
  status: CentralStatus;
  currentVersion: number;
  targets: CentralTarget[];
  principalTargets: CentralPrincipalTargetView[];
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  /** Name snapshot (changelog) of whoever wrote the current version, and when. Manager-side only. */
  lastEditedByName: string | null;
  lastEditedAt: string;
}

export interface CentralTemplateListItem {
  id: string;
  name: string;
  description: string;
  ownerOrgUnitUuid: string | null;
  status: CentralStatus;
  currentVersion: number;
  /** Org-unit targets: the count and the targets themselves (names are resolved by the client from the scope list). */
  targetCount: number;
  targets: CentralTarget[];
  principalTargets: CentralPrincipalTargetView[];
  updatedAt: string;
  /** Name snapshot of whoever wrote version 1. Manager-side only, never in CentralSkabelonSummary. */
  createdByName: string | null;
  /** Name snapshot of whoever wrote the current version, and when. */
  lastEditedByName: string | null;
  lastEditedAt: string;
}

/** One changelog entry. `content` and `targets` are the full snapshot as of that version. */
export interface CentralTemplateVersion {
  version: number;
  changeType: CentralChangeType;
  changeNote: string;
  changedByName: string | null;
  changedAt: string;
  content: CentralTemplateContent;
  targets: CentralTarget[];
  principalTargets: CentralPrincipalTargetSnapshot[];
}

/** USER-FACING: what a recipient may see of a central template. No prompt text, by design. */
export interface CentralSkabelonSummary {
  id: string;
  source: 'central';
  name: string;
  description: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
  includeDato: boolean;
  locked: true;
  version: number;
  allowUserInstruction: boolean;
  allowToggleOverrides: boolean;
}

export interface TemplateRef {
  source: 'personal' | 'central' | 'none';
  id: string | null;
  version: number | null;
}

/** An org unit as offered to the owner/target pickers. */
export interface CentralScopeOrgUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
}
