import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { listVersions } from '@/lib/skabeloner/central';
import { json, parseParams, versionDto } from '../../http';

// The changelog is as sensitive as the prompt: same scope rule, managers only.
// Like the detail, reading it is not audited.
export const GET = withAuthz<{ id: string }>(
  'admin/central-templates/[id]/versions GET',
  'template.manage',
  async (_req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    return respond(async () => {
      const versions = await listVersions(principal, p.data.id);
      return json({ versions: versions.map(versionDto) });
    });
  },
);
