// Pattern only, after SPHERE frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// The upstream changes of a composition on its Operation tab (F6): which pricings its live versions read and when they were
// last checked, filter chips by state (no-impact events hidden by default), and the events newest first, each a row that
// opens its detail in place (`?event=<id>`). The rows follow SPHERE's version rows (the recipe the Versions tab already
// ports): a label, pills, the date, the facts in a small line. What is "superseded" or "withdrawn" is the gateway's (`supersededBy`,
// `newVersionWithdrawn`); nothing is classified here.

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type {
  CompositionView,
  UpstreamEventList,
  UpstreamEventView,
  UpstreamWatchSummary,
} from '../../../core/api/types';
import { EmptyState } from '../../../core/components/empty-state';
import { UpstreamCategoryPill } from '../../../core/components/upstream-badge';
import { useResource } from '../../../core/hooks/useResource';
import {
  eventHeadline,
  pricingName,
  STATE_WORDS,
} from '../../../core/utils/composition/upstreamEvents';
import { compositionPath } from '../../../../routes/paths/compositions';
import { useUpstreamEventsApi } from '../../api/upstreamEventsApi';

type Chip = 'open' | 'reviewed' | 'resolved' | 'no_impact';

const CHIPS: ReadonlyArray<{ id: Chip; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'no_impact', label: 'No impact' },
];

/** Why a watch is not being read, in words; null for a watch that is. */
const PAUSED: Record<string, string> = {
  unavailable: 'SPHERE did not answer; OpenBinding tries again later',
  not_found: 'SPHERE answered “not found”; OpenBinding checks again before saying it is gone',
  gone: 'it is no longer readable in SPHERE',
  credential_missing: 'the organization’s SPHERE key is missing or was refused',
  registry_unknown: 'its SPHERE registry is not configured on this installation',
};

const PAGE = 50;

function ago(iso: string | null): string | null {
  return iso ? `${formatDistanceToNow(parseISO(iso))} ago` : null;
}

/** "Watching 3 pricings · last checked 2 minutes ago", and why any of them is paused. */
function WatchSummary({ watches }: { watches: UpstreamWatchSummary[] }) {
  if (watches.length === 0) return null;
  const observed = watches
    .map(watch => watch.observedAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const paused = watches.filter(watch => PAUSED[watch.status]);
  return (
    <div className="flex flex-col gap-0.5 text-xs text-tp-steel" aria-label="Watched pricings">
      <p className="m-0">
        {`Watching ${watches.length} ${watches.length === 1 ? 'pricing' : 'pricings'}`}
        {observed ? ` · last checked ${ago(observed)}` : ' · not checked yet'}
      </p>
      {paused.map(watch => (
        <p key={`${watch.pricing.pricingId ?? watch.pricing.url}`} className="m-0">
          {`${pricingName(watch.pricing)} is paused: ${PAUSED[watch.status]}.`}
        </p>
      ))}
    </div>
  );
}

function EventRow({ org, slug, event }: { org: string; slug: string; event: UpstreamEventView }) {
  const marks = [
    event.supersededBy ? 'superseded by a newer upstream version' : null,
    event.newVersionWithdrawn ? 'the new version was withdrawn' : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={compositionPath(org, slug, 'operation', { event: event.id })}
            className="min-w-0 text-sm font-medium [overflow-wrap:anywhere] text-tp-ink hover:text-tp-accent hover:underline"
          >
            {eventHeadline(event)}
          </Link>
          <UpstreamCategoryPill category={event.category} />
          <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-medium text-tp-steel">
            {STATE_WORDS[event.state]}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-tp-steel">
          {event.subject === 'offering'
            ? `The offering, against version ${event.version.label}`
            : `Version ${event.version.label}${event.tasks.length ? ` · ${event.tasks.join(', ')}` : ''}`}
          {/* An offering event affects every environment with a version in effect, whichever version it is. */}
          {event.environments.length > 0 &&
            (event.subject === 'offering' ? ' · affects ' : ' · in effect in ')}
          {event.environments.map((environment, index) => (
            <span key={environment}>
              {index > 0 && ', '}
              <span className="rounded bg-tp-primary/10 px-1 py-px font-medium text-tp-accent">
                {environment}
              </span>
            </span>
          ))}
          {event.resolvedBy && ` · resolved by ${event.resolvedBy.version.label}`}
          {marks.length > 0 && ` · ${marks.join(' · ')}`}
        </p>
      </div>
      <span className="shrink-0 text-[11px] text-tp-steel">{ago(event.detectedAt)}</span>
    </li>
  );
}

interface Props {
  org: string;
  composition: CompositionView;
  /** Bumped when something the page saw (a review, a notification) changed the events. */
  refresh?: string | number;
}

export default function UpstreamEventsSection({ org, composition, refresh = 0 }: Props) {
  const api = useUpstreamEventsApi();
  const [shown, setShown] = useState<Record<Chip, boolean>>({
    open: true,
    reviewed: true,
    resolved: true,
    no_impact: false,
  });
  const key = `upstream-events:${org}/${composition.slug}:${refresh}`;
  // Older pages asked for under this key; a new key (a refresh) starts from the first page again.
  const [older, setOlder] = useState<{
    key: string;
    events: UpstreamEventView[];
    next: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const read = useResource<UpstreamEventList>(key, () =>
    api.list(org, composition.slug, { limit: PAGE })
  );
  const page = read.data ?? read.stale;
  const extra = older && older.key === key && read.data ? older : null;
  const events = [...(page?.events ?? []), ...(extra?.events ?? [])];
  const nextBefore = extra ? extra.next : (page?.nextBefore ?? null);
  const counts = page?.counts;
  const visible = events.filter(event =>
    event.category === 'no_impact' ? shown.no_impact : shown[event.state]
  );
  const failure = read.status === 'error' ? classifyAuthError(read.error) : null;

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const answer = await api.list(org, composition.slug, { limit: PAGE, before: nextBefore });
      setOlder({
        key,
        events: [...(extra?.events ?? []), ...answer.events],
        next: answer.nextBefore,
      });
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const chipCount = (chip: Chip) =>
    counts
      ? chip === 'no_impact'
        ? counts.noImpact
        : chip === 'open'
          ? counts.open
          : chip === 'reviewed'
            ? counts.reviewed
            : counts.resolved
      : null;

  return (
    <section
      aria-labelledby="upstream-heading"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-2 border-b border-tp-hairline px-5 py-4">
        <h2 id="upstream-heading" className="font-display text-lg text-tp-ink">
          Upstream changes
        </h2>
        <p className="m-0 text-xs text-tp-steel">
          Changes in the pricings this composition’s versions read, as OpenBinding classified them.
          Nothing is changed for you: a person reviews, re-solves and adopts.
        </p>
        {page && <WatchSummary watches={page.watches} />}
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {CHIPS.map(chip => {
            const count = chipCount(chip.id);
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={shown[chip.id]}
                onClick={() => setShown(current => ({ ...current, [chip.id]: !current[chip.id] }))}
                className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-full border border-tp-hairline px-2.5 text-xs text-tp-slate transition-colors hover:bg-tp-surface aria-pressed:border-tp-primary aria-pressed:bg-tp-primary/10 aria-pressed:text-tp-accent"
              >
                {chip.label}
                {count !== null && <span className="tabular-nums">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-24">
        {read.status === 'loading' && !page ? (
          <p role="status" className="py-8 text-center text-sm text-tp-steel">
            Loading the upstream changes…
          </p>
        ) : failure ? (
          <div
            role="alert"
            className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {`The upstream changes couldn’t be loaded${marker(failure)}.`}
            <button
              type="button"
              onClick={read.reload}
              className="cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-3 py-1 text-xs font-medium"
            >
              Retry
            </button>
          </div>
        ) : events.length === 0 ? (
          <div className="p-4">
            <EmptyState
              dashed
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                  />
                </svg>
              }
              title="No upstream changes"
            >
              Nothing changed upstream since these versions were sealed. OpenBinding checks their
              pricings every few minutes.
            </EmptyState>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-tp-steel">
            No upstream change matches the chips chosen.
          </p>
        ) : (
          <ul aria-label="Upstream events" className="flex flex-col divide-y divide-tp-hairline">
            {visible.map(event => (
              <EventRow key={event.id} org={org} slug={composition.slug} event={event} />
            ))}
          </ul>
        )}
        {nextBefore && events.length > 0 && (
          <div className="border-t border-tp-hairline px-5 py-3">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="inline-flex min-h-6 cursor-pointer items-center text-xs text-tp-steel underline decoration-dotted hover:text-tp-ink disabled:cursor-wait"
            >
              {loadingMore ? 'Loading…' : 'Show older changes'}
            </button>
            {moreFailed && (
              <p role="alert" className="m-0 mt-1 text-xs text-red-700">
                The older changes couldn’t be read. Try again.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
