import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { listScopeOrgUnits } from '@/lib/skabeloner/central';
import { json, scopeUnitDto } from '../http';

// Owner and target pickers: only units inside the caller's template.manage scope.
export const GET = withAuthz('admin/central-templates/scope GET', 'template.manage', async (_req, { principal }) =>
  respond(async () => {
    const orgUnits = await listScopeOrgUnits(principal);
    return json({ orgUnits: orgUnits.map(scopeUnitDto) });
  }),
);
