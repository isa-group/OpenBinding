import './MetricCards.css';

export interface Metric {
  id?: string;
  label: string;
  value: number | string | null;
  unit?: string;
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  hint?: string;
}

interface MetricCardsProps {
  metrics: Metric[];
  label?: string;
}

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/** Key figures as cards. A missing value reads "no value", a trend reads as text with a decorative arrow. */
// [impl->req~frontend-rendering-metric-cards~1]
export function MetricCards({ metrics, label = 'Key figures' }: MetricCardsProps) {
  if (metrics.length === 0) return null;

  return (
    <ul aria-label={label} className="rendering-metrics">
      {metrics.map((m, index) => (
        <li key={m.id ?? `${m.label}-${index}`} className="rendering-metrics__card">
          <dl>
            <dt>{m.label}</dt>
            <dd>
              {m.value === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">no value</span>
                </>
              ) : (
                typeof m.value === 'number' ? number.format(m.value) : m.value
              )}
              {m.value !== null && m.unit && <span className="rendering-metrics__unit"> {m.unit}</span>}
            </dd>
          </dl>
          {m.trend && (
            <p className={`rendering-metrics__trend is-${m.trend.direction}`}>
              <span aria-hidden="true">{ARROW[m.trend.direction]}</span> <span>{m.trend.label}</span>
            </p>
          )}
          {m.hint && <small className="rendering-metrics__hint">{m.hint}</small>}
        </li>
      ))}
    </ul>
  );
}
