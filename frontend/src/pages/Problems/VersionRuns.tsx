import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { runsApi } from '../../api/runs';
import type { Job, Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { problemPath } from '../../routes/paths/problems';
import { runPath } from '../../routes/paths/runs';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { StatusChip } from '../Runs/parts';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { RouteProblemContent } from './useRouteProblem';

/** The Runs tab of the problem page: the organization's runs of a version of this problem, newest first, each linking to its page. */
export function VersionRuns({ organization, content, runHref, canCreate }: {
  organization: Organization; content: RouteProblemContent; runHref: string | null; canCreate: boolean;
}) {
  const { item, revisions } = content;
  const org = organization.slug;
  const versionOf = new Map(revisions.map((revision) => [revision.id, revision.revision]));
  const runs = useResource<Job[]>(`problem-runs:${org}/${item.slug}:${revisions.map((revision) => revision.id).join(',')}`, async () => {
    // The gateway filters the organization's runs by problem; a run names the revision it ran.
    const { runs: rows } = await runsApi.list(org, { problem: item.slug, limit: 200 });
    return rows
      .filter((job) => (job.revision ? versionOf.has(job.revision.id) : false))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
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
          action={canCreate && runHref ? <Action to={runHref} variant="primary">Start a run</Action> : undefined}
        >
          The runs of a version of {item.name} are listed here.
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
            {data.map((job, index) => {
              const revision = job.revision ? versionOf.get(job.revision.id) : undefined;
              const label = `Run ${data.length - index}`;
              return (
                <tr key={job.id}>
                  <td><Link to={runPath(org, job.id)} viewTransition>{label}</Link></td>
                  <td>{revision !== undefined ? <Link to={problemPath(org, item.slug, undefined, { version: revision })} viewTransition>Version {revision}</Link> : '—'}</td>
                  <td>{job.engine_id}</td>
                  <td><StatusChip status={job.status} termination={job.termination} /></td>
                  <td>{formatDateTime(job.created_at) ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
