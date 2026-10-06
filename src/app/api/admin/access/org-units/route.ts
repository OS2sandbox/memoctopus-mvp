import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz, hasCapability, requireCapability } from '@/lib/authz/guard';
import { createOrgUnit, listOrgUnits } from '@/lib/authz/access-admin';
import { parseJsonBody, respond } from '@/lib/authz/access-http';
import { orgUnitNameSchema, uuidSchema } from '@/lib/authz/access-schemas';
import { orgUnitsInScope } from '@/lib/authz/scope';

const bodySchema = z.object({ name: orgUnitNameSchema, parentUuid: uuidSchema.nullable().optional() }).strict();

// Administrators (access.manage) see the whole tree. Everyone else needs
// directory.read and only sees units inside that scope; units above it are not revealed.
export const GET = withAuthz('admin/access/org-units GET', null, async (_req, { principal }) => {
  const manager = hasCapability(principal, 'access.manage');
  if (!manager) {
    const denied = requireCapability(principal, 'directory.read');
    if (denied) return denied;
  }
  const scope = manager ? ({ all: true } as const) : await orgUnitsInScope(principal, 'directory.read');
  const orgUnits = await listOrgUnits(scope.all ? {} : { uuids: scope.uuids });
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
