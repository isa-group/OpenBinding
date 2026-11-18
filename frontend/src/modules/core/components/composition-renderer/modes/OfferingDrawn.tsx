import { lazy, Suspense } from 'react';
import { Notice } from '../../notice';
import { offeringReadText, type RendererUpstream } from '../../../utils/composition/upstream';

// The storefront loads pricing-renderer, so it comes in its own chunk, and only when an offering snapshot is held.
const Storefront = lazy(() => import('./Storefront'));

/** The offering as the evaluation read it: the storefront from its snapshot, or why it was not read. */
export function OfferingDrawn({ upstream }: { upstream: RendererUpstream | null }) {
  const offering = upstream?.view.offering ?? null;
  const words = offeringReadText(offering);
  const yaml = offering?.snapshot ? upstream?.yaml[offering.snapshot.id] : undefined;
  if (!offering?.status)
    return (
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        No evaluation has read the offering yet: its plans and prices show once one does.
      </p>
    );
  if (offering.status !== 'read') return <Notice tone="warning">{words}</Notice>;
  return (
    <div className="cr-storefront flex min-w-0 flex-col gap-2">
      <p className="cr-muted m-0 text-[13px] text-tp-steel">{words}</p>
      {yaml !== undefined && (
        <Suspense
          fallback={
            <p className="m-0 text-xs text-tp-steel" role="status">
              Drawing the offering…
            </p>
          }
        >
          <Storefront yaml={yaml} />
        </Suspense>
      )}
    </div>
  );
}
