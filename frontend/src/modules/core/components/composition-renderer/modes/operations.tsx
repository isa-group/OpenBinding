// The renderer's `operations` mode: what an environment's feed serves, the upstream changes of the version in effect and
// how it got there. SPHERE has no environments; the sections follow the other modes'. The mode takes the environment's
// data and the page's callbacks and slots only (the adoption history is a domain component the page mounts), so core
// imports no domain module.

import { formatDistanceToNow, parseISO } from 'date-fns';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EnvironmentInEffect, UpstreamEventView, UpstreamView } from '../../../api/types';
import { eventHeadline, STATE_WORDS } from '../../../utils/composition/upstreamEvents';
import { CompositionInEffect } from '../../composition-in-effect';
import { UpstreamCategoryPill } from '../../upstream-badge';
import { RendererSection } from '../RendererSection';
import type { Section } from '../presets';

/** The upstream changes of the version in effect: the gateway's rows and where each opens. */
export interface OperationsEvents {
  /** The open events of the version in effect, as the gateway lists them (newest first). */
  items: UpstreamEventView[];
  /** Where one event opens in place (the Operation tab's `?event=`). */
  eventHref: (event: UpstreamEventView) => string;
  /** Where every upstream change of the composition is listed. */
  allHref?: string;
}

/** What the `operations` mode draws: the screen reads it and hands it over. */
export interface OperationsData {
  /** The version in effect; null while nothing is adopted. */
  inEffect: EnvironmentInEffect | null;
  /** The upstream view of the version in effect, for the plan each candidate comes from. */
  upstream?: UpstreamView | null;
  /** Where a version opens, by label. */
  onOpenVersion?: (label: string) => string;
  /** Adopt a version here; absent when the reader may not. */
  onAdopt?: () => void;
  /** The upstream badge of the environment, beside the version in effect. */
  badge?: ReactNode;
  /** The open upstream changes of the version in effect; the section is left out without any. */
  events?: OperationsEvents | null;
  /** The adoption history, mounted by the page. */
  adoptions?: ReactNode;
  /** The margin table of the version in effect, mounted by the page. */
  margins?: ReactNode;
}

/** The compact list of the version in effect's open upstream changes, each a link to its detail. */
function EventsSection({ events }: { events: OperationsEvents }) {
  return (
    <RendererSection title="Upstream changes">
      <ul
        aria-label="Open upstream changes of the version in effect"
        className="flex flex-col divide-y divide-tp-hairline rounded-lg border border-tp-hairline"
      >
        {events.items.map(event => (
          <li
            key={event.id}
            className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
          >
            <Link
              to={events.eventHref(event)}
              className="min-w-0 flex-1 truncate text-sm font-medium text-tp-ink hover:text-tp-accent hover:underline"
            >
              {eventHeadline(event)}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
              <UpstreamCategoryPill category={event.category} />
              <span>{STATE_WORDS[event.state]}</span>
              <span>{`${formatDistanceToNow(parseISO(event.detectedAt))} ago`}</span>
            </span>
          </li>
        ))}
      </ul>
      {events.allHref && (
        <Link
          to={events.allHref}
          className="self-start text-xs text-tp-steel underline decoration-dotted hover:text-tp-ink"
        >
          Every upstream change of this composition
        </Link>
      )}
    </RendererSection>
  );
}

export function OperationsMode({
  sections,
  operation,
}: {
  sections: readonly Section[];
  operation: OperationsData;
}) {
  const { inEffect, upstream, onOpenVersion, onAdopt, badge, events, adoptions, margins } =
    operation;
  return (
    <>
      {sections.includes('inEffect') && (
        <RendererSection title="Composition in effect">
          {inEffect ? (
            <CompositionInEffect
              inEffect={inEffect}
              upstream={upstream}
              versionHref={onOpenVersion ? onOpenVersion(inEffect.version.label) : null}
              badge={badge}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-tp-steel">
              Nothing is adopted here yet, so the feed answers “nothing adopted”.
              {onAdopt && (
                <button
                  type="button"
                  onClick={onAdopt}
                  className="flex h-8 cursor-pointer items-center rounded-lg bg-tp-primary px-3 text-xs font-medium text-white hover:bg-tp-primary/90"
                >
                  Adopt a version…
                </button>
              )}
            </div>
          )}
          {inEffect && margins}
        </RendererSection>
      )}
      {sections.includes('events') && inEffect && events && events.items.length > 0 && (
        <EventsSection events={events} />
      )}
      {sections.includes('adoptions') && adoptions}
    </>
  );
}
