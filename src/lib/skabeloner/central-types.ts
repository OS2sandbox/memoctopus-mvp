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
} as const;

export interface CentralTarget {
  orgUnitUuid: string;
  includeDescendants: boolean;
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
  ownerOrgUnitUuid: string;
  status: CentralStatus;
  currentVersion: number;
  targets: CentralTarget[];
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
}

export interface CentralTemplateListItem {
  id: string;
  name: string;
  description: string;
  ownerOrgUnitUuid: string;
  status: CentralStatus;
  currentVersion: number;
  targetCount: number;
  updatedAt: string;
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
