import { formatNumber as fmt, shortId, type ArchiveQuery, type ArchiveResponse } from '../../analysis/archive';
import { ArchiveChart, ParallelCoordinates } from '../../components/BindingAnalysis/ArchiveChart';
import { TraceChart } from '../../components/TraceChart/TraceChart';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { CopyField } from '../../components/ui/CopyField';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { formatDateTime } from '../../utils/format';
import '../Platform/AnalysisPage.css';
import { OBJECTIVE_COLOURS, activeDimensions, budgetRungs, percent, searchOfSources, stretchesOf } from './analysisModel';
import type { ArchiveSession } from './useArchiveSession';

interface ViewProps {
  data: ArchiveResponse;
  query: ArchiveQuery;
  select: (id: string) => void;
  change: (values: Partial<ArchiveQuery>) => void;
}

/** Which objectives sit on the horizontal and vertical axes of the map (and, for preferences, the third priority). */
export function AxisControls({ data, query, change }: Pick<ViewProps, 'data' | 'query' | 'change'>) {
  const view = query.view ?? 'decision';
  const active = activeDimensions(data.dimensions);
  const slots = [0, 1, ...(view === 'preferences' && active.length >= 3 && (query.axes?.length ?? 3) > 2 ? [2] : [])];
  const names = ['X objective', 'Y objective', 'Third priority'];
  return (
    <div className="an-axes">
      {slots.map((slot) => (
        <label key={slot} className="an-field">
          <span>{names[slot]}</span>
          <select
            value={query.axes?.[slot] ?? data.dimensions[data.plot.axes[slot] ?? slot]?.key ?? ''}
            onChange={(event) => {
              const defaults = [...active, ...data.dimensions.filter((dimension) => dimension.constant)].map((dimension) => dimension.key);
              const axes = [...(query.axes ?? defaults.slice(0, view === 'preferences' ? 3 : 2))];
              const previous = axes[slot];
              const conflict = axes.indexOf(event.target.value);
              axes[slot] = event.target.value;
              if (conflict >= 0 && conflict !== slot) axes[conflict] = previous;
              change({ axes, viewport: null });
            }}
          >
            {data.dimensions.map((dimension) => <option key={dimension.key} value={dimension.key}>{dimension.label}{dimension.constant ? ' (constant)' : ''}</option>)}
          </select>
        </label>
      ))}
    </div>
  );
}

/** The map of the stored bindings, with the choice of its axes. */
export function SpaceMap({ data, query, select, change }: ViewProps) {
  return (
    <section className="an-card" aria-label="Binding space">
      <AxisControls data={data} query={query} change={change} />
      <ArchiveChart data={data} query={query} select={select} change={change} />
    </section>
  );
}

export function BudgetsView({ data, query, select, change }: ViewProps) {
  const budgets = data.budgets;
  const rungs = budgets?.available ? budgetRungs(budgets) : [];
  const [horizontal, vertical] = budgets?.axes.map((axis) => data.dimensions[axis]) ?? [];
  return (
    <>
      <section className="an-card" aria-labelledby="an-ladder-title">
        <h2 id="an-ladder-title">{horizontal ? `If ${horizontal.label} had to stay ${horizontal.direction === 'maximize' ? 'above' : 'under'}…` : 'Budgets'}</h2>
        {rungs.length === 0 && <p className="an-empty-line">{budgets?.reason ?? 'Budgets need two objectives that are not constant in these results.'}</p>}
        {rungs.length > 0 && horizontal && vertical && (
          <ol className="an-ladder">
            {rungs.map((rung) => (
              <li key={rung.id}>
                <strong>{fmt(rung.budget)}{horizontal.unit ? ` ${horizontal.unit}` : ''}</strong>
                <span className="an-track" aria-hidden="true"><i style={{ width: `${Math.max(3, rung.position)}%` }} /></span>
                <span>
                  <button type="button" onClick={() => select(rung.id)}>{shortId(rung.id)}</button>
                  {' '}reaches {vertical.label} {fmt(rung.achieved)}{vertical.unit ? ` ${vertical.unit}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
        <small className="an-note">Uses your current priorities and limits to pick what is reachable within each budget.{budgets?.meaning ? ` ${budgets.meaning}` : ''}</small>
      </section>
      <SpaceMap data={data} query={query} select={select} change={change} />
    </>
  );
}

interface FrontViewProps extends ViewProps {
  selected: string | undefined;
  session: ArchiveSession;
}

export function FrontView({ data, query, select, change, selected, session }: FrontViewProps) {
  const { task } = session;
  const running = task?.state === 'running' || task?.state === 'queued';
  return (
    <>
      <section className="an-card" aria-labelledby="an-front-title">
        <h2 id="an-front-title">Full trade-off front</h2>
        <p>{data.pareto.state === 'uncomputed'
          ? 'Full Pareto classification has not been computed. Rankings and the dominance of the selected binding remain exact.'
          : `${data.pareto.frontCount} non-dominated binding${data.pareto.frontCount === 1 ? '' : 's'} among ${data.pareto.count} in this scope.`}</p>
        <div className="an-controls">
          <label className="an-field">
            <span>Pareto scope</span>
            <select value={query.paretoScope ?? 'archive'} onChange={(event) => { change({ paretoScope: event.target.value as 'archive' | 'eligible' }); session.forgetFront(); }}>
              <option value="archive">All known-feasible bindings</option>
              <option value="eligible">Bindings meeting requirements</option>
            </select>
          </label>
          <label className="an-check"><input type="checkbox" checked={query.layers ?? false} onChange={(event) => { change({ layers: event.target.checked }); session.forgetFront(); }} />Compute all Pareto layers</label>
          <label className="an-check"><input type="checkbox" checked={query.geometry === 'voronoi'} onChange={(event) => change({ geometry: event.target.checked ? 'voronoi' : 'none' })} />Voronoi proximity</label>
        </div>
        {data.pareto.hypervolume && <p className="an-note">{data.pareto.hypervolume.meaning} Area: {fmt(data.pareto.hypervolume.value)}.</p>}
        {data.pareto.state === 'uncomputed' && !task && <Action variant="primary" onClick={session.startFront}>Compute the front</Action>}
        {data.pareto.state === 'uncomputed' && task && (
          <div className="an-task" role="status">
            <span><strong>{task.state[0].toUpperCase() + task.state.slice(1)}</strong> · {fmt(task.progress * 100)}%</span>
            <progress value={task.progress} max={1} aria-label="Progress of the front" />
            {running && <Action variant="secondary" size="sm" onClick={session.cancelFront}>Cancel</Action>}
            {task.state === 'cancelled' && <span>Cancelled. No partial front is shown, so nothing half-done is mistaken for an answer. <Action variant="link" size="sm" onClick={session.startFront}>Start again</Action></span>}
            {task.error && <Notice tone="error">{task.error}</Notice>}
          </div>
        )}
        {data.geometry?.state === 'unavailable' && <Notice tone="info">{data.geometry.reason}</Notice>}
      </section>
      <SpaceMap data={data} query={query} select={select} change={change} />
      {activeDimensions(data.dimensions).length >= 2 && (
        <section className="an-card" aria-label="All objectives"><ParallelCoordinates data={data} selected={selected} select={select} /></section>
      )}
    </>
  );
}

export function PreferencesView({ data, query, select, change }: ViewProps) {
  const stretches = stretchesOf(data.geometry);
  const winners = [...new Set(stretches.flatMap((stretch) => (stretch.winner ? [stretch.winner] : [])))];
  const active = activeDimensions(data.dimensions);
  const axis = data.geometry?.axis !== undefined ? data.dimensions[data.geometry.axis] : active[0];
  const colourOf = (id: string | null) => (id ? OBJECTIVE_COLOURS[winners.indexOf(id) % OBJECTIVE_COLOURS.length] : '#ededed');
  return (
    <>
      <section className="an-card" aria-labelledby="an-switch-title">
        <h2 id="an-switch-title">Which choice wins for each balance</h2>
        <div className="an-controls">
          <FilterPills
            ariaLabel="Preference map"
            value={query.geometry === 'power' ? 'power' : 'sensitivity'}
            options={[{ id: 'sensitivity', label: 'Priority scenarios' }, { id: 'power', label: 'Weighted-sum power map' }]}
            onChange={(id) => change(id === 'power' ? { geometry: 'power', rule: 'weighted' } : { geometry: 'sensitivity' })}
          />
          <label className="an-field">
            <span>Slice priorities</span>
            <select value={Math.min(active.length, query.axes?.length ?? 3)} onChange={(event) => change({ axes: active.slice(0, Number(event.target.value)).map((dimension) => dimension.key) })}>
              <option value={2}>Two priorities</option>
              {active.length >= 3 && <option value={3}>Three priorities</option>}
            </select>
          </label>
        </div>
        {data.geometry?.state === 'unavailable' && <Notice tone="info">{data.geometry.reason}</Notice>}
        {stretches.length > 0 && query.geometry !== 'power' && (
          <>
            <div className="an-switch" role="img" aria-label={stretches.map((stretch) => `${stretch.winner ? shortId(stretch.winner) : 'no winner'} from ${percent(stretch.from)} to ${percent(stretch.to)}`).join('; ')}>
              {stretches.map((stretch) => (
                <button
                  key={`${stretch.from}`}
                  type="button"
                  style={{ width: `${(stretch.to - stretch.from) * 100}%`, background: colourOf(stretch.winner) }}
                  disabled={!stretch.winner}
                  onClick={() => stretch.winner && select(stretch.winner)}
                  aria-label={`Inspect ${stretch.winner ? shortId(stretch.winner) : 'no winner'}`}
                >
                  {stretch.winner ? shortId(stretch.winner) : '—'}
                </button>
              ))}
            </div>
            <div className="an-switch-scale" aria-hidden="true"><span>none on {axis?.label ?? 'this objective'}</span><span>all on {axis?.label ?? 'this objective'}</span></div>
            <ul className="an-stretches">
              {stretches.map((stretch) => (
                <li key={`${stretch.from}`}>
                  <i style={{ background: colourOf(stretch.winner) }} aria-hidden="true" />
                  <span>{stretch.winner ? `Binding ${shortId(stretch.winner)}` : 'No winner'} from {percent(stretch.from)} to {percent(stretch.to)}</span>
                  {stretch.count > 1 && <Chip>{stretch.count} tied</Chip>}
                </li>
              ))}
            </ul>
            {data.geometry?.meaning && <small className="an-note">{data.geometry.meaning}</small>}
          </>
        )}
      </section>
      {query.geometry !== 'sensitivity' && <SpaceMap data={data} query={query} select={select} change={change} />}
    </>
  );
}

export function EvidenceView({ data }: { data: ArchiveResponse }) {
  return (
    <>
      <section className="an-card" aria-labelledby="an-evidence-title">
        <h2 id="an-evidence-title">Evidence used</h2>
        <p>{data.counts.unique.toLocaleString('en-US')} unique bindings from {data.counts.stored.toLocaleString('en-US')} stored occurrences · {data.counts.eligible.toLocaleString('en-US')} eligible.</p>
        <ul className="an-evidence">
          {data.sources.map((source) => (
            <li key={source.id}>
              <header>
                <strong>{source.engine}</strong>
                <span>{formatDateTime(source.createdAt) ?? source.createdAt} · {source.state}</span>
                <Chip tone={source.diagnostic ? 'warning' : 'plain'}>{source.diagnostic ? 'Canonical-evaluated diagnostic archive' : 'Stored job result'}</Chip>
                {source.legacy && <Chip tone="warning">Legacy identity</Chip>}
              </header>
              <dl>
                <div><dt>Job</dt><dd><code>{source.id}</code></dd></div>
                <div><dt>Model</dt><dd><CopyField value={source.irDigest ?? 'unavailable'} label="model digest" truncate /></dd></div>
                <div><dt>Evaluator</dt><dd><CopyField value={source.evaluatorDigest ?? 'unavailable'} label="evaluator digest" truncate /></dd></div>
                <div><dt>Result ({source.resultDigestKind})</dt><dd><CopyField value={source.resultDigest ?? 'unavailable'} label="result digest" truncate /></dd></div>
              </dl>
            </li>
          ))}
        </ul>
        <Action to={`/app/analysis?${searchOfSources(data.sources.map((source) => source.id))}`} variant="secondary" size="sm">Change sources</Action>
        {data.warnings.map((warning) => <Notice key={warning} tone="info">{warning}</Notice>)}
      </section>
      <section className="an-card" aria-labelledby="an-journey-title">
        <h2 id="an-journey-title">Recorded optimisation journey</h2>
        {data.trajectory.length
          ? data.trajectory.map((trace) => <TraceChart key={trace.jobId} trace={trace.events} engineId={trace.jobId} />)
          : <p className="an-empty-line">No trajectory was recorded. No intermediate states are inferred.</p>}
      </section>
    </>
  );
}
