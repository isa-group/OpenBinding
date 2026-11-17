// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization's runs instead of its pricings, read by the tab with server paging (10 a page, the gateway's
// offset and total); the status chips and a Filters popover (Problem, Engine) are gateway filters kept in the address; the
// rows are SPHERE's member rows (run-row); runs still moving are read again quietly until they end; "Start a run" opens
// `/runs/new?org=` for MEMBER and above, who may also retry a failed or cancelled run; a failed load says so with Retry.

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FaPlay } from 'react-icons/fa';
import { Action } from '../../../core/components/action-button';
import { FilterPills } from '../../../core/components/filter-pills';
import { Notice } from '../../../core/components/notice';
import Pagination from '../../../core/components/pagination';
import { classifyAuthError, marker, type AuthFailure } from '../../../core/api/errors';
import {
  dropdownVariants,
  transitionDefault,
  transitionFast,
} from '../../../core/utils/motion-variants';
import { useAuth } from '../../../auth/hooks/useAuth';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { launchPath, runPath } from '../../../../routes/paths/runs';
import { useRunsApi, type FilterOption, type Job, type JobState } from '../../api/runsApi';
import { refusalOf, type Refusal } from '../../utils/runErrors';
import {
  STATUS_FILTERS,
  isActive,
  normalizeStatus,
  type StatusFilter,
} from '../../utils/runsModel';
import RunRow, { RUN_ROW_COLUMNS } from '../run-row';
import { RefusalNotice } from '../run-status';

/** Runs per page of the tab, as SPHERE's organization tabs. */
export const PER_PAGE = 10;
/** How often the page is read again while one of its runs is still moving. */
export const REFRESH_MS = 8000;

interface Props {
  org: { slug: string; name: string };
  myRole: OrgRole | null;
}

type Outcome =
  { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };

const isState = (value: string | null): value is JobState =>
  STATUS_FILTERS.some(filter => filter.id !== '' && filter.id === value);

const selectClass =
  'h-9 w-full cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs text-tp-ink focus:border-tp-primary focus:outline-none';

export default function RunsTab({ org, myRole }: Props) {
  const { user } = useAuth();
  const api = useRunsApi();
  const [params, setParams] = useSearchParams();
  const [runs, setRuns] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [problems, setProblems] = useState<FilterOption[]>([]);
  const [engines, setEngines] = useState<FilterOption[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);

  const rawState = params.get('state');
  const state: StatusFilter = isState(rawState) ? rawState : '';
  const problem = params.get('problem') ?? '';
  const engine = params.get('engine') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const canLaunch = myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MEMBER';
  const activeFilters = (problem ? 1 : 0) + (engine ? 1 : 0);

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

  // A new address (another filter or page) shows the skeleton; a quiet reading keeps the rows it shows.
  const filterKey = `${org.slug}|${state}|${problem}|${engine}|${page}`;
  const [shownKey, setShownKey] = useState<string | null>(null);
  const loading = !loaded || shownKey !== filterKey;

  useEffect(() => {
    const controller = new AbortController();
    api
      .list(
        org.slug,
        {
          state: state || undefined,
          problem: problem || undefined,
          engine: engine || undefined,
          limit: PER_PAGE,
          offset: (page - 1) * PER_PAGE,
        },
        controller.signal
      )
      .then(answer => {
        setRuns(answer.runs);
        setTotal(answer.total);
        setFailure(null);
        setShownKey(filterKey);
        setLoaded(true);
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setRuns([]);
        setTotal(0);
        setFailure(classifyAuthError(caught));
        setShownKey(filterKey);
        setLoaded(true);
      });
    return () => controller.abort();
  }, [api, org.slug, state, problem, engine, page, attempt, filterKey]);

  // The choices of the Filters popover, read once.
  useEffect(() => {
    const controller = new AbortController();
    api.problemOptions(org.slug, controller.signal).then(setProblems, () => setProblems([]));
    api.engineOptions(controller.signal).then(setEngines, () => setEngines([]));
    return () => controller.abort();
  }, [api, org.slug]);

  // Runs that are still moving are asked about again, quietly; the list keeps what it shows meanwhile.
  const anyActive = runs.some(run => isActive(normalizeStatus(run.status)));
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = window.setInterval(() => setAttempt(value => value + 1), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [anyActive]);

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

  const retry = async (job: Job) => {
    setRetrying(job.id);
    setOutcome(null);
    try {
      const made = await api.retry(org.slug, job.id);
      setOutcome({ tone: 'success', text: 'Retry queued.', follow: runPath(org.slug, made.id) });
      setAttempt(value => value + 1);
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'retry') });
    } finally {
      setRetrying(null);
    }
  };

  const narrowed = state !== '' || activeFilters > 0;

  return (
    <motion.section
      key="runs"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Runs"
    >
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="font-display text-lg text-tp-ink">Runs</h2>
              {loaded && !failure && (
                <span className="text-sm text-tp-steel" aria-label={`${total} in all`}>
                  {total}
                </span>
              )}
            </div>
            <p className="text-xs text-tp-steel">
              Every engine run launched in {org.name}. Every member opens them; launching,
              cancelling and retrying need MEMBER.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
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
                    className="absolute top-full right-0 z-20 mt-1 flex w-64 flex-col gap-3 rounded-lg border border-tp-hairline bg-tp-canvas p-3 shadow-elevation-4"
                  >
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
                      Problem
                      <select
                        value={problem}
                        onChange={event =>
                          change(next => {
                            if (event.target.value) next.set('problem', event.target.value);
                            else next.delete('problem');
                          })
                        }
                        className={selectClass}
                      >
                        <option value="">Any problem</option>
                        {problem && !problems.some(option => option.value === problem) && (
                          <option value={problem}>{problem}</option>
                        )}
                        {problems.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
                      Engine
                      <select
                        value={engine}
                        onChange={event =>
                          change(next => {
                            if (event.target.value) next.set('engine', event.target.value);
                            else next.delete('engine');
                          })
                        }
                        className={selectClass}
                      >
                        <option value="">Any engine</option>
                        {engine && !engines.some(option => option.value === engine) && (
                          <option value={engine}>{engine}</option>
                        )}
                        {engines.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {activeFilters > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          change(next => {
                            next.delete('problem');
                            next.delete('engine');
                          })
                        }
                        className="cursor-pointer self-start text-xs font-medium text-tp-accent hover:underline"
                      >
                        Clear filters
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {canLaunch && (
              <Action to={launchPath(org.slug)} variant="primary" size="sm" className="h-9">
                <FaPlay aria-hidden="true" className="h-3 w-3" />
                Start a run
              </Action>
            )}
          </div>
        </div>

        <div className="border-b border-tp-hairline px-5 py-3">
          <FilterPills
            ariaLabel="Status"
            value={state}
            onChange={id =>
              change(next => {
                if (id) next.set('state', id);
                else next.delete('state');
              })
            }
            options={STATUS_FILTERS}
          />
        </div>

        {(outcome || failure) && (
          <div className="flex flex-col gap-2 px-5 pt-4">
            {outcome?.tone === 'success' && (
              <Notice
                tone="success"
                action={
                  outcome.follow ? (
                    <Action to={outcome.follow} variant="link" size="sm">
                      Follow the new run
                    </Action>
                  ) : undefined
                }
              >
                {outcome.text}
              </Notice>
            )}
            {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
            {failure && (
              <Notice
                tone="error"
                action={
                  <Action variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>
                    Retry
                  </Action>
                }
              >
                {failure.status === 403 ? (
                  <>
                    This credential can’t read runs{marker(failure)}. Use a session, or a key with{' '}
                    <code className="font-mono text-xs">jobs:read</code>.
                  </>
                ) : (
                  `Runs can’t be loaded right now${marker(failure)}.`
                )}
              </Notice>
            )}
          </div>
        )}

        <div className="min-h-60">
          {loading ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-2 p-5">
              <span className="sr-only">Loading the runs…</span>
              {[0, 1, 2].map(index => (
                <div key={index} className="h-10 animate-pulse rounded-lg bg-tp-surface" />
              ))}
            </div>
          ) : failure ? null : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-tp-ink">
              <FaPlay size={28} className="text-tp-muted" aria-hidden="true" />
              <p className="text-sm font-medium">
                {narrowed ? 'No runs match these filters' : 'No runs yet'}
              </p>
              <p className="text-xs text-tp-steel">
                {narrowed
                  ? 'Try another status, problem or engine.'
                  : 'Pick a problem version and an engine to run it.'}
              </p>
              {!narrowed && canLaunch && (
                <Action to={launchPath(org.slug)} variant="primary" size="sm">
                  Start a run
                </Action>
              )}
            </div>
          ) : (
            <>
              <div
                aria-hidden="true"
                className={`hidden border-b border-tp-hairline px-5 py-2 text-[11px] font-medium tracking-wide text-tp-steel uppercase ${RUN_ROW_COLUMNS}`}
              >
                <span>Status</span>
                <span>Problem</span>
                <span>Engine</span>
                <span>Outcome</span>
                <span>Took</span>
                <span>Launched by</span>
                <span />
              </div>
              <ul aria-label="Runs of the organization" className="divide-y divide-tp-hairline">
                {runs.map(job => (
                  <RunRow
                    key={job.id}
                    org={org.slug}
                    job={job}
                    me={user?.id ?? null}
                    canRetry={canLaunch}
                    retrying={retrying === job.id}
                    onRetry={() => void retry(job)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {total > PER_PAGE && !failure && (
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
