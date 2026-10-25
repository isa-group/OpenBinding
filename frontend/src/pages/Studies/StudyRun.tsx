import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { platformApi, type StudyCell } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { CellTable, RunHeatmap } from './CellViews';
import { CellBar, StateChip, StudyFrame, StudyGate } from './parts';
import { StudyScope, type StudyScopeValue } from './StudyScope';
import { loadRun } from './runData';
import { MAX_GRID_CELLS, RUNTIME, breakdownText, countStates, isActiveState, isRetryable, measureLabel, measuresOf, metricsOf, plural } from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';
import { POLL_MS, usePolling } from './usePolling';
import { useRevisionIndex } from './useRevisionIndex';

type Outcome =
  | { tone: 'success'; text: string }
  | { tone: 'error'; refusal: Refusal };

function RunBody({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, project, access, root } = scope;
  const org = organization.slug;
  const slug = project.slug;
  const studyPath = `${root}/studies/${encodeURIComponent(study.slug)}`;
  const runPath = `${studyPath}/runs/${runId}`;
  const { index } = useRevisionIndex(org, slug);
  const resource = useResource(`run:${study.id}/${runId}`, () => loadRun(org, slug, study.slug, runId));
  const [auto, setAuto] = useState(true);
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry-all' | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const data = resource.data ?? resource.stale;
  const reload = resource.reload;
  const live = Boolean(data && isActiveState(data.run.state));
  usePolling(live && auto, reload, POLL_MS);

  if (resource.status === 'error' && !data) {
    const problem = classifyAuthError(resource.error);
    if (problem.status === 403) {
      return (
        <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: 'Run' }]}>
          <Notice tone="warning" title={`This API key can’t show this run${marker(problem)}`}>
            {problem.message || 'The key isn’t allowed to use one of the engines this run pinned.'} Use a browser session, or a key whose engine access includes every engine of the study.
          </Notice>
        </StudyFrame>
      );
    }
    if (problem.status === 404) {
      return (
        <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: 'Run' }]} width="lg">
          <StudyGate title="Run not found" action={<Action to={studyPath} variant="primary">Back to the study</Action>}>
            This run doesn’t exist (404), or it isn’t one of {study.name}’s runs.
          </StudyGate>
        </StudyFrame>
      );
    }
    return (
      <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: 'Run' }]}>
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>The run couldn’t be loaded{marker(problem)}.</Notice>
      </StudyFrame>
    );
  }

  if (!data) {
    return (
      <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: 'Run' }]}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the run…</span><Skeleton variant="panel" /></div>
      </StudyFrame>
    );
  }

  const { run, cells } = data;
  const measures = measuresOf(cells);
  const measure = measureChoice && measures.includes(measureChoice) ? measureChoice : measures[0] ?? RUNTIME;
  const counts = countStates(cells);
  const retryable = cells.filter((cell) => isRetryable(cell.state));
  const feasible = cells.filter((cell) => cell.state === 'completed' && metricsOf(cell).feasible === true).length;
  const finishedAt = formatDateTime(run.finished_at);

  const cancel = async () => {
    setBusy('cancel');
    setOutcome(null);
    try {
      await platformApi.cancelStudyRun(org, slug, study.slug, run.id);
      setOutcome({ tone: 'success', text: 'Run cancelled. Cells that hadn’t finished are cancelled; you can retry them.' });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'cancel') });
    } finally {
      setBusy(null);
    }
  };

  const retryOne = async (cell: StudyCell) => {
    setRetrying(cell.id);
    setOutcome(null);
    try {
      await platformApi.retryStudyCell(org, slug, study.slug, run.id, cell.id);
      setOutcome({ tone: 'success', text: `Cell ${cell.ordinal} queued again.` });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'retry') });
    } finally {
      setRetrying(null);
    }
  };

  const retryAll = async () => {
    setBusy('retry-all');
    setOutcome(null);
    let done = 0;
    try {
      for (const cell of retryable) {
        setRetrying(cell.id);
        await platformApi.retryStudyCell(org, slug, study.slug, run.id, cell.id);
        done += 1;
      }
      setOutcome({ tone: 'success', text: `${plural(done, 'cell')} queued again.` });
    } catch (caught) {
      const refusal = studyRefusal(caught, 'retry');
      setOutcome({ tone: 'error', refusal: done > 0 ? { ...refusal, text: `${plural(done, 'cell')} queued again before this stopped. ${refusal.text}` } : refusal });
    } finally {
      setRetrying(null);
      setBusy(null);
      reload();
    }
  };

  return (
    <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: `Run #${run.run_number}` }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>Run #{run.run_number}</h1>
            <StateChip state={run.state} />
          </div>
          <p>
            {formatDateTime(run.created_at) ?? '—'}{finishedAt ? ` → ${finishedAt}` : ''} · matrix <span title={run.matrix_digest}>{shortDigest(run.matrix_digest)}</span>
          </p>
        </div>
        {/* [impl->req~frontend-retire-reports-entry-points-removed~1] */}
        <div className="proj-actions">
          <Action to={`${runPath}/analytics`} variant="primary">Compare results</Action>
          {access.canCreate && isActiveState(run.state) && (
            <Action variant="danger-outline" busy={busy === 'cancel'} disabled={busy !== null} onClick={() => void cancel()}>Cancel run</Action>
          )}
        </div>
      </header>

      {outcome?.tone === 'success' && (
        <Notice tone="success">{outcome.text}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
      {resource.status === 'error' && data && (
        <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>The latest reading failed, so this shows what was last known.</Notice>
      )}

      {cells.length === 0 ? (
        <Notice tone="warning">This run has no cells, which shouldn’t happen. Its matrix fingerprint ({shortDigest(run.matrix_digest)}) is still recorded; contact an administrator.</Notice>
      ) : (
        <>
          <section className="st-progress" aria-label="Progress of the run">
            <CellBar cells={cells} size="lg" legend note={counts.completed ? `${feasible} of ${counts.completed} completed are feasible` : undefined} />
            <div className="st-progress-side">
              {live ? (
                <label className="st-check">
                  <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
                  Keep updating
                </label>
              ) : <span className="job-feed"><span className="job-feed-dot" aria-hidden="true" />Finished · not live</span>}
              {live && auto && <span className="job-feed is-live"><span className="job-feed-dot" aria-hidden="true" />Live · every {POLL_MS / 1000} s</span>}
              {access.canCreate && retryable.length > 0 && (
                <Action variant="secondary" size="sm" busy={busy === 'retry-all'} disabled={busy !== null || retrying !== null} onClick={() => void retryAll()}>
                  Retry {retryable.length} unfinished {retryable.length === 1 ? 'cell' : 'cells'}
                </Action>
              )}
            </div>
          </section>

          {cells.length <= MAX_GRID_CELLS ? (
            <section className="st-card" aria-labelledby="st-heat-title">
              <div className="st-card-head">
                <h2 id="st-heat-title">Cells · {measureLabel(measure).toLowerCase()} (lower is better)</h2>
                {measures.length > 1 && (
                  <label className="job-select">
                    <span>Colour by</span>
                    <select aria-label="Colour by" value={measure} onChange={(event) => setMeasureChoice(event.target.value)}>
                      {measures.map((name) => <option key={name} value={name}>{measureLabel(name)}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <RunHeatmap cells={cells} measure={measure} where={{ runPath, index }} />
              <span className="st-scale">Better <span className="st-scale-bar" aria-hidden="true" /> Worse</span>
              <small className="org-muted">{breakdownText(cells)}. Each square opens its cell.</small>
            </section>
          ) : (
            <Notice tone="info">This run has {cells.length.toLocaleString('en-US')} cells, too many to draw as squares. The table below lists them all, a page at a time.</Notice>
          )}

          <CellTable cells={cells} where={{ runPath, index }} canRetry={access.canCreate} retrying={retrying} onRetry={(cell) => void retryOne(cell)} />
        </>
      )}
    </StudyFrame>
  );
}

/** One execution of a study (`study-run`, `/app/:org/:project/studies/:study/runs/:run`): every cell with its state, kept up to date while it runs. */
export function StudyRun() {
  const { run = '' } = useParams();
  return <StudyScope>{(scope) => <RunBody key={`${scope.study.id}/${run}`} scope={scope} runId={run} />}</StudyScope>;
}
