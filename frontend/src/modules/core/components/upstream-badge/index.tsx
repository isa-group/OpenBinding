// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/services/ServiceKindBadge.tsx
// (revision 7c7074ff), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the upstream events of a composition, a version or an environment instead of a service's kind: amber with the
// open count, rose when any recommends rebinding, a neutral "n reviewed" when only reviewed ones remain, and on an
// environment a neutral "Resolved in <version>, not adopted here". The pill's `title` names the worst category. It draws
// the gateway's counts as they come and computes nothing; with no counts (a visitor, a public list) it draws nothing.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EnvironmentUpstreamSummary, UpstreamSummary } from '../../api/types';
import {
  CATEGORY_TONE,
  CATEGORY_WORDS,
  upstreamBadgeText,
  type UpstreamCategory,
} from '../../utils/composition/upstreamEvents';
import { BADGE_SHAPE, BADGE_TONES, type BadgeTone } from './badgeTones';

interface Props {
  /** The gateway's counts: a composition's, a version's or an environment's; null or absent draws nothing. */
  upstream?: UpstreamSummary | EnvironmentUpstreamSummary | null;
  /** Where the pill leads (the Operation tab's events); a plain pill without it. */
  to?: string;
}

function Pill({
  tone,
  title,
  to,
  children,
}: {
  tone: BadgeTone;
  title: string;
  to?: string;
  children: ReactNode;
}) {
  const className = `${BADGE_SHAPE} ${BADGE_TONES[tone]} max-w-full truncate`;
  // A link is at least 24 px tall (WCAG 2.5.8; it sits on a card's own link), the pill drawn inside it as is.
  if (to)
    return (
      <Link
        to={to}
        title={title}
        className="group relative z-10 inline-flex min-h-6 max-w-full items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tp-primary"
      >
        <span className={`${className} group-hover:underline`}>{children}</span>
      </Link>
    );
  return (
    <span title={title} className={className}>
      {children}
    </span>
  );
}

/** The upstream badge: nothing for no counts or all zeros. */
export function UpstreamBadge({ upstream, to }: Props) {
  if (!upstream) return null;
  const { main, resolved } = upstreamBadgeText(upstream);
  if (!main && !resolved) return null;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      {main && (
        <Pill tone={main.tone} title={main.title} to={to}>
          {main.text}
        </Pill>
      )}
      {resolved && (
        <Pill tone="neutral" title={resolved.title}>
          {resolved.text}
        </Pill>
      )}
    </span>
  );
}

/** One event's category as a pill of the same recipe (the event rows and the event detail). */
export function UpstreamCategoryPill({ category }: { category: UpstreamCategory }) {
  return (
    <span
      className={`${BADGE_SHAPE} ${BADGE_TONES[CATEGORY_TONE[category]]} max-w-full shrink-0 truncate`}
    >
      {CATEGORY_WORDS[category]}
    </span>
  );
}
