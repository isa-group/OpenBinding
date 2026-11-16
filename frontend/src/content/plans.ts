/** The pricing version these figures were copied from. The live pricings are administered in the SPACE and SPHERE consoles. */
export const PRICING_VERSION = '0.2.0';

export interface PlanSummary {
  name: string;
  price: string;
  how: string;
  /** Headline limits: API keys and concurrent runs. */
  chips: readonly string[];
}

/**
 * The home page's plan strip. A summary only: the Pricing page renders the live document and is the source of
 * truth, so this list must be revisited whenever the pricing version changes.
 */
export const planSummaries: readonly PlanSummary[] = [
  {
    name: 'Free',
    price: 'Free',
    how: 'Default plan when you sign up.',
    chips: ['2 API keys', '1 concurrent run'],
  },
  {
    name: 'Research',
    price: 'Free with verified CAS',
    how: 'For Universidad de Sevilla accounts with a verified CAS identity.',
    chips: ['10 API keys', '4 concurrent runs'],
  },
  {
    name: 'Lab',
    price: 'Contact us',
    how: 'By agreement, for groups that run benchmark campaigns or operate engines.',
    chips: ['200 API keys', '32 concurrent runs'],
  },
];
