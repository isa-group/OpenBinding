// Pattern only, after SPHERE frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's danger-zone delete confirmed by typing the problem's address, in OpenBinding's modal; the gateway refuses
// a problem whose versions runs or studies name (409 `problem_has_runs`), and the modal says why.

import { useState, type FormEvent } from 'react';
import { problemsApi, type Problem } from '../../api/problemsApi';
import { Action } from '../../../core/components/action-button';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import type { ProblemOrg } from '../../types';
import { deleteRefusal } from '../../utils/problemErrors';

/**
 * Deleting a problem takes its versions with it. The gateway refuses it (409 `problem_has_runs`) while a run or a study names one of
 * them: those stay as evidence.
 */
export default function DeleteProblemModal({
  org,
  item,
  onClose,
  onDeleted,
}: {
  org: ProblemOrg;
  item: Pick<Problem, 'slug' | 'name'>;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === item.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await problemsApi.remove(org.slug, item.slug);
      onDeleted(item.name);
    } catch (caught) {
      setError(deleteRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Delete ${item.name}?`}
      tone="danger"
      size="md"
      onClose={() => !busy && onClose()}
    >
      <form className="flex flex-col gap-4" onSubmit={event => void submit(event)} noValidate>
        <p className="text-sm text-tp-slate">
          The problem and its versions disappear from {org.name}. This can’t be undone. A problem
          that runs or studies used can’t be deleted.
        </p>
        <FormField
          label={`Type ${item.slug} to confirm`}
          value={typed}
          onChange={event => {
            setTyped(event.target.value);
            setError(undefined);
          }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <div aria-live="assertive">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg p-3 text-sm text-tp-error-text"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="danger" disabled={!matches} busy={busy}>
            Delete problem
          </Action>
        </div>
      </form>
    </Modal>
  );
}
