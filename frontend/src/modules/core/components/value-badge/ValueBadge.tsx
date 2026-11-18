import {
  MdAttachMoney,
  MdDataUsage,
  MdDescription,
  MdEdit,
  MdOpenInNew,
  MdSpeed,
  MdToggleOn,
  MdVerified,
  MdVerifiedUser,
  MdWarningAmber,
} from 'react-icons/md';
import type { IconType } from 'react-icons';
import type { ValueSource } from '../../api/types';
import type { ValueOrigin } from '../../utils/binding/candidateMatrix';
import type { ValueStatus } from '../../utils/composition/values';
import { originText, SOURCE_WORD, sourceLink } from './originText';
import { VALUE_STATUS_TEXT } from './statusText';

const ICON: Record<ValueStatus, IconType> = {
  verified: MdVerified,
  declared: MdDataUsage,
  unverified: MdWarningAmber,
};

const SOURCE_ICON: Record<ValueSource['kind'], IconType> = {
  priced: MdAttachMoney,
  guarantee: MdVerifiedUser,
  limit: MdSpeed,
  feature: MdToggleOn,
  manual: MdEdit,
};

// The three differ in words and icon, and in the line: dashed for a value nobody checked, dotted for one that no longer holds.
const STATUS_CLASS: Record<ValueStatus, string> = {
  verified: 'border-tp-status-verified [&>svg]:text-tp-status-verified',
  declared: 'border-dashed border-tp-status-declared [&>svg]:text-tp-status-declared',
  unverified: 'border-dotted border-tp-status-unverified [&>svg]:text-tp-status-unverified',
};

// A value read from a pricing is drawn solid; one set by hand is dashed, as SPHERE draws a hand-made value.
const SOURCE_CLASS: Record<ValueSource['kind'], string> = {
  priced: 'border-tp-primary [&>svg]:text-tp-primary',
  guarantee: 'border-tp-primary [&>svg]:text-tp-primary',
  limit: 'border-tp-primary [&>svg]:text-tp-primary',
  feature: 'border-tp-primary [&>svg]:text-tp-primary',
  manual: 'border-dashed border-tp-hairline-strong [&>svg]:text-tp-steel',
};

const PILL =
  'inline-flex items-center gap-1 rounded-full border bg-tp-canvas px-2 py-px text-[11px] leading-normal font-semibold whitespace-nowrap text-tp-ink-tint';

interface ValueBadgeProps {
  status?: ValueStatus;
  origin?: ValueOrigin | null;
  /** A cell of a table: the origin shows as an icon (or its source's word) with its words for assistive technology and as a tooltip. */
  compact?: boolean;
  /** The value as the screen prints it (`35 USD/month`), quoted by a priced source's sentence. */
  shown?: string;
}

/** The word and icon of a value's source (Priced, Guarantee, Limit, Feature, Manual). */
export function SourcePill({ source }: { source: ValueSource }) {
  const Icon = SOURCE_ICON[source.kind];
  return (
    <span className={`vb-source is-${source.kind} ${PILL} ${SOURCE_CLASS[source.kind]}`}>
      <Icon aria-hidden="true" className="h-3 w-3 flex-none" />
      {SOURCE_WORD[source.kind]}
    </span>
  );
}

/** A guarantee's terms page, opened outside OpenBinding. */
function DocLink({ href, compact }: { href: string; compact: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="vb-doc inline-flex items-center gap-0.5 text-[11px] text-tp-link underline"
      aria-label={compact ? 'Guarantee terms (opens in a new tab)' : undefined}
    >
      {!compact && 'Guarantee terms'}
      <MdOpenInNew aria-hidden="true" className="h-3 w-3" />
    </a>
  );
}

/**
 * A value's status and origin, as one of SPHERE's pills. The status (`modules/core/utils/composition/values`) says how far a
 * value can be trusted: `verified`, `declared` or `unverified`. It always prints its words; colour and icon only repeat them.
 * The origin says where the package writes the value and, when a SPHERE import wrote it, what it was read from.
 */
export function ValueBadge({ status, origin, compact = false, shown }: ValueBadgeProps) {
  const Icon = status ? ICON[status] : null;
  const source = origin?.source ?? null;
  const link = sourceLink(source);
  const words = origin ? originText(origin, shown) : '';
  return (
    <span className="vb inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {status && Icon && (
        <span className={`vb-status is-${status} ${PILL} ${STATUS_CLASS[status]}`}>
          <Icon aria-hidden="true" className="h-3 w-3 flex-none" />
          {VALUE_STATUS_TEXT[status]}
        </span>
      )}
      {origin &&
        (compact ? (
          <span className="vb-origin is-compact inline-flex items-center gap-1" title={words}>
            {source ? (
              <span aria-hidden="true">
                <SourcePill source={source} />
              </span>
            ) : (
              <MdDescription aria-hidden="true" className="h-3 w-3 text-tp-stone" />
            )}
            <span className="sr-only">{words}</span>
            {link && <DocLink href={link} compact />}
          </span>
        ) : (
          <span className="vb-origin inline-flex flex-wrap items-center gap-1.5 text-xs [overflow-wrap:anywhere] text-tp-steel">
            {source && <SourcePill source={source} />}
            <span>{words}</span>
            {link && <DocLink href={link} compact={false} />}
          </span>
        ))}
    </span>
  );
}
