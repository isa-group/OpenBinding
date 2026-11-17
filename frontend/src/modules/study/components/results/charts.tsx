// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-analytics-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's chart card (a titled card, recharts 220 px high, the theme's grid and ticks) as the composition analytics
// tab draws it, over the cells of one study run instead of a pricing's history: each engine's values on one axis, the time
// each cell took, and two objectives against each other with the gateway's front marked. Each chart says what it shows in
// words and has its data behind "Show data", as OpenBinding's charts must.

import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { DataTable } from '../../../core/components/data-table';
import type { StudyCell } from '../../api/studiesApi';
import {
  engineColor,
  measureTitle,
  rankEngines,
  spreadText,
  type EngineRow,
  type Point,
  type SeedGroup,
} from '../../utils/analyticsModel';
import {
  RUNTIME,
  formatMeasure,
  formatSeconds,
  measureLabel,
  metricsOf,
} from '../../utils/studiesModel';
import { LINK, MUTED } from '../../utils/ui';

const TICK = { fontSize: 11, fill: 'var(--color-tp-slate)' };
const MARGIN = { top: 12, right: 12, bottom: 4, left: 0 };
const HEIGHT = 220;
const GRID = 'var(--color-tp-hairline-soft)';
const AXIS = 'var(--color-tp-hairline)';

/** A chart with its title and a table that says the same, one or the other on screen. */
export function ChartCard({
  title,
  note,
  summary,
  tools,
  chart,
  table,
  footer,
}: {
  title: string;
  note?: string;
  summary: string;
  tools?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
}) {
  const id = useId();
  const [asTable, setAsTable] = useState(false);
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
      aria-labelledby={id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold text-tp-ink">
            {title}
          </h2>
          {note && <p className={MUTED}>{note}</p>}
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium text-tp-accent hover:bg-tp-surface"
          aria-expanded={asTable}
          onClick={() => setAsTable(current => !current)}
        >
          {asTable ? 'Show chart' : 'Show data'}
        </button>
      </div>
      {tools}
      {asTable ? (
        table
      ) : (
        <div role="img" aria-label={summary}>
          {chart}
        </div>
      )}
      {footer}
    </section>
  );
}

/** Each engine's values on one shared axis, one row of dots per engine (lower is better). */
export function DistributionChart({
  rows,
  measure,
}: {
  rows: readonly EngineRow[];
  measure: string;
}) {
  const summary = rows.map(row => spreadText(row, measure)).join('; ');
  const labels = rows.map(row => row.label);
  return (
    <ChartCard
      title={`${measureTitle(measure)}, per engine`}
      note={`${measure === RUNTIME ? 'seconds' : 'objective'} · lower is better`}
      summary={summary}
      chart={
        <ResponsiveContainer width="100%" height={Math.max(HEIGHT, 60 + rows.length * 36)}>
          <ScatterChart margin={MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
            <XAxis
              type="number"
              dataKey="value"
              name={measureLabel(measure)}
              tick={TICK}
              stroke={AXIS}
              domain={['auto', 'auto']}
              tickFormatter={value => formatMeasure(Number(value))}
            />
            <YAxis
              type="category"
              dataKey="engine"
              allowDuplicatedCategory={false}
              ticks={labels}
              tick={TICK}
              stroke={AXIS}
              width={110}
            />
            <ZAxis range={[48, 48]} />
            <Tooltip
              isAnimationActive={false}
              formatter={value => formatMeasure(Number(value))}
              cursor={{ strokeDasharray: '3 3' }}
            />
            {rows.map(row => (
              <Scatter
                key={row.key}
                name={row.label}
                data={row.values.map(item => ({
                  engine: row.label,
                  value: item.value,
                  cell: item.cell.ordinal,
                }))}
                fill={engineColor(row.position)}
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      }
      table={
        <DataTable label={`${measureTitle(measure)} of each engine`} minWidth={480}>
          <thead>
            <tr>
              <th scope="col">Engine</th>
              <th scope="col">Values</th>
              <th scope="col">Lowest</th>
              <th scope="col">Median</th>
              <th scope="col">Highest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{row.values.length}</td>
                <td>{formatMeasure(row.spread?.min)}</td>
                <td>{formatMeasure(row.spread?.median)}</td>
                <td>{formatMeasure(row.spread?.max)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      }
    />
  );
}

const BAR_LIMIT = 48;

/** Time taken per cell, one bar each, coloured by engine. */
export function TimeChart({
  cells,
  rows,
}: {
  cells: readonly StudyCell[];
  rows: readonly EngineRow[];
}) {
  const timed = cells
    .filter(cell => cell.state === 'completed' && metricsOf(cell).runtimeSeconds !== undefined)
    .sort((a, b) => a.ordinal - b.ordinal);
  const shown = timed.slice(0, BAR_LIMIT);
  const engineOf = (cell: StudyCell) => rows.find(row => row.cells.includes(cell));
  const data = shown.map(cell => {
    const engine = engineOf(cell);
    return {
      cell: `#${cell.ordinal}`,
      seconds: metricsOf(cell).runtimeSeconds ?? 0,
      engine: engine?.label ?? 'engine',
      colour: engine ? engineColor(engine.position) : engineColor(0),
    };
  });
  const summary = rows
    .map(row => {
      const seconds = row.cells.flatMap(cell =>
        cell.state === 'completed' && metricsOf(cell).runtimeSeconds !== undefined
          ? [metricsOf(cell).runtimeSeconds as number]
          : []
      );
      return seconds.length
        ? `${row.label} took ${formatSeconds(Math.min(...seconds))} to ${formatSeconds(Math.max(...seconds))}`
        : null;
    })
    .filter(Boolean)
    .join('; ');
  return (
    <ChartCard
      title="Time taken per cell"
      note={
        timed.length > shown.length
          ? `First ${shown.length} of ${timed.length.toLocaleString('en-US')} cells`
          : 'seconds · one bar per completed cell'
      }
      summary={summary || 'No completed cell recorded its time.'}
      chart={
        shown.length === 0 ? (
          <p className={MUTED}>No completed cell recorded its time.</p>
        ) : (
          <ResponsiveContainer width="100%" height={HEIGHT}>
            <BarChart data={data} margin={MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="cell" tick={TICK} stroke={AXIS} />
              <YAxis
                tick={TICK}
                stroke={AXIS}
                width={44}
                tickFormatter={value => formatSeconds(Number(value))}
              />
              <Tooltip
                isAnimationActive={false}
                formatter={value => formatSeconds(Number(value))}
                cursor={{ fill: 'var(--color-tp-surface)' }}
              />
              <Bar dataKey="seconds" name="Took" isAnimationActive={false}>
                {data.map(item => (
                  <Cell key={item.cell} fill={item.colour} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )
      }
      table={
        <DataTable label="Time taken by each cell" minWidth={420}>
          <thead>
            <tr>
              <th scope="col">Cell</th>
              <th scope="col">Engine</th>
              <th scope="col">Took</th>
            </tr>
          </thead>
          <tbody>
            {data.map(item => (
              <tr key={item.cell}>
                <td>{item.cell}</td>
                <td>{item.engine}</td>
                <td>{formatSeconds(item.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      }
      footer={
        <span className="flex flex-wrap gap-3 text-[11px] text-tp-steel">
          {rows.map(row => (
            <span key={row.key} className="inline-flex items-center gap-1">
              <i
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: engineColor(row.position) }}
                aria-hidden="true"
              />
              {row.label}
            </span>
          ))}
        </span>
      }
    />
  );
}

/** Two measures plotted against each other for one problem version; the cells on the gateway's front are the best trade-offs. */
export function TradeoffChart({
  points,
  xName,
  yName,
}: {
  points: readonly Point[];
  xName: string;
  yName: string;
}) {
  const shape = (point: Point) => ({
    x: point.x,
    y: point.y,
    cell: point.cell.ordinal,
  });
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <ScatterChart margin={MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis
            type="number"
            dataKey="x"
            name={measureLabel(xName)}
            tick={TICK}
            stroke={AXIS}
            domain={['auto', 'auto']}
            tickFormatter={value => formatMeasure(Number(value))}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={measureLabel(yName)}
            tick={TICK}
            stroke={AXIS}
            width={48}
            domain={['auto', 'auto']}
            tickFormatter={value => formatMeasure(Number(value))}
          />
          <ZAxis range={[56, 56]} />
          <Tooltip isAnimationActive={false} formatter={value => formatMeasure(Number(value))} />
          <Scatter
            name="Not on the front"
            data={points.filter(point => !point.front).map(shape)}
            fill="var(--color-tp-stone)"
            isAnimationActive={false}
          />
          <Scatter
            name="Best trade-off"
            data={points.filter(point => point.front).map(shape)}
            fill="var(--color-tp-chart-2)"
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
      <span className="flex flex-wrap gap-3 text-[11px] text-tp-steel">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2.5 w-2.5 rounded-full bg-tp-chart-2" aria-hidden="true" />
          best trade-off (on the gateway’s front)
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2.5 w-2.5 rounded-full bg-tp-stone" aria-hidden="true" />
          not on the front
        </span>
      </span>
    </>
  );
}

/** The points of a trade-off plot as a table. */
export function TradeoffTable({
  points,
  xName,
  yName,
}: {
  points: readonly Point[];
  xName: string;
  yName: string;
}) {
  return (
    <DataTable label="Results plotted by two objectives" minWidth={420}>
      <thead>
        <tr>
          <th scope="col">Cell</th>
          <th scope="col">{measureLabel(xName)}</th>
          <th scope="col">{measureLabel(yName)}</th>
          <th scope="col">On the front</th>
        </tr>
      </thead>
      <tbody>
        {points.map(point => (
          <tr key={point.cell.id}>
            <td>#{point.cell.ordinal}</td>
            <td>{formatMeasure(point.x)}</td>
            <td>{formatMeasure(point.y)}</td>
            <td>{point.front ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
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
            <td>
              {row.spread ? (
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                    position === 0
                      ? 'bg-tp-accent text-tp-on-primary'
                      : 'bg-tp-surface text-tp-slate'
                  }`}
                >
                  {position + 1}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: engineColor(row.position) }}
                  aria-hidden="true"
                />
                {row.label}
              </span>
            </td>
            <td>
              {row.completed.length} of {row.cells.length}
            </td>
            <td>{row.feasible}</td>
            <td>{formatMeasure(row.spread?.min)}</td>
            <td>{formatMeasure(row.spread?.median)}</td>
            <td>
              {formatMeasure(row.spread?.mean)}
              {row.spread &&
                best !== undefined &&
                position > 0 &&
                best !== 0 &&
                row.spread.mean > best && (
                  <small className={`block ${MUTED}`}>
                    +{Math.round(((row.spread.mean - best) / Math.abs(best)) * 100)}% vs first
                  </small>
                )}
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
export function SeedTable({
  groups,
  measure,
  cellHref,
}: {
  groups: readonly SeedGroup[];
  measure: string;
  cellHref: (cellId: string) => string;
}) {
  return (
    <DataTable label="Results by seed" minWidth={640}>
      <thead>
        <tr>
          <th scope="col">Problem · engine</th>
          <th scope="col">{measureTitle(measure)} by seed</th>
          <th scope="col">Difference</th>
        </tr>
      </thead>
      <tbody>
        {groups.map(group => (
          <tr key={group.key}>
            <td>
              {group.label}
              <small className={`block ${MUTED}`}>{group.setting}</small>
            </td>
            <td>
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {group.seeds.map(item => (
                  <Link
                    key={item.cell.id}
                    to={cellHref(item.cell.id)}
                    viewTransition
                    className={LINK}
                  >
                    seed {item.seed}:{' '}
                    {item.value !== null ? formatMeasure(item.value) : item.cell.state}
                  </Link>
                ))}
              </span>
            </td>
            <td>
              {group.spread === null
                ? '—'
                : group.spread === 0
                  ? 'identical'
                  : formatMeasure(group.spread)}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
