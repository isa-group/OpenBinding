import { BadgeCheck, CircleDashed, FileText, TriangleAlert } from 'lucide-react';
import type { ValueOrigin } from '../../entities/binding/candidateMatrix';
import { originText } from './originText';
import './ValueBadge.css';

/**
 * How far a value can be trusted: `verified` (the gateway evaluated it against the problem), `declared` (written in a
 * document that links no problem), or `unverified` (a linked version whose current evaluation is `binding_invalid` or
 * `semantics_changed`, or is not the verified outcome).
 */
export type ValueStatus = 'verified' | 'declared' | 'unverified';

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

/** A value's status and origin. It always prints its words; colour and icon only repeat them. */
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
