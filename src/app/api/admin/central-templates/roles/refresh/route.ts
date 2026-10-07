import { NextResponse } from 'next/server';
import { forceBodySchema, parseWith, readOptionalJsonBody } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { runCatalogueRefresh } from '@/lib/rollekatalog/catalogue-sync';
import { catalogueResultResponse } from '@/lib/rollekatalog/catalogue-http';
import { catalogueConfigIssue } from '@/lib/rollekatalog/config';
import { catalogueErrorMessage } from '@/lib/rollekatalog/labels.da';

// The admin button "Opdatér rollekatalog". sync.run (a GLOBAL assignment), like the
// user/organisation sync button; independent of ACCESS_SOURCE. Counts and short codes only.
export const POST = withAuthz('admin/central-templates/roles/refresh POST', 'sync.run', async (req) => {
  const raw = await readOptionalJsonBody(req);
  if (!raw.ok) return raw.response;
  const parsed = parseWith(forceBodySchema, raw.value);
  if (!parsed.ok) return parsed.response;

  const issue = catalogueConfigIssue();
  if (issue) return NextResponse.json({ error: catalogueErrorMessage(issue), code: issue }, { status: 409 });

  return catalogueResultResponse(await runCatalogueRefresh({ trigger: 'manual', force: parsed.data.force === true }), true);
});
