// Pattern only, after SPHERE frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx (revision fc776b4d),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn the way OpenBinding's derive dialog follows SPHERE's fork modal: a choice, a note and one primary action in
// OpenBinding's modal. SPHERE has no adoption. Adopting makes a sealed version the one an environment's feed serves, so it
// names the environment's revision as `If-Match` (read when the environment is chosen here): a 412 offers to read it again
// instead of adopting over somebody else's adoption. Every refusal is worded; nothing adopts without this human step.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import type {
  CompositionEnvironmentView,
  CompositionVersionView,
  CompositionView,
  EnvironmentAdoptResult,
} from '../../../core/api/types';
import { Modal } from '../../../core/components/modal';
import { SelectField, TextAreaField } from '../../../core/components/select-field';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { useResource } from '../../../core/hooks/useResource';
import { valueStatus } from '../../../core/utils/composition/values';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { useEnvironmentsApi } from '../../api/environmentsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import { adoptionRefusal, type AdoptionRefusal } from '../../utils/environments';

/** A version the dialog offers: its id and label, and its value status when the caller read it. */
export type AdoptableVersion = Pick<CompositionVersionView, 'id' | 'label'> &
  Partial<Pick<CompositionVersionView, 'values_status' | 'current_evaluation'>>;

interface Props {
  org: string;
  composition: CompositionView;
  /** The versions that may be chosen, newest first (a version view, or just its id and label: a run's derived versions). */
  versions: AdoptableVersion[];
  /** The reader's role: only the environments it may adopt in are offered. */
  role: OrgRole | null;
  /** The environment chosen first (its slug). */
  environment?: string;
  /** The version chosen first (its id). */
  version?: string;
  onClose: () => void;
  onAdopted: (result: EnvironmentAdoptResult) => void;
}

export default function AdoptDialog({
  org,
  composition,
  versions,
  role,
  environment: initialEnvironment,
  version: initialVersion,
  onClose,
  onAdopted,
}: Props) {
  const api = useEnvironmentsApi();
  const [environmentSlug, setEnvironmentSlug] = useState(initialEnvironment ?? '');
  const [versionId, setVersionId] = useState(initialVersion ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<AdoptionRefusal | null>(null);
  const [nonce, setNonce] = useState(0);

  const environments = useResource(`adopt-environments:${org}/${composition.slug}`, () =>
    api.listEnvironments(org, composition.slug)
  );
  const allowed = (environments.data ?? []).filter(item => roleAtLeast(role, item.adoptRole));
  const chosenSlug = environmentSlug || allowed[0]?.slug || '';
  // The environment as it is now, with the revision the adoption names.
  const target = useResource<{ value: CompositionEnvironmentView; etag: string | null } | null>(
    `adopt-environment:${org}/${composition.slug}/${chosenSlug}:${nonce}`,
    async () => (chosenSlug ? api.getEnvironment(org, composition.slug, chosenSlug) : null)
  );
  const current = target.data?.value ?? null;
  const etag = target.data?.etag ?? null;
  const inEffectId = current?.inEffect?.version.id ?? null;
  const chosenVersion =
    versions.find(item => item.id === versionId && item.id !== inEffectId) ??
    (versionId ? undefined : versions.find(item => item.id !== inEffectId));
  const label = chosenVersion?.label ?? '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !current || !chosenVersion || !etag) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await api.adopt(
        org,
        composition.slug,
        current.slug,
        { version: chosenVersion.id, note: note.trim() },
        etag
      );
      onAdopted(result.value);
    } catch (caught) {
      setBusy(false);
      setRefusal(
        adoptionRefusal(readApiError(caught), {
          org,
          composition: composition.slug,
          label,
          environment: current.name,
        })
      );
    }
  };

  const loading = environments.status === 'loading' || (chosenSlug && target.status === 'loading');
  const unreadable = environments.status === 'error' || target.status === 'error';

  return (
    <Modal title="Adopt a version" size="lg" onClose={() => !busy && onClose()} dismissible={!busy}>
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-4">
        {environments.status === 'ready' && allowed.length === 0 ? (
          <p className="text-sm text-tp-slate">
            {(environments.data ?? []).length === 0
              ? 'This composition has no environment yet. An admin creates one on the Operation tab.'
              : 'Your role may not adopt in any environment of this composition.'}
          </p>
        ) : (
          <>
            <SelectField
              label="Environment"
              value={chosenSlug}
              onChange={value => {
                setEnvironmentSlug(value);
                setRefusal(null);
              }}
              disabled={busy}
            >
              {allowed.map(item => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                  {item.inEffect
                    ? ` · ${item.inEffect.version.label} in effect`
                    : ' · nothing adopted'}
                </option>
              ))}
            </SelectField>
            {current && (
              <p className="text-xs text-tp-steel" aria-live="polite">
                {current.inEffect
                  ? `In effect now: ${current.inEffect.version.label} (adoption #${current.inEffect.adoption}).`
                  : 'Nothing is in effect here yet.'}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-tp-ink">Version</legend>
              <ul className="max-h-56 divide-y divide-tp-hairline overflow-y-auto rounded-lg border border-tp-hairline">
                {versions.map(item => {
                  const inEffect = item.id === inEffectId;
                  return (
                    <li key={item.id}>
                      <label
                        className={`flex min-h-11 items-center gap-3 px-3 py-2 text-sm ${inEffect ? 'cursor-default bg-tp-primary/5 text-tp-steel' : 'cursor-pointer hover:bg-tp-surface'}`}
                      >
                        <input
                          type="radio"
                          name="adopt-version"
                          value={item.id}
                          checked={chosenVersion?.id === item.id}
                          disabled={inEffect || busy}
                          onChange={() => {
                            setVersionId(item.id);
                            setRefusal(null);
                          }}
                          className="h-4 w-4 accent-tp-primary"
                        />
                        <span className="font-mono font-medium text-tp-ink">{item.label}</span>
                        {item.values_status !== undefined && (
                          <ValueBadge
                            status={valueStatus({
                              values_status: item.values_status,
                              current_evaluation: item.current_evaluation ?? null,
                            })}
                            compact
                          />
                        )}
                        {inEffect && (
                          <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
                            in effect
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
            <TextAreaField
              label="Note"
              value={note}
              onChange={event => setNote(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Why this version, for the history"
              disabled={busy}
            />
            {chosenVersion && current && (
              <p className="rounded-lg bg-tp-surface px-3 py-2 text-xs text-tp-slate">
                The feed changes when you adopt: the application reads {chosenVersion.label} on its
                next poll.
              </p>
            )}
          </>
        )}
        <div aria-live="assertive">
          {loading && !refusal && (
            <p role="status" className="text-xs text-tp-steel">
              Reading the environment…
            </p>
          )}
          {unreadable && (
            <p role="alert" className="text-xs text-red-700">
              The environment couldn’t be read. Close this dialog and try again.
            </p>
          )}
          {refusal && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-700">
              <span>{refusal.text}</span>
              {refusal.link && (
                <Link to={refusal.link.to} onClick={onClose} className="font-medium underline">
                  {refusal.link.label}
                </Link>
              )}
              {refusal.reload && (
                <button
                  type="button"
                  onClick={() => {
                    setRefusal(null);
                    setNonce(value => value + 1);
                  }}
                  className="cursor-pointer rounded-md border border-red-300 px-2 py-1 font-medium"
                >
                  Read it again
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !chosenVersion || !current || !etag || target.status !== 'ready'}
            className="cursor-pointer rounded-lg bg-tp-primary px-4 py-2 text-xs font-semibold text-white hover:bg-tp-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? 'Adopting…' : label ? `Adopt ${label}` : 'Adopt'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
