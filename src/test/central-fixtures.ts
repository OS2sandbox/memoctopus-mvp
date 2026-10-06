// Test-only fixtures shared by the route tests of src/app/api/admin/central-templates.
import type { CentralTemplateAdmin, CentralTemplateVersion } from '@/lib/skabeloner/central-types';
import { makePrincipal } from '@/test/helpers';

export const T1 = '11111111-1111-4111-8111-111111111111';
export const OWNER = '22222222-2222-4222-8222-222222222222';
export const CHILD = '33333333-3333-4333-8333-333333333333';
export const NOTE = 'Præciseret formuleringen af prompten';

export const manager = makePrincipal({
  roles: ['tt-bruger', 'tt-skabelonansvarlig'],
  capabilities: ['template.use', 'template.manage'],
  scopes: { 'template.manage': { global: false, roots: [{ orgUnitUuid: OWNER, includeDescendants: true }] } },
});

export const ADMIN_TEMPLATE: CentralTemplateAdmin = {
  id: T1,
  ownerOrgUnitUuid: OWNER,
  name: 'Fagreferat',
  description: 'Til fagmøder',
  prompt: 'HEMMELIG PROMPT',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: true,
  allowUserInstruction: false,
  allowToggleOverrides: false,
  status: 'active',
  currentVersion: 3,
  targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-02T08:00:00.000Z',
  createdByName: 'Anne Admin',
};

export const VERSION: CentralTemplateVersion = {
  version: 3,
  changeType: 'update',
  changeNote: NOTE,
  changedByName: 'Anne Admin',
  changedAt: '2026-06-02T08:00:00.000Z',
  content: {
    name: 'Fagreferat',
    description: 'Til fagmøder',
    prompt: 'HEMMELIG PROMPT',
    includeDeltagere: true,
    includeBeslutningspunkter: false,
    includeDagsorden: false,
    includeDato: true,
    allowUserInstruction: false,
    allowToggleOverrides: false,
  },
  targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
};
