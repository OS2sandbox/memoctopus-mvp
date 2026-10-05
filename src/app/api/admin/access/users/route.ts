import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthz } from '@/lib/authz/guard';
import { listAppUsersWithRoles } from '@/lib/authz/access-admin';
import { parseWith } from '@/lib/authz/access-http';

const querySchema = z
  .object({
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

// Readable in both modes: in rollekatalog mode it is the read-only view.
export const GET = withAuthz('admin/access/users GET', 'access.manage', async (req) => {
  const parsed = parseWith(querySchema, Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.ok) return parsed.response;
  const users = await listAppUsersWithRoles(parsed.data);
  return NextResponse.json({ users });
});
