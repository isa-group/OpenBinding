// One upstream event of a composition, opened in place on its Operation tab (`?event=<id>`, F6): the pricing and its two
// versions with their SPHERE links, the category and the state (who reviewed it and their note, the version that resolved
// it), the affected version and where it is in effect; then what changed in words (the core `UpstreamChangeSummary`), each
// bound plan drawn before and after by pricing-renderer's change review over the two stored snapshots (read only, as the
// Versions tab's comparison draws it), and for an offering event the margins of each environment before and after. The
// actions are a person's: mark reviewed, update the problem from SPHERE, open the configurator, run again, propose
// adopting the version that resolved it. SPHERE has no upstream events; the frame is the Operation tab's own.

import { format, parseISO } from 'date-fns';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type {
  CompositionMargins,
  CompositionVersionView,
  CompositionView,
  MarginRow,
  UpstreamEventDetail,
} from '../../../core/api/types';
import { MarginTable } from '../../../core/components/margin-table';
import { Notice } from '../../../core/components/notice';
import PricingChangeReview from '../../../core/components/pricing-change-review';
import {
  compareProviderPlan,
  PROVIDER_PLAN_MESSAGES,
} from '../../../core/components/pricing-change-review/compare';
import { UpstreamCategoryPill } from '../../../core/components/upstream-badge';
import { UpstreamChangeSummary } from '../../../core/components/upstream-change-summary';
import { useResource } from '../../../core/hooks/useResource';
import NotFoundPage from '../../../core/pages/page-not-found';
import {
  pricingName,
  STATE_WORDS,
  versionsText,
} from '../../../core/utils/composition/upstreamEvents';
import { snapshotYaml, snapshotYamlHref } from '../../../core/utils/sphere/snapshotYaml';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { compositionPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { launchPath } from '../../../../routes/paths/runs';
import { useUpstreamEventsApi } from '../../api/upstreamEventsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import ReviewEventDialog from '../review-event-dialog';

const actionClass =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none';

interface DiffSide {
  label?: string | null;
  createdAt?: string | null;
  snapshotId?: string | null;
  url?: string | null;
}

interface DiffEntry {
  task: string;
  candidate: string;
  selection?: { plan?: string; addOns?: string[] };
  comparison?: { plan?: { renamedTo?: string | null } } | null;
}

interface MarginSide {
  status: CompositionMargins['status'];
  currency: string | null;
  costPerUser: string | null;
  rows: Array<{
    plan: string;
    addOns: string[];
    revenue: string | null;
    cost: string | null;
    margin: string | null;
  }>;
}

interface EnvironmentMargins {
  environment: string;
  adoption: number;
  evaluation?: string | null;
  users: number | null;
  before: MarginSide | null;
  after: MarginSide | null;
}

const asList = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** A side of the margins an offering event stored, in the margin table's shape (its rows as stored; nothing computed). */
function sideMargins(
  side: MarginSide,
  users: number | null,
  version: { id: string; label: string }
): CompositionMargins {
  return {
    apportionment: 'uniform',
    billing: null,
    cost: null,
    costPerUser: side.costPerUser,
    currency: side.currency,
    evaluation: null,
    offering: null,
    rows: side.rows.map((row): MarginRow => ({
      plan: row.plan,
      planName: row.plan,
      addOns: row.addOns,
      basis: 'subscription',
      revenue: row.revenue,
      cost: row.cost,
      margin: row.margin,
      excludedParts: [],
      outOfRange: false,
      private: false,
      requiresQuote: false,
    })),
    rowsTruncated: false,
    status: side.status,
    users,
    version,
    warnings: [],
  };
}

function SphereLink({ side, children }: { side: DiffSide | null; children: ReactNode }) {
  if (!side?.url) return <>{children}</>;
  return (
    <a
      href={side.url}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-dotted hover:text-tp-ink"
    >
      {children}
    </a>
  );
}

const dated = (side: DiffSide | null) =>
  side?.createdAt ? ` (${format(parseISO(side.createdAt), 'd MMM yyyy')})` : '';

/** One bound plan drawn before and after over the two stored snapshots, or why it cannot be. */
function PlanDrawing({
  org,
  entry,
  before,
  after,
}: {
  org: string;
  entry: DiffEntry;
  before: DiffSide | null;
  after: DiffSide | null;
}) {
  const yaml = useResource<[string, string] | null>(
    `upstream-event-yaml:${org}/${before?.snapshotId ?? '-'}/${after?.snapshotId ?? '-'}`,
    async () =>
      before?.snapshotId && after?.snapshotId
        ? Promise.all([
            snapshotYaml(snapshotYamlHref(org, before.snapshotId)),
            snapshotYaml(snapshotYamlHref(org, after.snapshotId)),
          ]).catch(() => null)
        : null
  );
  const plan = entry.selection?.plan ?? '';
  const compared = useMemo(() => {
    if (!yaml.data) return null;
    const addOns = entry.selection?.addOns ?? [];
    const renamed = entry.comparison?.plan?.renamedTo ?? plan;
    return compareProviderPlan(yaml.data[0], yaml.data[1], plan, addOns, renamed);
  }, [yaml.data, plan, entry]);
  const title = `${entry.task}: plan ${plan}, ${before?.label ?? '?'} → ${after?.label ?? '?'}`;
  if (yaml.status === 'loading') return null;
  if (!compared)
    return (
      <p className="m-0 text-[13px] text-tp-slate">
        {`${title}. OpenBinding holds no copy of one of the two versions, so the plan is not drawn.`}
      </p>
    );
  if (!compared.ok)
    return (
      <Notice tone="warning">{`${title}: the plan can’t be drawn, ${compared.reason}.`}</Notice>
    );
  return (
    <PricingChangeReview
      comparison={compared.comparison}
      title={title}
      messages={PROVIDER_PLAN_MESSAGES}
      readOnly
    />
  );
}

interface Props {
  org: string;
  composition: CompositionView;
  /** Light rows of the composition's versions, newest first (the problem the affected version links). */
  versions: CompositionVersionView[];
  /** The event's id, from the address. */
  eventId: string;
  role: OrgRole | null;
  /** The address of the Operation tab without the event. */
  backTo: string;
  /** Bumped when something changed the event (a review, a notification). */
  refresh?: string | number;
  /** More of a person's actions on the event (a proposal), given the event and its `ETag`. */
  actions?: (event: UpstreamEventDetail, etag: string | null) => ReactNode;
  /** The event changed here (a review): the tab's counts and badges are read again. */
  onChanged?: () => void;
}

export default function UpstreamEventDetailView({
  org,
  composition,
  versions,
  eventId,
  role,
  backTo,
  refresh = 0,
  actions,
  onChanged,
}: Props) {
  const api = useUpstreamEventsApi();
  const [nonce, setNonce] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const read = useResource(
    `upstream-event:${org}/${composition.slug}/${eventId}:${refresh}:${nonce}`,
    () => api.get(org, composition.slug, eventId)
  );

  const back = (
    <Link
      to={backTo}
      className="inline-flex items-center gap-1 self-start text-xs text-tp-steel hover:text-tp-ink hover:underline"
    >
      <span aria-hidden="true">←</span> All upstream changes
    </Link>
  );

  if (read.status === 'error') {
    if ((read.error as { status?: number } | null)?.status === 404) return <NotFoundPage />;
    return (
      <div className="flex flex-col gap-3">
        {back}
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {`The upstream change couldn’t be loaded${marker(classifyAuthError(read.error))}.`}
          <button type="button" onClick={read.reload} className={actionClass}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const loaded = read.data ?? read.stale;
  if (!loaded || loaded.value.id !== eventId)
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p role="status" className="py-12 text-center text-sm text-tp-steel">
          Loading the upstream change…
        </p>
      </div>
    );

  const event = loaded.value;
  const etag = read.data?.etag ?? null;
  const diff = (event.diff ?? {}) as Record<string, unknown>;
  const old = (diff.old ?? event.old) as DiffSide;
  const latest = (diff.new ?? event.new) as DiffSide | null;
  const offering = event.subject === 'offering';
  const member = roleAtLeast(role, 'MEMBER');
  const affected = versions.find(version => version.id === event.version.id);
  const link = affected?.problem && affected.problem.problem.id !== null ? affected.problem : null;
  const entries = asList<DiffEntry>(diff.entries).filter(entry => entry.selection?.plan);
  const margins = (diff.margins ?? null) as {
    environments?: EnvironmentMargins[];
  } | null;
  const resolving = event.resolvedBy;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {back}
      <section
        aria-labelledby="event-heading"
        className="rounded-xl border border-tp-hairline bg-tp-canvas"
      >
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-xs text-tp-steel">
              {offering ? 'The offering changed upstream' : 'A pricing changed upstream'}
            </p>
            <h2
              id="event-heading"
              className="font-display text-lg [overflow-wrap:anywhere] text-tp-ink"
            >
              {pricingName(event.pricing)}
            </h2>
            <p className="m-0 text-sm text-tp-slate">
              <SphereLink side={old}>{old?.label ?? 'the pinned version'}</SphereLink>
              {dated(old)}
              {' → '}
              {latest ? (
                <>
                  <SphereLink side={latest}>{latest.label ?? 'a new version'}</SphereLink>
                  {dated(latest)}
                </>
              ) : (
                'no longer readable'
              )}
            </p>
            {(old?.url || latest?.url) && (
              <p className="m-0 mt-0.5 text-[11px] text-tp-steel">
                The version names open in SPHERE in a new tab.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UpstreamCategoryPill category={event.category} />
            <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[11px] font-medium text-tp-steel">
              {STATE_WORDS[event.state]}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 py-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-tp-steel">
              {offering ? 'Compared with version' : 'Affects version'}
            </dt>
            <dd className="m-0 text-tp-ink">
              <Link
                to={compositionPath(org, composition.slug, undefined, {
                  version: event.version.label,
                })}
                className="inline-flex min-h-6 items-center font-mono hover:text-tp-accent hover:underline"
              >
                {event.version.label}
              </Link>
              {event.tasks.length > 0 && ` · ${event.tasks.join(', ')}`}
            </dd>
            <dd className="m-0 text-tp-steel">
              {/* A binding event lists where this version is in effect; an offering event, every environment with a version
                  in effect, since each one offers the plans that changed. */}
              {offering
                ? event.environments.length > 0
                  ? `Affects ${event.environments.join(', ')}: every environment with a version in effect`
                  : 'No environment has a version in effect'
                : event.environments.length > 0
                  ? `In effect in ${event.environments.join(', ')}`
                  : 'Not in effect in any environment'}
            </dd>
          </div>
          <div>
            <dt className="text-tp-steel">Detected</dt>
            <dd className="m-0 text-tp-ink">
              {format(parseISO(event.detectedAt), 'd MMM yyyy, HH:mm')}
            </dd>
            {event.supersededBy && (
              <dd className="m-0 text-tp-steel">
                Superseded by a{' '}
                <Link
                  to={compositionPath(org, composition.slug, 'operation', {
                    event: event.supersededBy,
                  })}
                  className="underline decoration-dotted hover:text-tp-ink"
                >
                  newer upstream version
                </Link>
                .
              </dd>
            )}
            {event.newVersionWithdrawn && (
              <dd className="m-0 text-tp-steel">The new version was withdrawn since.</dd>
            )}
          </div>
          {event.reviewedBy && (
            <div>
              <dt className="text-tp-steel">Reviewed</dt>
              <dd className="m-0 text-tp-ink">
                {`By ${event.reviewedBy.username}${event.reviewedAt ? `, ${format(parseISO(event.reviewedAt), 'd MMM yyyy')}` : ''}`}
              </dd>
              {event.note && (
                <dd className="m-0 [overflow-wrap:anywhere] whitespace-pre-line text-tp-slate">
                  “{event.note}”
                </dd>
              )}
            </div>
          )}
          {resolving && (
            <div>
              <dt className="text-tp-steel">Resolved</dt>
              <dd className="m-0 text-tp-ink">
                By{' '}
                <Link
                  to={compositionPath(org, composition.slug, 'versions', {
                    from: event.version.label,
                    to: resolving.version.label,
                  })}
                  className="inline-flex min-h-6 items-center font-mono hover:text-tp-accent hover:underline"
                >
                  {resolving.version.label}
                </Link>
                {resolving.by ? `, sealed by ${resolving.by.username}` : ''}
              </dd>
            </div>
          )}
        </dl>
        {event.rebindingRecommended && (
          <p className="mx-5 mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            Rebinding recommended: what the version binds can no longer be read as it was. Update
            the problem from SPHERE and choose again, or run it again.
          </p>
        )}
        {offering && (
          <p className="mx-5 mb-4 text-xs text-tp-steel">
            The offering is not pinned in the document; this event ends when reviewed.
          </p>
        )}
        {member && (
          <div className="flex flex-wrap items-center gap-2 border-t border-tp-hairline px-5 py-3">
            {event.state === 'open' && (
              <button
                type="button"
                onClick={() => setReviewing(true)}
                className="inline-flex h-8 cursor-pointer items-center rounded-lg bg-tp-primary px-3 text-xs font-medium text-white transition-colors hover:bg-tp-primary/90"
              >
                Mark reviewed
              </button>
            )}
            {actions?.(event, etag)}
            {!offering && link && (
              <>
                <Link
                  to={`${problemPath(org, link.problem.slug)}?sphereStep=pricing&sphereUpdate=1`}
                  className={actionClass}
                >
                  Update from SPHERE
                </Link>
                <Link
                  to={compositionPath(org, composition.slug, 'configuration')}
                  className={actionClass}
                >
                  Open the configurator
                </Link>
                <Link to={launchPath(org, { problem: link.problem.slug })} className={actionClass}>
                  Run again
                </Link>
              </>
            )}
          </div>
        )}
      </section>

      <section
        aria-label="The change"
        className="flex min-w-0 flex-col gap-4 rounded-xl border border-tp-hairline bg-tp-canvas p-5"
      >
        <UpstreamChangeSummary event={event} />
        {!offering && latest && entries.length > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            {entries.map(entry => (
              <PlanDrawing
                key={`${entry.task}-${entry.candidate}`}
                org={org}
                entry={entry}
                before={old}
                after={latest}
              />
            ))}
          </div>
        )}
        {offering &&
          (margins?.environments ?? []).map(environment => (
            <section
              key={environment.environment}
              aria-label={`Margins in ${environment.environment}`}
              className="flex min-w-0 flex-col gap-3"
            >
              <h3 className="m-0 text-sm font-semibold text-tp-ink">
                {`${environment.environment}: margins before and after (adoption #${environment.adoption}${environment.users !== null ? `, ${environment.users.toLocaleString('en')} users` : ''})`}
              </h3>
              {environment.before && (
                <MarginTable
                  title={`Before: ${old?.label ?? 'the evaluated offering'}`}
                  caption={`The evaluation adoption #${environment.adoption} pinned, with offering ${old?.label ?? '?'}`}
                  margins={sideMargins(environment.before, environment.users, event.version)}
                  hideBasis
                />
              )}
              {environment.after ? (
                <MarginTable
                  title={`After: ${latest?.label ?? 'the new offering'}`}
                  caption={`The same evaluation, with offering ${latest?.label ?? '?'}`}
                  margins={sideMargins(environment.after, environment.users, event.version)}
                  hideBasis
                />
              ) : (
                <p className="m-0 text-xs text-tp-steel">
                  The new offering can’t be read, so there are no margins after.
                </p>
              )}
            </section>
          ))}
        <p className="m-0 text-[11px] text-tp-steel">
          {`${versionsText(event)} · classified by OpenBinding (classifier ${event.classifier}); nothing was re-evaluated.`}
        </p>
      </section>
      {reviewing && (
        <ReviewEventDialog
          org={org}
          composition={composition.slug}
          event={event}
          etag={etag}
          onClose={() => setReviewing(false)}
          onChanged={() => {
            setReviewing(false);
            setNonce(value => value + 1);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
