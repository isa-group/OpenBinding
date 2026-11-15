import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Job, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { problemsPath, workbenchPath } from '../../routes/paths/problems';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource, type Resource } from '../../utils/useResource';
import { roleSource } from '../Organization/orgModel';
import { RoleChip } from '../Organization/parts';
import { loadStudies } from './projectData';
import { classifyAuthError, marker } from '../../features/workspace/errors';
import { jobStatus, type StudyContent } from '../../features/workspace/model';
import { cellBreakdown, countWord, integrityOf, latestRun, sealedShare, type IntegrityItem } from './projectModel';
import { OrgFrame, OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { VisibilityChip } from './parts';
import { useRouteProject } from './useRouteProject';
import './Project.css';

const RECENT = 3;

/** An action the role doesn't reach stays visible, dimmed, with the reason. */
function RoleAction({ allowed, to, variant, children }: { allowed: boolean; to: string; variant: 'primary' | 'secondary'; children: ReactNode }) {
  if (allowed) return <Action to={to} variant={variant}>{children}</Action>;
  return <span className={`ui-action is-${variant} is-md`} aria-disabled="true" title="Needs MEMBER">{children}</span>;
}

/** The card's own failure, with its own retry: a card that fails does not take the others with it. */
function CardFailure({ resource, noun }: { resource: Resource<unknown>; noun: string }) {
  const failure = classifyAuthError(resource.error);
  return (
    <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={resource.reload}>Retry</Action>}>
      {failure.status === 403
        ? `You can’t list ${noun} with this account or key (403). The rest of the page is unaffected.`
        : `${noun[0].toUpperCase()}${noun.slice(1)} couldn’t be loaded${marker(failure)}. The rest of the page is unaffected.`}
    </Notice>
  );
}

interface CardProps {
  id: string;
  title: string;
  allLabel: string;
  allTo: string;
  resource: Resource<unknown>;
  noun: string;
  children: ReactNode;
}

function Card({ id, title, allLabel, allTo, resource, noun, children }: CardProps) {
  return (
    <section className="proj-panel" aria-labelledby={id} aria-busy={resource.status === 'loading'}>
      <div className="proj-panel-head">
        <h2 id={id}>{title}</h2>
        <Link to={allTo} viewTransition>{allLabel}</Link>
      </div>
      {resource.status === 'loading' && <div role="status"><span className="sr-only">Loading {noun}…</span><Skeleton variant="tile" /></div>}
      {resource.status === 'error' && <CardFailure resource={resource} noun={noun} />}
      {resource.status === 'ready' && children}
    </section>
  );
}

interface JobsData {
  rows: Job[];
  /** The ids of the jobs this account launched; `null` when its history could not be read. */
  mine: Set<string> | null;
}

function duration(job: Job): string | null {
  if (!job.finished_at) return null;
  const seconds = Math.max(0, Math.round((Date.parse(job.finished_at) - Date.parse(job.created_at)) / 1000));
  if (Number.isNaN(seconds)) return null;
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}

function JobsCard({ root, resource, platformAdmin }: { root: string; resource: Resource<JobsData>; platformAdmin: boolean }) {
  const rows = (resource.data?.rows ?? []).slice(0, 5);
  const mine = resource.data?.mine ?? null;
  return (
    <Card id="po-jobs" title="Recent runs" allLabel="All runs" allTo={`${root}/runs`} resource={resource} noun="runs">
      {rows.length === 0 && <p className="org-muted">No runs in this project yet.</p>}
      {rows.length > 0 && (
        <ul className="proj-jobs" aria-label="Recent runs">
          {rows.map((job) => {
            const status = jobStatus(job.status, job.termination);
            const own = platformAdmin || Boolean(mine?.has(job.id));
            const took = duration(job);
            return (
              <li key={job.id} className="proj-job">
                <span className={`proj-dot is-${status.tone}`} aria-hidden="true" />
                <span className="proj-job-body">
                  <strong>{job.engine_id}</strong>
                  <small>{formatDateTime(job.created_at) ?? '—'}{took ? ` · ${took}` : ''}</small>
                </span>
                <span className={`proj-status is-${status.tone}`}>{status.label}</span>
                {own
                  ? <Link to={`${root}/runs/${job.id}`} viewTransition aria-label={`Open ${job.engine_id} run from ${formatDateTime(job.created_at) ?? 'an unknown time'}`}>Open</Link>
                  : <small className="proj-owner-only" title="Runs open only for whoever launched them">Owner only</small>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function StudiesCard({ root, resource }: { root: string; resource: Resource<StudyContent[]> }) {
  const studies = (resource.data ?? []).filter((entry) => !entry.study.archived);
  return (
    <Card id="po-studies" title="Studies" allLabel="All studies" allTo={`${root}/studies`} resource={resource} noun="studies">
      {studies.length === 0 && <p className="org-muted">No studies yet. A study compares engines and settings across problems.</p>}
      {studies.slice(0, RECENT).map(({ study, runs, latestCells }) => {
        const run = latestRun(runs);
        const definition = study.definition;
        const cells = definition.case_revision_ids.length * definition.engines.length * Math.max(1, definition.parameter_sets.length) * definition.seeds.length;
        const parts = [
          `${definition.case_revision_ids.length} problem versions`, `${definition.engines.length} engines`,
          ...(definition.parameter_sets.length > 1 ? [`${definition.parameter_sets.length} parameter sets`] : []),
          `${definition.seeds.length} seeds`,
        ];
        const breakdown = latestCells ? cellBreakdown(latestCells) : [];
        const total = breakdown.reduce((sum, item) => sum + item.count, 0);
        const label = breakdown.map((item) => `${item.count} ${item.label}`).join(', ');
        return (
          <Link key={study.id} to={`${root}/studies`} viewTransition className="proj-row-card">
            <span className="proj-row-top">
              <strong>{study.name}</strong>
              <span className={`proj-status is-${run ? (run.state === 'completed' ? 'ok' : run.state === 'failed' ? 'bad' : run.state === 'cancelled' ? 'off' : 'warn') : 'queued'}`}>
                {run ? `Run #${run.run_number} · ${run.state}` : 'Never run'}
              </span>
            </span>
            <small className="proj-row-note">{parts.join(' × ')} = {cells.toLocaleString('en-US')} cells · {formatDate(study.created_at) ?? '—'}</small>
            {total > 0 && (
              <>
                <span className="proj-cellbar" role="img" aria-label={`${label} of ${total}`}>
                  {breakdown.map((item) => <span key={item.id} className={`is-${item.id}`} style={{ width: `${(item.count / total) * 100}%` }} />)}
                </span>
                <span className="proj-cell-legend">{breakdown.map((item) => <span key={item.id}><i className={`is-${item.id}`} aria-hidden="true" /> {item.count} {item.label}</span>)}</span>
              </>
            )}
          </Link>
        );
      })}
    </Card>
  );
}

function IntegrityStrip({ items }: { items: IntegrityItem[] }) {
  const share = sealedShare(items);
  return (
    <section className="proj-integrity" aria-labelledby="po-integrity">
      <div>
        <h2 id="po-integrity">What’s sealed and what’s still a draft</h2>
        <span className="org-muted">Sealed items have a fingerprint and never change; drafts can still be edited.</span>
      </div>
      <div className="proj-integrity-body">
        <div className="proj-sealbar" aria-hidden="true">
          <span className="is-sealed" style={{ width: `${share.sealedPct}%` }} />
          <span className="is-draft" style={{ width: `${share.draftPct}%` }} />
        </div>
        <ul className="proj-integrity-chips" aria-label="Sealed and draft items">
          {items.length === 0 && <li className="is-sealed"><b>0</b> sealed items</li>}
          {items.map((item) => <li key={item.id} className={`is-${item.kind}`}><b>{item.count}</b> {countWord(item)}</li>)}
        </ul>
      </div>
    </section>
  );
}

function GetStarted({ org, root, canCreate }: { org: string; root: string; canCreate: boolean }) {
  const steps: Array<{ title: string; detail: string; cta: string; to: string; needsMember?: boolean }> = [
    { title: 'Add a problem', detail: 'Problems belong to the organization: upload a package or write one in its Workbench.', cta: 'Open problems', to: problemsPath(org) },
    { title: 'Start a run', detail: 'Run a problem version with an exact engine.', cta: 'New run', to: `${root}/runs/new`, needsMember: true },
    { title: 'Validate a package', detail: 'Check a .bim.zip you already have.', cta: 'Open Workbench', to: '/workbench' },
  ];
  return (
    <section className="proj-start" aria-labelledby="po-start">
      <div>
        <h2 id="po-start">Get started</h2>
        <p>This project is empty. Three ways to begin:</p>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="proj-step-n" aria-hidden="true">{index + 1}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
            {step.needsMember && !canCreate
              ? <span className="proj-owner-only" title="Needs MEMBER">{step.cta} · needs MEMBER</span>
              : <Link to={step.to} viewTransition>{step.cta}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function OverviewBody({ organization, project, canCreate, publicRead, role, roleTitle }: {
  organization: Organization; project: Project; canCreate: boolean; publicRead: boolean; role: Organization['effective_role'] | 'PLATFORM ADMIN'; roleTitle?: string;
}) {
  const { isAdmin } = useAuth();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;

  // A visitor of a public project never reads its jobs (the gateway refuses them), so the card is neither asked for nor shown.
  const jobs = useResource<JobsData>(`overview-jobs:${org}/${slug}:${publicRead ? 'public' : 'member'}`, async () => {
    if (publicRead) return { rows: [], mine: null };
    const [rows, own] = await Promise.all([platformApi.projectJobs(org, slug), apiClient.listOwnJobs({ limit: 100 }).catch(() => null)]);
    return { rows, mine: own ? new Set(own.jobs.map((job) => job.id)) : null };
  });
  const studies = useResource(`overview-studies:${org}/${slug}`, () => loadStudies(org, slug, RECENT));

  const loaded = [jobs, studies].every((item) => item.status === 'ready');
  const empty = loaded && (jobs.data?.rows.length ?? 0) === 0 && (studies.data?.length ?? 0) === 0;
  const sealed = studies.status === 'ready' ? integrityOf({ studies: studies.data }) : null;

  const header = (
    <>
      <div className="proj-title-row">
        <div className="proj-title">
          <span className="proj-title-line">
            <h1>{project.name}</h1>
            <VisibilityChip visibility={project.visibility} />
            {!publicRead && <RoleChip role={role} title={roleTitle} />}
          </span>
          <p>{project.description || 'No description yet.'}</p>
        </div>
        <div className="proj-actions">
          {!publicRead && (
            <>
              <RoleAction allowed={canCreate} to={`${root}/runs/new`} variant="primary">Run</RoleAction>
              <RoleAction allowed={canCreate} to={`${root}/studies/new`} variant="secondary">New study</RoleAction>
              <Action to={problemsPath(org)} variant="secondary">Problems</Action>
              <Action to={workbenchPath(org)} variant="secondary">Workbench</Action>
            </>
          )}
        </div>
      </div>
      {publicRead && <small className="org-muted">Studies are open to read. Only members can change anything or see runs.</small>}
      {!publicRead && !canCreate && <small className="org-muted">You’re a VIEWER: you can read everything here; creating needs MEMBER.</small>}
    </>
  );

  return (
    <OrgFrame organization={organization} project={project} section="overview" header={header}>
      {empty && !publicRead && <GetStarted org={org} root={root} canCreate={canCreate} />}
      {empty && publicRead && <p className="org-muted">Nothing has been shared in this project yet.</p>}
      {sealed && !empty && <IntegrityStrip items={sealed} />}
      {!empty && (
        <div className="proj-grid">
          {!publicRead && <JobsCard root={root} resource={jobs} platformAdmin={isAdmin} />}
          <StudiesCard root={root} resource={studies} />
        </div>
      )}
    </OrgFrame>
  );
}

/** A project (`proj-overview`, `/app/:org/:project`): its runs and studies, each card on its own. */
export function ProjectOverview() {
  const { context, organization, project, access, waiting, failure, reload } = useRouteProject();
  const { isAdmin } = useAuth();
  if (waiting) return <OrgSkeleton label="Loading project…" />;
  if (!organization || !project) {
    return <OrgGate failure={organization ? failure : null} organizationName={organization?.name} onRetry={reload} />;
  }
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' : null);
  return (
    <OverviewBody
      organization={organization}
      project={project}
      canCreate={access.canCreate}
      publicRead={access.publicRead}
      role={role}
      roleTitle={roleSource(organization, context.organizations).text}
    />
  );
}
