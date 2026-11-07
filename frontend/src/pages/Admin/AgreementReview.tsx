import { useMemo, type ForwardRefExoticComponent, type RefAttributes } from 'react';
import { compareSelections, normalizePricing, type IPricingLike, type PricingSelection } from 'pricing-renderer';
import { PricingChangeReview, type PricingChangeReviewElement, type PricingChangeReviewProps } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';

/**
 * The React props of the review (0.2.0) leave out `hideSections`, which the element has. The adapter sets every property the
 * element declares, so the prop reaches it all the same; only the type has to say so.
 */
const ChangeReview = PricingChangeReview as ForwardRefExoticComponent<
  PricingChangeReviewProps & Pick<PricingChangeReviewElement, 'hideSections'> & RefAttributes<PricingChangeReviewElement>
>;

/**
 * The Upgrade/Downgrade badge reads the order in which the document declares its plans as a ladder, and OpenBinding's plans are
 * not one: RESEARCH is free and is declared after ADVANCED.
 */
const HIDDEN_SECTIONS = ['relation'] as const;

/** The review speaks to the holder of the subscription by default; here an administrator reviews somebody else's contract. */
const MESSAGES: Record<string, string> = {
  'pricing.reviewBack': 'Back',
  'pricing.reviewPending': 'Applying the change…',
  'pricing.reviewErrorTitle': 'The change couldn’t be applied.',
  'pricing.reviewNoChanges': 'This is the contract the account already has.',
  'pricing.contactSales': 'By agreement',
  'pricing.reviewDifferenceQuote': 'No difference is shown: paid plans and add-ons are arranged by agreement.',
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
  pending: boolean;
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
export default function AgreementReview({ pricing, before, after, title, confirmLabel, notices, pending, error, onConfirm, onBack }: AgreementReviewProps) {
  const read = useMemo(() => (pricing ? normalizePricing(pricing) : null), [pricing]);
  // One object for as long as the change stays the same: the element moves the focus to its heading on every new comparison.
  const comparison = useMemo(() => (read?.value
    ? compareSelections({ before: { pricing: read.value, selection: before }, after: { pricing: read.value, selection: after } })
    : null), [read, before, after]);
  const messages = useMemo(() => ({ ...MESSAGES, 'pricing.reviewTitle': title }), [title]);

  if (!comparison) {
    const codes = (read?.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.code);
    return (
      <div className="adm-review" role="group" aria-label={title}>
        <Notice tone="warning" title="The change can’t be drawn side by side">
          The pricing document can’t be read for the comparison{codes.length > 0 ? ` (${codes.join(', ')})` : ''}. The gateway still checks the change when it’s applied.
        </Notice>
        {notices.length > 0 && <ul className="adm-review-notes">{notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>}
        {error && <Notice tone="error" title={MESSAGES['pricing.reviewErrorTitle']}>{error}</Notice>}
        <div className="adm-buttons">
          <Action variant="secondary" onClick={onBack}>Back</Action>
          <Action variant="primary" busy={pending} onClick={onConfirm}>{confirmLabel}</Action>
        </div>
      </div>
    );
  }

  return (
    <div className="adm-review">
      <ChangeReview
        comparison={comparison}
        hideSections={HIDDEN_SECTIONS}
        messages={messages}
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
