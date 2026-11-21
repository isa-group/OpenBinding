// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's roles (VIEWER, MEMBER, ADMIN; the owner seat moves only by the crown); the drafted role changes
// and removals are saved together through the gateway's atomic batch (at most MEMBER_BATCH_LIMIT), with OpenBinding's
// wording for a refused batch; members are named by username and email; no crown in a personal organization (it is
// never handed over), and no Leave for its owner.

import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { readApiError } from '../../../../core/api/errors';
import Iconify from '../../../../core/components/iconify';
import UserAvatar from '../../../../core/components/user-avatar';
import customAlert from '../../../../core/utils/custom-alert';
import customConfirm from '../../../../core/utils/custom-confirm';
import { transitionDefault } from '../../../../core/utils/motion-variants';
import {
  MEMBER_BATCH_LIMIT,
  useOrganizationsApi,
  type MemberChange,
  type Organization,
  type OrgMember,
  type OrgRole,
} from '../../../api/organizationsApi';
import { ROLE_COLORS, ROLE_LABELS } from '../constants';
import { batchRefusal } from '../memberRefusals';

interface Props {
  org: Organization;
  members: OrgMember[];
  canManage: boolean;
  currentUserId: string | undefined;
  managerRole: OrgRole | null;
  onRefresh: () => Promise<void>;
  /** Handing the organization over changes the viewer's own role, so more than the member list is reloaded. */
  onOwnershipTransferred: () => void | Promise<void>;
  onAddMember: () => void;
  onLeave: () => void | Promise<void>;
}

/** A drafted change: a new role, or `null` to remove the person. */
type Draft = Record<string, OrgRole | null>;

export default function MembersTab({
  org,
  members,
  canManage,
  currentUserId,
  managerRole,
  onRefresh,
  onOwnershipTransferred,
  onAddMember,
  onLeave,
}: Props) {
  const { updateMembersBatch, transferOwnership, removeMember } = useOrganizationsApi();
  const [draft, setDraft] = useState<Draft>({});
  const [isSaving, setIsSaving] = useState(false);

  // A change that the list now shows, or about someone who left, is no longer pending.
  useEffect(() => {
    const current = new Map(members.map(member => [member.user_id, member.role]));
    setDraft(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([userId, role]) => current.has(userId) && current.get(userId) !== role
        )
      )
    );
  }, [members]);

  const pending = useMemo<MemberChange[]>(
    () => Object.entries(draft).map(([user_id, role]) => ({ user_id, role })),
    [draft]
  );
  const nameOf = (member: OrgMember) => member.username ?? member.email ?? 'Former member';

  const setChange = (member: OrgMember, role: OrgRole | null) =>
    setDraft(previous => {
      if (role === member.role) {
        const remaining = { ...previous };
        delete remaining[member.user_id];
        return remaining;
      }
      return { ...previous, [member.user_id]: role };
    });

  const handleSave = async () => {
    if (pending.length === 0 || isSaving) return;
    if (pending.length > MEMBER_BATCH_LIMIT) {
      void customAlert(`Save at most ${MEMBER_BATCH_LIMIT} changes at a time.`, 'error');
      return;
    }
    setIsSaving(true);
    try {
      await updateMembersBatch(org.slug, pending);
      await onRefresh();
      setDraft({});
      void customAlert(
        `${pending.length} member change${pending.length === 1 ? '' : 's'} applied together.`,
        'success'
      );
    } catch (caught) {
      void customAlert(batchRefusal(caught), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTransferOwnership = (member: OrgMember) => {
    customConfirm(
      `Hand ${org.name} over to @${nameOf(member)}? They become its owner, along with every sub-organization under it, and you stay on as an admin.`,
      { danger: true, confirmLabel: 'Transfer ownership' }
    )
      .then(() =>
        transferOwnership(org.slug, member.user_id)
          .then(() => onOwnershipTransferred())
          .catch((caught: unknown) => customAlert(readApiError(caught).message, 'error'))
      )
      .catch(() => {});
  };

  const handleLeave = () => {
    if (managerRole === 'OWNER') {
      void customAlert(
        'An owner cannot leave. Hand the organization over with the crown first.',
        'info'
      );
      return;
    }
    customConfirm(`Leave ${org.name}? You will lose access to everything in it.`, {
      danger: true,
      confirmLabel: 'Leave',
    })
      .then(() =>
        removeMember(org.slug, currentUserId!)
          .then(() => onLeave())
          .catch((caught: unknown) => customAlert(readApiError(caught).message, 'error'))
      )
      .catch(() => {});
  };

  return (
    <motion.section
      key="members"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Members"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">Members</h2>
          <p className="text-xs text-tp-steel">
            {canManage
              ? 'Change roles or remove people; the changes wait here until you save them, and apply together.'
              : 'The people who hold a role here. Roles held above, in a parent organization, apply here too.'}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAddMember}
              disabled={isSaving}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-2 text-sm font-medium text-tp-ink transition-colors hover:border-tp-accent hover:text-tp-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Iconify icon="mdi:account-plus-outline" width={16} />
              Add member
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={pending.length === 0 || isSaving}
              title={
                pending.length === 0
                  ? 'Change one or more roles to enable saving'
                  : `Save ${pending.length} change${pending.length === 1 ? '' : 's'}`
              }
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Iconify
                icon={isSaving ? 'mdi:loading' : 'mdi:content-save-outline'}
                width={16}
                className={isSaving ? 'animate-spin' : ''}
              />
              {isSaving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      {canManage && pending.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
          className="flex flex-col gap-3 border-b border-tp-primary/20 bg-tp-primary/5 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-center gap-2 text-sm text-tp-ink">
            <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-tp-accent px-2 text-xs font-semibold text-tp-on-primary">
              {pending.length}
            </span>
            <span>
              {pending.length} member change{pending.length === 1 ? '' : 's'} ready to save
            </span>
          </div>
          <button
            type="button"
            onClick={() => setDraft({})}
            disabled={isSaving}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Discard
          </button>
        </motion.div>
      )}

      <ul className="divide-y divide-tp-hairline">
        {members.length === 0 && (
          <li className="flex flex-col items-center gap-2 py-12 text-tp-ink">
            <Iconify icon="mdi:account-group-outline" width={32} />
            <p className="text-sm">No members yet.</p>
          </li>
        )}

        {members.map(member => {
          const name = nameOf(member);
          const drafted = member.user_id in draft;
          const removed = drafted && draft[member.user_id] === null;
          const displayedRole = drafted ? (draft[member.user_id] ?? member.role) : member.role;
          const isMe = member.user_id === currentUserId;
          // The owner's seat is not a role anyone edits: there is one, and it moves only by being handed over.
          const canEditRole = canManage && !isMe && member.role !== 'OWNER';

          return (
            <li
              key={member.id}
              className={`flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-tp-surface/50 ${removed ? 'opacity-60' : ''}`}
            >
              <UserAvatar
                username={name}
                displayName={member.display_name}
                avatar={member.avatar}
                size={36}
              />

              <div className="min-w-0 flex-1">
                {member.display_name && (
                  <p
                    className={`truncate text-sm font-medium text-tp-ink ${removed ? 'line-through' : ''}`}
                  >
                    {member.display_name}
                  </p>
                )}
                <p
                  className={
                    member.display_name
                      ? `text-xs text-tp-steel ${removed ? 'line-through' : ''}`
                      : `text-sm font-medium text-tp-ink ${removed ? 'line-through' : ''}`
                  }
                >
                  @{name}
                  {isMe && <span className="ml-1.5 text-xs font-normal text-tp-steel">(you)</span>}
                </p>
                {member.email && (
                  <p className="truncate text-[11px] text-tp-steel">{member.email}</p>
                )}
              </div>

              {canEditRole ? (
                <select
                  value={displayedRole}
                  onChange={event => setChange(member, event.target.value as OrgRole)}
                  disabled={isSaving || removed}
                  aria-label={`Role for ${name}`}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all outline-none focus:border-tp-primary disabled:cursor-wait disabled:opacity-60 ${
                    drafted && !removed
                      ? 'border-tp-primary bg-tp-primary/5 text-tp-accent ring-2 ring-tp-primary/10'
                      : 'border-tp-input-border bg-tp-input-bg text-tp-slate'
                  }`}
                >
                  <option value="VIEWER">Viewer</option>
                  <option value="MEMBER">Member</option>
                  <option value="ADMIN">Admin</option>
                </select>
              ) : (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ROLE_COLORS[member.role]}`}
                >
                  {ROLE_LABELS[member.role]}
                </span>
              )}

              {canManage && managerRole === 'OWNER' && !isMe && !org.is_personal && (
                <button
                  type="button"
                  onClick={() => handleTransferOwnership(member)}
                  disabled={isSaving}
                  title={`Transfer ownership to @${name}`}
                  aria-label={`Transfer ownership to ${name}`}
                  className="cursor-pointer text-tp-steel transition-colors hover:text-tp-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Iconify icon="mdi:crown-outline" width={18} />
                </button>
              )}
              {canEditRole && (
                <button
                  type="button"
                  onClick={() => setChange(member, removed ? member.role : null)}
                  disabled={isSaving}
                  title={removed ? `Keep ${name}` : `Remove ${name}`}
                  aria-label={removed ? `Keep ${name}` : `Remove ${name}`}
                  className="cursor-pointer text-tp-steel transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Iconify icon={removed ? 'mdi:undo' : 'mdi:account-remove-outline'} width={18} />
                </button>
              )}
              {/* A personal organization's owner never leaves it: it goes with the account. */}
              {isMe && !(org.is_personal && member.role === 'OWNER') && (
                <button
                  type="button"
                  onClick={handleLeave}
                  disabled={isSaving}
                  title="Leave organization"
                  aria-label="Leave organization"
                  className="cursor-pointer text-red-700 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Iconify icon="mdi:logout" width={18} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
