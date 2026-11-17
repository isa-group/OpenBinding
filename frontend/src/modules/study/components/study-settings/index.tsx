// Adapted from SPHERE frontend/src/modules/pricing/components/collection-settings/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a study instead of a collection: General (name and description, saved together with the study's revision as
// `If-Match`; a 412 offers to reload), an Archived switch instead of the visibility (studies are never public), and a danger
// zone whose only action is Delete (a study with runs is archived instead, which the page explains). Who may do what comes
// from OpenBinding's roles: MEMBER edits and archives, ADMIN deletes. The address stays fixed, so renaming moves nobody.

import { useState, type FormEvent } from 'react';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import { studiesApi } from '../../api/studiesApi';
import type { StudyScopeValue } from '../../pages/card/hooks';
import { studyRefusal } from '../../utils/studyErrors';
import { INPUT } from '../../utils/ui';

const NAME_MAX = 160;
const DESCRIPTION_MAX = 2000;

export default function StudySettings({
  scope,
  busy,
  onChanged,
  onArchive,
  onDelete,
}: {
  scope: StudyScopeValue;
  /** Another action of the page is in flight. */
  busy: boolean;
  onChanged: (message: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { study, organization, access, etag } = scope;
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!access.canCreate) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center">
        <p className="text-sm text-tp-steel">
          Changing this study’s settings needs MEMBER in {organization.name}.
        </p>
      </div>
    );
  }

  const name = draft?.name ?? study.name;
  const description = draft?.description ?? study.description;
  const unchanged = name.trim() === study.name && description.trim() === study.description;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (unchanged || saving) return;
    if (!name.trim()) {
      setError('A study needs a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await studiesApi.update(
        organization.slug,
        study.slug,
        { name: name.trim(), description: description.trim() },
        etag
      );
      setDraft(null);
      onChanged('Details saved.');
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: study.name, reload: scope.reloadStudy })) {
        const refusal = studyRefusal(caught, 'update');
        setError(`${refusal.title}. ${refusal.text}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-5">
      <section aria-labelledby="study-settings-general">
        <h2 id="study-settings-general" className="mb-4 text-sm font-medium text-tp-ink">
          General
        </h2>
        <form onSubmit={event => void save(event)} noValidate className="mb-6 flex flex-col gap-3">
          <div>
            <label
              htmlFor="study-settings-name"
              className="mb-1.5 block text-[11px] font-medium text-tp-steel"
            >
              Name
            </label>
            <input
              id="study-settings-name"
              value={name}
              maxLength={NAME_MAX}
              onChange={event => {
                setDraft({ name: event.target.value, description });
                setError(null);
              }}
              className={INPUT}
            />
          </div>
          <div>
            <label
              htmlFor="study-settings-description"
              className="mb-1.5 block text-[11px] font-medium text-tp-steel"
            >
              Description (optional)
            </label>
            <textarea
              id="study-settings-description"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={event => {
                setDraft({ name, description: event.target.value });
                setError(null);
              }}
              className={INPUT}
            />
          </div>
          <p className="text-xs text-tp-steel">
            Address (fixed): <code className="font-mono text-tp-ink">{study.slug}</code>
          </p>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          <div>
            <button
              type="submit"
              disabled={unchanged || saving || busy}
              className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>

        <h2 className="mb-1 text-sm font-medium text-tp-ink">Archived</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-tp-steel">
            {study.archived ? 'Archived. ' : 'Active. '}
            An archived study keeps its runs and results but can’t start new runs until it is
            restored.
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={study.archived}
            aria-label="Archived"
            disabled={busy || saving}
            onClick={onArchive}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60 ${
              study.archived ? 'bg-tp-accent' : 'bg-tp-hairline-strong'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                study.archived ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </section>

      {access.canAdminister && (
        <>
          <hr className="my-6 border-tp-hairline" />
          <section aria-labelledby="study-settings-danger">
            <h2 id="study-settings-danger" className="mb-2 text-sm font-medium text-red-700">
              Danger zone
            </h2>
            <div className="rounded-lg border border-red-500 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-tp-ink">Delete this study</p>
                  <p className="mt-1 text-xs text-tp-steel">
                    The definition goes away for good. A study that already has runs is archived
                    instead, because runs are history.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={busy}
                  className="shrink-0 cursor-pointer rounded-md border border-red-600 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-600 hover:text-white disabled:cursor-default disabled:opacity-40"
                >
                  Delete study
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
