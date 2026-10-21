import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { createOrgUnit, listOrgUnits } from '@/lib/authz/access-admin';
import { parseJsonBody, respond } from '@/lib/authz/access-http';
import { orgUnitNameSchema, uuidSchema } from '@/lib/authz/access-schemas';

const bodySchema = z.object({ name: orgUnitNameSchema, parentUuid: uuidSchema.nullable().optional() }).strict();

// Only administrators (access.manage) read the tree here; a template manager gets the
// units it may target from /api/admin/central-templates/scope.
export const GET = withAuthz('admin/access/org-units GET', 'access.manage', async () => {
  const orgUnits = await listOrgUnits({});
  return NextResponse.json({ orgUnits });
});

export const POST = withAuthz('admin/access/org-units POST', 'access.manage', async (req, { session }) => {
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  return respond(async () => {
    const orgUnit = await createOrgUnit({ ...body.data, actorUserId: session.user.id });
    return NextResponse.json({ orgUnit }, { status: 201 });
  });
});
