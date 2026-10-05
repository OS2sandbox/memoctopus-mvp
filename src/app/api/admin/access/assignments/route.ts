import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { grantRole } from '@/lib/authz/access-admin';
import { parseJsonBody, readOnlyResponse, respond } from '@/lib/authz/access-http';
import { appUserIdSchema, isoDateSchema, roleKeySchema, uuidSchema } from '@/lib/authz/access-schemas';

const bodySchema = z
  .object({
    appUserId: appUserIdSchema,
    roleKey: roleKeySchema,
    scopeOrgUnitUuid: uuidSchema.nullable().optional(),
    includeDescendants: z.boolean().optional(),
    startDate: isoDateSchema.nullable().optional(),
    stopDate: isoDateSchema.nullable().optional(),
  })
  .strict();

export const POST = withAuthz('admin/access/assignments POST', 'access.manage', async (req, { session }) => {
  const readOnly = readOnlyResponse();
  if (readOnly) return readOnly;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  return respond(async () => {
    const assignment = await grantRole({ ...body.data, actorUserId: session.user.id });
    return NextResponse.json({ assignment }, { status: 201 });
  });
});
