// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/CreateSubOrgModal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's creation route with the parent's id (the gateway derives the slug); the slug preview; OpenBinding's
// accessible dialog; the refusal shows in place.

import { useState, type FormEvent } from 'react';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import { Modal } from '../../../../core/components/modal';
import SlugPreview from '../../../../core/components/slug-preview';
import { useOrganizationsApi, type Organization } from '../../../api/organizationsApi';

interface Props {
  parent: Organization;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}

export default function CreateSubOrgModal({ parent, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { createOrganization } = useOrganizationsApi();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    createOrganization({
      name: name.trim(),
      parent_id: parent.id,
      ...(description.trim() ? { description: description.trim() } : {}),
    })
      .then(async () => {
        await onCreated();
        onClose();
      })
      .catch((caught: unknown) => {
        setError(readApiError(caught).message || 'The sub-organization could not be created.');
        setIsSubmitting(false);
      });
  };

  return (
    <Modal title={`New sub-organization of ${parent.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <BlockAlert variant="error" message={error} />}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="sub-org-name"
            className="text-xs font-medium tracking-wide text-tp-steel uppercase"
          >
            Name
          </label>
          <input
            id="sub-org-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            maxLength={255}
            className="rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20"
          />
          <SlugPreview value={name} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="sub-org-description"
            className="text-xs font-medium tracking-wide text-tp-steel uppercase"
          >
            Description
          </label>
          <textarea
            id="sub-org-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
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
            disabled={isSubmitting || name.trim().length < 3}
            className="cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
          >
            {isSubmitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
