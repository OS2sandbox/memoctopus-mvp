import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { revokeAssignment } from '@/lib/authz/access-admin';
import { parseWith, readOnlyResponse, respond } from '@/lib/authz/access-http';
import { uuidSchema } from '@/lib/authz/access-schemas';

const paramsSchema = z.object({ id: uuidSchema }).strict();

export const DELETE = withAuthz<{ id: string }>(
  'admin/access/assignments/[id] DELETE',
  'access.manage',
  async (_req, { session, params }) => {
    const readOnly = readOnlyResponse();
    if (readOnly) return readOnly;
    const p = parseWith(paramsSchema, params);
    if (!p.ok) return p.response;

    return respond(async () => {
      await revokeAssignment(p.data.id, session.user.id);
      return NextResponse.json({ ok: true });
    });
  },
);
