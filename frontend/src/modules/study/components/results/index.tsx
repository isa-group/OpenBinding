// The Results tab of the study page. Adapted from SPHERE frontend/src/modules/pricing/pages/collection-card/index.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the collection's Analytics tab (summary stat tiles over a grid of recharts cards) over one study run: the counts of
// its cells, each engine's values, the time each cell took and two objectives against each other with the gateway's front
// marked, then the ranking, the seeds, the size of the search space and every plotted cell. Nothing is estimated: the values
// are what the run recorded. The hand-drawn charts this tab had are gone.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BindingSpaceBadge } from '../../../../components/BindingSpaceBadge/BindingSpaceBadge';
import {
  parseBindingSpace,
  toSuperscript,
} from '../../../../components/BindingSpaceBadge/bindingSpace';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { FilterPills } from '../../../core/components/filter-pills';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { studyRunLabel } from '../../../core/utils/identity';
import { studiesApi, type BindingSpaceAnalytics } from '../../api/studiesApi';
import { useRevisionIndex } from '../../hooks/useRevisionIndex';
import type { StudyScopeValue } from '../../pages/card/hooks';
import {
  engineRows,
  scatterOf,
  seedGroups,
  spreadOf,
  tradeoffText,
} from '../../utils/analyticsModel';
import { loadRun } from '../../utils/runData';
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
} from '../../utils/studiesModel';
import { CARD, CARD_TITLE, FIELD_LABEL, LINK, MUTED, SELECT } from '../../utils/ui';
import { CopyDigest } from '../copy-digest';
import { RunMissing } from '../study-run';
import { StateChip } from '../study-state';
import {
  ChartCard,
  DistributionChart,
  RankingTable,
  SeedTable,
  TimeChart,
  TradeoffChart,
  TradeoffTable,
} from './charts';

function Counter({ value, label, tone }: { value: string; label: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-3">
      <b
        className={`block text-lg font-semibold ${
          tone === 'ok'
            ? 'text-tp-success-strong'
            : tone === 'bad'
              ? 'text-tp-error-strong'
              : 'text-tp-ink'
        }`}
      >
        {value}
      </b>
      <span className="text-[11px] text-tp-steel">{label}</span>
    </div>
  );
}

/** What the run's analytics say about the size of the problem. */
function SpacePanel({ space }: { space: BindingSpaceAnalytics }) {
  const several = (space.cases?.length ?? 0) > 1;
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-labelledby="study-space-title">
      <div>
        <h2 id="study-space-title" className={CARD_TITLE}>
          {several ? 'Largest search space' : 'Search space'}
        </h2>
        <small className={MUTED}>
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
        <ul
          className="flex flex-col divide-y divide-tp-hairline-soft"
          aria-label="Search space of each problem version"
        >
          {space.cases.map(item => (
            <li
              key={`${item.id}-${item.revision}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="flex flex-col">
                <strong className="text-sm font-medium text-tp-ink">{item.name}</strong>
                <small className={MUTED}>
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

/** The Results tab of the study page: the analytics of the study run `runId`, its cells and how the engines compare. */
export function RunResults({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, studyPath } = scope;
  const org = organization.slug;
  const cellHref = (cellId: string) =>
    studyPageHref(studyPath, 'results', { run: runId, cell: cellId });
  const { index } = useRevisionIndex(org);
  const analytics = useResource(`analytics:${runId}`, () =>
    studiesApi.analytics(org, study.slug, runId)
  );
  const loaded = useResource(`analytics-run:${study.id}/${runId}`, () =>
    loadRun(org, study.slug, runId)
  );
  const [engine, setEngine] = useState('');
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [caseChoice, setCaseChoice] = useState('');
  const [xChoice, setXChoice] = useState<string | null>(null);
  const [yChoice, setYChoice] = useState<string | null>(null);

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
    if (problem.status === 404) return <RunMissing studyName={study.name} />;
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
      <div className="flex flex-col gap-4" role="status" aria-busy="true">
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
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-tp-ink">
          Compare results · run #{data.run.run_number}
        </h2>
        <p className="text-sm text-tp-steel">
          Only what the run recorded. Nothing here is estimated: lower is better for every
          objective.
        </p>
      </div>

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        aria-label="Counts of the run"
      >
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
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-tp-hairline-strong bg-tp-canvas px-4 py-10 text-center text-sm text-tp-slate">
          No completed cells yet, so there’s nothing to chart. Cells fail when an engine doesn’t
          answer, or are cancelled before running.
          <span className="flex items-center gap-2">
            <StateChip state={data.run.state} />
            <Link
              to={studyPageHref(studyPath, 'progress', { run: runId })}
              viewTransition
              className={LINK}
            >
              Back to the run
            </Link>
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
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
              <label className={FIELD_LABEL}>
                <span>Measure</span>
                <select
                  aria-label="Measure"
                  value={measure}
                  onChange={event => setMeasureChoice(event.target.value)}
                  className={SELECT}
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

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DistributionChart rows={rows} measure={measure} />
            <TimeChart cells={cells} rows={rows} />
            {objectives.length < 2 ? (
              <section className={CARD} aria-labelledby="study-pareto-title">
                <h2 id="study-pareto-title" className={CARD_TITLE}>
                  Best trade-offs (Pareto)
                </h2>
                <p className={`mt-1 ${MUTED}`}>
                  A trade-off needs two objectives, and this run recorded{' '}
                  {objectives.length === 1 ? 'one' : 'none'}.
                </p>
              </section>
            ) : (
              <ChartCard
                title="Best trade-offs (Pareto)"
                summary={
                  points.length === 0
                    ? 'No completed cell of this problem has both objectives.'
                    : tradeoffText(points, xName, yName)
                }
                tools={
                  (caseIds.length > 1 || objectives.length > 2) && (
                    <div className="flex flex-wrap items-end gap-3">
                      {caseIds.length > 1 && (
                        <label className={FIELD_LABEL}>
                          <span>Problem</span>
                          <select
                            aria-label="Problem"
                            value={scatterCase}
                            onChange={event => setCaseChoice(event.target.value)}
                            className={SELECT}
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
                          <label className={FIELD_LABEL}>
                            <span>Across</span>
                            <select
                              aria-label="Across"
                              value={xName}
                              onChange={event => setXChoice(event.target.value)}
                              className={SELECT}
                            >
                              {objectives.map(name => (
                                <option key={name} value={name}>
                                  {measureLabel(name)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={FIELD_LABEL}>
                            <span>Up</span>
                            <select
                              aria-label="Up"
                              value={yName}
                              onChange={event => setYChoice(event.target.value)}
                              className={SELECT}
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
                  )
                }
                chart={
                  points.length === 0 ? (
                    <p className={MUTED}>No completed cell of this problem has both objectives.</p>
                  ) : (
                    <TradeoffChart points={points} xName={xName} yName={yName} />
                  )
                }
                table={<TradeoffTable points={points} xName={xName} yName={yName} />}
                footer={
                  onFront.length > 0 && (
                    <p className={MUTED}>
                      Best trade-offs:{' '}
                      {onFront.map((point, position) => (
                        <span key={point.cell.id}>
                          {position > 0 && '; '}
                          <Link to={cellHref(point.cell.id)} viewTransition className={LINK}>
                            cell {point.cell.ordinal}
                          </Link>{' '}
                          ({formatMeasure(point.x)}, {formatMeasure(point.y)})
                        </span>
                      ))}
                      .
                    </p>
                  )
                }
              />
            )}
          </div>

          <section className={`${CARD} flex flex-col gap-2`} aria-labelledby="study-rank-title">
            <h2 id="study-rank-title" className={CARD_TITLE}>
              Engine ranking
            </h2>
            <RankingTable rows={rows} measure={measure} />
            <small className={MUTED}>
              Ranked by the mean of {measureLabel(measure).toLowerCase()} over completed cells.
              Problems are pooled here; open one problem in the trade-offs to compare like with
              like.
            </small>
          </section>

          <section className={`${CARD} flex flex-col gap-2`} aria-labelledby="study-seed-title">
            <h2 id="study-seed-title" className={CARD_TITLE}>
              Same inputs, different seed
            </h2>
            {groups.length === 0 ? (
              <p className={MUTED}>
                Each cell ran with a single seed, so there’s no seed-to-seed difference to show.
              </p>
            ) : (
              <SeedTable groups={groups} measure={measure} cellHref={cellHref} />
            )}
            {Object.keys(summary.stability).length > 0 && (
              <div className="mt-2 flex flex-col gap-2" aria-label="Repeatability of each engine">
                {Object.entries(summary.stability).map(([name, value]) => (
                  <div
                    key={name}
                    className="grid grid-cols-[minmax(0,1fr)_6rem_3rem] items-center gap-3 text-xs sm:grid-cols-[minmax(0,1fr)_10rem_3rem_6rem]"
                  >
                    <span className="truncate font-mono text-tp-slate">{name}</span>
                    <meter min={0} max={1} value={value.repeatability} className="w-full">
                      {value.repeatability}
                    </meter>
                    <strong className="text-tp-ink">
                      {Math.round(value.repeatability * 100)}%
                    </strong>
                    <small className={`max-sm:col-span-3 ${MUTED}`}>
                      {value.distinct}/{value.samples} distinct
                    </small>
                  </div>
                ))}
              </div>
            )}
          </section>

          {summary.binding_space && <SpacePanel space={summary.binding_space} />}

          <section className={`${CARD} flex flex-col gap-2`} aria-labelledby="study-ledger-title">
            <div>
              <h2 id="study-ledger-title" className={CARD_TITLE}>
                Every plotted cell
              </h2>
              <small className={MUTED}>
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
                        className={LINK}
                      >
                        #{cell.ordinal}
                      </Link>
                    </td>
                    <td>
                      {cell.engine_ref.name}
                      <small className={`block ${MUTED}`}>
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
              <small className={MUTED}>
                Showing the first 200 of {cells.length.toLocaleString('en-US')} cells; the CSV
                export has them all.
              </small>
            )}
            {formatDateTime(data.run.finished_at) && (
              <small className={MUTED}>Run finished {formatDateTime(data.run.finished_at)}.</small>
            )}
          </section>
        </>
      )}
    </div>
  );
}
