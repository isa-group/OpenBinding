// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/InviteModal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's code invitations (expiry in days, an optional cap on uses) and its invite-users route; the
// people are found with UserSearchInput; OpenBinding's accessible dialog with SPHERE's two views as tabs; refusals read
// with readApiError, shown in place.

import { useState } from 'react';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import Iconify from '../../../../core/components/iconify';
import { Modal } from '../../../../core/components/modal';
import { useOrganizationsApi, type OrganizationInvitation } from '../../../api/organizationsApi';
import UserSearchInput, { type UserSearchResult } from '../../../components/user-search-input';
import { isActiveInvitation, joinUrl } from '../invitations';

interface Props {
  orgSlug: string;
  invitations: OrganizationInvitation[];
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}

const EXPIRY_CHOICES = [1, 7, 30, 90];

export default function InviteModal({ orgSlug, invitations, onClose, onRefresh }: Props) {
  const [activeTab, setActiveTab] = useState<'link' | 'users'>('link');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<UserSearchResult[]>([]);
  const [isInviting, setIsInviting] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number>(7);
  const [maxUses, setMaxUses] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const { createInvitation, inviteUsers } = useOrganizationsApi();

  const handleGenerate = () => {
    setIsGenerating(true);
    setError(null);
    const maxUsesNum = maxUses ? parseInt(maxUses, 10) : undefined;
    createInvitation(orgSlug, {
      expires_in_days: expiresInDays,
      ...(maxUsesNum && maxUsesNum > 0 ? { max_uses: maxUsesNum } : {}),
    })
      .then(() => onRefresh())
      .catch((caught: unknown) => setError(readApiError(caught).message))
      .finally(() => setIsGenerating(false));
  };

  const handleCopy = (code: string) => {
    void navigator.clipboard?.writeText(joinUrl(code)).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    });
  };

  const handleInviteUsers = async () => {
    if (selectedUsers.length === 0) return;
    setIsInviting(true);
    setError(null);
    try {
      await inviteUsers(
        orgSlug,
        selectedUsers.map(u => u.id)
      );
      setSent(`${selectedUsers.length} invitation${selectedUsers.length === 1 ? '' : 's'} sent.`);
      setSelectedUsers([]);
      await onRefresh();
    } catch (caught) {
      setError(readApiError(caught).message || 'The invitations could not be sent.');
    } finally {
      setIsInviting(false);
    }
  };

  const activeInvitations = invitations.filter(inv => isActiveInvitation(inv));

  return (
    <Modal title="Invite members" onClose={onClose} size="lg">
      <div
        role="tablist"
        aria-label="How to invite"
        className="mb-4 flex gap-1 rounded-lg border border-tp-hairline bg-tp-surface p-1"
      >
        {(['link', 'users'] as const).map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-tp-canvas text-tp-ink shadow-elevation-1'
                : 'text-tp-steel hover:text-tp-ink'
            }`}
          >
            <Iconify
              icon={tab === 'link' ? 'mdi:link-variant' : 'mdi:account-plus-outline'}
              width={16}
            />
            {tab === 'link' ? 'Invite link' : 'Invite users'}
          </button>
        ))}
      </div>

      {error && <BlockAlert variant="error" message={error} className="mb-3" />}

      {activeTab === 'link' ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="invite-expiry"
                className="text-xs font-medium tracking-wide text-tp-steel uppercase"
              >
                Expires after
              </label>
              <select
                id="invite-expiry"
                value={expiresInDays}
                onChange={e => setExpiresInDays(Number(e.target.value))}
                className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink outline-none focus:border-tp-primary"
              >
                {EXPIRY_CHOICES.map(days => (
                  <option key={days} value={days}>
                    {days} day{days === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="invite-max-uses"
                className="text-xs font-medium tracking-wide text-tp-steel uppercase"
              >
                Max uses (optional)
              </label>
              <input
                id="invite-max-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                placeholder="Unlimited"
                className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink outline-none focus:border-tp-primary"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-tp-accent px-4 py-2.5 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
          >
            <Iconify
              icon={isGenerating ? 'mdi:loading' : 'mdi:link-plus'}
              width={16}
              className={isGenerating ? 'animate-spin' : ''}
            />
            {isGenerating ? 'Generating...' : 'Generate link'}
          </button>
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-tp-steel uppercase">
              Active links ({activeInvitations.length})
            </h3>
            {activeInvitations.length === 0 ? (
              <p className="text-sm text-tp-steel">No active links yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activeInvitations.map(inv => (
                  <li
                    key={inv.id}
                    className="flex items-center gap-2 rounded-lg border border-tp-hairline px-3 py-2"
                  >
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-tp-slate">
                      {joinUrl(inv.code)}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy(inv.code)}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-tp-hairline-strong px-2 py-1 text-xs font-medium text-tp-ink hover:bg-tp-surface"
                    >
                      <Iconify
                        icon={copiedCode === inv.code ? 'mdi:check' : 'mdi:content-copy'}
                        width={14}
                      />
                      {copiedCode === inv.code ? 'Copied' : 'Copy'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-tp-slate">
            Each person gets a notification with a link to join as a member.
          </p>
          <UserSearchInput selectedUsers={selectedUsers} onUsersChange={setSelectedUsers} />
          {sent && <BlockAlert variant="success" message={sent} />}
          <button
            type="button"
            onClick={() => void handleInviteUsers()}
            disabled={isInviting || selectedUsers.length === 0}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-tp-accent px-4 py-2.5 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
          >
            <Iconify icon="mdi:send" width={16} />
            {isInviting ? 'Sending...' : 'Send invitations'}
          </button>
        </div>
      )}
    </Modal>
  );
}
