// One environment of a composition on the Operation tab (`?environment=<slug>`): what it is, who answers for it, and the
// version in effect. SPHERE has no environments; the header follows the composition page's own sections. ADMIN edits and
// deletes it from here with the `ETag` this read answered.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type {
  CompositionEnvironmentView,
  CompositionVersionView,
  CompositionView,
} from '../../../core/api/types';
import { CompositionRenderer } from '../../../core/components/composition-renderer/CompositionRenderer';
import { MarginTable } from '../../../core/components/margin-table';
import { UpstreamBadge } from '../../../core/components/upstream-badge';
import { useResource } from '../../../core/hooks/useResource';
import { compositionViewModel } from '../../../core/utils/composition/viewModel';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { compositionPath } from '../../../../routes/paths/compositions';
import { compositionsApi, useCompositionsApi } from '../../api/compositionsApi';
import { useEnvironmentsApi } from '../../api/environmentsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import AdoptionHistory from '../adoption-history';
import CheckPanel from '../check-panel';
import EnvironmentKeyPanel from '../environment-key-panel';
import { adoptedText } from '../../utils/environments';
import EnvironmentFormDialog, { DeleteEnvironmentDialog } from '../environment-form-dialog';

const actionClass =
  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none';

interface Props {
  org: string;
  composition: CompositionView;
  versions: CompositionVersionView[];
  slug: string;
  role: OrgRole | null;
  /** The address of the grid of environments. */
  backTo: string;
  onAdopt?: (environment: CompositionEnvironmentView) => void;
  /** Something changed (an edit, a delete): say it and read the list again. */
  onChanged: (message?: string) => void;
}

export default function EnvironmentDetail({
  org,
  composition,
  slug,
  role,
  backTo,
  onAdopt,
  onChanged,
}: Props) {
  const api = useEnvironmentsApi();
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  const read = useResource(
    `composition-environment:${org}/${composition.slug}/${slug}:${nonce}`,
    () => api.getEnvironment(org, composition.slug, slug)
  );
  const reload = () => setNonce(value => value + 1);
  const canAdminister = roleAtLeast(role, 'ADMIN');
  const { getVersionMargins } = useCompositionsApi();

  // The version in effect, its upstream plans and its margins with the pinned evaluation. The users default to the
  // environment's expected users; a value typed here only asks again (after a pause) and is never saved.
  const loaded = read.data?.value ?? read.stale?.value ?? null;
  const current = loaded?.inEffect ?? null;
  const [usersTyped, setUsersTyped] = useState<string | null>(null);
  const usersShown =
    usersTyped ?? (loaded && loaded.expectedUsers !== null ? String(loaded.expectedUsers) : '');
  const [usersPaused, setUsersPaused] = useState(usersShown);
  useEffect(() => {
    const timer = window.setTimeout(() => setUsersPaused(usersShown), 400);
    return () => window.clearTimeout(timer);
  }, [usersShown]);
  const usersAsked = usersTyped === null ? usersShown : usersPaused;
  const users = /^[1-9]\d{0,9}$/.test(usersAsked) ? usersAsked : undefined;
  const margins = useResource(
    `environment-margins:${org}/${composition.slug}/${current?.version.id ?? 'none'}/${current?.evaluation?.id ?? ''}/${users ?? ''}`,
    async () =>
      current
        ? getVersionMargins(org, composition.slug, current.version.id, {
            users,
            evaluation: current.evaluation?.id,
          })
        : null
  );
  const upstream = useResource(
    `environment-upstream:${org}/${composition.slug}/${current?.version.id ?? 'none'}`,
    async () =>
      current
        ? compositionsApi.upstream(org, composition.slug, current.version.id).catch(() => null)
        : null
  );

  const back = (
    <Link
      to={backTo}
      className="inline-flex items-center gap-1 text-xs text-tp-steel hover:text-tp-ink hover:underline"
    >
      <span aria-hidden="true">←</span> All environments
    </Link>
  );

  if (read.status === 'error') {
    const failure = classifyAuthError(read.error);
    const missing = (read.error as { status?: number } | null)?.status === 404;
    return (
      <div className="flex flex-col gap-3">
        {back}
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {missing
            ? `There is no environment “${slug}” in this composition.`
            : `The environment couldn’t be loaded${marker(failure)}.`}
          {!missing && (
            <button type="button" onClick={read.reload} className={actionClass}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }
  const environment = read.data?.value ?? read.stale?.value;
  if (!environment)
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p role="status" className="py-12 text-center text-sm text-tp-steel">
          Loading the environment…
        </p>
      </div>
    );
  const etag = read.data?.etag ?? null;
  const inEffect = environment.inEffect;
  const operator = environment.operator;
  const canAdopt =
    Boolean(onAdopt) && roleAtLeast(role, environment.adoptRole) && !composition.archived;

  return (
    <div className="flex flex-col gap-4">
      {back}
      <section
        aria-labelledby="environment-heading"
        className="rounded-xl border border-tp-hairline bg-tp-canvas"
      >
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="environment-heading" className="font-display text-lg text-tp-ink">
              {environment.name}
            </h2>
            <p className="font-mono text-xs text-tp-steel">{environment.slug}</p>
            {environment.description && (
              <p className="mt-1 text-sm text-tp-slate">{environment.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canAdopt && (
              <button
                type="button"
                onClick={() => onAdopt?.(environment)}
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-tp-primary px-3 text-xs font-medium text-white transition-colors hover:bg-tp-primary/90"
              >
                Adopt…
              </button>
            )}
            {canAdminister && (
              <>
                <button type="button" onClick={() => setDialog('edit')} className={actionClass}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setDialog('delete')}
                  className={`${actionClass} text-red-700`}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-5 py-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-tp-steel">In effect</dt>
            <dd className="text-tp-ink">
              {inEffect ? (
                <>
                  <span className="font-mono">{inEffect.version.label}</span> · Adoption #
                  {inEffect.adoption}
                </>
              ) : (
                'Nothing adopted yet'
              )}
            </dd>
            {inEffect && <dd className="text-tp-steel">{adoptedText(inEffect)}</dd>}
          </div>
          <div>
            <dt className="text-tp-steel">Operator</dt>
            <dd className="text-tp-ink">
              {operator
                ? `${operator.displayName}${operator.member ? '' : ' (no longer a member)'}`
                : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-tp-steel">Who may adopt</dt>
            <dd className="text-tp-ink">
              {environment.adoptRole === 'MEMBER' ? 'Members' : 'Admins'}
            </dd>
          </div>
          <div>
            <dt className="text-tp-steel">Expected users</dt>
            <dd className="text-tp-ink">
              {environment.expectedUsers !== null
                ? environment.expectedUsers.toLocaleString('en')
                : 'Not set'}
            </dd>
          </div>
        </dl>
      </section>

      <section
        aria-label="Operation"
        className="rounded-xl border border-tp-hairline bg-tp-canvas p-5"
      >
        <CompositionRenderer
          model={compositionViewModel({
            composition,
            version: null,
            facts: null,
            reader: 'member',
          })}
          mode="operations"
          hideSections={['adoptions']}
          operation={{
            inEffect,
            upstream: upstream.data ?? null,
            onOpenVersion: label =>
              compositionPath(org, composition.slug, undefined, { version: label }),
            onAdopt: canAdopt ? () => onAdopt?.(environment) : undefined,
            badge: <UpstreamBadge upstream={environment.upstream} />,
            margins: (
              <MarginTable
                margins={margins.data ?? margins.stale ?? null}
                loading={margins.status === 'loading'}
                error={
                  margins.status === 'error'
                    ? `The margins couldn’t be computed${marker(classifyAuthError(margins.error))}.`
                    : null
                }
                users={{ value: usersShown, onChange: setUsersTyped }}
              />
            ),
          }}
        />
      </section>

      {roleAtLeast(role, 'MEMBER') && (
        <CheckPanel
          org={org}
          composition={composition.slug}
          environment={environment.slug}
          adopted={inEffect !== null}
        />
      )}

      <EnvironmentKeyPanel
        org={org}
        composition={composition.slug}
        environment={environment}
        canAdminister={canAdminister}
        onChanged={reload}
      />

      <AdoptionHistory
        org={org}
        composition={composition.slug}
        environment={environment.slug}
        inEffect={inEffect?.adoption ?? null}
        refresh={`${inEffect?.adoption ?? 0}`}
      />

      {dialog === 'edit' && (
        <EnvironmentFormDialog
          org={org}
          composition={composition.slug}
          editing={{ environment, etag }}
          onClose={() => setDialog(null)}
          onStale={() => {
            setDialog(null);
            reload();
          }}
          onSaved={saved => {
            setDialog(null);
            reload();
            onChanged(`Environment “${saved.name}” saved.`);
          }}
        />
      )}
      {dialog === 'delete' && (
        <DeleteEnvironmentDialog
          org={org}
          composition={composition.slug}
          environment={environment}
          etag={etag}
          onClose={() => setDialog(null)}
          onStale={() => {
            setDialog(null);
            reload();
          }}
          onDeleted={() => {
            setDialog(null);
            onChanged(`Environment “${environment.name}” deleted.`);
            void navigate(backTo);
          }}
        />
      )}
    </div>
  );
}
