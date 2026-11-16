import { Link, useNavigate } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import { problemsApi } from '../../api/problems';
import { compositionsApi } from '../../entities/composition/api';
import { kindLabel } from '../../entities/composition/kinds';
import { valueStatus } from '../../entities/composition/values';
import { compositionPath, compositionsPath } from '../../routes/paths/compositions';
import { problemPath, problemsPath } from '../../routes/paths/problems';
import { runsApi } from '../../api/runs';
import { launchPath, runPath, runsPath } from '../../routes/paths/runs';
import { newStudyPath, studiesPath, studyPath } from '../../routes/paths/studies';
import { jobStatus } from '../../features/workspace/model';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ValueBadge } from '../../widgets/value-badge/ValueBadge';
import { createAddress } from './createDialog';
import { ancestorsOf, atLeast, byName, roleSource } from './orgModel';
import { classifyAuthError, marker } from '../../shared/api/errors';
import { Breadcrumb } from '../../features/workspace/parts';
import { NeutralGate, OrgTile, PageSkeleton, RoleChip } from './parts';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

/** How many compositions the overview lists; the rest are one click away. */
const COMPOSITIONS_SHOWN = 5;

/** The organization's active compositions, the ones changed last first, with how many there are and the way to all of them. */
function CompositionsPanel({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const compositions = useResource(`org-compositions:${slug}`, () =>
    compositionsApi.list(slug, { archived: false, sort: 'updated', limit: COMPOSITIONS_SHOWN })
  );
  const failure = compositions.status === 'error' ? classifyAuthError(compositions.error) : null;
  const rows = compositions.data?.compositions ?? [];
  return (
    <section
      className="org-card"
      aria-labelledby="org-compositions-title"
      aria-busy={compositions.status === 'loading'}
    >
      <div className="org-card-head">
        <h2 id="org-compositions-title">
          Compositions
          {compositions.data && <span className="org-count">{compositions.data.total}</span>}
        </h2>
        {canCreate && (
          <Link to={`${compositionsPath(slug)}?create=composition`} viewTransition>
            + New composition
          </Link>
        )}
      </div>
      {compositions.status === 'loading' && <Skeleton variant="tile" />}
      {failure && (
        <span className="org-muted">Compositions couldn’t be loaded{marker(failure)}.</span>
      )}
      {compositions.status === 'ready' && rows.length === 0 && (
        <span className="org-muted">
          None yet. A composition is the binding the organization keeps: the service chosen for each
          task, and the values it yields.
        </span>
      )}
      {rows.map(item => (
        <Link
          key={item.id}
          to={compositionPath(slug, item.slug)}
          viewTransition
          className="org-sub"
        >
          <span>
            <strong>{item.name}</strong>
            <small>
              {kindLabel(item.kind)} ·{' '}
              {item.latest_version ? `version ${item.latest_version.label}` : 'no version yet'} ·{' '}
              {formatDate(item.updated_at) ?? '—'}
            </small>
          </span>
          {item.latest_version && <ValueBadge status={valueStatus(item.latest_version)} />}
        </Link>
      ))}
      <Link to={compositionsPath(slug)} viewTransition>
        All compositions
      </Link>
    </section>
  );
}

/** How many problems the overview lists; the rest are one click away. */
const PROBLEMS_SHOWN = 5;

/** The organization's newest problems and the way to all of them. */
function ProblemsPanel({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const problems = useResource(`org-problems:${slug}`, () =>
    problemsApi.list(slug, { limit: PROBLEMS_SHOWN })
  );
  const failure = problems.status === 'error' ? classifyAuthError(problems.error) : null;
  const rows = problems.data?.problems ?? [];
  return (
    <section
      className="org-card"
      aria-labelledby="org-problems-title"
      aria-busy={problems.status === 'loading'}
    >
      <div className="org-card-head">
        <h2 id="org-problems-title">
          Problems{problems.data && <span className="org-count">{problems.data.total}</span>}
        </h2>
        {canCreate && (
          <Link to={`${problemsPath(slug)}?create=problem`} viewTransition>
            + Upload
          </Link>
        )}
      </div>
      {problems.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Problems couldn’t be loaded{marker(failure)}.</span>}
      {problems.status === 'ready' && rows.length === 0 && (
        <span className="org-muted">
          None yet. A problem is a BIM package the organization runs and compares.
        </span>
      )}
      {rows.map(item => (
        <Link key={item.id} to={problemPath(slug, item.slug)} viewTransition className="org-sub">
          <span>
            <strong>{item.name}</strong>
            <small>
              {item.latest_revision
                ? `version ${item.latest_revision.revision} · ${formatDate(item.latest_revision.created_at) ?? '—'}`
                : 'no version yet'}
            </small>
          </span>
        </Link>
      ))}
      <Link to={problemsPath(slug)} viewTransition>
        All problems
      </Link>
    </section>
  );
}

/** How many runs the overview lists. */
const RUNS_SHOWN = 5;

/** The organization's newest runs, whoever launched them, and the way to all of them. */
function RunsPanel({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const runs = useResource(`org-runs:${slug}`, () => runsApi.list(slug, { limit: RUNS_SHOWN }));
  const failure = runs.status === 'error' ? classifyAuthError(runs.error) : null;
  const rows = runs.data?.runs ?? [];
  return (
    <section
      className="org-card"
      aria-labelledby="org-runs-title"
      aria-busy={runs.status === 'loading'}
    >
      <div className="org-card-head">
        <h2 id="org-runs-title">
          Runs{runs.data && <span className="org-count">{runs.data.total}</span>}
        </h2>
        {canCreate && (
          <Link to={launchPath(slug)} viewTransition>
            + New run
          </Link>
        )}
      </div>
      {runs.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Runs couldn’t be loaded{marker(failure)}.</span>}
      {runs.status === 'ready' && rows.length === 0 && (
        <span className="org-muted">None yet. A run solves a problem version with an engine.</span>
      )}
      {rows.map(job => {
        const status = jobStatus(job.status, job.termination);
        return (
          <Link key={job.id} to={runPath(slug, job.id)} viewTransition className="org-sub">
            <span>
              <strong>{job.problem?.name ?? job.engine_id}</strong>
              <small>
                {status.label} · {job.engine_id} · {formatDateTime(job.created_at) ?? '—'}
              </small>
            </span>
          </Link>
        );
      })}
      <Link to={runsPath(slug)} viewTransition>
        All runs
      </Link>
    </section>
  );
}

/** How many studies the overview lists. */
const STUDIES_SHOWN = 5;

/** The organization's studies (the live ones, by name) and the way to all of them. */
function StudiesPanel({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const studies = useResource(`org-studies:${slug}`, () => platformApi.studies(slug));
  const failure = studies.status === 'error' ? classifyAuthError(studies.error) : null;
  const rows = studies.data ?? [];
  return (
    <section
      className="org-card"
      aria-labelledby="org-studies-title"
      aria-busy={studies.status === 'loading'}
    >
      <div className="org-card-head">
        <h2 id="org-studies-title">
          Studies{studies.data && <span className="org-count">{rows.length}</span>}
        </h2>
        {canCreate && (
          <Link to={newStudyPath(slug)} viewTransition>
            + New study
          </Link>
        )}
      </div>
      {studies.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Studies couldn’t be loaded{marker(failure)}.</span>}
      {studies.status === 'ready' && rows.length === 0 && (
        <span className="org-muted">
          None yet. A study compares engines and settings across problem versions.
        </span>
      )}
      {rows.slice(0, STUDIES_SHOWN).map(study => (
        <Link key={study.id} to={studyPath(slug, study.slug)} viewTransition className="org-sub">
          <span>
            <strong>{study.name}</strong>
            <small>
              {study.definition.revision_ids.length} problem versions ·{' '}
              {study.definition.engines.length} engines · {formatDate(study.created_at) ?? '—'}
            </small>
          </span>
        </Link>
      ))}
      <Link to={studiesPath(slug)} viewTransition>
        All studies
      </Link>
    </section>
  );
}

function OrgOverviewBody({ organization }: { organization: Organization }) {
  const { context } = useRouteOrganization();
  const navigate = useNavigate();
  const slug = organization.slug;
  const role = organization.effective_role;
  const source = roleSource(organization, context.organizations);
  const canCreate = atLeast(role, 'MEMBER');
  const canAdminister = atLeast(role, 'ADMIN');

  const ancestors = ancestorsOf(organization, context.organizations).reverse();
  const subs = context.organizations
    .filter(item => item.parent_id === organization.id)
    .sort(byName);

  return (
    <div className="org-page is-wide">
      <div className="org-topline">
        <Breadcrumb
          items={[
            { label: 'Home', to: '/app' },
            ...ancestors.map(item => ({ label: item.name, to: `/app/${item.slug}` })),
            { label: organization.name },
          ]}
        />
        {context.organizations.length > 1 && (
          <label className="org-switch">
            Switch organization
            <select value={slug} onChange={event => navigate(`/app/${event.target.value}`)}>
              {context.organizations.map(item => (
                <option key={item.id} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <header className="org-hero">
        <OrgTile organization={organization} size="lg" />
        <div className="org-hero-body">
          <h1>{organization.name}</h1>
          <span className="org-hero-line">
            <code>/app/{slug}</code>
            <RoleChip role={role} title={source.text} />
            <small>{source.text}</small>
          </span>
          <span className="org-hero-created">
            Created {formatDate(organization.created_at) ?? '—'}
          </span>
        </div>
        <div className="org-hero-actions">
          {canCreate && (
            <Action to={`${problemsPath(slug)}?create=problem`} variant="primary">
              Upload BIM package
            </Action>
          )}
          <Action to={`/app/${slug}/settings/members`} variant="secondary">
            Members
          </Action>
          {canAdminister && (
            <Action to={`/app/${slug}/settings/audit`} variant="secondary">
              Audit
            </Action>
          )}
          <Action to={`/app/${slug}/settings`} variant="secondary">
            Settings
          </Action>
        </div>
      </header>

      <div className="org-columns">
        <div className="org-main org-panels">
          <CompositionsPanel slug={slug} canCreate={canCreate} />
          <ProblemsPanel slug={slug} canCreate={canCreate} />
          <RunsPanel slug={slug} canCreate={canCreate} />
          <StudiesPanel slug={slug} canCreate={canCreate} />
          {role === 'VIEWER' && (
            <small className="org-muted">
              You’re a VIEWER here: you read everything, and a MEMBER or above writes compositions,
              uploads problems and launches runs and studies.
            </small>
          )}
        </div>

        <aside className="org-aside">
          <section className="org-card" aria-labelledby="org-subs-title">
            <div className="org-card-head">
              <h2 id="org-subs-title">Sub-organizations</h2>
              {canAdminister && (
                <Link to={createAddress('/app', 'organization')} viewTransition>
                  + Add
                </Link>
              )}
            </div>
            {subs.length === 0 && (
              <span className="org-muted">
                None. Sub-organizations inherit everyone’s role from here.
              </span>
            )}
            {subs.map(item => {
              const itemSource = roleSource(item, context.organizations);
              return (
                <Link key={item.id} to={`/app/${item.slug}`} viewTransition className="org-sub">
                  <OrgTile organization={item} size="sm" />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{itemSource.text}</small>
                  </span>
                  <RoleChip role={item.effective_role} title={itemSource.text} />
                </Link>
              );
            })}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** An organization (`org-overview`, `/app/:org`): its compositions, its problems, its runs, its studies and its sub-organizations. */
export function OrgOverview() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting)
    return (
      <div className="org-page">
        <PageSkeleton />
      </div>
    );
  if (!organization)
    return (
      <div className="org-page">
        <NeutralGate />
      </div>
    );
  return <OrgOverviewBody organization={organization} />;
}
