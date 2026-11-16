// Adapted from SPHERE frontend/src/modules/organization/components/organization-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a real link instead of `router.push` (middle-click works); OpenBinding's organizations by slug, with the role
// instead of Personal/Team.

import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import OrgAvatar from '../../../core/components/org-avatar';
import { avatarProps, type Organization } from '../../api/organizationsApi';
import { orgPath } from '../../types/paths';
import RoleBadge from '../role-badge';

interface Props {
  org: Pick<Organization, 'id' | 'slug' | 'name' | 'avatar' | 'effective_role' | 'children'>;
}

export default function OrganizationCard({ org }: Props) {
  const subOrgCount = org.children?.length ?? 0;

  return (
    <motion.div whileHover={{ y: -2 }} transition={{ duration: 0.15 }}>
      <Link
        to={orgPath(org.slug)}
        className="group block cursor-pointer rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors hover:border-tp-hairline-strong hover:shadow-elevation-2"
      >
        <div className="mb-3 flex items-center gap-3">
          <OrgAvatar name={org.name} {...avatarProps(org.avatar)} size={36} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium text-tp-ink group-hover:text-tp-accent">
              {org.name}
            </h3>
            <p className="truncate text-[11px] text-tp-steel">@{org.slug}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-tp-steel">
          {org.effective_role && (
            <RoleBadge role={org.effective_role} className="px-2 py-0.5 text-[10px]" />
          )}
          {subOrgCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-tp-surface px-1.5 py-0.5">
              {subOrgCount} {subOrgCount === 1 ? 'sub-org' : 'sub-orgs'}
            </span>
          )}
        </div>
      </Link>
    </motion.div>
  );
}
