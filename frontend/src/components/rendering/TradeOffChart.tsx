import { useMemo, useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { DataTable } from '../ui/DataTable';
import { nonDominated, type TradeOffChartProps, type TradeOffPoint } from './tradeOffModel';
import './TradeOffChart.css';

export type { TradeOffChartProps, TradeOffPoint } from './tradeOffModel';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const TICK = { fontSize: 11, fill: 'var(--color-text-secondary)' };

interface Dot { x: number; y: number; name: string }

/** Non-dominated solutions as a table and, from two solutions, a scatter chart whose axes are chosen among the objectives. */
// [impl->req~frontend-rendering-trade-off-chart~1]
export function TradeOffChart({ points, objectives, label = 'Trade-off set' }: TradeOffChartProps) {
  const [axes, setAxes] = useState<{ x: string; y: string }>({ x: objectives[0] ?? '', y: objectives[1] ?? '' });
  const optimal = useMemo(() => nonDominated(points, objectives), [points, objectives]);

  if (objectives.length < 2 || points.length === 0) return null;

  // Keep the axes valid when the objectives change under a mounted component.
  const x = objectives.includes(axes.x) ? axes.x : objectives[0];
  const y = objectives.includes(axes.y) && axes.y !== x ? axes.y : objectives.find((o) => o !== x) ?? objectives[1];

  const choose = (axis: 'x' | 'y', value: string) => {
    if (axis === 'x') setAxes(value === y ? { x: value, y: x } : { x: value, y });
    else setAxes(value === x ? { x: y, y: value } : { x, y: value });
  };

  const dot = (p: TradeOffPoint): Dot => ({ x: p.values[x], y: p.values[y], name: p.label });
  const dominatedPoints = points.filter((p) => !optimal.includes(p));
  const summary = `${points.length} solutions plotted by ${x} (horizontal) and ${y} (vertical); ${optimal.length} not dominated: `
    + optimal.map((p) => `${p.label} (${number.format(p.values[x])}, ${number.format(p.values[y])})`).join('; ');

  return (
    <div className="trade-off" role="region" aria-label={label}>
      <DataTable label="Non-dominated solutions" minWidth={480}>
        <thead>
          <tr>
            <th scope="col">Solution</th>
            {objectives.map((o) => <th key={o} scope="col">{o}</th>)}
          </tr>
        </thead>
        <tbody>
          {optimal.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.label}</th>
              {objectives.map((o) => <td key={o}>{number.format(p.values[o])}</td>)}
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p className="trade-off__note">
        Not dominated: no other solution is at least as good on every objective and better on at least one.
      </p>
      {points.length < 2 ? (
        <p className="trade-off__note">A chart needs at least two solutions; this run has one.</p>
      ) : (
        <>
          <div className="trade-off__controls">
            <label className="trade-off__control">
              Horizontal axis
              <select value={x} onChange={(e) => choose('x', e.target.value)}>
                {objectives.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="trade-off__control">
              Vertical axis
              <select value={y} onChange={(e) => choose('y', e.target.value)}>
                {objectives.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <div className="trade-off__chart" role="img" aria-label={summary}>
            <ResponsiveContainer width="100%" height={280}>
              <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={x}
                  domain={['auto', 'auto']}
                  tick={TICK}
                  label={{ value: x, position: 'insideBottom', offset: -8, fontSize: 11, fill: 'var(--color-text-secondary)' }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={y}
                  domain={['auto', 'auto']}
                  tick={TICK}
                  width={64}
                  label={{ value: y, angle: -90, position: 'insideLeft', fontSize: 11, fill: 'var(--color-text-secondary)' }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(value: number, name: string) => [number.format(value), name]}
                  labelFormatter={(_: unknown, payload: ReadonlyArray<{ payload?: Dot }>) => payload?.[0]?.payload?.name ?? ''}
                  contentStyle={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
                />
                <Scatter name="not dominated" data={optimal.map(dot)} shape="circle" fill="var(--color-accent)" isAnimationActive={false} />
                <Scatter name="dominated" data={dominatedPoints.map(dot)} shape="cross" fill="var(--color-text-secondary)" stroke="var(--color-text-secondary)" isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <ul className="trade-off__legend">
            <li><span className="trade-off__mark is-filled" aria-hidden="true" />not dominated</li>
            <li><span className="trade-off__mark is-cross" aria-hidden="true" />dominated</li>
          </ul>
        </>
      )}
    </div>
  );
}
