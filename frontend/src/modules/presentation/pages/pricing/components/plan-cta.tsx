import { Action } from '../../../../core/components/action-button';
import type { PlanColumn } from '../../../../core/utils/pricing/pricingModel';

interface PlanCtaProps {
  plan: PlanColumn;
  signedIn: boolean;
  /** The account is on this plan: nothing to offer. */
  current: boolean;
  onContact: (plan: string) => void;
}

/**
 * What a plan offers, the same in the drawn document and in the comparison: nothing on the account's own plan, the contact
 * dialog for a plan arranged by agreement, CAS for RESEARCH, sign-up for a free plan. Nothing is bought here.
 */
export default function PlanCta({ plan, signedIn, current, onContact }: PlanCtaProps) {
  if (current) return null;
  if (plan.byAgreement)
    return (
      <Action variant="secondary" size="md" onClick={() => onContact(plan.id)}>
        Contact us
      </Action>
    );
  if (plan.id === 'RESEARCH') {
    return signedIn ? (
      <Action variant="primary" to="/me/settings?section=integrations">
        Link CAS identity
      </Action>
    ) : (
      <Action variant="primary" to="/authentication">
        Log in with CAS
      </Action>
    );
  }
  if (!signedIn && plan.priceLabel === 'Free')
    return (
      <Action variant="primary" to="/authentication?view=register">
        Sign up
      </Action>
    );
  return null;
}
