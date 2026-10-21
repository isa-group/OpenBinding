import { useNavigate } from 'react-router-dom';
import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import type { PricingCatalog } from '../../api/auth';
import { useAuth } from '../../contexts/auth';
import { withInfiniteLimits } from './pricingModel';

/**
 * The pricing document drawn by `pricing-renderer`, the same package every Pricing2Yaml consumer can use.
 * It is the long form of the comparison above, loaded only when someone opens it.
 */
export default function PricingDocument({ catalog }: { catalog: PricingCatalog }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="pricing-renderer-shell">
      <PricingRenderer
        pricing={withInfiniteLimits(catalog) as PricingCatalog}
        theme="light"
        pricingPath="/pricing"
        onAction={(event: CustomEvent) => {
          // Nothing to check out. Whoever is interested either needs an account first, or an agreement.
          event.preventDefault();
          navigate(user ? '/app/account/usage' : '/register', { viewTransition: true });
        }}
      />
    </div>
  );
}
