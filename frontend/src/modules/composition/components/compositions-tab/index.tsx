// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization's compositions, loaded by the tab itself from the gateway with server paging; the search,
// the Kind and Archived filters and the page live in the address; "New composition" opens `/compositions/new?org=`; the role decides it and the card's
// Archive (OpenBinding's MEMBER and above), not SPHERE's per-entity permissions; a visitor sees the public compositions;
// a failed load says so with Retry; no collections.

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FaProjectDiagram } from 'react-icons/fa';
import { readApiError } from '../../../core/api/errors';
import Pagination from '../../../core/components/pagination';
import { KIND_OPTIONS } from '../../../core/utils/composition/kinds';
import {
  dropdownVariants,
  transitionDefault,
  transitionFast,
} from '../../../core/utils/motion-variants';
import { compositionPath, newCompositionPath } from '../../../../routes/paths/compositions';
import { useCompositionsApi, type CompositionView } from '../../api/compositionsApi';
import { useArchiveComposition } from '../../hooks/useArchiveComposition';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import CompositionCard from '../composition-card';
import { useUpstreamRefresh } from '../../../notification/hooks/useUpstreamRefresh';
import { archiveMenu } from '../composition-card/menu';

/** Compositions per page of the tab, as SPHERE's organization tabs. */
export const PER_PAGE = 10;

const SEARCH_DELAY = 300;

interface Props {
  org: { slug: string; name: string };
  myRole: OrgRole | null;
  isPublicView: boolean;
}

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);

export default function CompositionsTab({ org, myRole, isPublicView }: Props) {
  const { getOrganizationCompositions } = useCompositionsApi();
  const [params, setParams] = useSearchParams();
  const [compositions, setCompositions] = useState<CompositionView[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);

  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const kinds = list(params.get('kinds'));
  const archived = params.get('archived') === 'true';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const canWrite = !isPublicView && roleAtLeast(myRole, 'MEMBER');
  const kindsParam = kinds.join(',');

  const change = useCallback(
    (edit: (next: URLSearchParams) => void, keepPage = false) =>
      setParams(
        previous => {
          const next = new URLSearchParams(previous);
          edit(next);
          if (!keepPage) next.delete('page');
          return next;
        },
        { replace: true }
      ),
    [setParams]
  );

  // The search is sent after a pause in typing, as SPHERE's tab does.
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = window.setTimeout(
      () =>
        change(next => {
          if (search.trim()) next.set('q', search.trim());
          else next.delete('q');
        }),
      SEARCH_DELAY
    );
    return () => window.clearTimeout(timer);
  }, [search, q, change]);

  // An upstream event about one of these compositions arrived: their badges are read again.
  // That re-read is quiet: the cards stay, with no loading state, and a failed one keeps them.
  const arrived = useUpstreamRefresh(org.slug);
  const asked = useRef<{ inputs: string; read: unknown }>({ inputs: '', read: null });
  useEffect(() => {
    const controller = new AbortController();
    const inputs = JSON.stringify([org.slug, page, q, kindsParam, archived, isPublicView, attempt]);
    const quiet =
      asked.current.inputs === inputs && asked.current.read === getOrganizationCompositions;
    asked.current = { inputs, read: getOrganizationCompositions };
    if (!quiet) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's loading flag, raised before each request
      setIsLoading(true);
      setError(null);
    }
    getOrganizationCompositions(
      org.slug,
      {
        sort: 'updated',
        limit: String(PER_PAGE),
        offset: String((page - 1) * PER_PAGE),
        ...(q ? { q } : {}),
        ...(kindsParam ? { kinds: kindsParam } : {}),
        ...(isPublicView ? {} : { archived: String(archived) }),
      },
      controller.signal
    )
      .then(answer => {
        setCompositions(answer.compositions);
        setTotal(answer.total);
      })
      .catch(caught => {
        if (controller.signal.aborted || quiet) return;
        setCompositions([]);
        setTotal(0);
        setError(readApiError(caught).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    getOrganizationCompositions,
    org.slug,
    page,
    q,
    kindsParam,
    archived,
    isPublicView,
    attempt,
    arrived,
  ]);

  const archive = useArchiveComposition(useCallback(() => setAttempt(value => value + 1), []));

  useEffect(() => {
    if (!showFilters) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFilters(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showFilters]);

  const activeFilters = kinds.length + (archived ? 1 : 0);
  const toggleKind = (kind: string) =>
    change(next => {
      const chosen = kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind];
      if (chosen.length) next.set('kinds', chosen.join(','));
      else next.delete('kinds');
    });

  return (
    <motion.section
      key="compositions"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Compositions"
    >
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-lg text-tp-ink">
              {isPublicView ? 'Public compositions' : 'Compositions'}
            </h2>
            <p className="text-xs text-tp-steel">
              {isPublicView
                ? 'The compositions this organization publishes.'
                : 'Compositions owned by this organization.'}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search compositions..."
              aria-label="Search compositions"
              className="h-9 w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink placeholder-tp-muted transition-colors focus:border-tp-primary focus:outline-none sm:w-64"
            />
            <div className="relative" ref={filtersRef}>
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                aria-expanded={showFilters}
                className={`flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors sm:w-auto ${
                  activeFilters
                    ? 'border-tp-primary/30 bg-tp-primary/5 text-tp-accent'
                    : 'border-tp-hairline-strong bg-tp-canvas text-tp-slate hover:border-tp-hairline'
                }`}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                  />
                </svg>
                Filters
                {activeFilters > 0 && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-tp-accent text-[9px] text-tp-on-primary">
                    {activeFilters}
                  </span>
                )}
                <svg
                  className={`h-3 w-3 transition-transform ${showFilters ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <AnimatePresence>
                {showFilters && (
                  <motion.div
                    variants={dropdownVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    transition={transitionFast}
                    role="group"
                    aria-label="Filters"
                    className="absolute top-full right-0 z-20 mt-1 w-56 rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
                  >
                    <p className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-tp-steel">Kind</p>
                    {KIND_OPTIONS.map(kind => (
                      <label
                        key={kind.id}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-tp-surface"
                      >
                        <input
                          type="checkbox"
                          checked={kinds.includes(kind.id)}
                          onChange={() => toggleKind(kind.id)}
                          className="h-3.5 w-3.5 rounded border-tp-hairline-strong text-tp-primary focus:ring-tp-primary"
                        />
                        <span className="flex-1 text-tp-slate">{kind.label}</span>
                      </label>
                    ))}
                    {!isPublicView && (
                      <label className="flex cursor-pointer items-center gap-2 border-t border-tp-hairline px-3 py-2 text-xs transition-colors hover:bg-tp-surface">
                        <input
                          type="checkbox"
                          checked={archived}
                          onChange={e =>
                            change(next => {
                              if (e.target.checked) next.set('archived', 'true');
                              else next.delete('archived');
                            })
                          }
                          className="h-3.5 w-3.5 rounded border-tp-hairline-strong text-tp-primary focus:ring-tp-primary"
                        />
                        <span className="flex-1 text-tp-slate">Only archived compositions</span>
                      </label>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {canWrite && (
              <Link
                to={newCompositionPath(org.slug)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New composition
              </Link>
            )}
          </div>
        </div>

        <div className="min-h-105 p-4">
          {isLoading ? (
            <p className="py-12 text-center text-sm text-tp-steel">Loading compositions…</p>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-red-700">The compositions could not be loaded. {error}</p>
              <button
                type="button"
                onClick={() => setAttempt(value => value + 1)}
                className="cursor-pointer rounded-lg border border-tp-hairline-strong px-3 py-1.5 text-xs font-medium text-tp-ink hover:border-tp-accent hover:text-tp-accent"
              >
                Retry
              </button>
            </div>
          ) : compositions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-tp-ink">
              <FaProjectDiagram size={32} className="text-tp-muted" aria-hidden="true" />
              <p className="text-sm">
                {q || activeFilters ? 'No compositions match.' : 'No compositions found.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {compositions.map(composition => (
                <CompositionCard
                  key={composition.id}
                  data={composition}
                  showVisibility={!isPublicView}
                  to={compositionPath(org.slug, composition.slug)}
                  menuItems={archiveMenu(composition, canWrite, archive)}
                />
              ))}
            </div>
          )}
        </div>

        {total > PER_PAGE && (
          <div className="border-t border-tp-hairline px-5 py-3">
            <Pagination
              currentPage={page}
              totalPages={Math.ceil(total / PER_PAGE)}
              onPageChange={next =>
                change(search => {
                  if (next > 1) search.set('page', String(next));
                  else search.delete('page');
                }, true)
              }
            />
          </div>
        )}
      </div>
    </motion.section>
  );
}
