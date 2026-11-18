import { lazy, Suspense, useId } from 'react';
import { MdOpenInNew } from 'react-icons/md';
import type { UpstreamSnapshot } from '../../api/types';
import type { Provenance } from '../../utils/composition/document';

// The drawing loads pricing-renderer, so it comes in its own chunk, and only when there is a document to draw.
const PricingPlan = lazy(() => import('./PricingPlan'));

interface PricingCardProps {
  /** The SPHERE plan a candidate comes from, as the composition writes it (`binding.<task>.from`). */
  reference: Provenance;
  /** The stored snapshot of that version (`GET …/upstream`): its title, version name and date and SPHERE's permanent link. */
  snapshot?: UpstreamSnapshot | null;
  /** The snapshot's Pricing2Yaml document; with it, pricing-renderer draws the plan. */
  yaml?: string;
}

const formatDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
};

/**
 * An upstream plan: the plan of a SPHERE pricing that a candidate comes from. When OpenBinding holds the version the reference
 * pins (a snapshot the gateway stored when the import or the seal read it), the card names the pricing and the version by their
 * names and date, links to that version in SPHERE, and pricing-renderer draws the plan from the snapshot. Otherwise it is the
 * reference face: owner/name, plan, registry and add-ons, showing the pinned reference and nothing more (a version id is not a
 * name, and a reference forms no address of SPHERE). Nothing here reaches SPHERE but the link a reader follows.
 */
export function PricingCard({ reference, snapshot = null, yaml }: PricingCardProps) {
  const title = useId();
  const { sphere, registry, plan, addons = [] } = reference;
  const date = formatDate(snapshot?.createdAt);
  const link =
    snapshot?.permanentUrl && /^https:\/\//.test(snapshot.permanentUrl)
      ? snapshot.permanentUrl
      : null;
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-3"
      aria-labelledby={title}
      data-snapshotted={snapshot ? 'true' : 'false'}
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3
          id={title}
          className="m-0 text-[15px] font-semibold [overflow-wrap:anywhere] text-tp-ink"
        >
          Plan {plan}
        </h3>
        <span className="text-[13px] [overflow-wrap:anywhere] text-tp-slate">
          {snapshot ? snapshot.title : <span className="font-mono">{sphere}</span>}
        </span>
      </header>
      <dl className="m-0 flex flex-col gap-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:min-w-16 [&_dt]:text-tp-steel [&>div]:flex [&>div]:min-w-0 [&>div]:flex-wrap [&>div]:gap-x-2 [&>div]:gap-y-1 [&>div]:text-[13px]">
        <div>
          <dt>Version</dt>
          <dd>
            {snapshot?.versionName
              ? `${snapshot.versionName}${date ? ` · ${date}` : ''}`
              : 'The pinned version (no copy here)'}
          </dd>
        </div>
        <div>
          <dt>SPHERE</dt>
          <dd>
            {registry ? (
              <>
                Registry <code>{registry}</code>
              </>
            ) : (
              'This installation’s'
            )}
          </dd>
        </div>
        <div>
          <dt>Add-ons</dt>
          <dd>{addons.length ? addons.join(', ') : 'None'}</dd>
        </div>
      </dl>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-tp-link underline"
        >
          Open in SPHERE
          <MdOpenInNew aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      )}
      {yaml !== undefined ? (
        <Suspense
          fallback={
            <p className="m-0 text-xs text-tp-steel" role="status">
              Drawing the plan…
            </p>
          }
        >
          <PricingPlan yaml={yaml} plan={plan} addOns={addons} />
        </Suspense>
      ) : (
        <p className="m-0 text-xs text-tp-steel">
          Showing the pinned reference: OpenBinding holds no copy of this version, so its prices and
          limits are kept in SPHERE.
        </p>
      )}
    </article>
  );
}
