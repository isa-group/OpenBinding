import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { StudyCell } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { LayoutGrid } from 'lucide-react';
import { StateChip } from './parts';
import {
  CELLS_PER_PAGE, RUNTIME, countStates, describeParameters, engineKeyOf, enginesOf, formatMeasure, formatSeconds, heatLevel, isRetryable, matrixView,
  measureLabel, measureValue, metricsOf, revisionLabel, slot, type RevisionInfo,
} from './studiesModel';

interface Where {
  /** `/app/:org/:project/studies/:study/runs/:run` */
  runPath: string;
  index: ReadonlyMap<string, RevisionInfo>;
}

function cellText(cell: StudyCell, measure: string): { top: string; sub: string } {
  const metrics = metricsOf(cell);
  if (cell.state === 'failed') return { top: 'Failed', sub: metrics.code ?? 'no result' };
  if (cell.state === 'cancelled') return { top: 'Cancelled', sub: 'not run' };
  if (cell.state === 'queued') return { top: 'Queued', sub: 'waiting' };
  if (cell.state === 'running') return { top: 'Running', sub: 'solving' };
  const value = measureValue(cell, measure);
  const took = metrics.runtimeSeconds;
  const sub = metrics.feasible === false ? 'infeasible' : measure === RUNTIME ? '' : took !== undefined ? formatSeconds(took) : '';
  return { top: value === null ? 'Done' : formatMeasure(value), sub };
}

/** The cells of a run as the matrix they came from, each coloured by one measure (lower is better) and linking to its own page. */
export function RunHeatmap({ cells, measure, where }: { cells: readonly StudyCell[]; measure: string; where: Where }) {
  const view = matrixView(cells);
  const values = cells.map((cell) => measureValue(cell, measure)).filter((value): value is number => value !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  return (
    <div className="st-grid-scroll" tabIndex={0} role="region" aria-label="Cells of the run as a matrix">
      <table className="st-grid is-heat">
        <thead>
          <tr>
            <th scope="col">Case</th>
            {view.columns.map((column) => <th key={column.key} scope="col" className="st-grid-head">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row}>
              <th scope="row">{revisionLabel(where.index, row, true)}</th>
              {view.columns.map((column) => {
                const cell = view.at.get(slot(row, column.key));
                if (!cell) return <td key={column.key} className="st-grid-gap" aria-label="No cell">·</td>;
                const text = cellText(cell, measure);
                const value = cell.state === 'completed' ? measureValue(cell, measure) : null;
                const tone = value !== null ? `is-level-${heatLevel(value, min, max)}` : cell.state === 'completed' ? 'is-level-none' : `is-${cell.state}`;
                return (
                  <td key={column.key}>
                    <Link
                      to={`${where.runPath}/cells/${cell.id}`}
                      viewTransition
                      className={`st-heat ${tone}${metricsOf(cell).feasible === false && cell.state === 'completed' ? ' is-infeasible' : ''}`}
                      aria-label={`Cell ${cell.ordinal}, ${revisionLabel(where.index, row, true)}, ${column.label}: ${cell.state}${value !== null ? `, ${measureLabel(measure)} ${formatMeasure(value)}` : ''}`}
                    >
                      <b>{text.top}</b>
                      {text.sub && <small>{text.sub}</small>}
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATE_FILTERS = [
  { id: '', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'pending', label: 'In progress' },
] as const;

const bucket = (state: string): string => (state === 'queued' || state === 'running' || state === 'partial' ? 'pending' : state);

interface CellTableProps {
  cells: readonly StudyCell[];
  where: Where;
  /** Whoever may retry (MEMBER). */
  canRetry: boolean;
  retrying: string | null;
  onRetry: (cell: StudyCell) => void;
}

/** Every cell of a run in a table: filter by engine and by state, page through, and retry the ones that did not finish. */
export function CellTable({ cells, where, canRetry, retrying, onRetry }: CellTableProps) {
  const [engine, setEngine] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(0);
  const engines = enginesOf(cells);
  const counts = countStates(cells);
  const objectives = [...new Set(cells.flatMap((cell) => Object.keys(metricsOf(cell).objectives)))].slice(0, 2);
  const stateCount = (id: string) => (id === '' ? cells.length : cells.filter((cell) => bucket(cell.state) === id).length);

  const filtered = cells.filter((cell) => (!engine || engineKeyOf(cell.engine_ref) === engine) && (!state || bucket(cell.state) === state));
  const pages = Math.max(1, Math.ceil(filtered.length / CELLS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * CELLS_PER_PAGE, (current + 1) * CELLS_PER_PAGE);
  const columns = 6 + objectives.length;

  return (
    <section className="st-card" aria-labelledby="st-cells-title">
      <h2 id="st-cells-title">All cells</h2>
      <div className="st-filters">
        {engines.length > 1 && (
          <FilterPills
            ariaLabel="Engine"
            value={engine}
            onChange={(id) => { setEngine(id); setPage(0); }}
            options={[{ id: '', label: 'All engines' }, ...engines.map((item) => ({ id: item.key, label: item.label }))]}
          />
        )}
        <FilterPills
          ariaLabel="State"
          value={state}
          onChange={(id) => { setState(id); setPage(0); }}
          options={STATE_FILTERS.map((item) => ({ id: item.id, label: `${item.label} (${stateCount(item.id)})` }))}
        />
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={<LayoutGrid />} title="No cells match these filters">Try another engine or state.</EmptyState>
      ) : (
        <DataTable label="Cells of the run" minWidth={140 * columns}>
          <thead>
            <tr>
              <th scope="col">Cell</th>
              <th scope="col">Case</th>
              <th scope="col">Engine · seed</th>
              <th scope="col">State</th>
              {objectives.map((name) => <th key={name} scope="col">{measureLabel(name)}</th>)}
              <th scope="col">Took</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((cell) => {
              const metrics = metricsOf(cell);
              return (
                <tr key={cell.id}>
                  <td><Link to={`${where.runPath}/cells/${cell.id}`} viewTransition aria-label={`Open cell ${cell.ordinal}`}>#{cell.ordinal}</Link></td>
                  <td>{revisionLabel(where.index, cell.binding_case_revision_id, true)}</td>
                  <td>
                    {cell.engine_ref.name ?? 'engine'} · seed {cell.seed}
                    <small className="org-muted">{describeParameters(cell.parameters)}</small>
                  </td>
                  <td><StateChip state={cell.state} /></td>
                  {objectives.map((name) => <td key={name}>{formatMeasure(metrics.objectives[name])}</td>)}
                  <td>{formatSeconds(metrics.runtimeSeconds)}</td>
                  <td className="job-actions-cell">
                    {canRetry && isRetryable(cell.state) && (
                      <button type="button" className="job-link-button" disabled={retrying !== null} onClick={() => onRetry(cell)} aria-label={`Retry cell ${cell.ordinal}`}>
                        {retrying === cell.id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      {filtered.length > CELLS_PER_PAGE && (
        <nav className="job-pager" aria-label="Pages of cells">
          <Action variant="secondary" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Action>
          <span aria-live="polite">Showing {current * CELLS_PER_PAGE + 1}–{Math.min(filtered.length, (current + 1) * CELLS_PER_PAGE)} of {filtered.length}</span>
          <Action variant="secondary" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Action>
        </nav>
      )}
      <small className="org-muted">{Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(' · ')}</small>
    </section>
  );
}
