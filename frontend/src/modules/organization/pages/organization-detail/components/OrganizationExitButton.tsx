// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/OrganizationExitButton.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: Delete is offered to the owner who is the only member, and asks OpenBinding's typed confirmation (the slug) with
// the counts of what goes with the organization; an owner with others hands it over first; a member, an admin or a viewer
// leaves through the self-leave route; refusals (an organization that holds runs) read with readApiError.

import { useState, type FormEvent } from 'react';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import Iconify from '../../../../core/components/iconify';
import { Modal } from '../../../../core/components/modal';
import customAlert from '../../../../core/utils/custom-alert';
import customConfirm from '../../../../core/utils/custom-confirm';
import {
  useOrganizationsApi,
  type Organization,
  type OrgMember,
  type OrgRole,
} from '../../../api/organizationsApi';

interface Props {
  org: Organization;
  members: OrgMember[];
  myRole: OrgRole | null;
  currentUserId?: string;
  onExited: () => void | Promise<void>;
  compact?: boolean;
  disabled?: boolean;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function DeleteDialog({
  org,
  onClose,
  onDeleted,
}: {
  org: Organization;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const { deleteOrganization } = useOrganizationsApi();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stats = org.stats;
  const goes = stats
    ? [
        plural(stats.sub_organizations, 'sub-organization'),
        plural(stats.compositions, 'composition'),
        plural(stats.problems, 'problem'),
        plural(stats.studies, 'study', 'studies'),
      ]
    : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteOrganization(org.slug);
      await onDeleted();
    } catch (caught) {
      const refusal = readApiError(caught);
      setError(
        refusal.status === 409
          ? `${org.name} holds runs or study runs, which are kept as history, so it cannot be deleted (${refusal.status} · ${refusal.code}).`
          : refusal.message || 'The organization could not be deleted.'
      );
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${org.name}`} tone="danger" eyebrow="Cannot be undone" onClose={onClose}>
      <form onSubmit={e => void submit(e)} className="flex flex-col gap-4">
        <p>
          Deleting {org.name} deletes everything in it
          {goes.length > 0 ? `: ${goes.join(', ')}.` : '.'}
        </p>
        {error && <BlockAlert variant="error" message={error} />}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="delete-org-confirm" className="text-sm font-medium text-tp-ink">
            Type <span className="font-mono">{org.slug}</span> to confirm
          </label>
          <input
            id="delete-org-confirm"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 font-mono text-sm text-tp-ink outline-none focus:border-red-500"
          />
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-slate hover:bg-tp-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || typed !== org.slug}
            className="cursor-pointer rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Deleting...' : 'Delete organization'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function OrganizationExitButton({
  org,
  members,
  myRole,
  currentUserId,
  onExited,
  compact = false,
  disabled = false,
}: Props) {
  const { removeMember } = useOrganizationsApi();
  const [isBusy, setIsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isDirectMember = members.some(member => member.user_id === currentUserId);
  const canDelete =
    myRole === 'OWNER' &&
    (members.length === 0 ||
      (members.length === 1 &&
        members[0].user_id === currentUserId &&
        members[0].role === 'OWNER'));
  const label = canDelete ? 'Delete organization' : 'Leave organization';

  // A role inherited from a parent is left there, not here.
  if (!currentUserId || (!canDelete && !isDirectMember)) return null;

  const handleClick = async () => {
    if (isBusy || disabled) return;
    if (canDelete) {
      setDeleting(true);
      return;
    }
    if (myRole === 'OWNER') {
      void customAlert(
        'An owner cannot leave. Hand the organization over to another member first.',
        'info'
      );
      return;
    }
    setIsBusy(true);
    try {
      await customConfirm(`Leave ${org.name}? You will lose access to everything in it.`, {
        danger: true,
        confirmLabel: 'Leave',
      });
    } catch {
      setIsBusy(false);
      return;
    }
    try {
      await removeMember(org.slug, currentUserId);
      await onExited();
    } catch (caught) {
      void customAlert(readApiError(caught).message, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={disabled || isBusy}
        title={label}
        aria-label={label}
        className={
          compact
            ? 'cursor-pointer text-red-700 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40'
            : 'flex cursor-pointer items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40'
        }
      >
        <Iconify
          icon={canDelete ? 'mdi:trash-can-outline' : 'mdi:logout'}
          width={compact ? 18 : 15}
        />
        {!compact && (canDelete ? 'Delete' : 'Leave')}
      </button>
      {deleting && (
        <DeleteDialog org={org} onClose={() => setDeleting(false)} onDeleted={onExited} />
      )}
    </>
  );
}
