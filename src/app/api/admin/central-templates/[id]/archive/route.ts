import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { archiveCentralTemplate } from '@/lib/skabeloner/central';
import { centralStateChangeSchema } from '@/lib/skabeloner/central-schemas';
import { adminDto, json, parseBody, parseParams } from '../../http';

type P = { id: string };

export const POST = withAuthz<P>(
  'admin/central-templates/[id]/archive POST',
  'template.manage',
  async (req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    const body = await parseBody(req, centralStateChangeSchema);
    if (!body.ok) return body.response;
    return respond(async () => {
      const template = await archiveCentralTemplate(principal, p.data.id, body.data);
      return json({ template: adminDto(template) });
    });
  },
);
