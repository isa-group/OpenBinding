// Pattern only, after SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the Runs tab of the problem page, the organization's runs of a version of this problem, in SPHERE's card layout
// with the core data table.

import { FiPlay } from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { runsApi } from '../../../../api/runs';
import type { Job } from '../../../../api/platform';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { EmptyState } from '../../../core/components/empty-state';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { problemPath } from '../../../../routes/paths/problems';
import { runPath } from '../../../../routes/paths/runs';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { StatusChip } from '../../../run/components/run-status';
import type { ProblemContent } from '../../types';

/** The Runs tab of the problem page: the organization's runs of a version of this problem, newest first, each linking to its page. */
export default function RunsTab({
  org,
  content,
  runHref,
  canCreate,
}: {
  org: string;
  content: ProblemContent;
  runHref: string | null;
  canCreate: boolean;
}) {
  const { item, revisions } = content;
  const versionOf = new Map(revisions.map(revision => [revision.id, revision.revision]));
  const runs = useResource<Job[]>(
    `problem-runs:${org}/${item.slug}:${revisions.map(revision => revision.id).join(',')}`,
    async () => {
      // The gateway filters the organization's runs by problem; a run names the revision it ran.
      const { runs: rows } = await runsApi.list(org, { problem: item.slug, limit: 200 });
      return rows
        .filter(job => (job.revision ? versionOf.has(job.revision.id) : false))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
  );
  const data = runs.data ?? runs.stale;
  const failure = runs.status === 'error' ? classifyAuthError(runs.error) : null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="pr-runs">
      <h2 id="pr-runs" className="text-lg font-medium text-tp-ink">
        Runs
      </h2>
      {runs.status === 'loading' && !data && (
        <div role="status" aria-busy="true">
          <span className="sr-only">Reading the runs…</span>
          <Skeleton variant="panel" />
        </div>
      )}
      {failure && !data && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={runs.reload}>
              Retry
            </Action>
          }
        >
          The runs can’t be loaded right now{marker(failure)}.
        </Notice>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={<FiPlay />}
          title="No runs of this problem yet"
          dashed
          action={
            canCreate && runHref ? (
              <Action to={runHref} variant="primary">
                Start a run
              </Action>
            ) : undefined
          }
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
                  <td>
                    <Link
                      to={runPath(org, job.id)}
                      className="cursor-pointer text-tp-accent hover:underline"
                    >
                      {label}
                    </Link>
                  </td>
                  <td>
                    {revision !== undefined ? (
                      <Link
                        to={problemPath(org, item.slug, undefined, { version: revision })}
                        className="cursor-pointer text-tp-accent hover:underline"
                      >
                        Version {revision}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{job.engine_id}</td>
                  <td>
                    <StatusChip status={job.status} termination={job.termination} />
                  </td>
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
