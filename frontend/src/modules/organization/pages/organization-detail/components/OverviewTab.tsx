// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/OverviewTab.tsx (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's counts, from the gateway's stats (members, sub-organizations, compositions, problems, runs,
// studies); a non-member sees the public compositions only.

import { motion } from 'framer-motion';
import Iconify from '../../../../core/components/iconify';
import { cardHover, transitionDefault } from '../../../../core/utils/motion-variants';
import type {
  OrganizationInvitation,
  OrganizationStats,
  PublicOrganization,
} from '../../../api/organizationsApi';

interface Props {
  org: { description?: string | null } & Partial<Pick<PublicOrganization, 'public_compositions'>>;
  /** A member's counts; null on the public view. */
  stats: OrganizationStats | null;
  invitations: OrganizationInvitation[];
  createdAt: string | null;
}

export default function OverviewTab({ org, stats, invitations, createdAt }: Props) {
  const created = createdAt
    ? new Date(createdAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const tiles: Array<{
    label: string;
    value: number | string;
    icon: string;
    color: string;
    isText?: boolean;
  }> = stats
    ? [
        {
          label: 'Members',
          value: stats.members,
          icon: 'mdi:account-group-outline',
          color: 'bg-tp-primary/8 text-tp-accent',
        },
        {
          label: 'Sub-organizations',
          value: stats.sub_organizations,
          icon: 'mdi:graph-outline',
          color: 'bg-emerald-50 text-emerald-700',
        },
        {
          label: 'Compositions',
          value: stats.compositions,
          icon: 'mdi:tag-outline',
          color: 'bg-blue-50 text-blue-700',
        },
        {
          label: 'Problems',
          value: stats.problems,
          icon: 'mdi:file-tree-outline',
          color: 'bg-purple-50 text-purple-700',
        },
        {
          label: 'Runs',
          value: stats.runs,
          icon: 'mdi:play-circle-outline',
          color: 'bg-amber-50 text-amber-700',
        },
        {
          label: 'Studies',
          value: stats.studies,
          icon: 'mdi:chart-box-outline',
          color: 'bg-rose-50 text-rose-700',
        },
        ...(invitations.length > 0
          ? [
              {
                label: 'Invitations',
                value: invitations.length,
                icon: 'mdi:link-variant',
                color: 'bg-amber-50 text-amber-700',
              },
            ]
          : []),
        ...(created
          ? [
              {
                label: 'Created',
                value: created,
                icon: 'mdi:calendar-outline',
                color: 'bg-tp-surface text-tp-steel',
                isText: true,
              },
            ]
          : []),
      ]
    : [
        {
          label: 'Public compositions',
          value: org.public_compositions ?? 0,
          icon: 'mdi:tag-outline',
          color: 'bg-blue-50 text-blue-700',
        },
      ];

  return (
    <motion.div
      key="overview"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
    >
      <h2 className="sr-only">Overview</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(stat => (
          <motion.div
            key={stat.label}
            variants={cardHover}
            initial="rest"
            whileHover="hover"
            className="rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-shadow hover:shadow-elevation-1"
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.color}`}>
                <Iconify icon={stat.icon} width={18} />
              </div>
              <div>
                {stat.isText ? (
                  <p className="text-sm font-medium text-tp-ink">{stat.value}</p>
                ) : (
                  <p className="text-2xl font-semibold text-tp-ink">{stat.value}</p>
                )}
                <p className="text-[11px] text-tp-steel">{stat.label}</p>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
