import { respond } from '@/lib/authz/access-http';
import { accessSource } from '@/lib/authz/config';
import { hasCapability, withAuthz } from '@/lib/authz/guard';
import { catalogueConfigIssue } from '@/lib/rollekatalog/config';
import { listCatalogue } from '@/lib/skabeloner/central';
import { catalogueEntryDto, json } from '../http';

// The role/group catalogue for the target picker: the 'config' and 'rollekatalog' sources merged
// (one table), inactive entries included so a withdrawn target can still be named. Names and
// identifiers only. `canTarget`: whether roles and groups can be used as targets at all (claims
// mode only; `reason` is 'needs_claims' otherwise, else null); `canRefresh`: whether the refresh
// button applies (sync.run and a configured Rollekatalog).
export const GET = withAuthz('admin/central-templates/roles GET', 'template.manage', async (_req, { principal }) =>
  respond(async () => {
    const { entries, lastRefreshedAt } = await listCatalogue();
    // Roles and groups only reach anybody when they come from the users' login claims.
    const reason = accessSource() !== 'claims' ? 'needs_claims' : null;
    return json({
      roles: entries.map(catalogueEntryDto),
      canTarget: reason === null,
      reason,
      // The access mode, so the screens can say which sharing route applies (units, or roles/groups via claims).
      source: accessSource(),
      canRefresh: hasCapability(principal, 'sync.run') && catalogueConfigIssue() === null,
      lastRefreshedAt,
    });
  }),
);
