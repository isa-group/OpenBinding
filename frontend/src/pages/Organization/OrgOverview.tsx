import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import { problemsApi } from '../../api/problems';
import { problemPath, problemsPath } from '../../routes/paths/problems';
import { runsApi } from '../../api/runs';
import { launchPath, runPath, runsPath } from '../../routes/paths/runs';
import { newStudyPath, studiesPath, studyPath } from '../../routes/paths/studies';
import { jobStatus } from '../../features/workspace/model';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ProjectCreate } from '../Project/ProjectCreate';
import { createAddress, useCreateDialog } from './createDialog';
import { ancestorsOf, atLeast, byName, roleSource } from './orgModel';
import { classifyAuthError, marker } from './orgErrors';
import { Breadcrumb, NeutralGate, OrgTile, PageSkeleton, RoleChip } from './parts';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

function ProjectCard({ organization, project }: { organization: Organization; project: Project }) {
  const isPublic = project.visibility === 'public';
  return (
    <Link to={`/app/${organization.slug}/${project.slug}`} viewTransition className="org-project-card">
      <span className="org-project-head">
        <strong>{project.name}</strong>
        <Chip tone={isPublic ? 'success' : 'plain'}>{isPublic ? 'Public' : 'Private'}</Chip>
      </span>
      <span className="org-project-desc">{project.description || 'No description yet.'}</span>
      <span className="org-project-meta">
        <code>{project.slug}</code>
        <span>Created {formatDate(project.created_at) ?? '—'}</span>
        {project.updated_at !== project.created_at && <span>Updated {formatDate(project.updated_at) ?? '—'}</span>}
      </span>
    </Link>
  );
}

/** How many problems the overview lists; the rest are one click away. */
const PROBLEMS_SHOWN = 5;

/** The organization's newest problems and the way to all of them. */
function ProblemsPanel({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const problems = useResource(`org-problems:${slug}`, () => problemsApi.list(slug, { limit: PROBLEMS_SHOWN }));
  const failure = problems.status === 'error' ? classifyAuthError(problems.error) : null;
  const rows = problems.data?.problems ?? [];
  return (
    <section className="org-card" aria-labelledby="org-problems-title" aria-busy={problems.status === 'loading'}>
      <div className="org-card-head">
        <h2 id="org-problems-title">Problems{problems.data && <span className="org-count">{problems.data.total}</span>}</h2>
        {canCreate && <Link to={`${problemsPath(slug)}?create=problem`} viewTransition>+ Upload</Link>}
      </div>
      {problems.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Problems couldn’t be loaded{marker(failure)}.</span>}
      {problems.status === 'ready' && rows.length === 0 && <span className="org-muted">None yet. A problem is a BIM package the organization runs and compares.</span>}
      {rows.map((item) => (
        <Link key={item.id} to={problemPath(slug, item.slug)} viewTransition className="org-sub">
          <span>
            <strong>{item.name}</strong>
            <small>{item.latest_revision ? `version ${item.latest_revision.revision} · ${formatDate(item.latest_revision.created_at) ?? '—'}` : 'no version yet'}</small>
          </span>
        </Link>
      ))}
      <Link to={problemsPath(slug)} viewTransition>All problems</Link>
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
    <section className="org-card" aria-labelledby="org-runs-title" aria-busy={runs.status === 'loading'}>
      <div className="org-card-head">
        <h2 id="org-runs-title">Runs{runs.data && <span className="org-count">{runs.data.total}</span>}</h2>
        {canCreate && <Link to={launchPath(slug)} viewTransition>+ New run</Link>}
      </div>
      {runs.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Runs couldn’t be loaded{marker(failure)}.</span>}
      {runs.status === 'ready' && rows.length === 0 && <span className="org-muted">None yet. A run solves a problem version with an engine.</span>}
      {rows.map((job) => {
        const status = jobStatus(job.status, job.termination);
        return (
          <Link key={job.id} to={runPath(slug, job.id)} viewTransition className="org-sub">
            <span>
              <strong>{job.problem?.name ?? job.engine_id}</strong>
              <small>{status.label} · {job.engine_id} · {formatDateTime(job.created_at) ?? '—'}</small>
            </span>
          </Link>
        );
      })}
      <Link to={runsPath(slug)} viewTransition>All runs</Link>
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
    <section className="org-card" aria-labelledby="org-studies-title" aria-busy={studies.status === 'loading'}>
      <div className="org-card-head">
        <h2 id="org-studies-title">Studies{studies.data && <span className="org-count">{rows.length}</span>}</h2>
        {canCreate && <Link to={newStudyPath(slug)} viewTransition>+ New study</Link>}
      </div>
      {studies.status === 'loading' && <Skeleton variant="tile" />}
      {failure && <span className="org-muted">Studies couldn’t be loaded{marker(failure)}.</span>}
      {studies.status === 'ready' && rows.length === 0 && <span className="org-muted">None yet. A study compares engines and settings across problem versions.</span>}
      {rows.slice(0, STUDIES_SHOWN).map((study) => (
        <Link key={study.id} to={studyPath(slug, study.slug)} viewTransition className="org-sub">
          <span>
            <strong>{study.name}</strong>
            <small>{study.definition.revision_ids.length} problem versions · {study.definition.engines.length} engines · {formatDate(study.created_at) ?? '—'}</small>
          </span>
        </Link>
      ))}
      <Link to={studiesPath(slug)} viewTransition>All studies</Link>
    </section>
  );
}

function OrgOverviewBody({ organization }: { organization: Organization }) {
  const { context } = useRouteOrganization();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const slug = organization.slug;
  const dialog = useCreateDialog('project', `/app/${slug}`);
  const role = organization.effective_role;
  const source = roleSource(organization, context.organizations);
  const canCreate = atLeast(role, 'MEMBER');
  const canAdminister = atLeast(role, 'ADMIN');

  const projects = useResource(`org-projects:${slug}`, () => platformApi.projects(slug));
  const ancestors = ancestorsOf(organization, context.organizations).reverse();
  const subs = context.organizations.filter((item) => item.parent_id === organization.id).sort(byName);

  const all = projects.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all.filter((item) => !needle || `${item.name} ${item.slug}`.toLowerCase().includes(needle));
  const failure = projects.status === 'error' ? classifyAuthError(projects.error) : null;

  return (
    <div className="org-page is-wide">
      <div className="org-topline">
        <Breadcrumb items={[
          { label: 'Home', to: '/app' },
          ...ancestors.map((item) => ({ label: item.name, to: `/app/${item.slug}` })),
          { label: organization.name },
        ]} />
        {context.organizations.length > 1 && (
          <label className="org-switch">
            Switch organization
            <select value={slug} onChange={(event) => navigate(`/app/${event.target.value}`)}>
              {context.organizations.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
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
          {canCreate && <Action variant="primary" data-create-opener="project" onClick={dialog.openDialog}>New project</Action>}
          <Action to={`/app/${slug}/settings/members`} variant="secondary">Members</Action>
          {canAdminister && <Action to={`/app/${slug}/settings/audit`} variant="secondary">Audit</Action>}
          <Action to={`/app/${slug}/settings`} variant="secondary">Settings</Action>
        </div>
      </header>

      <div className="org-columns">
        <section className="org-main" aria-labelledby="org-projects-title" aria-busy={projects.status === 'loading'}>
          <div className="org-section-head">
            <h2 id="org-projects-title">Projects{projects.status === 'ready' && <span className="org-count">{all.length}</span>}</h2>
            <label className="org-find">
              <span className="sr-only">Find a project</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a project…" />
            </label>
          </div>

          {projects.status === 'loading' && (
            <div className="org-project-grid" role="status"><span className="sr-only">Loading projects…</span><Skeleton variant="card" /><Skeleton variant="card" /></div>
          )}

          {failure && (
            <Notice
              tone="error"
              action={<Action variant="secondary" size="sm" onClick={projects.reload}>Retry</Action>}
            >
              {failure.status === 403
                ? `You can’t list the projects of this organization (403). Sub-organizations are unaffected.`
                : `Projects couldn’t be loaded${marker(failure)}. Sub-organizations are unaffected.`}
            </Notice>
          )}

          {projects.status === 'ready' && all.length === 0 && (
            <div className="org-empty">
              <strong>No projects yet</strong>
              <span>
                A project groups people around one piece of work. Anybody can read a public project;
                private ones are only for members.
              </span>
              {canCreate && <Action to={createAddress(`/app/${slug}`, 'project')} variant="primary" size="sm">Create the first project</Action>}
              {role === 'VIEWER' && (
                <small>You’re a VIEWER here, so you can’t create projects. A MEMBER or above can.</small>
              )}
            </div>
          )}

          {projects.status === 'ready' && all.length > 0 && shown.length === 0 && (
            <p className="org-muted">No project matches “{query.trim()}”.</p>
          )}

          {shown.length > 0 && (
            <div className="org-project-grid">
              {shown.map((item) => <ProjectCard key={item.id} organization={organization} project={item} />)}
            </div>
          )}
        </section>

        <aside className="org-aside">
          <ProblemsPanel slug={slug} canCreate={canCreate} />
          <RunsPanel slug={slug} canCreate={canCreate} />
          <StudiesPanel slug={slug} canCreate={canCreate} />
          <section className="org-card" aria-labelledby="org-subs-title">
            <div className="org-card-head">
              <h2 id="org-subs-title">Sub-organizations</h2>
              {canAdminister && <Link to={createAddress('/app', 'organization')} viewTransition>+ Add</Link>}
            </div>
            {subs.length === 0 && <span className="org-muted">None. Sub-organizations inherit everyone’s role from here.</span>}
            {subs.map((item) => {
              const itemSource = roleSource(item, context.organizations);
              return (
                <Link key={item.id} to={`/app/${item.slug}`} viewTransition className="org-sub">
                  <OrgTile organization={item} size="sm" />
                  <span><strong>{item.name}</strong><small>{itemSource.text}</small></span>
                  <RoleChip role={item.effective_role} title={itemSource.text} />
                </Link>
              );
            })}
          </section>
        </aside>
      </div>
      {dialog.open && <ProjectCreate onClose={dialog.close} onCreated={(created) => navigate(`/app/${slug}/${created.slug}`, { replace: true })} />}
    </div>
  );
}

/** An organization (`org-overview`, `/app/:org`): its projects, its problems, its runs, its studies and its sub-organizations. */
export function OrgOverview() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <div className="org-page"><PageSkeleton /></div>;
  if (!organization) return <div className="org-page"><NeutralGate /></div>;
  return <OrgOverviewBody organization={organization} />;
}
