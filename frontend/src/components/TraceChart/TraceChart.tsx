import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import './TraceChart.css';

/**
 * Best-so-far convergence chart for a solve run.
 *
 * Heuristic engines report improvement events as
 * `{eval_index, elapsed_ms, best_objective, feasible, hard_violation}`;
 * the exact engine reports anytime incumbents as
 * `{elapsed_ms, objective_value}`. Values are the engines' internal search
 * objectives (lower is better); infeasible best-so-far points are marked.
 */

interface TracePoint {
  evalIndex: number | null;
  elapsedMs: number;
  value: number;
  feasible: boolean;
}

type XMode = 'evaluations' | 'time';

function normalizeTrace(rawTrace: unknown): TracePoint[] {
  if (!Array.isArray(rawTrace)) return [];
  const points: TracePoint[] = [];
  for (const entry of rawTrace) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const value = typeof e.best_objective === 'number'
      ? e.best_objective
      : typeof e.objective_value === 'number'
        ? e.objective_value
        : null;
    if (value === null) continue;
    points.push({
      evalIndex: typeof e.eval_index === 'number' ? e.eval_index : null,
      elapsedMs: typeof e.elapsed_ms === 'number' ? e.elapsed_ms : 0,
      value,
      feasible: e.feasible !== false,
    });
  }
  return points;
}

export function TraceChart({ trace, engineId }: { trace: unknown; engineId?: string }) {
  const points = useMemo(() => normalizeTrace(trace), [trace]);
  const hasEvalAxis = points.some((p) => p.evalIndex !== null);
  const [xMode, setXMode] = useState<XMode>(hasEvalAxis ? 'evaluations' : 'time');

  if (points.length === 0) {
    return (
      <Alert type="info" title="No trace available">
        This engine did not report a best-so-far trace for this run. Traces are available for the
        heuristic engines (improvement events) and for the exact engine (anytime incumbents).
      </Alert>
    );
  }

  const effectiveMode: XMode = xMode === 'evaluations' && hasEvalAxis ? 'evaluations' : 'time';
  const data = points
    .map((p) => ({
      x: effectiveMode === 'evaluations' ? p.evalIndex ?? 0 : Math.max(1, p.elapsedMs),
      value: p.value,
      feasible: p.feasible,
    }))
    .sort((a, b) => a.x - b.x);

  const feasibleCount = points.filter((p) => p.feasible).length;
  const lastValue = data[data.length - 1]?.value;

  return (
    <div className="trace-chart">
      <div className="trace-chart-toolbar">
        <div className="trace-chart-modes">
          <button
            className={`trace-mode-button ${effectiveMode === 'evaluations' ? 'active' : ''}`}
            onClick={() => setXMode('evaluations')}
            disabled={!hasEvalAxis}
            title={hasEvalAxis ? 'X axis: evaluation index' : 'This engine reports time-stamped incumbents only'}
          >
            Evaluations
          </button>
          <button
            className={`trace-mode-button ${effectiveMode === 'time' ? 'active' : ''}`}
            onClick={() => setXMode('time')}
            title="X axis: wall-clock time (ms)"
          >
            Time
          </button>
        </div>
        <div className="trace-chart-meta">
          <Badge variant="accent" size="sm">{points.length} improvements</Badge>
          {feasibleCount < points.length && (
            <Badge variant="warning" size="sm">{points.length - feasibleCount} infeasible</Badge>
          )}
          {lastValue !== undefined && (
            <Badge variant="default" size="sm">best {lastValue.toFixed(6)}</Badge>
          )}
        </div>
      </div>

      <div className="trace-chart-canvas">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="x"
              type="number"
              scale="log"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
              label={{
                value: effectiveMode === 'evaluations' ? 'evaluations (log)' : 'wall time (ms, log)',
                position: 'insideBottom',
                offset: -4,
                fontSize: 11,
                fill: 'var(--color-text-secondary)',
              }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
              tickFormatter={(v: number) => v.toFixed(3)}
              width={64}
              label={{
                value: 'best objective',
                angle: -90,
                position: 'insideLeft',
                fontSize: 11,
                fill: 'var(--color-text-secondary)',
              }}
            />
            <Tooltip
              formatter={(value: number) => [value.toFixed(6), 'best objective']}
              labelFormatter={(label: number) =>
                effectiveMode === 'evaluations' ? `evaluation ${label}` : `${label} ms`
              }
              contentStyle={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Line
              type="stepAfter"
              dataKey="value"
              stroke="var(--color-accent, #7c3aed)"
              strokeWidth={2}
              dot={(props: { cx?: number; cy?: number; index?: number; payload?: { feasible?: boolean } }) => (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={3}
                  fill={props.payload?.feasible ? 'var(--color-accent, #7c3aed)' : '#e6a700'}
                  stroke="var(--color-surface)"
                  strokeWidth={1}
                />
              )}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="trace-chart-footnote">
        Engine-internal best-so-far objective (lower is better)
        {engineId ? ` reported by ${engineId}` : ''}. Amber dots mark best-so-far points that were
        still infeasible; the returned solution is always re-evaluated canonically by the gateway.
      </p>
    </div>
  );
}
