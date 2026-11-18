import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { listAudienceOrgUnits } from '@/lib/skabeloner/central';
import { json, scopeUnitDto } from '../http';

// The audience picker: every org unit (whoever manages a template may share it with any unit).
export const GET = withAuthz('admin/central-templates/scope GET', 'template.manage', async (_req, { principal }) =>
  respond(async () => {
    const orgUnits = await listAudienceOrgUnits(principal);
    return json({ orgUnits: orgUnits.map(scopeUnitDto) });
  }),
);
