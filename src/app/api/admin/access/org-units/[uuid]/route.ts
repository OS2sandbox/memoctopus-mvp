import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { deleteOrgUnit, updateOrgUnit } from '@/lib/authz/access-admin';
import { parseJsonBody, parseWith, respond } from '@/lib/authz/access-http';
import { orgUnitNameSchema, uuidSchema } from '@/lib/authz/access-schemas';

const paramsSchema = z.object({ uuid: uuidSchema }).strict();
const patchSchema = z
  .object({ name: orgUnitNameSchema.optional(), parentUuid: uuidSchema.nullable().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.parentUuid !== undefined, { message: 'Ingen ændringer angivet' });

type P = { uuid: string };

export const PATCH = withAuthz<P>(
  'admin/access/org-units/[uuid] PATCH',
  'access.manage',
  async (req, { session, params }) => {
    const p = parseWith(paramsSchema, params);
    if (!p.ok) return p.response;
    const body = await parseJsonBody(req, patchSchema);
    if (!body.ok) return body.response;

    return respond(async () => {
      const orgUnit = await updateOrgUnit(p.data.uuid, body.data, session.user.id);
      return NextResponse.json({ orgUnit });
    });
  },
);

export const DELETE = withAuthz<P>(
  'admin/access/org-units/[uuid] DELETE',
  'access.manage',
  async (_req, { session, params }) => {
    const p = parseWith(paramsSchema, params);
    if (!p.ok) return p.response;

    return respond(async () => {
      await deleteOrgUnit(p.data.uuid, session.user.id);
      return NextResponse.json({ ok: true });
    });
  },
);
