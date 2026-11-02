import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { jobsApi } from '../../api/jobs';
import { platformApi, type Job, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { problemPath } from '../../routes/paths/problems';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { StatusChip } from '../Jobs/parts';
import { classifyAuthError, marker } from './caseErrors';
import type { RouteCaseContent } from './useRouteCase';

/** How many of the project's newest runs are matched against the problem; each match asks the gateway for the run's compiled snapshot. */
const RUNS_READ = 30;

interface ProblemRun {
  job: Job;
  revision: number;
}

/** The Runs tab of the problem page: the runs that started from a revision of this problem, newest first, each linking to its page. */
// [impl->req~frontend-nav-problem-page~1]
export function VersionRuns({ organization, project, content, canCreate }: {
  organization: Organization; project: Project; content: RouteCaseContent; canCreate: boolean;
}) {
  const { item, revisions } = content;
  const root = `/app/${organization.slug}/${project.slug}`;
  const runs = useResource<ProblemRun[]>(`problem-runs:${organization.slug}/${project.slug}/${item.slug}:${revisions.map((revision) => revision.id).join(',')}`, async () => {
    const byInstance = new Map(revisions.flatMap((revision) => (revision.source_snapshot_id ? [[revision.source_snapshot_id, revision.revision] as const] : [])));
    if (byInstance.size === 0) return [];
    const newest = [...await platformApi.projectJobs(organization.slug, project.slug)]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, RUNS_READ);
    // A run names no problem: its compiled snapshot does, when the account may read it.
    const found = await Promise.all(newest.map(async (job) => {
      const instance = await jobsApi.instance(job.id).catch(() => null);
      const revision = instance ? byInstance.get(instance.id) : undefined;
      return revision === undefined ? null : { job, revision };
    }));
    return found.filter((row): row is ProblemRun => row !== null);
  });
  const data = runs.data ?? runs.stale;
  const failure = runs.status === 'error' ? classifyAuthError(runs.error) : null;

  return (
    <section className="org-section" aria-labelledby="pr-runs">
      <h2 id="pr-runs">Runs</h2>
      {runs.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Reading the runs…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={runs.reload}>Retry</Action>}>
          The runs can’t be loaded right now{marker(failure)}.
        </Notice>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={<Play />}
          title="No runs of this problem yet"
          dashed
          action={canCreate ? <Action to={`${root}/runs/new?case=${encodeURIComponent(item.slug)}`} variant="primary">Start a run</Action> : undefined}
        >
          Runs you can open that started from a version of {item.name} are listed here.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <DataTable label="Runs of the problem" minWidth={640}>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Version</th>
              <th scope="col">Engine</th>
              <th scope="col">Status</th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {data.map(({ job, revision }) => (
              <tr key={job.id}>
                <td><Link to={`${root}/runs/${encodeURIComponent(job.id)}`} viewTransition>Run {job.id.slice(0, 8)}</Link></td>
                <td><Link to={problemPath(root, item.slug, undefined, { version: revision })} viewTransition>Version {revision}</Link></td>
                <td>{job.engine_id}</td>
                <td><StatusChip status={job.status} termination={job.termination} /></td>
                <td>{formatDateTime(job.created_at) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {data && <p className="org-muted">Only the {RUNS_READ} newest runs of the project are checked, and a run you can’t open isn’t listed.</p>}
    </section>
  );
}
