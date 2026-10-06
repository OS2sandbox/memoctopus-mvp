import { respond } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { getManageableTemplate, updateCentralTemplate } from '@/lib/skabeloner/central';
import { updateCentralTemplateSchema } from '@/lib/skabeloner/central-schemas';
import { auditPromptRead } from '../audit-read';
import { adminDto, json, parseBody, parseParams } from '../http';

type P = { id: string };

// An unknown id and one outside the caller's scope both answer 404 (service).
// Returning the prompt is audited (central_template.read, coalesced, best-effort),
// and only after the service has let the caller see it: a 404 or 403 emits nothing.
export const GET = withAuthz<P>(
  'admin/central-templates/[id] GET',
  'template.manage',
  async (req, { principal, params }) => {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    return respond(async () => {
      const template = await getManageableTemplate(principal, p.data.id);
      await auditPromptRead(req, principal.userId, {
        id: template.id,
        version: template.currentVersion,
        ownerOrgUnitUuid: template.ownerOrgUnitUuid,
      });
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
