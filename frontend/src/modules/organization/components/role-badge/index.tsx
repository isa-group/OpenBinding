// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/constants.ts and the RoleBadge of
// frontend/src/modules/organization/pages/organizations-list/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's VIEWER role (stone); the owner pill on the accent, so small text keeps its contrast in both palettes.

import type { OrgRole } from '../../api/organizationsApi';
import { ROLE_COLORS, ROLE_LABELS } from './roles';

export default function RoleBadge({ role, className = '' }: { role: OrgRole; className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${ROLE_COLORS[role]} ${className}`}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}
