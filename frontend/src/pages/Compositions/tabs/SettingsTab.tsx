import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Globe, Lock, TriangleAlert } from 'lucide-react';
import { Action } from '../../../modules/core/components/action-button';
import { FormField } from '../../../modules/core/components/form-field';
import { Modal } from '../../../modules/core/components/modal';
import { Notice } from '../../../modules/core/components/notice';
import { Switch } from '../../../modules/core/components/switch';
import { compositionsApi } from '../../../entities/composition/api';
import { compositionsPath } from '../../../routes/paths/compositions';
import { readApiError, type ApiError } from '../../../modules/core/api/errors';
import type { CompositionUpdate, CompositionView } from '../../../modules/core/api/types';
import type { CompositionAccess } from '../useRouteComposition';

const NAME_MAX = 160;
const DESCRIPTION_MAX = 2000;

/** What publishing exposes, said before a composition is made public (A3's redaction, C2). */
export const PUBLISH_CONFIRMATION =
  'Public compositions show every version’s document to anyone, as written: the problem reference, the run ' +
  'and point recorded as evidence, the values and their verification status. The problem itself, its runs and evaluation diagnostics ' +
  'stay private. A fork’s source is named only while that source is public.';

/** The change a section of the tab is making. */
type Change = 'details' | 'archived' | 'visibility';

/** How a refused change reads; a 412 says the composition was read again. */
function refusalOf(error: ApiError, change: Change): string {
  const code = error.status
    ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
    : '';
  if (error.status === 412) {
    return `This composition changed since you opened it${code}. It has been read again: check what it says now and save again.`;
  }
  if (error.status === 403) {
    return change === 'visibility'
      ? `Changing who reads a composition needs ADMIN in this organization${code}. Nothing changed.`
      : `Changing a composition needs MEMBER in this organization${code}. Nothing changed.`;
  }
  if (error.status === 404) return `This composition is not there any more${code}.`;
  return `The change couldn’t be saved${code}${error.message ? `: ${error.message}` : '.'}`;
}

function DeleteDialog({
  org,
  composition,
  onClose,
}: {
  org: string;
  composition: CompositionView;
  onClose: () => void;
}) {
  const navigate = useNavigate();
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
      void navigate(compositionsPath(org), {
        state: { toast: `Composition “${composition.name}” deleted.` },
      });
    } catch (caught) {
      const refusal = readApiError(caught);
      const code = refusal.status
        ? ` (${refusal.status}${refusal.code !== 'unknown' ? ` · ${refusal.code}` : ''})`
        : '';
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
      <form className="org-dialog-form" onSubmit={event => void submit(event)} noValidate>
        <p>
          This deletes the composition with its{' '}
          {composition.version_count === 1 ? 'version' : `${composition.version_count} versions`}{' '}
          and their evaluations. Forks made from it in other organizations stay. This can’t be
          undone.
        </p>
        <FormField
          label={`Type ${composition.slug} to confirm`}
          value={typed}
          onChange={event => {
            setTyped(event.target.value);
            setError('');
          }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <div aria-live="assertive">
          {error && (
            <div className="org-dialog-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="danger" disabled={!matches} busy={busy}>
            Delete permanently
          </Action>
        </div>
      </form>
    </Modal>
  );
}

interface SettingsTabProps {
  org: string;
  /** The organization's name, for the sentences that name who reads the composition. */
  organizationName: string;
  composition: CompositionView;
  /** The revision every change names (`If-Match`), as the page read it. */
  etag: string | null;
  access: CompositionAccess;
  /** Read the composition again: after a change, and after a 412. */
  onChanged: () => void;
}

/**
 * Settings: the composition's name and description, archived or not (MEMBER), who reads it (ADMIN), and deleting it (ADMIN). Every
 * change names the revision the page read (`If-Match`), so a change made meanwhile by someone else is refused (412) instead of
 * overwritten; the page then reads the composition again and says so. Making a composition public first says what that exposes.
 */
export function SettingsTab({
  org,
  organizationName,
  composition,
  etag,
  access,
  onChanged,
}: SettingsTabProps) {
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState<Change | null>(null);
  const [saved, setSaved] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Change, string>>>({});
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!access.canCreate) {
    return (
      <Notice tone="info" title="Nothing to change here">
        {`Changing a composition’s settings needs MEMBER in ${organizationName}; you’re ${access.role ?? 'not a member'}.`}
      </Notice>
    );
  }

  const name = draft?.name ?? composition.name;
  const description = draft?.description ?? composition.description;
  const unchanged =
    name.trim() === composition.name && description.trim() === composition.description;
  const isPublic = composition.visibility === 'public';

  const change = async (kind: Change, body: CompositionUpdate, done: string) => {
    if (busy) return;
    setBusy(kind);
    setSaved('');
    setErrors({});
    try {
      await compositionsApi.update(org, composition.slug, body, etag);
      if (kind === 'details') setDraft(null);
      setSaved(done);
      onChanged();
    } catch (caught) {
      const error = readApiError(caught);
      setErrors({ [kind]: refusalOf(error, kind) });
      if (error.status === 412) onChanged();
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

  return (
    <div className="cms">
      {saved && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{saved}</span>
        </div>
      )}

      <section className="org-section" aria-labelledby="cms-details">
        <h2 id="cms-details">Name and description</h2>
        <form className="org-card cms-form" onSubmit={saveDetails} noValidate>
          <FormField
            label="Name"
            value={name}
            maxLength={NAME_MAX}
            onChange={event => {
              setDraft({ name: event.target.value, description });
              setErrors({});
            }}
          />
          <div className="ui-field">
            <label htmlFor="cms-description">
              Description <span className="proj-optional">(optional)</span>
            </label>
            <textarea
              id="cms-description"
              className="proj-textarea"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={event => {
                setDraft({ name, description: event.target.value });
                setErrors({});
              }}
            />
          </div>
          <div className="ui-field">
            <span className="org-fixed-label">Address (fixed)</span>
            <span className="org-fixed">{composition.slug}</span>
          </div>
          {errors.details && <Notice tone="error">{errors.details}</Notice>}
          <div className="org-form-actions">
            <Action type="submit" variant="primary" disabled={unchanged} busy={busy === 'details'}>
              Save
            </Action>
          </div>
        </form>
      </section>

      <section className="org-section" aria-labelledby="cms-archived">
        <h2 id="cms-archived">Archived</h2>
        <div className="org-card cms-row">
          <div className="cms-row-text">
            <strong>{composition.archived ? 'Archived' : 'Active'}</strong>
            <span className="org-muted">
              An archived composition leaves the list of active ones and keeps every version. It can
              be restored at any time.
            </span>
          </div>
          <Switch
            checked={composition.archived}
            label="Archived"
            disabled={busy !== null}
            onChange={checked =>
              void change(
                'archived',
                { archived: checked },
                checked ? 'Composition archived.' : 'Composition restored.'
              )
            }
          />
        </div>
        {errors.archived && <Notice tone="error">{errors.archived}</Notice>}
      </section>

      <section className="org-section" aria-labelledby="cms-visibility">
        <h2 id="cms-visibility">Visibility</h2>
        <div className="org-card cms-row">
          <div className="cms-row-text">
            <strong className="cms-visibility">
              {isPublic ? <Globe aria-hidden="true" /> : <Lock aria-hidden="true" />}
              {isPublic ? 'Public' : 'Private'}
            </strong>
            <span className="org-muted">
              {isPublic
                ? 'Anybody reads it and every version’s document, signed in or not, and can fork it into their own organization.'
                : `Only the members of ${organizationName} read it.`}
            </span>
            {!access.canAdminister && (
              <span className="org-muted">Changing who reads it needs ADMIN.</span>
            )}
          </div>
          {access.canAdminister &&
            (isPublic ? (
              <Action
                variant="secondary"
                busy={busy === 'visibility'}
                disabled={busy !== null}
                onClick={() =>
                  void change(
                    'visibility',
                    { visibility: 'private' },
                    'The composition is private: only members read it.'
                  )
                }
              >
                Make private
              </Action>
            ) : (
              <Action
                variant="secondary"
                disabled={busy !== null}
                onClick={() => setPublishing(true)}
              >
                Make public
              </Action>
            ))}
        </div>
        {errors.visibility && <Notice tone="error">{errors.visibility}</Notice>}
      </section>

      {access.canAdminister && (
        <section className="org-section" aria-labelledby="cms-danger">
          <h2 id="cms-danger">Danger zone</h2>
          <div className="org-card is-danger org-stack">
            <strong>Delete this composition</strong>
            <span className="org-muted">
              Deletes the composition with every version and its evaluations. This can’t be undone.
            </span>
            <Action variant="danger-outline" onClick={() => setDeleting(true)}>
              Delete composition
            </Action>
          </div>
        </section>
      )}

      {publishing && (
        <Modal
          title={`Make ${composition.name} public?`}
          size="md"
          onClose={() => setPublishing(false)}
        >
          <div className="org-dialog-form">
            <p>{PUBLISH_CONFIRMATION}</p>
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => setPublishing(false)}>
                Cancel
              </Action>
              <Action
                variant="primary"
                onClick={() => {
                  setPublishing(false);
                  void change(
                    'visibility',
                    { visibility: 'public' },
                    'The composition is public: anybody reads it.'
                  );
                }}
              >
                Make public
              </Action>
            </div>
          </div>
        </Modal>
      )}
      {deleting && (
        <DeleteDialog org={org} composition={composition} onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}
