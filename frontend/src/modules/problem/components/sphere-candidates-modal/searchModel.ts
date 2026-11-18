import type { SpherePricingRow, SpherePricingSearch } from '../../api/sphereApi';

// What the SPHERE search of the wizard (pricing-search.tsx) holds and says, apart from its drawing.

/** The most rows a search lists (the gateway's own cap). */
export const MAX_RESULTS = 24;
/** How long the search waits after typing. */
export const SEARCH_DELAY_MS = 300;

const formatDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
};

/** A pricing's owner as SPHERE names it. */
const ownerOf = (row: SpherePricingRow) => row.owner?.displayName || row.owner?.name || null;

/** What a row says under its name: owner, latest version and date, collection. */
export function rowLine(row: SpherePricingRow): string {
  return [
    ownerOf(row),
    `latest ${row.latestVersion.label}`,
    formatDate(row.latestVersion.createdAt),
    row.collection?.name ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The lower edges of SPHERE's whole-result histogram of minimum prices: the scale of "at least". */
export function priceSteps(search: SpherePricingSearch | null): number[] {
  const facet = search?.facets.minPrice as { data?: Array<{ value: string }> } | null | undefined;
  const edges = (facet?.data ?? [])
    .map(bucket => Number.parseFloat(bucket.value.split('-')[0].replace('+', '')))
    .filter(edge => Number.isFinite(edge) && edge > 0);
  return [...new Set(edges)].sort((a, b) => a - b);
}

export interface PricingSearchFilters {
  q: string;
  collection: string;
  organization: string;
  registry: string;
  minPrice: number | null;
  sort: 'name' | 'minPrice';
}

export const NO_FILTERS: PricingSearchFilters = {
  q: '',
  collection: '',
  organization: '',
  registry: '',
  minPrice: null,
  sort: 'name',
};

/** What the search reports up: the row chosen and the registry it was listed under (null for this installation's SPHERE). */
export interface ChosenPricing {
  row: SpherePricingRow;
  registry: string | null;
}
