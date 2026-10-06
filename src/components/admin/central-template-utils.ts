// Pure helpers and the fetch wrapper shared by the central template admin UI.
import { CENTRAL_LIMITS } from '@/lib/skabeloner/central-types';
import type {
  CentralChangeType,
  CentralContentField,
  CentralTarget,
  CentralTemplateContent,
} from '@/lib/skabeloner/central-types';
import { CENTRAL_CONTENT_FIELDS } from '@/lib/skabeloner/central-types';
import { messageFromBody, NETWORK_ERROR } from './api';
import { selfAndDescendants, type TreeUnit } from './org-tree';

export const changeTypeLabels: Record<CentralChangeType, string> = {
  create: 'Oprettet',
  update: 'Ændret',
  retarget: 'Modtagere ændret',
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

export const CHANGE_NOTE_HINT = 'Beskriv ændringen (mindst 10 tegn)';

/** Same rule as the server: trimmed, counted in code points. */
export function noteLength(note: string): number {
  return [...note.trim()].length;
}

export function noteProblem(note: string): string | null {
  const n = noteLength(note);
  if (n < CENTRAL_LIMITS.changeNoteMin) return CHANGE_NOTE_HINT;
  if (n > CENTRAL_LIMITS.changeNoteMax)
    return `Ændringsbeskrivelsen er for lang (højst ${CENTRAL_LIMITS.changeNoteMax} tegn)`;
  return null;
}

/** Names of the content fields whose value differs. */
export function changedContentFields(a: CentralTemplateContent, b: CentralTemplateContent): CentralContentField[] {
  return CENTRAL_CONTENT_FIELDS.filter((f) => a[f] !== b[f]);
}

export interface TargetChanges {
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

const timeFormat = new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short' });
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d);
}

export type CentralResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string; code?: string; currentVersion?: number };

/** Like apiRequest, but keeps `code` and `currentVersion` so a 409 can be told apart. */
export async function centralRequest<T = unknown>(
  url: string,
  init?: { method?: string; json?: unknown },
): Promise<CentralResult<T>> {
  const options: RequestInit = { method: init?.method };
  if (init?.json !== undefined) {
    options.body = JSON.stringify(init.json);
    options.headers = { 'Content-Type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch {
    return { ok: false, status: 0, message: NETWORK_ERROR };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty or non-JSON body: handled by the status below.
  }
  if (res.ok) return { ok: true, data: body as T };
  const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; currentVersion?: unknown };
  return {
    ok: false,
    status: res.status,
    message: messageFromBody(res.status, body),
    ...(typeof b.code === 'string' ? { code: b.code } : {}),
    ...(typeof b.currentVersion === 'number' ? { currentVersion: b.currentVersion } : {}),
  };
}

export const conflictMessage = (version: number) =>
  `Skabelonen er ændret af en anden (version ${version}). Genindlæs for at se ændringerne.`;
