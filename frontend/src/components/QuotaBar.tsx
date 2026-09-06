import type { LimitUsage } from '../api/auth';
import './QuotaBar.css';

/** Render the identifier, unit, allowance and consumption returned by SPACE. */
function formatAmount(value: number, unit?: string | null): string {
  return `${value.toLocaleString()}${unit ? ` ${unit}` : ''}`;
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
  const label = limit.limit_id;
  const fraction = limit.limit > 0 ? Math.min(1, limit.used / limit.limit) : 0;
  const percent = Math.round(fraction * 100);
  const state = fraction >= 1 ? 'spent' : fraction >= 0.8 ? 'low' : 'fine';
  const renewal = formatRenewal(limit.renews_at);

  return (
    <div className="quota">
      <div className="quota-head">
        <span className="quota-label">{label}</span>
        <span className="quota-figures">
          {formatAmount(limit.used, limit.unit)} / {formatAmount(limit.limit, limit.unit)}
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
        <div className={`quota-fill quota-fill-${state}`} style={{ transform: `scaleX(${percent / 100})` }} />
      </div>

      {renewal && (
        <span className="quota-renewal">
          {state === 'spent' ? `Renews ${renewal}` : `Resets ${renewal}`}
        </span>
      )}
    </div>
  );
}
