// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/ChildRolesManager.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the sub-organizations come from the gateway's hierarchy (only those this account administers); each shows
// where the account's own role there comes from (`role_source`); a role is set by writing a direct membership on the
// child through the member upsert, VIEWER included; the owner's seat is not edited here; refusals read with readApiError.

import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { readApiError } from '../../../../core/api/errors';
import Iconify from '../../../../core/components/iconify';
import OrgAvatar from '../../../../core/components/org-avatar';
import UserAvatar from '../../../../core/components/user-avatar';
import customAlert from '../../../../core/utils/custom-alert';
import { transitionDefault } from '../../../../core/utils/motion-variants';
import {
  avatarProps,
  useOrganizationsApi,
  type Organization,
  type OrgMember,
  type OrgRole,
} from '../../../api/organizationsApi';
import { orgPath } from '../../../types/paths';
import { ROLE_COLORS, ROLE_LABELS } from '../constants';
import type { TreeNode } from '../types';

interface Props {
  org: Organization;
  tree: TreeNode;
  /** The account's organizations, with its role in each and where that role comes from. */
  organizations: Organization[];
  currentUserId: string | undefined;
}

const roleKey = (organization: string, userId: string) => `${organization}:${userId}`;

function findNode(node: TreeNode, id: string): TreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export default function ChildRolesManager({ org, tree, organizations, currentUserId }: Props) {
  const { getMembers, upsertMember } = useOrganizationsApi();
  const children = useMemo(() => {
    const current = findNode(tree, org.id);
    const managed = new Map(
      organizations
        .filter(item => item.effective_role === 'OWNER' || item.effective_role === 'ADMIN')
        .map(item => [item.id, item])
    );
    return (current?.children ?? []).flatMap(child => {
      const mine = managed.get(child.id);
      return mine && child.hasAccess ? [mine] : [];
    });
  }, [tree, org.id, organizations]);
  const [membersBySlug, setMembersBySlug] = useState<Record<string, OrgMember[]>>({});
  const [draft, setDraft] = useState<Record<string, OrgRole>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const childKey = children.map(child => child.slug).join(',');
  const load = useCallback(async () => {
    const slugs = childKey ? childKey.split(',') : [];
    const results = await Promise.allSettled(slugs.map(slug => getMembers(slug)));
    const next: Record<string, OrgMember[]> = {};
    const broken = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next[slugs[index]] = result.value;
      else broken.add(slugs[index]);
    });
    setMembersBySlug(next);
    setFailed(broken);
  }, [childKey, getMembers]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the members are loaded when the sub-organizations are known
    void load();
  }, [load]);

  const pending = Object.entries(draft);
  if (children.length === 0) return null;

  const save = async () => {
    setIsSaving(true);
    let saved = 0;
    const errors: string[] = [];
    for (const [key, role] of pending) {
      const [slug, userId] = key.split(':');
      try {
        await upsertMember(slug, userId, role);
        saved += 1;
      } catch (caught) {
        errors.push(readApiError(caught).message);
      }
    }
    setDraft({});
    await load();
    setIsSaving(false);
    void customAlert(
      errors.length === 0
        ? `${saved} role change${saved === 1 ? '' : 's'} saved in the sub-organizations.`
        : `${saved} saved; ${errors.length} refused. ${errors[0]}`,
      errors.length === 0 ? 'success' : 'error'
    );
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitionDefault}
      aria-label="Roles in sub-organizations"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">Roles in sub-organizations</h2>
          <p className="text-xs text-tp-steel">
            Everyone here keeps their role below. Give someone a stronger role in one
            sub-organization only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending.length === 0 || isSaving}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Iconify icon="mdi:content-save-outline" width={16} />
          {isSaving ? 'Saving...' : pending.length > 0 ? `Save ${pending.length}` : 'Save'}
        </button>
      </div>

      <ul className="divide-y divide-tp-hairline">
        {children.map(child => {
          const members = membersBySlug[child.slug];
          const source =
            child.role_source && child.role_source.id !== child.id ? child.role_source : null;
          return (
            <li key={child.id} className="px-5 py-4">
              <div className="mb-2 flex items-center gap-3">
                <OrgAvatar name={child.name} {...avatarProps(child.avatar)} size={28} square />
                <div className="min-w-0 flex-1">
                  <Link
                    to={orgPath(child.slug)}
                    className="text-sm font-medium text-tp-ink hover:text-tp-accent"
                  >
                    {child.name}
                  </Link>
                  <p className="text-[11px] text-tp-steel">
                    Your role: {child.effective_role ? ROLE_LABELS[child.effective_role] : 'none'}
                    {source ? `, inherited from ${source.name}` : ', your own'}
                  </p>
                </div>
              </div>
              {failed.has(child.slug) && (
                <p role="alert" className="text-xs text-red-700">
                  The members of {child.name} could not be loaded.
                </p>
              )}
              {members && members.length === 0 && (
                <p className="text-xs text-tp-steel">Nobody holds a role of their own here.</p>
              )}
              {members && members.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {members.map(member => {
                    const key = roleKey(child.slug, member.user_id);
                    const name = member.username ?? member.email ?? 'Former member';
                    const editable = member.role !== 'OWNER' && member.user_id !== currentUserId;
                    return (
                      <li
                        key={member.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-tp-surface/50"
                      >
                        <UserAvatar
                          username={name}
                          displayName={member.display_name}
                          avatar={member.avatar}
                          size={24}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-tp-ink">@{name}</span>
                        {editable ? (
                          <select
                            aria-label={`Role for ${name} in ${child.name}`}
                            value={draft[key] ?? member.role}
                            onChange={event => {
                              const role = event.target.value as OrgRole;
                              setDraft(previous => {
                                const next = { ...previous };
                                if (role === member.role) delete next[key];
                                else next[key] = role;
                                return next;
                              });
                            }}
                            className="cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2.5 py-1.5 text-xs font-medium text-tp-slate outline-none focus:border-tp-primary"
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
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
