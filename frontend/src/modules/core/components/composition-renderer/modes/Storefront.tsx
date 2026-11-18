import { useMemo } from 'react';
import SpherePricingRenderer from '../../pricing-renderer';

/** The page already names the offering and the version; the storefront draws its plans and add-ons. */
const HIDDEN_SECTIONS = ['saasName', 'description', 'metadata'] as const;

/**
 * A composition's own pricing as a storefront: the offering's stored snapshot drawn by pricing-renderer through the bridge's
 * `commercial` preset (public plans, the package's own diagnostics mode).
 */
export default function Storefront({ yaml }: { yaml: string }) {
  const source = useMemo(() => ({ yaml }), [yaml]);
  return (
    <div data-testid="storefront" className="min-w-0">
      <SpherePricingRenderer
        source={source}
        preset="commercial"
        ctaEnabled={false}
        hideSections={HIDDEN_SECTIONS}
      />
    </div>
  );
}
