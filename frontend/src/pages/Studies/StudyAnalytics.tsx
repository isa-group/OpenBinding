import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  platformApi,
  type BindingSpaceAnalytics,
  type StudyRunExportFormat,
} from '../../api/platform';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { parseBindingSpace, toSuperscript } from '../../components/BindingSpaceBadge/bindingSpace';
import { Action } from '../../modules/core/components/action-button';
import { CopyDigest } from './CopyDigest';
import { DataTable } from '../../modules/core/components/data-table';
import { FilterPills } from '../../modules/core/components/filter-pills';
import { Notice } from '../../modules/core/components/notice';
import { Skeleton } from '../../modules/core/components/skeleton';
import { studyRunLabel } from '../../shared/lib/identity';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import { saveBytes } from '../../features/workspace/download';
import {
  DistributionPlot,
  RankingTable,
  SeedTable,
  TimeBars,
  TradeoffPlot,
} from './AnalyticsCharts';
import { engineRows, measureTitle, scatterOf, seedGroups, spreadOf } from './analyticsModel';
import { ParetoFront } from './ParetoFront';
import { StateChip, StudyGate } from './parts';
import { loadRun } from './runData';
import type { StudyScopeValue } from './StudyScope';
import {
  RUNTIME,
  countStates,
  engineKeyOf,
  enginesOf,
  formatMeasure,
  formatSeconds,
  measureLabel,
  measuresOf,
  metricsOf,
  plural,
  revisionLabel,
  studyPageHref,
} from './studiesModel';
import { useRevisionIndex } from './useRevisionIndex';

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
          {several
            ? `${space.cases?.length} problem versions · largest cardinality`
            : space.case_name
              ? `${space.case_name} · version ${space.revision}`
              : 'Analyzed instance'}
          {' · '}
          {parseBindingSpace(space.cardinality).formatted} ≈ 10
          {toSuperscript(Math.round(space.log10))} combinations, {plural(space.tasks, 'task')}
        </small>
      </div>
      <BindingSpaceBadge
        cardinality={space.cardinality}
        breakdown={space.breakdown}
        variant="card"
      />
      {several && space.cases && (
        <ul className="st-space-cases" aria-label="Search space of each problem version">
          {space.cases.map(item => (
            <li key={item.id}>
              <span>
                <strong>{item.name}</strong>
                <small>
                  version {item.revision} · {plural(item.tasks, 'task')}
                </small>
              </span>
              <BindingSpaceBadge cardinality={item.cardinality} breakdown={item.breakdown} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Results tab of the study page: the analytics of the study run `runId`, its Pareto front, its cells and the gateway's export of them. */
export function RunResults({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, studyPath, access } = scope;
  const org = organization.slug;
  const cellHref = (cellId: string) =>
    studyPageHref(studyPath, 'results', { run: runId, cell: cellId });
  const { index } = useRevisionIndex(org);
  const analytics = useResource(`analytics:${runId}`, () =>
    platformApi.analytics(org, study.slug, runId)
  );
  const loaded = useResource(`analytics-run:${study.id}/${runId}`, () =>
    loadRun(org, study.slug, runId)
  );
  const [engine, setEngine] = useState('');
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [caseChoice, setCaseChoice] = useState('');
  const [xChoice, setXChoice] = useState<string | null>(null);
  const [yChoice, setYChoice] = useState<string | null>(null);
  const [exporting, setExporting] = useState<StudyRunExportFormat | null>(null);
  const [exportFailure, setExportFailure] = useState<string | null>(null);

  /** The gateway's export of the whole run, fetched with the session and saved under the name the gateway gives it. */
  const exportRun = async (format: StudyRunExportFormat) => {
    if (exporting) return;
    setExporting(format);
    setExportFailure(null);
    try {
      const file = await platformApi.exportStudyRun(org, study.slug, runId, format);
      saveBytes(file.bytes, file.fileName, file.mediaType);
    } catch (caught) {
      setExportFailure(
        `The ${format.toUpperCase()} export couldn’t be made${marker(classifyAuthError(caught))}.`
      );
    } finally {
      setExporting(null);
    }
  };

  const summary = analytics.data ?? analytics.stale;
  const data = loaded.data ?? loaded.stale;

  const failed =
    analytics.status === 'error'
      ? analytics.error
      : loaded.status === 'error'
        ? loaded.error
        : null;
  if (failed && (!summary || !data)) {
    const problem = classifyAuthError(failed);
    if (problem.status === 404) {
      return (
        <StudyGate
          title="Run not found"
          action={
            <Action to={studyPath} variant="primary">
              Back to the study
            </Action>
          }
        >
          No such run in this study (404).
        </StudyGate>
      );
    }
    if (problem.status === 403) {
      return (
        <Notice tone="warning" title={`This API key can’t show these results${marker(problem)}`}>
          The key isn’t allowed to use one of the engines this run pinned.
        </Notice>
      );
    }
    return (
      <Notice
        tone="error"
        action={
          <Action
            variant="secondary"
            size="sm"
            onClick={() => {
              analytics.reload();
              loaded.reload();
            }}
          >
            Retry
          </Action>
        }
      >
        Analytics couldn’t be loaded{marker(problem)}.
      </Notice>
    );
  }
  if (!summary || !data) {
    return (
      <div className="st-skeletons" role="status" aria-busy="true">
        <span className="sr-only">Loading the analytics…</span>
        <Skeleton variant="panel" />
        <Skeleton variant="panel" />
      </div>
    );
  }

  const allCells = data.cells;
  const engines = enginesOf(allCells);
  const cells = engine
    ? allCells.filter(cell => engineKeyOf(cell.engine_ref) === engine)
    : allCells;
  const measures = measuresOf(allCells);
  const objectives = measures.filter(name => name !== RUNTIME);
  const measure =
    measureChoice && measures.includes(measureChoice) ? measureChoice : (measures[0] ?? RUNTIME);
  const completed = cells.filter(cell => cell.state === 'completed');
  const rows = engineRows(cells, measure);
  const counts = countStates(allCells);
  const median = spreadOf(summary.runtimes_s)?.median;

  const caseIds = [...new Set(completed.map(cell => cell.binding_case_revision_id))];
  const scatterCase = caseIds.includes(caseChoice) ? caseChoice : (caseIds[0] ?? '');
  const xName = xChoice && objectives.includes(xChoice) ? xChoice : (objectives[0] ?? '');
  const yName =
    yChoice && objectives.includes(yChoice) && yChoice !== xName
      ? yChoice
      : (objectives.find(name => name !== xName) ?? '');
  const fronts = summary.pareto ?? [];
  // The cells on the gateway's fronts of the plotted version, in the gateway's order; the chart only marks them.
  const frontOrder = [
    ...new Set(
      fronts
        .filter(front => front.revision_id === scatterCase)
        .flatMap(front => front.points.map(point => point.cell_id))
    ),
  ];
  const points =
    objectives.length >= 2 ? scatterOf(cells, scatterCase, xName, yName, new Set(frontOrder)) : [];
  const onFront = frontOrder.flatMap(cellId => points.filter(point => point.cell.id === cellId));
  const groups = seedGroups(cells, measure, index).filter(group => group.seeds.length > 1);

  return (
    <>
      <header className="proj-title-row">
        <div className="proj-title">
          <h2>Compare results · run #{data.run.run_number}</h2>
          <p>
            Only what the run recorded. Nothing here is estimated: lower is better for every
            objective.
          </p>
        </div>
        <div className="proj-actions">
          <Action
            variant="secondary"
            busy={exporting === 'csv'}
            disabled={exporting !== null && exporting !== 'csv'}
            onClick={() => void exportRun('csv')}
          >
            Export CSV
          </Action>
          <Action
            variant="secondary"
            busy={exporting === 'json'}
            disabled={exporting !== null && exporting !== 'json'}
            onClick={() => void exportRun('json')}
          >
            Export JSON
          </Action>
        </div>
      </header>
      {exportFailure && <Notice tone="error">{exportFailure}</Notice>}

      <div className="st-counters" aria-label="Counts of the run">
        <Counter value={String(allCells.length)} label="cells" />
        <Counter value={String(counts.completed ?? 0)} label="completed" tone="ok" />
        <Counter
          value={String(counts.failed ?? 0)}
          label="failed"
          tone={counts.failed ? 'bad' : undefined}
        />
        <Counter value={String(summary.feasible)} label="feasible" tone="ok" />
        <Counter value={String(summary.infeasible)} label="infeasible" />
        <Counter value={median === undefined ? '—' : formatSeconds(median)} label="median time" />
      </div>

      {completed.length === 0 && engine === '' ? (
        <div className="st-empty-card">
          No completed cells yet, so there’s nothing to chart. Cells fail when an engine doesn’t
          answer, or are cancelled before running.
          <span>
            <StateChip state={data.run.state} />{' '}
            <Link to={studyPageHref(studyPath, 'progress', { run: runId })} viewTransition>
              Back to the run
            </Link>
          </span>
        </div>
      ) : (
        <>
          <div className="st-filters">
            {engines.length > 1 && (
              <FilterPills
                ariaLabel="Engine"
                value={engine}
                onChange={setEngine}
                options={[
                  { id: '', label: engines.length === 2 ? 'Both engines' : 'All engines' },
                  ...engines.map(item => ({ id: item.key, label: item.label })),
                ]}
              />
            )}
            {measures.length > 1 && (
              <label className="job-select">
                <span>Measure</span>
                <select
                  aria-label="Measure"
                  value={measure}
                  onChange={event => setMeasureChoice(event.target.value)}
                >
                  {measures.map(name => (
                    <option key={name} value={name}>
                      {measureLabel(name)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="st-charts">
            <section className="st-card" aria-labelledby="st-dist-title">
              <div className="st-card-head">
                <h2 id="st-dist-title">{measureTitle(measure)}, per engine</h2>
                <small className="org-muted">
                  {measure === RUNTIME ? 'seconds' : 'objective'} · lower is better
                </small>
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
                <p className="org-muted">
                  A trade-off needs two objectives, and this run recorded{' '}
                  {objectives.length === 1 ? 'one' : 'none'}.
                </p>
              ) : (
                <>
                  <div className="st-card-tools">
                    {caseIds.length > 1 && (
                      <label className="job-select">
                        <span>Problem</span>
                        <select
                          aria-label="Problem"
                          value={scatterCase}
                          onChange={event => setCaseChoice(event.target.value)}
                        >
                          {caseIds.map(id => (
                            <option key={id} value={id}>
                              {revisionLabel(index, id, true)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {objectives.length > 2 && (
                      <>
                        <label className="job-select">
                          <span>Across</span>
                          <select
                            aria-label="Across"
                            value={xName}
                            onChange={event => setXChoice(event.target.value)}
                          >
                            {objectives.map(name => (
                              <option key={name} value={name}>
                                {measureLabel(name)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="job-select">
                          <span>Up</span>
                          <select
                            aria-label="Up"
                            value={yName}
                            onChange={event => setYChoice(event.target.value)}
                          >
                            {objectives
                              .filter(name => name !== xName)
                              .map(name => (
                                <option key={name} value={name}>
                                  {measureLabel(name)}
                                </option>
                              ))}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                  {points.length === 0 ? (
                    <p className="org-muted">
                      No completed cell of this problem has both objectives.
                    </p>
                  ) : (
                    <TradeoffPlot points={points} xName={xName} yName={yName} />
                  )}
                  {onFront.length > 0 && (
                    <p className="st-caption">
                      Best trade-offs:{' '}
                      {onFront.map((point, position) => (
                        <span key={point.cell.id}>
                          {position > 0 && '; '}
                          <Link to={cellHref(point.cell.id)} viewTransition>
                            cell {point.cell.ordinal}
                          </Link>{' '}
                          ({formatMeasure(point.x)}, {formatMeasure(point.y)})
                        </span>
                      ))}
                      .
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="st-card st-wide" aria-labelledby="st-rank-title">
              <h2 id="st-rank-title">Engine ranking</h2>
              <RankingTable rows={rows} measure={measure} />
              <small className="org-muted">
                Ranked by the mean of {measureLabel(measure).toLowerCase()} over completed cells.
                Problems are pooled here; open one problem in the trade-offs to compare like with
                like.
              </small>
            </section>

            <section className="st-card st-wide" aria-labelledby="st-seed-title">
              <h2 id="st-seed-title">Same inputs, different seed</h2>
              {groups.length === 0 ? (
                <p className="org-muted">
                  Each cell ran with a single seed, so there’s no seed-to-seed difference to show.
                </p>
              ) : (
                <SeedTable groups={groups} measure={measure} cellHref={cellHref} />
              )}
              {Object.keys(summary.stability).length > 0 && (
                <div
                  className="stability-ledger st-stability"
                  aria-label="Repeatability of each engine"
                >
                  {Object.entries(summary.stability).map(([name, value]) => (
                    <div key={name}>
                      <span>{name}</span>
                      <meter min={0} max={1} value={value.repeatability}>
                        {value.repeatability}
                      </meter>
                      <strong>{Math.round(value.repeatability * 100)}%</strong>
                      <small>
                        {value.distinct}/{value.samples} distinct
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <ParetoFront
            org={org}
            orgName={organization.name}
            fronts={fronts}
            cells={allCells}
            cellHref={cellHref}
            canDerive={access.canCreate}
          />
          {summary.binding_space && <SpacePanel space={summary.binding_space} />}

          <section className="st-card" aria-labelledby="st-ledger-title">
            <div className="st-card-head">
              <h2 id="st-ledger-title">Every plotted cell</h2>
              <small className="org-muted">
                {studyRunLabel({
                  study: study.name,
                  number: data.run.run_number,
                  createdAt: data.run.created_at,
                })}
              </small>
            </div>
            <DataTable label="Provenance of every cell" minWidth={760}>
              <thead>
                <tr>
                  <th scope="col">Cell</th>
                  <th scope="col">Engine · seed</th>
                  <th scope="col">State</th>
                  <th scope="col">Took</th>
                  <th scope="col">Digest</th>
                </tr>
              </thead>
              <tbody>
                {cells.slice(0, 200).map(cell => (
                  <tr key={cell.id}>
                    <td>
                      <Link
                        to={cellHref(cell.id)}
                        viewTransition
                        aria-label={`Open cell ${cell.ordinal}`}
                      >
                        #{cell.ordinal}
                      </Link>
                    </td>
                    <td>
                      {cell.engine_ref.name}
                      <small className="org-muted">
                        {cell.engine_ref.mode ?? cell.engine_ref.version} · seed {cell.seed}
                      </small>
                    </td>
                    <td>
                      <StateChip state={cell.state} />
                    </td>
                    <td>{formatSeconds(metricsOf(cell).runtimeSeconds)}</td>
                    <td>
                      <CopyDigest
                        value={cell.fingerprint}
                        label={`Copy digest of cell ${cell.ordinal}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {cells.length > 200 && (
              <small className="org-muted">
                Showing the first 200 of {cells.length.toLocaleString('en-US')} cells; the CSV
                export has them all.
              </small>
            )}
            {formatDateTime(data.run.finished_at) && (
              <small className="org-muted">
                Run finished {formatDateTime(data.run.finished_at)}.
              </small>
            )}
          </section>
        </>
      )}
    </>
  );
}
