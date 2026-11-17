import { Link } from 'react-router-dom';
import { Default, ErrorFallback, Feature, Loading, On } from 'space-react-client';
import { usePricingTokenStatus } from '../../../../core/utils/pricingToken';
import type { PricingView } from '../../../../core/utils/pricing/pricingModel';

const STATE = 'rounded-full border px-2 py-0.5 text-[11px] font-medium';

/** What the account's signed pricing token says about each feature, through the space-react-client gates. */
export default function Entitlements({ view, plan }: { view: PricingView; plan: string }) {
  const token = usePricingTokenStatus();
  const note =
    token === 'valid'
      ? `Read from your signed pricing token for the ${plan} plan.`
      : 'We can’t confirm your features right now, so none is shown as enabled or disabled.';
  return (
    <section
      aria-labelledby="pricing-mine"
      className="flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 sm:p-6"
    >
      <h2 id="pricing-mine" className="font-display text-2xl text-tp-ink">
        Available to your account
      </h2>
      <p className="text-sm text-tp-slate">{note}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {view.features.map(feature => (
          <div
            key={feature.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-tp-hairline-soft px-3 py-2 text-sm text-tp-ink"
          >
            <span>{feature.name}</span>
            <Feature id={`${view.saasName.toLowerCase()}-${feature.id}`}>
              <On>
                <span
                  className={`${STATE} border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text`}
                >
                  Enabled
                </span>
              </On>
              <Default>
                <span className={`${STATE} border-tp-hairline bg-tp-surface text-tp-slate`}>
                  Not enabled
                </span>
              </Default>
              <Loading>
                <span
                  className={`${STATE} border-tp-hairline bg-tp-surface text-tp-steel`}
                  aria-live="polite"
                >
                  Checking…
                </span>
              </Loading>
              <ErrorFallback>
                <span
                  className={`${STATE} border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text`}
                >
                  Can’t confirm
                </span>
              </ErrorFallback>
            </Feature>
          </div>
        ))}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tp-steel">
        <Link
          to="/me/settings?section=plan"
          viewTransition
          className="cursor-pointer text-sm font-medium text-tp-accent hover:underline"
        >
          See your plan
        </Link>
        <span>These states only guide the interface. The server checks every action.</span>
      </p>
    </section>
  );
}
