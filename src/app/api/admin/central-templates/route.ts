import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { parseWith, respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { createCentralTemplateSchema, centralStatusFilterSchema } from '@/lib/skabeloner/central-schemas';
import { createCentralTemplate, listManageableTemplates } from '@/lib/skabeloner/central';
import { adminDto, json, listItemDto, parseBody } from './http';

const querySchema = z.object({ status: centralStatusFilterSchema.default('active') }).strict();

function queryObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of req.nextUrl.searchParams) out[k] = v;
  return out;
}

// The service only returns templates whose owner unit is inside the caller's
// template.manage scope; another manager's templates are never listed.
export const GET = withAuthz('admin/central-templates GET', 'template.manage', async (req, { principal }) => {
  const q = parseWith(querySchema, queryObject(req));
  if (!q.ok) return q.response;
  return respond(async () => {
    const templates = await listManageableTemplates(principal, {
      status: q.data.status,
    });
    return json({ templates: templates.map(listItemDto) });
  });
});

// Works in both access modes: templates are owned by this app, not by Rollekatalog.
export const POST = withAuthz('admin/central-templates POST', 'template.manage', async (req, { principal }) => {
  const body = await parseBody(req, createCentralTemplateSchema);
  if (!body.ok) return body.response;
  return respond(async () => {
    const template = await createCentralTemplate(principal, body.data);
    return json({ template: adminDto(template) }, 201);
  });
});
