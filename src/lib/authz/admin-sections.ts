// One table drives both the admin navigation and the route gate, so what a
// user sees in the menu can never differ from what the server lets them open.
import { hasAnyCapability } from './permissions';
import type { Capability, Principal } from './types';

export type AdminSectionKey = 'overview' | 'users' | 'organisation';

export interface AdminSection {
  key: AdminSectionKey;
  href: string;
  label: string;
  /** ANY-OF: holding one of these is enough. Never empty. */
  requiredCapability: readonly [Capability, ...Capability[]];
  /** Becomes a read-only view when ACCESS_SOURCE=rollekatalog. */
  readOnlyInRollekatalogMode: boolean;
}

export const sectionByKey: Record<AdminSectionKey, AdminSection> = {
  overview: {
    key: 'overview',
    href: '/admin',
    label: 'Overblik',
    // Every admin-ish capability; plain template.use is deliberately absent.
    requiredCapability: [
      'directory.read',
      'access.manage',
      'template.manage',
      'audit.read',
      'audit.export',
      'sync.run',
    ],
    readOnlyInRollekatalogMode: false,
  },
  users: {
    key: 'users',
    href: '/admin/brugere',
    label: 'Brugere og roller',
    requiredCapability: ['access.manage'],
    readOnlyInRollekatalogMode: true,
  },
  organisation: {
    key: 'organisation',
    href: '/admin/organisation',
    label: 'Organisation',
    requiredCapability: ['directory.read'],
    readOnlyInRollekatalogMode: true,
  },
};

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  sectionByKey.overview,
  sectionByKey.users,
  sectionByKey.organisation,
];

export function canAccessSection(p: Principal, key: AdminSectionKey): boolean {
  return hasAnyCapability(p, sectionByKey[key].requiredCapability);
}

export function visibleSections(p: Principal): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => canAccessSection(p, s.key));
}
