import {
  useMemo,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react';
import {
  compareSelections,
  normalizePricing,
  type IPricingLike,
  type PricingSelection,
} from 'pricing-renderer';
import {
  PricingChangeReview,
  type PricingChangeReviewElement,
  type PricingChangeReviewProps,
} from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';

/**
 * The React props of the review (0.2.0) leave out `hideSections`, which the element has. The adapter sets every property the
 * element declares, so the prop reaches it all the same; only the type has to say so.
 */
const ChangeReview = PricingChangeReview as ForwardRefExoticComponent<
  PricingChangeReviewProps &
    Pick<PricingChangeReviewElement, 'hideSections'> &
    RefAttributes<PricingChangeReviewElement>
>;

/**
 * The Upgrade/Downgrade badge reads the order in which the document declares its plans as a ladder, and OpenBinding's plans are
 * not one: RESEARCH is free and is declared between FREE and LAB.
 */
const HIDDEN_SECTIONS = ['relation'] as const;

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

/** The review speaks to the holder of the subscription by default; here an administrator reviews somebody else's contract. */
const MESSAGES: Record<string, string> = {
  'pricing.reviewBack': 'Back',
  'pricing.reviewErrorTitle': 'The change couldn’t be applied.',
  'pricing.reviewNoChanges': 'This is the contract the account already has.',
  'pricing.contactSales': 'By agreement',
  'pricing.reviewDifferenceQuote':
    'No difference is shown: paid plans and add-ons are arranged by agreement.',
};

/** What keeps the change from being confirmed for now: the request that applies it, or a new reading of the subscription. */
export type ReviewPending = 'applying' | 'reading';

const PENDING: Record<ReviewPending, string> = {
  applying: 'Applying the change…',
  reading: 'Reading the subscription again…',
};

export interface AgreementReviewProps {
  /** The pricing document as the review reads it; `null` when there is none to read. */
  pricing: IPricingLike | null;
  /** The contract today. */
  before: PricingSelection;
  /** The contract the request asks for. */
  after: PricingSelection;
  /** The heading of the review, which takes the focus when it opens. */
  title: string;
  confirmLabel: string;
  /** What the request carries besides the contract, and what follows from it. */
  notices: string[];
  /** Why the change can't be confirmed right now, if it can't. */
  pending: ReviewPending | null;
  /** Why the last attempt was refused, when it was. */
  error?: string;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * What a subscription change does, drawn by the change review of `pricing-renderer`: the plan, the price, the add-ons, the features
 * and the limits before and after, then Confirm and Back. Loaded only when an administrator asks to apply a change.
 *
 * Both sides are compared on the same document, the active pricing: it is the one the gateway serves and the one the form above
 * offers. A document the renderer can't read still leaves the change reviewable in words, so that nobody is locked out of a
 * contract change by its drawing.
 */
export default function AgreementReview({
  pricing,
  before,
  after,
  title,
  confirmLabel,
  notices,
  pending,
  error,
  onConfirm,
  onBack,
}: AgreementReviewProps) {
  const read = useMemo(() => (pricing ? normalizePricing(pricing) : null), [pricing]);
  // One object for as long as the change stays the same: the element moves the focus to its heading on every new comparison.
  const comparison = useMemo(
    () =>
      read?.value
        ? compareSelections({
            before: { pricing: read.value, selection: before },
            after: { pricing: read.value, selection: after },
          })
        : null,
    [read, before, after]
  );
  const messages = useMemo(
    () => ({
      ...MESSAGES,
      'pricing.reviewTitle': title,
      'pricing.reviewPending': PENDING[pending ?? 'applying'],
    }),
    [title, pending]
  );

  if (!comparison) {
    const codes = (read?.diagnostics ?? [])
      .filter(diagnostic => diagnostic.severity === 'error')
      .map(diagnostic => diagnostic.code);
    return (
      <div className="flex min-w-0 flex-col gap-3" role="group" aria-label={title}>
        <Notice tone="warning" title="The change can’t be drawn side by side">
          The pricing document can’t be read for the comparison
          {codes.length > 0 ? ` (${codes.join(', ')})` : ''}. The gateway still checks the change
          when it’s applied.
        </Notice>
        {notices.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-tp-slate">
            {notices.map(notice => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}
        {error && (
          <Notice tone="error" title={MESSAGES['pricing.reviewErrorTitle']}>
            {error}
          </Notice>
        )}
        {pending && (
          <p className="text-[13px] text-tp-steel" role="status">
            {PENDING[pending]}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Action variant="secondary" onClick={onBack}>
            Back
          </Action>
          <Action variant="primary" busy={pending !== null} onClick={onConfirm}>
            {confirmLabel}
          </Action>
        </div>
      </div>
    );
  }

  return (
    <div className={REVIEW_SCALE} style={REVIEW_TOKENS}>
      <ChangeReview
        comparison={comparison}
        hideSections={HIDDEN_SECTIONS}
        messages={messages}
        notices={notices}
        pending={pending !== null}
        error={error}
        confirmLabel={confirmLabel}
        onConfirm={onConfirm}
        onBack={onBack}
      />
    </div>
  );
}
