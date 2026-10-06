import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { listVersions } from '@/lib/skabeloner/central';
import { auditPromptRead } from '../../audit-read';
import { json, parseParams, versionDto } from '../../http';

// The changelog is as sensitive as the prompt: same scope rule, managers only.
// It carries every historic prompt, so it emits the same coalesced
// central_template.read as the detail (version = the newest one).
export const GET = withAuthz<{ id: string }>(
  'admin/central-templates/[id]/versions GET',
  'template.manage',
  async (req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    return respond(async () => {
      const versions = await listVersions(principal, p.data.id);
      if (versions.length > 0) {
        await auditPromptRead(req, principal.userId, {
          id: p.data.id,
          version: Math.max(...versions.map((v) => v.version)),
        });
      }
      return json({ versions: versions.map(versionDto) });
    });
  },
);
