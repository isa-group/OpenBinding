import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DataTable } from '../../../core/components/data-table';
import { nonDominated, type TradeOffChartProps, type TradeOffPoint } from './tradeOffModel';

export type { TradeOffChartProps, TradeOffPoint } from './tradeOffModel';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const TICK = { fontSize: 11, fill: 'var(--color-tp-steel)' };
const NOTE = 'm-0 text-[13px] text-tp-steel';
const SELECT =
  'min-h-6 cursor-pointer rounded-md border border-tp-hairline bg-tp-canvas px-2 py-1 text-sm text-tp-ink outline-none focus:border-tp-primary';

interface Dot {
  x: number;
  y: number;
  name: string;
}

/** Non-dominated solutions as a table and, from two solutions, a scatter chart whose axes are chosen among the objectives. */
export function TradeOffChart({ points, objectives, label = 'Trade-off set' }: TradeOffChartProps) {
  const [axes, setAxes] = useState<{ x: string; y: string }>({
    x: objectives[0] ?? '',
    y: objectives[1] ?? '',
  });
  const optimal = useMemo(() => nonDominated(points, objectives), [points, objectives]);

  if (objectives.length < 2 || points.length === 0) return null;

  // Keep the axes valid when the objectives change under a mounted component.
  const x = objectives.includes(axes.x) ? axes.x : objectives[0];
  const y =
    objectives.includes(axes.y) && axes.y !== x
      ? axes.y
      : (objectives.find(o => o !== x) ?? objectives[1]);

  const choose = (axis: 'x' | 'y', value: string) => {
    if (axis === 'x') setAxes(value === y ? { x: value, y: x } : { x: value, y });
    else setAxes(value === x ? { x: y, y: value } : { x, y: value });
  };

  const dot = (p: TradeOffPoint): Dot => ({ x: p.values[x], y: p.values[y], name: p.label });
  const dominatedPoints = points.filter(p => !optimal.includes(p));
  const summary =
    `${points.length} solutions plotted by ${x} (horizontal) and ${y} (vertical); ${optimal.length} not dominated: ` +
    optimal
      .map(p => `${p.label} (${number.format(p.values[x])}, ${number.format(p.values[y])})`)
      .join('; ');

  return (
    <div className="flex flex-col gap-3" role="region" aria-label={label}>
      <DataTable label="Non-dominated solutions" minWidth={480}>
        <thead>
          <tr>
            <th scope="col">Solution</th>
            {objectives.map(o => (
              <th key={o} scope="col">
                {o}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {optimal.map(p => (
            <tr key={p.id}>
              <th scope="row">{p.label}</th>
              {objectives.map(o => (
                <td key={o}>{number.format(p.values[o])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p className={NOTE}>
        Not dominated: no other solution is at least as good on every objective and better on at
        least one.
      </p>
      {points.length < 2 ? (
        <p className={NOTE}>A chart needs at least two solutions; this run has one.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs text-tp-steel">
              Horizontal axis
              <select value={x} onChange={e => choose('x', e.target.value)} className={SELECT}>
                {objectives.map(o => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-tp-steel">
              Vertical axis
              <select value={y} onChange={e => choose('y', e.target.value)} className={SELECT}>
                {objectives.map(o => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="h-[280px] w-full" role="img" aria-label={summary}>
            <ResponsiveContainer width="100%" height={280}>
              <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tp-hairline)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={x}
                  domain={['auto', 'auto']}
                  tick={TICK}
                  label={{
                    value: x,
                    position: 'insideBottom',
                    offset: -8,
                    fontSize: 11,
                    fill: 'var(--color-tp-steel)',
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={y}
                  domain={['auto', 'auto']}
                  tick={TICK}
                  width={64}
                  label={{
                    value: y,
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 11,
                    fill: 'var(--color-tp-steel)',
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(value: number, name: string) => [number.format(value), name]}
                  labelFormatter={(_: unknown, payload: ReadonlyArray<{ payload?: Dot }>) =>
                    payload?.[0]?.payload?.name ?? ''
                  }
                  contentStyle={{
                    background: 'var(--color-tp-canvas)',
                    border: '1px solid var(--color-tp-hairline)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Scatter
                  name="not dominated"
                  data={optimal.map(dot)}
                  shape="circle"
                  fill="var(--color-tp-primary)"
                  isAnimationActive={false}
                />
                <Scatter
                  name="dominated"
                  data={dominatedPoints.map(dot)}
                  shape="cross"
                  fill="var(--color-tp-steel)"
                  stroke="var(--color-tp-steel)"
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-4 p-0 text-xs text-tp-steel [&_li]:inline-flex [&_li]:items-center [&_li]:gap-1.5">
            <li>
              <span
                className="inline-block h-3 w-3 flex-none rounded-full bg-tp-primary"
                aria-hidden="true"
              />
              not dominated
            </li>
            <li>
              <span
                className="relative inline-block h-3 w-3 flex-none before:absolute before:top-1/2 before:left-0 before:h-0.5 before:w-full before:rotate-45 before:bg-tp-steel after:absolute after:top-1/2 after:left-0 after:h-0.5 after:w-full after:-rotate-45 after:bg-tp-steel"
                aria-hidden="true"
              />
              dominated
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
