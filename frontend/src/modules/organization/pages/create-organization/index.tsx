// Adapted from SPHERE frontend/src/modules/organization/pages/create-organization/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway derives the slug from the name (with a suffix when it is taken) and the reserved slugs apply; an
// optional parent organization where the account is an admin, preselected by `?parent=`; the new organization's page opens
// afterwards; SPHERE's undefined `sphere-grey` classes become the theme's tokens; the refusal shows in place, labelled; a
// personal organization is never offered as the parent.

import { useState, type FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { useSearchParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import BlockAlert from '../../../core/components/block-alert';
import OrgAvatar from '../../../core/components/org-avatar';
import SlugPreview from '../../../core/components/slug-preview';
import { useRouter } from '../../../core/hooks/useRouter';
import { generateSlug } from '../../../core/utils/generate-slug';
import { useOrganizationsApi, type Organization } from '../../api/organizationsApi';
import OrganizationSelector from '../../components/organization-selector';
import { useOrganization } from '../../hooks/useOrganization';
import { orgPath } from '../../types/paths';

const DESCRIPTION_LIMIT = 500;

/** The sentence a refused creation shows. */
function createRefusal(error: unknown): string {
  const refusal = readApiError(error);
  if (refusal.code === 'personal_organization')
    return 'A personal organization takes no sub-organizations. Choose another parent, or none.';
  if (refusal.code === 'slug_conflict' || refusal.status === 409)
    return 'That name is taken. Try another one.';
  if (refusal.code === 'slug_reserved' || refusal.code === 'slug_underivable')
    return 'That name cannot be used for an address. Try another one.';
  if (refusal.status === 403) return 'You need to be an admin of the parent organization.';
  return refusal.message || 'The organization could not be created.';
}

export default function CreateOrganizationPage() {
  const [params] = useSearchParams();
  const [orgName, setOrgName] = useState('');
  const [description, setDescription] = useState('');
  const [parent, setParent] = useState<Organization | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { createOrganization } = useOrganizationsApi();
  const { refresh } = useOrganization();
  const router = useRouter();

  const slug = generateSlug(orgName);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    createOrganization({
      name: orgName.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(parent ? { parent_id: parent.id } : {}),
    })
      .then(async created => {
        await refresh();
        router.push(orgPath(created.slug));
      })
      .catch((err: unknown) => {
        setError(createRefusal(err));
        setIsSubmitting(false);
      });
  };

  return (
    <div className="mx-auto mt-4 w-full max-w-150 px-4 py-8">
      <Helmet>
        <title>OpenBinding - New organization</title>
      </Helmet>
      <h1 className="mb-6 text-center font-display text-3xl font-normal tracking-tight text-tp-ink">
        Create a new organization
      </h1>

      <div className="mb-4 flex justify-center">
        <OrgAvatar name={orgName || '?'} size={72} />
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && <BlockAlert variant="error" message={error} onDismiss={() => setError(null)} />}

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-tp-ink" htmlFor="org-name">
            Name <span className="text-red-700">*</span>
          </label>
          <input
            id="org-name"
            type="text"
            value={orgName}
            onChange={e => setOrgName(e.target.value)}
            placeholder="My Organization"
            required
            maxLength={255}
            className="h-11 rounded-md border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20 dark:focus:ring-tp-primary/20"
          />
          <SlugPreview value={orgName} />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-tp-ink" htmlFor="org-description">
            Description
          </label>
          <textarea
            id="org-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="A short description of your organization"
            rows={3}
            maxLength={DESCRIPTION_LIMIT}
            className="rounded-md border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm outline-none focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20 dark:focus:ring-tp-primary/20"
          />
          <p className="self-end text-xs text-tp-steel">
            {description.length}/{DESCRIPTION_LIMIT}
          </p>
        </div>

        <OrganizationSelector
          label="Parent organization (optional)"
          placeholder="None: a top-level organization"
          value={parent}
          onChange={setParent}
          initialSlug={params.get('parent')}
          minRole="ADMIN"
          excludePersonal
        />

        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="cursor-pointer rounded-md border border-tp-hairline-strong px-5 py-2 text-sm font-semibold text-tp-ink transition-colors hover:bg-tp-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || slug.length < 3}
            className="cursor-pointer rounded-md bg-tp-accent px-5 py-2 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? 'Creating...' : 'Create organization'}
          </button>
        </div>
      </form>
    </div>
  );
}
