import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Pencil } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Job, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource, type Resource } from '../../utils/useResource';
import { roleSource } from '../Organization/orgModel';
import { RoleChip } from '../Organization/parts';
import { loadCases, loadReports, loadStudies } from './projectData';
import { classifyAuthError, marker } from './projectErrors';
import {
  cellBreakdown, countWord, integrityOf, jobStatus, latestRun, reportStanding, sealedShare,
  type CaseContent, type IntegrityItem, type StudyContent,
} from './projectModel';
import type { ReportsContent } from './projectData';
import { ProjectFrame, ProjectGate, ProjectSkeleton, VisibilityChip } from './parts';
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

function CasesCard({ root, resource }: { root: string; resource: Resource<CaseContent[]> }) {
  const cases = resource.data ?? [];
  return (
    <Card id="po-cases" title="Cases" allLabel="All cases" allTo={`${root}/cases`} resource={resource} noun="cases">
      {cases.length === 0 && <p className="org-muted">No cases yet. A case holds a workflow, its candidates, constraints and goal.</p>}
      {cases.slice(0, RECENT).map(({ item, revisions }) => {
        const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
        const shown = ordered.slice(-4);
        return (
          <Link key={item.id} to={`${root}/cases/${item.slug}`} viewTransition className="proj-row-card">
            <span className="proj-row-top">
              <strong>{item.name}</strong>
              <small>{revisions.length === 1 ? '1 revision' : `${revisions.length} revisions`}</small>
            </span>
            {shown.length > 0 && (
              <ol className="proj-revisions" aria-label={`Revisions of ${item.name}`}>
                {ordered.length > shown.length && <li aria-hidden="true">…</li>}
                {shown.map((revision, index) => (
                  <li key={revision.id}>
                    <span
                      className={`proj-rev${index === shown.length - 1 ? ' is-latest' : ''}`}
                      title={`${formatDate(revision.created_at) ?? '—'} · ${shortDigest(revision.digest)}${index === shown.length - 1 ? ' · latest' : ''}`}
                    >
                      r{revision.revision}
                    </span>
                    {index < shown.length - 1 && <span aria-hidden="true" className="proj-rev-arrow">→</span>}
                  </li>
                ))}
              </ol>
            )}
            <small className="proj-row-note">{item.description || `Created ${formatDate(item.created_at) ?? '—'}`}</small>
          </Link>
        );
      })}
      {cases.length > RECENT && <small className="org-muted">{cases.length - RECENT} more in All cases.</small>}
    </Card>
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
    <Card id="po-jobs" title="Recent jobs" allLabel="All jobs" allTo={`${root}/jobs`} resource={resource} noun="jobs">
      {rows.length === 0 && <p className="org-muted">No jobs in this project yet.</p>}
      {rows.length > 0 && (
        <ul className="proj-jobs" aria-label="Recent jobs">
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
                  ? <Link to={`${root}/jobs/${job.id}`} viewTransition aria-label={`Open ${job.engine_id} job from ${formatDateTime(job.created_at) ?? 'an unknown time'}`}>Open</Link>
                  : <small className="proj-owner-only" title="Jobs open only for whoever launched them">Owner only</small>}
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
      {studies.length === 0 && <p className="org-muted">No studies yet. A study compares engines and settings across cases.</p>}
      {studies.slice(0, RECENT).map(({ study, runs, latestCells }) => {
        const run = latestRun(runs);
        const definition = study.definition;
        const cells = definition.case_revision_ids.length * definition.engines.length * Math.max(1, definition.parameter_sets.length) * definition.seeds.length;
        const parts = [
          `${definition.case_revision_ids.length} case revisions`, `${definition.engines.length} engines`,
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

function ReportsCard({ root, resource }: { root: string; resource: Resource<ReportsContent> }) {
  const content = resource.data;
  const reports = content?.reports ?? [];
  return (
    <Card id="po-reports" title="Reports" allLabel="All reports" allTo={`${root}/reports`} resource={resource} noun="reports">
      {reports.length === 0 && <p className="org-muted">No reports yet. Reports turn a study run into a document you can freeze and publish.</p>}
      {reports.slice(0, 4).map((report) => {
        const standing = reportStanding(report, content?.publications ?? []);
        const Icon = standing === 'draft' ? Pencil : Lock;
        return (
          <div key={report.id} className="proj-report">
            <span className={`proj-report-tile is-${standing}`} aria-hidden="true"><Icon /></span>
            <span className="proj-job-body">
              <Link to={`${root}/reports/${report.slug}`} viewTransition><strong>{report.title}</strong></Link>
              <small>{standing === 'draft' ? `Draft · revision ${report.draft_revision ?? 1}` : `Frozen · ${shortDigest(report.digest)}`}</small>
            </span>
            <span className={`proj-status is-${standing === 'published' ? 'ok' : standing === 'draft' ? 'warn' : 'running'}`}>
              {standing === 'published' ? 'Published' : standing === 'frozen' ? 'Frozen' : 'Draft'}
            </span>
            {standing === 'published' && <Link to={`/resolve/report/${report.digest}`} viewTransition aria-label={`Verify ${report.title}`}>Verify</Link>}
          </div>
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

function GetStarted({ root, canCreate }: { root: string; canCreate: boolean }) {
  const steps: Array<{ title: string; detail: string; cta: string; to: string; needsMember?: boolean }> = [
    { title: 'Import an example', detail: 'Start from a ready package and adapt it.', cta: 'Browse examples', to: '/examples' },
    { title: 'Create a case', detail: 'Compose a workflow, candidates, constraints and goal.', cta: 'New case', to: `${root}/cases`, needsMember: true },
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

function OverviewBody({ organization, project, canCreate, role, roleTitle }: {
  organization: Organization; project: Project; canCreate: boolean; role: Organization['effective_role'] | 'PLATFORM ADMIN'; roleTitle?: string;
}) {
  const { isAdmin } = useAuth();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;

  const cases = useResource(`overview-cases:${org}/${slug}`, () => loadCases(org, slug));
  const jobs = useResource<JobsData>(`overview-jobs:${org}/${slug}`, async () => {
    const [rows, own] = await Promise.all([platformApi.projectJobs(org, slug), apiClient.listOwnJobs({ limit: 100 }).catch(() => null)]);
    return { rows, mine: own ? new Set(own.jobs.map((job) => job.id)) : null };
  });
  const studies = useResource(`overview-studies:${org}/${slug}`, () => loadStudies(org, slug, RECENT));
  const reports = useResource(`overview-reports:${org}/${slug}`, () => loadReports(org, slug));

  const loaded = [cases, jobs, studies, reports].every((item) => item.status === 'ready');
  const empty = loaded
    && (cases.data?.length ?? 0) === 0 && (jobs.data?.rows.length ?? 0) === 0
    && (studies.data?.length ?? 0) === 0 && (reports.data?.reports.length ?? 0) === 0;
  const sealed = [cases, studies, reports].every((item) => item.status === 'ready')
    ? integrityOf({ cases: cases.data, studies: studies.data, reports: reports.data?.reports })
    : null;

  const header = (
    <>
      <div className="proj-title-row">
        <div className="proj-title">
          <span className="proj-title-line">
            <h1>{project.name}</h1>
            <VisibilityChip visibility={project.visibility} />
            <RoleChip role={role} title={roleTitle} />
          </span>
          <p>{project.description || 'No description yet.'}</p>
        </div>
        <div className="proj-actions">
          <RoleAction allowed={canCreate} to={`${root}/cases`} variant="primary">New case</RoleAction>
          <RoleAction allowed={canCreate} to={`${root}/jobs/new`} variant="secondary">Run</RoleAction>
          <RoleAction allowed={canCreate} to={`${root}/studies/new`} variant="secondary">New study</RoleAction>
          <RoleAction allowed={canCreate} to={`${root}/reports`} variant="secondary">New report</RoleAction>
          <Action to={`${root}/workbench`} variant="secondary">Workbench</Action>
          <Action to={`${root}/package`} variant="secondary">Export package</Action>
        </div>
      </div>
      {!canCreate && <small className="org-muted">You’re a VIEWER: you can read everything here and export the package; creating needs MEMBER.</small>}
    </>
  );

  return (
    <ProjectFrame organization={organization} project={project} section="overview" header={header}>
      {empty && <GetStarted root={root} canCreate={canCreate} />}
      {sealed && !empty && <IntegrityStrip items={sealed} />}
      {!empty && (
        <div className="proj-grid">
          <CasesCard root={root} resource={cases} />
          <JobsCard root={root} resource={jobs} platformAdmin={isAdmin} />
          <StudiesCard root={root} resource={studies} />
          <ReportsCard root={root} resource={reports} />
        </div>
      )}
    </ProjectFrame>
  );
}

/** A project (`proj-overview`, `/app/:org/:project`): sealed versus draft, cases, jobs, studies and reports, each card on its own. */
export function ProjectOverview() {
  const { context, orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  const { isAdmin } = useAuth();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' : null);
  return (
    <OverviewBody
      organization={organization}
      project={project}
      canCreate={access.canCreate}
      role={role}
      roleTitle={roleSource(organization, context.organizations).text}
    />
  );
}
