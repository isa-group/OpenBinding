// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/EditOrgModal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the name and the description of an OpenBinding organization (its slug never changes); OpenBinding's
// accessible dialog; the refusal shows in place; a personal organization keeps its account's name.

import { useState, type FormEvent } from 'react';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import { Modal } from '../../../../core/components/modal';
import { useOrganizationsApi, type Organization } from '../../../api/organizationsApi';

interface Props {
  org: Organization;
  onClose: () => void;
  onSaved: (updated: Organization) => void;
}

export default function EditOrgModal({ org, onClose, onSaved }: Props) {
  const [name, setName] = useState(org.name);
  const [description, setDescription] = useState(org.description ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { updateOrganization } = useOrganizationsApi();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    updateOrganization(org.slug, { name: name.trim(), description: description.trim() })
      .then(updated => onSaved(updated))
      .catch((caught: unknown) => {
        setError(readApiError(caught).message || 'The organization could not be saved.');
        setIsSaving(false);
      });
  };

  return (
    <Modal title="Edit organization" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <BlockAlert variant="error" message={error} />}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-org-name"
            className="text-xs font-medium tracking-wide text-tp-steel uppercase"
          >
            Name
          </label>
          <input
            id="edit-org-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            readOnly={org.is_personal}
            aria-describedby="edit-org-name-hint"
            maxLength={255}
            className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20"
          />
          <p id="edit-org-name-hint" className="text-xs text-tp-steel">
            {org.is_personal ? (
              <>
                A personal organization keeps its account&rsquo;s name and address,{' '}
                <span className="font-mono">@{org.slug}</span>.
              </>
            ) : (
              <>
                The address stays <span className="font-mono">@{org.slug}</span>.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-org-description"
            className="text-xs font-medium tracking-wide text-tp-steel uppercase"
          >
            Description
          </label>
          <textarea
            id="edit-org-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20"
          />
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
            disabled={isSaving || !name.trim()}
            className="cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
