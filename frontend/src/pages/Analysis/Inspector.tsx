import { formatNumber as fmt, shortId, type ArchiveQuery, type ArchiveResponse, type CandidateDetail } from '../../analysis/archive';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Skeleton } from '../../components/ui/Skeleton';
import { Fact } from './parts';

interface InspectorProps {
  data: ArchiveResponse;
  detail: CandidateDetail | null;
  selected: string | undefined;
  query: ArchiveQuery;
  failed: boolean;
  select: (id: string) => void;
  shortlist: (id: string) => void;
  change: (values: Partial<ArchiveQuery>) => void;
}

const METRICS: Array<{ id: NonNullable<ArchiveQuery['metric']>; label: string }> = [
  { id: 'euclidean', label: 'Euclidean · normalised losses' },
  { id: 'manhattan', label: 'Manhattan · normalised losses' },
  { id: 'hamming', label: 'Hamming · changed assignments' },
  { id: 'gower', label: 'Gower · losses and assignments' },
];

/** One binding in full: what it chose, what each objective contributes to its score, who beats it and what lies nearby. */
export function Inspector({ data, detail, selected, query, failed, select, shortlist, change }: InspectorProps) {
  if (!selected) return null;
  const loaded = detail && detail.row.id === selected ? detail : null;
  const shortlisted = query.compare?.includes(selected) ?? false;
  return (
    <section className="an-card an-inspector" aria-labelledby="an-inspector-title" aria-busy={!loaded && !failed}>
      <header className="an-card-head">
        <h2 id="an-inspector-title">Inspector · Binding {shortId(selected)}</h2>
        <Action variant="secondary" size="sm" onClick={() => shortlist(selected)}>{shortlisted ? 'Remove from shortlist' : 'Add to shortlist'}</Action>
      </header>

      {!loaded && !failed && <div role="status"><span className="sr-only">Loading the evidence of the selected binding…</span><Skeleton variant="tile" /></div>}
      {!loaded && failed && <p className="an-empty-line">The detail of this binding isn’t available right now.</p>}

      {loaded && (
        <>
          <p className="an-lede">{loaded.explanation.summary}</p>
          <div className="an-facts">
            <Fact label="Rank">{loaded.row.eligible ? loaded.row.rank ?? '—' : 'Not eligible'}</Fact>
            <Fact label="Preference score">{loaded.row.score?.map(fmt).join(' / ') ?? '—'}</Fact>
            <Fact label="Original model score">{Array.isArray(loaded.row.modelScore) ? loaded.row.modelScore.map(fmt).join(' / ') : fmt(loaded.row.modelScore)}</Fact>
            <Fact label="Occurrences">{loaded.occurrences.length.toLocaleString('en-US')}</Fact>
          </div>
          {!loaded.row.eligible && loaded.row.reasons.length > 0 && <p className="an-note">{loaded.row.reasons.join('. ')}.</p>}

          <h3>What contributes to this choice</h3>
          <div className="an-table-scroll">
            <table className="an-table">
              <thead><tr><th scope="col">Objective</th><th scope="col">Raw</th><th scope="col">0–1 scale</th><th scope="col">Priority</th><th scope="col">Contribution</th></tr></thead>
              <tbody>
                {loaded.explanation.components.map((component) => (
                  <tr key={component.key}>
                    <th scope="row">{component.key}</th>
                    <td>{fmt(component.value)}</td>
                    <td>{fmt(component.normalized)}</td>
                    <td>{fmt(component.weight)}</td>
                    <td>
                      <span className="an-contribution">
                        <span className="an-meter" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, (component.normalized ?? 0) * 100))}%` }} /></span>
                        {fmt(component.weightedLoss)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Assignment</h3>
          <dl className="an-assignment">
            {Object.entries(loaded.binding).map(([task, ref]) => (
              <div key={task}>
                <dt>{task}</dt>
                <dd>{typeof ref?.resource === 'string' && typeof ref?.id === 'string' ? <>{ref.id} <small>{ref.resource}</small></> : JSON.stringify(ref)}</dd>
              </div>
            ))}
          </dl>

          <h3>Dominance and nearby alternatives</h3>
          <p>
            {loaded.dominance.computed
              ? `${loaded.dominance.dominatorCount} stored feasible binding${loaded.dominance.dominatorCount === 1 ? '' : 's'} dominate this one in the ${loaded.dominance.scope} scope.`
              : 'Incomplete objectives prevent a dominance comparison.'}
          </p>
          {loaded.dominance.dominators.length > 0 && (
            <div className="an-chips" aria-label="Bindings that dominate this one">
              {loaded.dominance.dominators.slice(0, 10).map((id) => <button key={id} type="button" onClick={() => select(id)}>{shortId(id)}</button>)}
            </div>
          )}
          <label className="an-field">
            <span>Distance</span>
            <select value={query.metric ?? 'euclidean'} onChange={(event) => change({ metric: event.target.value as ArchiveQuery['metric'] })}>
              {METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
            </select>
          </label>
          <ol className="an-neighbours" aria-label="Nearest stored bindings">
            {loaded.neighbors.map((neighbour) => (
              <li key={neighbour.id}><button type="button" onClick={() => select(neighbour.id)}>{shortId(neighbour.id)}</button><span>{fmt(neighbour.distance)}</span></li>
            ))}
          </ol>
          <small className="an-note">Proximity describes stored alternatives; it does not establish robustness to new conditions.</small>

          {(query.compare?.length ?? 0) > 0 && (
            <>
              <h3>Shortlist comparison</h3>
              <div className="an-chips">
                {query.compare?.map((id) => <button key={id} type="button" title="Remove from comparison" onClick={() => shortlist(id)}>{shortId(id)} ×</button>)}
              </div>
              {loaded.comparison.map((other) => (
                <article className="an-comparison" key={other.id}>
                  <h4><button type="button" onClick={() => select(other.id)}>Alternative {shortId(other.id)}</button></h4>
                  {other.reasons.map((reason) => <p key={reason}>{reason}</p>)}
                  <p>{other.changes.length} changed assignment{other.changes.length === 1 ? '' : 's'} · score difference {other.scoreDelta?.map(fmt).join(' / ') ?? 'unavailable'}</p>
                  <ul className="an-deltas">
                    {other.dimensions.map((dimension) => (
                      <li key={dimension.key}>
                        <span>{dimension.key}: {fmt(dimension.selected)} → {fmt(dimension.alternative)}</span>
                        <Chip tone={dimension.delta === 0 ? 'plain' : dimension.improves ? 'success' : 'warning'}>{dimension.delta === 0 ? 'equal' : dimension.improves ? 'gain' : 'sacrifice'}</Chip>
                      </li>
                    ))}
                  </ul>
                  {other.changes.length > 0 && (
                    <details><summary>Assignment changes</summary>{other.changes.map((change) => <p key={change.task}>{change.task}: {change.selected?.id ?? '—'} → {change.alternative?.id ?? '—'}</p>)}</details>
                  )}
                </article>
              ))}
            </>
          )}

          <details className="an-source-view">
            <summary>View source</summary>
            <p>{loaded.explanation.formula}</p>
            <p>Near ties use tolerance {loaded.explanation.nearTieTolerance} × max(1, |a|, |b|); exact ties stay separate from near ties. The receipt keeps full precision. {loaded.explanation.nearTie ? 'The next score is numerically close; it is not merged into this tie group.' : ''}</p>
            <p>Binding identity <code>{loaded.row.id}</code> · fixed archive: {loaded.explanation.normalizationScope}</p>
            <ul>{loaded.occurrences.slice(0, 200).map((occurrence) => <li key={`${occurrence.jobId}:${occurrence.solutionIndex}`}>job {occurrence.jobId} · returned solution {occurrence.solutionIndex + 1}</li>)}</ul>
            <pre aria-label="Constraints and raw metrics">{JSON.stringify(loaded.evaluation, null, 2)}</pre>
          </details>
        </>
      )}
      <small className="an-note">From {data.sources.length} source{data.sources.length === 1 ? '' : 's'} · archive {shortId(data.revision)}</small>
    </section>
  );
}
