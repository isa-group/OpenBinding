import { BadgeCheck, CircleDashed, FileText, TriangleAlert } from 'lucide-react';
import type { ValueOrigin } from '../../entities/binding/candidateMatrix';
import type { ValueStatus } from '../../entities/composition/values';
import { originText } from './originText';
import './ValueBadge.css';

const STATUS: Record<ValueStatus, { text: string; Icon: typeof BadgeCheck }> = {
  verified: { text: 'Verified', Icon: BadgeCheck },
  declared: { text: 'Declared', Icon: CircleDashed },
  unverified: { text: 'Unverified', Icon: TriangleAlert },
};

interface ValueBadgeProps {
  status?: ValueStatus;
  origin?: ValueOrigin | null;
  /** A cell of a table: the origin shows as an icon with its words for assistive technology and as a tooltip. */
  compact?: boolean;
}

/**
 * A value's status and origin. The status (`entities/composition/values`) says how far a value can be trusted: `verified`,
 * `declared` or `unverified`. It always prints its words; colour and icon only repeat them.
 */
export function ValueBadge({ status, origin, compact = false }: ValueBadgeProps) {
  const shown = status ? STATUS[status] : null;
  return (
    <span className="vb">
      {shown && (
        <span className={`vb-status is-${status}`}>
          <shown.Icon aria-hidden="true" />
          {shown.text}
        </span>
      )}
      {origin && (compact ? (
        <span className="vb-origin is-compact" title={originText(origin)}>
          <FileText aria-hidden="true" />
          <span className="sr-only">{originText(origin)}</span>
        </span>
      ) : (
        <span className="vb-origin">{originText(origin)}</span>
      ))}
    </span>
  );
}
