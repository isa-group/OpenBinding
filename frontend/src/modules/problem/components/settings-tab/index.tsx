// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem's settings: its name and description (MEMBER), and SPHERE's danger zone, where an ADMIN deletes it with its
// versions (the address typed in OpenBinding's modal; refused while runs or studies name a version). Problems are private to
// their organization, so there is no visibility and no archive. A change names the revision read (`If-Match`), and a 412
// offers the reload (offer-reload). A VIEWER reads the fields.

import { useState, type FormEvent } from 'react';
import { useProblemsApi, type Problem } from '../../api/problemsApi';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import type { ProblemOrg } from '../../types';
import { updateRefusal } from '../../utils/problemErrors';
import { DESCRIPTION_MAX, NAME_MAX } from '../../utils/problemsModel';
import DeleteProblemModal from '../delete-problem-modal';

const fieldClass =
  'w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink transition-colors outline-none focus:border-tp-primary disabled:opacity-70';
const labelClass = 'mb-1.5 block text-[11px] font-medium text-tp-steel';

export default function SettingsTab({
  org,
  item,
  etag,
  canEdit,
  canAdminister,
  onSaved,
  onDeleted,
}: {
  org: ProblemOrg;
  item: Problem;
  /** The revision the problem was read at, which a change names. */
  etag: string | null;
  /** MEMBER or above: the name and the description change. */
  canEdit: boolean;
  canAdminister: boolean;
  onSaved: () => void;
  onDeleted: (name: string) => void;
}) {
  const { updateProblem } = useProblemsApi();
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const unchanged = name.trim() === item.name && description.trim() === item.description;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim() || !canEdit) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await updateProblem(
        org.slug,
        item.slug,
        { name: name.trim(), description: description.trim() },
        etag
      );
      setSaved(true);
      onSaved();
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: item.name, reload: onSaved }))
        setError(updateRefusal(caught).text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="ps-details"
        className="rounded-xl border border-tp-hairline bg-tp-canvas p-5"
      >
        <h2 id="ps-details" className="mb-4 text-sm font-medium text-tp-ink">
          Name and description
        </h2>
        <form onSubmit={event => void save(event)} noValidate className="flex flex-col gap-3">
          <div>
            <label htmlFor="problem-name" className={labelClass}>
              Name
            </label>
            <input
              id="problem-name"
              value={name}
              maxLength={NAME_MAX}
              disabled={!canEdit}
              aria-invalid={name.trim() ? undefined : true}
              aria-describedby={name.trim() ? undefined : 'problem-name-error'}
              onChange={event => {
                setName(event.target.value);
                setSaved(false);
              }}
              className={fieldClass}
            />
            {!name.trim() && (
              <p id="problem-name-error" className="mt-1 text-xs text-red-700">
                A problem needs a name.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="problem-settings-description" className={labelClass}>
              Description
            </label>
            <textarea
              id="problem-settings-description"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              disabled={!canEdit}
              value={description}
              onChange={event => {
                setDescription(event.target.value);
                setSaved(false);
              }}
              className={fieldClass}
            />
          </div>
          <p className="text-xs text-tp-steel">
            Address (fixed): <code className="font-mono text-tp-ink">{item.slug}</code>
          </p>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-xs text-tp-success-text">
              Saved.
            </p>
          )}
          {canEdit && (
            <div>
              <button
                type="submit"
                disabled={busy || unchanged || !name.trim()}
                className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </form>
      </section>

      {canAdminister && (
        <section aria-labelledby="ps-danger">
          <h2 id="ps-danger" className="mb-2 text-sm font-medium text-red-700">
            Danger zone
          </h2>
          <div className="rounded-lg border border-red-500 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-tp-ink">Delete this problem</p>
                <p className="mt-1 text-xs text-tp-steel">
                  Deleting removes the problem and its versions. A problem that runs or studies used
                  can’t be deleted: it stays as their evidence.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeleting(true)}
                className="shrink-0 cursor-pointer rounded-md border border-red-600 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-600 hover:text-white"
              >
                Delete problem
              </button>
            </div>
          </div>
        </section>
      )}

      {deleting && (
        <DeleteProblemModal
          org={org}
          item={item}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
