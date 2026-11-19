import { MdArrowForward, MdCheck } from 'react-icons/md';
import { Action } from '../../../../core/components/action-button';
import type { PricingView } from '../../../../core/utils/pricing/pricingModel';

/** A card of the page under the drawn document, in SPHERE's recipe. */
const CARD = 'flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 sm:p-6';
const TITLE = 'font-display text-2xl text-tp-ink';

const GATE_COUNT: Record<number, string> = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };

const LIMIT_OUTCOMES = [
  {
    mark: 'Reduced',
    title: 'Budgets above your ceiling are lowered',
    body: 'A time budget above your plan’s maximum time per run, or an iteration count above what the deployment allows, runs at the ceiling, with an OPTION_CLAMPED note showing requested and applied values.',
  },
  {
    mark: 'Wait',
    title: 'A plan allowance reached or busy slots',
    body: 'A plan allowance that is full (402) stays full until you free something or change plan. Busy run slots (429) free up in seconds.',
  },
  {
    mark: 'Rejected',
    title: 'The problem is too big for the deployment',
    body: 'A binding space above the deployment’s technical ceiling can’t run in a smaller form. Reduce candidates or tasks.',
  },
];

/** The features that also check the account's limits each time something starts. */
export function Gates({ view }: { view: PricingView }) {
  if (view.gates.length === 0) return null;
  return (
    <section aria-labelledby="pricing-gates" className={CARD}>
      <h2 id="pricing-gates" className={TITLE}>
        What has to have room before you start
      </h2>
      <p className="max-w-3xl text-sm text-tp-slate">
        {GATE_COUNT[view.gates.length] ?? view.gates.length}{' '}
        {view.gates.length === 1 ? 'feature also checks' : 'features also check'} your limits each
        time you start something. Everything else only needs to be included in your plan.
      </p>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
        {view.gates.map(gate => (
          <li
            key={gate.starts}
            className="flex flex-col gap-2.5 rounded-xl border border-tp-hairline-soft p-4"
          >
            <span className="inline-flex items-center gap-2 font-semibold text-tp-ink">
              <MdArrowForward className="h-4 w-4 text-tp-accent" aria-hidden="true" />
              Start {gate.starts}
            </span>
            <span className="text-xs text-tp-steel">Needs all of:</span>
            <ul className="flex flex-col gap-1.5">
              {gate.needs.map(need => (
                <li key={need} className="flex items-center gap-2 text-sm text-tp-charcoal">
                  <MdCheck className="h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />
                  {need}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The add-ons, each arranged under an agreement; for an account, whether its plan may have it. */
export function AddOns({ view, plan }: { view: PricingView; plan: string | null }) {
  if (view.addOns.length === 0) return null;
  const withoutAddOns = view.plans
    .filter(item => !view.addOns.some(addOn => addOn.plans.includes(item.id)))
    .map(item => item.id);
  return (
    <section aria-labelledby="pricing-addons" className={CARD}>
      <h2 id="pricing-addons" className={TITLE}>
        Add-ons
      </h2>
      <p className="text-sm text-tp-slate">
        Arranged under an agreement, in whole packs.
        {withoutAddOns.length > 0 &&
          ` ${withoutAddOns.join(' and ')} ${withoutAddOns.length === 1 ? 'has' : 'have'} no add-ons.`}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {view.addOns.map(addOn => {
          const available = plan ? addOn.plans.includes(plan) : null;
          return (
            <article
              key={addOn.id}
              className="flex flex-col gap-2 rounded-xl border border-tp-hairline-soft p-4"
            >
              <div className="flex items-center gap-2">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tp-accent text-sm font-semibold text-tp-on-primary"
                  aria-hidden="true"
                >
                  {addOn.initial}
                </span>
                <span className="min-w-0 flex-1 font-mono text-sm break-all text-tp-ink">
                  {addOn.id}
                </span>
                <span className="rounded-full border border-tp-primary/30 bg-tp-primary/10 px-2 py-0.5 text-[11px] font-medium text-tp-accent">
                  Contact us
                </span>
              </div>
              <span className="text-sm text-tp-charcoal">{addOn.effect}</span>
              <span className="text-xs text-tp-steel">
                For {addOn.plans.join(', ')} · {addOn.quantity} · per {addOn.per}
              </span>
              {available !== null && (
                <span
                  className={`self-start rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    available
                      ? 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text'
                      : 'border-tp-hairline bg-tp-surface text-tp-slate'
                  }`}
                >
                  {available ? 'Available under agreement' : 'Not available on your plan'}
                </span>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** The three outcomes of reaching a limit. */
export function LimitOutcomes() {
  return (
    <section aria-labelledby="pricing-limits" className={CARD}>
      <h2 id="pricing-limits" className={TITLE}>
        What happens when you reach a limit
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {LIMIT_OUTCOMES.map(outcome => (
          <div
            key={outcome.mark}
            className="flex flex-col gap-1.5 rounded-xl border border-tp-hairline-soft p-4 text-sm text-tp-slate"
          >
            <span className="self-start rounded-full bg-tp-surface px-2 py-0.5 text-[11px] font-semibold tracking-wide text-tp-ink uppercase">
              {outcome.mark}
            </span>
            <strong className="text-tp-ink">{outcome.title}</strong>
            <span>{outcome.body}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The RESEARCH plan: a verified Universidad de Sevilla e-mail, or an administrator's grant. */
export function ResearchCard({ signedIn }: { signedIn: boolean }) {
  return (
    <section
      aria-label="RESEARCH for Universidad de Sevilla"
      className="flex flex-wrap items-center gap-4 rounded-xl border border-tp-hairline bg-tp-surface-cream-soft p-5 sm:p-6"
    >
      <span
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-tp-accent font-semibold text-tp-on-primary"
        aria-hidden="true"
      >
        US
      </span>
      <div className="min-w-[260px] flex-1">
        <strong className="text-tp-ink">RESEARCH for Universidad de Sevilla</strong>
        <p className="text-sm text-tp-slate">
          Free for a verified e-mail at us.es or alum.us.es, or granted by an administrator. It’s a
          plan, not a role: it doesn’t make you an admin or change your organization roles.
        </p>
      </div>
      <Action variant="primary" to={signedIn ? '/me/settings?section=plan' : '/authentication'}>
        {signedIn ? 'How to get RESEARCH' : 'Sign in'}
      </Action>
    </section>
  );
}
