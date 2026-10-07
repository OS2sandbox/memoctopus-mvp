import { respond } from '@/lib/authz/access-http';
import { hasCapability, withAuthz } from '@/lib/authz/guard';
import { hasGlobalScope } from '@/lib/authz/scope';
import { catalogueConfigIssue } from '@/lib/rollekatalog/config';
import { listCatalogue } from '@/lib/skabeloner/central';
import { catalogueEntryDto, json } from '../http';

// The role/group catalogue for the target picker: the 'config' and 'rollekatalog' sources merged
// (one table), inactive entries included so a withdrawn target can still be named. Names and
// identifiers only. `canTarget`: whether the caller may use roles and groups as targets at all
// (global managers only); `canRefresh`: whether the refresh button applies (sync.run and a
// configured Rollekatalog). A scoped manager gets the list too, so a template they can see
// names its audience, but cannot pick from it.
export const GET = withAuthz('admin/central-templates/roles GET', 'template.manage', async (_req, { principal }) =>
  respond(async () => {
    const { entries, lastRefreshedAt } = await listCatalogue();
    return json({
      roles: entries.map(catalogueEntryDto),
      canTarget: hasGlobalScope(principal, 'template.manage'),
      canRefresh: hasCapability(principal, 'sync.run') && catalogueConfigIssue() === null,
      lastRefreshedAt,
    });
  }),
);
