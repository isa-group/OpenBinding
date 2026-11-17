// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/InvitationsTab.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's code invitations (who made each, when it expires, how often it was used); the join address is
// `/orgs/join/:code`; refusals read with readApiError.

import { motion } from 'framer-motion';
import { useState } from 'react';
import { readApiError } from '../../../../core/api/errors';
import Iconify from '../../../../core/components/iconify';
import customAlert from '../../../../core/utils/custom-alert';
import customConfirm from '../../../../core/utils/custom-confirm';
import { transitionDefault } from '../../../../core/utils/motion-variants';
import { useOrganizationsApi, type OrganizationInvitation } from '../../../api/organizationsApi';
import { isActiveInvitation, joinUrl } from '../invitations';

interface Props {
  orgSlug: string;
  invitations: OrganizationInvitation[];
  canManage: boolean;
  onRefresh: () => void | Promise<void>;
  onOpenInvite: () => void;
}

export default function InvitationsTab({
  orgSlug,
  invitations,
  canManage,
  onRefresh,
  onOpenInvite,
}: Props) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const { revokeInvitation } = useOrganizationsApi();

  const handleCopy = (code: string) => {
    void navigator.clipboard?.writeText(joinUrl(code)).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    });
  };

  return (
    <motion.section
      key="invitations"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Invitations"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">Invitations</h2>
          <p className="text-xs text-tp-steel">
            Invitation links let people join as members; adjust their role afterwards.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={onOpenInvite}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
          >
            <Iconify icon="mdi:link-plus" width={16} />
            Generate invite
          </button>
        )}
      </div>

      <ul className="divide-y divide-tp-hairline">
        {invitations.length === 0 && (
          <li className="flex flex-col items-center gap-2 py-12 text-tp-ink">
            <Iconify icon="mdi:link-variant-off" width={32} />
            <p className="text-sm">No invitations yet.</p>
          </li>
        )}

        {invitations.map(inv => {
          const isActive = isActiveInvitation(inv);
          return (
            <li
              key={inv.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-tp-surface/50"
            >
              <span className="min-w-0 flex-1">
                <code className="block truncate font-mono text-xs text-tp-slate">{inv.code}</code>
                <span className="block text-[11px] text-tp-steel">
                  {inv.created_by ? `By @${inv.created_by.username}` : 'By a former member'}
                  {inv.expires_at
                    ? ` · expires ${new Date(inv.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : ' · never expires'}
                </span>
              </span>
              <span className="text-[11px] whitespace-nowrap text-tp-ink">
                {inv.use_count} use{inv.use_count !== 1 ? 's' : ''}
                {inv.max_uses ? ` / ${inv.max_uses}` : ''}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
              >
                {isActive ? 'Active' : 'Expired'}
              </span>
              {canManage && (
                <>
                  <button
                    type="button"
                    onClick={() => handleCopy(inv.code)}
                    title="Copy invite link"
                    aria-label={copiedCode === inv.code ? 'Link copied' : 'Copy invite link'}
                    className="cursor-pointer text-tp-steel transition-colors hover:text-tp-accent"
                  >
                    <Iconify
                      icon={copiedCode === inv.code ? 'mdi:check' : 'mdi:content-copy'}
                      width={16}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label="Revoke invitation"
                    title="Revoke invitation"
                    onClick={() => {
                      customConfirm(
                        'Revoke this invitation? Nobody can join with its link any more.',
                        {
                          danger: true,
                          confirmLabel: 'Revoke',
                        }
                      )
                        .then(() =>
                          revokeInvitation(orgSlug, inv.id)
                            .then(() => onRefresh())
                            .catch((caught: unknown) =>
                              customAlert(readApiError(caught).message, 'error')
                            )
                        )
                        .catch(() => {});
                    }}
                    className="cursor-pointer text-tp-steel transition-colors hover:text-red-600"
                  >
                    <Iconify icon="mdi:trash-can-outline" width={16} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
