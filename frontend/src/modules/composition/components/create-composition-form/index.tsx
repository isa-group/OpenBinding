// Adapted from SPHERE frontend/src/modules/pricing/components/create-pricing-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition: the file is read by the gateway (`POST /v1/compositions/parse`) instead of pricing4ts, the
// composition is created and its first version sealed from the file; "Start in the editor" creates it empty and opens it
// to be written; the organization is one where the account is MEMBER (OpenBinding's roles, not SPHERE's entity
// permissions), preselected by `?org=`; Public needs ADMIN there; the back link and the toggle are links and a switch;
// refusals are said in words, and what the gateway finds in a file is listed.

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { readApiError, type ApiError } from '../../../core/api/errors';
import FileUpload from '../../../core/components/file-upload-input';
import SlugPreview from '../../../core/components/slug-preview';
import type { CompositionDocument } from '../../../core/utils/composition/document';
import { slugFromName } from '../../../core/utils/slug';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';
import { orgPath } from '../../../organization/types/paths';
import { compositionPath } from '../../../../routes/paths/compositions';
import { compositionsApi, languageApi } from '../../api/compositionsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import { UPLOAD_LIMIT_BYTES } from '../composition-import-modal';
import VisibilityOptions, { type Visibility } from '../visibility-options';

function describe(error: ApiError, slug: string, organization: string): string {
  if (error.code === 'slug_conflict')
    return `${slug} is in use in ${organization}. Choose another name.`;
  if (error.status === 403) return `Creating a composition needs MEMBER in ${organization}.`;
  return error.message || 'The composition couldn’t be created. Try again in a moment.';
}

export default function CreateCompositionForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialOrg = searchParams.get('org');
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [name, setName] = useState('');
  const [useDocumentName, setUseDocumentName] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState('');

  const canPublish = roleAtLeast(organization?.effective_role, 'ADMIN');

  const check = (needsName: boolean): boolean => {
    setError(null);
    setProblem('');
    if (!organization) {
      setProblem('Choose the organization the composition belongs to.');
      return false;
    }
    if (needsName && !name.trim()) {
      setProblem('Give the composition a name.');
      return false;
    }
    return true;
  };

  const fromFile = async (file: File) => {
    if (!check(!useDocumentName) || !organization) return;
    if (file.size > UPLOAD_LIMIT_BYTES) {
      setProblem(`${file.name} is larger than 256 KiB, the largest document the gateway reads.`);
      return;
    }
    setBusy(true);
    const text = await file.text();
    let slug = '';
    try {
      const parsed = await languageApi.parse(text);
      const document = parsed.document as unknown as CompositionDocument;
      const chosenName = useDocumentName ? document.composition : name.trim();
      slug = useDocumentName ? document.composition : slugFromName(chosenName);
      await compositionsApi.create(organization.slug, {
        slug,
        name: chosenName,
        kind: document.kind,
        description: '',
      });
      const sealed = await compositionsApi.seal(organization.slug, slug, text);
      if (visibility === 'public' && canPublish) {
        const { etag } = await compositionsApi.get(organization.slug, slug);
        await compositionsApi.update(organization.slug, slug, { visibility: 'public' }, etag);
      }
      void navigate(compositionPath(organization.slug, slug), {
        state: {
          toast: `Composition “${chosenName}” created with its version ${sealed.result.version.label}.`,
        },
      });
    } catch (caught) {
      const refusal = readApiError(caught);
      setError(refusal);
      setProblem(describe(refusal, slug, organization.name));
      setBusy(false);
    }
  };

  const inEditor = async () => {
    if (!check(true) || !organization) return;
    setBusy(true);
    const slug = slugFromName(name);
    try {
      await compositionsApi.create(organization.slug, {
        slug,
        name: name.trim(),
        kind: 'application',
        description: '',
      });
      if (visibility === 'public' && canPublish) {
        const { etag } = await compositionsApi.get(organization.slug, slug);
        await compositionsApi.update(organization.slug, slug, { visibility: 'public' }, etag);
      }
      void navigate(compositionPath(organization.slug, slug, 'editor'), {
        state: {
          toast: `Composition “${name.trim()}” created. It has no version yet: write its first one here.`,
        },
      });
    } catch (caught) {
      const refusal = readApiError(caught);
      setError(refusal);
      setProblem(describe(refusal, slug, organization.name));
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={event => event.preventDefault()} noValidate>
      {initialOrg && (
        <Link
          to={orgPath(initialOrg, 'compositions')}
          className="mb-2 inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-tp-steel transition-colors hover:text-tp-ink"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to organization
        </Link>
      )}

      <h1 className="mb-3 text-center font-display text-2xl text-tp-ink">
        Add a composition to OpenBinding
      </h1>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <OrganizationSelector
            value={organization}
            onChange={setOrganization}
            initialSlug={initialOrg}
            minRole="MEMBER"
          />
        </div>
        <div className="hidden pt-7 text-2xl text-tp-steel sm:block" aria-hidden="true">
          /
        </div>
        <div className="flex-2">
          <label htmlFor="composition-name" className="mb-1 block text-sm text-tp-slate">
            Composition name
          </label>
          <input
            id="composition-name"
            placeholder={useDocumentName ? 'Will use the document’s name' : 'e.g. Order desk'}
            value={useDocumentName ? '' : name}
            onChange={event => setName(event.target.value)}
            disabled={useDocumentName}
            maxLength={160}
            className="w-full rounded-md border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink transition-colors outline-none hover:border-tp-hairline-strong focus:border-tp-primary focus:ring-1 focus:ring-tp-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${!useDocumentName && name.trim() ? 'max-h-8 opacity-100' : 'max-h-0 opacity-0'}`}
          >
            <SlugPreview value={name} />
          </div>
          <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-tp-steel select-none">
            <button
              type="button"
              role="switch"
              aria-checked={useDocumentName}
              aria-label="Use the document’s name"
              onClick={() => setUseDocumentName(!useDocumentName)}
              className={`relative inline-block h-4 w-7 cursor-pointer rounded-full transition-colors ${useDocumentName ? 'bg-tp-accent' : 'bg-tp-hairline-strong'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform ${useDocumentName ? 'translate-x-3' : 'translate-x-0'}`}
              />
            </button>
            Use the document’s name (when uploading a file)
          </label>
        </div>
      </div>

      <div>
        <p className="mb-1 text-sm text-tp-slate">Visibility</p>
        <VisibilityOptions value={visibility} onChange={setVisibility} disabled={!canPublish} />
        {organization && !canPublish && (
          <p className="mt-1 text-xs text-tp-steel">
            Publishing needs ADMIN in {organization.name}; the composition starts private.
          </p>
        )}
      </div>

      <FileUpload
        onSubmit={file => void fromFile(file)}
        submitButtonText={busy ? 'Creating…' : 'Upload composition'}
        submitButtonWidth={400}
        isDragActiveText="Drop a Composition2Yaml file here"
        isNotDragActiveText="Drag and drop a Composition2Yaml file here"
        accept={{ 'application/yaml': ['.yaml', '.yml'], 'text/yaml': ['.yaml', '.yml'] }}
        disabled={busy}
      />

      <p className="text-center text-sm text-tp-steel">
        No file yet?{' '}
        <button
          type="button"
          onClick={() => void inEditor()}
          disabled={busy}
          className="cursor-pointer font-medium text-tp-accent underline disabled:cursor-wait disabled:opacity-60"
        >
          Write it in the editor
        </button>
      </p>

      {problem && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          <p>{problem}</p>
          {error && error.diagnostics.length > 0 && (
            <ul
              className="mt-2 list-disc space-y-1 pl-5 text-xs"
              aria-label="What the gateway found"
            >
              {error.diagnostics.map((finding, index) => (
                <li key={`${finding.code}-${index}`}>
                  {finding.message} <code className="font-mono">{finding.code}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="h-12" />
    </form>
  );
}
