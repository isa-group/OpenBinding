import { formatNumber as fmt, shortId, type ArchiveQuery, type ArchiveResponse, type ArchiveRow } from '../../analysis/archive';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { RULES, lossSegments, longestLoss } from './analysisModel';

interface RankingProps {
  data: ArchiveResponse;
  query: ArchiveQuery;
  selected: string | undefined;
  busy: boolean;
  select: (id: string) => void;
  shortlist: (id: string) => void;
  change: (values: Partial<ArchiveQuery>) => void;
}

/** The recommendation under the chosen rule, and the binding that comes next. */
export function Recommendation({ data, select, compareWith }: { data: ArchiveResponse; select: (id: string) => void; compareWith: (winner: string, other: string) => void }) {
  const winner = data.winners[0];
  const next = data.next[0];
  return (
    <section className="an-reco" aria-label="Recommendation">
      <div className="an-reco-main">
        <span className="an-eyebrow">{RULES[data.rule]} · {data.winnerCount > 1 ? `${data.winnerCount} co-winners` : 'Preferred under your rule'}</span>
        <h2>{winner ? <button type="button" onClick={() => select(winner.id)}>Binding {shortId(winner.id)}</button> : 'No stored binding meets these requirements'}</h2>
        <p>{winner ? data.formula : 'Adjust the requirements or choose other results. This does not prove that no feasible binding exists.'}</p>
        {data.winnerCount > 1 && (
          <div className="an-chips">
            {data.winners.slice(0, 8).map((row) => <button key={row.id} type="button" onClick={() => select(row.id)}>{shortId(row.id)}</button>)}
            {data.winnerCount > 8 && <span>All ties remain in the ranking.</span>}
          </div>
        )}
      </div>
      <div className="an-next">
        <span>Next distinct score group{data.nextCount > 1 ? ` · ${data.nextCount} tied` : ''}</span>
        {next ? (
          <>
            <button type="button" onClick={() => { select(next.id); if (winner) compareWith(winner.id, next.id); }}>Binding {shortId(next.id)}</button>
            <code>{next.score?.map(fmt).join(' / ')}</code>
          </>
        ) : <small>No worse eligible score group.</small>}
      </div>
    </section>
  );
}

function statusOf(row: ArchiveRow): { label: string; tone: 'success' | 'warning' | 'plain' } {
  if (row.eligible) return { label: 'Eligible', tone: 'success' };
  if (row.feasible === false) return { label: 'Hard-infeasible', tone: 'warning' };
  if (row.feasible === null) return { label: 'Unknown', tone: 'plain' };
  return { label: 'Excluded', tone: 'plain' };
}

/** Every stored binding in rank order: the bar shows where each one's weighted loss comes from, shorter being closer to the ideal. */
export function Ranking({ data, query, selected, busy, select, shortlist, change }: RankingProps) {
  const longest = longestLoss(data.rows, data);
  const first = data.total ? data.page * data.pageSize + 1 : 0;
  const last = Math.min(data.total, (data.page + 1) * data.pageSize);
  return (
    <section className="an-card an-ranking" aria-labelledby="an-ranking-title">
      <header className="an-card-head">
        <h2 id="an-ranking-title">Ranking <small>lower score is better · exact ties are kept together</small></h2>
        <span className="an-tools">
          <Action variant="secondary" size="sm" onClick={() => change({ viewport: null, page: 0 })} disabled={!query.viewport}>Clear spatial selection</Action>
        </span>
      </header>
      <div className="an-filters">
        <label className="an-field">
          <span>Find binding or assignment</span>
          <input type="search" value={query.search ?? ''} onChange={(event) => change({ search: event.target.value, page: 0 })} />
        </label>
        <label className="an-field">
          <span>Show</span>
          <select value={query.status ?? 'all'} onChange={(event) => change({ status: event.target.value as ArchiveQuery['status'], page: 0 })}>
            {['all', 'eligible', 'feasible', 'infeasible', 'unknown', 'excluded'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      {data.rows.length === 0 ? (
        <p className="an-empty-line">No bindings match this filter. Recommendations still use every eligible binding.</p>
      ) : (
        <ol className="an-ranks" start={first}>
          {data.rows.map((row) => {
            const status = statusOf(row);
            const on = row.id === selected;
            const facts = data.dimensions.flatMap((dimension, index) => (dimension.constant ? [] : [`${dimension.label} ${fmt(row.values?.[index])}${dimension.unit ? ` ${dimension.unit}` : ''}`]));
            return (
              <li key={row.id} className={`an-rank${on ? ' is-selected' : ''}`}>
                <button type="button" className="an-rank-main" aria-pressed={on} aria-label={`Inspect binding ${shortId(row.id)}`} title={row.id} onClick={() => select(row.id)}>
                  <span className={`an-badge${row.rank === 1 ? ' is-top' : ''}`}>{row.rank ?? '—'}</span>
                  <span className="an-rank-text">
                    <strong>Binding {shortId(row.id)}{row.scoreGroup === 1 && data.winnerCount > 1 ? ' (tie)' : ''}</strong>
                    <small>{facts.join(' · ') || `${row.occurrences} occurrence${row.occurrences === 1 ? '' : 's'}`}</small>
                  </span>
                  <span className="an-rank-score">
                    <span className="an-bar" aria-hidden="true">
                      {lossSegments(row, data, longest).map((segment) => <i key={segment.key} style={{ width: `${segment.width}%`, background: segment.colour }} />)}
                    </span>
                    <small>score {row.score?.map(fmt).join(' / ') ?? '—'}{row.paretoRank ? ` · front ${row.paretoRank}` : ''}</small>
                  </span>
                </button>
                <span className="an-rank-side">
                  <Chip tone={status.tone}>{status.label}</Chip>
                  <label className="an-compare">
                    <input type="checkbox" aria-label={`Compare ${shortId(row.id)}`} checked={query.compare?.includes(row.id) ?? false} onChange={() => shortlist(row.id)} />
                    Compare
                  </label>
                </span>
                {row.reasons.length > 0 && (
                  <details className="an-reasons"><summary>Why?</summary>{row.reasons.map((reason) => <p key={reason}>{reason}</p>)}</details>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="an-pager">
        <Action variant="secondary" size="sm" disabled={!data.page || busy} onClick={() => change({ page: data.page - 1 })}>Previous</Action>
        <span>{first ? `${first}–${last}` : '0'} of {data.total.toLocaleString('en-US')}</span>
        <Action variant="secondary" size="sm" disabled={(data.page + 1) * data.pageSize >= data.total || busy} onClick={() => change({ page: data.page + 1 })}>Next</Action>
      </div>
    </section>
  );
}
