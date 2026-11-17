// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's roles instead of SPHERE's entity permissions (MEMBER renames, describes and archives; ADMIN changes
// who reads it and deletes it); the description and Archived join General; visibility is the composition's (no per-version
// visibility, no "Mixed"), and making it public first says what that exposes; versions are immutable, so there is no
// "Delete version"; deleting asks for the address typed in OpenBinding's modal. Every change names the revision read
// (`If-Match`), and a 412 offers the reload (offer-reload).

import { useState, type FormEvent } from 'react';
import { readApiError, type ApiError } from '../../../core/api/errors';
import type { CompositionUpdate, CompositionView } from '../../../core/api/types';
import Iconify from '../../../core/components/iconify';
import { Modal } from '../../../core/components/modal';
import customConfirm from '../../../core/utils/custom-confirm';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import { compositionsApi } from '../../api/compositionsApi';
import VisibilityOptions from '../visibility-options';

const NAME_MAX = 160;
const DESCRIPTION_MAX = 2000;

/** What publishing exposes, said before a composition is made public. */
export const PUBLISH_CONFIRMATION =
  'Public compositions show every version’s document to anyone, as written: the problem reference, the run ' +
  'and point recorded as evidence, the values and their verification status. The problem itself, its runs and evaluation diagnostics ' +
  'stay private. A fork’s source is named only while that source is public.';

type Change = 'details' | 'archived' | 'visibility';

function codeOf(error: ApiError): string {
  return error.status
    ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
    : '';
}

/** How a refused change reads. */
function refusalOf(error: ApiError, change: Change): string {
  const code = codeOf(error);
  if (error.status === 403) {
    return change === 'visibility'
      ? `Changing who reads a composition needs ADMIN in this organization${code}. Nothing changed.`
      : `Changing a composition needs MEMBER in this organization${code}. Nothing changed.`;
  }
  if (error.status === 404) return `This composition is not there any more${code}.`;
  return `The change couldn’t be saved${code}${error.message ? `: ${error.message}` : '.'}`;
}

interface Props {
  org: string;
  organizationName: string;
  composition: CompositionView;
  /** The revision every change names (`If-Match`), as the page read it. */
  etag: string | null;
  canWrite: boolean;
  canAdminister: boolean;
  /** Read the composition again: after a change, and after a 412. */
  onChanged: (message?: string) => void;
  onDeleted: () => void;
}

function DeleteModal({
  org,
  composition,
  onClose,
  onDeleted,
}: {
  org: string;
  composition: CompositionView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed === composition.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      await compositionsApi.remove(org, composition.slug);
      onDeleted();
    } catch (caught) {
      const refusal = readApiError(caught);
      const code = codeOf(refusal);
      if (refusal.status === 403)
        setError(
          `Deleting a composition needs ADMIN in this organization${code}. Nothing was deleted.`
        );
      else if (refusal.status === 404) setError(`It is not there any more${code}.`);
      else
        setError(
          `The composition couldn’t be deleted${code}${refusal.message ? `: ${refusal.message}` : '.'} Nothing was deleted.`
        );
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Delete ${composition.name}?`}
      tone="danger"
      size="md"
      onClose={() => !busy && onClose()}
      dismissible={!busy}
    >
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-tp-slate">
          This deletes the composition with its{' '}
          {composition.version_count === 1 ? 'version' : `${composition.version_count} versions`}{' '}
          and their evaluations. Forks made from it in other organizations stay. This can’t be
          undone.
        </p>
        <label className="text-xs font-medium text-tp-steel" htmlFor="delete-confirm">
          Type {composition.slug} to confirm
        </label>
        <input
          id="delete-confirm"
          value={typed}
          onChange={event => {
            setTyped(event.target.value);
            setError('');
          }}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 font-mono text-sm text-tp-ink outline-none focus:border-tp-primary"
        />
        <div aria-live="assertive">
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="cursor-pointer rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:cursor-default disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function CompositionSettingsTab({
  org,
  organizationName,
  composition,
  etag,
  canWrite,
  canAdminister,
  onChanged,
  onDeleted,
}: Props) {
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState<Change | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Change, string>>>({});
  const [deleting, setDeleting] = useState(false);

  if (!canWrite) {
    return (
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-5">
        <div className="flex flex-col items-center gap-2 py-10 text-tp-steel">
          <Iconify icon="mdi:lock-outline" width={36} />
          <p className="text-sm">
            Changing this composition’s settings needs MEMBER in {organizationName}.
          </p>
        </div>
      </div>
    );
  }

  const name = draft?.name ?? composition.name;
  const description = draft?.description ?? composition.description;
  const unchanged =
    name.trim() === composition.name && description.trim() === composition.description;

  const change = async (kind: Change, body: CompositionUpdate, done: string) => {
    if (busy) return;
    setBusy(kind);
    setErrors({});
    try {
      await compositionsApi.update(org, composition.slug, body, etag);
      if (kind === 'details') setDraft(null);
      onChanged(done);
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: composition.name, reload: () => onChanged() }))
        setErrors({ [kind]: refusalOf(readApiError(caught), kind) });
    } finally {
      setBusy(null);
    }
  };

  const saveDetails = (event: FormEvent) => {
    event.preventDefault();
    if (unchanged) return;
    if (!name.trim()) {
      setErrors({ details: 'Give the composition a name.' });
      return;
    }
    void change(
      'details',
      { name: name.trim(), description: description.trim() },
      'Name and description saved.'
    );
  };

  const changeVisibility = (value: 'public' | 'private') => {
    if (value === composition.visibility) return;
    if (value === 'public') {
      customConfirm(PUBLISH_CONFIRMATION, {
        confirmLabel: 'Make public',
        cancelLabel: 'Keep private',
      })
        .then(() =>
          change(
            'visibility',
            { visibility: 'public' },
            'The composition is public: anybody reads it.'
          )
        )
        .catch(() => {});
    } else {
      void change(
        'visibility',
        { visibility: 'private' },
        'The composition is private: only members read it.'
      );
    }
  };

  const errorLine = (kind: Change) =>
    errors[kind] && (
      <p role="alert" className="mt-2 text-xs text-red-700">
        {errors[kind]}
      </p>
    );

  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-5">
      <section aria-labelledby="settings-general">
        <h2 id="settings-general" className="mb-4 text-sm font-medium text-tp-ink">
          General
        </h2>
        <form onSubmit={saveDetails} noValidate className="mb-6 flex flex-col gap-3">
          <div>
            <label
              htmlFor="settings-name"
              className="mb-1.5 block text-[11px] font-medium text-tp-steel"
            >
              Name
            </label>
            <input
              id="settings-name"
              value={name}
              maxLength={NAME_MAX}
              onChange={event => {
                setDraft({ name: event.target.value, description });
                setErrors({});
              }}
              className="w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary"
            />
          </div>
          <div>
            <label
              htmlFor="settings-description"
              className="mb-1.5 block text-[11px] font-medium text-tp-steel"
            >
              Description (optional)
            </label>
            <textarea
              id="settings-description"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={event => {
                setDraft({ name, description: event.target.value });
                setErrors({});
              }}
              className="w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary"
            />
          </div>
          <p className="text-xs text-tp-steel">
            Address (fixed): <code className="font-mono text-tp-ink">{composition.slug}</code>
          </p>
          {errorLine('details')}
          <div>
            <button
              type="submit"
              disabled={unchanged || busy !== null}
              className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-40"
            >
              {busy === 'details' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>

        <h2 className="mb-1 text-sm font-medium text-tp-ink">Archived</h2>
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-tp-steel">
            {composition.archived ? 'Archived. ' : 'Active. '}
            An archived composition leaves the list of active ones and keeps every version. It can
            be restored at any time.
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={composition.archived}
            aria-label="Archived"
            disabled={busy !== null}
            onClick={() =>
              void change(
                'archived',
                { archived: !composition.archived },
                composition.archived ? 'Composition restored.' : 'Composition archived.'
              )
            }
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60 ${
              composition.archived ? 'bg-tp-accent' : 'bg-tp-hairline-strong'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                composition.archived ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        {errorLine('archived')}

        <h2 className="mb-1 text-sm font-medium text-tp-ink">Visibility</h2>
        <p className="mb-2 text-xs text-tp-steel">
          {composition.visibility === 'public'
            ? 'Anybody reads it and every version’s document, signed in or not, and can fork it into their own organization.'
            : `Only the members of ${organizationName} read it.`}
          {!canAdminister && ' Changing who reads it needs ADMIN.'}
        </p>
        <div className="pl-4">
          <VisibilityOptions
            value={composition.visibility}
            onChange={changeVisibility}
            disabled={!canAdminister || busy !== null}
          />
        </div>
        {errorLine('visibility')}
      </section>

      {canAdminister && (
        <>
          <hr className="my-6 border-tp-hairline" />
          <section aria-labelledby="settings-danger">
            <h2 id="settings-danger" className="mb-2 text-sm font-medium text-red-700">
              Danger Zone
            </h2>
            <div className="rounded-lg border border-red-500 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-tp-ink">Delete this composition</p>
                  <p className="mt-1 text-xs text-tp-steel">
                    Once you delete a composition, there is no going back. Please be certain.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleting(true)}
                  className="shrink-0 cursor-pointer rounded-md border border-red-600 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-600 hover:text-white"
                >
                  Delete composition
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {deleting && (
        <DeleteModal
          org={org}
          composition={composition}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
