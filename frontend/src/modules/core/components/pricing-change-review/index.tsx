import type { CSSProperties, ForwardRefExoticComponent, RefAttributes } from 'react';
import type { SelectionComparison } from 'pricing-renderer';
import {
  PricingChangeReview as RendererChangeReview,
  type PricingChangeReviewElement,
  type PricingChangeReviewProps as RendererProps,
} from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';

/**
 * The React props of the review (0.2.0) leave out `hideSections`, which the element has. The adapter sets every property the
 * element declares, so the prop reaches it all the same; only the type has to say so.
 */
const ChangeReview = RendererChangeReview as ForwardRefExoticComponent<
  RendererProps &
    Pick<PricingChangeReviewElement, 'hideSections'> &
    RefAttributes<PricingChangeReviewElement>
>;

type ReviewSection = NonNullable<PricingChangeReviewElement['hideSections']>[number];

/** The review in the interface's palette: pricing-renderer's custom properties set to the `tp` tokens. */
const REVIEW_TOKENS = {
  '--pr-color-text': 'var(--color-tp-ink)',
  '--pr-color-muted': 'var(--color-tp-steel)',
  '--pr-color-surface': 'var(--color-tp-canvas)',
  '--pr-color-surface-raised': 'var(--color-tp-canvas)',
  '--pr-color-surface-subtle': 'var(--color-tp-surface)',
  '--pr-color-border': 'var(--color-tp-hairline)',
  '--pr-color-border-strong': 'var(--color-tp-hairline-strong)',
  '--pr-color-accent': 'var(--color-tp-accent)',
  '--pr-color-link': 'var(--color-tp-link)',
  '--pr-color-focus': 'var(--color-tp-primary)',
  '--pr-color-success': 'var(--color-tp-success-text)',
  '--pr-color-warning': 'var(--color-tp-warning-text)',
  '--pr-color-warning-surface': 'var(--color-tp-severity-warning-bg)',
  '--pr-radius-sm': '0.375rem',
  '--pr-radius-md': '0.5rem',
  '--pr-radius-lg': '0.75rem',
  '--pr-shadow-sm': 'none',
} as CSSProperties;

/** Inside a card the review keeps the card's scale: its title and section headings at the size of the card's own. */
const REVIEW_SCALE =
  'flex min-w-0 flex-col gap-3 [&_[data-pr-part=review-title]]:text-lg [&_[data-pr-part=review-title]]:font-semibold [&_[data-pr-part=review-title]]:tracking-normal [&_[data-pr-part=change-review]>section>h3]:text-[15px] [&_[data-pr-part=change-review]>section>h3]:font-semibold [&_[data-pr-part=change-review]>section>h3]:tracking-normal';

export interface PricingChangeReviewProps {
  /** The two sides, as pricing-renderer's `compareSelections` reads them. */
  comparison: SelectionComparison;
  /** The heading, which takes the focus when the review opens. */
  title: string;
  /** Words over the package's own (`pricing.*` keys). */
  messages?: Readonly<Record<string, string>>;
  notices?: string[];
  pending?: boolean;
  error?: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  onBack?: () => void;
  /** A comparison to read only: no Confirm or Back. */
  readOnly?: boolean;
  /**
   * The Upgrade/Downgrade badge reads the order in which a document declares its plans as a ladder; hide it where the plans
   * are not one (OpenBinding's own, where RESEARCH is free and declared between FREE and LAB) or where two versions are
   * compared rather than two plans.
   */
  hideRelation?: boolean;
}

/**
 * What changes between two selections of a pricing, drawn by pricing-renderer's change review: the plan, the price, the add-ons,
 * the features and the limits before and after. The administration reviews a subscription change with it (Confirm and Back);
 * the SPHERE wizard and a composition's version comparison review a provider's plan across two versions of its pricing, read
 * only. It draws; the decision data (which candidates change) is the gateway's.
 */
export default function PricingChangeReview({
  comparison,
  title,
  messages,
  notices = [],
  pending = false,
  error,
  confirmLabel,
  onConfirm,
  onBack,
  readOnly = false,
  hideRelation = true,
}: PricingChangeReviewProps) {
  const hidden: ReviewSection[] = [
    ...(hideRelation ? (['relation'] as const) : []),
    ...(readOnly ? (['actions'] as const) : []),
  ];
  return (
    <div className={REVIEW_SCALE} style={REVIEW_TOKENS}>
      <ChangeReview
        comparison={comparison}
        hideSections={hidden}
        messages={{ ...messages, 'pricing.reviewTitle': title }}
        notices={notices}
        pending={pending}
        error={error}
        confirmLabel={confirmLabel}
        onConfirm={onConfirm}
        onBack={onBack}
      />
    </div>
  );
}
