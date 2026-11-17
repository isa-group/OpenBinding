import { MdDataUsage, MdDescription, MdVerified, MdWarningAmber } from 'react-icons/md';
import type { IconType } from 'react-icons';
import type { ValueOrigin } from '../../utils/binding/candidateMatrix';
import type { ValueStatus } from '../../utils/composition/values';
import { originText } from './originText';
import { VALUE_STATUS_TEXT } from './statusText';

const ICON: Record<ValueStatus, IconType> = {
  verified: MdVerified,
  declared: MdDataUsage,
  unverified: MdWarningAmber,
};

// The three differ in words and icon, and in the line: dashed for a value nobody checked, dotted for one that no longer holds.
const STATUS_CLASS: Record<ValueStatus, string> = {
  verified: 'border-tp-status-verified [&>svg]:text-tp-status-verified',
  declared: 'border-dashed border-tp-status-declared [&>svg]:text-tp-status-declared',
  unverified: 'border-dotted border-tp-status-unverified [&>svg]:text-tp-status-unverified',
};

interface ValueBadgeProps {
  status?: ValueStatus;
  origin?: ValueOrigin | null;
  /** A cell of a table: the origin shows as an icon with its words for assistive technology and as a tooltip. */
  compact?: boolean;
}

/**
 * A value's status and origin, as one of SPHERE's pills. The status (`modules/core/utils/composition/values`) says how far a
 * value can be trusted: `verified`, `declared` or `unverified`. It always prints its words; colour and icon only repeat them.
 */
export function ValueBadge({ status, origin, compact = false }: ValueBadgeProps) {
  const Icon = status ? ICON[status] : null;
  return (
    <span className="vb inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {status && Icon && (
        <span
          className={`vb-status is-${status} inline-flex items-center gap-1 rounded-full border bg-tp-canvas px-2 py-px text-[11px] leading-normal font-semibold text-tp-ink-tint ${STATUS_CLASS[status]}`}
        >
          <Icon aria-hidden="true" className="h-3 w-3 flex-none" />
          {VALUE_STATUS_TEXT[status]}
        </span>
      )}
      {origin &&
        (compact ? (
          <span
            className="vb-origin is-compact inline-flex text-tp-stone"
            title={originText(origin)}
          >
            <MdDescription aria-hidden="true" className="h-3 w-3" />
            <span className="sr-only">{originText(origin)}</span>
          </span>
        ) : (
          <span className="vb-origin text-xs [overflow-wrap:anywhere] text-tp-steel">
            {originText(origin)}
          </span>
        ))}
    </span>
  );
}
