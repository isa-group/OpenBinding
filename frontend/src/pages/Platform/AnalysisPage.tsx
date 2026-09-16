import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { analysisApi, decisionReceipt, formatNumber as fmt, shortId, type ArchiveQuery, type ArchiveResponse, type ArchiveSource,
  type AnalysisTask, type AnalysisView, type CandidateDetail, type DecisionReceipt, type DecisionRule } from '../../analysis/archive';
import { platformApi, type Organization, type Project } from '../../api/platform';
import { ArchiveChart, ParallelCoordinates } from '../../components/BindingAnalysis/ArchiveChart';
import { TraceChart } from '../../components/TraceChart/TraceChart';
import './AnalysisPage.css';

const views: AnalysisView[] = ['decision', 'budgets', 'pareto', 'preferences', 'evidence'];
const rules: Record<DecisionRule, string> = { balanced: 'Balanced compromise', weighted: 'Weighted sum', ideal: 'Distance to ideal', chebyshev: 'Worst weighted loss', reference: 'Distance to reference', topsis: 'TOPSIS', model: 'Original model ordering' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function download(text: string, name: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AnalysisPage() {
  const [params] = useSearchParams();
  return <AnalysisWorkspace key={params.toString()} />;
}

function AnalysisWorkspace() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState<ArchiveQuery>(() => ({ sources: params.getAll('job'), view: 'decision', rule: 'balanced', page: 0, compare: [] }));
  const [data, setData] = useState<ArchiveResponse | null>(null), [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0), [task, setTask] = useState<AnalysisTask | null>(null);
  const [showSources, setShowSources] = useState(!query.sources.length), [save, setSave] = useState(false);
  const [snapshot, setSnapshot] = useState<DecisionReceipt | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const selected = query.selected ?? data?.winners[0]?.id;
  const effective: ArchiveQuery = { ...query, selected, revision: query.revision ?? data?.revision };
  const reportRef = params.get('report');
  const currentView = query.view ?? 'decision';

  useEffect(() => {
    if (!reportRef) return;
    let active = true;
    const [org, project, slug] = reportRef.split('/');
    if (!org || !project || !slug) return;
    platformApi.report(org, project, slug).then(report => {
      if (!active) return;
      const document = report.document;
      const saved = decisionReceipt(document);
      if (!saved) throw new Error('This report does not contain a valid binding decision snapshot');
      setSnapshot(saved); setQuery(saved.query); revision.current = saved.revision; setShowSources(false);
    }).catch(err => { if (active) setError(message(err)); });
    return () => { active = false; };
  }, [reportRef]);

  useEffect(() => {
    if (!query.sources.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true); setError('');
      analysisApi.query({ ...query, revision: query.revision ?? revision.current }, controller.signal).then(response => {
        if (controller.signal.aborted) return;
        revision.current = response.revision; setData(response);
      }).catch(err => { if (!controller.signal.aborted) setError(message(err)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 120);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, refresh]);

  useEffect(() => {
    if (!data || !selected || busy || error) return;
    const controller = new AbortController();
    analysisApi.candidate({ ...query, selected, revision: data.revision }, controller.signal).then(value => {
      if (!controller.signal.aborted && value.revision === data.revision) setDetail(value);
    }).catch(err => { if (!controller.signal.aborted) setError(message(err)); });
    return () => controller.abort();
  }, [data, selected, query, busy, error]);

  useEffect(() => {
    if (!task || !['queued', 'running'].includes(task.state)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => analysisApi.pareto(task.id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setTask(value);
      if (value.state === 'completed') setRefresh(v => v + 1);
    }).catch(err => { if (!controller.signal.aborted) { setError(message(err)); setTask(null); } }), document.hidden ? 5000 : 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [task]);

  function change(values: Partial<ArchiveQuery>) {
    setBusy(true);
    setDetail(null);
    setQuery(q => ({ ...q, ...values }));
    setNotice('');
  }
  function chooseSources(sources: string[]) {
    revision.current = undefined; setSnapshot(null); setTask(null); setData(null); setDetail(null);
    setQuery({ sources, view: 'decision', rule: 'balanced', compare: [], page: 0 });
    setParams(sources.map(id => ['job', id] as [string, string])); setShowSources(false);
  }
  function select(id: string) { change({ selected: id }); }
  function shortlist(id: string) {
    const current = query.compare ?? [];
    if (current.includes(id)) change({ compare: current.filter(value => value !== id) });
    else if (current.length < 4) change({ compare: [...current, id] });
    else setNotice('The comparison shortlist holds four bindings. Remove one to add another.');
  }
  async function exportData(format: 'receipt' | 'csv' | 'json') {
    try {
      const output = format === 'receipt' ? JSON.stringify(await analysisApi.receipt(effective), null, 2) : await analysisApi.export(effective, format);
      download(output, `binding-${format === 'receipt' ? 'decision.json' : `archive.${format}`}`, format === 'csv' ? 'text/csv' : 'application/json');
      setNotice('Export downloaded.');
    } catch (err) { setError(message(err)); }
  }
  return <main className="analysis-workspace">
    <header className="analysis-header"><div><span className="analysis-eyebrow">Binding decisions</span><h1>Find the trade-off you can explain.</h1>
      <p>Compare evaluated bindings. Set requirements, inspect alternatives, and keep the evidence behind your choice.</p></div>
      <div className="analysis-actions"><button onClick={() => setShowSources(value => !value)}>Choose runs{query.sources.length ? ` (${query.sources.length})` : ''}</button>
        <button disabled={!data || busy || !!error} onClick={() => setSave(true)}>Save decision</button>
        <button disabled={!data || busy || !!error} onClick={() => void exportData('receipt')}>Export receipt</button></div></header>
    {showSources && <SourcePicker selected={query.sources} choose={chooseSources} />}
    {error && <div className="analysis-error" role="alert"><strong>Analysis unavailable</strong><p>{error}</p>{data && <p>The values below are the last recorded response, not trusted current evidence. Reload before making a decision.</p>}
      <button onClick={() => { revision.current = undefined; change({ revision: undefined }); setSnapshot(null); setRefresh(v => v + 1); }}>Reload current evidence</button></div>}
    {snapshot && <details open={!!error} className="analysis-notice"><summary>Saved decision snapshot</summary>
      <p>This is the recorded decision. Live analysis requires access to matching source identities.</p><SavedDecision document={snapshot} /></details>}
    {notice && <p role="status" className="analysis-notice">{notice}</p>}
    {!query.sources.length && !showSources && <p>Choose a stored run to begin.</p>}
    {data && <div aria-busy={busy} className={busy ? 'analysis-loading' : ''}>
      <div className="analysis-evidence-bar"><span><strong>{data.counts.unique.toLocaleString()}</strong> unique bindings</span>
        <span>{data.counts.stored.toLocaleString()} stored occurrences</span><span>{data.counts.eligible.toLocaleString()} eligible</span>
        <span>{data.counts.infeasible ?? 0} hard-infeasible</span><span>{data.counts.unknown ?? 0} unknown feasibility</span>
        <span className="analysis-unknown-label">Unexplored space: unknown</span></div>
      <nav className="analysis-tabs" aria-label="Analysis views">{views.map(view => <button key={view} aria-current={currentView === view ? 'page' : undefined}
        onClick={() => change({ view, page: 0, geometry: view === 'preferences' ? 'sensitivity' : 'none', viewport: null })}>{view[0].toUpperCase()+view.slice(1)}</button>)}</nav>
      <div className="analysis-main"><section className="analysis-content">
        <div className="analysis-recommendation"><div><span className="analysis-eyebrow">{rules[data.rule]} · {data.winnerCount > 1 ? `${data.winnerCount} co-winners` : 'Preferred under your rule'}</span>
          <h2>{data.winners.length ? <button onClick={() => select(data.winners[0].id)}>Binding {shortId(data.winners[0].id)}</button> : 'No stored binding meets these requirements'}</h2>
          <p>{data.winners.length ? data.formula : 'Adjust requirements or choose another compatible archive. This does not prove that no feasible binding exists.'}</p>
          {data.winnerCount > 1 && <div className="analysis-chips">{data.winners.slice(0, 8).map(row => <button key={row.id} onClick={() => select(row.id)}>{shortId(row.id)}</button>)}{data.winnerCount > 8 && <span>All ties remain in the ranked table.</span>}</div>}
        </div><div className="analysis-next"><span>Next distinct score group{data.nextCount > 1 ? ` · ${data.nextCount} tied` : ''}</span>
          {data.next[0] ? <><button onClick={() => { select(data.next[0].id); change({ selected: data.next[0].id, compare: [data.winners[0].id] }); }}>Binding {shortId(data.next[0].id)}</button><code>{data.next[0].score?.map(fmt).join(' / ')}</code></> : <p>No worse eligible score group.</p>}</div></div>

        {currentView !== 'evidence' && <div className="analysis-controls">
          <label>Recommendation rule<select value={query.rule ?? 'balanced'} onChange={event => change({ rule: event.target.value as DecisionRule, page: 0, geometry: 'none' })}>
            {Object.entries(rules).map(([value, label]) => <option key={value} value={value} disabled={value === 'model' && !data.modelOrderingAvailable}>{label}{value === 'model' && !data.modelOrderingAvailable ? ' (partial order only)' : ''}</option>)}</select></label>
          {[0, 1, ...(currentView === 'preferences' && data.dimensions.filter(d => !d.constant).length >= 3 && (query.axes?.length ?? 3) > 2 ? [2] : [])].map((axis, i) => <label key={axis}>{['X objective', 'Y objective', 'Third priority'][i]}
            <select value={query.axes?.[axis] ?? data.dimensions[data.plot.axes[axis] ?? axis]?.key ?? ''} onChange={event => {
              const defaults = [...data.dimensions.filter(d => !d.constant), ...data.dimensions.filter(d => d.constant)].map(d => d.key);
              const axes = [...(query.axes ?? defaults.slice(0, currentView === 'preferences' ? 3 : 2))];
              const previous = axes[axis], conflict = axes.indexOf(event.target.value);
              axes[axis] = event.target.value; if (conflict >= 0 && conflict !== axis) axes[conflict] = previous;
              change({ axes, viewport: null });
            }}>{data.dimensions.map(d => <option key={d.key} value={d.key}>{d.label}{d.constant ? ' (constant)' : ''}</option>)}</select></label>)}
        </div>}

        {(currentView === 'decision' || currentView === 'budgets' || currentView === 'preferences') && <details open={currentView !== 'decision'} className="analysis-preferences"><summary>Priorities and requirements</summary>
          <p>Equal priority is the starting assumption. Normalization stays fixed to this archive, including when requirements change.</p>
          <div className="analysis-objectives">{data.dimensions.map(d => {
            const requirement = query.requirements?.find(r => r.dimension === d.key);
            return <div key={d.key}><strong>{d.label}</strong><small>{d.direction === 'maximize' ? 'Higher is better' : 'Lower is better'}{d.unit ? ` · ${d.unit}` : ''}{d.constant ? ' · constant loss' : ''}</small>
              <label>Priority<input aria-label={`${d.label} priority`} type="number" min="0" step="0.1" disabled={d.constant} value={query.weights?.[d.key] ?? (d.constant ? 0 : 1)} onChange={event => {
                const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 0) change({ weights: { ...query.weights, [d.key]: value }, page: 0 });
              }} /><output>{fmt((data.weights[d.key] ?? 0)*100)}%</output></label>
              <label>{requirement?.space !== 'normalized' && d.direction === 'maximize' ? 'At least' : 'At most'}<input aria-label={`${d.label} requirement`} type="number" step="any" placeholder="No limit" value={requirement?.value ?? ''} onChange={event => {
                const requirements = (query.requirements ?? []).filter(r => r.dimension !== d.key), value = event.target.valueAsNumber;
                if (event.target.value !== '' && Number.isFinite(value)) requirements.push({ dimension: d.key, value, space: requirement?.space ?? 'raw' });
                change({ requirements, page: 0 });
              }} /></label>
              {requirement && <label>Requirement units<select aria-label={`${d.label} requirement units`} value={requirement.space} onChange={event => change({ requirements: query.requirements?.map(r => r.dimension === d.key ? { ...r, space: event.target.value as 'raw' | 'normalized' } : r), page: 0 })}><option value="raw">Stored raw units</option><option value="normalized">Archive normalized loss</option></select></label>}
              {query.rule === 'reference' && <label>Normalized target<input type="number" step="0.1" value={query.reference?.[d.key] ?? 0} onChange={event => {
                if (Number.isFinite(event.target.valueAsNumber)) change({ reference: { ...query.reference, [d.key]: event.target.valueAsNumber } });
              }} /></label>}
            </div>;
          })}</div><button onClick={() => change({ weights: {}, requirements: [], reference: {}, page: 0 })}>Reset priorities and requirements</button>
        </details>}

        {currentView === 'pareto' && <div className="analysis-pareto-controls"><label>Pareto scope<select value={query.paretoScope ?? 'archive'} onChange={event => { change({ paretoScope: event.target.value as 'archive' | 'eligible' }); setTask(null); }}>
          <option value="archive">All known-feasible bindings</option><option value="eligible">Bindings meeting requirements</option></select></label>
          <label><input type="checkbox" checked={query.layers ?? false} onChange={event => { change({ layers: event.target.checked }); setTask(null); }} />Compute all Pareto layers</label>
          <label><input type="checkbox" checked={query.geometry === 'voronoi'} onChange={event => change({ geometry: event.target.checked ? 'voronoi' : 'none' })} />Voronoi proximity</label>
          <p>{data.pareto.state === 'uncomputed' ? 'Full Pareto classification has not been computed. Rankings and selected-binding dominance remain exact.' : `${data.pareto.frontCount} non-dominated bindings among ${data.pareto.count} in this scope.`}</p>
          {data.pareto.hypervolume && <p>{data.pareto.hypervolume.meaning} Area: {fmt(data.pareto.hypervolume.value)}.</p>}
          {data.pareto.state === 'uncomputed' && <button disabled={task?.state === 'running' || task?.state === 'queued'} onClick={() => analysisApi.startPareto(effective).then(setTask).catch(err => setError(message(err)))}>Compute exact Pareto analysis in background</button>}
          {task && <div role="status"><strong>{task.state}</strong> · {fmt(task.progress*100)}% <progress value={task.progress} max="1" />
            {['queued', 'running'].includes(task.state) && <button onClick={() => analysisApi.cancelPareto(task.id).then(setTask).catch(err => setError(message(err)))}>Cancel computation</button>}{task.error && <p>{task.error}</p>}</div>}
        </div>}
        {currentView === 'preferences' && <div className="analysis-actions"><label>Slice priorities<select value={query.axes?.length === 2 ? 2 : 3} onChange={event => change({ axes: data.dimensions.filter(d => !d.constant).slice(0, Number(event.target.value)).map(d => d.key) })}><option value={2}>Two priorities</option>{data.dimensions.filter(d => !d.constant).length >= 3 && <option value={3}>Three priorities</option>}</select></label><button aria-pressed={query.geometry === 'sensitivity'} onClick={() => change({ geometry: 'sensitivity' })}>Priority scenarios</button>
          <button aria-pressed={query.geometry === 'power'} onClick={() => change({ geometry: 'power', rule: 'weighted' })}>Weighted-sum power map</button></div>}
        {data.geometry?.state === 'unavailable' && <p role="status" className="analysis-notice">{data.geometry.reason}</p>}
        {currentView !== 'evidence' && data.geometry?.kind !== 'sensitivity' && <ArchiveChart data={data} query={effective} select={select} change={change} />}
        {data.geometry?.scenarios && <section className="analysis-scenarios"><h3>What changes as this priority increases?</h3><p>{data.geometry.meaning}</p><div>{data.geometry.scenarios.map(scenario => <button key={scenario.t} onClick={() => scenario.winners[0] && select(scenario.winners[0])}>
          <span>{fmt(scenario.t*100)}% toward one priority</span><strong>{scenario.winners[0] ? shortId(scenario.winners[0]) : 'None'}</strong><small>{scenario.winnerCount} winner{scenario.winnerCount === 1 ? '' : 's'}</small></button>)}</div></section>}
        {currentView === 'pareto' && <ParallelCoordinates data={data} selected={selected} select={select} />}
        {currentView === 'evidence' && <><details open><summary>Source and normalization evidence</summary><p>{data.warnings.join(' ')}</p>
          {data.sources.map(source => <div key={source.id} className="analysis-source-evidence"><Link to={`/app/analysis?job=${encodeURIComponent(source.id)}`}>{source.engine} · {source.id}</Link>
            <span>{source.diagnostic ? 'Canonical-evaluated diagnostic archive' : 'Stored job result'}{source.legacy ? ' · legacy identity' : ''}</span>
            <code>Model {source.irDigest}</code><code>Evaluator {source.evaluatorDigest ?? 'unavailable'}</code><code>Result ({source.resultDigestKind}) {source.resultDigest}</code></div>)}</details>
          <details><summary>Recorded optimization journey</summary>{data.trajectory.length ? data.trajectory.map(trace => <TraceChart key={trace.jobId} trace={trace.events} engineId={trace.jobId} />) : <p>No trajectory was recorded. No intermediate states are inferred.</p>}</details></>}

        <section className="analysis-ranking"><header><h3>Every binding, in context</h3><div className="analysis-actions"><button onClick={() => void exportData('csv')}>Export ranking CSV</button><button onClick={() => void exportData('json')}>Export archive JSON</button></div></header>
          <div className="analysis-controls"><label>Find binding or assignment<input type="search" value={query.search ?? ''} onChange={event => change({ search: event.target.value, page: 0 })} /></label>
            <label>Show<select value={query.status ?? 'all'} onChange={event => change({ status: event.target.value as ArchiveQuery['status'], page: 0 })}>
              {['all', 'eligible', 'feasible', 'infeasible', 'unknown', 'excluded'].map(value => <option key={value}>{value}</option>)}</select></label>
            {query.viewport && <button onClick={() => change({ viewport: null, page: 0 })}>Clear spatial selection</button>}</div>
          <div className="analysis-table-scroll"><table><thead><tr><th>Rank</th><th>Binding</th><th>Evidence</th><th>Preference score</th><th>Pareto layer</th><th>Compare</th></tr></thead>
            <tbody>{data.rows.map(row => <tr key={row.id} className={row.id === selected ? 'selected' : ''}><td>{row.rank ?? '—'}{row.scoreGroup === 1 && data.winnerCount > 1 ? ' (tie)' : ''}</td>
              <th><button title={row.id} aria-label={`Inspect binding ${shortId(row.id)}`} onClick={() => select(row.id)}>{shortId(row.id)}</button><small>{row.occurrences} occurrence{row.occurrences === 1 ? '' : 's'}</small></th>
              <td><span className={`analysis-status ${row.eligible ? 'eligible' : row.feasible === false ? 'infeasible' : ''}`}>{row.eligible ? 'Eligible' : row.feasible === false ? 'Hard-infeasible' : row.feasible === null ? 'Unknown' : 'Excluded'}</span>{row.reasons.length > 0 && <details><summary>Why?</summary>{row.reasons.map(reason => <p key={reason}>{reason}</p>)}</details>}</td>
              <td>{row.score?.map(fmt).join(' / ') ?? '—'}</td><td>{row.paretoRank ?? (data.pareto.state === 'front-complete' && row.feasible === true && row.losses && (data.pareto.scope === 'archive' || row.eligible) ? 'Not on first front' : 'Uncomputed / outside scope')}</td>
              <td><input type="checkbox" aria-label={`Compare ${shortId(row.id)}`} checked={query.compare?.includes(row.id) ?? false} onChange={() => shortlist(row.id)} /></td></tr>)}</tbody></table></div>
          {!data.rows.length && <p>No bindings match this table filter. Recommendations still use all eligible bindings.</p>}
          <div className="analysis-pagination"><button disabled={!data.page || busy} onClick={() => change({ page: data.page-1 })}>Previous</button><span>{data.total ? `${data.page*data.pageSize+1}–${Math.min(data.total, (data.page+1)*data.pageSize)}` : '0'} of {data.total.toLocaleString()}</span><button disabled={(data.page+1)*data.pageSize >= data.total || busy} onClick={() => change({ page: data.page+1 })}>Next</button></div>
        </section>
      </section><aside className="analysis-inspector" aria-label="Binding inspector">
        <header><span className="analysis-eyebrow">Binding inspector</span><h2>{selected ? shortId(selected) : 'Select a binding'}</h2></header>
        {selected && !detail && !error && <p role="status">Loading selected-binding evidence…</p>}
        {detail && detail.row.id === selected && <><p>{detail.explanation.summary}</p><p>{detail.row.eligible ? `Rank ${detail.row.rank} · score ${detail.row.score?.map(fmt).join(' / ')}` : detail.row.reasons.join('. ')}</p>
          <button onClick={() => shortlist(detail.row.id)}>{query.compare?.includes(detail.row.id) ? 'Remove from shortlist' : 'Add to shortlist'}</button>
          <p>Original model score: {JSON.stringify(detail.row.modelScore)}. This is separate from your preference score.</p>
          <h3>What contributes to this choice?</h3><div className="analysis-contributions">{detail.explanation.components.map(component => <div key={component.key}>
            <label>{component.key}<strong>{fmt(component.value)}</strong></label><meter min="0" max="1" value={Math.max(0, Math.min(1, component.normalized ?? 0))} />
            <small>Normalized loss {fmt(component.normalized)} × priority {fmt(component.weight)} = {fmt(component.weightedLoss)}</small></div>)}</div>
          <details><summary>Exact scoring explanation</summary><p>{detail.explanation.formula}</p><p>Equal worst-loss scores under the balanced rule are compared by their total weighted loss.</p>
            <p>Next distinct score: {detail.explanation.nextScore?.map(fmt).join(' / ') ?? 'none'}. {detail.explanation.nearTie ? 'The next score is numerically close; it is not merged into this tie group.' : ''}</p>
            <p>Near ties use tolerance {detail.explanation.nearTieTolerance} × max(1, |a|, |b|). Exact score ties remain separate from near ties. The receipt retains full precision.</p>
            <code>Binding identity: {detail.row.id}</code><br /><code>Fixed archive: {detail.explanation.normalizationScope}</code></details>
          <details open><summary>Assignment</summary><dl className="analysis-assignment">{Object.entries(detail.binding).map(([key, ref]) => <div key={key}><dt>{key}</dt><dd>{typeof ref?.resource === 'string' && typeof ref?.id === 'string' ? `${ref.resource} / ${ref.id}` : JSON.stringify(ref)}</dd></div>)}</dl></details>
          <details><summary>Constraints and raw metrics</summary><pre>{JSON.stringify(detail.evaluation, null, 2)}</pre></details>
          <details open><summary>Dominance and nearby alternatives</summary><p>{detail.dominance.computed ? `${detail.dominance.dominatorCount} stored feasible bindings dominate this binding in the ${detail.dominance.scope} scope.` : 'Incomplete objectives prevent a dominance comparison.'}</p>
            {detail.dominance.dominators.slice(0, 10).map(id => <button key={id} onClick={() => select(id)}>{shortId(id)}</button>)}
            <label>Distance<select value={query.metric ?? 'euclidean'} onChange={event => change({ metric: event.target.value as ArchiveQuery['metric'] })}>
              <option value="euclidean">Euclidean · normalized losses</option><option value="manhattan">Manhattan · normalized losses</option><option value="hamming">Hamming · changed assignments</option><option value="gower">Gower · losses and assignments</option></select></label>
            <ol className="analysis-neighbors">{detail.neighbors.map(neighbor => <li key={neighbor.id}><button onClick={() => select(neighbor.id)}>{shortId(neighbor.id)}</button><span>{fmt(neighbor.distance)}</span></li>)}</ol>
            <small>Proximity describes stored alternatives; it does not establish robustness to new conditions.</small></details>
          <details><summary>Source occurrences ({detail.occurrences.length})</summary><ul>{detail.occurrences.slice(0, 200).map(occurrence => <li key={`${occurrence.jobId}:${occurrence.solutionIndex}`}>{occurrence.jobId} · returned solution {occurrence.solutionIndex+1}</li>)}</ul></details>
          {(query.compare?.length ?? 0) > 0 && <section><h3>Shortlist comparison</h3><div className="analysis-chips">{query.compare?.map(id => <button key={id} onClick={() => shortlist(id)} title="Remove from comparison">{shortId(id)} ×</button>)}</div>
            {detail.comparison.map(other => <article className="analysis-comparison" key={other.id}><h4><button onClick={() => select(other.id)}>Alternative {shortId(other.id)}</button></h4>
              {other.reasons.map(reason => <p key={reason}>{reason}</p>)}<p>{other.changes.length} changed assignment{other.changes.length === 1 ? '' : 's'} · score difference {other.scoreDelta?.map(fmt).join(' / ') ?? 'unavailable'}</p>
              {other.dimensions.map(d => <p key={d.key}>{d.key}: {fmt(d.selected)} → {fmt(d.alternative)} <strong>{d.delta === 0 ? 'equal' : d.improves ? 'gain' : 'sacrifice'}</strong></p>)}
              <details><summary>Assignment changes</summary>{other.changes.map(c => <p key={c.task}>{c.task}: {c.selected?.id ?? '—'} → {c.alternative?.id ?? '—'}</p>)}</details></article>)}</section>}
        </>}
      </aside></div>
      <footer className="analysis-footer">{data.warnings.map(warning => <p key={warning}>{warning}</p>)}<small>{data.version} · archive {shortId(data.revision)}</small></footer>
    </div>}
    {busy && <p className="analysis-busy" role="status">Comparing stored bindings…</p>}
    {save && data && <SaveDecision query={effective} close={() => setSave(false)} saved={path => { setSave(false); setNotice(`Decision saved as a project-visible draft: ${path}`); }} />}
  </main>;
}

function SourcePicker({ selected, choose }: { selected: string[]; choose: (ids: string[]) => void }) {
  const [items, setItems] = useState<ArchiveSource[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [chosen, setChosen] = useState(selected), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const anchor = chosen[0] ?? '';
  useEffect(() => {
    const controller = new AbortController();
    analysisApi.sources('', anchor, controller.signal).then(response => { if (!controller.signal.aborted) { setItems(response.items); setCursor(response.nextCursor); } })
      .catch(err => { if (!controller.signal.aborted) setError(message(err)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [anchor]);
  return <section className="analysis-source-picker"><h2>Choose the evidence to compare</h2><p>Select one run, or explicitly combine runs with the same verified model and evaluator. Every occurrence keeps its source.</p>
    {error && <p role="alert">{error}</p>}<div>{items.map(source => <label key={source.id}><input type="checkbox" checked={chosen.includes(source.id)}
      disabled={!chosen.includes(source.id) && (!!anchor && source.compatible !== true || !['completed', 'failed', 'cancelled'].includes(source.state))}
      onChange={event => setChosen(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} />
      <span><strong>{source.engine}</strong><small>{new Date(source.createdAt).toLocaleString()} · {source.state}{source.diagnostic ? ' · diagnostic evaluations' : ''}{source.legacy ? ' · legacy, single run only' : ''}</small><code>{source.id}</code></span>
      <button type="button" onClick={() => choose([source.id])} disabled={!['completed', 'failed', 'cancelled'].includes(source.state)}>Open alone</button></label>)}</div>
    {!items.length && !busy && <p>No stored jobs are available. Run a binding case from the workbench first.</p>}
    <div className="analysis-actions"><button disabled={!chosen.length || busy} onClick={() => choose(chosen)}>Compare {chosen.length} selected run{chosen.length === 1 ? '' : 's'}</button>
      {cursor && <button disabled={busy} onClick={() => { setBusy(true); analysisApi.sources(cursor, anchor).then(response => { setItems(old => [...old, ...response.items]); setCursor(response.nextCursor); }).catch(err => setError(message(err))).finally(() => setBusy(false)); }}>Load more runs</button>}</div>
  </section>;
}

function SaveDecision({ query, close, saved }: { query: ArchiveQuery; close: () => void; saved: (path: string) => void }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [org, setOrg] = useState(''), [project, setProject] = useState(''), [title, setTitle] = useState('Binding decision');
  const [slug, setSlug] = useState(() => `binding-decision-${Date.now().toString(36)}`), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); platformApi.organizations().then(setOrganizations).catch(err => setError(message(err))); }, []);
  useEffect(() => { if (!org) return; let active = true; platformApi.projects(org).then(value => { if (active) setProjects(value); }).catch(err => { if (active) setError(message(err)); }); return () => { active = false; }; }, [org]);
  return <dialog ref={dialog} className="analysis-save" onCancel={close}><form onSubmit={event => { event.preventDefault(); setBusy(true);
    analysisApi.save(query, org, project, title, slug).then(report => saved(`/app/${org}/${project}/reports/${report.slug}`)).catch(err => setError(message(err))).finally(() => setBusy(false)); }}>
    <h2>Save the evidence behind your decision</h2><p>This creates a draft visible to members of the selected project. It does not freeze or publish the report.</p>
    <label>Organization<select required value={org} onChange={event => { setOrg(event.target.value); setProject(''); }}><option value="">Choose organization</option>{organizations.map(o => <option key={o.id} value={o.slug}>{o.name}</option>)}</select></label>
    <label>Project<select required value={project} onChange={event => setProject(event.target.value)}><option value="">Choose project</option>{projects.map(p => <option key={p.id} value={p.slug}>{p.name} · {p.visibility}</option>)}</select></label>
    <label>Title<input required value={title} onChange={event => setTitle(event.target.value)} /></label><label>Report slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={event => setSlug(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}<div className="analysis-actions"><button type="button" onClick={close}>Cancel</button><button disabled={busy}>Save draft</button></div></form></dialog>;
}

export function SavedDecision({ document: raw }: { document: unknown }) {
  const document = decisionReceipt(raw);
  if (!document) return <p role="alert">This report contains an invalid decision snapshot. Inspect its raw document.</p>;
  return <div className="analysis-saved"><p>{document.scope}</p>{document.selected.map(selected => <article key={selected.row.id}>
    <h3>Binding {shortId(selected.row.id)}</h3><p>{selected.explanation.formula}</p><p>Recorded score: {selected.row.score?.map(fmt).join(' / ') ?? 'not eligible'}</p>
    <dl>{selected.explanation.components.map(c => <div key={c.key}><dt>{c.key}</dt><dd>{fmt(c.value)} · priority {fmt(c.weight)}</dd></div>)}</dl>
    <details><summary>Recorded assignment</summary><pre>{JSON.stringify(selected.binding, null, 2)}</pre></details></article>)}</div>;
}
