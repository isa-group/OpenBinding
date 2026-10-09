import { Link } from 'react-router-dom';
import type { StudyCell } from '../../api/platform';
import { DataTable } from '../../components/ui/DataTable';
import { axisOf, engineColor, measureTitle, percentOf, rankEngines, type EngineRow, type Point, type SeedGroup } from './analyticsModel';
import { RUNTIME, formatMeasure, formatSeconds, measureLabel, metricsOf, plural } from './studiesModel';

const round = (value: number): number => Math.round(value * 10) / 10;

/** Cost found, per engine: where each engine's values fall on one shared axis, as a range, its middle half, its median and its dots. */
export function DistributionPlot({ rows, measure }: { rows: readonly EngineRow[]; measure: string }) {
  const axis = axisOf(rows.flatMap((row) => row.values.map((item) => item.value)));
  const at = (value: number) => round(percentOf(value, axis.low, axis.high));
  const unit = measure === RUNTIME ? 's' : '';
  return (
    <div className="st-dist">
      {rows.map((row) => {
        const spread = row.spread;
        const summary = spread
          ? `${row.label}: ${plural(row.values.length, 'value')} from ${formatMeasure(spread.min)}${unit} to ${formatMeasure(spread.max)}${unit}, median ${formatMeasure(spread.median)}${unit}`
          : `${row.label}: no value to show`;
        return (
          <div key={row.key} className="st-dist-row">
            <span className="st-dist-label">{row.label}</span>
            <div className="st-dist-track" role="img" aria-label={summary}>
              {spread && <i className="st-dist-range" style={{ left: `${at(spread.min)}%`, width: `${Math.max(0.5, at(spread.max) - at(spread.min))}%` }} />}
              {spread && row.values.length >= 5 && <i className="st-dist-box" style={{ left: `${at(spread.q1)}%`, width: `${Math.max(0.5, at(spread.q3) - at(spread.q1))}%` }} />}
              {spread && row.values.length >= 5 && <i className="st-dist-median" style={{ left: `${at(spread.median)}%` }} />}
              {row.values.length <= 60 && row.values.map((item) => (
                <i key={item.cell.id} className="st-dot" title={`Cell ${item.cell.ordinal} · seed ${item.cell.seed} · ${formatMeasure(item.value)}${unit}`} style={{ left: `${at(item.value)}%`, background: engineColor(row.position) }} />
              ))}
            </div>
            <span className="st-dist-note">{spread ? `median ${formatMeasure(spread.median)}${unit}` : '—'}</span>
          </div>
        );
      })}
      <span className="st-axis"><span>{formatMeasure(axis.low)}</span><span>{measure === RUNTIME ? 'seconds' : 'lower is better'}</span><span>{formatMeasure(axis.high)}</span></span>
      {rows.some((row) => row.values.length >= 5) && <small className="org-muted">The line spans every value, the box the middle half and the tick the median.</small>}
    </div>
  );
}

const BAR_LIMIT = 48;

/** Time taken per cell, one bar each, coloured by engine. */
export function TimeBars({ cells, rows }: { cells: readonly StudyCell[]; rows: readonly EngineRow[] }) {
  const timed = cells
    .filter((cell) => cell.state === 'completed' && metricsOf(cell).runtimeSeconds !== undefined)
    .sort((a, b) => a.ordinal - b.ordinal);
  const shown = timed.slice(0, BAR_LIMIT);
  const top = Math.max(0, ...shown.map((cell) => metricsOf(cell).runtimeSeconds ?? 0));
  const colour = new Map(rows.map((row) => [row.key, engineColor(row.position)]));
  const summary = rows
    .map((row) => {
      const seconds = row.cells.flatMap((cell) => (cell.state === 'completed' && metricsOf(cell).runtimeSeconds !== undefined ? [metricsOf(cell).runtimeSeconds as number] : []));
      return seconds.length ? `${row.label} took ${formatSeconds(Math.min(...seconds))} to ${formatSeconds(Math.max(...seconds))}` : null;
    })
    .filter(Boolean)
    .join('; ');
  if (shown.length === 0) return <p className="org-muted">No completed cell recorded its time.</p>;
  return (
    <>
      <div className={`st-bars${shown.length > 16 ? ' is-dense' : ''}`} role="img" aria-label={summary}>
        {shown.map((cell) => {
          const seconds = metricsOf(cell).runtimeSeconds ?? 0;
          const engine = rows.find((row) => row.cells.includes(cell));
          return (
            <span key={cell.id} title={`Cell ${cell.ordinal} · ${engine?.label ?? 'engine'} · ${formatSeconds(seconds)}`}>
              <b>{formatSeconds(seconds)}</b>
              <i style={{ height: `${top > 0 ? Math.max(3, Math.round((seconds / top) * 110)) : 3}px`, background: colour.get(engine?.key ?? '') ?? 'var(--tp-primary)' }} />
            </span>
          );
        })}
      </div>
      <span className="st-legend">
        {rows.map((row) => <span key={row.key}><i style={{ background: engineColor(row.position) }} aria-hidden="true" />{row.label}</span>)}
        {timed.length > shown.length && <span>First {shown.length} of {timed.length.toLocaleString('en-US')} cells</span>}
      </span>
    </>
  );
}

/** Two measures plotted against each other for one case revision; the cells nobody beats on both are the best trade-offs. */
export function TradeoffPlot({ points, xName, yName }: { points: readonly Point[]; xName: string; yName: string }) {
  const xAxis = axisOf(points.map((point) => point.x));
  const yAxis = axisOf(points.map((point) => point.y));
  const front = points.filter((point) => point.front);
  const summary = `${plural(points.length, 'result')} plotted by ${measureLabel(xName)} and ${measureLabel(yName)}; ${plural(front.length, 'is a best trade-off', 'are best trade-offs')}: ${front.map((point) => `${formatMeasure(point.x)} and ${formatMeasure(point.y)}`).join('; ')}`;
  return (
    <>
      <div className="st-scatter-wrap">
        <span className="st-scatter-y">{measureLabel(yName)} · {formatMeasure(yAxis.high)}</span>
        <div className="st-scatter" role="img" aria-label={summary}>
          {[...points].sort((a, b) => Number(a.front) - Number(b.front)).map((point) => (
            <i
              key={point.cell.id}
              className={point.front ? 'is-front' : undefined}
              title={`Cell ${point.cell.ordinal} · ${formatMeasure(point.x)} ${measureLabel(xName)} · ${formatMeasure(point.y)} ${measureLabel(yName)}`}
              style={{ left: `${round(percentOf(point.x, xAxis.low, xAxis.high))}%`, bottom: `${round(percentOf(point.y, yAxis.low, yAxis.high))}%` }}
            />
          ))}
        </div>
        <span className="st-axis"><span>{formatMeasure(xAxis.low)}</span><span>{measureLabel(xName)} →</span><span>{formatMeasure(xAxis.high)}</span></span>
      </div>
      <span className="st-legend"><span><i className="is-front" aria-hidden="true" />best trade-off</span><span><i aria-hidden="true" />beaten on both</span></span>
    </>
  );
}

/** Engines side by side on one measure, best mean first: the ranking. */
export function RankingTable({ rows, measure }: { rows: readonly EngineRow[]; measure: string }) {
  const ranked = rankEngines(rows);
  const best = ranked[0]?.spread?.mean;
  return (
    <DataTable label={`Engines ranked by ${measureLabel(measure).toLowerCase()}`} minWidth={720}>
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Engine</th>
          <th scope="col">Completed</th>
          <th scope="col">Feasible</th>
          <th scope="col">Best</th>
          <th scope="col">Median</th>
          <th scope="col">Mean</th>
          <th scope="col">Worst</th>
          <th scope="col">Mean time</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((row, position) => (
          <tr key={row.key}>
            <td>{row.spread ? <span className={`st-rank${position === 0 ? ' is-first' : ''}`}>{position + 1}</span> : '—'}</td>
            <td><span className="st-swatch" style={{ background: engineColor(row.position) }} aria-hidden="true" />{row.label}</td>
            <td>{row.completed.length} of {row.cells.length}</td>
            <td>{row.feasible}</td>
            <td>{formatMeasure(row.spread?.min)}</td>
            <td>{formatMeasure(row.spread?.median)}</td>
            <td>
              {formatMeasure(row.spread?.mean)}
              {row.spread && best !== undefined && position > 0 && best !== 0 && row.spread.mean > best && <small className="org-muted">+{Math.round(((row.spread.mean - best) / Math.abs(best)) * 100)}% vs first</small>}
            </td>
            <td>{formatMeasure(row.spread?.max)}</td>
            <td>{formatSeconds(row.meanSeconds)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/** Same inputs, different seed: the value each seed found, and how far apart they are. */
export function SeedTable({ groups, measure, runPath }: { groups: readonly SeedGroup[]; measure: string; runPath: string }) {
  return (
    <DataTable label="Results by seed" minWidth={640}>
      <thead>
        <tr>
          <th scope="col">Case · engine</th>
          <th scope="col">{measureTitle(measure)} by seed</th>
          <th scope="col">Difference</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.key}>
            <td>{group.label}<small className="org-muted">{group.setting}</small></td>
            <td>
              <span className="st-seed-values">
                {group.seeds.map((item) => (
                  <Link key={item.cell.id} to={`${runPath}/cells/${item.cell.id}`} viewTransition>seed {item.seed}: {item.value !== null ? formatMeasure(item.value) : item.cell.state}</Link>
                ))}
              </span>
            </td>
            <td>{group.spread === null ? '—' : group.spread === 0 ? 'identical' : formatMeasure(group.spread)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
