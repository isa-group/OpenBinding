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
const TREND = {
  up: 'text-tp-success-text',
  down: 'text-tp-error-text',
  flat: 'text-tp-steel',
} as const;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/** Key figures as cards. A missing value reads "no value", a trend reads as text with a decorative arrow. */
export function MetricCards({ metrics, label = 'Key figures' }: MetricCardsProps) {
  if (metrics.length === 0) return null;

  return (
    <ul
      aria-label={label}
      className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 p-0"
    >
      {metrics.map((m, index) => (
        <li
          key={m.id ?? `${m.label}-${index}`}
          className="min-w-0 rounded-xl border border-tp-hairline bg-tp-canvas p-3"
        >
          <dl className="m-0">
            <dt className="text-[11px] text-tp-steel">{m.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold [overflow-wrap:anywhere] text-tp-ink">
              {m.value === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">no value</span>
                </>
              ) : typeof m.value === 'number' ? (
                number.format(m.value)
              ) : (
                m.value
              )}
              {m.value !== null && m.unit && (
                <span className="text-xs font-normal text-tp-steel"> {m.unit}</span>
              )}
            </dd>
          </dl>
          {m.trend && (
            <p className={`mt-1 text-xs ${TREND[m.trend.direction]}`}>
              <span aria-hidden="true">{ARROW[m.trend.direction]}</span>{' '}
              <span>{m.trend.label}</span>
            </p>
          )}
          {m.hint && <small className="mt-1 block text-[11px] text-tp-steel">{m.hint}</small>}
        </li>
      ))}
    </ul>
  );
}
