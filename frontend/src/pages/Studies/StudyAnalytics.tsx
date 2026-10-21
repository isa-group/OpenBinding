import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { platformApi, type BindingSpaceAnalytics, type Report, type StudyCell } from '../../api/platform';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { parseBindingSpace, toSuperscript } from '../../components/BindingSpaceBadge/bindingSpace';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { DataTable } from '../../components/ui/DataTable';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { saveBytes } from '../Project/download';
import { DistributionPlot, RankingTable, SeedTable, TimeBars, TradeoffPlot } from './AnalyticsCharts';
import { cellsCsv, engineRows, measureTitle, scatterOf, seedGroups, spreadOf } from './analyticsModel';
import { StateChip, StudyFrame, StudyGate } from './parts';
import { createRunReport, reportsOfRun } from './reportActions';
import { loadRun } from './runData';
import { StudyScope, type StudyScopeValue } from './StudyScope';
import { RUNTIME, countStates, engineKeyOf, enginesOf, formatMeasure, formatSeconds, measureLabel, measuresOf, metricsOf, plural, revisionLabel } from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';
import { useRevisionIndex } from './useRevisionIndex';

type Outcome =
  | { tone: 'success'; text: string; follow?: { to: string; label: string } }
  | { tone: 'error'; refusal: Refusal };

function Counter({ value, label, tone }: { value: string; label: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="st-counter">
      <b className={tone ? `is-${tone}` : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** What the run's analytics say about the size of the problem, kept from the earlier analytics screen. */
function SpacePanel({ space }: { space: BindingSpaceAnalytics }) {
  const several = (space.cases?.length ?? 0) > 1;
  return (
    <section className="st-card" aria-labelledby="st-space-title">
      <div className="st-card-head">
        <h2 id="st-space-title">{several ? 'Largest search space' : 'Search space'}</h2>
        <small className="org-muted">
          {several ? `${space.cases?.length} case revisions · largest cardinality` : space.case_name ? `${space.case_name} · revision ${space.revision}` : 'Analyzed instance'}
          {' · '}{parseBindingSpace(space.cardinality).formatted} ≈ 10{toSuperscript(Math.round(space.log10))} combinations, {plural(space.tasks, 'task')}
        </small>
      </div>
      <BindingSpaceBadge cardinality={space.cardinality} breakdown={space.breakdown} variant="card" />
      {several && space.cases && (
        <ul className="st-space-cases" aria-label="Search space of each case revision">
          {space.cases.map((item) => (
            <li key={item.id}>
              <span><strong>{item.name}</strong><small>revision {item.revision} · {plural(item.tasks, 'task')}</small></span>
              <BindingSpaceBadge cardinality={item.cardinality} breakdown={item.breakdown} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The solutions of one cell's job, on request: the decision workspace the earlier analytics screen opened by default. */
function CellSolutions({ cells, index }: { cells: readonly StudyCell[]; index: ReturnType<typeof useRevisionIndex>['index'] }) {
  const withJob = cells.filter((cell) => cell.job_id && cell.state === 'completed');
  const [picked, setPicked] = useState('');
  const [asked, setAsked] = useState('');
  const chosen = withJob.some((cell) => cell.job_id === picked) ? picked : withJob[0]?.job_id ?? '';
  const result = useResource(`explore:${asked}`, () => (asked ? apiClient.getJobStatus(asked).then((job) => job.result ?? null) : Promise.resolve(null)));
  if (withJob.length === 0) return null;
  const failure = result.status === 'error' ? classifyAuthError(result.error) : null;
  return (
    <section className="st-card" aria-labelledby="st-explore-title">
      <h2 id="st-explore-title">Explore the solutions of one cell</h2>
      <p className="org-muted">Choose one execution to keep its instance, objective and normalization together. Different cases are never pooled into one front.</p>
      <div className="st-explore-pick">
        <label className="job-select">
          <span>Cell</span>
          <select aria-label="Analysis study cell" value={chosen} onChange={(event) => { setPicked(event.target.value); setAsked(''); }}>
            {withJob.map((cell) => (
              <option key={cell.id} value={cell.job_id ?? ''}>
                Cell {cell.ordinal} · {revisionLabel(index, cell.binding_case_revision_id, true)} · {cell.engine_ref.name} · seed {cell.seed}
              </option>
            ))}
          </select>
        </label>
        <Action variant="secondary" size="sm" disabled={!chosen || asked === chosen} busy={Boolean(asked) && result.status === 'loading'} onClick={() => setAsked(chosen)}>Load the solutions</Action>
      </div>
      {failure && <Notice tone="error">{failure.status === 404 ? 'That job opens only for whoever launched it' : 'The solutions couldn’t be loaded'}{marker(failure)}.</Notice>}
      {asked && result.status === 'ready' && result.data && <BindingAnalysis result={result.data} jobId={asked} />}
      {asked && result.status === 'ready' && !result.data && <p className="org-muted">That job has no stored result.</p>}
    </section>
  );
}

function AnalyticsBody({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, project, access, root } = scope;
  const org = organization.slug;
  const slug = project.slug;
  const studyPath = `${root}/studies/${encodeURIComponent(study.slug)}`;
  const runPath = `${studyPath}/runs/${runId}`;
  const { index } = useRevisionIndex(org, slug);
  const analytics = useResource(`analytics:${runId}`, () => platformApi.analytics(org, slug, study.slug, runId));
  const loaded = useResource(`analytics-run:${study.id}/${runId}`, () => loadRun(org, slug, study.slug, runId));
  const reports = useResource<Report[]>(`analytics-reports:${runId}`, () => platformApi.reports(org, slug).catch(() => []));
  const [engine, setEngine] = useState('');
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [caseChoice, setCaseChoice] = useState('');
  const [xChoice, setXChoice] = useState<string | null>(null);
  const [yChoice, setYChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  const run = loaded.data?.run ?? loaded.stale?.run;
  const trail = (last: string) => [{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: `Run #${run?.run_number ?? '…'}`, to: runPath }, { label: last }];
  const summary = analytics.data ?? analytics.stale;
  const data = loaded.data ?? loaded.stale;

  const failed = analytics.status === 'error' ? analytics.error : loaded.status === 'error' ? loaded.error : null;
  if (failed && (!summary || !data)) {
    const problem = classifyAuthError(failed);
    return (
      <StudyFrame organization={organization} project={project} trail={trail('Compare results')} width={problem.status === 404 ? 'lg' : 'wide'}>
        {problem.status === 404 ? (
          <StudyGate title="Run not found" action={<Action to={studyPath} variant="primary">Back to the study</Action>}>No such run in {project.name} (404).</StudyGate>
        ) : problem.status === 403 ? (
          <Notice tone="warning" title={`This API key can’t show these results${marker(problem)}`}>The key isn’t allowed to use one of the engines this run pinned.</Notice>
        ) : (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => { analytics.reload(); loaded.reload(); }}>Retry</Action>}>Analytics couldn’t be loaded{marker(problem)}.</Notice>
        )}
      </StudyFrame>
    );
  }
  if (!summary || !data) {
    return (
      <StudyFrame organization={organization} project={project} trail={trail('Compare results')}>
        <div className="st-skeletons" role="status" aria-busy="true"><span className="sr-only">Loading the analytics…</span><Skeleton variant="panel" /><Skeleton variant="panel" /></div>
      </StudyFrame>
    );
  }

  const allCells = data.cells;
  const engines = enginesOf(allCells);
  const cells = engine ? allCells.filter((cell) => engineKeyOf(cell.engine_ref) === engine) : allCells;
  const measures = measuresOf(allCells);
  const objectives = measures.filter((name) => name !== RUNTIME);
  const measure = measureChoice && measures.includes(measureChoice) ? measureChoice : measures[0] ?? RUNTIME;
  const completed = cells.filter((cell) => cell.state === 'completed');
  const rows = engineRows(cells, measure);
  const counts = countStates(allCells);
  const draft = reportsOfRun(reports.data ?? reports.stale ?? [], data.run)[0];
  const median = spreadOf(summary.runtimes_s)?.median;

  const caseIds = [...new Set(completed.map((cell) => cell.binding_case_revision_id))];
  const scatterCase = caseIds.includes(caseChoice) ? caseChoice : caseIds[0] ?? '';
  const xName = xChoice && objectives.includes(xChoice) ? xChoice : objectives[0] ?? '';
  const yName = yChoice && objectives.includes(yChoice) && yChoice !== xName ? yChoice : objectives.find((name) => name !== xName) ?? '';
  const points = objectives.length >= 2 ? scatterOf(cells, scatterCase, xName, yName) : [];
  const groups = seedGroups(cells, measure, index).filter((group) => group.seeds.length > 1);

  const exportCsv = () => {
    const text = cellsCsv(allCells, measures, index);
    saveBytes(new TextEncoder().encode(text).slice().buffer, `${study.slug}-run-${data.run.run_number}-cells.csv`, 'text/csv');
  };

  const makeReport = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const made = await createRunReport(org, slug, study, data.run);
      setOutcome({ tone: 'success', text: 'Draft report created from this run.', follow: { to: `${root}/reports/${encodeURIComponent(made.slug)}`, label: 'Open the report' } });
      reports.reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'report') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudyFrame organization={organization} project={project} trail={trail('Compare results')}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Compare results · run #{data.run.run_number}</h1>
          <p>Only what the run recorded. Nothing here is estimated: lower is better for every objective.</p>
        </div>
        <div className="proj-actions">
          <Action to="/app/analysis" variant="secondary">Weigh trade-offs</Action>
          {access.canCreate && (draft
            ? <Action to={`${root}/reports/${encodeURIComponent(draft.slug)}`} variant="secondary">Open the report</Action>
            : <Action variant="secondary" busy={busy} onClick={() => void makeReport()}>Create a report</Action>)}
          <Action variant="secondary" onClick={exportCsv}>Export CSV</Action>
        </div>
      </header>

      {outcome?.tone === 'success' && (
        <Notice tone="success" action={outcome.follow ? <Action to={outcome.follow.to} variant="link" size="sm">{outcome.follow.label}</Action> : undefined}>{outcome.text}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}

      <div className="st-counters" aria-label="Counts of the run">
        <Counter value={String(allCells.length)} label="cells" />
        <Counter value={String(counts.completed ?? 0)} label="completed" tone="ok" />
        <Counter value={String(counts.failed ?? 0)} label="failed" tone={counts.failed ? 'bad' : undefined} />
        <Counter value={String(summary.feasible)} label="feasible" tone="ok" />
        <Counter value={String(summary.infeasible)} label="infeasible" />
        <Counter value={median === undefined ? '—' : formatSeconds(median)} label="median time" />
      </div>

      {completed.length === 0 && engine === '' ? (
        <div className="st-empty-card">
          No completed cells yet, so there’s nothing to chart. Cells fail when an engine doesn’t answer, or are cancelled before running.
          <span><StateChip state={data.run.state} /> <Link to={runPath} viewTransition>Back to the run</Link></span>
        </div>
      ) : (
        <>
          <div className="st-filters">
            {engines.length > 1 && (
              <FilterPills
                ariaLabel="Engine"
                value={engine}
                onChange={setEngine}
                options={[{ id: '', label: engines.length === 2 ? 'Both engines' : 'All engines' }, ...engines.map((item) => ({ id: item.key, label: item.label }))]}
              />
            )}
            {measures.length > 1 && (
              <label className="job-select">
                <span>Measure</span>
                <select aria-label="Measure" value={measure} onChange={(event) => setMeasureChoice(event.target.value)}>
                  {measures.map((name) => <option key={name} value={name}>{measureLabel(name)}</option>)}
                </select>
              </label>
            )}
          </div>

          <div className="st-charts">
            <section className="st-card" aria-labelledby="st-dist-title">
              <div className="st-card-head">
                <h2 id="st-dist-title">{measureTitle(measure)}, per engine</h2>
                <small className="org-muted">{measure === RUNTIME ? 'seconds' : 'objective'} · lower is better</small>
              </div>
              <DistributionPlot rows={rows} measure={measure} />
            </section>

            <section className="st-card" aria-labelledby="st-time-title">
              <h2 id="st-time-title">Time taken per cell</h2>
              <TimeBars cells={cells} rows={rows} />
            </section>

            <section className="st-card" aria-labelledby="st-pareto-title">
              <div className="st-card-head">
                <h2 id="st-pareto-title">Best trade-offs (Pareto)</h2>
              </div>
              {objectives.length < 2 ? (
                <p className="org-muted">A trade-off needs two objectives, and this run recorded {objectives.length === 1 ? 'one' : 'none'}.</p>
              ) : (
                <>
                  <div className="st-card-tools">
                    {caseIds.length > 1 && (
                      <label className="job-select">
                        <span>Case</span>
                        <select aria-label="Case" value={scatterCase} onChange={(event) => setCaseChoice(event.target.value)}>
                          {caseIds.map((id) => <option key={id} value={id}>{revisionLabel(index, id, true)}</option>)}
                        </select>
                      </label>
                    )}
                    {objectives.length > 2 && (
                      <>
                        <label className="job-select">
                          <span>Across</span>
                          <select aria-label="Across" value={xName} onChange={(event) => setXChoice(event.target.value)}>
                            {objectives.map((name) => <option key={name} value={name}>{measureLabel(name)}</option>)}
                          </select>
                        </label>
                        <label className="job-select">
                          <span>Up</span>
                          <select aria-label="Up" value={yName} onChange={(event) => setYChoice(event.target.value)}>
                            {objectives.filter((name) => name !== xName).map((name) => <option key={name} value={name}>{measureLabel(name)}</option>)}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                  {points.length === 0
                    ? <p className="org-muted">No completed cell of this case has both objectives.</p>
                    : <TradeoffPlot points={points} xName={xName} yName={yName} />}
                  {points.some((point) => point.front) && (
                    <p className="st-caption">
                      Best trade-offs: {points.filter((point) => point.front).sort((a, b) => a.x - b.x).map((point, position) => (
                        <span key={point.cell.id}>{position > 0 && '; '}<Link to={`${runPath}/cells/${point.cell.id}`} viewTransition>cell {point.cell.ordinal}</Link> ({formatMeasure(point.x)}, {formatMeasure(point.y)})</span>
                      ))}.
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="st-card st-wide" aria-labelledby="st-rank-title">
              <h2 id="st-rank-title">Engine ranking</h2>
              <RankingTable rows={rows} measure={measure} />
              <small className="org-muted">Ranked by the mean of {measureLabel(measure).toLowerCase()} over completed cells. Cases are pooled here; open one case in the trade-offs to compare like with like.</small>
            </section>

            <section className="st-card st-wide" aria-labelledby="st-seed-title">
              <h2 id="st-seed-title">Same inputs, different seed</h2>
              {groups.length === 0 ? <p className="org-muted">Each cell ran with a single seed, so there’s no seed-to-seed difference to show.</p> : <SeedTable groups={groups} measure={measure} runPath={runPath} />}
              {Object.keys(summary.stability).length > 0 && (
                <div className="stability-ledger st-stability" aria-label="Repeatability of each engine">
                  {Object.entries(summary.stability).map(([name, value]) => (
                    <div key={name}>
                      <span>{name}</span>
                      <meter min={0} max={1} value={value.repeatability}>{value.repeatability}</meter>
                      <strong>{Math.round(value.repeatability * 100)}%</strong>
                      <small>{value.distinct}/{value.samples} distinct</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {summary.binding_space && <SpacePanel space={summary.binding_space} />}
          <CellSolutions cells={allCells} index={index} />

          <section className="st-card" aria-labelledby="st-ledger-title">
            <div className="st-card-head">
              <h2 id="st-ledger-title">Every plotted cell</h2>
              <small className="org-muted" title={data.run.matrix_digest}>matrix {shortDigest(data.run.matrix_digest)}</small>
            </div>
            <DataTable label="Provenance of every cell" minWidth={760}>
              <thead>
                <tr>
                  <th scope="col">Cell</th>
                  <th scope="col">Engine · seed</th>
                  <th scope="col">State</th>
                  <th scope="col">Took</th>
                  <th scope="col">Fingerprint</th>
                </tr>
              </thead>
              <tbody>
                {cells.slice(0, 200).map((cell) => (
                  <tr key={cell.id}>
                    <td><Link to={`${runPath}/cells/${cell.id}`} viewTransition aria-label={`Open cell ${cell.ordinal}`}>#{cell.ordinal}</Link></td>
                    <td>{cell.engine_ref.name}<small className="org-muted">{cell.engine_ref.mode ?? cell.engine_ref.version} · seed {cell.seed}</small></td>
                    <td><StateChip state={cell.state} /></td>
                    <td>{formatSeconds(metricsOf(cell).runtimeSeconds)}</td>
                    <td><CopyField value={cell.fingerprint} label={`fingerprint of cell ${cell.ordinal}`} truncate /></td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {cells.length > 200 && <small className="org-muted">Showing the first 200 of {cells.length.toLocaleString('en-US')} cells; the CSV has them all.</small>}
            {formatDateTime(data.run.finished_at) && <small className="org-muted">Run finished {formatDateTime(data.run.finished_at)}.</small>}
          </section>
        </>
      )}
    </StudyFrame>
  );
}

/** The analytics of a run (`study-analytics`, `/app/:org/:project/studies/:study/runs/:run/analytics`): tables and charts that compare the engines. */
export function StudyAnalytics() {
  const { run = '' } = useParams();
  return <StudyScope>{(scope) => <AnalyticsBody key={`${scope.study.id}/${run}`} scope={scope} runId={run} />}</StudyScope>;
}
