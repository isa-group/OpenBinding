// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/constants.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's tabs, in the address (`/orgs/:org/:tab?`), with who may open each; SPHERE's `beta` flag marks a tab
// only users with beta features see (Connections); the role names and colours live with the role badge
// (components/role-badge/roles.ts), VIEWER included.

import type { Tab } from './types';

export { ROLE_COLORS, ROLE_LABELS } from '../../components/role-badge/roles';

/**
 * What each tab shows: its label and icon, the least role that opens it (`null`: anybody who reads the page) and whether only
 * users with beta features on see it (`beta`).
 */
export const TAB_META: Record<
  Tab,
  { label: string; icon: string; minRole: 'VIEWER' | 'ADMIN' | null; beta?: boolean }
> = {
  overview: { label: 'Overview', icon: 'mdi:view-dashboard-outline', minRole: null },
  compositions: { label: 'Compositions', icon: 'mdi:tag-outline', minRole: null },
  problems: { label: 'Problems', icon: 'mdi:file-tree-outline', minRole: 'VIEWER' },
  runs: { label: 'Runs', icon: 'mdi:play-circle-outline', minRole: 'VIEWER' },
  studies: { label: 'Studies', icon: 'mdi:chart-box-outline', minRole: 'VIEWER' },
  members: { label: 'Members', icon: 'mdi:account-group-outline', minRole: 'VIEWER' },
  invitations: { label: 'Invitations', icon: 'mdi:link-variant', minRole: 'ADMIN' },
  hierarchy: { label: 'Hierarchy', icon: 'mdi:graph-outline', minRole: 'VIEWER' },
  presets: { label: 'Presets', icon: 'mdi:tune-variant', minRole: 'VIEWER' },
  audit: { label: 'Audit', icon: 'mdi:shield-check-outline', minRole: 'ADMIN' },
  connections: {
    label: 'Connections',
    icon: 'mdi:link-variant-plus',
    minRole: 'ADMIN',
    beta: true,
  },
};

/** The tabs in the order of the bar. */
export const TABS = Object.keys(TAB_META) as Tab[];

export function isTab(value: string | undefined): value is Tab {
  return value !== undefined && (TABS as string[]).includes(value);
}
