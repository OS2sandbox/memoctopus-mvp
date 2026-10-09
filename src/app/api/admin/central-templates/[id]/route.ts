import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { getManageableTemplate, updateCentralTemplate } from '@/lib/skabeloner/central';
import { updateCentralTemplateSchema } from '@/lib/skabeloner/central-schemas';
import { adminDto, json, parseBody, parseParams } from '../http';

type P = { id: string };

// An unknown id and one outside the caller's scope both answer 404 (service).
// Reading a template (prompt included) is deliberately not audited: the log records
// what people changed, not what they looked at.
export const GET = withAuthz<P>(
  'admin/central-templates/[id] GET',
  'template.manage',
  async (_req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    return respond(async () => {
      const template = await getManageableTemplate(principal, p.data.id);
      return json({ template: adminDto(template) });
    });
  },
);

export const PUT = withAuthz<P>(
  'admin/central-templates/[id] PUT',
  'template.manage',
  async (req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    const body = await parseBody(req, updateCentralTemplateSchema);
    if (!body.ok) return body.response;
    return respond(async () => {
      const template = await updateCentralTemplate(principal, p.data.id, body.data);
      return json({ template: adminDto(template) });
    });
  },
);
