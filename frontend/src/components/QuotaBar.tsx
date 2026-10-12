import type { LimitUsage } from '../api/auth';
import { formatMonthDay, formatNumber } from '../utils/format';
import './QuotaBar.css';

/** Render the identifier, unit, allowance and consumption returned by SPACE. */
function formatAmount(value: number, unit?: string | null): string {
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}

// Dates are English and in UTC, like every other date of the interface (utils/format).
const formatRenewal = formatMonthDay;

interface QuotaBarProps {
  limit: LimitUsage;
  /** The name people read; the limit's identifier when omitted. */
  label?: string;
  /** How one value reads (a duration, a size). By default the number with its unit. */
  format?: (value: number) => string;
  /**
   * `plain` is the compact row of the administration screens; `card` is the boxed allowance of the
   * usage screen, with the unit beside its name and what is left spelled out.
   */
  variant?: 'plain' | 'card';
  /** What stops when it is used up, for the card’s sentence: “New study runs can’t start until it renews”. */
  stops?: string;
}

/**
 * One allowance and what is left of it.
 *
 * Shows the figures as well as the bar. A bar alone answers "roughly how much
 * is gone"; somebody deciding whether to start a long solve needs the number.
 */
export function QuotaBar({ limit, label, format, variant = 'plain', stops }: QuotaBarProps) {
  const name = label ?? limit.limit_id;
  const used = Math.max(0, limit.used);
  const fraction = limit.limit > 0 ? Math.min(1, used / limit.limit) : 0;
  const percent = Math.round(fraction * 100);
  const state = fraction >= 1 ? 'spent' : fraction >= 0.8 ? 'low' : 'fine';
  const renewal = formatRenewal(limit.renews_at);
  const show = (value: number) => (format ? format(value) : formatAmount(value, limit.unit));

  const meter = (
    <div
      className="quota-track"
      role="meter"
      aria-label={name}
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={limit.limit}
      aria-valuetext={`${show(used)} of ${show(limit.limit)} used`}
    >
      <div className={`quota-fill quota-fill-${state}`} style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  );

  if (variant === 'card') {
    const spent = state === 'spent';
    return (
      <div className={`quota quota-card${spent ? ' is-spent' : ''}`}>
        <div className="quota-head">
          <span className="quota-label">{name}</span>
          {limit.unit && <span className="quota-unit">{limit.unit}</span>}
        </div>
        {meter}
        <div className="quota-card-figures">
          <span>{show(used)} of {show(limit.limit)} used</span>
          <strong>{spent ? '0 left' : `${show(Math.max(0, limit.limit - used))} left`}</strong>
        </div>
        {spent && (
          <span className="quota-spent-note">
            Used up. New {stops ?? name.toLowerCase()} can’t start until it renews; a request now gets a 402.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="quota">
      <div className="quota-head">
        <span className="quota-label">{name}</span>
        <span className="quota-figures">
          {show(used)} / {show(limit.limit)}
        </span>
      </div>

      {meter}

      {renewal && (
        <span className="quota-renewal">
          {state === 'spent' ? `Renews ${renewal}` : `Resets ${renewal}`}
        </span>
      )}
    </div>
  );
}
