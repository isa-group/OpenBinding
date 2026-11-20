// Creating and editing a composition environment (ADMIN), and deleting one with its slug typed, in OpenBinding's modal (the
// recipe of the composition's settings and delete dialogs). SPHERE has no environments; nothing here is copied.
// An edit sends the `ETag` of the environment it was opened on as `If-Match`; a 412 offers to reload instead of saving over
// somebody else's change. The slug is chosen once: it is part of the feed address applications read.

import { useState, type FormEvent } from 'react';
import { readApiError, type ApiError } from '../../../core/api/errors';
import type {
  CompositionEnvironmentCreate,
  CompositionEnvironmentUpdate,
  CompositionEnvironmentView,
} from '../../../core/api/types';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import { SelectField, TextAreaField } from '../../../core/components/select-field';
import { useResource } from '../../../core/hooks/useResource';
import { generateSlug } from '../../../core/utils/generate-slug';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import { useOrganizationsApi } from '../../../organization/api/organizationsApi';
import { useEnvironmentsApi } from '../../api/environmentsApi';

/** The environment slug rule: 1 to 40 lowercase letters, digits and hyphens, a letter first. */
export const ENVIRONMENT_SLUG = /^[a-z][a-z0-9-]{0,39}$/;

const MAX_USERS = 1_000_000_000;

const codeOf = (refusal: ApiError) => (refusal.code ? ` (${refusal.code})` : '');

const buttonClass =
  'cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:cursor-default disabled:opacity-50';
const primaryClass =
  'cursor-pointer rounded-lg bg-tp-primary px-4 py-2 text-xs font-semibold text-white hover:bg-tp-primary/90 disabled:cursor-default disabled:opacity-50';

interface FormProps {
  org: string;
  composition: string;
  /** The environment to edit with the `ETag` it was read with; absent to create one. */
  editing?: { environment: CompositionEnvironmentView; etag: string | null };
  onClose: () => void;
  /** Saved: the environment as the gateway answered it. */
  onSaved: (environment: CompositionEnvironmentView, etag: string | null) => void;
  /** The environment changed since it was read: read it again. */
  onStale?: () => void;
}

export default function EnvironmentFormDialog({
  org,
  composition,
  editing,
  onClose,
  onSaved,
  onStale,
}: FormProps) {
  const api = useEnvironmentsApi();
  const { getMembers } = useOrganizationsApi();
  const current = editing?.environment;
  const [name, setName] = useState(current?.name ?? '');
  const [slug, setSlug] = useState(current?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(current));
  const [description, setDescription] = useState(current?.description ?? '');
  const [operator, setOperator] = useState(current?.operator?.username ?? '');
  const [adoptRole, setAdoptRole] = useState<'ADMIN' | 'MEMBER'>(current?.adoptRole ?? 'ADMIN');
  const [users, setUsers] = useState(
    current?.expectedUsers !== null && current?.expectedUsers !== undefined
      ? String(current.expectedUsers)
      : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const members = useResource(`environment-operators:${org}`, () => getMembers(org));
  const usernames = [
    ...new Set((members.data ?? []).flatMap(member => (member.username ? [member.username] : []))),
  ].sort();
  if (operator && !usernames.includes(operator)) usernames.unshift(operator);

  const shownSlug = slugTouched ? slug : generateSlug(name).slice(0, 40);
  const usersNumber = users.trim() === '' ? null : Number(users);
  const usersError =
    usersNumber !== null &&
    (!Number.isInteger(usersNumber) || usersNumber < 1 || usersNumber > MAX_USERS)
      ? 'A whole number from 1 to 1,000,000,000.'
      : undefined;
  const slugError =
    !current && shownSlug && !ENVIRONMENT_SLUG.test(shownSlug)
      ? 'Lowercase letters, digits and hyphens, a letter first, at most 40.'
      : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim() || usersError || slugError || (!current && !shownSlug)) return;
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      if (current) {
        const body: CompositionEnvironmentUpdate = {
          name: name.trim(),
          description,
          operator: operator || null,
          adoptRole,
          expectedUsers: usersNumber,
        };
        const saved = await api.updateEnvironment(
          org,
          composition,
          current.slug,
          body,
          editing?.etag ?? null
        );
        onSaved(saved.value, saved.etag);
      } else {
        const body: CompositionEnvironmentCreate = {
          slug: shownSlug,
          name: name.trim(),
          description,
          operator: operator || null,
          adoptRole,
          expectedUsers: usersNumber,
        };
        const saved = await api.createEnvironment(org, composition, body);
        onSaved(saved.value, saved.etag);
      }
    } catch (caught) {
      setBusy(false);
      if (offerReloadIfChanged(caught, { resource: 'this environment', reload: onStale })) return;
      const refusal = readApiError(caught);
      const code = codeOf(refusal);
      if (refusal.code === 'slug_conflict')
        setFieldErrors({ slug: `${shownSlug} is already an environment of this composition.` });
      else if (refusal.code === 'environment_limit')
        setError(`This composition has as many environments as it may${code}. Delete one first.`);
      else if (refusal.status === 403)
        setError(`Environments are changed by ADMIN in this organization${code}.`);
      else
        setError(
          `The environment couldn’t be saved${code}${refusal.message ? `: ${refusal.message}` : '.'}`
        );
    }
  };

  return (
    <Modal
      title={current ? `Edit ${current.name}` : 'New environment'}
      size="lg"
      onClose={() => !busy && onClose()}
      dismissible={!busy}
    >
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-tp-slate">
          {current
            ? 'Its address stays the same: applications keep reading the version in effect.'
            : 'An environment is where an application reads the version in effect. Nothing is in effect until somebody adopts a version.'}
        </p>
        <FormField
          label="Name"
          value={name}
          onChange={event => setName(event.target.value)}
          required
          maxLength={80}
          autoComplete="off"
        />
        {current ? (
          <p className="text-xs text-tp-steel">
            Slug <code className="font-mono text-tp-ink">{current.slug}</code>: it is part of the
            feed address, so it never changes.
          </p>
        ) : (
          <FormField
            label="Slug"
            value={shownSlug}
            onChange={event => {
              setSlugTouched(true);
              setSlug(event.target.value);
            }}
            mono
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            error={fieldErrors.slug ?? slugError}
            hint="Part of the feed address; it never changes."
          />
        )}
        <TextAreaField
          label="Description"
          value={description}
          onChange={event => setDescription(event.target.value)}
          maxLength={500}
          rows={2}
        />
        <SelectField
          label="Operator"
          value={operator}
          onChange={setOperator}
          hint="The member answerable for what runs here; told of every adoption."
        >
          <option value="">No operator</option>
          {usernames.map(username => (
            <option key={username} value={username}>
              {username}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Who may adopt"
          value={adoptRole}
          onChange={value => setAdoptRole(value === 'MEMBER' ? 'MEMBER' : 'ADMIN')}
        >
          <option value="ADMIN">Admins</option>
          <option value="MEMBER">Members</option>
        </SelectField>
        <FormField
          label="Expected users"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_USERS}
          value={users}
          onChange={event => setUsers(event.target.value)}
          error={usersError}
          hint="The users the margins of this environment assume; leave it empty for none."
        />
        <div aria-live="assertive">
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || Boolean(usersError) || Boolean(slugError)}
            className={primaryClass}
          >
            {busy ? 'Saving…' : current ? 'Save' : 'Create environment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface DeleteProps {
  org: string;
  composition: string;
  environment: CompositionEnvironmentView;
  etag: string | null;
  onClose: () => void;
  onDeleted: () => void;
  onStale?: () => void;
}

/** Deleting an environment: its keys and history go, and its feed stops answering; the slug is typed to confirm. */
export function DeleteEnvironmentDialog({
  org,
  composition,
  environment,
  etag,
  onClose,
  onDeleted,
  onStale,
}: DeleteProps) {
  const api = useEnvironmentsApi();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed === environment.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteEnvironment(org, composition, environment.slug, etag);
      onDeleted();
    } catch (caught) {
      setBusy(false);
      if (offerReloadIfChanged(caught, { resource: 'this environment', reload: onStale })) return;
      const refusal = readApiError(caught);
      setError(
        `The environment couldn’t be deleted${codeOf(refusal)}${refusal.message ? `: ${refusal.message}` : '.'} Nothing was deleted.`
      );
    }
  };

  return (
    <Modal
      title={`Delete ${environment.name}?`}
      tone="danger"
      onClose={() => !busy && onClose()}
      dismissible={!busy}
    >
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-tp-slate">
          This deletes the environment with its feed keys and its adoption history. An application
          that reads its feed stops getting answers. This can’t be undone.
        </p>
        <label className="text-xs font-medium text-tp-steel" htmlFor="environment-delete-confirm">
          Type {environment.slug} to confirm
        </label>
        <input
          id="environment-delete-confirm"
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
          <button type="button" onClick={onClose} disabled={busy} className={buttonClass}>
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
