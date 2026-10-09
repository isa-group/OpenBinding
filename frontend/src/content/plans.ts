/** The pricing document these figures were copied from: space/pricing/openbinding.yml. */
export const PRICING_VERSION = '0.1.0';

export interface PlanSummary {
  name: string;
  price: string;
  how: string;
  /** Headline limits: solves per month, concurrent jobs and study runs per month. */
  chips: readonly string[];
}

/**
 * The home page's plan strip. A summary only: the Pricing page renders the live document and is the source of
 * truth, so this list must be revisited whenever the pricing version changes.
 */
export const planSummaries: readonly PlanSummary[] = [
  { name: 'Basic', price: 'Free', how: 'Default plan when you sign up.', chips: ['10 solves / month', '1 concurrent job', '3 study runs / month'] },
  { name: 'Research', price: 'Free with verified CAS', how: 'For Universidad de Sevilla accounts with a verified CAS identity.', chips: ['50 solves / month', '3 concurrent jobs', '100 study runs / month'] },
  { name: 'Advanced', price: 'Contact us', how: 'Institutional agreement. Adds advanced analytics.', chips: ['25 solves / month', '2 concurrent jobs', '50 study runs / month'] },
  { name: 'Pro', price: 'Contact us', how: 'Institutional agreement. Adds the reproducibility archive.', chips: ['Unlimited solves', '8 concurrent jobs', '1,000 study runs / month'] },
];
