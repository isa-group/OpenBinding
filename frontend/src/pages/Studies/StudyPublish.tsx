import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { saveBytes } from '../Project/download';
import { cellsCsv } from './analyticsModel';
import { loadRun } from './runData';
import type { StudyScopeValue } from './StudyScope';
import { measuresOf } from './studiesModel';
import { useRevisionIndex } from './useRevisionIndex';

/** The Publish tab of the study page: the CSV export of the study run `runId` and the way to the project's published results. */
export function RunPublish({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, project, root } = scope;
  const { index } = useRevisionIndex(organization.slug, project.slug);
  const loaded = useResource(`publish-run:${study.id}/${runId}`, () => (runId ? loadRun(organization.slug, project.slug, study.slug, runId) : Promise.resolve(undefined)));
  const data = loaded.data ?? loaded.stale;
  const failure = loaded.status === 'error' && !data ? classifyAuthError(loaded.error) : null;

  const exportCsv = () => {
    if (!data) return;
    const text = cellsCsv(data.cells, measuresOf(data.cells), index);
    saveBytes(new TextEncoder().encode(text).slice().buffer, `${study.slug}-run-${data.run.run_number}-cells.csv`, 'text/csv');
  };

  return (
    <>
      <section className="st-card" aria-labelledby="st-csv-title">
        <h2 id="st-csv-title">Export the cells</h2>
        {!runId && <p className="org-muted">This study has no run yet, so there is nothing to export.</p>}
        {runId && loaded.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Loading the run…</span><Skeleton variant="tile" /></div>}
        {failure && (
          <Notice tone={failure.status === 404 ? 'warning' : 'error'} action={failure.status === 404 ? undefined : <Action variant="secondary" size="sm" onClick={loaded.reload}>Retry</Action>}>
            {failure.status === 404 ? `No such run in ${project.name} (404).` : `The run couldn’t be loaded${marker(failure)}.`}
          </Notice>
        )}
        {data && (
          <>
            <p className="org-muted">Every cell of run #{data.run.run_number} with its engine, seed, state, objectives and fingerprint, as one CSV file.</p>
            <div>
              <Action variant="secondary" onClick={exportCsv}>Export CSV</Action>
            </div>
          </>
        )}
      </section>

      <section className="st-card" aria-labelledby="st-published-title">
        <h2 id="st-published-title">Published results</h2>
        <p className="org-muted">Results that a project publishes for others to cite are listed on the project’s Published tab.</p>
        <div>
          <Action to={`${root}/published`} variant="secondary">Published results of this project</Action>
        </div>
      </section>
    </>
  );
}
