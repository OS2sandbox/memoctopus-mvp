import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { listOrgUnitMembers, setOrgUnitMembers } from '@/lib/authz/access-admin';
import { parseJsonBody, parseWith, readOnlyResponse, respond } from '@/lib/authz/access-http';
import { appUserIdSchema, uuidSchema } from '@/lib/authz/access-schemas';

const paramsSchema = z.object({ uuid: uuidSchema }).strict();
const bodySchema = z.object({ appUserIds: z.array(appUserIdSchema).max(1000) }).strict();

type P = { uuid: string };

export const GET = withAuthz<P>(
  'admin/access/org-units/[uuid]/members GET',
  'access.manage',
  async (_req, { params }) => {
    const p = parseWith(paramsSchema, params);
    if (!p.ok) return p.response;
    return respond(async () => NextResponse.json({ members: await listOrgUnitMembers(p.data.uuid) }));
  },
);

// Replaces the whole membership of the unit (PUT semantics).
export const PUT = withAuthz<P>(
  'admin/access/org-units/[uuid]/members PUT',
  'access.manage',
  async (req, { session, params }) => {
    const readOnly = readOnlyResponse();
    if (readOnly) return readOnly;
    const p = parseWith(paramsSchema, params);
    if (!p.ok) return p.response;
    const body = await parseJsonBody(req, bodySchema);
    if (!body.ok) return body.response;

    return respond(async () => {
      const members = await setOrgUnitMembers(p.data.uuid, body.data.appUserIds, session.user.id);
      return NextResponse.json({ members });
    });
  },
);
