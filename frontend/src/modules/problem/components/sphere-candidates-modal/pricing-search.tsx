// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the deferred search (75-134), the combobox and listbox (455-525) and the `PricingTarget`/`SelectedPricing` rows
// (675-740) search SPHERE's catalogue through the gateway (`GET /v1/organizations/{org}/sphere/pricings`), not the caller's own
// pricings; the search waits 300 ms after typing and a 429 waits for its `Retry-After` before asking once more; the listbox
// moves with the arrow keys; a row names the pricing, its owner, latest version, date and collection, never an id. The filters
// follow SPHERE's search-pricings list (frontend/src/modules/harvey/components/SearchPricings.tsx, as a pattern): a collection,
// a minimum price "at least" on the scale of SPHERE's whole-result histogram, sort by name or by minimum price; plus the
// organization's SPHERE organizations when it is connected and the operator's registries when there are some. There is no
// upper price bound (SPHERE's own `max-minPrice` filter is wrong) and no page-only facet.

import { useEffect, useDeferredValue, useId, useMemo, useState, type ReactNode } from 'react';
import { FiCheck, FiSearch } from 'react-icons/fi';
import { readApiError } from '../../../core/api/errors';
import { isAbortError } from '../../../core/api/http';
import type { SphereApi, SpherePricingRow, SpherePricingSearch } from '../../api/sphereApi';
import {
  MAX_RESULTS,
  NO_FILTERS,
  SEARCH_DELAY_MS,
  priceSteps,
  rowLine,
  type ChosenPricing,
  type PricingSearchFilters,
} from './searchModel';

const INPUT =
  'h-10 w-full rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 text-sm text-tp-ink outline-none transition-colors placeholder:text-tp-muted focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/10';
const LABEL = 'mb-1 block text-[11px] font-medium tracking-wider text-tp-steel uppercase';

interface Props {
  org: string;
  api: SphereApi;
  /** The pricing chosen, shown as SPHERE's selected row with "Change". */
  chosen: ChosenPricing | null;
  onChoose: (chosen: ChosenPricing | null) => void;
  /** Pricings already in the recipe, marked in the list. */
  taken?: readonly string[];
}

/** What the last answered search said; `key` names the query it answered, so a newer query reads as loading. */
type Answer = { key: string } & (
  | { kind: 'ready'; search: SpherePricingSearch }
  | { kind: 'busy'; seconds: number }
  | { kind: 'error'; message: string }
);
type State = Answer | { kind: 'loading' };

/** SPHERE's pricings, searched through the gateway, as the publish modal's list: a combobox over a listbox of rows. */
export default function PricingSearch({ org, api, chosen, onChoose, taken = [] }: Props) {
  const [filters, setFilters] = useState<PricingSearchFilters>(NO_FILTERS);
  const [typed, setTyped] = useState('');
  const deferred = useDeferredValue(typed);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [last, setLast] = useState<SpherePricingSearch | null>(null);
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // The words wait 300 ms after the last key, as SPHERE's search does, so a word typed is one request.
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        setFilters(current =>
          current.q === deferred.trim() ? current : { ...current, q: deferred.trim() }
        ),
      SEARCH_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [deferred]);

  const key = JSON.stringify([filters, attempt]);
  const state: State = answer && answer.key === key ? answer : { kind: 'loading' };

  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;
    api
      .searchPricings(
        org,
        {
          q: filters.q || undefined,
          collection: filters.collection.trim() || undefined,
          organization: filters.organization.trim() || undefined,
          registry: filters.registry || undefined,
          minPrice: filters.minPrice ?? undefined,
          sort: filters.sort,
          limit: MAX_RESULTS,
        },
        controller.signal
      )
      .then(search => {
        setAnswer({ key, kind: 'ready', search });
        setLast(search);
        setActive(0);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        const read = readApiError(error);
        if (read.status === 429 || (read.status === 503 && read.retryAfter)) {
          const seconds = Math.max(1, Math.ceil(read.retryAfter ?? 5));
          setAnswer({ key, kind: 'busy', seconds });
          // SPHERE asked for a pause: ask once more when it is over, not before.
          retry = window.setTimeout(() => setAttempt(value => value + 1), seconds * 1000);
          return;
        }
        setAnswer({
          key,
          kind: 'error',
          message:
            read.status === 0
              ? 'SPHERE’s pricings could not be searched: the gateway did not answer.'
              : `SPHERE’s pricings could not be searched${read.message ? `: ${read.message}` : '.'}`,
        });
      });
    return () => {
      controller.abort();
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [api, org, filters, key]);

  const rows = state.kind === 'ready' ? state.search.pricings : [];
  const total = state.kind === 'ready' ? state.search.total : 0;
  const hidden = Math.max(0, total - rows.length);
  const steps = useMemo(() => priceSteps(last), [last]);
  const registries = last?.registries ?? [];
  const connected = last?.connected ?? false;
  const registry = filters.registry || null;

  const set = (patch: Partial<PricingSearchFilters>) =>
    setFilters(current => ({ ...current, ...patch }));

  if (chosen) {
    return <SelectedPricing chosen={chosen} onChange={() => onChoose(null)} />;
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Search SPHERE">
      <div className="relative">
        <FiSearch
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-tp-steel"
          aria-hidden="true"
        />
        <input
          value={typed}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' && rows.length) {
              event.preventDefault();
              setActive(index => Math.min(rows.length - 1, index + 1));
            } else if (event.key === 'ArrowUp' && rows.length) {
              event.preventDefault();
              setActive(index => Math.max(0, index - 1));
            } else if (event.key === 'Enter' && rows[active]) {
              event.preventDefault();
              onChoose({ row: rows[active], registry });
            }
          }}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[active] ? optionId(active) : undefined}
          aria-label="Search SPHERE pricings by name"
          placeholder="Type to search SPHERE’s pricings…"
          className={`${INPUT} pl-9`}
        />
      </div>

      <details className="rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium text-tp-link">Filters</summary>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="min-w-0">
            <span className={LABEL}>Collection</span>
            <input
              value={filters.collection}
              onChange={event => set({ collection: event.target.value })}
              placeholder="A collection’s slug"
              className={INPUT}
            />
          </label>
          <label className="min-w-0">
            <span className={LABEL}>Minimum price at least</span>
            <select
              value={filters.minPrice ?? ''}
              onChange={event =>
                set({ minPrice: event.target.value === '' ? null : Number(event.target.value) })
              }
              className={INPUT}
            >
              <option value="">Any price</option>
              {steps.map(step => (
                <option key={step} value={step}>
                  {step.toLocaleString('en', { maximumFractionDigits: 2 })}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={LABEL}>Sort by</span>
            <select
              value={filters.sort}
              onChange={event => set({ sort: event.target.value as PricingSearchFilters['sort'] })}
              className={INPUT}
            >
              <option value="name">Name</option>
              <option value="minPrice">Minimum price</option>
            </select>
          </label>
          {connected && (
            <label className="min-w-0">
              <span className={LABEL}>Your SPHERE organization</span>
              <input
                value={filters.organization}
                onChange={event => set({ organization: event.target.value })}
                placeholder="Its id, to list its private pricings too"
                className={INPUT}
              />
            </label>
          )}
          {registries.length > 0 && (
            <label className="min-w-0">
              <span className={LABEL}>Registry</span>
              <select
                value={filters.registry}
                onChange={event => set({ registry: event.target.value })}
                className={INPUT}
              >
                <option value="">This installation’s SPHERE</option>
                {registries.map(alias => (
                  <option key={alias} value={alias}>
                    {alias}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </details>

      <ul id={listId} role="listbox" aria-label="SPHERE pricings" className="flex flex-col gap-2">
        {state.kind === 'loading' && rows.length === 0 ? (
          <EmptyState>Searching SPHERE…</EmptyState>
        ) : state.kind === 'busy' ? (
          <li
            role="status"
            className="rounded-xl border border-tp-severity-warning-border bg-tp-severity-warning-bg px-4 py-3 text-sm text-tp-warning-text"
          >
            SPHERE is busy; trying again in {state.seconds} s.
          </li>
        ) : state.kind === 'error' ? (
          <li
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {state.message}
          </li>
        ) : rows.length === 0 ? (
          <EmptyState>
            {filters.q
              ? `No SPHERE pricing matches “${filters.q}”.`
              : 'No SPHERE pricing matches these filters.'}
          </EmptyState>
        ) : (
          rows.map((row, index) => (
            <li
              key={`${row.pricingId}-${registry ?? ''}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
            >
              <PricingTarget
                row={row}
                active={index === active}
                taken={taken.includes(row.pricingId)}
                onSelect={() => onChoose({ row, registry })}
              />
            </li>
          ))
        )}
      </ul>
      {hidden > 0 && (
        <p className="text-center text-xs text-tp-steel">
          {hidden} more {hidden === 1 ? 'pricing' : 'pricings'} — keep typing to narrow the list.
        </p>
      )}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-6 text-center text-sm text-tp-steel">
      {children}
    </li>
  );
}

function PricingTarget({
  row,
  active,
  taken,
  onSelect,
}: {
  row: SpherePricingRow;
  active: boolean;
  taken: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:border-tp-primary/40 hover:bg-tp-surface ${active ? 'border-tp-primary/60 bg-tp-surface' : 'border-tp-hairline bg-tp-canvas'}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-tp-ink">{row.name}</span>
        <span className="mt-0.5 block truncate text-xs text-tp-steel">{rowLine(row)}</span>
      </span>
      {taken && (
        <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
          In the recipe
        </span>
      )}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${row.private ? 'bg-tp-surface text-tp-steel' : 'bg-emerald-50 text-emerald-800'}`}
      >
        {row.private ? 'Private' : 'Public'}
      </span>
    </button>
  );
}

function SelectedPricing({ chosen, onChange }: { chosen: ChosenPricing; onChange: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-tp-primary bg-tp-primary/5 px-3 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tp-accent text-tp-on-primary">
        <FiCheck className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-tp-ink">{chosen.row.name}</span>
        <span className="mt-0.5 block truncate text-xs text-tp-steel">
          {rowLine(chosen.row)}
          {chosen.registry ? ` · registry ${chosen.registry}` : ''}
        </span>
      </span>
      <button
        type="button"
        onClick={onChange}
        className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-medium text-tp-accent transition-colors hover:bg-tp-primary/10"
      >
        Change
      </button>
    </div>
  );
}
