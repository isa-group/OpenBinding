/** The pricing version these figures were copied from. The live pricings are administered in the SPACE and SPHERE consoles. */
export const PRICING_VERSION = '0.1.0';

export interface PlanSummary {
  name: string;
  price: string;
  how: string;
  /** Headline limits: API keys and concurrent jobs. */
  chips: readonly string[];
}

/**
 * The home page's plan strip. A summary only: the Pricing page renders the live document and is the source of
 * truth, so this list must be revisited whenever the pricing version changes.
 */
export const planSummaries: readonly PlanSummary[] = [
  { name: 'Basic', price: 'Free', how: 'Default plan when you sign up.', chips: ['1 API key', '1 concurrent job'] },
  { name: 'Research', price: 'Free with verified CAS', how: 'For Universidad de Sevilla accounts with a verified CAS identity.', chips: ['25 API keys', '3 concurrent jobs'] },
  { name: 'Advanced', price: 'Contact us', how: 'Institutional agreement. Adds advanced analytics.', chips: ['10 API keys', '2 concurrent jobs'] },
  { name: 'Pro', price: 'Contact us', how: 'Institutional agreement. Adds the reproducibility archive.', chips: ['Unlimited API keys', '8 concurrent jobs'] },
];
