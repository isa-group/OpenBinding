// The role names and pill colours of SPHERE frontend/src/modules/organization/pages/organization-detail/constants.ts
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md. Adapted: OpenBinding's VIEWER (stone), the owner on the accent.

import type { OrgRole } from '../../api/organizationsApi';

export const ROLE_LABELS: Record<OrgRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export const ROLE_COLORS: Record<OrgRole, string> = {
  OWNER: 'bg-tp-primary/10 text-tp-accent',
  ADMIN: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  MEMBER: 'bg-tp-surface text-tp-steel',
  VIEWER: 'bg-stone-100 text-stone-700',
};
