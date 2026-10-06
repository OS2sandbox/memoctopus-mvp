// Admin actions on roles, org units and directory users (written in the same transaction as the change) and
// authorisation denials. Only ids and role keys: never names or emails.
import { z } from 'zod';
import { ROLE_KEYS } from '@/lib/authz/types';
import { code, defineEvent } from './types';

const roleKey = () => z.enum(ROLE_KEYS);
const noDetails = () => z.object({}).strict();
const nullableUuid = () => z.string().uuid().nullable();

export const accessEvents = {
  'access.role_assign': defineEvent({
    sources: ['server'],
    entityType: 'role_assignment',
    entityIdRequired: true,
    secondaryEntityTypes: ['directory_user'],
    details: z
      .object({
        roleKey: roleKey(),
        scopeOrgUnitUuid: nullableUuid().optional(),
        includeDescendants: z.boolean().optional(),
        bootstrap: z.boolean().optional(),
      })
      .strict(),
  }),
  'access.role_revoke': defineEvent({
    sources: ['server'],
    entityType: 'role_assignment',
    entityIdRequired: true,
    secondaryEntityTypes: ['directory_user'],
    details: z.object({ roleKey: roleKey(), scopeOrgUnitUuid: nullableUuid().optional() }).strict(),
  }),
  'access.org_unit_create': defineEvent({
    sources: ['server'],
    entityType: 'org_unit',
    entityIdRequired: true,
    secondaryEntityTypes: ['org_unit'],
    details: noDetails(),
  }),
  'access.org_unit_update': defineEvent({
    sources: ['server'],
    entityType: 'org_unit',
    entityIdRequired: true,
    secondaryEntityTypes: ['org_unit'],
    details: z.object({ nameChanged: z.boolean().optional(), parentChanged: z.boolean().optional() }).strict(),
  }),
  'access.org_unit_delete': defineEvent({
    sources: ['server'],
    entityType: 'org_unit',
    entityIdRequired: true,
    details: noDetails(),
  }),
  'access.member_add': defineEvent({
    sources: ['server'],
    entityType: 'org_unit_member',
    entityIdRequired: true,
    secondaryEntityTypes: ['directory_user'],
    details: noDetails(),
  }),
  'access.member_remove': defineEvent({
    sources: ['server'],
    entityType: 'org_unit_member',
    entityIdRequired: true,
    secondaryEntityTypes: ['directory_user'],
    details: noDetails(),
  }),
  'access.user_create': defineEvent({
    sources: ['server'],
    entityType: 'directory_user',
    entityIdRequired: true,
    details: z.object({ source: z.enum(['local', 'rollekatalog']).optional() }).strict(),
  }),
  'access.user_link': defineEvent({
    sources: ['server'],
    entityType: 'directory_user',
    entityIdRequired: true,
    details: z
      .object({
        via: z.enum(['userid-claim', 'extuuid-claim', 'email', 'manual']).optional(),
        automatic: z.boolean().optional(),
      })
      .strict(),
  }),
  'authz.denied': defineEvent({
    sources: ['server'],
    entityType: null,
    anyEntityType: true,
    entityIdRequired: false,
    defaultOutcome: 'denied',
    // required = the capability or guard that refused, reason = short machine reason.
    details: z.object({ required: code(), reason: code() }).strict(),
  }),
} as const;
