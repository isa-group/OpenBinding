// The non-drag path of SPHERE's organization tree (frontend/src/modules/organization/pages/organizations-list, revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md. Pattern only: SPHERE moves organizations by dragging alone; this dialog makes the same move from a
// phone or the keyboard, drawn with the modal recipe.

import { useId, useState } from 'react';
import { Modal } from '../../../core/components/modal';
import type { Organization } from '../../api/organizationsApi';

interface MoveOrganizationModalProps {
  organization: Organization;
  /** Every organization of the account, flat. */
  organizations: Organization[];
  /** The organization's own branch: it cannot land there. */
  blockedIds: Set<string>;
  onClose: () => void;
  /** The new parent's id, or null for the top level. */
  onMove: (parentId: string | null) => void;
}

const ROOT = '';

export default function MoveOrganizationModal({
  organization,
  organizations,
  blockedIds,
  onClose,
  onMove,
}: MoveOrganizationModalProps) {
  const targets = organizations
    .filter(
      org =>
        !blockedIds.has(org.id) &&
        (org.effective_role === 'OWNER' || org.effective_role === 'ADMIN')
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectId = useId();
  const [parent, setParent] = useState<string>(organization.parent_id ?? ROOT);
  const unchanged = parent === (organization.parent_id ?? ROOT);

  return (
    <Modal title={`Move ${organization.name}`} onClose={onClose} size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={event => {
          event.preventDefault();
          onMove(parent === ROOT ? null : parent);
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium text-tp-ink">
            New parent
          </label>
          <select
            id={selectId}
            value={parent}
            onChange={event => setParent(event.target.value)}
            className="h-11 rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/15 focus:outline-none"
          >
            <option value={ROOT}>None (top level)</option>
            {targets.map(org => (
              <option key={org.id} value={org.id}>
                {org.name} (@{org.slug})
              </option>
            ))}
          </select>
          <span className="text-xs text-tp-steel">
            You need to be an admin of the organization and of its new parent.
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={unchanged}
            className="cursor-pointer rounded-md bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            Move
          </button>
        </div>
      </form>
    </Modal>
  );
}
