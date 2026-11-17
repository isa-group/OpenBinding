// Adapted from SPHERE frontend/src/modules/core/components/pricing-list-view/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: any resource, not only pricings: the page passes its fetch, its card and its filters (a choice list such as the
// kinds, and the gateway's numeric ranges), so `core` imports no domain module. The search, the filters and the page live
// in the address (`?q=&owners=&kinds=&min_tasks=&page=`), so a list can be linked and the back button restores it. The
// owner facet comes from the gateway, counted over every match and named by slug (SPHERE's counted one page and sent
// display names as `selectedOwners`, which its API reads as `selectedOrganizations`). A failed load says so and offers
// Retry instead of showing an empty list, and a newer request cancels the one in flight. A page may say something under the
// title (the engine catalog says whose engines it shows).

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Skeleton from 'react-loading-skeleton';
import { useSearchParams } from 'react-router-dom';
import { readApiError } from '../../api/errors';
import { fadeInUp, staggerContainer, transitionDefault } from '../../utils/motion-variants';
import DualRangeSlider from '../dual-range-slider';
import Pagination from '../pagination';
import SearchInput from '../search-input';

/** A gateway histogram: SPHERE's ten buckets over a number of every match. */
export interface ListRangeFacet {
  min?: number | null;
  max?: number | null;
  data?: { value: string; count: number }[];
}

/** The facets a list answers, over every match. */
export interface ListFacets {
  owners?: { slug: string; name: string; count: number }[];
  ranges?: Record<string, ListRangeFacet | undefined>;
}

export interface ListPage<T> {
  items: T[];
  total: number;
  facets?: ListFacets | null;
}

/** A filter of a fixed set of values (the kinds), sent as one comma-separated parameter. */
export interface ChoiceFilter {
  param: string;
  label: string;
  options: { value: string; label: string }[];
}

/** A filter over one of the gateway's ranges (`min_<name>` and `max_<name>`). */
export interface RangeFilter {
  name: string;
  label: string;
  format?: (value: number) => string;
}

interface Props<T> {
  /** One page of the list: the address's filters as the gateway's parameters, plus `limit` and `offset`. */
  fetchItems: (params: Record<string, string>, signal: AbortSignal) => Promise<ListPage<T>>;
  renderItem: (item: T) => ReactNode;
  itemKey: (item: T) => string;
  title: string;
  subtitle: string;
  /** The resource's name, singular and plural, for the count line and the empty box. */
  noun: [string, string];
  perPage?: number;
  /** Offer the owner facet (an organization filter); off where the list is one organization's. */
  ownerFilter?: boolean;
  choiceFilters?: ChoiceFilter[];
  rangeFilters?: RangeFilter[];
  /** What the page shows beside the title (a "New" button). */
  actions?: ReactNode;
  /** What the page says under the title, above the search (who sees what). */
  banner?: ReactNode;
  /** Change it to load the page again (after an item changed). */
  refreshKey?: number;
}

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);

const numberParam = (value: string | null) => {
  if (value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const ceiling = (facet: ListRangeFacet | undefined) =>
  facet?.max !== null && facet?.max !== undefined ? Math.ceil(facet.max) : 0;

export default function ResourceListView<T>({
  fetchItems,
  renderItem,
  itemKey,
  title,
  subtitle,
  noun,
  perPage = 12,
  ownerFilter = true,
  choiceFilters = [],
  rangeFilters = [],
  actions,
  banner,
  refreshKey = 0,
}: Props<T>) {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<ListFacets | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const owners = useMemo(() => list(params.get('owners')), [params]);
  const choices = useMemo(
    () =>
      Object.fromEntries(
        choiceFilters.map(filter => [filter.param, list(params.get(filter.param))])
      ),
    [choiceFilters, params]
  );
  const ranges = useMemo(
    () =>
      Object.fromEntries(
        rangeFilters.map(filter => [
          filter.name,
          [
            numberParam(params.get(`min_${filter.name}`)),
            numberParam(params.get(`max_${filter.name}`)),
          ],
        ])
      ) as Record<string, [number | undefined, number | undefined]>,
    [rangeFilters, params]
  );

  // The draft the panel edits; Apply commits it to the address.
  const [draftOwners, setDraftOwners] = useState<string[]>(owners);
  const [draftChoices, setDraftChoices] = useState<Record<string, string[]>>(choices);
  const [draftRanges, setDraftRanges] = useState<Record<string, [number, number]>>({});

  const query = params.toString();
  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams(query);
    search.delete('page');
    const request: Record<string, string> = Object.fromEntries(search.entries());
    request.limit = String(perPage);
    request.offset = String((page - 1) * perPage);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's loading flag, raised before each request
    setIsLoading(true);
    setError(null);
    fetchItems(request, controller.signal)
      .then(answer => {
        if (controller.signal.aborted) return;
        setItems(answer.items);
        setTotal(answer.total);
        setFacets(answer.facets ?? null);
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setItems([]);
        setTotal(0);
        setError(readApiError(caught).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [fetchItems, query, page, perPage, attempt, refreshKey]);

  const ownerFilters = useMemo(
    () =>
      (facets?.owners ?? []).map(owner => ({
        label: owner.name,
        value: owner.slug,
        count: owner.count,
      })),
    [facets]
  );

  const rangeLimits = useMemo(
    () =>
      rangeFilters
        .map(filter => ({ filter, max: ceiling(facets?.ranges?.[filter.name]) }))
        .filter(({ max }) => max > 0),
    [facets, rangeFilters]
  );

  const update = useCallback(
    (change: (next: URLSearchParams) => void) => {
      setParams(
        previous => {
          const next = new URLSearchParams(previous);
          change(next);
          next.delete('page');
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const openFilters = () => {
    if (!showFilters) {
      setDraftOwners(owners);
      setDraftChoices(choices);
      setDraftRanges(
        Object.fromEntries(
          rangeLimits.map(({ filter, max }) => {
            const [low, high] = ranges[filter.name] ?? [];
            return [filter.name, [low ?? 0, Math.min(high ?? max, max)]];
          })
        )
      );
    }
    setShowFilters(!showFilters);
  };

  const hasActive =
    owners.length > 0 ||
    Object.values(choices).some(values => values.length > 0) ||
    Object.values(ranges).some(([low, high]) => low !== undefined || high !== undefined);

  const applyFilters = () =>
    update(next => {
      if (draftOwners.length) next.set('owners', draftOwners.join(','));
      else next.delete('owners');
      for (const filter of choiceFilters) {
        const values = draftChoices[filter.param] ?? [];
        if (values.length) next.set(filter.param, values.join(','));
        else next.delete(filter.param);
      }
      for (const { filter, max } of rangeLimits) {
        const [low, high] = draftRanges[filter.name] ?? [0, max];
        if (low > 0) next.set(`min_${filter.name}`, String(low));
        else next.delete(`min_${filter.name}`);
        if (high < max) next.set(`max_${filter.name}`, String(high));
        else next.delete(`max_${filter.name}`);
      }
    });

  const clearAll = () => {
    setDraftOwners([]);
    setDraftChoices({});
    setDraftRanges(
      Object.fromEntries(rangeLimits.map(({ filter, max }) => [filter.name, [0, max]]))
    );
    update(next => {
      for (const name of [...next.keys()]) next.delete(name);
    });
  };

  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter(item => item !== value) : [...values, value];

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const [singular, plural] = noun;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionDefault}
        className="mb-6 flex flex-wrap items-end justify-between gap-3"
      >
        <div>
          <h1 className="font-display text-2xl font-normal text-tp-ink">{title}</h1>
          <p className="mt-1 text-sm text-tp-steel">{subtitle}</p>
        </div>
        {actions}
      </motion.div>

      {banner && <div className="mb-5">{banner}</div>}

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...transitionDefault, delay: 0.05 }}
        className="mb-5 flex items-center gap-3"
      >
        <div className="min-w-0 flex-1">
          <SearchInput
            key={q}
            initialValue={q}
            placeholder="Search by name..."
            onSearch={value =>
              update(next => {
                if (value) next.set('q', value);
                else next.delete('q');
              })
            }
          />
        </div>
        <button
          type="button"
          onClick={openFilters}
          aria-expanded={showFilters}
          className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
            hasActive
              ? 'border-tp-primary/30 bg-tp-primary/5 text-tp-accent'
              : 'border-tp-hairline-strong bg-tp-canvas text-tp-slate hover:border-tp-hairline hover:text-tp-ink'
          }`}
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 00-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"
            />
          </svg>
          Filters
          {hasActive && (
            <span
              className="flex h-4 w-4 items-center justify-center rounded-full bg-tp-accent text-[9px] text-tp-on-primary"
              aria-label="active"
            >
              !
            </span>
          )}
        </button>
      </motion.div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              role="group"
              aria-label="Filters"
              className="mb-5 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {ownerFilter && ownerFilters.length > 0 && (
                  <fieldset>
                    <legend className="mb-1.5 block text-[11px] font-medium text-tp-steel">
                      Owner ({ownerFilters.length})
                    </legend>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-tp-hairline p-1.5">
                      {ownerFilters.map(owner => (
                        <label
                          key={owner.value}
                          className="flex cursor-pointer items-center gap-1.5 text-xs text-tp-slate hover:text-tp-ink"
                        >
                          <input
                            type="checkbox"
                            checked={draftOwners.includes(owner.value)}
                            onChange={() => setDraftOwners(current => toggle(current, owner.value))}
                            className="h-3.5 w-3.5 rounded border-tp-hairline-strong text-tp-primary focus:ring-tp-primary"
                          />
                          <span className="flex-1 truncate">{owner.label}</span>
                          <span className="text-[10px] text-tp-steel">{owner.count}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                {choiceFilters.map(filter => (
                  <fieldset key={filter.param}>
                    <legend className="mb-1.5 block text-[11px] font-medium text-tp-steel">
                      {filter.label}
                    </legend>
                    <div className="space-y-1 rounded-lg border border-tp-hairline p-1.5">
                      {filter.options.map(option => (
                        <label
                          key={option.value}
                          className="flex cursor-pointer items-center gap-1.5 text-xs text-tp-slate hover:text-tp-ink"
                        >
                          <input
                            type="checkbox"
                            checked={(draftChoices[filter.param] ?? []).includes(option.value)}
                            onChange={() =>
                              setDraftChoices(current => ({
                                ...current,
                                [filter.param]: toggle(current[filter.param] ?? [], option.value),
                              }))
                            }
                            className="h-3.5 w-3.5 rounded border-tp-hairline-strong text-tp-primary focus:ring-tp-primary"
                          />
                          <span className="flex-1 truncate">{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}

                {rangeLimits.map(({ filter, max }) => (
                  <div key={filter.name}>
                    <span className="mb-1.5 block text-[11px] font-medium text-tp-steel">
                      {filter.label}
                    </span>
                    <DualRangeSlider
                      label={filter.label}
                      min={0}
                      max={max}
                      value={draftRanges[filter.name] ?? [0, max]}
                      onChange={value =>
                        setDraftRanges(current => ({ ...current, [filter.name]: value }))
                      }
                      formatLabel={filter.format ?? (value => value.toLocaleString())}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                {hasActive && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-tp-steel hover:text-red-600"
                  >
                    Clear all
                  </button>
                )}
                <button
                  type="button"
                  onClick={applyFilters}
                  className="cursor-pointer rounded-lg bg-tp-accent px-4 py-1.5 text-xs font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
                >
                  Apply filters
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mb-4 text-xs text-tp-steel" aria-live="polite">
        {isLoading
          ? 'Loading...'
          : error
            ? ''
            : `${total} ${total === 1 ? singular : plural} found`}
      </div>

      <div className="min-h-170">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {Array.from({ length: perPage }).map((_, i) => (
              <Skeleton key={i} height={128} />
            ))}
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50 py-12 text-center"
          >
            <p className="text-sm font-medium text-red-800">The {plural} could not be loaded.</p>
            <p className="mt-1 text-xs text-red-700">{error}</p>
            <button
              type="button"
              onClick={() => setAttempt(value => value + 1)}
              className="mt-4 cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center">
            <svg
              className="mb-3 h-10 w-10 text-tp-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
            <p className="text-sm font-medium text-tp-ink">No {plural} found</p>
            <p className="mt-1 text-xs text-tp-steel">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {items.map(item => (
              <motion.div key={itemKey(item)} variants={fadeInUp} transition={transitionDefault}>
                {renderItem(item)}
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      <div className="mt-6">
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          onPageChange={next =>
            setParams(previous => {
              const search = new URLSearchParams(previous);
              if (next > 1) search.set('page', String(next));
              else search.delete('page');
              return search;
            })
          }
        />
      </div>
    </div>
  );
}
