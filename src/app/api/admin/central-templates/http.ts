// Shared plumbing of the manager-side central template routes: strict param and
// body parsing, and explicit DTO whitelists so a column added to the service
// (or a raw row) can never reach the browser by accident. These responses carry
// prompt text, so they are never cached.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { parseWith } from '@/lib/authz/access-http';
import type {
  CentralScopeOrgUnit,
  CentralTarget,
  CentralTemplateAdmin,
  CentralTemplateContent,
  CentralTemplateListItem,
  CentralTemplateVersion,
} from '@/lib/skabeloner/central-types';

export const idParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

// Only issues carrying messages we wrote ourselves (Danish, static) are forwarded.
// Zod's own messages are English and can echo input (unrecognized keys), so for
// everything else the client gets path + code only.
const OWN_MESSAGE_CODES = new Set(['too_small', 'too_big', 'custom']);
const OWN_MESSAGE_FIELDS = new Set(['name', 'description', 'prompt', 'changeNote', 'targets']);

function hasOwnMessage(field: string, code: string): boolean {
  if (field === 'changeNote') return code !== 'unrecognized_keys'; // required/invalid_type messages are set in the schema
  return OWN_MESSAGE_FIELDS.has(field) && OWN_MESSAGE_CODES.has(code);
}

type Parsed<S extends ZodTypeAny> = { ok: true; data: z.output<S> } | { ok: false; response: NextResponse };

/** Like access-http parseJsonBody, but 400s carry the Danish field messages of the central schemas. */
export async function parseBody<S extends ZodTypeAny>(req: NextRequest, schema: S): Promise<Parsed<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: json({ error: 'Ugyldig JSON', code: 'invalid_json' }, 400),
    };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };

  const issues = r.error.issues.map((i) => {
    const field = String(i.path[0] ?? '');
    const own = OWN_MESSAGE_FIELDS.has(field) && i.code !== 'unrecognized_keys' && i.code !== 'invalid_string';
    return {
      path: i.path.join('.'),
      code: i.code,
      ...(own ? { message: i.message } : {}),
    };
  });
  const first = issues.find((i) => 'message' in i) as { message: string } | undefined;
  return {
    ok: false,
    response: json({ error: first?.message ?? 'Ugyldigt input', code: 'invalid', issues }, 400),
  };
}

export function parseParams(params: unknown): Parsed<typeof idParamsSchema> {
  return parseWith(idParamsSchema, params);
}

const target = (t: CentralTarget): CentralTarget => ({
  orgUnitUuid: t.orgUnitUuid,
  includeDescendants: t.includeDescendants,
});

const content = (c: CentralTemplateContent): CentralTemplateContent => ({
  name: c.name,
  description: c.description,
  prompt: c.prompt,
  includeDeltagere: c.includeDeltagere,
  includeBeslutningspunkter: c.includeBeslutningspunkter,
  includeDagsorden: c.includeDagsorden,
  includeDato: c.includeDato,
  allowUserInstruction: c.allowUserInstruction,
  allowToggleOverrides: c.allowToggleOverrides,
});

export function adminDto(t: CentralTemplateAdmin): CentralTemplateAdmin {
  return {
    ...content(t),
    id: t.id,
    ownerOrgUnitUuid: t.ownerOrgUnitUuid,
    status: t.status,
    currentVersion: t.currentVersion,
    targets: t.targets.map(target),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    createdByName: t.createdByName ?? null,
  };
}

export function listItemDto(t: CentralTemplateListItem): CentralTemplateListItem {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    ownerOrgUnitUuid: t.ownerOrgUnitUuid,
    status: t.status,
    currentVersion: t.currentVersion,
    targetCount: t.targetCount,
    updatedAt: t.updatedAt,
  };
}

export function versionDto(v: CentralTemplateVersion): CentralTemplateVersion {
  return {
    version: v.version,
    changeType: v.changeType,
    changeNote: v.changeNote,
    changedByName: v.changedByName ?? null,
    changedAt: v.changedAt,
    content: content(v.content),
    targets: v.targets.map(target),
  };
}

export function scopeUnitDto(u: CentralScopeOrgUnit): CentralScopeOrgUnit {
  return { uuid: u.uuid, name: u.name, parentUuid: u.parentUuid ?? null };
}
