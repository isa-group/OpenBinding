import type { LimitUsage } from '../api/auth';
import './QuotaBar.css';

/**
 * The limits that are balances, in the words an account holder would use.
 *
 * Only these belong in a bar. The pricing also carries ceilings -
 * `maxTimeoutPerTaskLimit` and its kind - which bound one request and are
 * never consumed, so drawing them as "0 of 300 used" would say something
 * untrue about them.
 */
const LIMIT_LABELS: Record<string, string> = {
  tasksLimit: 'Solve jobs',
  solverTimeLimit: 'Solver time',
  federatedTasksLimit: 'Federated solve jobs',
  concurrentTasksLimit: 'Running at once',
  federatedEnginesLimit: 'Registered engines',
  apiKeysLimit: 'API keys',
};

const MONTHLY = new Set(['tasksLimit', 'solverTimeLimit', 'federatedTasksLimit']);

/** Whether a limit is something that gets spent, rather than a ceiling. */
export function isBalance(limitId: string): boolean {
  return limitId in LIMIT_LABELS;
}

function formatAmount(limitId: string, value: number): string {
  if (limitId !== 'solverTimeLimit') {
    return value.toLocaleString();
  }
  // Seconds are what the pricing counts, and hours are what people think in.
  if (value >= 3600) return `${(value / 3600).toFixed(1)} h`;
  if (value >= 60) return `${(value / 60).toFixed(1)} min`;
  return `${value.toFixed(1)} s`;
}

function formatRenewal(renewsAt?: string | null): string | null {
  if (!renewsAt) return null;
  const date = new Date(renewsAt);
  if (Number.isNaN(date.getTime())) return null;
  // Pinned to the interface's own language rather than the browser's, so the
  // month abbreviation reads as part of the sentence it sits in.
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * One allowance and what is left of it.
 *
 * Shows the figures as well as the bar. A bar alone answers "roughly how much
 * is gone"; somebody deciding whether to start a long solve needs the number.
 */
export function QuotaBar({ limit }: { limit: LimitUsage }) {
  const label = LIMIT_LABELS[limit.limit_id] ?? limit.limit_id;
  const fraction = limit.limit > 0 ? Math.min(1, limit.used / limit.limit) : 0;
  const percent = Math.round(fraction * 100);
  const state = fraction >= 1 ? 'spent' : fraction >= 0.8 ? 'low' : 'fine';
  const renewal = formatRenewal(limit.renews_at);

  return (
    <div className="quota">
      <div className="quota-head">
        <span className="quota-label">{label}</span>
        <span className="quota-figures">
          {formatAmount(limit.limit_id, limit.used)} / {formatAmount(limit.limit_id, limit.limit)}
          {MONTHLY.has(limit.limit_id) && <span className="quota-period"> this month</span>}
        </span>
      </div>

      <div
        className="quota-track"
        role="meter"
        aria-label={label}
        aria-valuenow={limit.used}
        aria-valuemin={0}
        aria-valuemax={limit.limit}
      >
        <div className={`quota-fill quota-fill-${state}`} style={{ width: `${percent}%` }} />
      </div>

      {renewal && (
        <span className="quota-renewal">
          {state === 'spent' ? `Renews ${renewal}` : `Resets ${renewal}`}
        </span>
      )}
    </div>
  );
}
