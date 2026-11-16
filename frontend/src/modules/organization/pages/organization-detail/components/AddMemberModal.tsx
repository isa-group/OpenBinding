// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/AddMemberModal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: people are found by username (UserSearchInput) instead of typed blind, several at once, members left out; the
// role is VIEWER, MEMBER or ADMIN; the gateway's upsert adds each; OpenBinding's accessible dialog (focus trap, Escape).

import { useMemo, useState, type FormEvent } from 'react';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import { Modal } from '../../../../core/components/modal';
import { useOrganizationsApi, type OrgMember, type OrgRole } from '../../../api/organizationsApi';
import UserSearchInput, { type UserSearchResult } from '../../../components/user-search-input';

interface Props {
  orgSlug: string;
  members: OrgMember[];
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}

export default function AddMemberModal({ orgSlug, members, onClose, onAdded }: Props) {
  const [people, setPeople] = useState<UserSearchResult[]>([]);
  const [role, setRole] = useState<OrgRole>('MEMBER');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { upsertMember } = useOrganizationsApi();
  const memberIds = useMemo(() => new Set(members.map(member => member.user_id)), [members]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (people.length === 0) return;
    setIsSubmitting(true);
    setError(null);
    try {
      for (const person of people) await upsertMember(orgSlug, person.id, role);
      await onAdded();
      onClose();
    } catch (caught) {
      setError(readApiError(caught).message || 'The people could not be added.');
      setIsSubmitting(false);
    }
  };

  return (
    <Modal title="Add members" onClose={onClose}>
      <form onSubmit={e => void handleSubmit(e)} className="flex flex-col gap-4">
        {error && <BlockAlert variant="error" message={error} />}
        <UserSearchInput selectedUsers={people} onUsersChange={setPeople} excludedIds={memberIds} />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="add-member-role"
            className="text-xs font-medium tracking-wide text-tp-steel uppercase"
          >
            Role
          </label>
          <select
            id="add-member-role"
            value={role}
            onChange={e => setRole(e.target.value as OrgRole)}
            className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20"
          >
            <option value="VIEWER">Viewer: can look</option>
            <option value="MEMBER">Member: can create and edit</option>
            <option value="ADMIN">Admin: can manage members and settings</option>
          </select>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-slate transition-colors hover:bg-tp-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || people.length === 0}
            className="cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
          >
            {isSubmitting
              ? 'Adding...'
              : people.length > 1
                ? `Add ${people.length} members`
                : 'Add member'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
