// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization's problems, loaded by the tab itself from the gateway with server paging (each row embeds its
// latest revision and how many it has); the search, the filters (the origin of the latest version, the composition that links
// it, the order) and the page live in the address; "New" ▾ offers an uploaded BIM package (the import modal, in this
// organization), the problem editor and a template; the role decides it and the card's kebab (Run latest and New version
// for a MEMBER, Delete for an ADMIN with the address typed), not SPHERE's per-entity permissions; a VIEWER reads only; a
// failed load says so with Retry; no collections.

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaProjectDiagram } from 'react-icons/fa';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import type { ProblemOrigin } from '../../../core/api/types';
import Pagination from '../../../core/components/pagination';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import {
  dropdownVariants,
  transitionDefault,
  transitionFast,
} from '../../../core/utils/motion-variants';
import { useCompositionsApi, type CompositionView } from '../../../composition/api/compositionsApi';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { problemEditorPath, problemPath } from '../../../../routes/paths/problems';
import { useProblemsApi, type ProblemView } from '../../api/problemsApi';
import { problemAccessOf } from '../../hooks/useProblemRole';
import { ORIGIN_LABELS } from '../../types';
import { runLaunchOf } from '../../utils/runTarget';
import DeleteProblemModal from '../delete-problem-modal';
import ProblemCard, { type ProblemMenuItem } from '../problem-card';
import ProblemImportModal from '../problem-import-modal';

/** Problems per page of the tab, as SPHERE's organization tabs. */
export const PER_PAGE = 10;

/** The template a new problem starts from in the problem editor when the tab offers one. */
export const STARTER_TEMPLATE = 'demo/01_simple_seq';

/** The most compositions the "Linked by composition" select offers. */
const COMPOSITION_PAGE = 200;

const SEARCH_DELAY = 300;

/** The origins the filter offers; SPHERE is recorded by the gateway already and offered from F3. */
const FILTER_ORIGINS = ['upload', 'editor', 'qacoforge'] as const;
const isFilterOrigin = (value: string | null): value is ProblemOrigin =>
  (FILTER_ORIGINS as readonly string[]).includes(value ?? '');

type Sort = 'name' | 'recent';

interface Props {
  org: { slug: string; name: string };
  myRole: OrgRole | null;
}

export default function ProblemsTab({ org, myRole }: Props) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { getOrganizationProblems } = useProblemsApi();
  const { getOrganizationCompositions } = useCompositionsApi();
  const [params, setParams] = useSearchParams();
  const [problems, setProblems] = useState<ProblemView[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [compositions, setCompositions] = useState<CompositionView[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<ProblemView | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLDivElement>(null);

  const { canCreate, canAdminister } = problemAccessOf(myRole);
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const originParam = params.get('origin');
  const origin = isFilterOrigin(originParam) ? originParam : null;
  const composition = params.get('composition') ?? '';
  const sort: Sort = params.get('sort') === 'recent' ? 'recent' : 'name';
  const page = Math.max(1, Number(params.get('page')) || 1);

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
  const setParam = (name: string, value: string | null) =>
    change(next => {
      if (value) next.set(name, value);
      else next.delete(name);
    });

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

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's loading flag, raised before each request
    setIsLoading(true);
    setError(null);
    getOrganizationProblems(
      org.slug,
      {
        limit: String(PER_PAGE),
        offset: String((page - 1) * PER_PAGE),
        q: q || undefined,
        origin: origin ?? undefined,
        composition: composition || undefined,
        sort: sort === 'recent' ? 'recent' : undefined,
      },
      controller.signal
    )
      .then(answer => {
        // The gateway orders the whole list (by name, or newest latest version first) before it pages it.
        setProblems(answer.problems);
        setTotal(answer.total);
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setProblems([]);
        setTotal(0);
        setError(readApiError(caught).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [getOrganizationProblems, org.slug, page, q, origin, composition, sort, attempt]);

  // The compositions the "Linked by composition" select offers; without them it offers only "Any composition".
  useEffect(() => {
    const controller = new AbortController();
    getOrganizationCompositions(
      org.slug,
      { sort: 'name', limit: String(COMPOSITION_PAGE) },
      controller.signal
    )
      .then(answer => setCompositions(answer.compositions))
      .catch(() => {
        if (!controller.signal.aborted) setCompositions([]);
      });
    return () => controller.abort();
  }, [getOrganizationCompositions, org.slug]);

  useEffect(() => {
    if (!showFilters && !showNew) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (showFilters && !filtersRef.current?.contains(target)) setShowFilters(false);
      if (showNew && !newRef.current?.contains(target)) setShowNew(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowFilters(false);
        setShowNew(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showFilters, showNew]);

  const activeFilters = (origin ? 1 : 0) + (composition ? 1 : 0) + (sort === 'recent' ? 1 : 0);
  const filtered = Boolean(q || origin || composition);

  const menuOf = (problem: ProblemView): ProblemMenuItem[] => {
    const latest = problem.latest_revision;
    return [
      ...(canCreate && latest
        ? [
            {
              label: 'Run latest',
              ariaLabel: `Run the latest version of ${problem.name}`,
              to: runLaunchOf(org.slug, problem.slug, latest.revision),
            },
          ]
        : []),
      ...(canCreate
        ? [
            {
              label: 'New version',
              ariaLabel: `New version of ${problem.name}`,
              to: problemEditorPath(org.slug, { problem: problem.slug }),
            },
          ]
        : []),
      ...(canAdminister
        ? [
            {
              label: 'Delete',
              ariaLabel: `Delete ${problem.name}`,
              variant: 'danger' as const,
              onClick: () => setRemoving(problem),
            },
          ]
        : []),
    ];
  };

  const selectClass =
    'h-8 w-full cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-2 text-xs text-tp-ink focus:border-tp-primary focus:outline-none';
  const newItemClass =
    'flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface';

  return (
    <motion.section
      key="problems"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Problems"
    >
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-lg text-tp-ink">Problems</h2>
            <p className="text-xs text-tp-steel">Problems owned by this organization.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search problems..."
              aria-label="Search problems"
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
                    className="absolute top-full right-0 z-20 mt-1 w-64 rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
                  >
                    <fieldset>
                      <legend className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-tp-steel">
                        Origin of the latest version
                      </legend>
                      {[
                        { id: '', label: 'All origins' },
                        ...FILTER_ORIGINS.map(id => ({ id, label: ORIGIN_LABELS[id] })),
                      ].map(option => (
                        <label
                          key={option.id || 'all'}
                          className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-tp-surface"
                        >
                          <input
                            type="radio"
                            name="problem-origin"
                            checked={(origin ?? '') === option.id}
                            onChange={() => setParam('origin', option.id || null)}
                            className="h-3.5 w-3.5 cursor-pointer text-tp-primary focus:ring-tp-primary"
                          />
                          <span className="flex-1 text-tp-slate">{option.label}</span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="block border-t border-tp-hairline px-3 py-2 text-[11px] font-medium text-tp-steel">
                      Linked by composition
                      <select
                        value={composition}
                        onChange={e => setParam('composition', e.target.value || null)}
                        className={`mt-1 ${selectClass}`}
                      >
                        <option value="">Any composition</option>
                        {composition && !compositions.some(item => item.slug === composition) && (
                          <option value={composition}>{composition}</option>
                        )}
                        {compositions.map(item => (
                          <option key={item.id} value={item.slug}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block border-t border-tp-hairline px-3 py-2 text-[11px] font-medium text-tp-steel">
                      Sort
                      <select
                        value={sort}
                        onChange={e =>
                          setParam('sort', e.target.value === 'recent' ? 'recent' : null)
                        }
                        className={`mt-1 ${selectClass}`}
                      >
                        <option value="name">Name</option>
                        <option value="recent">Latest version</option>
                      </select>
                    </label>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {canCreate && (
              <div className="relative" ref={newRef}>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={showNew}
                  onClick={() => setShowNew(value => !value)}
                  className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep sm:w-auto"
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
                  New
                  <svg
                    className={`h-3 w-3 transition-transform ${showNew ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showNew && (
                  <div
                    role="menu"
                    aria-label="New problem"
                    className="absolute top-full right-0 z-20 mt-1 w-64 rounded-lg border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-4"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowNew(false);
                        setImporting(true);
                      }}
                      className={newItemClass}
                    >
                      <span>
                        <span className="block font-medium">Upload BIM package</span>
                        <span className="mt-0.5 block text-[11px] text-tp-steel">
                          A .bim.zip you already have
                        </span>
                      </span>
                    </button>
                    <Link
                      role="menuitem"
                      to={problemEditorPath(org.slug)}
                      onClick={() => setShowNew(false)}
                      className={newItemClass}
                    >
                      <span>
                        <span className="block font-medium">Write in the problem editor</span>
                        <span className="mt-0.5 block text-[11px] text-tp-steel">
                          Checked as you type
                        </span>
                      </span>
                    </Link>
                    <Link
                      role="menuitem"
                      to={problemEditorPath(org.slug, { template: STARTER_TEMPLATE })}
                      onClick={() => setShowNew(false)}
                      className={newItemClass}
                    >
                      <span>
                        <span className="block font-medium">Start from a template</span>
                        <span className="mt-0.5 block text-[11px] text-tp-steel">
                          A small sequential workflow to change
                        </span>
                      </span>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-105 p-4">
          {isLoading ? (
            <p role="status" className="py-12 text-center text-sm text-tp-steel">
              Loading problems…
            </p>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-red-700">The problems could not be loaded. {error}</p>
              <button
                type="button"
                onClick={() => setAttempt(value => value + 1)}
                className="cursor-pointer rounded-lg border border-tp-hairline-strong px-3 py-1.5 text-xs font-medium text-tp-ink hover:border-tp-accent hover:text-tp-accent"
              >
                Retry
              </button>
            </div>
          ) : problems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-tp-ink">
              <FaProjectDiagram size={32} className="text-tp-muted" aria-hidden="true" />
              {filtered ? (
                <>
                  <p className="text-sm">No problem matches these filters.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      change(next => {
                        next.delete('q');
                        next.delete('origin');
                        next.delete('composition');
                      });
                    }}
                    className="cursor-pointer text-xs font-medium text-tp-accent hover:underline"
                  >
                    Show every problem
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">No problems yet</p>
                  <p className="max-w-[28rem] text-xs text-tp-steel">
                    A problem describes one experiment. Upload a BIM package you already have, write
                    one in the problem editor, or start from a template.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {problems.map(problem => (
                <ProblemCard
                  key={problem.id}
                  data={problem}
                  to={problemPath(org.slug, problem.slug)}
                  menuItems={menuOf(problem)}
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

      {importing && (
        <ProblemImportModal
          mode="problem"
          org={org}
          onClose={() => setImporting(false)}
          onCreated={created => {
            setImporting(false);
            void navigate(problemPath(org.slug, created.problem.slug), {
              state: {
                toast: `Problem “${created.problem.name}” created with version ${created.revision.revision}.`,
              },
            });
          }}
        />
      )}
      {removing && (
        <DeleteProblemModal
          org={org}
          item={removing}
          onClose={() => setRemoving(null)}
          onDeleted={name => {
            setRemoving(null);
            addToast({ kind: SYSTEM_TOAST, title: `Problem “${name}” deleted.` });
            setAttempt(value => value + 1);
          }}
        />
      )}
    </motion.section>
  );
}
